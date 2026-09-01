# Контент и база данных SAFETYHUB

Этот документ описывает обязательный рабочий процесс для схемы Supabase, курсов, тестов, статей и presentation assets. Он нужен, чтобы hosted-проект и локальный репозиторий не расходились между чатами и релизами.

## Источники истины

| Область                                 | Источник истины                     | Локальный эквивалент                  |
| --------------------------------------- | ----------------------------------- | ------------------------------------- |
| Таблицы, RPC, RLS, grants, индексы      | Git migrations                      | `supabase/migrations/`                |
| Generated TypeScript-схема базы         | Supabase CLI                        | `lib/supabase/database.generated.ts`  |
| Прикладные алиасы и JSON/RPC-контракты  | Код приложения                      | `lib/supabase/types.ts`               |
| Опубликованные курсы и статьи           | Admin application / hosted Supabase | `content/snapshots/`                  |
| Опубликованные локализации RU/KK/EN/ZH  | Admin application / hosted Supabase | `content/snapshots/localizations/`    |
| PDF, миниатюры и публичные медиа статей | Supabase Storage                    | assets в snapshot + SHA-256 manifests |
| Пользователи и история                  | Hosted operational database         | не экспортируются                     |

Таблица `public.tests` исторически является master-таблицей курса. В продуктовой модели и TypeScript она называется `Course`; физическое имя сохраняется ради безопасной совместимости.

## Запрещённые действия

- Не выполнять ручной SQL в Supabase Dashboard.
- Не редактировать уже применённые миграции.
- Не перезаписывать опубликованный Storage object по прежнему пути.
- Не помещать правильные ответы или staging paths в `public/` либо клиентский payload.
- Не копировать production users, attempts, certificates, identities или audit в snapshot.
- Не выполнять destructive push без зашифрованной проверенной резервной копии.

## Локальный Supabase

Требуется Docker Desktop или совместимый Docker/Podman runtime. Проект использует PostgreSQL 17.

```powershell
npx supabase start
npm run db:reset
npm run db:types:generate:local
npm run db:types:check:local
npm run check:db-types
npm run test:db
```

`npm run db:reset` после SQL seed создаёт оба presentation Storage bucket через
Storage API и загружает пять content-addressed PDF/миниатюр, а также все
опубликованные WebP статей из snapshot в соответствующие локальные bucket.
Служебную схему Storage seed напрямую не изменяет.

Если Docker недоступен, эти проверки должны пройти в CI или в disposable окружении до production-релиза. Отсутствие Docker не является разрешением пропустить DB gate.

## Изменение схемы

1. До backup/apply доказать точный reviewed delta командой
   `npm run db:migrations:check-preflight -- --expected-project-ref <ref>`.
   Для релиза RU/KK/EN/ZH команда принимает только существующий hosted-prefix
   из 39 migrations и точный закреплённый хвост из 17 файлов с проверенными
   SHA-256. Обычный `db:migrations:check-linked` и exact
   `npm run db:types:check` обязательны после применения migrations.
   Это release-specific approval record, а не открытое правило для всех будущих
   migrations: если до apply добавлена ещё одна reviewed migration, до нового
   запуска preflight нужно явно обновить `REVIEWED_PENDING_MIGRATIONS` (filename
   и normalized SHA-256), exact count/test и release review. Нельзя ослаблять
   gate так, чтобы он принимал произвольный дополнительный хвост.
2. Создать новую timestamped forward-only migration.
3. Добавить constraints, RLS, grants и SQL contract/security tests.
4. Выполнить локальный reset.
5. После локального reset обновить exact generated schema:
   `npm run db:types:generate:local`.
6. Проверить exact parity: `npm run db:types:check:local`. После linked push
   дополнительно выполнить `npm run db:types:generate` и
   `npm run db:types:check` против hosted schema.
7. Запустить `npm run test:db`, затем `npm run verify`.
8. Перед linked push сделать backup по `docs/backup-restore.md`.

## Изменение курса, теста или статьи

1. Проверить синхронность read-only командой с явно указанными текущим project ref
   и pinned PostgreSQL CA:
   `npm run content:parity:check -- --expected-project-ref <ref> --ssl-root-cert <absolute-ca.pem> --ssl-root-cert-sha256 <sha256>`.
   Если reviewed multilingual migrations ещё не применены и локализационные
   таблицы отсутствуют полностью, `--check` автоматически выполняет legacy RU
   preflight: сверяет закреплённый `catalogChecksum`, точные totals
   `5/5/198/15/150/600/10`, структуру `3 × 10 × 4`, policy `7/15/8/Asia/Oral`
   и байты канонических course/article/media snapshots. Частично применённая
   схема и любой обычный `--pull` в legacy-режиме отклоняются.
