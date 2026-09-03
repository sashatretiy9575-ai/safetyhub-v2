# Административный процесс локализации

`/admin` всегда работает на русском языке. Редакторы курса, статьи и юридического
документа показывают четыре вкладки: RU, KK, EN и ZH. Язык вкладки относится к
публикуемому материалу и не меняет язык самой административной панели.

## Статусы

- `Не заполнено` — локализованного черновика ещё нет;
- `Черновик` — материал сохранён, но не прошёл автоматическую проверку;
- `Готово` — `reviewed_content_hash` совпадает с текущим `content_hash`;
- `Опубликовано` — готовый hash вошёл в текущую неизменяемую редакцию.

Любое изменение готового текста снова переводит язык в черновик. RU синхронизируется
из существующей основной формы курса или статьи и в языковых вкладках доступен только
для контроля и предпросмотра. KK, EN и ZH редактируются в соответствующей вкладке.
Предпросмотр задаёт `lang` выбранной локали; китайский предпросмотр использует CJK-font
даже при русском `lang` административного layout.

## Курсы и граница ключей ответов

Браузер получает для локализованного assessment только статус и количества: три
варианта и по десять вопросов. Он не получает и не отправляет UUID вариантов,
вопросов или опций сохранённого банка, правильный ответ, номер выбранного варианта
ученика либо private answer-key данные. Обычное сохранение локализации передаёт в RPC
явный пустой `p_question_variants`; существующий серверный банк сохраняется без
изменений. Это правило относится именно к редактору локализаций и остаётся в силе.

Единственное исключение — русский редактор курса: с миграции
`20260903090000_course_editor_question_bank_read.sql` он читает сохранённый банк
целиком через `public.read_course_question_bank_v4` под правом `test.manage` и с
записью в журнал аудита.

Практическое следствие для переводов: бандлы KK/EN/ZH сопоставляются с русским
банком по тем же UUID вариантов, вопросов и опций. Пока редактор выдумывал новые
идентификаторы на каждое сохранение, связь рвалась незаметно при любой правке
курса. Теперь она рвётся только тогда, когда администратор действительно изменил
состав, порядок или количество вопросов — и тогда публикация будет заблокирована
`private.assert_course_draft_localizations_complete`, пока не выполнен повторный
`npm run content:assessment-localization:import`.

Локализованный банк вопросов импортируется только операторской командой с
service-role credential в локальном secret context. JSON bundle имеет точную форму:

```json
{
  "version": 1,
  "courseId": "00000000-0000-0000-0000-000000000000",
  "locale": "kk",
  "expectedVersion": 1,
  "questionVariants": [
    {
      "id": "stable-variant-uuid",
      "variantNumber": 1,
      "questions": [
        {
          "id": "stable-question-uuid",
          "text": "Локализованный вопрос",
          "explanation": "Публичное пояснение",
          "options": [{ "id": "stable-option-uuid", "text": "Локализованный ответ" }]
        }
      ]
    }
  ]
}
```

Полный bundle обязан содержать точную матрицу `3 × 10 × 4` и те же UUID/порядок,
что канонический RU assessment. Любое неизвестное поле, включая `correctOptionId`
или иной вариант answer key, блокирует импорт. Сначала выполняется локальная проверка:

```powershell
npm run content:assessment-localization:check -- --file C:\secure\course-kk.json
```

`expectedVersion` берётся из строки «Версия черновика для offline-импорта» в
локализованной вкладке после первого сохранения текста и презентации. Применение
требует linked/local URL, service credential, UUID администратора с `test.manage` в
`SAFETYHUB_CONTENT_OPERATOR_ID` и точного подтверждения:

```powershell
npm run content:assessment-localization:import -- --file C:\secure\course-kk.json --confirmation IMPORT:<courseId>:kk
```

Команда выводит только counts, version и content hash. Исходный bundle, тексты,
UUID и credentials в stdout не выводятся. Файл импорта не размещается в репозитории
или browser upload. После импорта администратор обновляет страницу, проверяет counts
и завершает текстовую локализацию.

Для проверенной Stage 6 партии не нужно вручную копировать `expectedVersion` 45 раз.
`npm run content:localizations:publish:plan` проверяет финальный hash-only receipt, а
контролируемая `content:localizations:publish` перед каждым save/import заново читает
hosted `draft_version`. Она использует тот же authenticated admin RPC для текста и
публикации и тот же service-only RPC для assessment, затем повторно читает immutable
revision и сравнивает каждую локаль со staged manifest. Команда требует точный
production project ref, UUID той же admin-сессии, reviewed batch hash и буквальное
подтверждение; её полный операторский вызов описан в
`docs/content-localization-batch.md`. Повторный запуск после сетевого сбоя либо
продолжает незавершённую фазу, либо доказывает exact replay без новой revision.

## Презентации

Загрузка использует существующий staging/finalize процесс. Staging keys остаются
привязанными к оператору и receipt:

```text
<actorId>/<presentationId>/source.pdf
<actorId>/<presentationId>/thumbnail.webp
```

Locale хранится в metadata row. Finalizer блокирует эту строку, проверяет совпадение
course/locale/digest/page count, повторно валидирует PDF и thumbnail и создаёт новые
immutable objects:

```text
<courseId>/<locale>/<presentationId>/<sha256>.pdf
<courseId>/<locale>/<presentationId>/<sha256>-thumb.webp
```

Legacy path без locale допускается только как replay ранее опубликованного RU asset.
Новая загрузка любой локали, включая RU, всегда содержит locale segment. Browser
response содержит bounded presentation receipt, но не Storage bucket/path.

## Атомарная публикация

Кнопка публикации основной формы сначала сохраняет канонический RU-черновик, затем
вызывает four-locale publisher. Database transaction блокирует локализованные строки,
проверяет RU/KK/EN/ZH, presentation receipts и assessment topology, и только после
этого создаёт одну неизменяемую revision. Если матрица неполна, RU-черновик остаётся
сохранён, а текущая опубликованная revision не меняется.

Статьи следуют тому же процессу без assessment/presentation. Для юридических
документов сначала создаётся новая каноническая версия Privacy и Terms с одной
датой начала по `Asia/Oral`, затем сохраняются восемь structured JSON copies.
Publication активирует обе версии и все RU/KK/EN/ZH immutable copies одной
транзакцией; опубликованный текст нельзя редактировать. Отдельный publisher
одного юридического документа намеренно отключён, чтобы не оставить mixed
current consent pair.

Перед изменением production content обязательно выполнить linked check с явно
подтверждённым текущим project ref и pinned PostgreSQL CA (точная команда приведена
в `docs/content-localization-batch.md`). Интерактивные изменения выполняются через
admin application; утверждённая Stage 6 партия может быть оркестрирована только
service-side batch-командой, которая вызывает те же admin publication contracts.
После неё выполняются linked pull, просмотр deterministic diff, localized snapshot
validator и linked parity. Тестовая разработка интерфейса и `--plan` сами по себе
не публикуют и не изменяют production content.

## ZH synthetic identity

Approval queue, employee directory, learning history и export используют
редактированные admin projections: synthetic `@auth.invalid` identity остаётся
`null`, а интерфейс показывает нейтральную подпись «Вход по логину и паролю».
Synthetic email, username, пароль, password hash, credentials и recovery data
нельзя добавлять в HTML, JSON, CSV/PDF export, Telegram, audit payload или
analytics. Исторические WebAuthn credential metadata подчиняются тому же запрету.
