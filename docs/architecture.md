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

Публичные страницы имеют физические App Router сегменты: `/` — RU, а `/kk`,
`/en` и `/zh` — отдельные статические деревья, которые делегируют общий content
UI. `setRequestLocale` получает locale из route params, а не из `headers()`,
cookie или `Accept-Language`. Поэтому public HTML может быть ISR/CDN-объектом с
`revalidate = 300`; второй запрос не зависит от браузерной сессии. `proxy.ts`
сохраняет внешний pathname для этих страниц, выставляет CDN cache policy и не
вызывает Supabase `getUser()` на public GET.

Текущие Privacy/Terms и исторические адреса `/privacy/{version}`,
`/terms/{version}` (с теми же physical locale prefixes) — такие же статические
ISR-документы. Они читают только committed immutable receipt из `content/legal`
и `content/snapshots/localizations/manifest.json`, а не Supabase, `cookies()`,
`headers()` или `searchParams`. Старые ссылки `?version=` proxy сначала
перенаправляет на versioned URL с `private, no-store`; поэтому CDN никогда не
получает cookie- или query-зависимую legal HTML copy. Для версии без локального
receipt генерируется 404, кроме явно сохранённых ранних RU React renderers.

Для private/auth-entry URL `proxy.ts` по-прежнему разбирает префикс и передаёт
проверенные `x-safetyhub-locale` и `x-safetyhub-pathname` во внутреннее private
дерево. Поэтому `/zh/profile` и `/en/topics/{slug}/test` проходят тот же cookie
refresh, CSP nonce и authorization gate, что и непрефиксные private маршруты.
Locale-prefixed API/admin/asset URL не переписываются и завершаются 404.

Язык меняется только явным выбором из доступного dropdown: гость просто
переходит на соответствующий физический URL; client cookie
`safetyhub-locale` — неавторитетное удобство и не входит в server render/cache
key. Для сессии normal realm RU↔KK↔EN выполняется один server-authorized update
`profiles.preferred_locale`; смена между normal и ZH realm завершает локальную
сессию вместо переписывания профиля в другой realm.

Dropdown всегда показывает локальный SVG-флаг и полное имя языка, сохраняет
keyboard/focus/selected semantics Radix и не использует emoji как флаг. Assets
поставляет локальная зависимость `flag-icons` v7.5.0 (MIT, Flag Icons by Lipis);
её license остаётся в dependency package, а рядом с флагом всегда есть текстовая
доступная метка.

### Realm-bound locale transition

`preferred_locale` — только предпочтение отображения внутри уже разрешённого
credential realm, а не способ поменять метод входа. Контракт имеет два значения:
`email_otp` для `ru`/`kk`/`en` и `zh_username_password` только для `zh`.
Серверный источник истины для ZH — одновременно private
`zh_username_accounts` mapping и подписанный `safetyhub_auth_kind` в Auth
metadata; одно `preferred_locale` не делает обычный аккаунт китайским.

`private.assert_locale_matches_auth_realm` вызывается из смены preference,
locale-aware profile/presentation/attempt RPC и чтения/завершения уже созданной
попытки по её immutable locale. Он закрывает ручной PostgREST вызов даже если
клиентский URL или старая вкладка ошибочно сохранили cookie. При RU↔KK↔EN
остается одна сессия и один server-authorized update. При переходе между
normal и ZH realm приложение очищает только локальную сессию/устройство и
открывает нужный login; серверный аккаунт, обучение и сертификаты не удаляются.
`proxy.ts` повторяет эту проверку только на protected/auth-entry routes, не на
public GET, чтобы public cache не зависел от auth cookie.

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
загружают CJK asset. У документа есть корректный `lang`, `Content-Language`,
`translate="no"`, класс `notranslate` и Google `notranslate` meta: это подавляет
стандартный auto-translate, но не отменяет вручную включённый перевод браузера.

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
Сохранённый question bank администратору с правом `test.manage` теперь виден: при
открытии существующего курса сервер отдаёт тексты вопросов, варианты ответов,
отмеченный правильный ответ, пояснения и идентификаторы. Читает его отдельная узкая
функция `public.read_course_question_bank_v4`, которая проверяет право и актора,
пишет в `admin_audit_log` событие `course.question_bank_read` (только версия
черновика, content hash и счётчики — без текстов и без ключей) и возвращает банк
только тогда, когда `private.course_question_variants_valid` его принимает; иначе
редактор начинает с пустых трёх вариантов.

Это единственное послабление. Широкая `get_course_editor_payload_v3` остаётся
отозванной у всех ролей, потому что вместе с вопросами отдаёт неизменяемые пути
презентаций в Storage. Payload ученика ключей по-прежнему не содержит, редактор
локализаций получает только статусы и количества.

Затирание банка запрещено на уровне базы: триггер
`private.guard_course_draft_question_bank` под той же блокировкой строки отвергает
замену полного банка неполным с ошибкой `COURSE_QUESTION_BANK_MISSING`. Курс, у
которого банка ещё нет, сохраняется по-старому. Предыдущая опубликованная ревизия
сохраняется, пока новая не опубликована.

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
использует отдельный flow с латинским username и паролем; email, SMS и телефон
не являются фактором входа или восстановления. Номер в профиле во всех локалях
остаётся только контактным полем. Нативный Supabase email OTP технически создаёт
для нового пользователя внутренний случайный password hash, поэтому
`auth.users.encrypted_password` не является корректным признаком passwordless и
не блокируется database trigger.

