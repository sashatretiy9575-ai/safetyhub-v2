# Архитектура SafetyHub

## Контуры приложения

SafetyHub — Next.js App Router приложение с тремя интерфейсными контурами:

- публичный сайт: курсы, статьи, SEO, PWA и проверка сертификата;
- кабинет участника: профиль, прохождение тестов и сертификаты;
- административная оболочка: участники, результаты, курсы, статьи и настройки.

Код разделён по ответственности: `app` содержит маршруты, `components` — UI,
`features` — прикладные сценарии, `lib` — общие контракты, `supabase` — миграции,
SQL-тесты и Edge Functions, `content` — локальный development fallback и seed.

## Локали и URL

Публичный и learner-контуры используют единый тип `AppLocale` со значениями
`ru`, `kk`, `en`, `zh`. Русский остаётся default locale без префикса, а казахский,
английский и упрощённый китайский доступны под `/kk`, `/en`, `/zh`. Админка,
`/api`, Next internals, metadata endpoints и неизменяемые assets не получают
locale aliases; `/admin` всегда получает русский request context.

Существующее дерево App Router не дублируется. `proxy.ts` разбирает внешний URL,
записывает проверенные `x-safetyhub-locale` и `x-safetyhub-pathname`, затем
переписывает локализованный URL на существующий внутренний route. До rewrite
вычисляются protected-path и CSP nonce, поэтому `/zh/profile` и
`/en/topics/{slug}/test` проходят тот же Supabase cookie refresh и те же
authorization gates, что и непрефиксные маршруты. Locale-prefixed API/admin/asset
URL не переписываются и завершаются 404.

Порядок определения языка для первого непрефиксного запроса: locale-cookie,
взвешенный `Accept-Language`, затем RU. Явный `/kk`, `/en` или `/zh` всегда имеет
приоритет и обновляет годовую `SameSite=Lax` cookie. Переключатель языка сначала
обновляет cookie, затем открывает тот же нормализованный pathname и сохраняет
query string. Синхронизация `profiles.preferred_locale` добавляется поверх этого
контракта после аутентификации и не меняет URL-правила.

`next-intl` загружает один из четырёх каталогов `messages/*.json`; типы ключей
выводятся из RU-каталога, а тест требует точного совпадения ключей и ICU-параметров
во всех языках. Runtime fallback на русский не используется. HTML `lang`,
canonical, `hreflang`, Open Graph locale, JSON-LD language и sitemap alternates
формируются из того же locale-контракта.

Manifest и offline shell имеют отдельные locale endpoints `/manifest/{locale}`
и `/offline/{locale}`. Service Worker precache-ит все восемь документов, выбирает
offline fallback по префиксу исходной навигации и по-прежнему полностью обходит
auth/profile/test/callback маршруты. Китайская оболочка использует локальный
subset Noto Sans SC только при `data-locale="zh"`; остальные маршруты не
загружают CJK asset.

## Данные и доверительные границы

Supabase предоставляет Auth, PostgreSQL и Storage. Браузер не считается
доверенной стороной: административные операции повторно проверяют capability в
security-definer RPC, используют ограниченные payload, rate limit и audit log.
Service-role key доступен только серверу и служебным worker-процессам.

Продуктовые роли — `participant` и `admin`. Детальные возможности администратора
проверяются capability-моделью, но не передаются публичному клиенту сверх
необходимого текущему экрану.

## Жизненный цикл контента

Для курса и статьи существуют только состояния `draft` и `published`.

- `Сохранить` обновляет серверный черновик с optimistic version check.
- `Опубликовать` в одной PostgreSQL-транзакции сохраняет текущий payload и создаёт
  новую неизменяемую опубликованную ревизию.
- У опубликованного объекта может быть более новый черновик; интерфейс показывает
  нейтральную пометку `Есть черновик`, а не отдельный lifecycle-статус.
- Юрисдикция, дата актуальности и источники необязательны и не блокируют
  публикацию.

Курс публикуется целиком: метаданные, неизменяемая PDF-презентация, правила
прохождения и три варианта по десять вопросов входят в один черновик и одну
неизменяемую ревизию. Структура выбранного варианта хранится отдельно от ключа
ответов. Браузер участника получает только вопросы назначенного варианта без
`variant_id`, номера варианта и правильных ответов.

