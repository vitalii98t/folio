/**
 * Finmap API HTTP client — endpoints of the public API v2.2
 * (https://api.finmap.online). Every call goes through a per-company rate
 * limiter — see finmap-rate-limiter.ts.
 */
import { finmapLimiterFor, retryAfterMs, FinmapRateLimiter, type FinmapPriority } from './finmap-rate-limiter';

const BASE_URL = 'https://api.finmap.online/v2.2';
const REQUEST_TIMEOUT_MS = 60_000;   // hard cap per request
const MAX_RETRIES = 2;                // total = 1 + 2 = 3 attempts
const RETRY_DELAY_MS = 1_500;         // backoff base

/** A 429 is refused before processing and not counted, so it is replayed for
 *  every method. These bound how long one call may sit in rate-limit waits
 *  (another client of the same company can keep the quota busy). */
const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_RATE_LIMIT_WAIT_MS = 150_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** POST endpoints that are pure queries (list/search, no side effects) and
 *  therefore safe to replay. Every other POST creates something. */
const IDEMPOTENT_POST_PATHS = new Set([
  '/operations/list',
  '/operations/invoices/list',
]);

/** True when replaying the request cannot change server state twice.
 *  Creates/updates/deletes are NEVER retried on timeouts or 5xx: those don't
 *  tell us whether Finmap already applied the write, and a replay could
 *  duplicate an operation (money!) or clobber a concurrent edit. */
function isIdempotentRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  return m === 'POST' && IDEMPOTENT_POST_PATHS.has(path);
}

export type OperationType = 'income' | 'expense' | 'transfer';

export interface FinmapAPIOptions {
  /** 'background' for scheduled tasks/syncs — they yield to the chat when
   *  the company's request quota is tight. Default 'interactive'. */
  priority?: FinmapPriority;
  /** Test hook. */
  baseUrl?: string;
  /** Test hook — defaults to the shared per-key limiter. */
  limiter?: FinmapRateLimiter;
}

export class FinmapAPI {
  private readonly priority: FinmapPriority;
  private readonly baseUrl: string;
  private readonly limiterOverride?: FinmapRateLimiter;

  constructor(private apiKey: string | undefined, opts: FinmapAPIOptions = {}) {
    this.priority = opts.priority ?? 'interactive';
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.limiterOverride = opts.limiter;
  }

  /** True when this client has credentials to actually call Finmap. Tools
   *  should short-circuit with a clear error before HTTP round-trip in
   *  MCP-only sessions (where the user hasn't added a key). */
  hasKey(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  private get limiter(): FinmapRateLimiter {
    return this.limiterOverride ?? finmapLimiterFor((this.apiKey as string).trim());
  }

  /** Wait for a request slot in this company's quota. For callers that reach
   *  api.finmap.online outside this client (the generic http_request tool). */
  async throttle(): Promise<void> {
    if (this.hasKey()) await this.limiter.acquire(this.priority);
  }

  /** Feed rate-limit headers from such an outside call back to the limiter. */
  noteResponse(res: { status: number; headers: { get(name: string): string | null } }) {
    if (!this.hasKey()) return;
    this.limiter.observe(res.headers);
    if (res.status === 429) this.limiter.block(retryAfterMs(res.headers));
  }

  private request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    return this.exec(method, path, body, query, 'json') as Promise<T>;
  }

  private async exec(
    method: string,
    path: string,
    body: unknown,
    query: Record<string, string> | undefined,
    responseType: 'json' | 'binary',
  ): Promise<unknown> {
    if (!this.hasKey()) {
      throw new Error(
        'Finmap не підключено для цієї сесії. Додай API-ключ Finmap у налаштуваннях сесії, щоб користуватись Finmap-інструментами.'
      );
    }
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }

    const limiter = this.limiter;
    const canRetry = isIdempotentRequest(method, path);
    let attempt = 0;
    let rateRetries = 0;
    let rateWaitedMs = 0;