`enforce_email_otp_access_token` работает как Supabase Custom Access Token Hook.
Для обычных аккаунтов access token выдаётся только для `email/signup`, `otp`,
`magiclink` и продолжения уже разрешённой сессии `token_refresh`. Для
server-mapped ZH identity он допускает только `password` и `token_refresh`,
когда включён DB receipt `zh_username_password`, аккаунт не заблокирован и
точный GoTrue `session_id` привязан к private ZH session record. Для ZH
провайдерский `@auth.invalid` адрес заменяется пустой строкой в обязательных
JWT email/phone claims и не входит в browser или admin projections. Request-time
gate повторно проверяет этот exact session binding; admin password reset сначала
отзывает все ZH sessions и блокирует mapping до успешного завершения смены
пароля. Legacy ZH WebAuthn mapping получает немедленный отказ, включая
уже выданные JWT. Любые неразрешённые password, recovery, invite, OAuth, phone
и anonymous методы получают отказ до выдачи JWT.
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

ZH registration создаёт provider account с server-generated `@auth.invalid`
identifier и сохраняет username-to-provider mapping только в private schema.
До username lookup, legal/Auth/profile write она проверяет отдельный первый
Turnstile token через server-only Cloudflare `Siteverify` с Vercel-only
`SAFETYHUB_TURNSTILE_SECRET_KEY`. Сама registration не переиспользует первый
одноразовый proof и не считает его session: клиент сразу получает новый
Turnstile proof и вызывает обычный GoTrue `signInWithPassword`, поэтому после
успеха открывается pending-approval state без ручного повторного ввода пароля.
Если новый proof недоступен, UI возвращает пользователя к обычному видимому
экрану входа. Неуспешный или недоступный verifier не выделяет provider identity
или mapping. В production/preview ответ
`Siteverify` дополнительно должен совпадать с hostname configured deployment.
Synthetic email, пароль, password hash, credentials и recovery data не входят в
browser payload, admin projections, Telegram, export, audit payload или analytics.
Публичный username принимается только в ZH auth request и не передаётся в
Telegram, admin projections, export или audit payload. Регистрация фиксирует
`preferred_locale = 'zh'` и переводит минимальный ZH profile прямо в pending:
email, телефон, имя, фамилия, avatar и обычный onboarding не требуются до
ручного approval. Existing approval/RLS gates продолжают закрывать обучение.
Исторические WebAuthn tables и routes остаются только для forward migration,
redaction и явного `410 ZH_AUTH_METHOD_RETIRED`; это не активный auth surface.

Шаблоны email для password recovery и legacy invite — статические уведомления
без token, hash, redirect URL или password reset promise. Они остаются явной
защитой на случай случайного обращения к стандартным Auth endpoints; единственные
шаблоны, которым разрешён `{{ .Token }}`, — login и registration OTP.

После первой OTP-сессии RU/KK/EN сервер фиксирует текущие Политику и Условия,
а ZH — при завершении username/password регистрации. Во входном UX это короткая
предвключённая строка со ссылками, а не отдельная тяжёлая legal-card; снятый
checkbox блокирует основное действие. Принятие записывается только в
`legal_acceptances`; клиентский intent из OTP-запроса не считается согласием.
`legal_document_versions` содержит
только immutable copies: новые материальные тексты публикуются новой forward-only
migration, а уже принятые версии остаются доступны по versioned URL.

Обычный email-OTP профиль после заполнения переводится в `pending` и получает
24-часовой ориентир ответа; минимальный ZH profile уже pending без обычного
onboarding. До `approved` серверно закрыты PDF, learner payload,
создание/возобновление/оценивание попытки и выдача сертификата. Администратор
принимает решение в capability-gated очереди; контактные поля normal profile
доступны только для ручной связи и никогда не отправляются в SMS-провайдера.

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
Для email OTP и ZH password login Supabase Auth выполняет Siteverify через
server-only `SUPABASE_AUTH_CAPTCHA_SECRET`; приложение проверяет наличие token
и передаёт его в `signInWithOtp` или `signInWithPassword`, но не пытается
повторно использовать одноразовый token. Отдельный ZH registration preflight
использует Cloudflare `Siteverify` в Vercel с
`SAFETYHUB_TURNSTILE_SECRET_KEY` до provisioning; это не Supabase config secret.
Production widget ограничивается canonical hostname в Cloudflare, server
preflight в production/preview сверяет hostname response с configured origin,
а coarse IP rate limit применяется до вызова provider.

Тема управляется одной runtime-функцией: класс, `color-scheme`, `theme-color` и
фон `html/body` переключаются согласованно. Цвета оболочки — `#f7f8fa` для светлой
темы и `#0d0f12` для тёмной. `viewport-fit=cover` и фон документа окрашивают верхний
и нижний safe area установленной PWA.
