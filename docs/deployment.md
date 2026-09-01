# Deployment и домен SafetyHub

## Текущее доменное состояние

- canonical origin: `https://safetyhub.kz`;
- apex обслуживается Vercel с валидным TLS;
- `https://www.safetyhub.kz` постоянно перенаправляется на apex;
- authoritative DNS остаётся на `ns1.ps.kz`, `ns2.ps.kz`, `ns3.ps.kz`;
- Cloudflare не управляет DNS-зоной и используется только для Turnstile.

Если Vercel показывает `Valid Configuration` и публичные проверки выше проходят,
менять PS.KZ DNS не нужно. Не трогайте MX, SPF, DKIM, DMARC и verification-записи
при обычной выкладке приложения.

## Auth email configuration

- Supabase Site URL: `https://safetyhub.kz`.
- Login и registration OTP: 6 цифр, срок действия 3600 секунд, повторная
  отправка не чаще одного раза в 60 секунд.
- SMTP sender: `SafetyHub <no-reply@safetyhub.kz>` через
  `srv-plesk28.ps.kz:465`; не заменяйте provider-host на apex или `mail.safetyhub.kz`.
- Перенесите из `supabase/config.toml` в новый hosted Supabase точные subjects и
  тела всех четырёх шаблонов. Только `magic_link` и `confirmation` содержат
  `{{ .Token }}`. `recovery` и `invite` — статические retirement notices без
  token, hash или redirect URL; не заменяйте их временно password-шаблоном.
- Supabase технически создаёт внутренний случайный hash и для первого native
  email-OTP signup; не проверяйте и не ограничивайте
  `auth.users.encrypted_password`. После применения
  `20260831115000_passwordless_auth_provider_guard.sql` и
  `20260831120000_auth_hook_public_schema_usage.sql` **сначала** примените
  Auth config из `supabase/config.toml`: второй migration даёт
  `supabase_auth_admin` только `USAGE` на схему `public`, необходимый для
  разрешения hook-функции (не доступ к таблицам или другим функциям). Custom
  Access Token Hook `public.enforce_email_otp_access_token` выдаёт JWT только для
  `email/signup`, `otp`, `magiclink` и `token_refresh`, а password/recovery/
  invite/OAuth/phone/anonymous session issuance получает `EMAIL_OTP_REQUIRED`.

## Выкладка схемы и каталога

1. Зафиксируйте intended diff и успешный локальный gate.
2. Создайте свежий production database/Storage backup и проверьте receipt.
3. Примените forward-only совместимую миграцию: presentation/variant tables, новые
   столбцы, RLS, grants и RPC. Применение миграции само по себе не переключает и не
   удаляет каталог.
4. Создайте и проверьте два Storage bucket через Storage API:
   `course-presentations-staging` (private) и `course-presentations` (private).
   У опубликованного bucket не должно быть public CDN read: PDF/миниатюра
   выдаются только через same-origin approval-gated route.
5. Откройте PR, дождитесь зелёного disposable-Supabase gate и проверьте Vercel
   Preview. Старый каталог должен продолжать работать до явной активации batch.
6. Разверните совместимое приложение, затем через административный flow создайте
   пять черновиков, загрузите и финализируйте пять PDF, импортируйте три варианта
   каждого теста, сформируйте catalog batch manifest и подготовьте четыре
   непубликованные редакции статей с новыми course links.
7. До maintenance сверьте prepared batch с утверждённым snapshot: пять
   `expected_content_hash` в порядке `1..5`, PDF SHA-256/page counts и checksum
   партии командой
   `npm run content:catalog-batch:check -- --batch-id <prepared-batch-uuid>`.
   Требуются exit code `0` и JSON `ok: true`; предупреждение о новом валидном
   thumbnail требует визуальной проверки, но не означает порчу PDF. Затем
   включите maintenance, убедитесь, что не осталось неистёкших
   started-attempts, и исключите параллельные auth/profile/avatar/export-мутации.
   Catalog maintenance сам по себе не является глобальным write freeze.
8. Повторите custom-format `pg_dump` с portable recovery key, byte-backup
   приватных avatars и сверку пользователей/профилей. После успешной проверки
   backup повторите read-only batch-check непосредственно перед activation
   (его PostgREST-чтения не являются одним repeatable-read snapshot), затем
   вызовите admin-only `activate_course_catalog_batch` с заранее
   сохранённым idempotency key. При неоднозначном HTTP-результате повторяйте
   только ту же пару batch/key.
9. Пока maintenance включён, сверьте `5` курсов, `5` текущих ревизий, `15`
   вариантов, `150` вопросов, `600` ответов, пустую старую учебную историю,
   checksum и неизменные user/profile ID. Только после успешной активации
   опубликуйте четыре подготовленные статьи и проверьте новые ссылки.
10. Выполните read-only smoke, явно выключите maintenance и сразу выполните smoke
    создания/возобновления/завершения попытки и сертификата. Если learner smoke
    падает, снова включите maintenance. Staging и публичные orphan objects
    очищайте отдельно только после подтверждения ссылок.
11. Выполните двухфазный linked content pull: первый запуск создаёт `qaRoot` без
    записи, после просмотра всех страниц повторите с `--visual-qa-approved`, затем
    проверьте parity и зафиксируйте snapshot.
