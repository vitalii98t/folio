import { FinmapAPI } from './finmap-api';
import { buildFinmapMcpServer, MUTATION_TOOLS } from './mcp-tools';
import { SYSTEM_PROMPT, BACKGROUND_SYSTEM_PROMPT, MCP_ONLY_SYSTEM_PROMPT, SUBAGENTS_PROMPT } from './system-prompt';
import { FINMAP_AGENTS, MCP_ONLY_AGENTS } from './subagents';
import { getClaudePath, isAuthError } from './claude-status';
import { mcpHttpHost, type McpHttpRoute } from './mcp-http-host';
import type { SessionStore } from './session-store';
import type { ChatSession, MessageUsage, ContextUsage, AgentEvent, RateLimitSnapshot, RateLimitWindow } from '../shared/types';

type SDK = typeof import('@anthropic-ai/claude-agent-sdk');
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult;
type CanUseTool = import('@anthropic-ai/claude-agent-sdk').CanUseTool;
type Options = import('@anthropic-ai/claude-agent-sdk').Options;
type SDKResultMessage = import('@anthropic-ai/claude-agent-sdk').SDKResultMessage;

let _sdk: SDK | null = null;
async function getSDK(): Promise<SDK> {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk');
  return _sdk;
}

/** How long a confirmation may sit unanswered before we auto-deny it. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;

/**
 * Read-only tools the SDK auto-approves (canUseTool is skipped for them).
 * Anything that changes state is deliberately NOT here — it must reach
 * canUseTool so the user can confirm it (see MUTATION_TOOLS).
 */
const ALLOWED_TOOLS = [
  // Built-ins: skill loading, file reading (attachments), web research,
  // subagents, deferred-tool loading. All read-only.
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch',
  'Task', 'Agent', 'TodoWrite', 'ListMcpResourcesTool', 'ReadMcpResourceTool',

  // Finmap reads
  'mcp__finmap__get_accounts',
  'mcp__finmap__get_currencies',
  'mcp__finmap__get_exchange_rates',
  'mcp__finmap__get_categories',
  'mcp__finmap__get_tags',
  'mcp__finmap__get_projects',
  'mcp__finmap__get_counterparties',
  'mcp__finmap__get_operations',
  'mcp__finmap__summarize_operations',
  'mcp__finmap__get_operation_details',
  'mcp__finmap__check_externalIds',
  'mcp__finmap__get_invoices',
  'mcp__finmap__get_invoice_details',
  'mcp__finmap__get_invoice_goods',
  'mcp__finmap__get_invoice_companies',
  // Reads the invoice and writes a PDF into Downloads/Folio — no Finmap change.
  'mcp__finmap__download_invoice_pdf',
  'mcp__finmap__get_webhooks',
  'mcp__finmap__list_integrations',
  // Deterministic matcher used by reconcile-statement — pure computation.
  'mcp__finmap__reconcile_match',
  // Folio self-management: listing only. add/update/remove confirm.
  'mcp__finmap__list_mcp_servers',
  'mcp__finmap__list_file_bindings',
  'mcp__finmap__list_scheduled_tasks',
  // Local bookkeeping with no external effect: saving a pasted service
  // account JSON into userData/credentials, and the dedup ledger for
  // folder imports.
  'mcp__finmap__save_service_account_key',
  'mcp__finmap__mark_files_processed',
  // Google Drive reads (public folder via API key)
  'mcp__finmap__gdrive_list_files',
  'mcp__finmap__gdrive_get_file_content',
];

/** Built-ins that can run commands or change files on the user's machine.
 *  Folio never needs them; hiding them also keeps the tool list short. */
const DISALLOWED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell', 'Monitor',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'CronCreate', 'CronDelete', 'RemoteTrigger', 'ScheduleWakeup', 'EnterWorktree', 'ExitWorktree', 'Workflow',
  // Subagents run in the foreground here (see CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
  // below), so there is nothing to list, message, poll or stop.
  'SendMessage', 'ListAgents', 'TaskOutput', 'TaskStop',
  // Interactive terminal UI Folio doesn't render — Claude asks in plain text instead.
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
];

/** Plumbing calls that say nothing to the user — no badge in the chat. */
const SILENT_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);

/** Non-MCP built-ins canUseTool may allow if they weren't auto-approved. */
const SAFE_BUILTINS = new Set(ALLOWED_TOOLS.filter(t => !t.startsWith('mcp__')));

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Convert the CLI's rate_limit_info into Folio's snapshot. Newer CLIs send
 *  every window in `unifiedWindows`; older ones only the one that changed. */
