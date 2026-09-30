import type { UiLanguage } from '../shared/types';
import { DEFAULT_UI_LANGUAGE } from '../shared/types';

/**
 * The handful of user-facing strings the MAIN process produces: lines echoed
 * into the terminal we open for install/login, logout errors, and
 * speech-to-text errors shown in the chat. Everything else the user reads
 * comes from the renderer, which has its own dictionary (renderer/i18n).
 */
type MainKey =
| 'terminal.exitCode'
| 'terminal.done'
| 'install.downloading'
| 'install.downloadFailed'
  | 'install.running'
  | 'logout.notFound'
  | 'logout.failed'
  | 'voice.notConfigured'
  | 'voice.tooShort'
  | 'voice.timeout'
  | 'voice.network'
  | 'voice.badResponse'
  | 'voice.empty'
  | 'voice.unauthorized'
  | 'voice.tooLarge'
  | 'voice.rateLimited'
  | 'voice.http';

const STRINGS: Record<UiLanguage, Record<MainKey, string>> = {
  uk: {
    'terminal.exitCode': '[Folio] Команда завершилась з кодом {code}.',
    'terminal.done': '[Folio] Готово. Можеш закривати вікно.',
    'install.downloading': '[Folio] Завантажую інсталятор Claude Code...',
    'install.downloadFailed': '[Folio] Не вдалося завантажити інсталятор. Перевір підключення до інтернету.',
    'install.running': '[Folio] Запускаю інсталятор...',
    'logout.notFound': 'Claude Code не знайдено на цій машині.',
    'logout.failed': 'Не вдалося виконати logout.',
    'voice.notConfigured': 'Голосове введення недоступне в цій збірці.',
    'voice.tooShort': 'Запис надто короткий — говори трохи довше.',
    'voice.timeout': 'Сервер розпізнавання не відповів за 90 секунд.',
    'voice.network': "Немає зв'язку з сервером розпізнавання: {detail}",
    'voice.badResponse': 'Сервер розпізнавання повернув незрозумілу відповідь.',
    'voice.empty': 'Нічого не розпізнано — спробуй ще раз ближче до мікрофона.',
    'voice.unauthorized': 'Сервіс розпізнавання відхилив ключ цієї збірки — онови Folio або напиши розробнику.',
    'voice.tooLarge': 'Запис завеликий для цього провайдера — диктуй коротшими фрагментами.',
    'voice.rateLimited': 'Ліміт запитів провайдера вичерпано — спробуй за хвилину.',
    'voice.http': 'Помилка розпізнавання (HTTP {status}){detail}',
  },
  en: {
    'terminal.exitCode': '[Folio] Command exited with code {code}.',
    'terminal.done': '[Folio] Done. You can close this window.',
    'install.downloading': '[Folio] Downloading the Claude Code installer...',
    'install.downloadFailed': '[Folio] Could not download the installer. Check your internet connection.',
    'install.running': '[Folio] Running the installer...',
    'logout.notFound': 'Claude Code was not found on this machine.',
    'logout.failed': 'Logout failed.',
    'voice.notConfigured': 'Voice input is not available in this build.',
    'voice.tooShort': 'Recording too short — speak a little longer.',
    'voice.timeout': 'The speech server did not answer within 90 seconds.',
    'voice.network': 'Cannot reach the speech server: {detail}',
    'voice.badResponse': 'The speech server returned an unreadable response.',
    'voice.empty': 'Nothing recognised — try again closer to the microphone.',
    'voice.unauthorized': "The speech service rejected this build's key — update Folio or contact the developer.",
    'voice.tooLarge': 'Recording too large for this provider — dictate in shorter pieces.',
    'voice.rateLimited': 'Provider rate limit hit — try again in a minute.',
    'voice.http': 'Speech recognition error (HTTP {status}){detail}',
  },
};

export function mainT(lang: UiLanguage | undefined, key: MainKey, params?: Record<string, string | number>): string {
  let s = STRINGS[lang ?? DEFAULT_UI_LANGUAGE]?.[key] ?? STRINGS[DEFAULT_UI_LANGUAGE][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
