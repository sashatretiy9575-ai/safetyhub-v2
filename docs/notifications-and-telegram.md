# Admin inbox and Telegram dispatcher

This subsystem carries three minimized product events and is deliberately
separate from `private.auth_admin_outbox`:

- `account.approval_requested`;
- `course.completed`;
- `system.alert`.

The business transaction writes `private.notification_events`. A trigger
creates one Telegram delivery row, an asynchronous `pg_net` request wakes the
Edge Function after commit, and a one-minute `pg_cron` sweep recovers missed or
retryable deliveries. Telegram availability never controls the originating
registration, course completion, or system operation.

## Trust boundaries

- The browser reads the inbox only through same-origin, no-store Next.js APIs.
- Inbox RPCs require the `audit.read` capability. The browser never creates a
  Supabase client and never receives delivery leases.
- The API validates an exact payload allowlist per event type before returning
  data. A future SQL payload field is fail-closed until the application
  contract explicitly accepts it.
- The dispatcher accepts only `POST` with a constant-time checked bearer. It
  uses a service-role Supabase client only inside the Edge Function.
- Every newly-created `account.approval_requested` event has exactly the
  schema-v2 generic envelope `schemaVersion`, `locale`, `requestedAt`,
  and `adminPath`. It has no application identity, contact details, username,
  provider identifier, avatar bytes, documents, assessment answers, credential
  material, or recovery data. Telegram renders it as “new training request”,
  locale, time, and the safe admin link.
- `telegram_application_details` remains disabled in production. It is
  retained only as a legacy rollout flag: it never expands a newly-created
  approval payload after the schema-v2 migration. Historical generic and
  historic full-detail events remain immutable and are accepted only by narrow
  backwards-compatible dispatcher/inbox parsers until normal retention prunes
  them.
- The one historical blank ZH generic shape is accepted only when it has the
  exact five legacy keys, both name fields are exactly empty, and locale is
  exactly `zh`. A blank RU/KK/EN legacy payload is invalid rather than being
  silently treated as a generic request.
- Telegram is informational. It has no commands, callbacks, or state-changing
  approval controls.

## Secret names

No values belong in Git, local command output, or deployment logs.

Supabase Function secrets:

- `TELEGRAM_BOT_TOKEN`;
- `TELEGRAM_CHAT_ID` (a negative numeric private-group ID);
- `TELEGRAM_DISPATCHER_SECRET` (at least 32 random bytes);
- `SAFETYHUB_SITE_URL` (`https://safetyhub.kz` in production);
- the platform-provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

Vault entries used by the database wake-up function:

- `notification_dispatch_url` — the deployed `telegram-dispatcher` URL;
- `notification_dispatch_secret` — exactly the same value as
  `TELEGRAM_DISPATCHER_SECRET`.

Prepare secrets in an ignored, access-restricted environment file and use the
Supabase CLI `secrets set --env-file` path. Do not place values directly on a
shared command line. Create or rotate the two Vault entries through the
controlled production secret procedure after the function URL exists. Use two
separate files:

- Function file: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `TELEGRAM_DISPATCHER_SECRET`, `SAFETYHUB_SITE_URL`;
- Vault operator file: `SUPABASE_SECRET_KEY`,
  `TELEGRAM_DISPATCHER_SECRET` (the exact same dispatcher value).

The platform injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; do not put
either in the Function file.

## Release sequence

1. Create the private group and bot through the owner's authenticated Telegram
   session, add the bot, and obtain the numeric group ID. Account confirmation,
   CAPTCHA, SMS, or 2FA remains an owner action.
2. After the reviewed additive migrations and exact linked-ref preflight have
   been applied, set Function secrets and deploy without echoing values:

   ```powershell
   $ProjectRef = '<CURRENT_PRODUCTION_PROJECT_REF>'
   if ((Get-Content -LiteralPath 'supabase/.temp/project-ref' -Raw).Trim() -cne $ProjectRef) {
     throw 'Linked Supabase project does not match the reviewed production ref.'
   }
   npx --no-install supabase secrets set `
     --project-ref $ProjectRef `
     --env-file 'C:\secure-operator\telegram-function.env'
   npx --no-install supabase secrets list --project-ref $ProjectRef
   npx --no-install supabase functions deploy telegram-dispatcher `
     --project-ref $ProjectRef `
     --no-verify-jwt
   ```

   `verify_jwt = false` is safe only because the function enforces the
   independent dispatcher bearer. `secrets list` verifies names, not values.

