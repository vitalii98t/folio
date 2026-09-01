import { getClaudePath } from './claude-status';
import type { ClaudeModelInfo } from '../shared/types';

let _sdk: typeof import('@anthropic-ai/claude-code') | null = null;
async function getSDK() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-code');
  return _sdk;
}

/**
 * Model list for the settings picker.
 *
 * We do NOT hardcode model names. The installed Claude Code CLI already knows
 * which models the user's plan gives them, and exposes that over the SDK
 * control channel as `supportedModels()`. Asking it means the list stays
 * correct when Anthropic ships a new tier and when the user changes plan —
 * a baked-in list would go stale on both counts.
 *
 * The control channel only exists on a *streaming* query, so we spawn a
 * throwaway one whose prompt iterator never yields: the CLI boots, answers
 * the control request, and we abort it. No message is ever sent, so this
 * costs no tokens.
 */

/** Used when the CLI is missing or too old to answer the control request.
 *  Plain tier aliases — every Claude Code version understands these. */
const FALLBACK_MODELS: ClaudeModelInfo[] = [
  { value: 'opus', displayName: 'Opus', description: 'Найрозумніша — складні задачі' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Баланс швидкості та якості' },
  { value: 'haiku', displayName: 'Haiku', description: 'Найшвидша — прості запити' },
];

/** The CLI spawn takes a couple of seconds, so the answer is cached. A short
 *  TTL on failures lets a just-installed CLI be picked up without a restart. */
const CACHE_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 60_000;
const QUERY_TIMEOUT_MS = 30_000;

let cache: { models: ClaudeModelInfo[]; fetchedAt: number; ok: boolean } | null = null;
let inFlight: Promise<ClaudeModelInfo[]> | null = null;

/** Prompt iterator that yields nothing and finishes when aborted — keeps the
 *  streaming query (and thus the control channel) open without a turn. */
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<never, void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function fetchModels(cwd: string): Promise<ClaudeModelInfo[]> {
  const claudePath = getClaudePath();
  if (!claudePath) throw new Error('Claude Code not found');

  const sdk = await getSDK();
  const abortController = new AbortController();

  const q = sdk.query({
    prompt: idlePrompt(abortController.signal),
    options: {
      abortController,
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      // Nothing to load — we only want the model list, so skip the user's
      // MCP servers entirely and keep the spawn fast.
      mcpServers: {},
      strictMcpConfig: true,
    },
  });

  try {
    const raw = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('supportedModels timed out')), QUERY_TIMEOUT_MS),
      ),
    ]);

    const models = (raw as ClaudeModelInfo[])
      .filter(m => m && typeof m.value === 'string' && m.value)
      // "default" is not a model — it's "whatever Claude Code picks", which we
      // already offer as the empty value. Its description still gets shown
      // there, so the user can see what the default currently resolves to.
      .map(m => ({
        value: m.value,
        displayName: m.displayName || m.value,
        description: m.description || '',
        resolvedModel: (m as any).resolvedModel,
      }));

    if (!models.length) throw new Error('supportedModels returned nothing');
    return models;
  } finally {
    abortController.abort();
    // The generator was never iterated, so nothing throws — but the SDK also
    // exposes interrupt() and we call it defensively to close the transport.
    try { await q.interrupt(); } catch {}
  }
}

/** Models offered in the settings picker, newest-first as the CLI orders them.
 *  Never rejects — falls back to tier aliases if the CLI can't be asked. */
export async function listClaudeModels(cwd: string): Promise<ClaudeModelInfo[]> {
  const ttl = cache?.ok ? CACHE_TTL_MS : FAILURE_TTL_MS;
  if (cache && Date.now() - cache.fetchedAt < ttl) return cache.models;
  if (inFlight) return inFlight;

  inFlight = fetchModels(cwd)
    .then(models => {
      cache = { models, fetchedAt: Date.now(), ok: true };
      return models;
    })
    .catch(err => {
      console.error('[Models] Falling back to static list:', err?.message ?? err);
      cache = { models: FALLBACK_MODELS, fetchedAt: Date.now(), ok: false };
      return FALLBACK_MODELS;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}
