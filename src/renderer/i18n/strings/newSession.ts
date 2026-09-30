import type { StringBundle } from '../index';

const strings: StringBundle = {
  uk: {
    'newSession.title': 'Додати компанію',
    'newSession.nameLabel': 'Назва компанії',
    'newSession.namePlaceholder': 'Моя компанія',
    'newSession.apiKeyLabel': 'Finmap API ключ',
    'newSession.apiKeyPlaceholder': 'Вставте API ключ з Finmap',
    'newSession.apiKeyHint': 'Знайти можна в Finmap → Налаштування → API.',
    'newSession.skipApiKey': 'Пропустити — створити сесію тільки для MCP',
    'newSession.confirmMcpOnly':
      'Створити сесію без Finmap API-ключа?\n\n' +
      'У цьому режимі будуть доступні MCP-сервери (Jira, GSheets, Notion, GitHub тощо), ' +
      'але Finmap-інструменти (операції, категорії, інвойси) не працюватимуть. ' +
      'Ключ можна додати пізніше у налаштуваннях сесії.',
    'newSession.cancel': 'Скасувати',
    'newSession.create': 'Додати',
  },
  en: {
    'newSession.title': 'Add company',
    'newSession.nameLabel': 'Company name',
    'newSession.namePlaceholder': 'My company',
    'newSession.apiKeyLabel': 'Finmap API key',
    'newSession.apiKeyPlaceholder': 'Paste your API key from Finmap',
    'newSession.apiKeyHint': 'You can find it in Finmap → Settings → API.',
    'newSession.skipApiKey': 'Skip — create an MCP-only session',
    'newSession.confirmMcpOnly':
      'Create a session without a Finmap API key?\n\n' +
      'In this mode MCP servers (Jira, GSheets, Notion, GitHub, etc.) will be available, ' +
      'but Finmap tools (transactions, categories, invoices) will not work. ' +
      'You can add the key later in the session settings.',
    'newSession.cancel': 'Cancel',
    'newSession.create': 'Add',
  },
};
export default strings;
