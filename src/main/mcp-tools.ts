import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { FinmapAPI } from './finmap-api';
import { reconcile } from './reconcile-matcher';
import { GDriveClient } from './gdrive-client';

let _sdk: typeof import('@anthropic-ai/claude-code') | null = null;
async function getSDK() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-code');
  return _sdk;
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Slim down operation object — keep only fields Claude needs */
function slimOp(op: any) {
  const slim: any = {
    id: op.id,
    type: op.type,
    sum: op.sum,
    currencyId: op.currencyId,
    date: op.date,
  };
  if (op.dateOfPayment && op.dateOfPayment !== op.date) slim.dateOfPayment = op.dateOfPayment;
  if (op.startDate) slim.startDate = op.startDate;
  if (op.endDate) slim.endDate = op.endDate;
  if (op.accountFromId) { slim.accountFromId = op.accountFromId; slim.accountFromName = op.accountFromName; }
  if (op.accountToId) { slim.accountToId = op.accountToId; slim.accountToName = op.accountToName; }
  if (op.categoryId && op.categoryId !== 'empty') { slim.categoryId = op.categoryId; slim.categoryName = op.categoryName; }
  if (op.counterpartyId && op.counterpartyId !== 'empty') { slim.counterpartyId = op.counterpartyId; slim.counterpartyName = op.counterpartyName; }
  if (op.projectIds?.length && op.projectIds[0] !== 'empty') { slim.projectIds = op.projectIds; slim.projects = op.projects; }
  if (op.tagIds?.length && op.tagIds[0] !== 'empty') { slim.tagIds = op.tagIds; slim.tags = op.tags; }
  if (op.comment) slim.comment = op.comment;
  if (op.exchangeRate && op.exchangeRate !== 1) slim.exchangeRate = op.exchangeRate;
  if (op.transactionCurrency && op.transactionCurrency !== op.currencyId) {
    slim.transactionCurrency = op.transactionCurrency;
    slim.transactionSum = op.transactionSum;
  }
  if (op.externalId) slim.externalId = op.externalId;
  return slim;
}

function slimAccount(a: any) {
  return { id: a.id, label: a.label, currencyId: a.currencyId, balance: a.balance };
}

function slimEntity(e: any) {
  const r: any = { id: e.id, label: e.label };
  if (e.parentId) r.parentId = e.parentId;
  return r;
}

export const MUTATION_TOOLS = new Set([
  'mcp__finmap__create_operation', 'mcp__finmap__patch_operation', 'mcp__finmap__delete_operation',
  'mcp__finmap__create_category', 'mcp__finmap__update_category', 'mcp__finmap__delete_category',
  'mcp__finmap__create_tag', 'mcp__finmap__update_tag', 'mcp__finmap__delete_tag',
  'mcp__finmap__create_project', 'mcp__finmap__update_project', 'mcp__finmap__delete_project',
  'mcp__finmap__create_counterparty', 'mcp__finmap__update_counterparty', 'mcp__finmap__delete_counterparty',
  'mcp__finmap__create_invoice', 'mcp__finmap__update_invoice', 'mcp__finmap__delete_invoice',
  'mcp__finmap__create_invoice_good', 'mcp__finmap__update_invoice_good', 'mcp__finmap__delete_invoice_good',
  'mcp__finmap__create_invoice_company', 'mcp__finmap__update_invoice_company', 'mcp__finmap__delete_invoice_company',
  'mcp__finmap__upsert_exchange_rate', 'mcp__finmap__delete_exchange_rate',
  'mcp__finmap__create_webhook', 'mcp__finmap__update_webhook', 'mcp__finmap__delete_webhook',
  'mcp__finmap__save_integration', 'mcp__finmap__update_integration', 'mcp__finmap__delete_integration',
  // MCP-server self-management — adding/removing other MCP servers is a
  // sensitive operation (it spawns child processes and stores API tokens),
  // so user must confirm via the same ConfirmationBar flow.
  'mcp__finmap__add_mcp_server', 'mcp__finmap__update_mcp_server', 'mcp__finmap__remove_mcp_server',
  // File import bindings — create/update/delete need user confirmation
  // because they configure recurring background imports that will create
  // operations in Finmap on schedule.
  'mcp__finmap__create_file_binding', 'mcp__finmap__update_file_binding', 'mcp__finmap__delete_file_binding',
  // Scheduled tasks — same pattern: recurring background activity that user
  // should explicitly authorize.
  'mcp__finmap__create_scheduled_task', 'mcp__finmap__update_scheduled_task', 'mcp__finmap__delete_scheduled_task',
]);

/**
 * Fetch all Finmap operations matching filters, transparently paginating
 * across the API's 100-per-page limit. Capped at 25 pages (2500 ops) so a
 * malformed query can't hammer Finmap; reconciliation windows are typically
 * a few days on one account, where this is overkill.
 */
async function fetchAllOperationsPaginated(api: FinmapAPI, filters: Record<string, unknown>) {
  const PAGE = 100;
  const MAX_PAGES = 25;
  const all: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await api.getOperations({ ...filters, limit: PAGE, offset: page * PAGE });
    const list = (result?.list ?? []) as any[];
    all.push(...list);
    if (list.length < PAGE) break;
  }
  return all;
}

/**
 * Derive signed amount from a Finmap operation for matcher consumption:
 *   income → +sum
 *   expense → −sum
 *   transfer → sign depends on whether the queried account is source (−) or
 *              destination (+); ambiguous cross-account transfers fall back
 *              to +sum so the user can spot them in the matcher's "extra" group.
 */
function toSignedAmount(op: any, queryAccountIds: string[]): number {
  const sum = Number(op?.sum) || 0;
  if (op?.type === 'income') return sum;
  if (op?.type === 'expense') return -sum;
  if (op?.type === 'transfer') {
    if (op.accountFromId && queryAccountIds.includes(op.accountFromId)) return -sum;
    if (op.accountToId && queryAccountIds.includes(op.accountToId)) return sum;
  }
  return sum;
}

