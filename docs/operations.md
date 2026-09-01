# Эксплуатация SafetyHub

## Ежедневный контроль

Проверяйте Vercel runtime errors, Supabase Auth/PostgREST errors, p95 ключевых RPC,
размер PostgreSQL и Storage, egress, CPU/RAM, соединения, рост attempts/audit и
очередь orphan assets. Повторяющиеся 5xx, рост неразобранных Storage operations или
долгие tombstones требуют остановить соответствующую запись/worker и расследовать
причину до ручного удаления данных.

Числа Auth/API в Supabase Dashboard показывают запросы, а не людей. Точное число
аккаунтов проверяется `count(*)` в `auth.users` и Auth Admin API. Оценка Studio
может брать `pg_class.reltuples`; после существенных изменений допустим безопасный
`ANALYZE auth.users`, без создания или удаления пользователей.

## Работа с контентом

- редактируйте курс или статью в черновике;
- используйте `Сохранить` для серверной контрольной точки;
- используйте `Опубликовать` для атомарного сохранения и публикации;
- перед удалением убедитесь, что выбран правильный объект и подтвердите единый
  destructive dialog;
- не удаляйте Storage-файлы вручную: один content-addressed asset может иметь
  несколько ссылок.

Удалённая статья должна отсутствовать в выдаче, sitemap и slug redirects. Удалённый
курс не должен принимать новые попытки. Сохранённые сертификаты проверяются и
скачиваются по-прежнему; PDF создаётся в браузере из авторизованных no-store
metadata и неизменяемых assets, а не на сервере.

## Locale shell и PWA

- Проверяйте `/`, `/kk`, `/en`, `/zh` и один вложенный URL каждой локали. RU не
  должен получать `/ru`, а `/zh/admin`, `/en/api/...` и locale-prefixed assets не
  должны становиться alias существующего ресурса.
- При проверке автоопределения очищайте только cookie `safetyhub-locale` и задавайте
  конкретный `Accept-Language`. Явный префикс должен иметь приоритет, cookie —
  приоритет над заголовком, неизвестный язык — возвращать RU.
- После добавления ключа обновите все четыре `messages/*.json`. Тест каталогов
  блокирует отсутствующий ключ, пустое значение или несовпадающий ICU parameter.
- Если в `messages/zh.json` появились новые иероглифы, пересоберите UI subset из
  официального Noto Sans SC variable TTF:
  `python scripts/subset-cjk-ui-font.py C:/path/to/NotoSansSC-VF.ttf`.
  Проверьте, что font остаётся self-hosted, меньше 500 KiB и preloaded только при
  `data-locale="zh"`.
- Проверяйте locale manifest `/manifest/{locale}` и offline shell
  `/offline/{locale}`. После изменения их контракта увеличьте версию
  `safetyhub-static-v*`, иначе установленная PWA может сохранить старый fallback.
- При диагностике локализованного protected route сначала сравните внешний URL с
  внутренним pathname после удаления locale prefix. Нельзя добавлять отдельный
  browser Supabase client или обходить общий `updateSession` ради локали.

## Клиентские сертификаты и export

- Ошибка `CERTIFICATE_PDF_CLIENT_ONLY` на старом `/api/certificates/{id}` —
  ожидаемый compatibility contract; актуальный интерфейс сначала запрашивает
  `/metadata`, затем запускает browser worker.
- Metadata endpoints обязаны оставаться `private, no-store`: 32 KiB для одного
  сертификата и 2 MiB для административного export до 500 строк.
- RU/KK/EN используют локальный Noto Sans Latin/Cyrillic/Kazakh asset. Полный ZH
  font Noto Sans CJK SC `Sans2.004` входит в deployment bundle, проверяется по
  размеру и SHA-256 и загружается только через один exact-query same-origin URL.
  Route не обращается к внешнему upstream и не допускает query aliases. Immutable
  content route дополнительно требует exact lowercase UUID pathname и отвергает
  uppercase, mixed-case и percent-encoded aliases до DB/Storage; сбой
  локального asset не должен приводить к server-side fallback-рендеру.