function toRateLimitSnapshot(info: any): RateLimitSnapshot | null {
  if (!info || typeof info !== 'object') return null;
  const win = (w: any): RateLimitWindow | undefined =>
    w && typeof w.utilization === 'number' && typeof w.resetsAt === 'number'
      ? { utilization: w.utilization, resetsAt: w.resetsAt * 1000 }
      : undefined;
  const single = (type: string) =>
    info.rateLimitType === type ? win({ utilization: info.utilization, resetsAt: info.resetsAt }) : undefined;
  const fiveHour = win(info.unifiedWindows?.five_hour) ?? single('five_hour');
  const sevenDay = win(info.unifiedWindows?.seven_day) ?? single('seven_day');
  if (!fiveHour && !sevenDay) return null;
  return { status: info.status ?? 'allowed', fiveHour, sevenDay, receivedAt: Date.now() };
}

/** One mutation awaiting user confirmation. Multiple can be pending at once
 *  (Claude may call several tools in parallel) — they queue FIFO. */
interface PendingConfirm {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  /** Auto-deny timer so an unanswered confirmation can't hang the run forever. */
  timer: ReturnType<typeof setTimeout>;
}

export interface SendHandlers {
  onChunk?: (text: string) => void;
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  /** `usage` is present when the SDK delivered a result message. */
  onDone: (fullText: string, usage?: MessageUsage) => void;
  onError: (error: string) => void;
  /** A mutation needs the user's confirmation (chat runs only). */
  onToolPermission?: (toolName: string, input: Record<string, unknown>) => void;
  /** Claude Code's own login failed. Absent → reported through onError. */
  onAuthError?: (message: string) => void;
  /** Live context-window fill on every API turn. */
  onUsage?: (usage: ContextUsage) => void;
  /** Claude Code compacted the conversation; `preTokens` = size before. */
  onCompact?: (preTokens: number) => void;
  /** Subagent lifecycle. */
  onAgent?: (event: AgentEvent) => void;
}

export interface SendOptions {
  /**
   * Background run (scheduled task, integration sync, folder import):
   * auto-approves every tool, uses the lean prompt, starts a fresh Claude
   * conversation each time (never resumes or overwrites the chat's), and is
   * cancelled through the controller the caller passes.
   */
  background?: boolean;
  abortController?: AbortController;
}

/**
 * Runs Claude Agent SDK queries for Folio sessions.
 *
 * Every call builds its own Finmap client and in-process MCP server: sharing
 * one server instance between a chat run and a background run on the same
 * session rebinds its transport and routes tool results to the wrong CLI
 * process. It also means a changed API key takes effect on the next message.
 */
export class AgentManager {
  private sessionStore: SessionStore;
  private workspaceCwd: string = process.cwd();
  /** Chat (interactive) run per session — what the Stop button cancels. */
  private chatRuns = new Map<string, AbortController>();
  /** Pending confirmations per session (chat runs only). */
  private pendingConfirms = new Map<string, PendingConfirm[]>();
  private autoApprove = new Map<string, boolean>();
  /** Resume id of each session's chat conversation (mirrors the store). */
  private claudeSessionIds = new Map<string, string>();
  /** Account-wide plan limits — last snapshot from any run. */
  private rateLimit: RateLimitSnapshot | null = null;
  /** Set by main to broadcast plan-limit updates to the window. */
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  setWorkspaceCwd(cwd: string) {
    this.workspaceCwd = cwd;
  }

  getWorkspaceCwd(): string {
    return this.workspaceCwd;
  }

  setAutoApprove(sessionId: string, enabled: boolean) {
    this.autoApprove.set(sessionId, enabled);
  }

  getAutoApprove(sessionId: string): boolean {
    return this.autoApprove.get(sessionId) ?? false;
  }

  getRateLimit(): RateLimitSnapshot | null {
    return this.rateLimit;
  }

  getClaudeSessionId(sessionId: string): string | null {
    return this.claudeSessionIds.get(sessionId) ?? this.sessionStore.get(sessionId)?.claudeSessionId ?? null;
  }

  removeSession(id: string) {
    this.cancel(id);
    this.denyAllPending(id, 'Session removed');
    this.claudeSessionIds.delete(id);
    this.autoApprove.delete(id);
  }

  /** Start a fresh Claude conversation for the chat — next message won't resume. */
  resetClaudeSession(sessionId: string) {
    this.cancel(sessionId);
    this.claudeSessionIds.delete(sessionId);
    this.sessionStore.update(sessionId, { claudeSessionId: undefined });
  }