2. Внести изменение через административный интерфейс.
3. Опубликовать новую immutable revision.
4. Выполнить
   `npm run content:pull:linked -- --expected-project-ref <ref> --ssl-root-cert <absolute-ca.pem> --ssl-root-cert-sha256 <sha256>`.
   Команда сначала собирает полный
   снимок и seed во временной директории и печатает diff, не изменяя канонический
   snapshot до этого момента.
5. Если опубликован новый PDF или новая миниатюра, команда завершится в режиме
   `approval-required` и выведет `qaRoot`. Просмотреть все PNG страниц и все
   контактные листы в этой директории.
6. Для тех же неизменившихся hosted-хешей повторить
   `npm run content:pull:linked -- --visual-qa-approved --expected-project-ref <ref> --ssl-root-cert <absolute-ca.pem> --ssl-root-cert-sha256 <sha256>`.
   Флаг принимается только
   при наличии созданной предыдущим запуском pending QA-квитанции для точного
   набора PDF и миниатюр.
7. Проверить напечатанный diff и diff Git после атомарной замены snapshot.
8. Запустить `npm run content:snapshot:validate`, затем повторить точную linked
   parity-команду из шага 1.
9. Закоммитить snapshot вместе с ожидаемыми hashes.

Для исходного импорта 25 августа 2026 года дополнительно запускается
`npm run content:initial-import:validate`. Этот отдельный gate фиксирует пять
утверждённых slug, 198 страниц, исходные SHA-256 и матрицу 15 вариантов. Обычный
`content:snapshot:validate` остаётся динамическим и не ограничивает число будущих
курсов.

### Первоначальная публикация в пустой hosted-проект

После создания первого администратора первоначальный каталог публикуется только
server-only командой `content:initial-import`. Команда требует точный project ref,
UUID администратора, утверждённый `catalogHash` и буквальное подтверждение,
содержащее оба значения:

```powershell
npm run content:initial-import -- `
  --project-ref <project-ref> `
  --actor-id <admin-user-uuid> `
  --catalog-hash 11b5486025cbb94c02ea0ed021ce8a8afc3f1e4c997c9cccbf5497e8fb42c026 `
  --confirm INITIAL-IMPORT:<project-ref>:11b5486025cbb94c02ea0ed021ce8a8afc3f1e4c997c9cccbf5497e8fb42c026
```

`NEXT_PUBLIC_SUPABASE_URL` обязан указывать именно на переданный project ref, а
`SUPABASE_SECRET_KEY` читается только процессом команды. Workflow перед первой
записью проверяет пустой каталог и отсутствие попыток, аттестаций и сертификатов.
PDF и WebP сначала загружаются в приватный staging bucket, затем проверяются и
публикуются в приватный bucket по неизменяемым content-addressed путям. Пять
draft-курсов связываются с управляемым catalog batch и активируются одной
транзакцией после проверки counts и `catalogChecksum`.

Все фазы идемпотентны: после сетевого сбоя повторяется та же команда. Она не
читает и не экспортирует пользователей, профили, согласия, сессии или аудит и не
печатает ключи ответов. Безопасная pre/post-квитанция без секретов и персональных
данных по умолчанию сохраняется под `tmp/initial-import/`; другой путь задаётся
через `--receipt`. Staging-объекты удаляются только после успешной активации и
повторной проверки immutable published objects.

Snapshot сериализуется детерминированно: стабильный порядок курсов, вариантов, вопросов, ответов и JSON-ключей, LF-переводы строк и завершающий newline.

## Воспроизведение исходного импорта материалов

Это одноразовый операторский конвейер для утверждённой партии от 25 августа
2026 года. Обычные дальнейшие правки выполняются через админку и
`content:pull:linked`; исходные PPTX этой командой не перезаписываются.

Предварительные условия: исходники находятся вне репозитория, доступен Microsoft
PowerPoint для точного PDF-экспорта, а bundled workspace runtime для презентаций,
документов и PDF загружен в текущую Codex-сессию. Внешнюю папку всегда передавать
через `-LiteralPath`/аргумент, не копировать операторские оригиналы в `public/`.