- В Chromium с File System Access API большой ZIP записывается потоком. В других
  браузерах export разбивается на части не более 100 сертификатов; это штатное
  поведение, а не потеря данных.
- При жалобе на скачивание сначала проверьте metadata JSON, template/font route,
  CSP `worker-src/connect-src 'self'`, свободную память вкладки и отмену задачи.
  Никогда не включайте обратно backend PDF/ZIP generation как оперативный обход.

## Storage reconciler

`storage-reconciler` — закрытая scheduled Supabase Edge Function. Она принимает
только `POST` с отдельным `STORAGE_RECONCILER_SECRET`, создаёт service-role клиент
только после проверки bearer и обрабатывает bounded batches. Secret хранится в
Supabase Functions secrets. Если расписание использует Supabase Cron и `pg_net`,
то же значение хранится в Supabase Vault и извлекается только во время вызова.
Секрет нельзя помещать прямо в cron SQL, Git, URL, monitoring labels или
`NEXT_PUBLIC_*`; service-role key остаётся только внутри Edge Function.

Worker удаляет только точные объекты, уже заявленные базой как orphan/delete
candidate, и повторно сверяет Storage. Ключ аватара обязан иметь точную форму
`{userId}/objects/{operationToken}.webp`. Перед окончательной очисткой аккаунта БД
требует 15-минутный grace period и два полных пустых сканирования с интервалом не менее двух минут,
а после удаления Auth-пользователя — ещё два таких сканирования.

Для аварийной остановки сначала отключается расписание.
Нельзя вручную удалять operation rows, tombstones, manifests или Storage prefixes:
они являются durable состоянием восстановления, и работа безопасно продолжится
после истечения lease.

## Секреты и ротация

Все серверные секреты должны содержать не менее 32 криптографически случайных
байт. При ротации `CERTIFICATE_VERIFICATION_SECRET` сначала установите новый
current и старый previous, разверните приложение и проверьте старые и новые QR.
После переходного окна удалите previous отдельной выкладкой.

`ZH_RECOVERY_PEPPER` хранится только в server runtime Vercel и должен содержать
не менее 32 случайных байт. Его нельзя менять как обычный deploy: существующие
initial recovery codes и admin re-enrollment codes после ротации перестанут
проверяться. Плановая ротация требует сначала выдать новые codes через reasoned
admin reset; аварийная ротация намеренно отзывает все ещё не использованные
codes. Значение нельзя помещать в `NEXT_PUBLIC_*`, логи, analytics или Supabase
таблицы.

Для WebAuthn production trust root неизменяем: RP ID `safetyhub.kz`, origin
`https://safetyhub.kz`. Preview deployment fail-closed; localhost разрешён
только не-production процессу на `localhost:3000` или `127.0.0.1:3000`.
`cleanup_required` и просроченный `cleanup_claimed` безопасно подхватываются
следующей ZH auth-операцией; для гарантированного обслуживания также вызывайте
service-only `claim_zh_registration_cleanup`/`finish_...` из планового bounded
maintenance job. Строки операций, Auth users и avatar objects вручную не
удаляйте.

При утечке Storage bearer одновременно обновите Function secret и Vault value,
затем проверьте, что старое значение получает отказ. Никогда не печатайте database
URI, service-role key, backup passphrase или персональные payload.

## OTP receipts и presentation leases

Email OTP receipt обслуживается только service-role RPC
`issue_email_otp_challenge`, `consume_email_otp_challenge_attempt`,
`complete_email_otp_challenge` и `prune_email_otp_challenges`. Не выдавайте
табличные grants на `private.email_otp_challenges` и не логируйте cookie, HMAC или
email. Плановый maintenance может вызывать bounded prune; expired receipt в любом
случае удаляется при следующем consume/issue. Шесть ошибок ограничивают только
один конкретный challenge, а не все попытки жертвы по email.

