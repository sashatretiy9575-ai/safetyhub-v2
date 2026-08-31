-- Course materials are access-controlled learner content.  A published
-- presentation is deliberately not a public CDN object: an active session
-- must be approved at the time its same-origin download route authorizes it.
--
-- This migration follows 20260831101000_profile_phone_approval_schema.sql,
-- which introduced the independent approval lifecycle on account_controls.

create or replace function private.require_approved_learner()
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_approval_state public.account_approval_state;
begin
  -- Lock the control row for the duration of the authorization statement.
  -- This prevents an approval decision from interleaving with a single
  -- protected learner RPC, while keeping suspension/deletion semantics in
  -- private.require_active_user() as the one canonical source of truth.
  select control.approval_state
  into v_approval_state
  from public.account_controls control
  where control.user_id = v_user_id
    and control.status = 'active'
    and not control.deletion_pending
  for share;

  if not found
    or v_approval_state is distinct from 'approved'::public.account_approval_state then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'ACCOUNT_APPROVAL_REQUIRED';
  end if;

  return v_user_id;
end;
$$;

revoke all on function private.require_approved_learner()
  from public, anon, authenticated, service_role;

-- The public Storage endpoint honors a bucket's `public` flag before ordinary
-- object policies.  Keep the immutable object names, but make the bucket
-- private so those names are never independently sufficient to fetch bytes.
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'course-presentations',
  'course-presentations',
  false,
  26214400,
  array['application/pdf', 'image/webp']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- A restrictive policy composes with every existing permissive policy.  It
-- therefore blocks anonymous/authenticated access to this bucket even if an
-- old Dashboard-created policy or a future broad policy would otherwise allow
-- it.  The service role remains the server-only downloader/uploader.
drop policy if exists course_presentations_browser_access_denied on storage.objects;
create policy course_presentations_browser_access_denied on storage.objects
as restrictive
for all to anon, authenticated
using (bucket_id <> 'course-presentations')
with check (bucket_id <> 'course-presentations');

-- The public course catalogue needs only proof that a ready presentation
-- exists plus its display metadata.  Storage object paths, source filenames
-- and bucket names must never be selectable by a browser role.  Revoke the
-- table-level grant first: a column-level REVOKE cannot override a broad
-- table-level SELECT that may have been added by an older deployment.
revoke select on public.course_presentations from anon, authenticated;
drop policy if exists course_presentations_public_read on public.course_presentations;
drop policy if exists course_presentations_catalog_read on public.course_presentations;
create policy course_presentations_catalog_read on public.course_presentations
for select to anon, authenticated using (
  status = 'ready'
  and exists (
    select 1
    from public.tests test
    join public.test_revisions revision on revision.id = test.current_revision_id
    where test.id = course_presentations.course_id
      and test.status = 'published'
      and revision.presentation_id = course_presentations.id
  )
);

revoke select (
  storage_bucket,
  storage_path,
  thumbnail_path,
  source_filename,
  mime_type,
  byte_size,
  aspect_ratio,
  validation_error,
  created_by,
  created_at,
  retired_at,
  cleanup_claimed_at
) on public.course_presentations from anon, authenticated;

grant select (
  id,
  course_id,
  page_count,
  sha256,
  status,
  validated_at
) on public.course_presentations to anon, authenticated;

-- This RPC is invoked only by the same-origin Next route with the user's
-- cookie-backed client. It returns only an already-public presentation ID and
-- display metadata; the Storage object path remains server-only. It contains
-- no assessment data or answer keys.
create or replace function public.get_approved_course_presentation(
  p_course_slug text,
  p_asset text
)
returns table (
  presentation_id uuid,
  content_type text,
  byte_size bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_approved_learner();

  if p_course_slug is null
    or char_length(p_course_slug) not between 1 and 120
    or p_course_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or p_asset is null
    or p_asset not in ('presentation', 'thumbnail') then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;

  return query
  select
    presentation.id as presentation_id,
    case
      when p_asset = 'presentation' then 'application/pdf'
      else 'image/webp'
    end as content_type,
    case
      when p_asset = 'presentation' then presentation.byte_size
      else null
    end as byte_size
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  join public.course_presentations presentation
    on presentation.id = revision.presentation_id
  where test.slug = p_course_slug
    and test.status = 'published'
    and presentation.status = 'ready'
    and presentation.storage_bucket = 'course-presentations'
    and (p_asset = 'presentation' or presentation.thumbnail_path is not null)
  limit 1;

  if not found then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.get_approved_course_presentation(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_approved_course_presentation(text,text)
  to authenticated;

comment on function private.require_approved_learner() is
  'Requires an active, non-deleting account whose independent learner approval state is approved.';
comment on function public.get_approved_course_presentation(text,text) is
  'Cookie-authenticated, approval-gated lookup for the same-origin presentation proxy. It never returns assessment questions or answer keys.';
comment on table public.course_presentations is
  'Metadata only. Immutable PDF/WebP bytes are in a private bucket and are served only through the approval-gated application route.';