12. После применения `20260831116000_retire_browser_editor_key_reads.sql` не
    используйте прежний editor-RPC для просмотра сохранённых вариантов. Карточка
    существующего курса передаёт в браузер только метаданные и безопасную сводку
    PDF; для новой редакции администратор заново вводит все 30 вопросов в памяти
    и отправляет их один раз через защищённую mutation route. Связанный
    service-role export snapshot остаётся единственным воспроизводимым
    server-only источником сохранённых ключей.

Нельзя выполнять вставки каталога вручную через Supabase Dashboard. SQL-транзакция
активации не включает Storage, поэтому все пять файлов обязаны иметь `ready` до
cutover. Полная процедура находится в `docs/content-and-database-workflow.md`.

## Первый администратор нового контура

После применения всех migrations и Auth config, но до ручной проверки очереди
заявок, будущий главный администратор один раз проходит обычный путь
`email → шестизначный код → legal acceptance`. Затем оператор с локально
заданным service key выполняет явный bootstrap:

```powershell
npm run admin:bootstrap -- --email <owner-email> --confirm-email <owner-email> --allow-remote
```

Команда требует два совпадающих email-аргумента, находит ровно одного уже
подтверждённого Auth-пользователя и через service-role RPC атомарно проверяет
все актуальные версии юридических документов перед выдачей роли. Если не
принята хотя бы одна актуальная версия, она безопасно завершается без выдачи
admin-доступа с кодом `BOOTSTRAP_ADMIN_LEGAL_ACCEPTANCE_REQUIRED`. Команда не
создаёт пользователя, не отправляет invitation, не принимает пароль и не
выводит email или ключи в консоль. `--allow-remote`
нужен специально для постоянного Supabase-проекта; без него команда безопасно
отказывается работать вне localhost. После успешного одноразового bootstrap
первый администратор открывает `/admin/approvals` и может принимать заявки.

### Release gate для bootstrap RPC

`20260831119000_bootstrap_admin_legal_gate.sql` добавляет RPC
`bootstrap_email_otp_admin`. После применения migration к доступному linked
project выполните `npm run db:types:generate` и закоммитьте точный вывод CLI в
`lib/supabase/database.generated.ts`. Не редактируйте этот generated-файл
вручную: DB-release остаётся незавершённым до обычных clean-reset,
type-contract и SQL regression проверок.

## Production smoke

- apex отвечает 200, `www` — 308 на apex, TLS и canonical корректны;
- robots/sitemap содержат только production origin и актуальный контент;
- статья имеет единую desktop-ширину hero/TOC/body, mobile layout не переполняется;
- главная и каталог показывают ровно пять новых курсов;
- на странице каждого курса сначала видна кнопка «Скачать презентацию», затем
  «Начать тест»; anonymous, pending и rejected запросы к PDF/thumbnail получают
  отказ и не получают Storage byte, а approved пользователь скачивает правильный
  PDF с ожидаемым именем и `Cache-Control: private, no-store`;
- тест содержит 10 вопросов, пользовательский HTML/JSON не раскрывает номер или
  идентификатор варианта и правильные ответы;
- возобновление сохраняет вопросы и deadline, а девятая новая попытка по одному
  курсу до следующего 00:00 `Asia/Oral` получает `ATTEMPT_DAILY_LIMIT`;
- registration/login запускают один deferred Turnstile после submit, используют
  единый auto-create native OTP flow и отправляют только шестизначный email OTP;
  recovery/invite templates не содержат секрета;
- native email OTP создаёт/подтверждает пользователя и получает сессию;
  внутренняя provider-запись password hash не считается пользовательским
  паролем; прямой password login, recovery и invite не получают SafetyHub JWT
  из-за Custom Access Token Hook;
- черновик курса сохраняется до загрузки PDF, upload/finalize/preview/replace и
  публикация работают, не ломая прежнюю опубликованную ревизию;
- при открытии существующего курса браузер администратора не получает
  сохранённые варианты, правильные ответы, пояснения или Storage paths; новая
  редакция начинается с пустых трёх вариантов и отправляет только свежий ввод,
  а участник получает только назначенные вопросы;
- preview удаления учебной истории показывает точные counts; удаление на
  контролируемом участнике очищает попытки/аттестации/сертификаты, сохраняет его
  аккаунт и создаёт минимальный audit event;
- старый QR удалённого сертификата возвращает 404;
- светлая/тёмная PWA синхронизирует `theme-color` и safe areas;
- Vercel/Supabase logs не показывают новый рост 4xx/5xx или latency.

## Rollback

- До catalog cutover при ошибке приложения переназначьте production alias на
  предыдущий Ready deployment и не активируйте batch.
- Не откатывайте Auth email templates к password recovery/invite ссылкам и не
  отключайте email-OTP Custom Access Token Hook: возврат к паролям требует отдельного
  согласованного security change, а не application rollback.
- Если additive migration не прошла, приложение и каталог не переключайте.
- После catalog cutover включите maintenance, сохраните аварийную копию новых
  попыток и восстанавливайте только проверенный backup в отдельном окружении.
  Ручной возврат отдельных строк и destructive down migration запрещены; для
  схемы используйте forward fix, для данных — утверждённый restore или отдельную
  контролируемую транзакцию переключения каталога.
- DNS откатывается только по сохранённому zone export и лишь при доказанной проблеме
  доменного контура, а не при обычной ошибке приложения.
- Старые Supabase callback URL можно оставить на ограниченное переходное окно.
