/**
 * Deterministic totals over Finmap operations.
 *
 * Questions like "compare expenses by project for July and August" used to
 * make Claude page through hundreds of operations (each page ~40 KB, over the
 * tool-output cap, so it ended up grepping dumps) and add numbers up in its
 * head — slow, expensive and unreliable. This module does the arithmetic in
 * code; the `summarize_operations` tool pages through the API and returns a
 * few dozen rows.
 *
 * Rules that matter for correctness:
 *  - Currencies are never mixed: every row is per currency. `companySum` is
 *    Finmap's own conversion to the company currency, for cross-currency totals.
 *  - A split operation is attributed to each project/category by its share
 *    (Finmap's `projectObjects` / `categoryObjects`), so parts add up to the
 *    operation's sum and nothing is counted twice.
 *  - Tags are not shares: an operation with two tags counts fully under each,
 *    so tag rows overlap (flagged in `notes`).
 */

export const GROUP_DIMENSIONS = ['project', 'category', 'counterparty', 'account', 'type', 'currency', 'month', 'day', 'tag'] as const;
export type GroupDimension = typeof GROUP_DIMENSIONS[number];

export interface SummaryOptions {
  /** Bucket month/day by payment date instead of accrual date. */
  useDateOfPayment?: boolean;
  /** Tag id → label (operations only carry tag ids reliably). */
  tagLabels?: Map<string, string>;
  /** Max rows returned, largest first. */
  top?: number;
  /** Attach the single biggest operation to every row. Finmap cannot sort
   *  by amount, so without this "the largest X in each Y" means paging. */
  withLargest?: boolean;
}

export interface LargestOperation {
  id: string;
  date: string;
  sum: number;
  counterparty?: string;
  comment?: string;
}

export interface SummaryRow {
  [key: string]: string | number | null | LargestOperation | undefined;
  largest?: LargestOperation;
  currency: string;
  count: number;
  sum: number;
  companySum: number;
}

export interface OperationsSummary {
  groupBy: GroupDimension[];
  operations: number;
  rows: SummaryRow[];
  /** Rows beyond `top`, folded into one line per currency. */
  otherRows?: { rows: number; byCurrency: Record<string, { sum: number; companySum: number }> };
  totals: Array<{ type: string; currency: string; count: number; sum: number; companySum: number }>;
  notes: string[];
}

