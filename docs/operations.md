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
скачиваются по-прежнему.

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

При утечке Storage bearer одновременно обновите Function secret и Vault value,
затем проверьте, что старое значение получает отказ. Никогда не печатайте database
URI, service-role key, backup passphrase или персональные payload.

## Изменение схемы

1. Добавьте новую migration; уже применённые файлы не переписываются.
2. Выполните чистый local reset.
3. Обновите seed и generated Supabase types.
4. Запустите SQL contracts/security, TypeScript, lint, build и E2E.
5. Повторно проверьте RLS, grants, RPC и Supabase advisors.
6. Для destructive contract migration сначала сделайте backup и убедитесь, что
   совместимая версия приложения уже работает в production.
