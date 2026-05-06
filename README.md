<div align="center">

<img src="build/icon-256.png" width="128" height="128" alt="Folio logo" />

# Folio

### AI-асистент для управління фінансами у [Finmap](https://finmap.online)

Десктоп-додаток на базі Claude Code SDK. Автоматизує рутину обліку, підключає інтеграції за хвилини, звіряє виписки за секунди.

[![Build status](https://github.com/vitalii98t/folio/actions/workflows/build.yml/badge.svg)](https://github.com/vitalii98t/folio/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/vitalii98t/folio?label=release&color=6dd5ed)](https://github.com/vitalii98t/folio/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)

[![Windows](https://img.shields.io/badge/Windows-installer-0078D6?logo=windows&logoColor=white)](https://github.com/vitalii98t/folio/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-Intel%20%7C%20Apple%20Silicon-000000?logo=apple&logoColor=white)](https://github.com/vitalii98t/folio/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-AppImage-FCC624?logo=linux&logoColor=black)](https://github.com/vitalii98t/folio/releases/latest)

**[⬇️ Завантажити останню версію](https://github.com/vitalii98t/folio/releases/latest)**

</div>

---

## ✨ Що вміє

- 🤖 **Чат із Claude** який має повний доступ до Finmap API через 43 MCP-тули
- 🧠 **10 спеціалізованих скілів** — звірка виписки, інтеграції, прогноз cashflow, податковий звіт ФОП, фото чека → операція тощо. Активуються автоматично за тригер-фразами
- ⚡ **Інтеграції за 10 хвилин** — кидаєш API-доку, Claude сам пише і запускає sync
- 📊 **Звірка виписок** — drag PDF/Excel/CSV у чат, миттєвий звіт що відсутнє/зайве/розбіжне (детермінований 3-pass matcher у Node)
- ⏰ **Автозадачі за розкладом** — Claude сам категоризує/синхронізує/звіряє кожні N хвилин
- 📈 **Графіки в чаті** — *"Покажи витрати за квартал у вигляді pie chart"* → готово
- 🔍 **Пошук Ctrl+K** по всій історії чатів
- 🏢 **Multi-company** з ізольованими сесіями (свій API-ключ для кожної)
- 🛡️ **Підтвердження дій** перед будь-якою зміною даних у Finmap

## 📸 Демо

<div align="center">

> *(тут буде GIF з основними сценаріями — додам після першого Demo Day)*

</div>

## 📦 Встановлення

### Передумова — Claude Code CLI

Folio працює поверх **Claude Code CLI**. Можеш встановити його **через кнопку всередині Folio** (Setup-екран при першому запуску) або руками:

| ОС | Команда |
|---|---|
| **Windows** | `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` |
| **macOS / Linux** | `curl -fsSL https://claude.ai/install.sh \| sh` |

Після встановлення:
```
claude login
```

> ℹ️ Після встановлення Claude Code **перезапустіть Folio**, щоб додаток підхопив новий PATH.

### 🪟 Windows

1. Завантаж `Folio Setup X.X.X.exe` з [останнього релізу](https://github.com/vitalii98t/folio/releases/latest)
2. Двічі клікни `.exe`
3. Якщо SmartScreen покаже **"Windows protected your PC"** → `More info` → `Run anyway`
4. Майстер встановлення → обираєш папку → Install
5. Запускай через ярлик у Start Menu

> **Дані:** `%APPDATA%\folio\` (історія, налаштування, автозадачі)

### 🍎 macOS

| Mac | Файл |
|---|---|
| **Apple Silicon** (M1/M2/M3/M4) | `Folio-X.X.X-arm64.dmg` |
| **Intel** | `Folio-X.X.X.dmg` |

> Не знаєш який? Меню `` → `About This Mac` → "Chip: Apple M..." це Apple Silicon.

1. Завантаж `.dmg` з [релізу](https://github.com/vitalii98t/folio/releases/latest)
2. Двічі клікни → перетягни **Folio** у `Applications`
3. **Перший запуск:** через відсутність Apple Developer ID треба зняти quarantine. У Terminal:
   ```bash
   xattr -cr /Applications/Folio.app
   ```
4. Запускай з Applications

> **Дані:** `~/Library/Application Support/folio/`

### 🐧 Linux

1. Завантаж `Folio-X.X.X.AppImage` з [релізу](https://github.com/vitalii98t/folio/releases/latest)
2. Дай право на виконання:
   ```bash
   chmod +x Folio-*.AppImage
   ```
3. Запускай:
   ```bash
   ./Folio-*.AppImage
   ```

> **Дані:** `~/.config/folio/`

## 🚀 Перші кроки

1. **Setup-екран** перевіряє чи встановлений Claude Code. Якщо ні — кнопка `Встановити Claude Code` відкриває термінал зі скриптом
2. **Авторизуйся:** кнопка `Увійти в Claude Code` → у терміналі запуститься `claude login`
3. **Додай компанію:** натисни `+` у sidebar → введи назву + Finmap API-ключ
   - Ключ: **Finmap → Налаштування → API**
4. **Питай у чат:** *"Покажи витрати за серпень по категоріях"*

## 💬 Що можна питати

```
Покажи витрати за серпень по категоріях у вигляді графіка
Звір цю виписку з рахунком ПриватБанк UAH        (+ прикріпити PDF/CSV)
Знайди операції без категорії за минулий тиждень і поставь категорії з коментаря
Підключи інтеграцію з нашою CRM, ось API-доку    (+ скинути доку)
Розрахуй чистий прибуток за квартал по проекту X
Знайди дублікати у вхідних платежах
Розділи цей платіж 50/50 між проєктами Маркетинг і Дослідження
```

## 🧠 Спеціалізовані скіли

Folio постачається з 10 готовими **скілами** — папками інструкцій у `resources/skills/`, які Claude підвантажує автоматично, коли запит юзера матчиться з тригер-фразами скіла. Це винесена з основного промта спеціалізована логіка, що тримає основний промт коротким і дає однакову поведінку на повторюваних задачах.

| Скіл | Тригер | Що робить |
|------|--------|-----------|
| `reconcile-statement` | "звір виписку" + файл | 3-pass detematizonий matcher (1:1 / split / shifted-date), презентація у 5 групах |
| `integration-setup` | "+ Інтеграція" / "підключи [сервіс]" | Розбирає API-доку, робить першу синхронізацію, зберігає `syncPrompt` для авто-синку |
| `integration-modify` | "змінюй інтеграцію" / "поміняй інтервал" | Update-only, захист від duplicate-save бага |
| `mass-import` | прикріплений Excel/CSV + "імпортуй" | Батч-парсинг + `check_externalIds` дедуп + chunked create |
| `split-operations` | "розділи 50/50" / "70% на X" | Project-split XOR category-split, валідація стейків |
| `charts-output` | "візуалізуй" / "покажи графіком" | bar/line/pie через `finapse-chart` fenced-блок |
| `receipt-from-photo` | фото чека + "ось чек" | Vision-парсинг, мапінг на категорію + контрагент |
| `tax-quarterly-report` | "квартальний звіт ФОП" | UA-специфіка: групи ЄП, ліміти, дедлайни |
| `cashflow-forecast` | "прогноз" / "вистачить грошей" | Detect recurring → forecast next 1-3 months |
| `period-summary` | "підсумки місяця/кварталу" | Стандартизований формат з порівнянням до попереднього періоду |

Скіли вантажаться **on-demand** — коли заявка не матчиться з жодним, контекст лишається мінімальним. Бекграунд-задачі (sync, scheduled tasks) запускаються з окремим лін-промтом, без скільної логіки взагалі.

Детальніше про архітектуру скілів — у `docs/product-overview.md`.

## 🛠️ Технологічний стек

| | |
|---|---|
| **Runtime** | Electron 33 |
| **UI** | React 19 + Vite + TypeScript |
| **AI** | [Claude Code SDK](https://www.npmjs.com/package/@anthropic-ai/claude-code) (agentic, MCP-based) |
| **Графіки** | Recharts |
| **Storage** | Local JSON (per-user `userData`) |
| **Packaging** | electron-builder + GitHub Actions |

## 🔧 Збірка з вихідного коду

```bash
git clone https://github.com/vitalii98t/folio.git
cd folio
npm install
npm run icons       # генерує іконки з SVG
npm run build       # компілює main + renderer
npm run dist:win    # збирає Windows installer
# або: dist:linux  (тільки на Linux/CI з fpm)
# або: dist:mac    (тільки на macOS)
```

Готовий файл — у `release/`.

Workflow для CI/CD: [.github/workflows/build.yml](.github/workflows/build.yml) — збирає всі 3 платформи паралельно при push.

## 📂 Структура

```
src/
├── main/           # Node.js процес: IPC, MCP сервер, scheduler, AgentManager
│   ├── main.ts             # entry point
│   ├── agent-manager.ts    # Claude Code SDK wrapper
│   ├── mcp-tools.ts        # 43 MCP-тули для Finmap API
│   ├── reconcile-matcher.ts # детермінований 3-pass matcher
│   ├── skills-installer.ts # копіює бандл-скіли у workspace при старті
│   ├── sync-scheduler.ts   # автозадачі + автосинхронізація
│   └── system-prompt.ts    # інструкції для Claude (UI + BG варіанти)
├── renderer/       # React UI
│   ├── components/         # ChatView, Sidebar, модалки, чарти
│   ├── styles/             # CSS modules (Frozen Sky тема)
│   └── hooks/              # useVoiceInput тощо
├── shared/types.ts # IPC контракти + типи
└── ../resources/skills/    # 10 спеціалізованих скілів (бандляться у release)
```

## 🗺️ Roadmap

- [ ] **Голосовий чат** — диктуєш витрату → Claude парсить
- [ ] **Email/IMAP парсинг** — виписки з пошти автоматично
- [ ] **Marketplace** — публікація як перший продукт у Finmap Marketplace для незалежних розробників

## 👤 Автор

**Vitalii Tovkes** — розробник [Finmap](https://finmap.online)

[![GitHub](https://img.shields.io/badge/GitHub-vitalii98t-181717?logo=github)](https://github.com/vitalii98t)

## 📄 Ліцензія

MIT — деталі у файлі [LICENSE](LICENSE).
