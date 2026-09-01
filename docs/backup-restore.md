# Backup и restore SafetyHub

## Правила

- Свежая проверенная резервная точка обязательна перед production-миграциями и
  любым массовым/destructive изменением.
- Backup создаётся вне репозитория и синхронизируемой папки проекта.
- Plaintext dump удаляется только после проверки расшифровки, размера и SHA-256.
- Production dump никогда не восстанавливается поверх production для rehearsal.
- Не удаляйте attempts, certificates, audit, revisions или Storage objects как
  «тестовый мусор».

## Database backup

1. Задайте ожидаемый current production ref, дважды сверьте его с Dashboard и
   локальным link. Скачайте для этого проекта `Server root certificate` из
   Dashboard, сохраните PEM в защищённом operator-каталоге и отдельно запишите
   его SHA-256. Скрипт принимает только обычный, не symlink, действующий CA PEM.
2. Создайте новый путь вне репозитория и выполните автоматический gate:

   ```powershell
   $ProjectRef = '<CURRENT_PRODUCTION_PROJECT_REF>'
   $SslRootCert = 'C:\secure-operator\supabase-server-root-ca.crt'
   $SslRootCertSha256 = '<EXPECTED_LOWERCASE_CA_SHA256>'
   if ((Get-Content -LiteralPath 'supabase/.temp/project-ref' -Raw).Trim() -cne $ProjectRef) {
     throw 'Linked Supabase project does not match the reviewed production ref.'
   }
   npm run db:backup:linked -- `
     --expected-project-ref $ProjectRef `
     --ssl-root-cert $SslRootCert `
     --ssl-root-cert-sha256 $SslRootCertSha256 `
     --output 'C:\secure-backups\safetyhub-YYYYMMDD-HHMMSS' `
     --pg-bin 'C:\tools\postgresql-17\bin' `
     --recovery-key-output 'E:\offline-keys\safetyhub-YYYYMMDD-HHMMSS.recovery-key.txt'
   ```

3. Команда получает только краткоживущий linked login, читает `public`, `private`,
   `auth` и `storage` в одной `repeatable read, read only` snapshot, создаёт два
   custom-format архива `pg_dump` PostgreSQL 17, шифрует schema/data и тут же
   выполняет тестовую расшифровку через переносимый recovery key.
   Затем команда поднимает одноразовый локальный PostgreSQL 17, восстанавливает
   прикладные схемы `public/private`, сверяет число строк каждой таблицы и только
   после этого создаёт `verification.json`.
   Все linked PostgreSQL-соединения аутентифицируют сервер одним и тем же явно
   указанным CA: Node.js использует `rejectUnauthorized: true`, SNI и проверку
   имени хоста, а PostgreSQL 17/libpq запускается с принудительными
   `PGSSLMODE=verify-full` и `PGSSLROOTCERT=<validated physical PEM path>`.
   Bundled/system trust fallback отсутствует. Унаследованные `PG*` переменные
   процесса отбрасываются и не могут ослабить эти параметры.
4. Проверьте `ok`, точный `projectRef`, размеры, counts, encrypted receipt
   SHA-256, `postgresSslRootCertificate.sha256`/fingerprint/validity и
   агрегированный
   Storage manifest (`objects`, bucket counts/bytes и `objectSetSha256`). Полные
   Storage paths остаются только внутри зашифрованного `data.dump`.
5. В переносимой EDB-сборке без contrib локальная rehearsal использует безопасные
   сигнатурные заглушки `pgcrypto/pg_trgm` и пропускает только два trigram-индекса.
   Сам зашифрованный архив остаётся полным: функции и оба индекса восстанавливаются
   в Supabase/PostgreSQL с установленными `pgcrypto` и `pg_trgm`.