interface Part {
  id: string | null;
  name: string | null;
  /** Share of the operation, 0..1. */
  share: number;
  /** Exact amounts from Finmap when it provides them for this part. */
  sum?: number;
  companySum?: number;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v !== 'empty';
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');

function splitParts(objects: any, fallbackId: unknown, fallbackName: unknown): Part[] {
  if (Array.isArray(objects) && objects.length > 0) {
    return objects.map((o: any) => ({
      id: isId(o?.id) ? o.id : null,
      name: typeof o?.label === 'string' ? o.label : null,
      share: typeof o?.stake === 'number' ? o.stake / 100 : 1 / objects.length,
      sum: typeof o?.sum === 'number' ? o.sum : undefined,
      companySum: typeof o?.companyCurrencySum === 'number' ? o.companyCurrencySum : undefined,
    }));
  }
  return [{ id: isId(fallbackId) ? fallbackId : null, name: isId(fallbackId) && typeof fallbackName === 'string' ? fallbackName : null, share: 1 }];
}

function partsFor(op: any, dim: GroupDimension, opts: SummaryOptions): Part[] {
  switch (dim) {
    case 'project':
      return splitParts(op.projectObjects, undefined, undefined);
    case 'category':
      return splitParts(op.categoryObjects, op.categoryId, op.categoryName);
    case 'tag': {
      const ids = (Array.isArray(op.tagIds) ? op.tagIds : []).filter(isId);
      if (ids.length === 0) return [{ id: null, name: null, share: 1 }];
      return ids.map((id: string) => ({ id, name: opts.tagLabels?.get(id) ?? null, share: 1 }));
    }
    case 'counterparty':
      return [{ id: isId(op.counterpartyId) ? op.counterpartyId : null, name: isId(op.counterpartyId) ? (op.counterpartyName ?? null) : null, share: 1 }];
    case 'account': {
      // Expense/transfer leave from an account, income arrives to one.
      const id = op.type === 'income' ? op.accountToId : op.accountFromId ?? op.accountToId;
      const name = op.type === 'income' ? op.accountToName : op.accountFromName ?? op.accountToName;
      return [{ id: isId(id) ? id : null, name: name ?? op.accountName ?? null, share: 1 }];
    }
    case 'type':
      return [{ id: op.type ?? null, name: op.type ?? null, share: 1 }];
    case 'currency':
      return [{ id: op.currencyId ?? null, name: op.currencyId ?? null, share: 1 }];
    case 'month':
    case 'day': {
      const ts = (opts.useDateOfPayment ? op.dateOfPayment : undefined) ?? op.date;
      if (typeof ts !== 'number') return [{ id: null, name: null, share: 1 }];
      // Local time of the machine — the same calendar the user sees in Finmap.
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}` + (dim === 'day' ? `-${pad(d.getDate())}` : '');
      return [{ id: key, name: key, share: 1 }];
    }
  }
}

export function summarizeOperations(ops: any[], groupBy: GroupDimension[], opts: SummaryOptions = {}): OperationsSummary {
  const dims = [...new Set(groupBy)];
  const splitDims: GroupDimension[] = dims.filter(d => d === 'project' || d === 'category');
  const groups = new Map<string, SummaryRow>();
  const totals = new Map<string, { type: string; currency: string; count: number; sum: number; companySum: number }>();
  const largest = new Map<SummaryRow, { op: any; amount: number }>();

  for (const op of ops) {
    const currency = String(op.currencyId ?? '');
    const sum = typeof op.sum === 'number' ? op.sum : 0;
    const companySum = typeof op.companyCurrencySum === 'number' ? op.companyCurrencySum : sum;

    const tKey = `${op.type}|${currency}`;
    const t = totals.get(tKey) ?? { type: String(op.type ?? ''), currency, count: 0, sum: 0, companySum: 0 };
    t.count++; t.sum += sum; t.companySum += companySum;
    totals.set(tKey, t);

    // Cartesian product of each dimension's parts.
    let combos: Array<{ keys: Part[] }> = [{ keys: [] }];
    for (const dim of dims) {
      const parts = partsFor(op, dim, opts);
      combos = combos.flatMap(c => parts.map(p => ({ keys: [...c.keys, p] })));
    }

    for (const combo of combos) {
      // Amount of this slice. With one split dimension Finmap's own per-part
      // sums are exact; with two, multiply the second's share in.
      let partSum = sum;
      let partCompany = companySum;
      const split = combo.keys.filter((_, i) => splitDims.includes(dims[i]));
      if (split.length > 0) {
        const first = split[0];
        partSum = first.sum ?? sum * first.share;
        partCompany = first.companySum ?? companySum * first.share;
        for (const extra of split.slice(1)) { partSum *= extra.share; partCompany *= extra.share; }
      }

      const gKey = combo.keys.map(k => k.id ?? '∅').join('|') + '|' + currency;
      let row = groups.get(gKey);
      if (!row) {
        row = { currency, count: 0, sum: 0, companySum: 0 };
        dims.forEach((dim, i) => {
          const k = combo.keys[i];
          if (dim === 'type' || dim === 'currency' || dim === 'month' || dim === 'day') {
            if (dim !== 'currency') row![dim] = k.name;
          } else {
            row![dim] = k.name;          // null = operation has no project/category/…
            row![`${dim}Id`] = k.id;
          }
        });
        groups.set(gKey, row);
      }
      row.count++;
      row.sum += partSum;
      row.companySum += partCompany;
      if (opts.withLargest) {
        const best = largest.get(row);
        if (!best || Math.abs(partSum) > Math.abs(best.amount)) largest.set(row, { op, amount: partSum });
      }
    }
  }

  const describeLargest = (row: SummaryRow): LargestOperation | undefined => {
    const best = largest.get(row);
    if (!best) return undefined;
    const d = new Date(best.op.date);
    const out: LargestOperation = {
      id: String(best.op.id),
      date: Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '',
      sum: round2(best.amount),
    };
    if (isId(best.op.counterpartyId) && best.op.counterpartyName) out.counterparty = best.op.counterpartyName;
    if (typeof best.op.comment === 'string' && best.op.comment) out.comment = best.op.comment.length > 120 ? best.op.comment.slice(0, 117) + '…' : best.op.comment;
    return out;
  };

  const all = [...groups.values()]
    .map(r => {
      const big = describeLargest(r);
      return { ...r, sum: round2(r.sum), companySum: round2(r.companySum), ...(big ? { largest: big } : {}) } as SummaryRow;
    })
    .sort((a, b) => Math.abs(b.companySum) - Math.abs(a.companySum));

  const top = opts.top ?? 100;
  const rows = all.slice(0, top);
  const rest = all.slice(top);
  const notes: string[] = [];
  if (dims.includes('tag')) notes.push('Tag rows overlap: an operation with several tags is counted in full under each tag, so tag rows do not add up to the totals.');
  if (dims.some(d => d === 'project' || d === 'category')) notes.push('Rows with a null project/category are operations that have none assigned.');

  const summary: OperationsSummary = {
    groupBy: dims,
    operations: ops.length,
    rows,
    totals: [...totals.values()]
      .map(t => ({ ...t, sum: round2(t.sum), companySum: round2(t.companySum) }))
      .sort((a, b) => Math.abs(b.companySum) - Math.abs(a.companySum)),
    notes,
  };
  if (rest.length > 0) {
    const byCurrency: Record<string, { sum: number; companySum: number }> = {};
    for (const r of rest) {
      const c = byCurrency[r.currency] ?? { sum: 0, companySum: 0 };
      c.sum = round2(c.sum + r.sum); c.companySum = round2(c.companySum + r.companySum);
      byCurrency[r.currency] = c;
    }
    summary.otherRows = { rows: rest.length, byCurrency };
  }
  return summary;
}
