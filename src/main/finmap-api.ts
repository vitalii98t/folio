/**
 * Finmap API HTTP client — ALL endpoints from v2.2
 */

const BASE_URL = 'https://api.finmap.online/v2.2';

export class FinmapAPI {
  constructor(private apiKey: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>
  ): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apiKey': this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Finmap API ${method} ${path} → ${res.status}: ${text}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : ({} as T);
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