6. Рекомендуется хранить каталог backup и файл recovery key на разных
   носителях/в разных контролируемых хранилищах. Это операционная рекомендация,
   а не требование разных букв диска: инструмент допускает один диск, но требует
   физически раздельные новые пути. Он учитывает регистр Windows и раскрывает
   junction/symlink до существующих родителей через `realpath`; recovery key,
   plaintext dump и encrypted output не могут оказаться друг внутри друга.
   Не меняйте эти пути и их junction/symlink во время выполнения. DPAPI-копия
   ключа удобна на текущей машине, но не заменяет переносимый recovery key при
   утрате Windows-профиля.

Проверка расшифровки на текущем Windows-профиле:

```powershell
node scripts/restore-database-backup.mjs `
  --backup 'C:\secure-backups\safetyhub-YYYYMMDD-HHMMSS' `
  --output 'C:\secure-restore-test\dpapi'
```

Проверка переносимого восстановления на другой машине/профиле:

```powershell
node scripts/restore-database-backup.mjs `
  --backup 'C:\secure-backups\safetyhub-YYYYMMDD-HHMMSS' `
  --output 'C:\secure-restore-test\portable' `
  --recovery-key-file 'E:\offline-keys\safetyhub-YYYYMMDD-HHMMSS.recovery-key.txt'
```

`--output` должен указывать на новый отсутствующий каталог вне encrypted backup.
До его создания restore ограниченно и строго проверяет V1 `receipt.json`: форму
и размер receipt, допустимые поля, SHA-256 и целые размеры, уникальные без учёта
регистра имена обычных `.sql`/`.dump` файлов и фиксированный wrapped-key файл.
Имена с `/` или `\`, вложенными/dot/absolute/drive/UNC/device/ADS/control
формами, Windows reserved names либо завершающими точкой/пробелом отклоняются без
вывода опасного имени. Artifact, receipt и key-файлы должны быть обычными файлами,
не symlink/junction, и после `realpath` оставаться внутри backup; plaintext-файлы
после создания также проверяются внутри нового output.

Проверки выполняются повторно непосредственно перед чувствительными записями,
но Windows/Node.js не предоставляет этому скрипту единый атомарный `openat`-подобный
примитив для всей последовательности. Поэтому родительские каталоги backup,
output и recovery key должны быть доступны на запись только оператору; не
переназначайте junction и не меняйте ACL/пути параллельно с backup или restore.

## Полный byte-backup Supabase Storage

Один database dump сохраняет `storage.objects` metadata, но не байты файлов. До
удаления проекта обязательна отдельная зашифрованная выгрузка bytes **всех**
известных Storage bucket'ов:

```text
content-media
course-presentations
course-presentations-staging
profile-avatars
```

Экспортёр намеренно принимает только этот exact allowlist: нельзя тихо пропустить
staging bucket или добавить непроверенный bucket без нового ревью кода. Он делает
только `listBuckets`, `getBucket`, рекурсивный `list` и `download(...).asStream()`
с service key; если видимый inventory проекта отличается от этих четырёх bucket'ов,
он останавливается до скачивания. Upload, delete, move, copy и изменение bucket'ов
в нём отсутствуют.
Несмотря на историческое имя package script `storage:backup:linked`, он не
вызывает `supabase --linked`: URL вычисляется только как
`https://<--expected-project-ref>.supabase.co`.

1. Внешне остановите записи в старый проект на всё окно backup: включите
   maintenance/остановите старый deployment и дождитесь отсутствия параллельных
   profile, avatar, presentation и content mutations. Storage listing и downloads
   не образуют транзакционную cross-bucket snapshot сами по себе.
2. Создайте заранее существующий приватный каталог вне репозитория и sync-папок,
   например `C:\secure-backups\storage`. Recovery key храните отдельно, лучше на
   подключённом зашифрованном носителе. Корень recovery key не создаётся скриптом
   автоматически и не может лежать внутри output-каталога.