Удаление доступно только через `delete_course` и `delete_article`. RPC блокирует
строку, проверяет ожидаемую версию, пишет минимальный audit-факт и удаляет связанные
данные в одной транзакции. Slug redirects и cache tags очищаются вместе с объектом.

## Презентации курсов

Пользовательский материал курса — PDF в приватном bucket
`course-presentations`. Неизменяемый content-addressed путь с SHA-256 — это
внутренний ключ Storage, а не публичная ссылка: сам по себе он не даёт права
скачивания. Черновик и опубликованная ревизия ссылаются на конкретную
`ready`-запись `course_presentations`.

Администратор загружает PDF и WebP-миниатюру напрямую в приватный bucket
`course-presentations-staging` по короткоживущему signed upload token. Сервер
проверяет сигнатуру и структуру PDF, отсутствие шифрования и опасных actions,
фактический SHA-256, число страниц, MIME, размер и миниатюру. Только после этого
объекты копируются в приватный неизменяемый путь. Неудачная замена не влияет на
ранее опубликованную ревизию.

На странице курса PDF не встраивается и не рендерится в браузере. Одна и та же
same-origin download route повторно проверяет активную сессию и ручное состояние
`approved`, актуальные legal acceptance и locale binding. Перед Storage route
атомарно расходует actor/network budget и берёт короткую actor/global lease;
объект передаётся без буферизации, с точным byte ceiling, 60-секундным deadline
и освобождением lease при EOF, ошибке, отмене или разрыве клиента. Ответ сохраняет
`Content-Disposition: attachment` и `Cache-Control: private, no-store`.
Неавторизованный, pending или rejected пользователь не может использовать маршрут
или Storage URL в обход интерфейса. Прогресс чтения PDF не записывается в базу и
не является условием начала теста.

Предпросмотр и скачивание в редакторе курса проходят через отдельный same-origin
маршрут с capability `test.manage`. Он также потоково отдаёт байты с `no-store`;
админский браузер не получает Storage signed URL, потому что CDN-cache
неизменяемого объекта не должен переживать авторизацию preview.

## Попытки, варианты и сертификаты

Новая попытка создаётся только серверной RPC в одной транзакции. RPC блокирует
пару участник–курс advisory lock, проверяет роль и дневной лимит, случайно выбирает
один из трёх вариантов и сохраняет его в попытке. При возобновлении возвращается
тот же вопросник; срок попытки не продлевается. Политика текущего каталога — 10
вопросов, 7 правильных для сдачи, 15 минут и не более 8 новых попыток на курс за
календарный день `Asia/Oral`.

Оценивание использует приватный ключ выбранного варианта. Аттестация и сертификат
создаются только после успешного результата и ссылаются на конкретные попытку и
ревизию. Отдельная административная операция с capability `results.delete`
удаляет всю учебную историю участника — задания экспорта, сертификаты,
аттестации и попытки — одной транзакцией, но сохраняет Auth account, профиль,
роль, настройки и аудит. После удаления старый QR возвращает «Сертификат не
найден».

Сервер сертификатов выполняет только авторизацию, bounded metadata lookup и
создание HMAC-подписанного verification URL. Бывший PDF endpoint отвечает
`CERTIFICATE_PDF_CLIENT_ONLY`; фактический PDF формирует отдельный browser Web
Worker, который после действия пользователя динамически загружает `pdf-lib`, QR,
неизменяемый шаблон и locale font. В browser graph этого контура нет
`node:fs`, `node:path` или `node:crypto`, а HMAC secret никогда не передаётся
клиенту.

Административный export повторно проверяет выбор actor-bound RPC и возвращает
только JSON metadata максимум для 500 сертификатов. Worker формирует русский
сводный отчёт и ZIP с concurrency 2. При наличии File System Access API архив
пишется потоком в выбранный файл; иначе браузер получает отдельные архивы не
более 100 сертификатов каждый. Прогресс и отмена остаются клиентскими, PDF/ZIP
bytes не создаются route handlers и не сохраняются в PostgreSQL или Storage.

## Редакторы и граница ключей ответов

