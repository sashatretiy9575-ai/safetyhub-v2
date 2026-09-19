-- 20260919120000 froze every certificate that predated the signature registry with
-- `captureKind='legacy-cutover'` and no profile, so those documents go on drawing the
-- settings as they stood that morning: the stamp that has since been replaced, and a
-- commission where only the chairman signs, because the settings never held the
-- members' signatures at all. Nothing about that state was ever chosen at an issuance
-- — a migration wrote it — and the company's own stamp is the registered one.
--
-- Each such row is recaptured once against the profile its program actually uses: the
-- one its batch names, otherwise the program's single profile for everybody. A program
-- split into workers and engineers has neither, and guessing which a person attended
-- is not this migration's business, so those rows are left exactly as they are. A
-- snapshot taken at a real issuance is never touched.
-- Two triggers stand in the way of an update: the guard that refuses any change to
-- a certificate, and the capture itself, which refuses a changed snapshot. Both are
-- disabled for this statement only and restored below, inside the same transaction,
-- so no concurrent writer ever sees the table unguarded.
alter table public.certificates disable trigger certificates_snapshot_guard;
alter table public.certificates disable trigger capture_document_snapshot;

update public.certificates c
set document_snapshot = c.document_snapshot || jsonb_build_object(
      'profile', p.body,
      'profileVersion', p.version,
      'recapturedAt', statement_timestamp()
    )
from public.document_profiles p
where c.document_snapshot ->> 'captureKind' = 'legacy-cutover'
  and coalesce(c.document_snapshot -> 'profile', 'null'::jsonb) = 'null'::jsonb
  and p.course_slug = c.test_slug
  and p.id = coalesce(
    (
      select b.profile_id
      from public.document_batches b
      where b.organization_key = lower(btrim(coalesce(c.organization, '')))
        and b.course_slug = c.test_slug
    ),
    (
      select q.id
      from public.document_profiles q
      where q.course_slug = c.test_slug and q.audience = 'all'
    )
  );

alter table public.certificates enable trigger capture_document_snapshot;
alter table public.certificates enable trigger certificates_snapshot_guard;
