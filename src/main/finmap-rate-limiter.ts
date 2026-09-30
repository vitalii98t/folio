/**
 * Client-side throttle for the Finmap public API.
 *
 * Finmap limits requests per COMPANY (shared by all of its API keys, and by
 * the hosted MCP connector): currently 10 requests / 5 s and 120 / minute.
 * Every response reports the live state in headers —
 *   Max-Req-Count:        "5s=10, 1m=120"
 *   Used-Req-Count:       "5s=3, 1m=41"
 *   Remaining-Req-Count:  "5s=7, 1m=79"
 *   Next-Possibility-At:  "5s=2026-09-30T10:00:05.000Z, 1m=…"
 * — and an exceeded limit is a 429 with Retry-After (seconds). Rejected
 * requests are not counted and are refused BEFORE processing, so replaying
 * a 429 is safe even for writes.
 *
 * Folio can burst easily: parallel subagents paging operations, a mass
 * import, a scheduled sync running next to the chat. So every Finmap call
 * waits for a slot here first. One limiter per API key (our best handle on
 * "company"), shared by every FinmapAPI instance in the process.
 *
 * The limiter keeps a sliding log per window, stricter than whatever the
 * server does (fixed or sliding), and re-syncs from the headers so usage by
 * OTHER clients of the same company is respected too.
 */

export type FinmapPriority = 'interactive' | 'background';

interface RateWindow {
  /** Header key, e.g. "5s". */
  key: string;
  ms: number;
  max: number;
  /** Ascending times (epoch ms) at which a used slot becomes free again. */
  releases: number[];
}

interface Waiter {
  priority: FinmapPriority;
  resolve: () => void;
}

const DEFAULT_WINDOWS: ReadonlyArray<{ key: string; ms: number; max: number }> = [
  { key: '5s', ms: 5_000, max: 10 },
  { key: '1m', ms: 60_000, max: 120 },
];

/** Slack for clock skew and network latency between our send time and the
 *  moment the server counts the request. */
const PAD_MS = 250;

/** Background runs (scheduled tasks, syncs, folder imports) may fill at most
 *  this share of each window, so a chat message never waits behind them. */
const BACKGROUND_SHARE = 0.7;