    for (;;) {
      // Blocks while the company's 5 s / 1 min windows are full.
      await limiter.acquire(this.priority);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      let payload: string | ArrayBuffer;
      try {
        res = await fetch(url.toString(), {
          method,
          headers: {
            'Content-Type': 'application/json',
            // Guaranteed non-empty here — hasKey() check at the top.
            'apiKey': this.apiKey as string,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        payload = responseType === 'binary' && res.ok ? await res.arrayBuffer() : await res.text();
      } catch (err: any) {
        const isAbort = err?.name === 'AbortError';
        const isNetwork = /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(err?.message ?? '');
        // Only idempotent reads are replayed on timeout/network failure. For
        // writes the server may have processed the request even though the
        // response never arrived, so we surface the error instead of risking
        // a duplicate.
        if ((isAbort || isNetwork) && canRetry && attempt < MAX_RETRIES) {
          attempt++;
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        if (isAbort) {
          throw new Error(
            `Finmap API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s` +
            (canRetry ? '' : ' — the change may or may not have been applied; check in Finmap before retrying'),
          );
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }

      // Learn the server's view of the quota (other clients share it).
      limiter.observe(res.headers);

      if (res.status === 429) {
        const waitMs = retryAfterMs(res.headers);
        limiter.block(waitMs);
        if (rateRetries < MAX_RATE_LIMIT_RETRIES && rateWaitedMs + waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
          rateRetries++;
          rateWaitedMs += waitMs;
          continue; // acquire() sits out the block
        }
        throw new Error(
          `Finmap API rate limit: ${method} ${path} was still refused (429) after waiting ${Math.round(rateWaitedMs / 1000)}s. ` +
          'Limits are 10 requests / 5 s and 120 / min per company, shared with every other integration and AI connector using this company. Try again in a minute.',
        );
      }

      if (!res.ok) {
        // 5xx is transient — retry reads only (a 500 on a write may still
        // have been applied). Other 4xx are client errors — surface them.
        if (res.status >= 500 && canRetry && attempt < MAX_RETRIES) {
          attempt++;
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new Error(`Finmap API ${method} ${path} → ${res.status}: ${payload as string}`);
      }

      if (responseType === 'binary') return payload;
      const text = payload as string;
      return text ? JSON.parse(text) : {};
    }
  }

  // ── Accounts ────────────────────────────────────────────────
  getAccounts(withBalances = true) {
    return this.request<any[]>('GET', '/accounts', undefined, {
      withBalances: withBalances ? 'true' : 'false',
    });
  }

  // ── Currencies ──────────────────────────────────────────────
  getCurrencies() {
    return this.request<any[]>('GET', '/currencies');
  }

  // ── Currency Exchange Rates ─────────────────────────────────
  getCustomExchangeRates() {
    return this.request<any[]>('GET', '/currencyExchangeRates/custom/all');
  }
  upsertCustomExchangeRate(data: { from: string; to: string; rate: number }) {
    return this.request<any>('POST', '/currencyExchangeRates/custom', data);
  }
  deleteCustomExchangeRate(from: string, to: string) {
    return this.request<any>('DELETE', `/currencyExchangeRates/custom/${from}/${to}`);
  }

  // ── Tags ────────────────────────────────────────────────────
  getTags() {
    return this.request<any[]>('GET', '/tags');
  }
  createTag(data: { label: string }) {
    return this.request<any>('POST', '/tags', data);
  }
  updateTag(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/tags/${id}`, data);
  }
  deleteTag(id: string) {
    return this.request<any>('DELETE', `/tags/${id}`);
  }

  // ── Projects ────────────────────────────────────────────────
  getProjects() {
    return this.request<any[]>('GET', '/projects');
  }
  createProject(data: { label: string }) {
    return this.request<any>('POST', '/projects', data);
  }
  updateProject(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/projects/${id}`, data);
  }
  deleteProject(id: string) {
    return this.request<any>('DELETE', `/projects/${id}`);
  }

  // ── Categories Income ───────────────────────────────────────
  getIncomeCategories() {
    return this.request<any[]>('GET', '/categories/income');
  }
  createIncomeCategory(data: { label: string; parentId?: string }) {
    // Only send fields that are defined — API rejects unknown/empty fields
    const body: Record<string, string> = { label: data.label };
    if (data.parentId) body.parentId = data.parentId;
    return this.request<any>('POST', '/categories/income', body);
  }
  updateIncomeCategory(id: string, data: { label?: string; parentId?: string }) {
    return this.request<any>('PATCH', `/categories/income/${id}`, data);
  }
  deleteIncomeCategory(id: string) {
    return this.request<any>('DELETE', `/categories/income/${id}`);
  }

  // ── Categories Expense ──────────────────────────────────────
  getExpenseCategories() {
    return this.request<any[]>('GET', '/categories/expense');
  }
  createExpenseCategory(data: { label: string; parentId?: string }) {
    const body: Record<string, string> = { label: data.label };
    if (data.parentId) body.parentId = data.parentId;
    return this.request<any>('POST', '/categories/expense', body);
  }
  updateExpenseCategory(id: string, data: { label?: string; parentId?: string }) {
    return this.request<any>('PATCH', `/categories/expense/${id}`, data);
  }
  deleteExpenseCategory(id: string) {
    return this.request<any>('DELETE', `/categories/expense/${id}`);
  }

  // ── Suppliers ───────────────────────────────────────────────
  getSuppliers() {
    return this.request<any[]>('GET', '/suppliers');
  }
  createSupplier(data: { label: string }) {
    return this.request<any>('POST', '/suppliers', data);
  }
  updateSupplier(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/suppliers/${id}`, data);
  }
  deleteSupplier(id: string) {
    return this.request<any>('DELETE', `/suppliers/${id}`);
  }

  // ── Creditors ───────────────────────────────────────────────
  getCreditors() {
    return this.request<any[]>('GET', '/creditors');
  }
  createCreditor(data: { label: string }) {
    return this.request<any>('POST', '/creditors', data);
  }
  updateCreditor(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/creditors/${id}`, data);
  }
  deleteCreditor(id: string) {
    return this.request<any>('DELETE', `/creditors/${id}`);
  }

  // ── Debitors ────────────────────────────────────────────────
  getDebitors() {
    return this.request<any[]>('GET', '/debitors');
  }
  createDebitor(data: { label: string }) {
    return this.request<any>('POST', '/debitors', data);
  }
  updateDebitor(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/debitors/${id}`, data);
  }
  deleteDebitor(id: string) {
    return this.request<any>('DELETE', `/debitors/${id}`);
  }

  // ── Investors ───────────────────────────────────────────────
  getInvestors() {
    return this.request<any[]>('GET', '/investors');
  }
  createInvestor(data: { label: string }) {
    return this.request<any>('POST', '/investors', data);
  }
  updateInvestor(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/investors/${id}`, data);
  }
  deleteInvestor(id: string) {
    return this.request<any>('DELETE', `/investors/${id}`);
  }

  // ── Employees ───────────────────────────────────────────────
  getEmployees() {
    return this.request<any[]>('GET', '/employees');
  }
  createEmployee(data: { label: string }) {
    return this.request<any>('POST', '/employees', data);
  }
  updateEmployee(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/employees/${id}`, data);
  }
  deleteEmployee(id: string) {
    return this.request<any>('DELETE', `/employees/${id}`);
  }

  // ── Owners ──────────────────────────────────────────────────
  getOwners() {
    return this.request<any[]>('GET', '/owners');
  }
  createOwner(data: { label: string }) {
    return this.request<any>('POST', '/owners', data);
  }
  updateOwner(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/owners/${id}`, data);
  }
  deleteOwner(id: string) {
    return this.request<any>('DELETE', `/owners/${id}`);
  }

  // ── Tax Organisations ───────────────────────────────────────
  getTaxOrganisations() {
    return this.request<any[]>('GET', '/tax-organisations');
  }
  createTaxOrganisation(data: { label: string }) {
    return this.request<any>('POST', '/tax-organisations', data);
  }
  updateTaxOrganisation(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/tax-organisations/${id}`, data);
  }
  deleteTaxOrganisation(id: string) {
    return this.request<any>('DELETE', `/tax-organisations/${id}`);
  }

  // ── Operations ──────────────────────────────────────────────
  getOperations(filters: Record<string, unknown>) {
    return this.request<{ list: any[]; total: number }>('POST', '/operations/list', filters);
  }
  getOperationDetails(params: { id?: string; externalId?: string }) {
    const query: Record<string, string> = {};
    if (params.id) query.id = params.id;
    if (params.externalId) query.externalId = params.externalId;
    return this.request<{ list: any[]; total: number }>('GET', '/operations/details', undefined, query);
  }

  createIncomeOperation(data: Record<string, unknown>, offset = 0) {
    return this.request<any>('POST', '/operations/income', data, { offset: String(offset) });
  }
  createExpenseOperation(data: Record<string, unknown>, offset = 0) {
    return this.request<any>('POST', '/operations/expense', data, { offset: String(offset) });
  }
  createTransferOperation(data: Record<string, unknown>, offset = 0) {
    return this.request<any>('POST', '/operations/transfer', data, { offset: String(offset) });
  }

  patchIncomeOperation(id: string, data: Record<string, unknown>, offset = 0) {
    return this.request<any>('PATCH', `/operations/income/${id}`, data, { offset: String(offset) });
  }
  patchExpenseOperation(id: string, data: Record<string, unknown>, offset = 0) {
    return this.request<any>('PATCH', `/operations/expense/${id}`, data, { offset: String(offset) });
  }
  patchTransferOperation(id: string, data: Record<string, unknown>, offset = 0) {
    return this.request<any>('PATCH', `/operations/transfer/${id}`, data, { offset: String(offset) });
  }

  deleteIncomeOperation(id: string) {
    return this.request<any>('DELETE', `/operations/income/${id}`);
  }
  deleteExpenseOperation(id: string) {
    return this.request<any>('DELETE', `/operations/expense/${id}`);
  }
  deleteTransferOperation(id: string) {
    return this.request<any>('DELETE', `/operations/transfer/${id}`);
  }

  // Same operations addressed by the externalId set at creation — lets a
  // sync update/delete what it imported without a lookup request first.
  patchOperationByExternalId(type: OperationType, externalId: string, data: Record<string, unknown>, offset = 0) {
    return this.request<any>('PATCH', `/operations/${type}/byExternalId/${encodeURIComponent(externalId)}`, data, { offset: String(offset) });
  }
  deleteOperationByExternalId(type: OperationType, externalId: string) {
    return this.request<any>('DELETE', `/operations/${type}/byExternalId/${encodeURIComponent(externalId)}`);
  }

  // ── Invoices ────────────────────────────────────────────────
  getInvoices(filters: Record<string, unknown>) {
    return this.request<{ list: any[]; total: number }>('POST', '/operations/invoices/list', filters);
  }
  getInvoiceDetails(params: { id?: string; externalId?: string }) {
    const query: Record<string, string> = {};
    if (params.id) query.id = params.id;
    if (params.externalId) query.externalId = params.externalId;
    return this.request<{ list: any[]; total: number }>('GET', '/operations/invoices/details', undefined, query);
  }
  createInvoice(data: Record<string, unknown>, offset = 0) {
    return this.request<any>('POST', '/invoices', data, { offset: String(offset) });
  }
  updateInvoice(id: string, data: Record<string, unknown>, offset = 0) {
    return this.request<any>('PATCH', `/invoices/${id}`, data, { offset: String(offset) });
  }
  deleteInvoice(id: string) {
    return this.request<any>('DELETE', `/invoices/${id}`);
  }
  updateInvoiceByExternalId(externalId: string, data: Record<string, unknown>, offset = 0) {
    return this.request<any>('PATCH', `/invoices/byExternalId/${encodeURIComponent(externalId)}`, data, { offset: String(offset) });
  }
  deleteInvoiceByExternalId(externalId: string) {
    return this.request<any>('DELETE', `/invoices/byExternalId/${encodeURIComponent(externalId)}`);
  }
  /** Rendered invoice as PDF bytes. language: ru | en | uk | pl | es | cz | tr | uz | pt-BR */
  async getInvoicePdf(id: string, language?: string): Promise<Buffer> {
    const bytes = await this.exec('GET', `/invoices/pdf/${encodeURIComponent(id)}`, undefined, language ? { language } : undefined, 'binary');
    return Buffer.from(bytes as ArrayBuffer);
  }

  // ── Invoice Goods ───────────────────────────────────────────
  getInvoiceGoods() {
    return this.request<any[]>('GET', '/invoices/goods');
  }
  createInvoiceGood(data: { label: string }) {
    return this.request<any>('POST', '/invoices/goods', data);
  }
  updateInvoiceGood(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/invoices/goods/${id}`, data);
  }
  deleteInvoiceGood(id: string) {
    return this.request<any>('DELETE', `/invoices/goods/${id}`);
  }

  // ── Invoice Companies ───────────────────────────────────────
  getInvoiceCompanies() {
    return this.request<any[]>('GET', '/invoices/companies');
  }
  createInvoiceCompany(data: { label: string }) {
    return this.request<any>('POST', '/invoices/companies', data);
  }
  updateInvoiceCompany(id: string, data: { label: string }) {
    return this.request<any>('PATCH', `/invoices/companies/${id}`, data);
  }
  deleteInvoiceCompany(id: string) {
    return this.request<any>('DELETE', `/invoices/companies/${id}`);
  }

  // ── Webhooks ────────────────────────────────────────────────
  getWebhooks() {
    return this.request<any[]>('GET', '/webhooks');
  }
  createWebhook(data: { name: string; url: string }) {
    return this.request<any>('POST', '/webhooks', data);
  }
  updateWebhook(id: string, data: { name?: string; url?: string }) {
    return this.request<any>('PATCH', `/webhooks/${id}`, data);
  }
  deleteWebhook(id: string) {
    return this.request<any>('DELETE', `/webhooks/${id}`);
  }
}
