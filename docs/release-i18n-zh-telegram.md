# RU/KK/EN/ZH, passkey, notifications and client certificates release

This runbook is the production cutover contract for the additive multilingual
release. It supplements `docs/deployment.md`; it does not authorize replaying
the destructive historical catalog rebuild. Run every command with the
repository-pinned Node 24/npm 11 toolchain from a clean
`codex/i18n-zh-telegram` review branch.

## Non-negotiable boundaries

- `main` is updated only through a reviewed pull request and green CI.
- Applied migrations are never edited or rolled back. A correction is a new
  forward-only migration.
- The linked project must be exactly the recorded SafetyHub production ref.
- No load test, synthetic seeding or destructive rehearsal targets production.
- Existing PS.KZ test mailboxes are used only during final smoke. The release
  does not create a mailbox, change its password or persist its credentials.
- GitHub, Supabase, Vercel, Cloudflare, SMTP and Telegram secret values never
  enter Git, command arguments, receipts or shared logs.
- Content publication and linked schema/storage mutations are sequential. Do
  not overlap them with backups, parity pulls or another operator session.
- The application is deployed with every new production flag off before any
  feature is enabled.

## Required preflight evidence

Before the first production write, record the commit SHA, PR URL, CI run URL,
linked project ref, Vercel deployment ID, UTC/`Asia/Oral` timestamps and the
following successful commands:

```powershell
npm run db:reset
npx supabase db lint --local --level error
npm run db:types:generate:local
npm run db:types:check:local
npm run check:db-types
npm run test:db
npm run content:snapshot:validate
npm run content:initial-import:validate
npm run content:localizations:validate:release
npm run content:seed:generate
git diff --exit-code -- supabase/seed.sql
npm run verify
npm run seed:workspace
npm run test:e2e:release
npm run test:load
```

`npm run test:load` is valid only against the explicitly disposable target
accepted by its hard-deny safety gate. Store the sanitized latency/count report
as CI evidence; never reuse its credentials or synthetic rows.

Immediately before production writes, run the read-only linked gates:

```powershell
npm run db:migrations:check-linked
npm run db:types:check
npm run storage:buckets:check:linked
npm run content:pull:linked -- --check
npm run content:parity:check
```

Any unexpected migration, type, bucket or content drift stops the release until
the hosted state is pulled and reviewed.

## Backup gate

1. Create a fresh encrypted custom-format PostgreSQL backup using
   `npm run db:backup:linked` and a fresh all-bucket byte backup using the
   documented Storage procedure.
2. Keep database ciphertext, Storage ciphertext and recovery material in
   physically separate access-controlled paths.
3. Verify both receipts and rehearse restoration into a disposable environment.
4. Record pre-change row counts for localized content, legal versions,
   presentations, attempts, certificates, notification tables and ZH private
   tables. Receipts contain counts/hashes only, never operational PII.

No migration or content publication begins without verified restore evidence.

## Ordered production cutover

Execute these phases one at a time and record post-counts after every phase.

1. Apply only the reviewed unapplied additive migrations. Confirm the hosted
   migration list and regenerate/check the exact linked CLI type output.
2. Push the reviewed Supabase Auth configuration only after supplying the real
   Turnstile secret through the protected local secret context. The public
   always-pass test secret is rejected by the preparation script.
3. Deploy the compatible Vercel build with:
   `SAFETYHUB_LOCALE_ROUTES_ENABLED=false`,
   `SAFETYHUB_ZH_PASSKEY_ENABLED=false`, and
   `SAFETYHUB_ADMIN_INBOX_ENABLED=false`.
4. Upload the 15 localized learner PDFs as new immutable, content-addressed
   objects. Keep the 15 canonical PPTX sources in the reviewed release artifact
   set, outside learner Storage. Never overwrite or delete a published object.
5. Through the Russian admin application, stage the localized legal versions,
   course/article drafts, assessment translations and presentation references.
   Publish only complete four-locale transactions.
6. Pull the resulting hosted content, review the deterministic diff, run parity,
   and archive the automated-only translation/visual QA receipt.
