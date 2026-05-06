// Deterministic 3-pass matcher for bank-statement reconciliation against
// Finmap operations. Used by the `reconcile_match` MCP tool.
//
// Why this lives in TS (not a Python script in the skill folder):
// users don't reliably have Python on PATH, especially on Windows. Running
// the matcher inside Folio's Node process is cross-platform and faster
// (no process spawn). The skill instructs Claude to call the MCP tool;
// the tool calls into here.

export interface BankOp {
  id: string;
  date: string;        // YYYY-MM-DD
  amount: number;      // signed: expense negative, income positive
  description?: string;
}

export interface FinmapOp {
  id: string;
  date: string;
  amount: number;
  counterparty?: string;
  category?: string;
}

export interface ReconcileOptions {
  dateToleranceDays?: number;   // pass-1 tolerance (default 1)
  splitWindowDays?: number;     // pass-2 search window (default 7)
  maxSplitSize?: number;        // largest combo size to try (default 4)
  amountEpsilon?: number;       // float tolerance (default 0.01)
  dateMismatchMaxDays?: number; // pass-3 max days to consider candidate (default 60)
}

export interface MatchedPair {
  bankId: string;
  finmapId: string;
  dateDiffDays: number;
}

export interface SplitMatch {
  /** Filled when one bank op = N Finmap ops */
  bankId?: string;
  finmapIds?: string[];
  /** Filled when one Finmap op = N bank ops (rare but possible) */
  finmapId?: string;
  bankIds?: string[];
  splitSize: number;
  totalAmount: number;
}

export interface DateMismatchCandidate {
  bankId: string;
  finmapId: string;
  dateDiffDays: number;
  bankDate: string;
  finmapDate: string;
}

export interface ReconcileResult {
  matched: MatchedPair[];
  matchedSplit: SplitMatch[];
  candidateMismatchDate: DateMismatchCandidate[];
  missingInFinmap: { bankId: string }[];
  extraInFinmap: { finmapId: string }[];
  stats: {
    totalBank: number;
    totalFinmap: number;
    matchedCount: number;
    splitCount: number;
    candidateDateCount: number;
    missingCount: number;
    extraCount: number;
  };
  warnings: string[];
}

const MS_PER_DAY = 86_400_000;

