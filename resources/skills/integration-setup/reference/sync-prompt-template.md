# syncPrompt — шаблон і приклади

Цей файл описує як писати `syncPrompt` так, щоб через місяць автосинк не зламався.

## Обовʼязкові секції syncPrompt

```
1. URL: <повний URL ендпойнту операцій>
2. METHOD: GET (або POST якщо інакше)
3. AUTH: <як саме авторизуватись — який header, з яким значенням>
4. DATE FILTER: <як фільтрувати, які параметри передавати>
5. PARSING: <шлях до масиву операцій у відповіді, наприклад response.data.transactions>
6. FIELD MAPPING:
   - amount: <як отримати signed-суму з відповіді>
   - date: <звідки брати дату, у якому форматі>
   - description: <звідки опис>
   - originalId: <звідки унікальний ID операції — для externalId>
7. FINMAP MAPPING:
   - account: {finmapAccountId}
   - category default: <якщо немає — пиши 'без категорії'>
   - counterparty: <якщо описание містить назву компанії — створювати/шукати>
8. WINDOW: тягнути операції за останні 24 години (з overlap для надійності)
9. DEDUP: externalId = "{serviceName}_{originalId}".
   ПЕРЕД create_operation роби БАТЧ-перевірку (один виклик на всю партію):
   - Збери всі expected externalIds з відповіді API
   - Виклич: check_externalIds({
       externalIds: [...],
       accountIds: [{finmapAccountId}],
       startDate: <window start in ms>,
       endDate: <window end in ms>,
     })
   - Створюй операції тільки для тих, що в "missing"
   НЕ використовуй get_operations({search}) для пошуку externalId — search НЕ шукає по externalId полю.
```

## Приклад syncPrompt (псевдо, для абстрактного банку)

```
URL: https://api.examplebank.com/v1/transactions
METHOD: GET
AUTH: Header "X-Api-Key: {serviceApiKey}"
DATE FILTER: query params ?from={ISO date}&to={ISO date}.
  Тягни операції за останні 26 годин (24h + 2h overlap).
PARSING: response це JSON-обʼєкт, операції лежать у полі response.transactions[].
FIELD MAPPING:
  - amount: from "amount" field. Якщо "type" == "debit", роби негативним.
    Якщо "credit" — позитивним.
  - date: from "transactionDate", формат YYYY-MM-DD.
  - description: from "narrative" field.
  - originalId: from "transactionId".
FINMAP MAPPING:
  - account: {finmapAccountId}
  - category default: "без категорії"
  - counterparty: якщо "merchantName" непорожнє — get_counterparties → знайти,
    якщо нема — create_counterparty type=supplier.
WINDOW: останні 26 годин.
DEDUP: externalId = "examplebank_" + originalId.
  ПЕРЕД create_operation:
    1. Збери список expected externalIds з усіх щойно отриманих transactions API
    2. Виклич ОДИН раз з accountIds + sync window — це активує fast-path:
       check_externalIds({
         externalIds: ["examplebank_001", "examplebank_002", ...],
         accountIds: [{finmapAccountId}],
         startDate: <Date.now() - 26h>,
         endDate: <Date.now()>,
       })
    3. Створюй операції тільки для тих, що в response.missing.
```

## Чому саме така структура

- **URL/METHOD/AUTH/DATE FILTER** — щоб фоновий процес знав ЯК зробити запит без додаткового діалогу.
- **PARSING + FIELD MAPPING** — щоб не залежало від того, чи запамʼятав AI структуру відповіді з минулого діалогу. Усе явно тут.
- **FINMAP MAPPING** — куди саме операції потрапляють. Категорії і контрагенти — окремий тонкий момент: якщо не вказано як створювати, AI може запропонувати юзеру і всю автоматизацію зломається.
- **WINDOW з overlap** — без overlap пропустимо операції, які прийшли в межах 1-2 хвилин після останнього синку. 2 години overlap + дедуплікація через externalId = надійність без дублікатів.
- **DEDUP блок останній і обовʼязковий** — без нього кожен синк створює дублікати. Завжди через `check_externalIds` (один батч-виклик), а не через `get_operations({search})`, бо search НЕ шукає по externalId.

## Антипатерни — як НЕ писати syncPrompt

❌ **Розпливчасто:** "тягни операції з банку і додавай у Finmap" — AI вгадуватиме URL щоразу інакше.

❌ **Без явного дедупу:** "перевіряй чи операція не існує" — AI забуде формат externalId і дублі поліжуть.

❌ **Без явного знаку amount:** банки часто повертають додатню суму + поле "type". Якщо не сказати "переведи в signed", у Finmap всі операції будуть позитивними і ламатимуть звітність.

❌ **Категорія "як буде" без default:** AI відмовиться створювати операцію, бо не знає категорії, синк зависне.
