import type { TranscribeResult, UiLanguage } from '../shared/types';
import { VOICE_ENDPOINT, VOICE_MODEL } from '../shared/voice-presets';
import { mainT } from './i18n';

/** Key baked in by build-main.mjs (esbuild `define`). The runtime
 *  GROQ_API_KEY fallback is for `electron .` runs against an unbundled build. */
function builtInKey(): string {
  return (process.env.FOLIO_GROQ_API_KEY || process.env.GROQ_API_KEY || '').trim();
}

export function isVoiceAvailable(): boolean {
  return builtInKey().length > 0;
}

/** Give the provider room, but never leave the mic button spinning forever. */
const REQUEST_TIMEOUT_MS = 90_000;

/** Clips below this are almost certainly an accidental click. Skip the
 *  round-trip — and the "thanks for watching" Whisper likes to hallucinate on
 *  silence. ~1 KB of 32 kbps opus is well under half a second of audio. */
const MIN_AUDIO_BYTES = 1_000;

/**
 * Send one recorded clip to Groq Whisper and return the recognised text.
 * Runs in main so the key never enters the renderer — the renderer only ships
 * raw audio bytes over IPC.
 *
 * @param language ISO-639-1 hint ("uk"); empty = auto-detect per clip.
 * @param uiLang   language for error messages.
 */
export async function transcribeAudio(
  language: string | undefined,
  audio: Uint8Array,
  mimeType: string,
  uiLang?: UiLanguage,
  opts: { endpoint?: string; apiKey?: string } = {},
): Promise<TranscribeResult> {
  const apiKey = (opts.apiKey ?? builtInKey()).trim();
  if (!apiKey) return { ok: false, error: mainT(uiLang, 'voice.notConfigured') };
  if (audio.byteLength < MIN_AUDIO_BYTES) {
    return { ok: false, error: mainT(uiLang, 'voice.tooShort') };
  }

  // Copy into a standalone ArrayBuffer: the IPC-delivered view may sit on a
  // larger backing store, and Blob must get exactly our bytes.
  const bytes = audio.slice().buffer as ArrayBuffer;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), `recording.${extensionFor(mimeType)}`);
  form.append('model', VOICE_MODEL);
  // verbose_json carries per-segment no_speech_prob, which lets us drop the
  // phrases Whisper invents on silence ("Дякую!", "Thanks for watching").
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  const hint = language?.trim();
  if (hint) form.append('language', hint);

  let res: Response;
  try {
    res = await fetch(opts.endpoint ?? VOICE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, error: mainT(uiLang, 'voice.timeout') };
    }
    const detail = err?.cause?.message ?? err?.message ?? String(err);
    return { ok: false, error: mainT(uiLang, 'voice.network', { detail }) };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: describeHttpError(res.status, body, uiLang) };
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, error: mainT(uiLang, 'voice.badResponse') };
  }
  const text = speechText(payload);
  if (!text) return { ok: false, error: mainT(uiLang, 'voice.empty') };
  return { ok: true, text };
}

/** Segments Whisper itself rates as probably-not-speech. */
const NO_SPEECH_THRESHOLD = 0.6;

/** Whisper's stock hallucinations on silence/noise — subtitle credits and
 *  "thanks for watching" from its training data. Dropped only when they are
 *  the ENTIRE transcript; nobody dictates these to a finance assistant. */
const HALLUCINATIONS = /^(дякую за перегляд|дякую за увагу|thanks for watching|thank you for watching|продолжение следует|субтитр\S*( .*)?|редактор субтитр.*|subtitles by .*|amara\.org.*)$/i;

function speechText(payload: any): string {
  const text = rawSpeechText(payload);
  const normalized = text.toLowerCase().replace(/[.!?…,"«»]+/g, '').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(normalized) ? '' : text;
}

function rawSpeechText(payload: any): string {
  const segments = Array.isArray(payload?.segments) ? payload.segments : null;
  if (!segments) return typeof payload?.text === 'string' ? payload.text.trim() : '';
  return segments
    .filter((s: any) => typeof s?.text === 'string' && !(typeof s.no_speech_prob === 'number' && s.no_speech_prob > NO_SPEECH_THRESHOLD))
    .map((s: any) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function extensionFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

function describeHttpError(status: number, body: string, uiLang?: UiLanguage): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    const raw = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? '';
    detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    detail = body.slice(0, 200);
  }
  switch (status) {
    case 401:
    case 403:
      return mainT(uiLang, 'voice.unauthorized');
    case 413:
      return mainT(uiLang, 'voice.tooLarge');
    case 429:
      return mainT(uiLang, 'voice.rateLimited');
    default:
      return mainT(uiLang, 'voice.http', { status, detail: detail ? `: ${detail}` : '' });
  }
}
