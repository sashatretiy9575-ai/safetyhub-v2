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

1. Дважды сверьте linked Supabase project ref и окружение.
2. Создайте новый путь вне репозитория и выполните автоматический gate:

   ```powershell
   npm run db:backup:linked -- `
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
4. Проверьте `ok`, размеры, counts, encrypted receipt SHA-256 и агрегированный
   Storage manifest (`objects`, bucket counts/bytes и `objectSetSha256`). Полные
   Storage paths остаются только внутри зашифрованного `data.dump`.
5. В переносимой EDB-сборке без contrib локальная rehearsal использует безопасные
   сигнатурные заглушки `pgcrypto/pg_trgm` и пропускает только два trigram-индекса.
   Сам зашифрованный архив остаётся полным: функции и оба индекса восстанавливаются
   в Supabase/PostgreSQL с установленными `pgcrypto` и `pg_trgm`.
6. Храните каталог backup и файл recovery key на разных носителях/в разных
   контролируемых хранилищах. DPAPI-копия ключа удобна на текущей машине, но не
   заменяет переносимый recovery key при утрате Windows-профиля.

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
   В `--env-file` передайте абсолютный путь к защищённому локальному файлу со
   старым `SUPABASE_SECRET_KEY` (например, к уже существующему, неотслеживаемому
   `C:\Users\oatmeal\Desktop\SAFETYHUB\.env.local`). Копировать секрет в новый
   checkout или в командную строку не нужно. Ключ читается только из указанного
   env-file и не попадает в stdout, receipt или manifest.

   ```powershell
   npm run storage:backup:linked -- `
     --expected-project-ref vezgxdooijznpjqrpvcv `
     --allow-bucket content-media `
     --allow-bucket course-presentations `
     --allow-bucket course-presentations-staging `
     --allow-bucket profile-avatars `
     --output-dir 'C:\secure-backups\storage' `
     --env-file 'C:\Users\oatmeal\Desktop\SAFETYHUB\.env.local' `
     --recovery-key-output 'E:\offline-keys\storage-YYYYMMDD-HHMMSS.recovery-key.txt'
   ```

4. Команда создаёт новый `safetyhub-storage-byte-backup-...` под output-каталогом.
   В нём остаются только encrypted archive, encrypted manifest, локальная
   DPAPI-копия archive passphrase, key-recovery receipt и aggregate receipt. Object
   keys, ETag, metadata и bytes находятся только в AES-256-GCM encrypted archive
   и manifest. Portable recovery key лежит отдельно.
5. Сразу выполните portable verification, не обращаясь к Supabase:

   ```powershell
   npm run storage:backup:verify -- `
     --backup 'C:\secure-backups\storage\<run-directory>' `
     --expected-project-ref vezgxdooijznpjqrpvcv `
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

## Restore/rollback цели

Предыдущий Ready deployment Vercel — быстрый rollback приложения. Ошибки схемы
исправляются forward migration; destructive down migration запрещена. RPO — свежая
точка непосредственно перед миграцией. Фактический RTO зависит от доступности
Supabase, размера дампа и завершённого rehearsal.