  /** Cancel the session's CHAT run. Background runs are cancelled through
   *  the controller their caller owns. */
  cancel(sessionId: string) {
    const ac = this.chatRuns.get(sessionId);
    if (ac) {
      ac.abort();
      this.chatRuns.delete(sessionId);
    }
  }

  /** Confirm the OLDEST pending mutation (FIFO — the order the UI shows). */
  async confirmMutation(sessionId: string): Promise<boolean> {
    const pending = this.pendingConfirms.get(sessionId)?.shift();
    if (!pending) return false;
    clearTimeout(pending.timer);
    // Pass the original input — {} would execute the tool with empty data.
    pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    return true;
  }

  async rejectMutation(sessionId: string): Promise<boolean> {
    const pending = this.pendingConfirms.get(sessionId)?.shift();
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.resolve({ behavior: 'deny', message: 'User rejected this action.' });
    return true;
  }

  private denyAllPending(sessionId: string, message: string) {
    const queue = this.pendingConfirms.get(sessionId) ?? [];
    for (const p of queue.splice(0)) {
      clearTimeout(p.timer);
      p.resolve({ behavior: 'deny', message });
    }
  }

  async sendMessage(session: ChatSession, userMessage: string, h: SendHandlers, opts: SendOptions = {}) {
    const background = opts.background === true;
    const abortController = opts.abortController ?? new AbortController();
    if (!background) {
      // A second chat message while one runs replaces it (the UI blocks this,
      // but never leave an orphaned controller behind).
      this.chatRuns.get(session.id)?.abort();
      this.chatRuns.set(session.id, abortController);
    }

    const hasFinmap = typeof session.apiKey === 'string' && session.apiKey.trim().length > 0;
    const api = new FinmapAPI(session.apiKey, { priority: background ? 'background' : 'interactive' });
    let httpRoute: McpHttpRoute | null = null;

    try {
      const sdk = await getSDK();
      // Chat runs serve Finmap tools over local HTTP so subagents get them
      // too (the CLI keeps in-process servers to the main thread). Background
      // runs have no subagents and keep the in-process server.
      let finmapServer: any;
      if (background) {
        finmapServer = await buildFinmapMcpServer(api, this.sessionStore, session.id);
      } else {
        httpRoute = await mcpHttpHost.register(async () =>
          (await buildFinmapMcpServer(api, this.sessionStore, session.id)).instance);
        // Generous per-call timeout: a tool that pages through operations
        // may wait for Finmap's rate-limit windows (10 / 5 s, 120 / min).
        // alwaysLoad: Finmap tools are in the prompt from the start instead of
        // being deferred behind ToolSearch — one less round trip per agent,
        // and a subagent can't "lose" its tools.
        finmapServer = { ...httpRoute.config, timeout: 5 * 60_000, alwaysLoad: true };
      }

      // User-configured MCP servers (stdio child processes the SDK spawns).
      const userMcpConfigs = this.sessionStore.getMcpServers(session.id)
        .filter(s => s.enabled && s.name !== 'finmap');
      const userMcpServers: Record<string, { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }> = {};
      for (const cfg of userMcpConfigs) {
        userMcpServers[cfg.name] = {
          type: 'stdio',
          command: cfg.command,
          args: cfg.args,
          ...(cfg.env && Object.keys(cfg.env).length > 0 ? { env: cfg.env } : {}),
        };
      }
      const autoApproveByPrefix = new Map<string, boolean>();
      for (const cfg of userMcpConfigs) autoApproveByPrefix.set(`mcp__${cfg.name}__`, cfg.autoApproveAll);

      const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
        // Non-MCP built-ins: only the read-only set. Shell/file-writing tools
        // are also in disallowedTools; this is the backstop for any new
        // built-in a future CLI adds.
        if (!toolName.startsWith('mcp__')) {
          return SAFE_BUILTINS.has(toolName)
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: `Tool "${toolName}" is not available in Folio.` };
        }

        if (background || this.getAutoApprove(session.id)) {
          return { behavior: 'allow', updatedInput: input };
        }

        let needsConfirm: boolean;
        if (toolName === 'mcp__finmap__http_request') {
          // Reads are fine; anything that can send data out or change a
          // remote system is confirmed.
          const method = String((input as any)?.method ?? 'GET').toUpperCase();
          needsConfirm = method !== 'GET' && method !== 'HEAD';
        } else if (toolName.startsWith('mcp__finmap__')) {
          needsConfirm = MUTATION_TOOLS.has(toolName);
        } else {
          const prefix = [...autoApproveByPrefix.keys()].find(p => toolName.startsWith(p));
          // Unknown MCP source → confirm rather than trust.
          needsConfirm = prefix ? !autoApproveByPrefix.get(prefix) : true;
        }
        if (!needsConfirm) return { behavior: 'allow', updatedInput: input };

        h.onToolPermission?.(toolName, input);
        return new Promise<PermissionResult>((resolve) => {
          const queue = this.pendingConfirms.get(session.id) ?? [];
          this.pendingConfirms.set(session.id, queue);
          const entry: PendingConfirm = {
            toolName,
            input,
            resolve,
            timer: setTimeout(() => {
              const idx = queue.indexOf(entry);
              if (idx !== -1) queue.splice(idx, 1);
              resolve({
                behavior: 'deny',
                message: 'Користувач не підтвердив дію протягом 10 хвилин — скасовано автоматично.',
              });
            }, CONFIRM_TIMEOUT_MS),
          };
          queue.push(entry);
          signal.addEventListener('abort', () => {
            const idx = queue.indexOf(entry);
            if (idx !== -1) queue.splice(idx, 1);
            clearTimeout(entry.timer);
            resolve({ behavior: 'deny', message: 'Cancelled' });
          });
        });
      };

