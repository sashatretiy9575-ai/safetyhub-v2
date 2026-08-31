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
npm run check:db-types
npm run test:db
```

Reset должен применить migrations с нуля и сгенерированный `supabase/seed.sql`.
SQL contracts проверяют capabilities/grants, два lifecycle-статуса, прямую
публикацию, version conflicts, физическое удаление и сохранение certificate
snapshot. После изменения схемы обновите `lib/supabase/types.ts` из чистой базы.

## Локальные authenticated fixtures

`npm run seed:workspace` создаёт локальные admin/participant сценарии и набор
сотрудников. Скрипт отказывается от remote Supabase без явного test-only флага;
production использовать запрещено.

Для browser tests нужны `E2E_ADMIN_EMAIL`, `E2E_PARTICIPANT_EMAIL` и
`E2E_PASSWORD`. CI требует, чтобы authenticated сценарии не были skipped.

```powershell
npm run seed:workspace
npm run test:e2e:release
```

## Обязательные browser проверки

- статьи на 1440/1536/1920 px: hero, TOC и body имеют одну рабочую ширину 1120 px;
- карточки курсов на 320/390 px: фотография без встроенного текста читаема, а
  страница курса показывает полноширинные кнопки скачивания и начала теста;
- 240–280 px: нет page-level horizontal overflow;
- редакторы на 390 и 1440 px; sticky action bar не выше 64 px;
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
