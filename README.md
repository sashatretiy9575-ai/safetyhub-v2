# SafetyHub

SafetyHub.kz — PWA для обучения, тестирования и выдачи проверяемых сертификатов по
охране труда, промышленной и пожарной безопасности. Стек: Next.js 16, React 19,
Tailwind 4, Supabase (Postgres, Auth, Storage, Edge Functions), деплой на Vercel.

## Требования

- Node.js 24 (`.nvmrc`), npm 11, Docker Desktop для локального Supabase.
- TypeScript остаётся на линии 6.x, пока typescript-eslint не поддерживает 7.

## Быстрый старт

```powershell
npm ci
Copy-Item .env.example .env.local
npx supabase start          # локальные URL и ключи перенесите в .env.local
npm run db:reset            # чистая локальная база, все миграции, бакеты, ассеты
npm run db:types            # типы базы из локальной схемы
npm run seed:workspace      # admin@safetyhub.local, participant@safetyhub.local, тестовые компании
npm run dev                 # http://localhost:3000
```

Для `supabase start` нужны два одноразовых значения в окружении оболочки:
`SUPABASE_SEND_EMAIL_HOOK_SECRETS` формата `v1,whsec_<base64>` и
`SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA` (тестовый ключ
Turnstile). Коды входа на стенде читаются из Mailpit: `http://127.0.0.1:54324`.
`db:reset` работает только с локальной базой.

## Структура

```
app/         маршруты и страницы: (public), [locale], (account), (admin), api/
components/  весь React-интерфейс: ui, layout, shared, marketing, admin, auth, profile, quiz…
server/      только серверный код: клиенты Supabase, RPC, авторизация, почта, PDF-проверки
lib/         общие помощники для сервера и браузера: валидация, PDF-рендер, телефоны, SEO, PWA
i18n/ messages/   локали ru/kk/en/zh и каталоги строк
supabase/    миграции, SQL-тесты, edge-функции, config.toml, seed.sql
content/     снапшоты курсов, статей, правовых документов и локализаций
scripts/ tests/ e2e/   инструменты, node-тесты, Playwright
```

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run dev` | локальная разработка |
| `npm run lint`, `npm run type-check` | ESLint без предупреждений, строгий TypeScript |
| `npm test` | node-тесты (`tests/`) |
| `npm run build` | production-сборка |
| `npm run check:bundles` | бюджеты JS/CSS по маршрутам |
| `npm run verify` | полный локальный гейт приложения |
| `npm run db:reset`, `npm run db:types`, `npm run check:db-types` | база, типы, контракт типов |
| `npm run test:db` | SQL-контракты и тесты безопасности |
| `npm run seed:workspace` | локальные аккаунты и компании |
| `npm run test:e2e`, `npm run test:e2e:release` | Playwright |
| `npm run verify:release:local`, `npm run verify:release` | релизные гейты (приложение + база + e2e) |
| `npm run content:pull:linked`, `npm run content:parity:check` | сверка контента с боевой базой |
| `npm run db:migrations:check-preflight`, `npm run db:push` | миграции в боевую базу |

## Переменные окружения

Полный шаблон — `.env.example`. Группы:

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_PROJECT_ID`, `DATABASE_URL`.
- Сайт: `NEXT_PUBLIC_SITE_URL` (в production только `https://safetyhub.kz`), флаги `SAFETYHUB_*_ENABLED`.
- Turnstile: `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `SUPABASE_AUTH_CAPTCHA_SECRET`, `SAFETYHUB_TURNSTILE_SECRET_KEY`.
- Серверные секреты: `RATE_LIMIT_HMAC_SECRET`, `CERTIFICATE_VERIFICATION_SECRET` (обязательны везде),
  `CONTENT_REVALIDATE_SECRET` — минимум 32 случайных символа, `STORAGE_RECONCILER_SECRET`.
- Почта: `SUPABASE_SEND_EMAIL_HOOK_SECRETS`, `SAFETYHUB_SMTP_HOST/PORT/USER/PASSWORD/FROM`.
- E2E: `E2E_ADMIN_EMAIL`, `E2E_PARTICIPANT_EMAIL`, `E2E_*_STORAGE_STATE`.

Секреты никогда не получают префикс `NEXT_PUBLIC_`, не попадают в git и в логи.
Боевые значения живут только в Vercel (Environment Variables) и в Supabase
(Functions secrets, Vault); локально — в `.env.local`.

## Правила

1. Любое изменение схемы, RPC, RLS, индексов или политик Storage — новый forward-only
   файл в `supabase/migrations/`. Применённые миграции не редактируются. SQL через
   Dashboard запрещён.
2. После изменения схемы: `npm run db:types`, правки `lib/supabase/types.ts`, SQL-тесты.
3. Источник контента — боевая Supabase. Перед правкой курсов и статей —
   `npm run content:pull:linked -- --check`; после публикации — pull,
   `content:parity:check` и коммит снапшота. В `content/snapshots/` нет персональных данных.
4. Ключи ответов не попадают в `public/`, в ответы ученику, в логи.
5. Перед релизом — `npm run verify`; для релиза базы — чистый `db:reset`,
   `check:db-types`, `test:db`.
6. `db:push` с деструктивными изменениями — только после свежего бэкапа.
   Объекты Storage не удаляются в том же шаге, что и ссылки на них в базе.

## Выкат

Push в `main` собирает production на Vercel (регион `bom1`). Миграции применяются
отдельно: `npm run db:migrations:check-preflight -- --expected-project-ref <ref>`,
затем `npx supabase db push --linked` с `SUPABASE_DB_PASSWORD` в окружении оболочки.
Конфиг Supabase Auth готовится командой `npm run auth:config:prepare:production`.