function parseDate(s: string): number {
  // Accept YYYY-MM-DD or full ISO
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${s}`);
  return t;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Math.round((parseDate(a) - parseDate(b)) / MS_PER_DAY));
}

function amountsMatch(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

/**
 * Iterate all combinations of size `k` from `arr` lazily, stopping when the
 * caller returns true. Avoids materializing all combos for big arrays.
 */
function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  const n = arr.length;
  if (k > n || k < 1) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map(i => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

export function reconcile(
  bankOps: BankOp[],
  finmapOps: FinmapOp[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const dateTolerance = options.dateToleranceDays ?? 1;
  const splitWindow = options.splitWindowDays ?? 7;
  const maxSplit = options.maxSplitSize ?? 4;
  const eps = options.amountEpsilon ?? 0.01;
  const mismatchMaxDays = options.dateMismatchMaxDays ?? 60;

  const usedBank = new Set<string>();
  const usedFinmap = new Set<string>();
  const warnings: string[] = [];

  const matched: MatchedPair[] = [];
  const matchedSplit: SplitMatch[] = [];
  const candidateMismatchDate: DateMismatchCandidate[] = [];

  // Sort for determinism
  const bankSorted = [...bankOps].sort((a, b) =>
    a.date.localeCompare(b.date) || a.amount - b.amount || a.id.localeCompare(b.id)
  );

  // ── Pass 1: 1:1 exact (amount + date within tolerance) ──
  for (const bank of bankSorted) {
    if (usedBank.has(bank.id)) continue;
    let best: { fm: FinmapOp; diff: number } | null = null;
    for (const fm of finmapOps) {
      if (usedFinmap.has(fm.id)) continue;
      if (!amountsMatch(bank.amount, fm.amount, eps)) continue;
      const diff = daysBetween(bank.date, fm.date);
      if (diff > dateTolerance) continue;
      if (best === null || diff < best.diff) best = { fm, diff };
    }
    if (best !== null) {
      matched.push({ bankId: bank.id, finmapId: best.fm.id, dateDiffDays: best.diff });
      usedBank.add(bank.id);
      usedFinmap.add(best.fm.id);
    }
  }

  // ── Pass 2a: 1 bank → N finmap (split case) ──
  // Bound combinatorial blow-up: skip if too many candidates.
  for (const bank of bankSorted) {
    if (usedBank.has(bank.id)) continue;
    const candidates = finmapOps.filter(
      fm => !usedFinmap.has(fm.id) && daysBetween(bank.date, fm.date) <= splitWindow
    );
    if (candidates.length < 2) continue;

    const cap = candidates.length > 30 ? 3 : maxSplit;
    if (candidates.length > 30 && maxSplit > 3) {
      warnings.push(
        `bank ${bank.id}: capped split search to size 3 (${candidates.length} candidates in window)`
      );
    }

    let found = false;
    for (let size = 2; size <= Math.min(cap, candidates.length) && !found; size++) {
      for (const combo of combinations(candidates, size)) {
        const total = combo.reduce((s, c) => s + c.amount, 0);
        if (amountsMatch(total, bank.amount, eps)) {
          matchedSplit.push({
            bankId: bank.id,
            finmapIds: combo.map(c => c.id),
            splitSize: size,
            totalAmount: total,
          });
          usedBank.add(bank.id);
          for (const c of combo) usedFinmap.add(c.id);
          found = true;
          break;
        }
      }
    }
  }

  // ── Pass 2b: 1 finmap → N bank (rarer reverse split) ──
  for (const fm of finmapOps) {
    if (usedFinmap.has(fm.id)) continue;
    const candidates = bankOps.filter(
      b => !usedBank.has(b.id) && daysBetween(b.date, fm.date) <= splitWindow
    );
    if (candidates.length < 2) continue;

    const cap = candidates.length > 30 ? 3 : maxSplit;

    let found = false;
    for (let size = 2; size <= Math.min(cap, candidates.length) && !found; size++) {
      for (const combo of combinations(candidates, size)) {
        const total = combo.reduce((s, c) => s + c.amount, 0);
        if (amountsMatch(total, fm.amount, eps)) {
          matchedSplit.push({
            finmapId: fm.id,
            bankIds: combo.map(c => c.id),
            splitSize: size,
            totalAmount: total,
          });
          usedFinmap.add(fm.id);
          for (const c of combo) usedBank.add(c.id);
          found = true;
          break;
        }
      }
    }
  }

  // ── Pass 3: amount matches but date too far apart ──
  for (const bank of bankSorted) {
    if (usedBank.has(bank.id)) continue;
    let best: { fm: FinmapOp; diff: number } | null = null;
    for (const fm of finmapOps) {
      if (usedFinmap.has(fm.id)) continue;
      if (!amountsMatch(bank.amount, fm.amount, eps)) continue;
      const diff = daysBetween(bank.date, fm.date);
      if (diff <= dateTolerance) continue; // would have been caught in pass 1
      if (diff > mismatchMaxDays) continue; // too far — almost certainly not the same op
      if (best === null || diff < best.diff) best = { fm, diff };
    }
    if (best !== null) {
      candidateMismatchDate.push({
        bankId: bank.id,
        finmapId: best.fm.id,
        dateDiffDays: best.diff,
        bankDate: bank.date,
        finmapDate: best.fm.date,
      });
      usedBank.add(bank.id);
      usedFinmap.add(best.fm.id);
    }
  }

  // ── Remaining ──
  const missingInFinmap = bankOps
    .filter(b => !usedBank.has(b.id))
    .map(b => ({ bankId: b.id }));
  const extraInFinmap = finmapOps
    .filter(f => !usedFinmap.has(f.id))
    .map(f => ({ finmapId: f.id }));

  return {
    matched,
    matchedSplit,
    candidateMismatchDate,
    missingInFinmap,
    extraInFinmap,
    stats: {
      totalBank: bankOps.length,
      totalFinmap: finmapOps.length,
      matchedCount: matched.length,
      splitCount: matchedSplit.length,
      candidateDateCount: candidateMismatchDate.length,
      missingCount: missingInFinmap.length,
      extraCount: extraInFinmap.length,
    },
    warnings,
  };
}
