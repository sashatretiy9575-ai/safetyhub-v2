# RU/KK/EN/ZH, username/password, notifications and client certificates release

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
$ProjectRef = '<CURRENT_PRODUCTION_PROJECT_REF>'
$SslRootCert = 'C:\secure-operator\supabase-server-root-ca.crt'
$SslRootCertSha256 = '<EXPECTED_LOWERCASE_CA_SHA256>'
if ((Get-Content -LiteralPath 'supabase/.temp/project-ref' -Raw).Trim() -cne $ProjectRef) {
  throw 'Linked Supabase project does not match the reviewed production ref.'
}
npm run db:migrations:check-preflight -- --expected-project-ref $ProjectRef
npm run storage:buckets:check:linked
npm run content:pull:linked -- `
  --check `
  --expected-project-ref $ProjectRef `
  --ssl-root-cert $SslRootCert `
  --ssl-root-cert-sha256 $SslRootCertSha256
npm run content:parity:check -- `
  --expected-project-ref $ProjectRef `
  --ssl-root-cert $SslRootCert `
  --ssl-root-cert-sha256 $SslRootCertSha256
```

The pre-migration gate now accepts exactly the 58-migration production prefix
and the reviewed two-file tail: the auth-realm/locale boundary and generic
approval notifications. It retains the normalized SHA-256 receipt for the
already-applied 19-file localization release (including ZH minimal pending
approval and atomic legal consent-bundle publication) and pins every pending
filename/hash entry; a
partially applied tail, remote-only version, renamed file or changed migration
fails closed. The production schema is already localized, so a normal linked
content check remains mandatory rather than falling back to legacy RU preflight
behavior.

`npm run db:types:check` remains the exact post-migration hosted-schema gate and
must pass после применения migrations together with
`npm run db:migrations:check-linked`. Any unexpected migration, bucket or
content drift stops the release until the hosted state is pulled and reviewed.
The PostgreSQL gates have no system or bundled-root fallback: the
operator-provided current-project Server root CA, hostname/SNI verification and
optional reviewed SHA-256 pin are mandatory.

The `58 + 2` manifest is deliberately specific to this unapplied forward
release. It pins the realm/locale RPC boundary and the no-PII approval
notification contract. If another reviewed migration is added before the linked apply, update
the pinned `REVIEWED_PENDING_MIGRATIONS` filename/hash manifest and its
exact-count test in the same reviewed change, then obtain a fresh preflight
receipt. Do not change the gate to tolerate an arbitrary extra local migration.

## Backup gate

1. Create a fresh encrypted custom-format PostgreSQL backup using
   `npm run db:backup:linked -- --expected-project-ref $ProjectRef
--ssl-root-cert $SslRootCert --ssl-root-cert-sha256
$SslRootCertSha256 ...` and a fresh all-bucket byte backup using the
   documented Storage procedure. Both receipts must contain the exact reviewed
   current project ref; the database receipt also records the CA hash and
   certificate fingerprint.
2. Keep database ciphertext, Storage ciphertext and recovery material in
   physically separate access-controlled paths.
3. Verify both receipts and rehearse restoration into a disposable environment.
4. Record pre-change row counts for localized content, legal versions,
   presentations, attempts, certificates, notification tables and ZH private
   tables. Receipts contain counts/hashes only, never operational PII.

No migration or content publication begins without verified restore evidence.

## Ordered production cutover

Execute these phases one at a time and record post-counts after every phase.

1. Preview, review, apply and re-check only the unapplied additive migrations:

   ```powershell
   if ((Get-Content -LiteralPath 'supabase/.temp/project-ref' -Raw).Trim() -cne $ProjectRef) {
     throw 'Linked Supabase project does not match the reviewed production ref.'
   }
   npx --no-install supabase db push --linked --dry-run
   # Stop here unless the printed migration set exactly matches the reviewed set.
   npx --no-install supabase db push --linked
   npm run db:migrations:check-linked
   npm run db:types:check
   ```

   Do not use `--include-all`, `--include-seed`, a dashboard SQL editor or an
   unreviewed database URL. Save the dry-run, applied migration list and exact
   linked type check as nonsecret release evidence.

2. Push the reviewed Supabase Auth configuration only after supplying the real
   Turnstile secret through the protected local secret context. Separately set
   the matching Vercel-only `SAFETYHUB_TURNSTILE_SECRET_KEY` for ZH registration
   Siteverify; it is not read from Supabase config. The public always-pass test
   secret is rejected by the preparation script and by the deployed verifier.
3. Deploy the compatible Vercel build with:
   `SAFETYHUB_LOCALE_ROUTES_ENABLED=false`,
   `SAFETYHUB_ZH_USERNAME_PASSWORD_ENABLED=false`, and
   `SAFETYHUB_ADMIN_INBOX_ENABLED=false`.
4. Upload the 15 localized learner PDFs as new immutable, content-addressed
   objects. Keep the 15 canonical PPTX sources in the reviewed release artifact
   set, outside learner Storage. Never overwrite or delete a published object.
5. Through the Russian admin application, stage the localized legal versions,
   course/article drafts, assessment translations and presentation references.
   Publish only complete four-locale transactions. Privacy and Terms must be
   selected and published together through the one atomic legal-bundle action;
   do not invoke legacy one-document activation RPCs.
6. Pull the resulting hosted content, review the deterministic diff, run parity,
   and archive the automated-only translation/visual QA receipt.
7. Enable locale routing, then verify RU unprefixed URLs and `/kk`, `/en`, `/zh`
   before continuing.