```powershell
$materials = 'C:\Users\oatmeal\Desktop\sh\Готовые материалы'

python scripts/course-content/verify-derived-presentations.py `
  --source-dir $materials `
  --manifest content/source-materials/derived/manifest.json

powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/course-content/export-presentations.ps1

node scripts/course-content/render-and-verify-pdfs.mjs
# Просмотреть указанный qaRoot, затем зафиксировать visual approval:
node scripts/course-content/render-and-verify-pdfs.mjs --visual-qa-approved
python scripts/course-content/verify-pdf-safety.py --record

python scripts/course-content/extract-tests.py `
  --docx (Join-Path $materials '06_Тестовые_задания.docx') `
  --source-dir $materials

npm run content:initial-import:validate
npm run content:seed:generate
node scripts/course-content/verify-seed-snapshot.mjs
```

`edit-presentations.mjs` выполняет только утверждённую замену CTA и очистку
speaker notes в рабочей копии, а `verify-derived-presentations.py` независимо
проверяет source SHA, темы, количество слайдов и отсутствие иных изменений
видимого текста. PDF-валидатор читает перечень презентаций и ожидаемое число
страниц из `catalog.json`, а при чистом первоначальном импорте — из derived
manifest; в нём нет списка пяти slug или page counts, зашитого в код. Проверка
точного состава первоначальной партии и её утверждённого CTA остаётся только в
отдельном gate `content:initial-import:validate`.

Перед флагом `--visual-qa-approved` оператор обязан просмотреть все PNG страниц
и контактные листы под `tmp/course-materials/pdf-render/<slug>/`;
`tmp/` является локальной QA-доказательной базой и не коммитится. Итоговые
квитанции проверки страниц остаются в `presentation-manifest.json`.

Если любой source SHA отличается, конвейер останавливается. Нельзя автоматически
«принять» новый хеш: изменившийся исходник сначала проходит новый содержательный
аудит и получает отдельное утверждение.

## Замена презентации

1. Подготовить PDF без пароля, JavaScript actions, launch actions и вложений.
2. Ограничения: `application/pdf`, до 25 MiB, от 1 до 200 страниц.
3. В админке запросить signed upload token.
4. Загрузить файл напрямую resumable TUS upload в `course-presentations-staging`.
5. Дождаться серверной проверки PDF, SHA-256 и миниатюры.
6. Сохранить черновик и проверить preview.
7. Опубликовать новую редакцию курса.
8. Синхронизировать snapshot. Старый CDN object только помечается retired и удаляется отдельной orphan-cleanup операцией после проверки ссылок.

Успешная финализация удаляет staging-объекты сразу. Зависшие, отклонённые или
прерванные загрузки старше 24 часов забирает service-role-only lease RPC, а
`storage-reconciler` удаляет байты через Storage Admin API и только затем очищает
метаданные. Прямое удаление строк `storage.objects` запрещено.

## Проверка parity

`npm run content:parity:check` сравнивает локальные базовый и four-locale snapshot
с hosted read model. Команда требует явные `--expected-project-ref` и
`--ssl-root-cert`; необязательный `--ssl-root-cert-sha256` фиксирует точный CA-файл.
`npm run content:pull:linked` скачивает hosted-объекты только во временную область,
сверяет SHA-256 и строит безопасный список diff до записи в канонические пути.
Новый или изменённый PDF автоматически проверяется на опасные actions и вложения,
разбирается PDF.js, полностью рендерится по одной странице, получает текстовый QA
receipt и динамические контактные листы. Публичная миниатюра также проверяется как
ограниченный 16:9 WebP. До ручного просмотра всех страниц и повторного запуска с
`--visual-qa-approved` файлы snapshot и `supabase/seed.sql` не изменяются.

Перед применением команда строит полный staged snapshot курсов, статей, всех
current RU/KK/EN/ZH course/article/variant localizations, полного legal ledger,
15 target-locale PDF/WebP presentation pairs и только тех WebP из `content-media`,
на которые ссылаются опубликованные статьи,
генерирует staged seed и запускает динамический snapshot validator. После preview
готовые директории и seed заменяются одной rollback-safe операцией; ошибка любого
шага возвращает прежние пути. `content/snapshots/media/manifest.json` и
`content/snapshots/localizations/manifest.json` входят в детерминированный снимок.
Localized manifest связан с финальным independent-review batch hash, проверяет
ровно четыре локали каждой current сущности, stable question/option topology и
content-addressed hashes/bytes всех 15 assets. Режим `--check` ничего не пишет в канонический snapshot
и завершается ненулевым кодом при любом расхождении.
Команда читает только текущие опубликованные ревизии
курсов и статей, локализации presentation/вариантов/articles/legal, presentation
metadata, базовые private answer mappings для существующего RU seed и метаданные
используемых публичных assets. Localized projection и manifest никогда не включают
answer mappings; таблицы пользователей, профилей,
попыток, сертификатов, согласий и аудита не запрашиваются.