      // Prompt: lean for background, MCP-only persona without a Finmap key,
      // full prompt + subagent guidance for interactive chats.
      const basePrompt = background
        ? BACKGROUND_SYSTEM_PROMPT
        : (hasFinmap ? SYSTEM_PROMPT : MCP_ONLY_SYSTEM_PROMPT) + SUBAGENTS_PROMPT;
      const responseLanguage = this.sessionStore.getSettings().responseLanguage;
      const languageRule =
        responseLanguage === 'uk' ? '\n\n## Language\nALWAYS respond in Ukrainian, regardless of the language the user writes in.'
        : responseLanguage === 'en' ? '\n\n## Language\nALWAYS respond in English, regardless of the language the user writes in.'
        : '';
      const systemPrompt = (session.notes?.trim()
        ? `${basePrompt}\n\n## Company context (from user)\n${session.notes.trim()}`
        : basePrompt) + languageRule;

      const options: Options = {
        systemPrompt,
        maxTurns: background ? 20 : 30,
        abortController,
        canUseTool,
        // Workspace dir with `.claude/skills/` — Claude Code discovers skills
        // from the project source. User-level settings (~/.claude) are left
        // out on purpose so the user's own hooks/permissions/plugins from
        // their coding setup don't leak into Folio.
        cwd: this.workspaceCwd,
        settingSources: ['project'],
        // Only the MCP servers Folio passes — not the user's own .mcp.json,
        // plugins, or claude.ai connectors (which may even share a name like
        // "Finmap" and confuse the model).
        strictMcpConfig: true,
        env: {
          ...process.env,
          ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
          // Subagents run in the foreground: the Agent call returns the
          // finished result (several calls in one message still run in
          // parallel). Background agents made the main turn end early, fill
          // the reply with "waiting…" notes and resume agents by message.
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        } as Record<string, string>,
        pathToClaudeCodeExecutable: getClaudePath() || undefined,
        mcpServers: { ...userMcpServers, finmap: finmapServer },
        allowedTools: ALLOWED_TOOLS,
        // Background runs don't fan out into subagents — keeps unattended
        // cost predictable.
        disallowedTools: background ? [...DISALLOWED_TOOLS, 'Task', 'Agent'] : DISALLOWED_TOOLS,
        permissionMode: 'default',
        // Token-level streaming + per-turn usage (context size).
        includePartialMessages: !background,
        ...(background ? {} : { agents: hasFinmap ? FINMAP_AGENTS : MCP_ONLY_AGENTS }),
        stderr: (data: string) => { if (/error/i.test(data)) console.error('[claude]', data.trim()); },
      };

      // Per-session model; aliases resolve to the newest model of the tier.
      if (session.model?.trim()) options.model = session.model.trim();

      // Chat runs resume the chat conversation; background runs never do, so
      // task prompts don't end up in the user's chat history.
      const resumeId = background ? null : this.getClaudeSessionId(session.id);
      if (resumeId) options.resume = resumeId;

      const stream = sdk.query({ prompt: userMessage, options });