Защищённый relay презентации перед Storage download расходует actor/IP quota и
вызывает `claim_course_presentation_download_lease` с обычным TTL 90 секунд.
Контракт допускает максимум две активные передачи на actor и двенадцать глобально;
lease удерживается до EOF, cancel, timeout или ошибки, затем освобождается точной
парой `(leaseId, actorId)`. Не заменяйте его process-local semaphore. Crash
восстанавливается expiry: следующий claim под advisory lock удаляет просроченные
строки. Прямые grants на private lease table запрещены.

## Изменение схемы

## Поэтапные runtime-флаги релиза

Новые внешние поверхности имеют независимые server-only gates:

- `SAFETYHUB_LOCALE_ROUTES_ENABLED` — префиксы `/kk`, `/en`, `/zh`, switcher,
  localized sitemap/SEO/PWA;
- `SAFETYHUB_ZH_PASSKEY_ENABLED` — ZH registration/login/recovery и admin reset;
- `SAFETYHUB_ADMIN_INBOX_ENABLED` — UI и no-store API административного inbox.

В production/preview отсутствие значения и любое значение кроме точного `true`
оставляет поверхность закрытой. Включение выполняется отдельной reviewed
конфигурацией deployment в указанном порядке; секреты в эти значения не входят.
Перед включением локалей публикационный validator и parity обязаны быть зелёными.
Перед ZH gate должны совпадать WebAuthn RP/origin и текущие legal versions. Перед
inbox gate сначала разворачивается DB event contract, затем включается DB emission,
а Telegram delivery активируется отдельным последующим шагом.

DB-порядок задаётся service-only RPC `set_runtime_feature_flag` с обязательными
reason и новым idempotency UUID для каждого логического изменения:

1. `notification_events = true`;
2. smoke административного inbox;
3. `telegram_delivery = true`;
4. smoke приватной группы.

Отключение выполняется в обратном порядке. Прямые изменения private-таблицы,
повторное использование UUID с другими параметрами и включение Telegram раньше
event emission отклоняются контрактом БД.

RPC вызывается только через fail-closed operator CLI. В отдельном абсолютном,
не symlink, access-restricted env-file должна быть ровно одна assignment
`SUPABASE_SECRET_KEY`; значение не передаётся в argv и не выводится. Перед каждым
вызовом дважды задаётся один и тот же reviewed current production ref:

```powershell
$ProjectRef = '<CURRENT_PRODUCTION_PROJECT_REF>'
npm run runtime:flag:set -- `
  --expected-project-ref $ProjectRef `
  --confirm-project-ref $ProjectRef `
  --feature notification_events `
  --enabled true `
  --reason 'Enable notification events after release migration' `
  --idempotency-key '<NEW_UUID>' `
  --env-file 'C:\secure-operator\production-service.env'

npm run runtime:flag:set -- `
  --expected-project-ref $ProjectRef `
  --confirm-project-ref $ProjectRef `
  --feature telegram_delivery `
  --enabled true `
  --reason 'Enable Telegram after dispatcher smoke' `
  --idempotency-key '<ANOTHER_NEW_UUID>' `
  --env-file 'C:\secure-operator\production-service.env'
```

Rollback использует те же команды с новыми UUID: сначала
`telegram_delivery=false`, затем при необходимости
`notification_events=false`. UUID повторяется только для retry идентичного
запроса; receipt содержит ref/feature/state/timestamp/UUID, но не service key и
не reason.

Операционная подготовка RU/KK/EN/ZH content выполняется по
`docs/admin-localization-workflow.md`. Localized assessment bundle проверяется и
импортируется только offline service-командой; browser upload для него отсутствует.
Новые presentation objects всегда используют locale segment в immutable path.

1. Добавьте новую migration; уже применённые файлы не переписываются.
2. Выполните чистый local reset.
3. Обновите seed и generated Supabase types.
4. Запустите SQL contracts/security, TypeScript, lint, build и E2E.
5. Повторно проверьте RLS, grants, RPC и Supabase advisors.
6. Для destructive contract migration сначала сделайте backup и убедитесь, что
   совместимая версия приложения уже работает в production.