Ожидаемый текущий контракт каталога:

- 5 опубликованных курсов;
- 5 текущих редакций;
- 15 вариантов;
- 150 вопросов;
- 600 вариантов ответа;
- presentation page counts `25/31/42/59/41`;
- policy `7/10`, `15` минут, `8` попыток, `Asia/Oral`.

## Seed и восстановление

`npm run content:seed:generate` строит детерминированный локальный SQL seed из
snapshot, включая метаданные опубликованных WebP статей. После controlled Stage 6
publication он также воспроизводит current course/article/variant localizations,
полный legal ledger и current legal pointers из валидированного localized
manifest; конфликт immutable revision/hash завершает seed ошибкой. Число будущих
курсов и статей берётся из базового snapshot и не зафиксировано текущими значениями
5 и 10, а Stage 6 receipt отдельно фиксирует границу первой партии.
`npm run content:assets:seed:local` идемпотентно загружает пять RU и 15
target-locale presentation PDF/thumbnail pairs и публичные WebP статей, а при
существующем immutable path сначала сверяет фактический SHA-256. Production никогда
не обновляется запуском seed; hosted content публикуется через админку или явно
подтверждённую server-side batch/catalog activation operation.

## Destructive catalog cutover

1. Убедиться, что пять staged-курсов и PDF имеют ready status, и вызвать
   `POST /api/admin/course-catalog/prepare` до maintenance.
2. Подготовить в админке, но пока не публиковать, четыре редакции статей с
   заменёнными ссылками на `biot`/`pozharnaya-bezopasnost`.
3. Сверить prepared batch с локальным утверждённым snapshot: порядок slug,
   каждый `expected_content_hash`, PDF SHA-256/page counts и общий
   `catalogChecksum`:

   ```powershell
   npm run content:catalog-batch:check -- --batch-id <prepared-batch-uuid>
   ```

   Продолжать можно только при exit code `0` и JSON `ok: true`. Warning о
   несовпадающем SHA нового, но валидного 16:9 WebP требует визуальной проверки;
   любой `drift` блокирует cutover.
4. Включить maintenance через `POST /api/admin/course-catalog/maintenance` и
   повторно сверить project ref, users/profiles и фактические counts. Maintenance
   блокирует новые попытки и course mutations, но не является глобальным write
   freeze: дождаться отсутствия неистёкших started-attempts и исключить
   параллельные auth/profile/avatar/export-мутации.
5. Сделать новый encrypted custom-format `pg_dump` с portable recovery key,
   отдельный encrypted byte-backup приватного avatar bucket и Storage manifest.
6. Проверить расшифровку обоими recovery-путями, archive lists, restore rehearsal,
   размеры и SHA-256 backup. Пока maintenance остаётся включённым, повторить
   `content:catalog-batch:check` непосредственно перед activation: отдельные
   PostgREST SELECT и Storage downloads не образуют repeatable-read snapshot.
7. Заранее сохранить один idempotency key и вызвать
   `POST /api/admin/course-catalog/activate` с подготовленным batch ID. При
   timeout/5xx повторять только ту же пару batch/key; новый ключ после
   неоднозначного ответа запрещён. Если шаг неуспешен, maintenance не выключать.
8. Под maintenance сверить users/profiles до/после, exact counts
   `5/5/15/150/600`, пустую старую учебную историю, PDF и checksum. Только затем
   опубликовать четыре подготовленные редакции статей и проверить новые ссылки.
9. Так как maintenance намеренно блокирует создание новой попытки, выполнить под
   ним весь read-only smoke, затем явно выключить maintenance и немедленно
   выполнить learner smoke: start/resume/complete/certificate. При ошибке снова
   включить maintenance до rollback-решения.
10. Выполнить двухфазный `content:pull:linked`, просмотреть `qaRoot`, повторить с
   `--visual-qa-approved`, затем проверить parity и закоммитить hosted receipt.
11. Только после успешного smoke очищать staging и подтверждённые orphan objects.

Rollback схемы выполняется новой forward migration. Восстановление destructive data выполняется только из проверенной backup-точки и сначала репетируется в disposable-проекте.