3. Выполните export **из чистого checkout**
   `C:\Users\oatmeal\Desktop\SAFETYHUB-v2`, где находится этот инструмент.
   В `--env-file` передайте абсолютный путь к защищённому локальному файлу с
   current production `SUPABASE_SECRET_KEY`. Копировать секрет в checkout или в
   командную строку не нужно. Ключ читается только из указанного env-file и не
   попадает в stdout, receipt или manifest.

   ```powershell
   $ProjectRef = '<CURRENT_PRODUCTION_PROJECT_REF>'
   npm run storage:backup:linked -- `
     --expected-project-ref $ProjectRef `
     --allow-bucket content-media `
     --allow-bucket course-presentations `
     --allow-bucket course-presentations-staging `
     --allow-bucket profile-avatars `
     --output-dir 'C:\secure-backups\storage' `
     --env-file 'C:\secure-operator\storage-backup.env' `
     --recovery-key-output 'E:\offline-keys\storage-YYYYMMDD-HHMMSS.recovery-key.txt'
   ```

   Если ключ доступен только через текущую Supabase Management API session,
   используйте вместо `--env-file` взаимоисключающий `--secret-stdin`. Команда
   ниже оставляет раскрытый current key только в памяти PowerShell, требует
   ровно один `type=secret`/`sb_secret_...` и передаёт в backup только raw value:

   ```powershell
   $ProjectRef = '<CURRENT_PRODUCTION_PROJECT_REF>'
   $ApiKeys = npx --no-install supabase projects api-keys `
     --project-ref $ProjectRef --reveal --output json | ConvertFrom-Json
   if ($LASTEXITCODE -ne 0) { throw 'Supabase API-key lookup failed.' }
   $SecretKeys = @($ApiKeys | Where-Object {
     $_.type -ceq 'secret' -and $_.api_key -cmatch '^sb_secret_[^\r\n]{22,}$'
   })
   if ($SecretKeys.Count -ne 1) { throw 'Expected exactly one current secret API key.' }
   $SecretKeys[0].api_key | npm run storage:backup:linked -- `
     --expected-project-ref $ProjectRef `
     --allow-bucket content-media `
     --allow-bucket course-presentations `
     --allow-bucket course-presentations-staging `
     --allow-bucket profile-avatars `
     --output-dir 'C:\secure-backups\storage' `
     --secret-stdin `
     --recovery-key-output 'E:\offline-keys\storage-YYYYMMDD-HHMMSS.recovery-key.txt'
   Remove-Variable ApiKeys, SecretKeys -ErrorAction SilentlyContinue
   ```

   Не запускайте lookup отдельно без pipeline и не сохраняйте его JSON в файл,
   transcript или shell history. `--secret-stdin` принимает не более 8 KiB,
   запрещает TTY/multiline input и никогда не выводит значение.

4. Команда создаёт новый `safetyhub-storage-byte-backup-...` под output-каталогом.
   В нём остаются только encrypted archive, encrypted manifest, локальная
   DPAPI-копия archive passphrase, key-recovery receipt и aggregate receipt. Object
   keys, ETag, metadata и bytes находятся только в AES-256-GCM encrypted archive
   и manifest. Portable recovery key лежит отдельно.
5. Сразу выполните portable verification, не обращаясь к Supabase:

   ```powershell
   npm run storage:backup:verify -- `
     --backup 'C:\secure-backups\storage\<run-directory>' `
     --expected-project-ref '<CURRENT_PRODUCTION_PROJECT_REF>' `
     --allow-bucket content-media `
     --allow-bucket course-presentations `
     --allow-bucket course-presentations-staging `
     --allow-bucket profile-avatars `
     --recovery-key-file 'E:\offline-keys\storage-YYYYMMDD-HHMMSS.recovery-key.txt'
   ```

6. Перед destructive action сравните:
   - `archivedObjects`, `archivedBytes` и per-bucket totals;
   - `objectSetSha256`: это SHA-256 от sorted `[bucket, key, listed size, ETag]`,
     поэтому при закрытом окне записи он должен совпасть с
     `storageManifest.objectSetSha256` database backup;
   - `downloadSetSha256`, archive SHA-256, authenticated manifest/archive и
     per-object SHA-256;
   - успешные exit code `0` и JSON `ok: true` у backup и verifier.

