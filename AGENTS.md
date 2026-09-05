# SAFETYHUB repository rules

## Database and content source of truth

- Make every table, column, index, trigger, RPC, grant, RLS, or Storage-policy change in a new forward-only file under `supabase/migrations/`.
- Never edit, rename, or delete an applied migration. Never make production-only SQL changes in the Supabase Dashboard.
- After a database change, regenerate the exact CLI schema in `lib/supabase/database.generated.ts`, update the application contracts in `lib/supabase/types.ts`, update SQL contract/security tests, and update the relevant architecture or operations documentation.
- Before changing courses, assessments, articles, or presentation assets, run `npm run content:pull:linked -- --check` when linked credentials are available. If it reports drift, pull and review the hosted content before editing.
- Publish operational content through the admin application. After publication, run `npm run content:pull:linked`, review the deterministic diff, run `npm run content:parity:check`, and commit the refreshed snapshot.
- Never export users, profiles, attempts, attestations, certificates, legal acceptances, sessions, identities, or audit events into `content/snapshots/`.
- Keep assessment answer keys out of `public/`, learner payloads, public/anon RPC responses, logs, and analytics. The single exception is the Russian course editor, which reads the saved bank through `public.read_course_question_bank_v4` under the `test.manage` capability. The repository is currently private; re-check repository visibility before committing answer-key snapshots.
- Treat hosted Supabase as the operational content source and `content/snapshots/` as the reproducible local receipt. A local reset must recreate the same schema and catalog without copying operational personal data.

## Required verification

- Run the narrowest relevant tests while iterating, then run `npm run verify` before release.
- A database release additionally requires a clean `supabase db reset`, `npm run check:db-types`, and `npm run test:db` in a Docker-capable local or CI environment.
- Never run `npm run db:push` for a destructive catalog change without a fresh encrypted backup, a reviewed migration diff, and a recorded pre/post count check.
- Do not delete published Storage objects in the same step that changes database references. Retire them first, verify references, and clean confirmed orphans separately.

## Course catalog contract

- The current learner contract is three hidden variants per course, ten questions per variant, four options per question, one correct option, a default pass score of 7, a 15-minute timer, and eight new attempts per course per `Asia/Oral` calendar day.
- The learner payload must never expose a variant number, variant identifier, correct option, answer-key table, or unpublished presentation metadata.
- Presentation PDFs use immutable content-addressed paths. Replacing a presentation creates a new presentation record and object path; it never overwrites a published CDN object.
