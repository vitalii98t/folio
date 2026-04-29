# Folio

> AI-асистент для управління фінансами у [Finmap](https://finmap.online).

Folio — desktop-додаток на базі Claude Code SDK, який дає Claude повний доступ до Finmap API через 41 MCP-тул. Можеш у звичайному чаті:

- Категоризувати, створювати, редагувати, видаляти операції / інвойси / контрагентів / категорії
- Звіряти банківські виписки з Finmap (CSV / PDF / XLSX)
- Підключати інтеграції до будь-якого зовнішнього API за **10 хвилин** (раніше потребувало розробки)
- Запускати **автозадачі за розкладом**: автокатегоризація, автосинхронізація, автозвірка
- Бачити графіки прямо в чаті, шукати по всій історії (Ctrl+K)

---

## Встановлення

### Передумови (для всіх платформ)

Folio використовує **Claude Code CLI** — його треба встановити окремо. Можеш зробити це **через кнопку всередині Folio** (з'явиться при першому запуску) або руками:
(після встановлення перезавантажте додаток Folio)

| ОС | Команда у терміналі |
|---|---|
| **Windows** | `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` |
| **macOS / Linux** | `curl -fsSL https://claude.ai/install.sh \| sh` |

Після встановлення виконай:
```
claude login
```

Це відкриє браузер для авторизації в Anthropic.

---

### Windows

1. Завантаж `Folio Setup X.X.X.exe` з [останнього релізу](https://github.com/vitalii98t/folio/releases/latest)
2. Двічі клікни `.exe`
3. Якщо Windows Defender / SmartScreen покаже **"Windows protected your PC"** — натисни `More info` → `Run anyway` (це через відсутність code-signing сертифіката, додаток безпечний)
4. Майстер встановлення → обираєш папку → "Install"
5. Запускай через ярлик у Start Menu або на робочому столі

**Дані додатку** зберігаються у `%APPDATA%\folio\` (історія чатів, налаштування компаній, автозадачі).

---

### macOS

Обери файл під свій процесор:

| Mac | Файл |
|---|---|
| **Apple Silicon** (M1/M2/M3/M4) | `Folio-X.X.X-arm64.dmg` |
| **Intel** | `Folio-X.X.X.dmg` |

> Не знаєш який? Меню `` → `About This Mac`. Якщо "Chip: Apple M..." — Apple Silicon. Якщо "Processor: Intel..." — Intel.

1. Завантаж `.dmg` з [останнього релізу](https://github.com/vitalii98t/folio/releases/latest)
2. Двічі клікни `.dmg` → перетягни **Folio** у `Applications`
3. **Важливо:** через відсутність Apple Developer ID при першому запуску macOS заблокує додаток. Відкрий **Terminal** і виконай:
   ```bash
   xattr -cr /Applications/Folio.app
   ```
   (Це знімає quarantine-флаг, який macOS ставить файлам з інтернету для unsigned-додатків.)
4. Запускай Folio з Applications

**Дані додатку** зберігаються у `~/Library/Application Support/folio/`.

---

### Linux (Ubuntu / Debian / Fedora / Arch — будь-який дистрибутив)

1. Завантаж `Folio-X.X.X.AppImage` з [останнього релізу](https://github.com/vitalii98t/folio/releases/latest)
2. У терміналі додай право на виконання:
   ```bash
   chmod +x Folio-*.AppImage
   ```
3. Запускай:
   ```bash
   ./Folio-*.AppImage
   ```

Або клацни на файл правою кнопкою → `Properties` → `Permissions` → відмітити `Allow executing file as program` → подвійний клік запускає.

**Дані додатку** зберігаються у `~/.config/folio/`.

---

## Перші кроки після встановлення

1. **Setup-екран** — Folio перевіряє, чи встановлений Claude Code. Якщо ні, кнопка `Встановити Claude Code` відкриває термінал зі скриптом установки.
2. **Авторизуйся:** кнопка `Увійти в Claude Code` → у терміналі запуститься `claude login` → у браузері пройдеш OAuth.
3. **Додай компанію:** натисни `+` у sidebar → введи назву + Finmap API ключ.
   - API ключ береш у **Finmap → Налаштування → API**.
4. **Привіт у чат** — Folio відповість і покаже що вміє.

---

## Що може Folio (приклади запитів)

- *"Покажи витрати за серпень по категоріях у вигляді графіка"*
- *"Звір цю виписку з рахунком ПриватБанк UAH"* + прикріпити PDF/CSV
- *"Знайди операції без категорії за минулий тиждень і поставь категорії з коментаря"*
- *"Підключи інтеграцію з нашою CRM, ось API-доку"* + скинути PDF або текст документації
- *"Розрахуй чистий прибуток за квартал по проекту X"*
- *"Знайди дублікати у вхідних платежах"*

---

## Автозадачі (запускаються в фоні за розкладом)

У ⚙ налаштуваннях компанії → секція **"Автозадачі"** → `+` → описуєш що Claude має робити (наприклад, *"кожні 30 хв категоризуй нові операції"*) → обираєш інтервал.

Folio запускає Claude автоматично в фоновому режимі, без UI-підтверджень. Бачиш результат у тостері справа зверху + у деталях задачі.

---

## Збірка з вихідного коду

Тільки якщо хочеш модифікувати:

```bash
git clone https://github.com/vitalii98t/folio.git
cd folio
npm install
npm run icons       # генерує іконки з SVG
npm run build       # компілює main + renderer
npm run dist:win    # збирає Windows installer
# або dist:linux / dist:mac (mac тільки на macOS)
```

Готовий файл — у `release/`.

Детальніше про CI/CD: [`.github/workflows/build.yml`](.github/workflows/build.yml).

---

## Технологічний стек

- **Electron 33** — desktop runtime
- **React 19** + **Vite** + **TypeScript** — UI
- **Claude Code SDK** (`@anthropic-ai/claude-code`) — agentic AI з підтримкою MCP
- **Recharts** — графіки в чаті
- **electron-builder** — пакування для всіх платформ через GitHub Actions

---

## Автор

[vitalii98t](https://github.com/vitalii98t) — розробник [Finmap](https://finmap.online).

---

## Ліцензія

Поки немає публічної ліцензії — всі права збережено за автором.
