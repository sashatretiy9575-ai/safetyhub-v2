# Безопасная подготовка production Auth config

Локальный [`supabase/config.toml`](../supabase/config.toml) намеренно остаётся
localhost-конфигурацией. Перед настройкой нового hosted Supabase подготовьте
изолированную одноразовую копию:

```powershell
npm run auth:config:prepare:production
```

Команда **не подключается к Supabase и ничего не публикует**. Она создаёт
уникальную папку во временной директории ОС, то есть за пределами репозитория,
и в ней создаёт только следующую структуру:

```text
supabase/config.toml
supabase/templates/magic-link.html
supabase/templates/confirmation.html
supabase/templates/recovery.html
supabase/templates/invite.html
```

Перед записью команда проверяет SHA-256 локального `config.toml` и всех четырёх
шаблонов. В подготовленной копии разрешены ровно две строковые замены:

```diff
- site_url = "http://localhost:3000"
+ site_url = "https://safetyhub.kz"
- additional_redirect_urls = ["http://localhost:3000/**"]
+ additional_redirect_urls = ["https://safetyhub.kz/**"]
```

После записи повторно проверяются точный набор файлов, итоговый SHA-256 config и
SHA-256 каждого шаблона. Если локальная конфигурация или шаблон были изменены,
скрипт безопасно завершается до создания готовой копии. При сознательном изменении
Auth-конфига сначала обновите allowlist и его тест вместе с release review; не
обходите проверку ручной правкой временного файла.

## Когда выполнять `config push`

1. Сначала примените migrations нового проекта, включая Custom Access Token Hook
   и grant для `supabase_auth_admin`.
2. Запустите подготовку и просмотрите напечатанный временный путь.
3. Только после отдельного решения о release замените явный placeholder ref в
   напечатанной команде и выполните её из PowerShell. Команда не содержит ключей,
   паролей или значений переменных окружения.
4. Проверьте в новом Supabase Site URL, redirect URL, все четыре шаблона и
   включённый custom access-token hook. Затем пройдите реальный email OTP smoke.

Не запускайте `supabase config push` из корня репозитория: это отправит
localhost URL. После успешной проверки удалите созданную временную папку как
обычный одноразовый рабочий материал; она никогда не должна попадать в Git.