export async function buildFinmapMcpServer(api: FinmapAPI, sessionStore?: any, sessionId?: string) {
  const { tool, createSdkMcpServer } = await getSDK();

  const tools = [
    // ── HTTP for external integrations ──
    tool('http_request', 'HTTP request to any external API. Methods: GET/POST/PUT/PATCH/DELETE. Used for integrations.',
      {
        url: z.string(),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().default('GET'),
        headers: z.record(z.string()).optional(),
        body: z.any().optional(),
      },
      async (input) => {
        try {
          const opts: RequestInit = {
            method: input.method,
            headers: { 'Content-Type': 'application/json', ...(input.headers ?? {}) },
          };
          if (input.body && input.method !== 'GET') {
            opts.body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
          }
          const res = await fetch(input.url, opts);
          const responseText = await res.text();
          const truncated = responseText.length > 100000 ? responseText.substring(0, 100000) + '\n...[truncated]' : responseText;
          let parsed: any;
          try { parsed = JSON.parse(truncated); } catch { parsed = null; }
          return text({ status: res.status, body: parsed ?? truncated });
        } catch (err: any) {
          return text({ error: err.message });
        }
      }
    ),

    // ── Reconciliation (deterministic matcher used by reconcile-statement skill) ──
    //
    // Two ways to call:
    //
    //   (A) PREFERRED — pass bank + accountIds + startDate + endDate.
    //       Tool fetches Finmap operations internally (paginated, signed-amount
    //       derived from type+accountFromId/accountToId), runs matcher, returns
    //       result. Claude only has to format the bank array — saves ~50% of
    //       arg-formatting time on big statements.
    //
    //   (B) Fallback — pass bank + finmap (both arrays). Use only when caller
    //       already has Finmap ops in hand (e.g., from a prior get_operations
    //       call) and wants to reuse them without refetching.
    tool('reconcile_match',
      'Match bank statement operations against Finmap operations using a 3-pass deterministic algorithm. ' +
      'Returns 5 groups: matched, matchedSplit, candidateMismatchDate, missingInFinmap, extraInFinmap. ' +
      'PREFERRED CALL: pass bank + accountIds + startDate + endDate — tool fetches Finmap side itself (much cheaper to format than two arrays). ' +
      'FALLBACK: pass bank + finmap arrays directly. ' +
      'Use ONLY through the reconcile-statement skill.',
      {
        bank: z.array(z.object({
          id: z.string(),
          date: z.string().describe('YYYY-MM-DD'),
          amount: z.number().describe('Signed: expense negative, income positive'),
          description: z.string().optional(),
        })).min(1),
        // Provide either finmap OR accountIds+dates — if both, finmap wins.
        finmap: z.array(z.object({
          id: z.string(),
          date: z.string(),
          amount: z.number(),
          counterparty: z.string().optional(),
          category: z.string().optional(),
        })).optional(),
        accountIds: z.array(z.string()).optional(),
        startDate: z.number().optional().describe('Unix ms — start of period to fetch from Finmap'),
        endDate: z.number().optional().describe('Unix ms — end of period to fetch from Finmap'),
        options: z.object({
          dateToleranceDays: z.number().optional(),
          splitWindowDays: z.number().optional(),
          maxSplitSize: z.number().optional(),
          amountEpsilon: z.number().optional(),
          dateMismatchMaxDays: z.number().optional(),
        }).optional(),
      },
      async (input) => {
        try {
          let finmapOps = input.finmap;

          // Path A: caller passed accountIds + dates → fetch internally
          if (!finmapOps) {
            if (!input.accountIds || input.accountIds.length === 0
                || input.startDate === undefined || input.endDate === undefined) {
              return text({
                error: 'Pass either `finmap` array OR `accountIds + startDate + endDate` so we can fetch Finmap operations.',
              });
            }
            const fetched = await fetchAllOperationsPaginated(api, {
              accountIds: input.accountIds,
              startDate: input.startDate,
              endDate: input.endDate,
            });
            finmapOps = fetched.map(op => ({
              id: op.id,
              date: typeof op.date === 'number'
                ? new Date(op.date).toISOString().slice(0, 10)
                : String(op.date).slice(0, 10),
              amount: toSignedAmount(op, input.accountIds!),
              counterparty: op.counterpartyName,
              category: op.categoryName,
            }));
          }

          const result = reconcile(input.bank, finmapOps, input.options ?? {});
          return text(result);
        } catch (err: any) {
          return text({ error: err?.message ?? 'reconcile_match failed' });
        }
      }
    ),

    // ── Accounts ──
    tool('get_accounts', 'List accounts. Call first when user mentions account by name.',
      { withBalances: z.boolean().optional().default(true) },
      async (input) => {
        const accounts = await api.getAccounts(input.withBalances);
        return text(accounts.map(slimAccount));
      }
    ),

    // ── Currencies ──
    tool('get_currencies', 'Supported currencies.', {}, async () => text(await api.getCurrencies())),
    tool('get_exchange_rates', 'Custom exchange rates.', {}, async () => text(await api.getCustomExchangeRates())),
    tool('upsert_exchange_rate', 'Create/update exchange rate.',
      { from: z.string(), to: z.string(), rate: z.number() },
      async (input) => text(await api.upsertCustomExchangeRate(input))
    ),
    tool('delete_exchange_rate', 'Delete exchange rate.',
      { from: z.string(), to: z.string() },
      async (input) => text(await api.deleteCustomExchangeRate(input.from, input.to))
    ),

    // ── Categories ──
    tool('get_categories', 'List categories by type.',
      { type: z.enum(['income', 'expense']) },
      async (input) => {
        const cats = input.type === 'income' ? await api.getIncomeCategories() : await api.getExpenseCategories();
        return text(cats.map(slimEntity));
      }
    ),
    tool('create_category', 'Create category. Pass label only for root, add parentId for subcategory.',
      {
        type: z.enum(['income', 'expense']),
        label: z.string(),
        parentId: z.string().optional(),
      },
      async (input) => {
        const body: { label: string; parentId?: string } = { label: input.label };
        if (input.parentId) body.parentId = input.parentId;
        return text(input.type === 'income' ? await api.createIncomeCategory(body) : await api.createExpenseCategory(body));
      }
    ),
    tool('update_category', 'Rename or move category.',
      {
        type: z.enum(['income', 'expense']),
        id: z.string(),
        label: z.string().optional(),
        parentId: z.string().optional(),
      },
      async (input) => {
        const body: any = {};
        if (input.label) body.label = input.label;
        if (input.parentId) body.parentId = input.parentId;
        return text(input.type === 'income' ? await api.updateIncomeCategory(input.id, body) : await api.updateExpenseCategory(input.id, body));
      }
    ),
    tool('delete_category', 'Delete category.',
      { type: z.enum(['income', 'expense']), id: z.string() },
      async (input) => text(input.type === 'income' ? await api.deleteIncomeCategory(input.id) : await api.deleteExpenseCategory(input.id))
    ),

    // ── Tags ──
    tool('get_tags', 'List tags.', {}, async () => text((await api.getTags()).map(slimEntity))),
    tool('create_tag', 'Create tag.',
      { label: z.string() },
      async (input) => text(await api.createTag(input))
    ),
    tool('update_tag', 'Rename tag.',
      { id: z.string(), label: z.string() },
      async (input) => text(await api.updateTag(input.id, { label: input.label }))
    ),
    tool('delete_tag', 'Delete tag.',
      { id: z.string() },
      async (input) => text(await api.deleteTag(input.id))
    ),

    // ── Projects ──
    tool('get_projects', 'List projects.', {}, async () => text((await api.getProjects()).map(slimEntity))),
    tool('create_project', 'Create project.',
      { label: z.string() },
      async (input) => text(await api.createProject(input))
    ),
    tool('update_project', 'Rename project.',
      { id: z.string(), label: z.string() },
      async (input) => text(await api.updateProject(input.id, { label: input.label }))
    ),
    tool('delete_project', 'Delete project.',
      { id: z.string() },
      async (input) => text(await api.deleteProject(input.id))
    ),

    // ── Counterparties ──
    tool('get_counterparties', 'List counterparties by type.',
      { type: z.enum(['suppliers', 'creditors', 'debitors', 'investors', 'employees', 'owners', 'tax-organisations']) },
      async (input) => {
        const map: Record<string, () => Promise<any[]>> = {
          suppliers: () => api.getSuppliers(), creditors: () => api.getCreditors(),
          debitors: () => api.getDebitors(), investors: () => api.getInvestors(),
          employees: () => api.getEmployees(), owners: () => api.getOwners(),
          'tax-organisations': () => api.getTaxOrganisations(),
        };
        return text((await map[input.type]()).map(slimEntity));
      }
    ),
    tool('create_counterparty', 'Create counterparty.',
      {
        type: z.enum(['suppliers', 'creditors', 'debitors', 'investors', 'employees', 'owners', 'tax-organisations']),
        label: z.string(),
      },
      async (input) => {
        const data = { label: input.label };
        const map: Record<string, () => Promise<any>> = {
          suppliers: () => api.createSupplier(data), creditors: () => api.createCreditor(data),
          debitors: () => api.createDebitor(data), investors: () => api.createInvestor(data),
          employees: () => api.createEmployee(data), owners: () => api.createOwner(data),
          'tax-organisations': () => api.createTaxOrganisation(data),
        };
        return text(await map[input.type]());
      }
    ),
    tool('update_counterparty', 'Rename counterparty.',
      {
        type: z.enum(['suppliers', 'creditors', 'debitors', 'investors', 'employees', 'owners', 'tax-organisations']),
        id: z.string(),
        label: z.string(),
      },
      async (input) => {
        const data = { label: input.label };
        const map: Record<string, () => Promise<any>> = {
          suppliers: () => api.updateSupplier(input.id, data), creditors: () => api.updateCreditor(input.id, data),
          debitors: () => api.updateDebitor(input.id, data), investors: () => api.updateInvestor(input.id, data),
          employees: () => api.updateEmployee(input.id, data), owners: () => api.updateOwner(input.id, data),
          'tax-organisations': () => api.updateTaxOrganisation(input.id, data),
        };
        return text(await map[input.type]());
      }
    ),
    tool('delete_counterparty', 'Delete counterparty.',
      {
        type: z.enum(['suppliers', 'creditors', 'debitors', 'investors', 'employees', 'owners', 'tax-organisations']),
        id: z.string(),
      },
      async (input) => {
        const map: Record<string, () => Promise<any>> = {
          suppliers: () => api.deleteSupplier(input.id), creditors: () => api.deleteCreditor(input.id),
          debitors: () => api.deleteDebitor(input.id), investors: () => api.deleteInvestor(input.id),
          employees: () => api.deleteEmployee(input.id), owners: () => api.deleteOwner(input.id),
          'tax-organisations': () => api.deleteTaxOrganisation(input.id),
        };
        return text(await map[input.type]());
      }
    ),

    // ── Operations ──
    tool('get_operations', 'Search operations with filters. Returns slim list. limit MUST be ≤100 (Finmap server-side cap) — for more, use offset to paginate.',
      {
        accountIds: z.array(z.string()).optional(),
        categoryIds: z.array(z.string()).optional(),
        counterpartyIds: z.array(z.string()).optional(),
        projectIds: z.array(z.string()).optional(),
        tagIds: z.array(z.string()).optional(),
        types: z.array(z.enum(['income', 'expense', 'transfer'])).optional(),
        search: z.string().optional(),
        startDate: z.number().optional(),
        endDate: z.number().optional(),
        sumFrom: z.number().optional(),
        sumTo: z.number().optional(),
        approved: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
        desc: z.boolean().optional().default(true),
      },
      async (input) => {
        const result = await api.getOperations(input);
        return text({ list: result.list.map(slimOp), total: result.total });
      }
    ),
    tool('get_operation_details', 'Get one operation by id or externalId.',
      { id: z.string().optional(), externalId: z.string().optional() },
      async (input) => {
        const result = await api.getOperationDetails(input);
        return text({ list: result.list.map(slimOp), total: result.total });
      }
    ),

    // Batch dedup helper — used by mass-import, integration-setup and sync
    // flows. ONE POST /operations/list call covers the whole sync window,
    // then we filter by externalId in code. Deterministic, no risk of Claude
    // mis-counting in its head.
    //
    // accountIds + a date range are REQUIRED by design — without them we'd
    // either have to scan the entire account history (slow, doesn't scale) or
    // fall back to per-ID lookups (1000 ops = 1000 requests, that's the bug
    // we're fixing). Making the params mandatory forces Claude to think about
    // the dedup window upfront.
    //
    // Internally we paginate up to MAX_PAGES × pageLimit ops, but typical sync
    // windows (24-48h on one account) fit in one page.
    tool('check_externalIds',
      'Batch-check which externalIds already exist as Finmap operations. Use BEFORE batch create_operation to dedupe. ' +
      'Does ONE Finmap list call internally and filters in code — handles 100s of IDs with a single API hit. ' +
      'REQUIRED: pass accountIds + startDate + endDate covering the window when those externalIds would have been created (e.g., for a 24h sync use the last 26h). ' +
      'Returns {existing: [...skip these...], missing: [...safe to create...], scannedOps, totalInWindow, warning?}.',
      {
        externalIds: z.array(z.string()).min(1).max(500),
        accountIds: z.array(z.string()).min(1),
        startDate: z.number(),
        endDate: z.number(),
      },
      async (input) => {
        const wanted = new Set(input.externalIds);
        const found = new Set<string>();

        // Finmap caps `limit` at 100 per /operations/list call (anything
        // higher → 400 "limit must not be greater than 100"). MAX_PAGES is
        // sized so we still cover up to 2500 ops if needed — typical sync
        // windows on one account fit in one page.
        const PAGE_LIMIT = 100;
        const MAX_PAGES = 25;
        let scanned = 0;
        let total = 0;
        let offset = 0;
        let warning: string | undefined;

        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await api.getOperations({
            accountIds: input.accountIds,
            startDate: input.startDate,
            endDate: input.endDate,
            limit: PAGE_LIMIT,
            offset,
          });
          const list = (result?.list ?? []) as any[];
          total = typeof result?.total === 'number' ? result.total : (scanned + list.length);
          scanned += list.length;
          for (const op of list) {
            if (typeof op?.externalId === 'string' && wanted.has(op.externalId)) {
              found.add(op.externalId);
            }
          }
          if (list.length < PAGE_LIMIT) break;          // got the tail
          if (found.size >= wanted.size) break;          // already matched everything wanted
          offset += PAGE_LIMIT;
          if (page === MAX_PAGES - 1 && scanned < total) {
            warning =
              `Scanned ${scanned} of ${total} operations in window; pagination capped at ${MAX_PAGES * PAGE_LIMIT}. ` +
              `Some externalIds in "missing" might actually exist beyond the scanned range — narrow the date window or split the batch.`;
          }
        }

        const existing = Array.from(found);
        const missing = input.externalIds.filter(eid => !found.has(eid));
        return text({
          existing,
          missing,
          checked: input.externalIds.length,
          scannedOps: scanned,
          totalInWindow: total,
          ...(warning ? { warning } : {}),
        });
      }
    ),

    // ── MCP self-management ──
    // These tools let Claude inspect and configure OTHER MCP servers attached
    // to the current session. Driven by the `mcp-setup` skill: user says
    // "connect Telegram" → Claude WebSearches → reads server's README →
    // gathers config + tokens from user → calls `add_mcp_server` (mutation,
    // confirmed by user). New servers activate from the NEXT user message
    // (current SDK session doesn't refresh mcpServers mid-conversation).
    tool('list_mcp_servers',
      'List MCP servers configured for the current session (Slack, Notion, Telegram, etc.). Returns name, command, args, env-var keys (values redacted), enabled, autoApproveAll. Use BEFORE add_mcp_server to avoid duplicates.',
      {},
      async () => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const list = (sessionStore.getMcpServers(sessionId) as any[]).map(s => ({
          id: s.id,
          name: s.name,
          command: s.command,
          args: s.args,
          envKeys: s.env ? Object.keys(s.env) : [],
          enabled: s.enabled,
          autoApproveAll: s.autoApproveAll,
        }));
        return text({ list });
      }
    ),
    tool('add_mcp_server',
      'Register a NEW MCP server for this session (Slack, Notion, Telegram, Figma, Postgres, anything that speaks MCP). After creation, the server becomes available to Claude on the NEXT user message — current message cannot use it yet. Always check `list_mcp_servers` first to avoid duplicates.',
      {
        name: z.string().min(1).describe('Lower-case namespace, no spaces. Becomes tool prefix: mcp__<name>__<tool>.'),
        command: z.string().min(1).describe('Executable to run, e.g. "npx", "uvx", or absolute path.'),
        args: z.array(z.string()).describe('Args passed to the executable, e.g. ["-y", "@modelcontextprotocol/server-slack"].'),
        env: z.record(z.string()).optional().describe('Env vars (API tokens). Stored locally in plaintext.'),
        autoApproveAll: z.boolean().optional().default(false).describe('When true, ALL tools from this server skip the per-call confirmation. Use only for trusted, read-mostly services.'),
      },
      async (input) => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const created = sessionStore.createMcpServer({
          sessionId,
          name: input.name.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
          command: input.command,
          args: input.args,
          env: input.env,
          enabled: true,
          autoApproveAll: input.autoApproveAll ?? false,
        });
        return text({
          created: { id: created.id, name: created.name, command: created.command, args: created.args },
          note: 'MCP server registered. It will be available from the NEXT user message in this session.',
        });
      }
    ),
    tool('update_mcp_server',
      'Update an existing MCP server config. Pass only fields to change.',
      {
        id: z.string(),
        name: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        enabled: z.boolean().optional(),
        autoApproveAll: z.boolean().optional(),
      },
      async (input) => {
        if (!sessionStore) return text({ error: 'session context unavailable' });
        const { id, ...updates } = input;
        const updated = sessionStore.updateMcpServer(id, updates);
        return text({ updated, note: 'Changes apply from the NEXT user message.' });
      }
    ),
    tool('remove_mcp_server',
      'Delete an MCP server from this session.',
      { id: z.string() },
      async (input) => {
        if (!sessionStore) return text({ error: 'session context unavailable' });
        const ok = sessionStore.deleteMcpServer(input.id);
        return text({ deleted: ok });
      }
    ),

    // ── Credential file management ──
    // Users paste Service Account JSON / OAuth credentials right into the
    // chat for convenience (non-technical users don't know what "absolute
    // file path" means). We save the content to a per-app credentials dir
    // and hand the resulting path back — that path goes into env of the
    // MCP server. Means: never `cat` a JSON in a prompt to keep it private;
    // it's saved once, MCP server reads it from disk on every spawn.
    tool('save_service_account_key',
      'Persist a Google Service Account JSON (or any service credential file) to the local Folio credentials dir and return its absolute path. ' +
      'Use this when the user pastes JSON content of a Service Account into chat — call this tool first, then pass the returned `path` into the env of the MCP server you\'re configuring. ' +
      'The file is saved per-user in Folio\'s userData (OS-protected). DO NOT echo the JSON content back to the user — just confirm the email/project.',
      {
        jsonContent: z.string().min(20).describe('Raw JSON content of the Service Account key file pasted by the user.'),
        label: z.string().optional().describe('Short label for filename, e.g. "gsheets" or "gdrive-sa". Defaults to "credential".'),
      },
      async (input) => {
        let parsed: any;
        try {
          parsed = JSON.parse(input.jsonContent);
        } catch {
          return text({ error: 'Це не валідний JSON. Перевір що скопіював весь вміст файла, від { до }.' });
        }
        // Sanity check — Service Account JSON has these fields. Don't enforce
        // strictly (OAuth credentials have different shape), just hint.
        if (!parsed.private_key && !parsed.client_email && !parsed.client_id) {
          return text({ error: 'JSON не схожий на Google credentials — не бачу ні private_key, ні client_email. Перевір що скопіював саме файл ключа Service Account.' });
        }

        const credentialsDir = path.join(app.getPath('userData'), 'credentials');
        try { fs.mkdirSync(credentialsDir, { recursive: true }); } catch {}

        const label = (input.label ?? 'credential').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const suffix = crypto.randomBytes(4).toString('hex');
        const filePath = path.join(credentialsDir, `${label || 'credential'}-${suffix}.json`);

        // Write with restrictive permissions on Unix. On Windows the
        // userData dir is already user-scoped by NTFS ACL.
        fs.writeFileSync(filePath, input.jsonContent, { encoding: 'utf-8' });
        try { fs.chmodSync(filePath, 0o600); } catch {}

        return text({
          path: filePath,
          email: parsed.client_email,
          projectId: parsed.project_id,
          note: 'Ключ збережено локально у Folio. Передай шлях у поле SERVICE_ACCOUNT_PATH (або аналогічне) у env MCP-сервера.',
        });
      }
    ),

    // ── File import bindings (folder → Finmap auto-sync) ──
    // These tools let the folder-import-setup skill configure recurring
    // file imports. State (`processedFileIds`) is mutated by
    // `mark_files_processed` after each successful import to dedupe future runs.
    tool('list_file_bindings',
      'List file-import bindings for the current session — each binding watches a folder in an external service (Google Drive etc.) and auto-imports new files into a Finmap account. Returns id, source, account, contextPrompt, intervalMin, enabled, processedCount, lastSync.',
      {},
      async () => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const list = (sessionStore.getFileBindings(sessionId) as any[]).map(b => ({
          id: b.id,
          sourceServerName: b.sourceServerName,
          sourceFolderId: b.sourceFolderId,
          sourceFolderName: b.sourceFolderName,
          finmapAccountId: b.finmapAccountId,
          finmapAccountName: b.finmapAccountName,
          contextPrompt: b.contextPrompt,
          syncIntervalMin: b.syncIntervalMin,
          enabled: b.enabled,
          processedCount: b.processedFileIds?.length ?? 0,
          lastSync: b.lastSync,
        }));
        return text({ list });
      }
    ),
    tool('create_file_binding',
      'Create a new file-import binding. After creation, the scheduler will check the folder every `syncIntervalMin` minutes and import any file whose ID is not in `processedFileIds`. ' +
      'IMPORTANT: pass `processedFileIds` already filled with the IDs of ALL existing files in the folder at setup time — this is the BASELINE that prevents bulk-importing the back catalog. New files added AFTER this moment are what gets imported.',
      {
        sourceServerName: z.string().describe('MCP server namespace, e.g. "gdrive".'),
        sourceFolderId: z.string().describe('Folder ID from the source MCP server.'),
        sourceFolderName: z.string().describe('Human label for UI, e.g. "Bank Statements / 2026".'),
        finmapAccountId: z.string(),
        finmapAccountName: z.string(),
        contextPrompt: z.string().describe('Free-text policy: which category, counterparty, operation type, parsing hints. Example: "Категорія: Продаж послуг. Тип: дохід. Для .pdf — банківська виписка."'),
        syncIntervalMin: z.number().int().min(5).max(1440).default(30),
        processedFileIds: z.array(z.string()).default([]).describe('Baseline file IDs to skip on first run. Pre-populate with all existing folder files so we only import NEW ones.'),
      },
      async (input) => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const created = sessionStore.createFileBinding({
          sessionId,
          sourceServerName: input.sourceServerName,
          sourceFolderId: input.sourceFolderId,
          sourceFolderName: input.sourceFolderName,
          finmapAccountId: input.finmapAccountId,
          finmapAccountName: input.finmapAccountName,
          contextPrompt: input.contextPrompt,
          syncIntervalMin: input.syncIntervalMin,
          enabled: true,
          processedFileIds: input.processedFileIds ?? [],
        });
        return text({ created, note: `Binding active. Will start scanning every ${created.syncIntervalMin} min. ${created.processedFileIds.length} existing files marked as baseline.` });
      }
    ),
    tool('update_file_binding',
      'Update a file-import binding. Pass only fields to change. Most common: change `contextPrompt`, `syncIntervalMin`, or `enabled`.',
      {
        id: z.string(),
        sourceFolderName: z.string().optional(),
        finmapAccountId: z.string().optional(),
        finmapAccountName: z.string().optional(),
        contextPrompt: z.string().optional(),
        syncIntervalMin: z.number().int().min(5).max(1440).optional(),
        enabled: z.boolean().optional(),
      },
      async (input) => {
        if (!sessionStore) return text({ error: 'session context unavailable' });
        const { id, ...updates } = input;
        const updated = sessionStore.updateFileBinding(id, updates);
        return text({ updated });
      }
    ),
    tool('delete_file_binding',
      'Delete a file-import binding. Does NOT touch already-imported operations in Finmap.',
      { id: z.string() },
      async (input) => {
        if (!sessionStore) return text({ error: 'session context unavailable' });
        const ok = sessionStore.deleteFileBinding(input.id);
        return text({ deleted: ok });
      }
    ),
    tool('mark_files_processed',
      'Mark a list of file IDs as processed for a binding. Call AFTER successfully importing those files into Finmap so the next scheduler run skips them. ' +
      'Also used during initial setup to seed the baseline — all existing folder files marked here, only future additions will be picked up.',
      {
        bindingId: z.string(),
        fileIds: z.array(z.string()).min(1),
      },
      async (input) => {
        if (!sessionStore) return text({ error: 'session context unavailable' });
        const updated = sessionStore.markFilesProcessed(input.bindingId, input.fileIds);
        return text({
          updated: updated ? { id: updated.id, processedCount: updated.processedFileIds.length } : null,
        });
      }
    ),

    // ── Scheduled tasks (recurring background runs) ──
    // These let Claude propose "let's make this a recurring task" after a
    // successful one-off operation. Pattern: user asks for something, Claude
    // does it, then asks "shall I run this every N?" — on yes, calls
    // create_scheduled_task with the same prompt that just worked.
    tool('list_scheduled_tasks',
      'List recurring scheduled tasks for the current session. Returns id, name, prompt (truncated to 200ch), intervalMin, enabled, lastRun, lastStatus.',
      {},
      async () => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const list = (sessionStore.getTasks(sessionId) as any[]).map(t => ({
          id: t.id,
          name: t.name,
          prompt: typeof t.prompt === 'string' && t.prompt.length > 200 ? t.prompt.slice(0, 200) + '…' : t.prompt,
          intervalMin: t.intervalMin,
          enabled: t.enabled,
          lastRun: t.lastRun,
          lastStatus: t.lastStatus,
        }));
        return text({ list });
      }
    ),
    tool('create_scheduled_task',
      'Create a recurring task that runs `prompt` on a schedule. Use AFTER successfully doing a one-off operation that the user wants to automate (daily report, weekly sync, hourly check). ' +
      'CRITICAL: write the prompt SELF-CONTAINED — it will run on its own without prior chat context. No "the data we just discussed" — re-fetch on each run. ' +
      'Include explicit MCP tool names where useful (e.g. "use mcp__gsheets__update_values to ..."). Background runs have a leaner system prompt without the skills list.',
      {
        name: z.string().min(1).describe('Short human label, e.g. "Daily category report".'),
        prompt: z.string().min(10).describe('Self-contained instruction. Should produce the same intended result whenever it runs.'),
        intervalMin: z.number().int().min(5).max(43200).default(60).describe('5..43200 (30 days)'),
      },
      async (input) => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const created = sessionStore.createTask({
          sessionId,
          name: input.name.trim(),
          prompt: input.prompt.trim(),
          intervalMin: input.intervalMin,
          enabled: true,
        });
        return text({
          created: { id: created.id, name: created.name, intervalMin: created.intervalMin },
          note: 'Task active. Find it in Settings → Автозадачі — there you can pause, edit, or run it manually (▶ button).',
        });
      }
    ),
    tool('update_scheduled_task',
      'Update an existing scheduled task. Pass only fields to change.',
      {
        id: z.string(),
        name: z.string().optional(),
        prompt: z.string().optional(),
        intervalMin: z.number().int().min(5).max(43200).optional(),
        enabled: z.boolean().optional(),
      },
      async (input) => {
        if (!sessionStore) return text({ error: 'session context unavailable' });
        const { id, ...updates } = input;
        const updated = sessionStore.updateTask(id, updates);
        return text({ updated });
      }
    ),
    tool('delete_scheduled_task',
      'Delete a scheduled task. Permanent.',
      { id: z.string() },
      async (input) => {
        if (!sessionStore) return text({ error: 'session context unavailable' });
        const ok = sessionStore.deleteTask(input.id);
        return text({ deleted: ok });
      }
    ),

    // ── Google Drive (direct, via session's API key) ──
    // Powers the gdrive-direct folder-import flow. Reads the API key from
    // the session (set in Settings → Google Drive API Key) and talks to
    // Drive v3 REST directly — no OAuth, no MCP subprocess. Public-with-link
    // folders are the supported access model.
    tool('gdrive_list_files',
      'List files in a public Google Drive folder (must be shared "anyone with the link"). Returns id, name, mimeType, createdTime, modifiedTime, size. Sorted by modifiedTime desc. Use this from folder-import bindings to discover new files.',
      {
        folderId: z.string().describe('Folder ID — the segment after /folders/ in a Drive URL.'),
        pageSize: z.number().int().min(1).max(1000).optional().default(100),
      },
      async (input) => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const session = sessionStore.get(sessionId);
        const key = session?.googleDriveApiKey;
        if (!key) return text({ error: 'No Google Drive API key configured for this session. Open Settings → Google Drive API Key and paste yours.' });
        try {
          const files = await new GDriveClient(key).listFiles(input.folderId, { pageSize: input.pageSize });
          return text({ files });
        } catch (err: any) {
          return text({ error: err?.message ?? 'Drive list failed' });
        }
      }
    ),
    tool('gdrive_get_file_content',
      'Download a single Drive file. Google-native files are exported: Sheets → CSV (returned as decoded text + rowCount/charCount so you can verify completeness), Docs → plain text, Slides → PDF (base64). Other files come back base64. ' +
      'SHEETS WITH MULTIPLE TABS: pass `gid` to read a SPECIFIC tab. Without `gid` only the FIRST tab is exported and other tabs are silently ignored — the response will carry a warning. CSV output is properly quoted, so cell values containing commas, pipes (|) or newlines stay intact (do NOT treat them as column separators).',
      {
        fileId: z.string(),
        mimeType: z.string().describe('Source mimeType returned by gdrive_list_files. Determines whether we download raw or export.'),
        gid: z.string().optional().describe('Google Sheets ONLY: the tab id from the URL (the gid=NNN segment, e.g. "1372508757"). Required to read a specific tab — the sheet must be shared "Anyone with the link". Omit for the first/default tab.'),
      },
      async (input) => {
        if (!sessionStore || !sessionId) return text({ error: 'session context unavailable' });
        const session = sessionStore.get(sessionId);
        const key = session?.googleDriveApiKey;
        if (!key) return text({ error: 'No Google Drive API key configured for this session.' });
        try {
          const client = new GDriveClient(key);

          if (input.mimeType === 'application/vnd.google-apps.spreadsheet') {
            // Read a specific tab when a gid is given — Drive's /export ignores
            // tabs, so we go through the gid-aware Sheets export path.
            if (input.gid) {
              const { csv, size } = await client.exportSheetTab(input.fileId, input.gid);
              const rowCount = csv.length ? csv.split('\n').length : 0;
              return text({
                format: 'csv',
                tab: `gid=${input.gid}`,
                csv,
                rowCount,
                charCount: csv.length,
                byteSize: size,
                truncated: false,
                note: 'Full CSV of ONE tab (gid). Reconcile rowCount with the expected total BEFORE counting/aggregating.',
              });
            }
            // No gid → first tab only. Surface this loudly so a multi-tab sheet
            // doesn't get silently mis-counted.
            const result = await client.exportFile(input.fileId, 'text/csv');
            const csv = Buffer.from(result.base64, 'base64').toString('utf-8');
            const rowCount = csv.length ? csv.split('\n').length : 0;
            return text({
              format: 'csv',
              tab: 'FIRST tab only',
              csv,
              rowCount,
              charCount: csv.length,
              byteSize: result.size,
              truncated: false,
              warning: '⚠️ Exported the FIRST tab ONLY. If you need another tab (the source URL has a gid=NNN segment), call again with the `gid` parameter — otherwise any count/aggregate will be based on the wrong tab.',
            });
          }

          if (input.mimeType === 'application/vnd.google-apps.document') {
            const result = await client.exportFile(input.fileId, 'text/plain');
            const docText = Buffer.from(result.base64, 'base64').toString('utf-8');
            return text({ format: 'text', text: docText, charCount: docText.length, byteSize: result.size, truncated: false });
          }

          let result: { base64: string; size: number };
          if (input.mimeType === 'application/vnd.google-apps.presentation') {
            result = await client.exportFile(input.fileId, 'application/pdf');
          } else {
            result = await client.downloadFile(input.fileId);
          }
          return text({
            base64: result.base64,
            size: result.size,
            note: result.size > 2_000_000 ? 'File is large (>2MB) — only first portion may be useful for parsing.' : undefined,
          });
        } catch (err: any) {
          return text({ error: err?.message ?? 'Drive download failed' });
        }
      }
    ),

    tool('create_operation',
      'Create income/expense/transfer. ' +
      'DATES: `date` is the accrual date (default — required for cash-basis). `dateOfPayment` is the actual payment date when it differs from accrual (e.g., invoice issued on 1st, paid on 15th). ' +
      '`startDate`+`endDate` define an accrual PERIOD instead of a single date (e.g., May rent = 1.05–31.05). Period works ONLY on operations that have a `categoryId` (or `categories[]` split) — Finmap rule. Pass either `date` OR `startDate`+`endDate`, not both. ' +
      'SPLIT: for split across multiple projects OR multiple categories — pass `projects[]` OR `categories[]` arrays (NOT both). Each item: {id, stake, sum} where stake is percent (sum to 100) and sum is absolute amount in operation currency. System categories cannot be split.',
      {
        type: z.enum(['income', 'expense', 'transfer']),
        amount: z.number().min(0),
        date: z.number().optional().describe('Accrual date (Unix ms). Required unless startDate+endDate provided.'),
        dateOfPayment: z.number().optional().describe('Actual payment date (Unix ms). Set when payment date differs from accrual date.'),
        startDate: z.number().optional().describe('Accrual period start (Unix ms). Alternative to single `date` for periodic operations (rent for May, salary for week). Requires categoryId.'),
        endDate: z.number().optional().describe('Accrual period end (Unix ms). Paired with startDate.'),
        comment: z.string().optional(),
        accountToId: z.string().optional(),
        accountFromId: z.string().optional(),
        categoryId: z.string().optional(),
        counterpartyId: z.string().optional(),
        projectId: z.string().optional(),
        tagIds: z.array(z.string()).optional(),
        amountTo: z.number().optional(),
        externalId: z.string().optional(),
        exchangeRate: z.number().optional(),
        amountInCompanyCurrency: z.number().optional(),
        projects: z.array(z.object({
          id: z.string(),
          stake: z.number(),
          sum: z.number().optional(),
          companyCurrencySum: z.number().optional(),
          transactionSum: z.number().optional(),
        })).optional(),
        categories: z.array(z.object({
          id: z.string(),
          stake: z.number(),
          sum: z.number().optional(),
          companyCurrencySum: z.number().optional(),
          transactionSum: z.number().optional(),
        })).optional(),
      },
      async (input) => {
        const { type, ...data } = input;
        const map = { income: () => api.createIncomeOperation(data), expense: () => api.createExpenseOperation(data), transfer: () => api.createTransferOperation(data) };
        return text(await map[type]());
      }
    ),
    tool('patch_operation',
      'Update operation. Pass only fields to change. ' +
      'DATES: `date` = accrual date; `dateOfPayment` = actual payment date when different from accrual; `startDate`+`endDate` = accrual PERIOD (only for operations with categoryId — Finmap rule). To switch from single date to period or vice versa, pass the new fields — backend handles the swap. ' +
      'SPLIT: to convert single-project/category op into a split — pass projects[] or categories[] (mutually exclusive). System categories cannot be split.',
      {
        type: z.enum(['income', 'expense', 'transfer']),
        id: z.string(),
        amount: z.number().min(0).optional(),
        date: z.number().optional().describe('Accrual date (Unix ms).'),
        dateOfPayment: z.number().optional().describe('Actual payment date (Unix ms). Set when payment date differs from accrual.'),
        startDate: z.number().optional().describe('Accrual period start (Unix ms). Use instead of `date` for periodic operations. Requires categoryId.'),
        endDate: z.number().optional().describe('Accrual period end (Unix ms). Paired with startDate.'),
        comment: z.string().optional(),
        categoryId: z.string().optional(),
        counterpartyId: z.string().optional(),
        projectId: z.string().optional(),
        tagIds: z.array(z.string()).optional(),
        accountToId: z.string().optional(),
        accountFromId: z.string().optional(),
        projects: z.array(z.object({
          id: z.string(),
          stake: z.number(),
          sum: z.number().optional(),
          companyCurrencySum: z.number().optional(),
          transactionSum: z.number().optional(),
        })).optional(),
        categories: z.array(z.object({
          id: z.string(),
          stake: z.number(),
          sum: z.number().optional(),
          companyCurrencySum: z.number().optional(),
          transactionSum: z.number().optional(),
        })).optional(),
      },
      async (input) => {
        const { type, id, ...data } = input;
        const map = { income: () => api.patchIncomeOperation(id, data), expense: () => api.patchExpenseOperation(id, data), transfer: () => api.patchTransferOperation(id, data) };
        return text(await map[type]());
      }
    ),
    tool('delete_operation', 'Delete operation.',
      { type: z.enum(['income', 'expense', 'transfer']), id: z.string() },
      async (input) => {
        const map = { income: () => api.deleteIncomeOperation(input.id), expense: () => api.deleteExpenseOperation(input.id), transfer: () => api.deleteTransferOperation(input.id) };
        return text(await map[input.type]());
      }
    ),

    // ── Invoices ──
    tool('get_invoices', 'List invoices.',
      {
        limit: z.number().optional().default(50),
        offset: z.number().optional().default(0),
        counterpartyIds: z.array(z.string()).optional(),
        startDate: z.number().optional(),
        endDate: z.number().optional(),
        confirmedInvoice: z.boolean().optional(),
        invoiceStatus: z.enum(['overdue', 'payed', 'notPayed', 'all']).optional(),
      },
      async (input) => text(await api.getInvoices(input))
    ),
    tool('get_invoice_details', 'Get invoice by id or externalId.',
      { id: z.string().optional(), externalId: z.string().optional() },
      async (input) => text(await api.getInvoiceDetails(input))
    ),
    tool('create_invoice', 'Create invoice.',
      {
        invoiceNumber: z.string(),
        invoiceCompanyId: z.string(),
        supplierId: z.string(),
        invoiceCompanyDetails: z.string(),
        supplierDetails: z.string(),
        goods: z.array(z.object({ id: z.string(), count: z.number(), price: z.number(), vat: z.number().optional() })),
        invoiceCurrency: z.string(),
        date: z.number().optional(),
        dateOfPayment: z.number().optional(),
        comment: z.string().optional(),
        shipping: z.number().optional(),
        discountPercentage: z.number().optional(),
        discountAmount: z.number().optional(),
        externalId: z.string().optional(),
      },
      async (input) => text(await api.createInvoice(input))
    ),
    tool('update_invoice', 'Update invoice.',
      {
        id: z.string(),
        invoiceNumber: z.string().optional(),
        invoiceCompanyId: z.string().optional(),
        supplierId: z.string().optional(),
        invoiceCompanyDetails: z.string().optional(),
        supplierDetails: z.string().optional(),
        goods: z.array(z.object({ id: z.string(), count: z.number(), price: z.number(), vat: z.number().optional() })).optional(),
        invoiceCurrency: z.string().optional(),
        date: z.number().optional(),
        dateOfPayment: z.number().optional(),
        comment: z.string().optional(),
        shipping: z.number().optional(),
        discountPercentage: z.number().optional(),
        discountAmount: z.number().optional(),
        confirmedInvoice: z.boolean().optional(),
      },
      async (input) => {
        const { id, ...data } = input;
        return text(await api.updateInvoice(id, data));
      }
    ),
    tool('delete_invoice', 'Delete invoice.',
      { id: z.string() },
      async (input) => text(await api.deleteInvoice(input.id))
    ),

    // ── Invoice goods & companies ──
    tool('get_invoice_goods', 'List invoice goods.', {}, async () => text((await api.getInvoiceGoods()).map(slimEntity))),
    tool('create_invoice_good', 'Create invoice good.',
      { label: z.string() },
      async (input) => text(await api.createInvoiceGood(input))
    ),
    tool('update_invoice_good', 'Rename invoice good.',
      { id: z.string(), label: z.string() },
      async (input) => text(await api.updateInvoiceGood(input.id, { label: input.label }))
    ),
    tool('delete_invoice_good', 'Delete invoice good.',
      { id: z.string() },
      async (input) => text(await api.deleteInvoiceGood(input.id))
    ),

    tool('get_invoice_companies', 'List invoice companies.', {}, async () => text((await api.getInvoiceCompanies()).map(slimEntity))),
    tool('create_invoice_company', 'Create invoice company.',
      { label: z.string() },
      async (input) => text(await api.createInvoiceCompany(input))
    ),
    tool('update_invoice_company', 'Rename invoice company.',
      { id: z.string(), label: z.string() },
      async (input) => text(await api.updateInvoiceCompany(input.id, { label: input.label }))
    ),
    tool('delete_invoice_company', 'Delete invoice company.',
      { id: z.string() },
      async (input) => text(await api.deleteInvoiceCompany(input.id))
    ),

    // ── Webhooks ──
    tool('get_webhooks', 'List webhooks.', {}, async () => text(await api.getWebhooks())),
    tool('create_webhook', 'Create webhook.',
      { name: z.string(), url: z.string() },
      async (input) => text(await api.createWebhook(input))
    ),
    tool('update_webhook', 'Update webhook.',
      { id: z.string(), name: z.string().optional(), url: z.string().optional() },
      async (input) => {
        const { id, ...data } = input;
        return text(await api.updateWebhook(id, data));
      }
    ),
    tool('delete_webhook', 'Delete webhook.',
      { id: z.string() },
      async (input) => text(await api.deleteWebhook(input.id))
    ),

    // ── Integrations ──
    tool('save_integration', 'Save integration for auto-sync. syncPrompt = detailed instruction for self (URL, headers, parsing).',
      {
        serviceName: z.string(),
        serviceApiKey: z.string(),
        finmapAccountId: z.string(),
        finmapAccountName: z.string().optional(),
        syncIntervalMin: z.number().optional().default(30),
        syncPrompt: z.string(),
      },
      async (input) => {
        if (!sessionStore || !sessionId) return text({ error: 'unavailable' });
        const integration = sessionStore.createIntegration({
          sessionId,
          serviceName: input.serviceName,
          serviceApiKey: input.serviceApiKey,
          finmapAccountId: input.finmapAccountId,
          finmapAccountName: input.finmapAccountName,
          syncIntervalMin: input.syncIntervalMin,
          syncPrompt: input.syncPrompt,
          enabled: true,
        });
        return text({ saved: true, integrationId: integration.id });
      }
    ),
    tool('list_integrations', 'List saved integrations.', {},
      async () => {
        if (!sessionStore || !sessionId) return text({ error: 'unavailable' });
        return text(sessionStore.getIntegrations(sessionId).map((i: any) => ({
          id: i.id, service: i.serviceName, account: i.finmapAccountName || i.finmapAccountId,
          enabled: i.enabled, interval: `${i.syncIntervalMin}min`,
          lastSync: i.lastSync ? new Date(i.lastSync).toISOString() : 'never',
        })));
      }
    ),
    tool('update_integration', 'Update existing integration in place. Use this — DO NOT save_integration again — when changing rules of an integration that already exists. Pass only fields you want to change.',
      {
        id: z.string(),
        serviceName: z.string().optional(),
        serviceApiKey: z.string().optional(),
        finmapAccountId: z.string().optional(),
        finmapAccountName: z.string().optional(),
        syncIntervalMin: z.number().optional(),
        syncPrompt: z.string().optional(),
      },
      async (input) => {
        if (!sessionStore) return text({ error: 'unavailable' });
        const { id, ...updates } = input;
        const r = sessionStore.updateIntegration(id, updates);
        return text(r ? { updated: true, id: r.id } : { error: 'not found' });
      }
    ),
    tool('toggle_integration', 'Enable/disable integration.',
      { id: z.string() },
      async (input) => {
        if (!sessionStore) return text({ error: 'unavailable' });
        const r = sessionStore.toggleIntegration(input.id);
        return text(r ? { id: r.id, enabled: r.enabled } : { error: 'not found' });
      }
    ),
    tool('delete_integration', 'Delete integration.',
      { id: z.string() },
      async (input) => {
        if (!sessionStore) return text({ error: 'unavailable' });
        return text({ deleted: sessionStore.deleteIntegration(input.id) });
      }
    ),
  ];

  return createSdkMcpServer({ name: 'finmap', version: '1.0.0', tools });
}
