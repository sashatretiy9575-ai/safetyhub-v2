-- Preserve the exact settings/images used by each issuance. Existing documents
-- are explicitly a cutover capture, never represented as historical originals.
create table public.document_assets (
 id uuid primary key default gen_random_uuid(),
 owner_id text not null check (owner_id ~ '^[a-z][a-z0-9-]{1,79}$'),
 kind text not null check (kind in ('signature','stamp')),
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 object_key text not null check (object_key ~ '^[a-f0-9]{64}\.png$'),
 created_at timestamptz not null default now(),
 unique(owner_id,kind,sha256), check(object_key=sha256||'.png')
);
alter table public.document_assets enable row level security;
revoke all on public.document_assets from public,anon,authenticated;
grant select,insert on public.document_assets to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('document-facsimiles','document-facsimiles',false,2097152,array['image/png'])
 on conflict(id) do nothing;

create table public.document_profiles (
 id text primary key check (id ~ '^[a-z][a-z0-9-]{1,119}$'),
 course_slug text not null,
 audience text not null check (audience in ('all','worker','itr')),
 body jsonb not null check (jsonb_typeof(body)='object' and octet_length(body::text)<=32000),
 version bigint not null default 1,
 updated_at timestamptz not null default now(),
 unique(course_slug,audience)
);
alter table public.document_profiles enable row level security;
revoke all on public.document_profiles from public,anon,authenticated;
grant select,insert,update on public.document_profiles to service_role;
alter table public.document_batches add column profile_id text references public.document_profiles(id);

create table public.certificate_settings_versions (
 version bigint primary key,
 payload jsonb not null,
 captured_at timestamptz not null default now()
);
alter table public.certificate_settings_versions enable row level security;
revoke all on public.certificate_settings_versions from public,anon,authenticated;
grant select on public.certificate_settings_versions to service_role;
insert into public.certificate_settings_versions(version,payload)
 select version,private.certificate_settings_payload(true) from public.certificate_settings;
create function private.archive_document_settings() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.version is distinct from old.version then
   insert into public.certificate_settings_versions(version,payload)
   values(new.version,private.certificate_settings_payload(true));
 end if;
 return new;
end; $$;
revoke all on function private.archive_document_settings() from public,anon,authenticated,service_role;
create trigger archive_document_settings after update on public.certificate_settings
 for each row execute function private.archive_document_settings();

alter table public.certificates add column document_snapshot jsonb;
create function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; b public.document_batches; p public.document_profiles; d date;
begin
 if tg_op='UPDATE' then
   if new.document_snapshot is distinct from old.document_snapshot then raise exception 'DOCUMENT_SNAPSHOT_IMMUTABLE'; end if;
   return new;
 end if;
 select private.certificate_settings_payload(false) into s;
 select * into b from public.document_batches where organization_key=lower(btrim(new.organization)) and course_slug=new.test_slug;
 if b.profile_id is not null then select * into p from public.document_profiles where id=b.profile_id and course_slug=new.test_slug;
 else select * into p from public.document_profiles where course_slug=new.test_slug and audience='all'; end if;
 if exists(select 1 from public.document_profiles where course_slug=new.test_slug) and p.id is null then
   raise exception using errcode='22023', message='DOCUMENT_PROFILE_REQUIRED';
 end if;
 d:=coalesce(b.document_date,(new.issued_at at time zone 'Asia/Oral')::date);
 new.document_snapshot:=jsonb_build_object(
   'schemaVersion',1,'captureKind','issuance','capturedAt',statement_timestamp(),
   'settings',s,'profile',p.body,'profileVersion',p.version,
   'protocolNumber',coalesce(b.protocol_number,to_char(d,'DD.MM')),'protocolDate',d,
   'education',coalesce((select education from public.profiles where id=new.user_id),''),
   'photo', (select jsonb_build_object('objectKey',object_key,'legacyImported',legacy_imported) from private.profile_avatar_manifests where user_id=new.user_id)
 );
 return new;
