/** Speech-to-text backend. Folio ships one fixed provider — Groq's
 *  OpenAI-compatible `/audio/transcriptions` endpoint with Whisper large-v3
 *  turbo — and a key baked in at build time (see build-main.mjs). Users only
 *  pick the recognition language. */
export const VOICE_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const VOICE_MODEL = 'whisper-large-v3-turbo';

/** Language hint options, labelled with endonyms so they read the same in
 *  every UI language. The "detect automatically" entry (empty value) is
 *  added by the settings modal with a translated label. */
export const VOICE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'uk', label: 'Українська' },
  { value: 'en', label: 'English' },
  { value: 'pl', label: 'Polski' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ru', label: 'Русский' },
];

export const DEFAULT_VOICE_LANGUAGE = 'uk';