function parseWindowMs(key: string): number | null {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(key.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n > 0 ? n * mult : null;
}

/** "5s=10, 1m=120" → { '5s': '10', '1m': '120' } */
function parsePairs(value: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const part of value.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class FinmapRateLimiter {
  private windows: RateWindow[] = DEFAULT_WINDOWS.map(w => ({ ...w, releases: [] }));
  private blockedUntil = 0;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the first response's headers were already reported in the log. */
  private reported = false;

  constructor(private now: () => number = Date.now) {}

  /** Resolves when the caller may send one request. FIFO within a priority;
   *  interactive callers go before background ones. */
  acquire(priority: FinmapPriority = 'interactive'): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ priority, resolve });
      this.pump();
    });
  }

  /** Pause everything for `ms` (after a 429). */
  block(ms: number) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(0, ms));
    this.pump();
  }

  /** Re-sync with the server's view from response headers. */
  observe(headers: { get(name: string): string | null }) {
    const now = this.now();
    const max = parsePairs(headers.get('Max-Req-Count'));
    const used = parsePairs(headers.get('Used-Req-Count'));
    const remaining = parsePairs(headers.get('Remaining-Req-Count'));
    const next = parsePairs(headers.get('Next-Possibility-At'));

    if (!this.reported) {
      this.reported = true;
      const raw = headers.get('Max-Req-Count');
      console.log(raw
        ? `[Finmap] rate limits from server: ${raw}`
        : '[Finmap] no rate-limit headers in the response — throttling with defaults (10 / 5 s, 120 / min)');
    }

    // Limits may change server-side ("per-day — unlimited for now").
    for (const [key, raw] of Object.entries(max)) {
      const limit = Number(raw);
      const ms = parseWindowMs(key);
      if (!ms || !Number.isFinite(limit) || limit <= 0) continue;
      const existing = this.windows.find(w => w.key === key);
      if (existing) existing.max = limit;
      else this.windows.push({ key, ms, max: limit, releases: [] });
    }

    for (const w of this.windows) {
      this.prune(w, now);
      let serverUsed = Number(used[w.key]);
      if (!Number.isFinite(serverUsed) && remaining[w.key] !== undefined) {
        const rem = Number(remaining[w.key]);
        if (Number.isFinite(rem)) serverUsed = w.max - rem;
      }
      if (!Number.isFinite(serverUsed)) continue;
      // The server has seen more requests than we sent — another client of
      // this company (second key, hosted MCP, another integration) is using
      // the quota. Reserve those slots until the window resets.
      const extra = Math.min(serverUsed, w.max) - w.releases.length;
      if (extra <= 0) continue;
      const resetAt = Date.parse(next[w.key] ?? '');
      const release = Number.isFinite(resetAt) && resetAt > now ? resetAt + PAD_MS : now + w.ms + PAD_MS;
      for (let i = 0; i < extra; i++) w.releases.push(release);
      w.releases.sort((a, b) => a - b);
    }
    this.pump();
  }

  /** For logs/tests. */
  snapshot() {
    const now = this.now();
    return {
      queued: this.queue.length,
      blockedForMs: Math.max(0, this.blockedUntil - now),
      windows: this.windows.map(w => {
        this.prune(w, now);
        return { key: w.key, max: w.max, used: w.releases.length };
      }),
    };
  }

  private prune(w: RateWindow, now: number) {
    let i = 0;
    while (i < w.releases.length && w.releases[i] <= now) i++;
    if (i > 0) w.releases.splice(0, i);
  }

  /** Milliseconds until a request of this priority may go; 0 = now. */
  private waitFor(priority: FinmapPriority, now: number): number {
    let wait = Math.max(0, this.blockedUntil - now);
    for (const w of this.windows) {
      this.prune(w, now);
      const cap = priority === 'background' ? Math.max(1, Math.floor(w.max * BACKGROUND_SHARE)) : w.max;
      if (w.releases.length >= cap) {
        // Enough slots must free up to get back under the cap.
        wait = Math.max(wait, w.releases[w.releases.length - cap] - now);
      }
    }
    return wait;
  }

  private take(now: number) {
    for (const w of this.windows) {
      w.releases.push(now + w.ms + PAD_MS);
      w.releases.sort((a, b) => a - b);
    }
  }

  private pump() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) {
      const now = this.now();
      let idx = this.queue.findIndex(w => w.priority === 'interactive');
      if (idx === -1) idx = 0;
      const waiter = this.queue[idx];
      const wait = this.waitFor(waiter.priority, now);
      if (wait > 0) {
        // Background waiters have a lower cap, so nobody else can go sooner.
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
        return;
      }
      this.queue.splice(idx, 1);
      this.take(now);
      waiter.resolve();
    }
  }
}

const limiters = new Map<string, FinmapRateLimiter>();

/** One limiter per API key, shared across the whole main process. */
export function finmapLimiterFor(apiKey: string): FinmapRateLimiter {
  let limiter = limiters.get(apiKey);
  if (!limiter) {
    limiter = new FinmapRateLimiter();
    limiters.set(apiKey, limiter);
  }
  return limiter;
}

/** How long a 429 asks us to wait. Retry-After is seconds (or an HTTP date);
 *  falls back to the latest window reset, then to 5 s. */
export function retryAfterMs(headers: { get(name: string): string | null }, now = Date.now()): number {
  const raw = headers.get('Retry-After');
  let ms = NaN;
  if (raw) {
    const secs = Number(raw);
    ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    const remaining = parsePairs(headers.get('Remaining-Req-Count'));
    const next = parsePairs(headers.get('Next-Possibility-At'));
    let latest = 0;
    for (const [key, at] of Object.entries(next)) {
      if (remaining[key] !== undefined && Number(remaining[key]) > 0) continue; // this window isn't the blocker
      const t = Date.parse(at);
      if (Number.isFinite(t)) latest = Math.max(latest, t);
    }
    ms = latest > now ? latest - now : 5_000;
  }
  return Math.min(Math.max(ms, 250), 65_000) + 100;
}
