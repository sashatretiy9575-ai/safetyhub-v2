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
- Recovery OTP: 6 цифр, срок действия 3600 секунд, повторная отправка не чаще
  одного раза в 60 секунд.
- SMTP sender: `SafetyHub <no-reply@safetyhub.kz>` через
  `srv-plesk28.ps.kz:465`; не заменяйте provider-host на apex или `mail.safetyhub.kz`.
- Финальный Reset Password template берётся из `supabase/templates/recovery.html`:
  он содержит только `{{ .Token }}` и не содержит `{{ .ConfirmationURL }}`.
- Старый allow-list `https://safetyhub.kz/auth/callback?password_ticket=*` пока
  сохраняется только для уже отправленных recovery-ссылок; новый поток от него не зависит.
- При выкладке сначала временно добавьте код к прежнему шаблону, затем разверните
  приложение и после успешного code-flow smoke установите финальный code-only шаблон.

## Выкладка схемы и каталога

1. Зафиксируйте intended diff и успешный локальный gate.
2. Создайте свежий production database/Storage backup и проверьте receipt.
3. Примените forward-only совместимую миграцию: presentation/variant tables, новые
   столбцы, RLS, grants и RPC. Применение миграции само по себе не переключает и не
   удаляет каталог.
4. Создайте и проверьте два Storage bucket через Storage API:
   `course-presentations-staging` (private) и `course-presentations` (public read).
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

Нельзя выполнять вставки каталога вручную через Supabase Dashboard. SQL-транзакция
активации не включает Storage, поэтому все пять файлов обязаны иметь `ready` до
cutover. Полная процедура находится в `docs/content-and-database-workflow.md`.

## Production smoke

- apex отвечает 200, `www` — 308 на apex, TLS и canonical корректны;
- robots/sitemap содержат только production origin и актуальный контент;
- статья имеет единую desktop-ширину hero/TOC/body, mobile layout не переполняется;
- главная и каталог показывают ровно пять новых курсов;
- на странице каждого курса сначала видна кнопка «Скачать презентацию», затем
  «Начать тест»; все пять кнопок скачивают правильный PDF с ожидаемым именем;
- тест содержит 10 вопросов, пользовательский HTML/JSON не раскрывает номер или
  идентификатор варианта и правильные ответы;
- возобновление сохраняет вопросы и deadline, а девятая новая попытка по одному
  курсу до следующего 00:00 `Asia/Oral` получает `ATTEMPT_DAILY_LIMIT`;
- signup/login/recovery запускают один deferred Turnstile после submit;
- recovery проходит целиком как email → шестизначный код → новый пароль без
  перехода из письма; повторное использование кода отклоняется;
- черновик курса сохраняется до загрузки PDF, upload/finalize/preview/replace и
  публикация работают, не ломая прежнюю опубликованную ревизию;
- администратор видит три варианта, а участник — только назначенные вопросы;
- preview удаления учебной истории показывает точные counts; удаление на
  контролируемом участнике очищает попытки/аттестации/сертификаты, сохраняет его
  аккаунт и создаёт минимальный audit event;
- старый QR удалённого сертификата возвращает 404;
- светлая/тёмная PWA синхронизирует `theme-color` и safe areas;
- Vercel/Supabase logs не показывают новый рост 4xx/5xx или latency.

## Rollback

- До catalog cutover при ошибке приложения переназначьте production alias на
  предыдущий Ready deployment и не активируйте batch.
- Перед откатом приложения восстановите прежний recovery-шаблон со ссылкой;
  иначе старая версия не сможет завершить восстановление.
- Если additive migration не прошла, приложение и каталог не переключайте.
- После catalog cutover включите maintenance, сохраните аварийную копию новых
  попыток и восстанавливайте только проверенный backup в отдельном окружении.
  Ручной возврат отдельных строк и destructive down migration запрещены; для
  схемы используйте forward fix, для данных — утверждённый restore или отдельную
  контролируемую транзакцию переключения каталога.
- DNS откатывается только по сохранённому zone export и лишь при доказанной проблеме
  доменного контура, а не при обычной ошибке приложения.
- Старые Supabase callback URL можно оставить на ограниченное переходное окно.