end; $$;
revoke all on function private.capture_document_snapshot() from public,anon,authenticated,service_role;
-- Freeze existing render inputs before the new assets are installed. The
-- captureKind makes the provenance limitation explicit for future audits.
-- DDL takes an exclusive lock until this migration transaction commits; the
-- existing guard is restored before any concurrent writer can proceed.
alter table public.certificates disable trigger certificates_snapshot_guard;
update public.certificates c set document_snapshot=jsonb_build_object(
 'schemaVersion',1,'captureKind','legacy-cutover','capturedAt',statement_timestamp(),
 'settings',private.certificate_settings_payload(false),'profile',null,
 'protocolNumber',coalesce((select b.protocol_number from public.document_batches b where b.organization_key=lower(btrim(c.organization)) and b.course_slug=c.test_slug),to_char(c.issued_at at time zone 'Asia/Oral','DD.MM')),
 'protocolDate',coalesce((select b.document_date from public.document_batches b where b.organization_key=lower(btrim(c.organization)) and b.course_slug=c.test_slug),(c.issued_at at time zone 'Asia/Oral')::date),
 'education',coalesce((select education from public.profiles where id=c.user_id),''),
 'photo',(select jsonb_build_object('objectKey',object_key,'legacyImported',legacy_imported) from private.profile_avatar_manifests where user_id=c.user_id)
);
alter table public.certificates enable trigger certificates_snapshot_guard;
create trigger capture_document_snapshot before insert or update on public.certificates
 for each row execute function private.capture_document_snapshot();

alter function private.certificate_download_payload(uuid) rename to certificate_download_payload_before_document_snapshot;
create function private.certificate_download_payload(p_certificate_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.certificate_download_payload_before_document_snapshot(p_certificate_id)
   || jsonb_build_object('documentSnapshot',c.document_snapshot)
 from public.certificates c where id=p_certificate_id;
$$;
revoke all on function private.certificate_download_payload(uuid) from public,anon,authenticated,service_role;
revoke all on function private.certificate_download_payload_before_document_snapshot(uuid) from public,anon,authenticated,service_role;

create function public.select_document_profile(p_batch_id uuid,p_profile_id text,p_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.document_batches;
begin
 perform private.require_capability('site.settings.manage');
 perform private.require_capability('results.export');
 perform private.enforce_actor_quota('site.settings.update');
 update public.document_batches set profile_id=p_profile_id,version=version+1,updated_at=now()
 where id=p_batch_id and version=p_version and exists(
   select 1 from public.document_profiles p where p.id=p_profile_id and p.course_slug=document_batches.course_slug)
 returning * into b;
 if b.id is null then raise exception using errcode='40001',message='DOCUMENT_BATCH_CONFLICT'; end if;
 return to_jsonb(b);
end; $$;
revoke all on function public.select_document_profile(uuid,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.select_document_profile(uuid,text,bigint) to authenticated;

create function public.save_document_batch(p_organization text,p_course_slug text,p_date date,p_number text,p_automatic boolean,p_version bigint,p_profile_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb;
begin
 saved:=public.save_document_batch(p_organization,p_course_slug,p_date,p_number,p_automatic,p_version);
 if p_profile_id is not null and p_profile_id is distinct from saved->>'profile_id' then
   saved:=public.select_document_profile((saved->>'id')::uuid,p_profile_id,(saved->>'version')::bigint);
 end if;
 return saved;
end; $$;
revoke all on function public.save_document_batch(text,text,date,text,boolean,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.save_document_batch(text,text,date,text,boolean,bigint,text) to authenticated;

comment on column public.certificates.document_snapshot is 'Immutable render inputs; legacy-cutover records capture-time settings, not a claim about original issuance settings.';

-- The avatar object is already immutable. Retain it while a certificate refers
-- to it; account purge still deletes the owner's entire storage prefix.
alter function public.claim_profile_avatar_reconciliation(uuid,integer) rename to claim_profile_avatar_reconciliation_before_documents;
alter function public.claim_profile_avatar_reconciliation_before_documents(uuid,integer) set schema private;
create function public.claim_profile_avatar_reconciliation(p_worker_id uuid,p_limit integer default 50) returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(case when exists(
   select 1 from public.certificates c where c.user_id=(op->>'userId')::uuid
     and c.document_snapshot#>>'{photo,objectKey}'=op->>'previousObjectKey'
 ) then op||jsonb_build_object('previousObjectKey',null) else op end),'[]'::jsonb)
 from jsonb_array_elements(private.claim_profile_avatar_reconciliation_before_documents(p_worker_id,p_limit)) op;
$$;
revoke all on function private.claim_profile_avatar_reconciliation_before_documents(uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.claim_profile_avatar_reconciliation(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_profile_avatar_reconciliation(uuid,integer) to service_role;