Курсы и статьи используют общие shell, action bar и optimistic concurrency.
Статьи сохраняют block-editor; курс больше не зависит от текстового слайдера и
редактируется как метаданные, presentation asset, правила и три вкладки вариантов.
Однако сохранённый question bank не является editor-read payload: при открытии
существующего курса сервер передаёт только metadata, безопасную PDF-сводку и
историю ревизий. Клиент всегда создаёт пустые три варианта; правильные ответы,
пояснения и идентификаторы ранее сохранённых вариантов не входят ни в HTML, ни
в React client payload, ни в browser-callable RPC. Администратор вводит новый
набор только в памяти страницы и отправляет его через защищённую mutation route.
Предыдущая опубликованная ревизия сохраняется, пока новая не опубликована.

Локальное сохранение course-editor отключено, а известные ключи старых
course-черновиков удаляются по имени без чтения значения. Общий локальный store
по-прежнему разрешён для article-editor, но не для assessment data.

Иконка курса выбирается из единого реестра Phosphor с типом `IconId`, категориями,
поиском и сохранёнными legacy ID `factory`, `shield`, `fire`, `first-aid`.

## Изображения

Браузер декодирует поддерживаемые JPEG/PNG/WebP/AVIF через `createImageBitmap`,
уменьшает под целевое поле, удаляет metadata при canvas re-encode и отправляет
WebP. Если безопасное преобразование недоступно, отправляется исходный файл.

Сервер всегда повторно декодирует байты Sharp, исправляет ориентацию, ограничивает
изображение 1600×1600, создаёт канонический WebP, проверяет размер и вычисляет
SHA-256. Storage key адресуется хешем, поэтому одинаковые байты дедуплицируются.
Публичные варианты WebP/AVIF и responsive `srcset` создаёт Next Image Optimizer.

Удаление контента помечает только доказанные неиспользуемые assets как
`orphan_candidate`; фактическое удаление выполняет Storage Reconciler после
повторной проверки ссылок.

## Воспроизводимость hosted-контента

Forward-only миграции — единственный источник истины для схемы, RPC, RLS, grants,
триггеров и Storage policies. Опубликованный рабочий контент меняется через
административный интерфейс, а `content/snapshots/` хранит его детерминированный
локальный снимок, PDF, миниатюры, hashes и seed. Снимок не содержит пользователей,
профили, учебную историю или аудит. Правила синхронизации и cutover описаны в
`docs/content-and-database-workflow.md` и обязательны для будущих изменений.

Four-locale authoring, service-only assessment import, locale-specific presentation
paths и атомарные publication contracts описаны в
`docs/admin-localization-workflow.md`. Эти контракты сохраняют private answer-key
boundary: browser editor видит только публичный текст курса и агрегированные counts.

## Auth, согласия и ручное одобрение

RU/KK/EN используют шестизначный одноразовый код из email (email OTP). ZH
использует отдельный discoverable WebAuthn passkey с обязательной проверкой
пользователя устройством; email, SMS, password и username в китайском flow нет.
Номер в профиле во всех локалях остаётся только контактным полем. Нативный
Supabase email OTP технически создаёт для нового пользователя
внутренний случайный password hash, поэтому `auth.users.encrypted_password` не
является корректным признаком passwordless и не блокируется database trigger.
Вместо этого `enforce_email_otp_access_token` работает как Supabase Custom
Access Token Hook. Для обычных аккаунтов access token выдаётся только для
`email/signup`, `otp`, `magiclink` и продолжения уже разрешённой сессии
`token_refresh`. Для synthetic ZH identity допускается только server-generated
`magiclink`, связанный с одноразовым двухминутным grant после проверенной
WebAuthn-операции. Hook привязывает полученный `session_id` к текущему
`auth_epoch`, а refresh разрешается только для этой точной пары; reset passkey
удаляет разрешённые сессии, увеличивает epoch и инвалидирует старые refresh
tokens. Дополнительный request-time gate сверяет epoch и `session_id`
для каждого application authorization, поэтому уже выданный access token также
перестаёт работать сразу после reset. Provider-only `@auth.invalid` адрес
в обязательном JWT email claim заменяется пустой строкой и не входит в browser
или admin projections. Password, recovery, invite, OAuth, phone и anonymous
methods получают отказ до выдачи JWT.
Код отправляется через Supabase Auth после same-origin и coarse IP quota;
переданный приложением Turnstile token проверяет сам Supabase Auth provider, без
второй попытки Siteverify одноразового токена. Login и registration используют единый
`signInWithOtp`-шлюз с разрешённым созданием неизвестного email: поэтому форма
входа не подтверждает существование аккаунта и не оставляет нового пользователя
без письма. После принятой provider-ом отправки приложение создаёт отдельный
opaque receipt: cookie содержит только 32 случайных байта, а private DB — только
HMAC receipt и HMAC нормализованного email, expiry не более часа и счётчик не
более шести попыток. До provider proof изменяется только coarse network quota;
неверный CAPTCHA или код не может расходовать общий victim-email budget.
Успешная проверка кода атомарно удаляет receipt до сохранения обычной
Supabase-сессии.

