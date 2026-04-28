import { z } from 'zod';
import { FinmapAPI } from './finmap-api';

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
]);

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
    tool('get_operations', 'Search operations with filters. Returns slim list (id, type, sum, date, accounts, category, counterparty, projects, tags, comment).',
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
        limit: z.number().optional().default(50),
        offset: z.number().optional().default(0),
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
    tool('create_operation', 'Create income/expense/transfer.',
      {
        type: z.enum(['income', 'expense', 'transfer']),
        amount: z.number().min(0),
        date: z.number().optional(),
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
      },
      async (input) => {
        const { type, ...data } = input;
        const map = { income: () => api.createIncomeOperation(data), expense: () => api.createExpenseOperation(data), transfer: () => api.createTransferOperation(data) };
        return text(await map[type]());
      }
    ),
    tool('patch_operation', 'Update operation. Pass only fields to change.',
      {
        type: z.enum(['income', 'expense', 'transfer']),
        id: z.string(),
        amount: z.number().min(0).optional(),
        date: z.number().optional(),
        comment: z.string().optional(),
        categoryId: z.string().optional(),
        counterpartyId: z.string().optional(),
        projectId: z.string().optional(),
        tagIds: z.array(z.string()).optional(),
        accountToId: z.string().optional(),
        accountFromId: z.string().optional(),
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