8. Enable the database `zh_username_password` receipt, then ZH
   username/password registration. Verify first-token registration creates no
   session, redirects to login, and a fresh Turnstile token completes password
   authentication. The fresh ZH application must transition directly to
   `pending` without email, telephone, profile/contact fields or avatar; then
   verify pending access, approval, rejection and admin-only password recovery.
   After approval, verify the mapped ZH learner can open material and complete
   an attempt without a fabricated profile/avatar; a pass creates an
   attestation but remains `pending_identity` until a real identity is verified.
9. Enable the database `notification_events` flag, then the application admin
   inbox flag. Verify the inbox while Telegram remains unavailable.
10. Create/configure the private Telegram group and bot. Put
    `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_DISPATCHER_SECRET` and
    `SAFETYHUB_SITE_URL` in a dedicated ignored/access-restricted Function env
    file; put `SUPABASE_SECRET_KEY` and the exact same
    `TELEGRAM_DISPATCHER_SECRET` in a separate operator env file, or retain those
    two Vault values only in memory for the strict `--secret-stdin` contract
    documented in `docs/notifications-and-telegram.md`. Then run:

    ```powershell
    npx --no-install supabase secrets set `
      --project-ref $ProjectRef `
      --env-file 'C:\secure-operator\telegram-function.env'
    npx --no-install supabase secrets list --project-ref $ProjectRef
    npx --no-install supabase functions deploy telegram-dispatcher `
      --project-ref $ProjectRef `
      --no-verify-jwt
    npm run notifications:vault:configure -- `
      --expected-project-ref $ProjectRef `
      --confirm-project-ref $ProjectRef `
      --reason 'Configure Telegram dispatcher Vault values for release' `
      --idempotency-key '<NEW_UUID>' `
      --env-file 'C:\secure-operator\telegram-vault.env'
    ```

    `secrets list` must show names only; never use `NAME=VALUE` arguments. The
    Vault CLI derives the one allowed current-project Function URL, calls the
    service-only reasoned/idempotent RPC and emits only the two Vault names.
    For a diskless Vault call replace `--env-file ...` with `--secret-stdin` and
    pipe the exact ordered two-line assignment payload from the approved secret
    systems; never construct either value in argv.
    Only after the dispatcher smoke succeeds enable the database
    `telegram_delivery` flag. Telegram remains informational and cannot mutate
    approval state.

11. Verify browser-only certificate rendering for all four locales and the
    500-item export path. Keep the previous server code unavailable through the
    stable `CERTIFICATE_PDF_CLIENT_ONLY` tombstone; QR verification stays live.
12. Complete the full production smoke below, compare post-counts to expected
    deltas, and save the release receipt/runbook evidence.

Database runtime flags are changed only through the reasoned, idempotent
service-only `set_runtime_feature_flag` RPC. Enable events before Telegram;
disable them in the reverse order. The controlled operator file contains only
`SUPABASE_SECRET_KEY`; alternatively, pipe the raw in-memory key to
`--secret-stdin` as documented in `docs/operations.md`. Use a new UUID for each
logical change and reuse that UUID only when retrying the exact same request:

```powershell
npm run runtime:flag:set -- `
  --expected-project-ref $ProjectRef `
  --confirm-project-ref $ProjectRef `
  --feature notification_events `
  --enabled true `
  --reason 'Enable notification events after release migration' `
  --idempotency-key '<NEW_UUID>' `
  --env-file 'C:\secure-operator\production-service.env'

npm run runtime:flag:set -- `
  --expected-project-ref $ProjectRef `
  --confirm-project-ref $ProjectRef `
  --feature telegram_delivery `
  --enabled true `
  --reason 'Enable Telegram after dispatcher smoke' `
  --idempotency-key '<ANOTHER_NEW_UUID>' `
  --env-file 'C:\secure-operator\production-service.env'
```

## Production smoke matrix

- Apex returns `200`; `www` returns `308` to apex; TLS, CSP and security headers
  are valid.
- RU remains unprefixed. KK/EN/ZH routes, same-page language switching, cookie,
  profile locale, canonical, `hreflang`, Open Graph, sitemap, JSON-LD, manifest
  and offline behavior match the selected locale. `/admin` remains Russian.
- Existing PS.KZ test mailboxes complete RU/KK/EN six-digit OTP end to end. No
  mailbox credential is logged, committed or included in a receipt.
- ZH registration and login accept only a Latin username and password. Email,
  SMS, telephone, profile/contact fields and avatar are absent from the
  registration-to-pending approval path and from authentication/recovery;
  recovery is administrator-only. The Russian `identity.manage` queue displays
  the canonical username for the minimal application, while the generic
  Telegram event contains no username, provider email, password or telephone.
- Pending and rejected accounts cannot fetch either presentation, create/resume
  an attempt or obtain a certificate through browser or direct RPC. Approval in
  the Russian admin UI opens the same gates immediately after session refresh.
  An approved minimal ZH account may learn and pass without profile/avatar
  fields, while certificate issuance remains blocked until a verified real
  identity exists; its username is never used as a certificate name.
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

The repository does not pin a Vercel CLI or contain a production Vercel project
binding. Application flag changes, promotion and rollback therefore remain a
release blocker until an owner records the exact Vercel project/team and the
immutable previous Ready deployment ID in the protected deployment system.
Use that reviewed UI/CI path; do not download a floating CLI during cutover and
do not guess a deployment alias. Database rollback is the same CLI above with
fresh UUIDs, first `telegram_delivery=false`, then
`notification_events=false`; schema corrections remain forward-only.
