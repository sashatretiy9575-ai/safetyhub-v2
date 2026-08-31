# SafetyHub

SafetyHub.kz — русскоязычная PWA-платформа для обучения, тестирования и выдачи
проверяемых сертификатов по охране труда, промышленной и пожарной безопасности.
Приложение построено на Next.js 16, React 19 и Supabase.

## Локальный запуск

Нужны Node.js 24, npm 11 и Docker Desktop для локального Supabase.

```powershell
npm ci
Copy-Item .env.example .env.local
npx supabase start
npm run db:reset
npm run db:types
npm run dev
```

После `supabase start` перенесите локальные URL и ключи в `.env.local`. Приложение
открывается по адресу `http://localhost:3000`. `db:reset` удаляет данные только в
локальном Supabase; не запускайте его для production.

## Переменные окружения

Полный безопасный шаблон находится в `.env.example`. Основные группы:

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SECRET_KEY`;
- публичный origin: `NEXT_PUBLIC_SITE_URL`;
- Turnstile: `NEXT_PUBLIC_TURNSTILE_SITE_KEY`;
- серверные секреты: `RATE_LIMIT_HMAC_SECRET`, `CERTIFICATE_VERIFICATION_SECRET`;
- `CONTENT_REVALIDATE_SECRET` — минимум 32 криптографически случайных байта;
- content runtime: `CONTENT_UPSTREAM_TIMEOUT_MS`, `CONTENT_FALLBACK_ENABLED`;
- Storage worker: `STORAGE_RECONCILER_SECRET`;
- passwordless E2E: `E2E_ADMIN_EMAIL`, `E2E_PARTICIPANT_EMAIL`; для remote
  preview — пары абсолютных путей `E2E_ADMIN_STORAGE_STATE` и
  `E2E_PARTICIPANT_STORAGE_STATE` вне репозитория.

Секреты не должны иметь префикс `NEXT_PUBLIC_`, попадать в Git или выводиться в
логи. Production `NEXT_PUBLIC_SITE_URL` — только `https://safetyhub.kz` без пути.

## Команды

```powershell
npm run dev                 # локальная разработка
npm run lint                # ESLint
npm run type-check          # строгая проверка TypeScript
npm test                    # Node test suite
npm run build               # production build
npm run verify              # полный локальный application gate
npm run db:reset            # чистая локальная база и все миграции
npm run check:db-types      # соответствие сгенерированных DB-типов
npm run test:db             # SQL contracts/security tests
npm run seed:workspace      # локальные admin/participant fixtures
npm run e2e:otp-state -- --email <email> --role <admin|participant> --output <absolute-state-path>
npm run test:e2e:release    # release Playwright matrix
npm run verify:release      # application + database + authenticated E2E
```

## Документация

- [Архитектура](docs/architecture.md)
- [Эксплуатация](docs/operations.md)
- [Backup и restore](docs/backup-restore.md)
- [Deployment и домен](docs/deployment.md)
- [Тестирование](docs/testing.md)
