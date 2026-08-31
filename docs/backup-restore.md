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

## Private Storage backup

1. Возьмите соответствующий `scripts/storage-*.config.example.json` как шаблон.
2. Подтвердите production ref отдельным аргументом CLI.
3. Запустите wrapper на доверенной машине и сохраните переносимый ключ отдельно:

   ```powershell
   node scripts/run-private-avatar-backup.mjs `
     --config scripts/storage-avatar-backup.config.example.json `
     --confirm-production-ref vezgxdooijznpjqrpvcv `
     --output-dir 'C:\secure-backups\avatars' `
     --env-file .env.local `
     --recovery-key-output 'E:\offline-keys\avatars-YYYYMMDD-HHMMSS.recovery-key.txt'
   ```

4. Проверьте manifest, число объектов, размеры, SHA-256 и обратную расшифровку.
5. Несколько объектов одного пользователя не являются основанием удалять любой из
   них без сравнения manifest и базы.

Проверка portable key выполняется независимо от DPAPI:

```powershell
node scripts/verify-private-avatar-backup.mjs `
  --backup 'C:\secure-backups\avatars\<run-directory>' `
  --expected-project-ref vezgxdooijznpjqrpvcv `
  --recovery-key-file 'E:\offline-keys\avatars-YYYYMMDD-HHMMSS.recovery-key.txt'
```

Content media адресуется SHA-256 и восстанавливается по той же схеме: database
metadata и Storage bytes должны относиться к одной backup-точке.

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