      let fullResponse = '';
      // With includePartialMessages text arrives as deltas and the complete
      // `assistant` message follows — append once. No deltas (older CLI or
      // background run) → fall back to the blocks.
      let sawTextDelta = false;
      let needsBreak = false;
      let turnInputTokens = 0;
      let contextTokens: number | undefined;
      let contextWindow: number | undefined = session.contextWindow;
      let resultUsage: MessageUsage | undefined;
      // With background subagents the CLI may emit several `result`
      // messages per query (the turn ends, a task finishes, the turn
      // resumes). Token counts add up; cost is cumulative in each result.
      const tokenSum = { input: 0, cacheRead: 0, output: 0, turns: 0 };
      // Subagents: CLI task id ↔ the Task tool_use that spawned it.
      const taskByToolUse = new Map<string, string>();
      const openTasks = new Set<string>();
      const seenTasks = new Set<string>();

      for await (const message of stream) {
        if (abortController.signal.aborted) break;

        if (!background && 'session_id' in message && message.session_id && !this.claudeSessionIds.get(session.id)) {
          this.claudeSessionIds.set(session.id, message.session_id);
          this.sessionStore.update(session.id, { claudeSessionId: message.session_id });
        }

        if ((message as any).type === 'rate_limit_event') {
          const snap = toRateLimitSnapshot((message as any).rate_limit_info);
          if (snap) {
            this.rateLimit = snap;
            this.onRateLimit?.(snap);
          }
          continue;
        }

        switch (message.type) {
          case 'stream_event': {
            if (message.parent_tool_use_id) break; // subagent text — shown as a card, not in the reply
            const ev = message.event as any;
            if (ev?.type === 'message_start') {
              sawTextDelta = false;
              needsBreak = fullResponse.length > 0 && !fullResponse.endsWith('\n');
              const u = ev.message?.usage ?? {};
              turnInputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
              contextTokens = turnInputTokens;
              h.onUsage?.({ contextTokens: turnInputTokens, contextWindow });
            } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              sawTextDelta = true;
              // Text after a tool round starts a new message — without a
              // break the two sentences run together ("…продовжити.Обидва…").
              const piece = (needsBreak ? '\n\n' : '') + ev.delta.text;
              needsBreak = false;
              fullResponse += piece;
              h.onChunk?.(piece);
            } else if (ev?.type === 'message_delta') {
              const afterTurn = turnInputTokens + (ev.usage?.output_tokens ?? 0);
              contextTokens = afterTurn;
              h.onUsage?.({ contextTokens: afterTurn, contextWindow });
            }
            break;
          }
          case 'assistant': {
            const content = message.message.content;
            if (!Array.isArray(content)) break;
            if (message.parent_tool_use_id) {
              // A subagent's own tool call — surface it on its card.
              const taskId = taskByToolUse.get(message.parent_tool_use_id);
              if (!taskId) break;
              for (const block of content as any[]) {
                if (block?.type === 'tool_use' && !SILENT_TOOLS.has(block.name)) h.onAgent?.({ kind: 'progress', id: taskId, tool: block.name });
              }
              break;
            }
            for (const block of content as any[]) {
              if (block?.type === 'text' && typeof block.text === 'string') {
                if (!sawTextDelta) {
                  const piece = (fullResponse.length > 0 && !fullResponse.endsWith('\n') ? '\n\n' : '') + block.text;
                  fullResponse += piece;
                  h.onChunk?.(piece);
                }
              } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
                // Subagent launches get their own card; don't double-show.
                if (!SUBAGENT_TOOLS.has(block.name) && !SILENT_TOOLS.has(block.name)) h.onToolCall?.(block.name, (block.input ?? {}) as Record<string, unknown>);
              }
            }
            break;
          }
          case 'system': {
            const m = message as any;
            if (m.subtype === 'compact_boundary') {
              contextTokens = undefined; // next message_start reports the post-compaction size
              h.onCompact?.(m.compact_metadata?.pre_tokens ?? 0);
            } else if (m.subtype === 'task_started') {
              const isAgent = m.task_type === 'local_agent' || typeof m.subagent_type === 'string';
              if (!isAgent || m.ambient || m.skip_transcript) break;
              openTasks.add(m.task_id);
              seenTasks.add(m.task_id);
              if (m.tool_use_id) taskByToolUse.set(m.tool_use_id, m.task_id);
              h.onAgent?.({
                kind: 'start',
                id: m.task_id,
                type: m.subagent_type ?? 'general-purpose',
                description: m.description ?? '',
                startedAt: Date.now(),
              });
            } else if (m.subtype === 'task_progress') {
              if (!openTasks.has(m.task_id)) break;
              h.onAgent?.({
                kind: 'progress',
                id: m.task_id,
                tool: m.last_tool_name && !SILENT_TOOLS.has(m.last_tool_name) ? m.last_tool_name : undefined,
                toolCount: m.usage?.tool_uses,
                tokens: m.usage?.total_tokens,
              });
            } else if (m.subtype === 'task_notification' || (m.subtype === 'task_updated' && ['completed', 'failed', 'killed'].includes(m.patch?.status))) {
              // task_updated(completed) usually arrives first, without usage;
              // the task_notification that follows carries tool/token counts.
              // Emit for both so the card gets its final numbers.
              if (!seenTasks.has(m.task_id)) break;
              if (!openTasks.has(m.task_id) && m.subtype !== 'task_notification') break;
              openTasks.delete(m.task_id);
              const status = m.status ?? m.patch?.status;
              h.onAgent?.({
                kind: 'end',
                id: m.task_id,
                ok: status === 'completed',
                endedAt: Date.now(),
                toolCount: m.usage?.tool_uses,
                tokens: m.usage?.total_tokens,
              });
            }
            break;
          }
          case 'result': {
            if (!background && message.session_id && !this.claudeSessionIds.get(session.id)) {
              this.claudeSessionIds.set(session.id, message.session_id);
              this.sessionStore.update(session.id, { claudeSessionId: message.session_id });
            }
            resultUsage = this.summariseUsage(message, tokenSum, contextTokens, contextWindow);
            if (message.subtype === 'success') {
              if (!fullResponse) {
                fullResponse = message.result;
                h.onChunk?.(message.result);
              }
            } else {
              const errs = (message as any).errors as string[] | undefined;
              const text = errs?.length ? errs.join('\n') : `Claude stopped: ${message.subtype}`;
              this.reportError(text, h);
              return;
            }
            break;
          }
        }
      }

      // Any subagent the CLI never closed (abort, crash) — close its card.
      for (const id of openTasks) h.onAgent?.({ kind: 'end', id, ok: false, endedAt: Date.now() });

      if (abortController.signal.aborted) {
        // The chat UI already reset itself on Stop; a background run must
        // record the cancellation instead of a silent empty "done".
        if (background) h.onError('Cancelled');
        return;
      }
      h.onDone(fullResponse, resultUsage);
    } catch (err: any) {
      if (err?.name === 'AbortError' || abortController.signal.aborted) {
        if (background) h.onError('Cancelled');
        return;
      }
      this.reportError(err?.message ?? 'Unknown error', h);
    } finally {
      httpRoute?.dispose();
      if (!background && this.chatRuns.get(session.id) === abortController) {
        this.chatRuns.delete(session.id);
        this.denyAllPending(session.id, 'Cancelled');
      }
    }
  }

  private reportError(text: string, h: SendHandlers) {
    if (isAuthError(text) && h.onAuthError) h.onAuthError(text);
    else h.onError(text);
  }

  /** Flatten the SDK result(s) into what the UI shows under a reply:
   *  tokens, turns, duration, context fill. Cost is intentionally dropped. */
  private summariseUsage(
    message: SDKResultMessage,
    tokenSum: { input: number; cacheRead: number; output: number; turns: number },
    contextTokens: number | undefined,
    fallbackContextWindow: number | undefined,
  ): MessageUsage {
    const u: Record<string, number | undefined> = (message.usage as any) ?? {};
    const byModel = (message.modelUsage ?? {}) as Record<string, { outputTokens?: number; contextWindow?: number }>;
    // The model with the most output answered; others are helpers.
    const primary = Object.keys(byModel)
      .sort((a, b) => (byModel[b].outputTokens ?? 0) - (byModel[a].outputTokens ?? 0))[0];
    const contextWindow = (primary && byModel[primary].contextWindow) || fallbackContextWindow;

    tokenSum.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    tokenSum.cacheRead += u.cache_read_input_tokens ?? 0;
    tokenSum.output += u.output_tokens ?? 0;
    tokenSum.turns += message.num_turns ?? 0;

    return {
      inputTokens: tokenSum.input,
      cacheReadTokens: tokenSum.cacheRead,
      outputTokens: tokenSum.output,
      durationMs: message.duration_ms ?? 0,
      numTurns: tokenSum.turns,
      model: primary,
      contextTokens,
      contextWindow,
    };
  }
}