3. Store the derived current-project function URL and dispatcher bearer through
   the service-only Vault RPC. The CLI requires an exact ref confirmation,
   reason and retry-safe UUID and never logs either configured value. A
   controlled env-file remains supported:

   ```powershell
   npm run notifications:vault:configure -- `
     --expected-project-ref $ProjectRef `
     --confirm-project-ref $ProjectRef `
     --reason 'Configure Telegram dispatcher Vault values for release' `
     --idempotency-key '<NEW_UUID>' `
     --env-file 'C:\secure-operator\telegram-vault.env'
   ```

   To avoid a Vault operator file, populate `$ServiceKey` and
   `$DispatcherSecret` only in memory through the approved secret systems. The
   `--secret-stdin` contract is exactly these two nonempty lines in this order,
   is bounded to 8 KiB, rejects TTY/extra/duplicate lines, and is mutually
   exclusive with `--env-file`:

   ```powershell
   (@(
       "SUPABASE_SECRET_KEY=$ServiceKey"
       "TELEGRAM_DISPATCHER_SECRET=$DispatcherSecret"
     ) -join "`n") | npm run notifications:vault:configure -- `
     --expected-project-ref $ProjectRef `
     --confirm-project-ref $ProjectRef `
     --reason 'Configure Telegram dispatcher Vault values for release' `
     --idempotency-key '<NEW_UUID>' `
     --secret-stdin
   Remove-Variable ServiceKey, DispatcherSecret -ErrorAction SilentlyContinue
   ```

4. Deploy the backwards-compatible dispatcher and inbox before applying the
   schema-v2 trigger migration. Let any active leases drain (or briefly disable
   only delivery through the reasoned runtime flag) before changing the
   database contract.
5. Apply the reviewed forward-only migration through the repository release
   flow, record aggregate pre-counts for exact dead blank-ZH candidates, then
   call the service-only bounded
   `npm run notifications:legacy-zh:recover -- …` operator CLI documented in
   `docs/operations.md`; do not invoke the RPC through Dashboard/manual SQL.
   It calls only `recover_legacy_blank_zh_approval_deliveries` and touches only
   dead/no-remote-message/no-lease legacy ZH deliveries; it never replays
   delivered, leased, non-ZH, pending, or retry rows. Restore delivery and
   verify the aggregate receipt and selected rows transition `dead → retry → delivered`
   without a duplicate remote message. Its `1..100` limit defaults
   to 100; the mandatory reason and UUID are nonsecret release correlation,
   while the receipt contains no payload, delivery ID or personal data.
6. Enable event creation and, only after inbox/dispatcher smoke, Telegram
   delivery through `npm run runtime:flag:set` as documented in
   `docs/operations.md`. Keep `telegram_application_details=false`.
   Verify a generic pending-application event, then verify a passed/failed
   completion and a synthetic system alert.
7. Exercise duplicate wake-ups, a request timeout, Telegram `429`, `5xx`, an
   invalid chat ID, and a rotated token. Confirm retries/dead-letter state in
   the Russian admin inbox while the business records remain committed.

## Runtime behavior

The admin shell owns one polling provider even though desktop and mobile each
render a bell control. Polling runs only while the document is visible and the
browser is online, no more often than every 15 seconds. It sends `If-None-Match`,
uses a 10-second abort timeout, pauses offline, refreshes immediately after an
admin action, and backs off exponentially to two minutes after failures.

The dispatcher claims at most 12 rows with a 45-second lease and sends at most
three Telegram requests concurrently. It validates the lease envelope and then
parses each payload independently: a malformed but lease-valid row is failed
for its own delivery, while valid rows in the same claim continue. Completion
and failure transitions are lease-token guarded. Telegram `429` responses
honor bounded `retry_after`; other errors are stored only as stable
categories. Ten failed attempts move a delivery to the dead letter state,
where an authorized admin can request a fresh idempotent retry.

Telegram Bot API [`sendMessage`](https://core.telegram.org/bots/api#sendmessage)
has no caller-supplied idempotency key. Lease and
completion state prevent duplicate invocations from sending an already
completed delivery, but no HTTP client can distinguish a timeout before
Telegram accepted a message from a timeout after acceptance. That narrow
ambiguous-result window is at-least-once; operators should use the correlation
and event timestamps when investigating a possible duplicate.

## Rollback and rotation

- Keep `telegram_application_details=false`, then disable delivery through
  the reasoned runtime-flag CLI with `telegram_delivery=false`; if needed,
  use dispatcher-secret rotation as a second kill switch. Inbox events remain
  available.
- Revoking the bot token affects only Telegram delivery. Registration and
  course completion continue normally.
- Restore delivery by rotating both copies of the dispatcher secret together,
  deploying the function, rerunning the idempotent Vault CLI with a fresh UUID,
  performing smoke, and only then setting `telegram_delivery=true`; manually
  retry dead rows in the inbox afterward.
- Do not delete event or delivery rows manually. The service-only prune RPC
  retains delivered delivery rows for 30 days and inbox events for 90 days;
  audit history remains governed separately.
