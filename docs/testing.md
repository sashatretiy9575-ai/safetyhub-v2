# Тестирование SafetyHub

## Application gate

```powershell
npm run check:security
npm run check:contacts
npm run check:config
npm run lint
npm run type-check
npm test
npm run build
npm run check:bundles
npm audit --audit-level=moderate
npm audit signatures
```

`npm run verify` выполняет этот набор последовательно. Он не заменяет SQL и
authenticated browser checks.

## Database gate

Docker Desktop и локальный Supabase должны быть запущены.

```powershell
npm run db:reset
npx supabase db lint --local --level error
npm run db:types:check:local
npm run check:db-types
npm run test:db
```

Reset должен применить migrations с нуля и сгенерированный `supabase/seed.sql`.
SQL contracts проверяют capabilities/grants, два lifecycle-статуса, прямую
публикацию, version conflicts, физическое удаление и сохранение certificate
snapshot. `db:types:check:local` сравнивает закоммиченный
`lib/supabase/database.generated.ts` с точным выводом CLI из этой чистой базы;
после изменения схемы сначала сгенерируйте и проверьте типы, затем обновите
`lib/supabase/types.ts`.

## Локальные authenticated fixtures

`npm run seed:workspace` создаёт локальные admin/participant сценарии и набор
сотрудников. Скрипт отказывается от remote Supabase без явного test-only флага;
production использовать запрещено.

В localhost-режиме release runner использует только уже подтверждённые fixture
аккаунты из `seed:workspace`: локальный service key создаёт одноразовый
email OTP через Auth admin API, Supabase проверяет его через `verifyOtp`, а `@supabase/ssr`
собирает две временные HttpOnly Playwright state files. Они создаются в системной
временной папке, передаются только рабочим процессам Playwright и удаляются после
прогона. Ни пароль, ни password endpoint, ни значение cookie в environment не
используются. CI требует, чтобы authenticated сценарии не были skipped.

```powershell
npm run seed:workspace
npm run test:e2e:release
```

Для remote preview/staging локальный service bootstrap намеренно запрещён: он
никогда не должен выпускать session для удалённого проекта. Сначала завершите
настоящий вход по шестицифровому email OTP в контролируемый fixture mailbox и
создайте по одному state-файлу для admin и participant. Скрипт открывает
видимый Chromium, запускает login OTP и ждёт, пока оператор вручную пройдёт
Turnstile и введёт код из SMTP-письма; mailbox, код и cookie в stdout не
читаются.

```powershell
$stateRoot = Join-Path $env:TEMP 'safetyhub-e2e-states'
New-Item -ItemType Directory -Force $stateRoot | Out-Null
npm run e2e:otp-state -- --email <admin-fixture-email> --role admin --output "$stateRoot/admin.json"
npm run e2e:otp-state -- --email <participant-fixture-email> --role participant --output "$stateRoot/participant.json"
$env:E2E_ADMIN_STORAGE_STATE = "$stateRoot/admin.json"
$env:E2E_PARTICIPANT_STORAGE_STATE = "$stateRoot/participant.json"
npm run test:e2e:release
```

State files содержат HttpOnly refresh/session cookie, поэтому они обязаны быть
абсолютными путями вне репозитория и secret mount в CI. Runner отбрасывает
localStorage, все посторонние cookies и source-domain атрибуты; принимает только
project-scoped Supabase auth cookie, перед запуском пересобирает временную
минимальную state file и удаляет её. Не сохраняйте эти файлы как artifact и
удаляйте исходные файлы после smoke. `--replace` у capture-команды используйте
только для осознанного обновления истёкшей сессии.

## Обязательные browser проверки

- статьи на 1440/1536/1920 px: hero, TOC и body имеют одну рабочую ширину 1120 px;
- карточки курсов на 320/390 px: фотография без встроенного текста читаема, а
  страница курса показывает полноширинные кнопки скачивания и начала теста;
- 240–280 px: нет page-level horizontal overflow;
- редакторы на 390 и 1440 px; sticky action bar не выше 64 px;
- при открытии существующего курса в DevTools network/HTML не появляются
  сохранённые варианты, correct option, пояснения или Storage path; editor
  показывает чистые три варианта и не создаёт course-draft в localStorage;
- Turnstile не загружается на open/focus/input, запускается после submit и
  продолжает pending action один раз;
- light/dark `theme-color`, `html/body` и верхний/нижний safe area;
- удаление статьи/курса, historical certificate download/revoke и запрет reissue;
- accessibility, keyboard/focus, hydration и console errors.

Viewport/visual matrix включает как минимум 240, 280, 320, 390, 768, 1024,
1120, 1280, 1440, 1536 и 1920 px. Обновляйте screenshot baselines только после
ручного просмотра обычного прогона.

Системный Home indicator и поведение status bar полностью проверяются только в
реально установленной iOS/Android PWA; Chromium viewport не является достаточным
доказательством.

## Release gate

`npm run verify:release` объединяет application, clean database, SQL contracts,
fixtures и authenticated Playwright. Production выкладывается только из точного
SHA с зелёным CI. Если локальный Docker недоступен, это не считается успешным
database gate: используйте CI или отдельный disposable Supabase и зафиксируйте
результат до production migration.