7. Enable locale routing, then verify RU unprefixed URLs and `/kk`, `/en`, `/zh`
   before continuing.
8. Enable ZH passkey registration and verify registration, pending access,
   authentication, approval, rejection, recovery and reasoned admin reset.
9. Enable the database `notification_events` flag, then the application admin
   inbox flag. Verify the inbox while Telegram remains unavailable.
10. Create/configure the private Telegram group and bot, deploy the dispatcher,
    set Function/Vault secrets, and only then enable the database
    `telegram_delivery` flag. Telegram remains informational and cannot mutate
    approval state.
11. Verify browser-only certificate rendering for all four locales and the
    500-item export path. Keep the previous server code unavailable through the
    stable `CERTIFICATE_PDF_CLIENT_ONLY` tombstone; QR verification stays live.
12. Complete the full production smoke below, compare post-counts to expected
    deltas, and save the release receipt/runbook evidence.

Database runtime flags are changed only through the reasoned, idempotent
service-only `set_runtime_feature_flag` RPC. Enable events before Telegram;
disable them in the reverse order.

## Production smoke matrix

- Apex returns `200`; `www` returns `308` to apex; TLS, CSP and security headers
  are valid.
- RU remains unprefixed. KK/EN/ZH routes, same-page language switching, cookie,
  profile locale, canonical, `hreflang`, Open Graph, sitemap, JSON-LD, manifest
  and offline behavior match the selected locale. `/admin` remains Russian.
- Existing PS.KZ test mailboxes complete RU/KK/EN six-digit OTP end to end. No
  mailbox credential is logged, committed or included in a receipt.
- ZH contains no email/SMS/password/username field. A real discoverable passkey
  completes registration and later authentication; wrong RP/origin/challenge,
  replay, counter regression and reused recovery codes fail generically.
- Pending and rejected accounts cannot fetch either presentation, create/resume
  an attempt or obtain a certificate through browser or direct RPC. Approval in
  the Russian admin UI opens the same gates immediately after session refresh.
- Every localized course exposes one immutable presentation and exactly three
  hidden variants of ten questions/four options. Learner HTML/JSON contains no
  variant identity, answer key or private Storage locator.
- A pending application appears once in the admin inbox and in the private
  Telegram group. Duplicate wake-ups do not resend a delivered row; `429`,
  timeout, `5xx`, invalid chat and rotated-token cases retry/dead-letter without
  rolling back the business event.
- RU/KK/EN/ZH certificates render all expected glyphs in the browser, download,
  print and verify by QR. Network traces contain bounded JSON/assets but no
  backend-generated PDF/report/ZIP response.
- A 500-certificate admin export reports progress, cancels cleanly and uses a
  streaming file when supported; the fallback emits archives of at most 100.
- Revocation invalidates public verification without deleting historical ledger
  metadata. Existing pre-release RU certificates remain verifiable.
- Supabase/Vercel logs show no synthetic email, recovery material, credentials,
  assessment answers or unexpected error/latency increase.

## Rollback

1. Disable Telegram delivery first, then notification event creation if needed.
   Removing/rotating the dispatcher secret is an additional delivery kill
   switch; inbox data remains available.
2. Set the application route/auth/inbox flags to false and promote the previous
   known-good Vercel deployment.
3. Leave additive schema, previous content revisions, certificate ledger rows
   and immutable Storage objects in place. Do not run down migrations and do
   not edit an applied migration.
4. Do not delete newly published Storage objects in the rollback step. Mark
   references dormant, verify reachability and clean confirmed orphans in a
   separately reviewed operation.
5. Restore data only into a separate disposable environment first. A production
   restore requires an independently reviewed incident procedure and verified
   backup receipt.
6. Do not change PS.KZ DNS/MX/SPF/DKIM/DMARC for an application rollback.

The release is complete only when the green CI evidence, linked checks,
backup/restore receipts, content parity receipt, smoke results, pre/post counts
and rollback identifiers are stored without secrets or operational personal
data.
