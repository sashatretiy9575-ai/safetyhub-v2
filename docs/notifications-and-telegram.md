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
- Telegram messages contain only the participant name, locale, event time,
  course/result summary when applicable, stable system code/correlation ID,
  and an admin deep link. They exclude contact and employment details,
  documents, assessment answers, authentication identities, credentials, and
  recovery data.
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
controlled production secret procedure after the function URL exists.

## Release sequence

1. Create the private group and bot through the owner's authenticated Telegram
   session, add the bot, and obtain the numeric group ID. Account confirmation,
   CAPTCHA, SMS, or 2FA remains an owner action.
2. Set Function secrets without echoing them.
3. Deploy `telegram-dispatcher`; its `verify_jwt = false` setting is safe only
   because the function enforces the independent dispatcher bearer.
4. Store the deployed function URL and dispatcher secret under the two Vault
   names above.
5. Apply the reviewed additive notification migration. It creates the
   after-insert wake-up and the one-minute recovery schedule.
6. Submit one pending application and verify one inbox event and one Telegram
   message. Then verify a passed/failed completion and a synthetic system alert.
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
three Telegram requests concurrently. Completion and failure transitions are
lease-token guarded. Telegram `429` responses honor bounded `retry_after`;
other errors are stored only as stable categories. Ten failed attempts move a
delivery to the dead letter state, where an authorized admin can request a
fresh idempotent retry.

Telegram Bot API [`sendMessage`](https://core.telegram.org/bots/api#sendmessage)
has no caller-supplied idempotency key. Lease and
completion state prevent duplicate invocations from sending an already
completed delivery, but no HTTP client can distinguish a timeout before
Telegram accepted a message from a timeout after acceptance. That narrow
ambiguous-result window is at-least-once; operators should use the correlation
and event timestamps when investigating a possible duplicate.

## Rollback and rotation

- Disable delivery by removing/rotating `notification_dispatch_secret` or by
  pausing the scheduled job; inbox events remain available.
- Revoking the bot token affects only Telegram delivery. Registration and
  course completion continue normally.
- Restore delivery by rotating both copies of the dispatcher secret together,
  deploying the function, then manually retrying dead rows in the inbox.
- Do not delete event or delivery rows manually. The service-only prune RPC
  retains delivered delivery rows for 30 days and inbox events for 90 days;
  audit history remains governed separately.