Инструмент честно ограничен объектами, видимыми через документированный Storage
listing API: он не доказывает отсутствие hidden backend versions, sidecars, retry
queues или уже удалённых физических объектов. Старый специализированный
`run-private-avatar-backup.mjs` можно сохранить как дополнительный forensic
инструмент для исторического исследования avatar metadata, но он не заменяет
all-bucket export для обычного восстановления.

## Restore rehearsal

Восстановление выполняется только в disposable/staging Supabase:

1. Создайте пустой совместимый проект с отключёнными внешними письмами/webhooks.
2. Примените migrations из точного release SHA.
3. Расшифруйте backup в контролируемую временную папку.
4. Восстановите `auth.users`, `auth.identities` и прикладные `public/private`
   данные; managed migration metadata, sessions и одноразовые токены не переносите.
5. Проверьте counts, FK, content hashes, current revision pointers, nullable
   historical certificate links и публичную certificate verification.
6. Прочитайте один курс, одну статью, одну попытку, обычный сертификат и сертификат
   отсоединённого курса, если такой fixture присутствует.
7. Сверьте Storage manifest и байты, не делая приватный bucket публичным.
8. Сохраните обезличенный receipt вне репозитория, затем удалите plaintext и
   disposable project.

All-bucket byte restore проверяется встроенным rehearsal harness. Он **никогда**
не предназначен для production: current и previous production refs жёстко
запрещены, target ref подтверждается второй раз, а Supabase Management API должна
вернуть для target точное имя `DISPOSABLE SECURITY TEST`. До первой загрузки
target обязан содержать ровно четыре ожидаемых bucket'а с совпадающей
конфигурацией и ноль видимых объектов.

В access-restricted target env-file должны быть ровно
`SUPABASE_SECRET_KEY` disposable-проекта и `SUPABASE_ACCESS_TOKEN` оператора:

```powershell
$ProjectRef = '<CURRENT_PRODUCTION_PROJECT_REF>'
$DisposableRef = '<DISPOSABLE_PROJECT_REF>'
npm run storage:restore:rehearse -- `
  --backup 'C:\secure-backups\storage\<run-directory>' `
  --expected-source-project-ref $ProjectRef `
  --allow-bucket content-media `
  --allow-bucket course-presentations `
  --allow-bucket course-presentations-staging `
  --allow-bucket profile-avatars `
  --target-project-ref $DisposableRef `
  --confirm-target-project-ref $DisposableRef `
  --confirm-disposable-project 'DISPOSABLE SECURITY TEST' `
  --env-file 'C:\secure-operator\disposable-storage-restore.env' `
  --recovery-key-file 'E:\offline-keys\storage-YYYYMMDD-HHMMSS.recovery-key.txt'
```

Harness сначала повторно аутентифицирует encrypted manifest/archive и SHA-256
каждого tar entry, затем извлекает их в новый OS temp-каталог. Только после этого
он дважды проверяет disposable marker, загружает с `upsert=false`, скачивает и
хэширует каждый объект, сверяет полный финальный inventory и удаляет весь
plaintext temp-каталог. При частичном сбое он намеренно не делает cloud delete:
пометьте весь disposable project скомпрометированным rehearsal и удалите его
через утверждённый owner workflow. Harness не восстанавливает database rows,
Storage metadata IDs/timestamps/ETag/cache policy и не является production
restore-процедурой; эти свойства проверяются отдельным database rehearsal и
application smoke.

## Restore/rollback цели

Предыдущий Ready deployment Vercel — быстрый rollback приложения. Ошибки схемы
исправляются forward migration; destructive down migration запрещена. RPO — свежая
точка непосредственно перед миграцией. Фактический RTO зависит от доступности
Supabase, размера дампа и завершённого rehearsal.
