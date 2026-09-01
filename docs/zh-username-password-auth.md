# Chinese username/password authentication

Chinese (`zh`) learner accounts use a separate credential contract from the
RU/KK/EN email-code flow:

- Sign-up and login accept only a canonical Latin username and password.
- The public username is 3–32 characters, starts with a lowercase Latin
  letter, and may contain lowercase letters, digits, `.`, `_`, and `-`.
- Passwords are accepted only by Supabase Auth. SafetyHub does not persist a
  plaintext password, password hash, reset token, or password value in a
  database RPC, audit record, browser storage, or application log.
- An opaque `@auth.invalid` provider identifier exists only in the private,
  server-only username mapping. It is redacted from JWT claims, the learner
  context, and administrator directory projections.
- A profile telephone remains normal contact data. It is collected by the
  standard onboarding form and is not an authentication factor or recovery
  channel.
- Registration first sends a dedicated Turnstile token to a Vercel server-only
  Cloudflare `Siteverify` call. It verifies before username lookup, legal
  acceptance, provider-user creation, or mapping. A failed or unavailable
  verification creates neither an Auth identity nor a mapping.
- Registration returns a completion/login redirect without a session. Login
  obtains a fresh Turnstile token and passes it to Supabase Auth
  `signInWithPassword`; a one-time registration token is never reused.
- `SAFETYHUB_TURNSTILE_SECRET_KEY` is a Vercel-only secret distinct from
  `SUPABASE_AUTH_CAPTCHA_SECRET`. In production/preview the verifier rejects the
  public test secret and binds a successful response to the configured deployment
  hostname.

## Rollout order

The cutover has two independent, fail-closed controls. Both are required for
public registration and login.

1. Enable the service-only database receipt `zh_username_password` with the
   existing reasoned, idempotent runtime-feature procedure. It is inserted as
   `false` by `20260902130000_zh_username_password_auth.sql`.
2. Set `SAFETYHUB_ZH_USERNAME_PASSWORD_ENABLED=true` in the application
   runtime, then deploy the application configuration through the ordinary
   release process.

Disabling either control prevents new Chinese password sessions. The database
session guard also rejects existing mapped sessions when the database receipt
is off. Do not enable the browser flag before the database receipt.

## Approval and recovery

Registration records current legal acceptance but leaves the account in the
normal `profile_incomplete` state. The learner must complete the standard
profile and contact-phone onboarding flow before the existing approval
submission transitions the account to `pending`. Administrator approval remains
mandatory before protected learner access.

There is no Chinese self-service recovery endpoint. An administrator with
`identity.manage` may use the internal ZH password recovery API only after
identity verification. Recovery first marks the private mapping
`password_change_pending` and deletes every exact authorized session. The
server then submits the replacement password directly to Supabase Auth and
finally clears the pending state. If the provider or final database call fails,
the account stays disabled rather than accepting an old credential; an
administrator repeats the verified recovery operation. The password is never
included in the database operation or audit payload.

Legacy ZH WebAuthn login, registration, recovery, and credential-reset routes
return `410 ZH_AUTH_METHOD_RETIRED`. For a verified legacy account, an
administrator can provision a Latin username/password transition through the
same fail-closed recovery sequence. Historical WebAuthn tables remain only to
support forward migration and redaction of pre-cutover records; they are not an
active authentication surface. The request-time session guard also rejects any
already-issued legacy passkey JWT immediately; there is no expiry grace period.

## Verification

The focused contract coverage is in:

- `tests/auth/zh-webauthn-contract.test.mjs`
- `tests/security/zh-session-provider-method.test.mjs`
- `supabase/tests/zh_session_provider_method.sql`
- `supabase/tests/zh_webauthn_auth.sql`

After a local database reset, regenerate the CLI schema contract with
`npm run db:types:generate:local`, then run `npm run check:db-types` and
`npm run test:db`. The generated schema is intentionally not hand-maintained.