ZH challenge хранится только как SHA-256 receipt, живёт не более пяти минут и
потребляется ровно один раз. Private-таблицы держат credential ID, public key,
monotonic counter, user handle и salted/peppered recovery digest; browser grants
на эти данные отсутствуют. Создание Auth user и immutable avatar связано durable
registration operation: orphan Auth или Storage объект переводится в cleanup
state и удаляется bounded lease-worker. Запись immutable avatar в Storage
разрешена только server-side `service_role` для точной операции в состоянии
`auth_created`, совпадающих user/object key и ещё живого неприменённого
registration challenge; обычный authenticated avatar upload по-прежнему требует
отдельную `avatar_upload_operations` lease. После успешной регистрации профиль
сразу получает `preferred_locale = 'zh'` и `pending`; существующие approval/RLS
gates продолжают закрывать обучение.

Шаблоны email для password recovery и legacy invite — статические уведомления
без token, hash, redirect URL или password reset promise. Они остаются явной
защитой на случай случайного обращения к стандартным Auth endpoints; единственные
шаблоны, которым разрешён `{{ .Token }}`, — login и registration OTP.

После первой OTP-сессии пользователь отдельно принимает текущие Политику и
Условия. Принятие записывается только в `legal_acceptances` через
`accept_current_legal_documents`; клиентский intent из OTP-запроса не считается
согласием. `legal_document_versions` содержит только immutable copies: новые
материальные тексты публикуются новой forward-only migration, а уже принятые
версии остаются доступны по versioned URL.

После заполнения профиля сервер переводит участника в `pending` и фиксирует
24-часовой ориентир ответа. До `approved` серверно закрыты PDF, learner payload,
создание/возобновление/оценивание попытки и выдача сертификата. Администратор
принимает решение в capability-gated очереди; номер телефона доступен ему только
для ручной связи и никогда не отправляется в SMS-провайдера.

Очередь сортируется по `(approval_due_at, user_id)` и возвращает cursor последней
видимой строки, а не look-ahead строки: следующий запрос не пропускает заявку на
границе страниц. Решение хранит idempotency receipt на 24 часа. Перед replay RPC
под advisory lock блокирует только receipt точной пары `(actor_user_id,
idempotency_key)`, синхронно удаляет его, если он истёк, и заново читает live
receipt; корректность не зависит от периодического cleanup worker. Профильная
заявка сначала берёт `account_controls FOR UPDATE`, затем `profiles FOR UPDATE` —
в том же направлении, что approval-gated course access, чтобы не формировать
обратный row-lock цикл с началом попытки.

## Turnstile и PWA

Cloudflare Turnstile загружается только после submit защищённой формы. Используется
один нативный Managed widget с `execution: execute`; токен продолжает ровно один
отложенный submit и сбрасывается после ошибки, истечения или использования.
Supabase Auth выполняет единственную Siteverify-проверку через server-only
`SUPABASE_AUTH_CAPTCHA_SECRET`; приложение проверяет наличие токена и передаёт его
в `signInWithOtp`, но не пытается повторно использовать одноразовый token.
Production widget ограничивается canonical hostname в Cloudflare, а coarse IP
rate limit применяется до вызова provider.

Тема управляется одной runtime-функцией: класс, `color-scheme`, `theme-color` и
фон `html/body` переключаются согласованно. Цвета оболочки — `#f7f8fa` для светлой
темы и `#0d0f12` для тёмной. `viewport-fit=cover` и фон документа окрашивают верхний
и нижний safe area установленной PWA.
