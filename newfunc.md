Оновлена картина
Defaults → один вільний текст-промт
Замість структурованих полів (category, counterparty, type) — один text-area з контекстом, який Claude інтерпретує:


Категорія: "Продаж послуг"
Контрагент: брати з імені файла після першого пробілу
Тип: дохід
Якщо файл .pdf — це банківська виписка, парсити як reconcile
Зберігається разом з binding. У Settings можна редагувати — як syncPrompt у інтеграцій чи prompt у scheduled tasks. Юзеру знайома механіка.

Перший setup — baseline без діалогу
При підключенні папки:

Listing файлів у папці
Беремо айдішники всіх існуючих файлів і записуємо у processedFileIds як baseline
Жодного імпорту в момент setup — пам'ятаємо що "до цього моменту вже все було, нас цікавлять тільки майбутні файли"
У runtime: будь-який файл, чий ID НЕ в processedFileIds → новий → автоматичний імпорт
Тобто прибираю режим "питати про кожен". Усе автоматом, юзер довіряє контекст-промту.

Runtime — простий цикл
Кожні N хвилин:

mcp__gdrive__list_files(folderId) → отримуємо все
Фільтруємо: тільки ті ID, яких нема в processedFileIds
Для кожного нового: parse + import з context-промтом → додаємо ID у processedFileIds
Один файл → один імпорт, два → два, як ти і казав
Спрощена схема

interface FileImportBinding {
  id: string;
  sessionId: string;
  
  // Source (поки тільки gdrive)
  sourceServerName: string;          // "gdrive"
  sourceFolderId: string;
  sourceFolderName: string;          // для UI: "Bank Statements / 2026"
  
  // Destination
  finmapAccountId: string;
  finmapAccountName: string;          // для UI: "PrivatBank UAH"
  
  // Контекст (вільний текст-промт)
  contextPrompt: string;
  
  // Поведінка
  syncIntervalMin: number;            // 15/30/60/...
  enabled: boolean;
  
  // State
  processedFileIds: string[];         // дедуп
  lastSync?: number;
}
Прибрав defaults структуру, askBeforeImport, fileKind. Усе у contextPrompt.

Зразок UI у SessionSettingsModal
Окрема секція "Авто-імпорт з папок" під MCP-серверами:


┌────────────────────────────────────────────────────────┐
│ 📁 Bank Statements / 2026  →  💳 PrivatBank UAH        │
│ Інтервал: 30 хв · Останній синк: 5 хв тому            │
│ ├─ Контекст: "Категорія: Продаж послуг, Контрагент..."│
│ └─ [✓ enabled]  [Edit context]  [Delete]              │
└────────────────────────────────────────────────────────┘
[+ Додати авто-імпорт]
Edit context — інлайн textarea як у scheduled tasks.

Чек-ліст реалізації (фінальний)
#	Що	Орієнтовно
1	FileImportBinding тип + IPC channels у shared/types.ts	10 хв
2	CRUD + markProcessed() у SessionStore	20 хв
3	IPC handlers у main.ts + preload API	15 хв
4	MCP-tools для Claude: list/create/update/delete_file_import_binding, mark_files_processed	40 хв
5	Розширення SyncScheduler — третій цикл для bindings	1 год
6	Skill folder-import-setup — wizard через діалог	40 хв
7	UI section у SessionSettingsModal (по аналогії з integrations)	1 год
8	Тригер-фрази скіла в system-prompt.ts	5 хв
9	Білд + smoke-test	30 хв
Загалом: ~5-6 годин, бо стало простіше після прибрання діалогового режиму.

Що буде відрізнятись від твого опису
Жодного — все що ти сказав, лягло у план без компромісів. Прибрав тільки одне моє надскладне (інтерактив "питати про кожен"), бо ти явно сказав "усе автоматом".

Готово розпочати
Як даси відмашку — стартую з тонкої частини (типи + store + tools). UI і skill зроблю в кінці.

Готовий?