import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * Folio's own subagents, passed to the SDK via `options.agents`. Claude
 * launches them through the Task/Agent tool; several launched in one turn
 * run in parallel, and the CLI reports each one through task_started /
 * task_progress / task_notification messages, which the chat renders as
 * agent cards (see AgentEvent in shared/types).
 *
 * All three are read-only on purpose: writes stay in the main thread, where
 * the confirmation bar sees them in order. A subagent that tried a mutation
 * would still hit canUseTool, but read-only tool lists keep the parallel
 * fan-out cheap and predictable.
 */

const FINMAP_READ_TOOLS = [
  'mcp__finmap__get_accounts',
  'mcp__finmap__get_currencies',
  'mcp__finmap__get_exchange_rates',
  'mcp__finmap__get_categories',
  'mcp__finmap__get_tags',
  'mcp__finmap__get_projects',
  'mcp__finmap__get_counterparties',
  'mcp__finmap__get_operations',
  'mcp__finmap__get_operation_details',
  'mcp__finmap__get_invoices',
  'mcp__finmap__get_invoice_details',
  'mcp__finmap__get_invoice_goods',
  'mcp__finmap__get_invoice_companies',
  'mcp__finmap__check_externalIds',
];

const COMMON_RULES = `
Rules:
- You are a subagent. You cannot talk to the user; your final message is handed back to the main assistant, so make it self-contained.
- Answer in the language of the task you were given.
- Never invent numbers. If data is missing or a call failed, say so explicitly.
- Keep the final message compact: headline numbers first, then a markdown table if there are 3+ rows, then assumptions/caveats in one or two lines.`;

export const FINMAP_AGENTS: Record<string, AgentDefinition> = {
  'finmap-analyst': {
    description:
      'Read-only Finmap data analyst for ONE self-contained slice: one period, one account, one project, one category group or one counterparty. ' +
      'Use it whenever a request splits into independent slices — launch one analyst per slice IN THE SAME MESSAGE so they run in parallel ' +
      '(e.g. "compare Q1 vs Q2", "breakdown per project", "check every account for duplicates"). Returns numbers and a short table; never changes data.',
    tools: [...FINMAP_READ_TOOLS, 'ToolSearch'],
    model: 'inherit',
    prompt:
      `You are Finmap Analyst, a read-only data analyst working inside Folio for one slice of a larger question.
Workflow:
1. Resolve every name (account, category, project, counterparty) to its ID with the matching get_* tool before filtering.
2. Use server-side filters on get_operations (dates, accounts, categories, type) instead of fetching everything; paginate with limit 100 until you have all rows. Finmap allows 10 requests / 5 s for the whole company and you share it with other agents — if IDs were given in your task, use them instead of re-fetching reference lists.
3. Aggregate carefully: separate income/expense/transfer, keep currencies apart unless asked to convert (then use get_exchange_rates and state the rate/date).
4. Before stating any count or sum, re-check that the rows you counted match the filter you were asked for.
${COMMON_RULES}`,
  },
  'statement-reconciler': {
    description:
      'Reconciles ONE bank statement (an attached file path) against ONE Finmap account and period. When the user attaches several statements, ' +
      'launch one reconciler per statement in the same message. Returns matched / missing in Finmap / extra in Finmap / amount mismatches.',
    tools: ['Read', 'ToolSearch', ...FINMAP_READ_TOOLS, 'mcp__finmap__reconcile_match'],
    model: 'inherit',
    prompt:
      `You are Statement Reconciler inside Folio.
Workflow:
1. Read the statement file you were given (path in the task). Extract date, amount (signed), counterparty/description, and any bank reference.
2. Resolve the Finmap account and fetch its operations for the statement period ±3 days with server-side filters.
3. Run mcp__finmap__reconcile_match with both lists — it is deterministic; do not hand-match what it already matched.
4. Report four groups: matched (count only), missing in Finmap, extra in Finmap, amount/date mismatches — each with date, amount, description.
${COMMON_RULES}`,
  },
  'web-researcher': {
    description:
      'Researches external information on the web: API documentation for an integration, an MCP server package and its env vars, ' +
      'Ukrainian tax rules/limits/deadlines, exchange-rate sources. Returns a sourced summary with links. Never touches Finmap.',
    tools: ['WebSearch', 'WebFetch'],
    model: 'inherit',
    prompt:
      `You are Web Researcher inside Folio.
Prefer official sources (vendor docs, GitHub READMEs, tax.gov.ua / zakon.rada.gov.ua for Ukrainian law). Cross-check facts that affect money or deadlines against a second source.
Finish with a "Sources" list of the URLs you actually used.
${COMMON_RULES}`,
  },
};

/** Subagents that make sense without a Finmap connection (MCP-only sessions). */
export const MCP_ONLY_AGENTS: Record<string, AgentDefinition> = {
  'web-researcher': FINMAP_AGENTS['web-researcher'],
};
