-- The documents admin becomes three steps: set a course up once, issue, download
-- one archive. The data underneath is made to match.
--
-- 1. One commission and one stamp for every course. The ten profiles each kept
--    a copy of the same three people and the same stamp, and none of the copies
--    could be edited from the admin. The commission now lives once, on the
--    settings row «Общее» (versioned and archived like the rest of it), and is
--    written into the profile of each document at the moment it is issued, so
--    an issued document never changes when the commission does.
-- 2. Every course has document settings. A course created in the admin used to
--    get none and printed by the old global rules; now it starts with the
--    general form, and a renamed course keeps its settings.
-- 3. «ИТР» or «рабочий» is a property of the person, not of the company: an
--    administrator may override what the position says for one person. The
--    company-wide category, which could not even be switched back, is retired.
-- 4. The protocol date and number are chosen when the documents are issued. A
--    date saved once for a company used to stick to every later issuance for
--    that company and course, back-dating documents issued weeks later.
-- 5. A validity of 0 months could never be chosen: 0 meant "the form's default".
--    `noExpiry` now says "no term" explicitly.

-- 1. The shared commission -------------------------------------------------

create function private.valid_document_commission(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare s jsonb; ids text[] := '{}';
begin
 if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v->'signers') is distinct from 'array' then return false; end if;
 if exists(select 1 from jsonb_object_keys(v) k where k not in ('signers','stampAssetId')) then return false; end if;
 if jsonb_array_length(v->'signers') not between 1 and 6 then return false; end if;
 if coalesce(jsonb_typeof(v->'stampAssetId'),'null') not in ('null','string')
   or coalesce(v->>'stampAssetId','00000000-0000-0000-0000-000000000000') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   return false;
 end if;
 for s in select value from jsonb_array_elements(v->'signers') loop
   if jsonb_typeof(s) is distinct from 'object'
     or exists(select 1 from jsonb_object_keys(s) k where k not in ('signerId','name','position','assetId'))
     or jsonb_typeof(s->'signerId') is distinct from 'string' or s->>'signerId' !~ '^[a-z][a-z0-9-]{1,79}$'
     or jsonb_typeof(s->'name') is distinct from 'string' or char_length(btrim(s->>'name')) not between 1 and 200
     or jsonb_typeof(s->'position') is distinct from 'string' or char_length(s->>'position') > 200
     or coalesce(jsonb_typeof(s->'assetId'),'null') not in ('null','string')
     or coalesce(s->>'assetId','00000000-0000-0000-0000-000000000000') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or (s->>'signerId') = any(ids) then
     return false;
   end if;
   ids := ids || (s->>'signerId');
 end loop;
 return true;
end; $$;
revoke all on function private.valid_document_commission(jsonb) from public,anon,authenticated;

alter table public.certificate_settings add column document_commission jsonb;

-- The payload every reader gets, the snapshot included.
create or replace function private.certificate_settings_payload(p_include_images boolean) returns jsonb
language sql stable set search_path='' as $$
 select private.certificate_settings_payload_v1(p_include_images) || jsonb_build_object(
   'documentDefaults',document_defaults,
   'documentCommission',document_commission,
   'hasProtocolSignature',protocol_signature_png is not null,
   'protocolSignaturePng',case when p_include_images then protocol_signature_png else null end)
 from public.certificate_settings where singleton;
$$;
revoke all on function private.certificate_settings_payload(boolean) from public,anon,authenticated,service_role;

-- The commission every profile already agrees on; on a database that never
-- had profiles, the people the settings row names, without signatures yet.
update public.certificate_settings set
  document_commission = coalesce(
    (select jsonb_build_object('signers', body->'commission', 'stampAssetId', body->'stampAssetId')
     from public.document_profiles
     where jsonb_typeof(body->'commission') = 'array'
       and private.valid_document_commission(
         jsonb_build_object('signers', body->'commission', 'stampAssetId', body->'stampAssetId'))
     group by 1 order by count(*) desc, min(id) limit 1),
    jsonb_build_object(
      'signers', (
        select jsonb_agg(person order by place) from (
          select 0 as place, jsonb_build_object(
            'signerId', 'chairman',
            'name', coalesce(nullif(btrim(chairman_name), ''), 'Председатель комиссии'),
            'position', left(chairman_position, 200),
            'assetId', null) as person
          union all
          select member.place, jsonb_build_object(
            'signerId', 'member-' || member.place,
            'name', left(btrim(member.value->>'name'), 200),
            'position', left(coalesce(member.value->>'position', ''), 200),
            'assetId', null)
          from jsonb_array_elements(document_defaults->'commission') with ordinality member(value, place)
          where btrim(coalesce(member.value->>'name', '')) <> '' and member.place <= 5
        ) people),
      'stampAssetId', null)),
  version = version + 1,
  updated_at = statement_timestamp()
where singleton;

alter table public.certificate_settings alter column document_commission set not null;
alter table public.certificate_settings add constraint document_commission_valid
  check (private.valid_document_commission(document_commission));


-- Profiles stop carrying their own copy of it.
update public.document_profiles
set body = body - 'commission' - 'stampAssetId', version = version + 1, updated_at = now()
where body ? 'commission' or body ? 'stampAssetId';

-- 5. «Без срока» ------------------------------------------------------------

-- A stored value always wins; only a blank is filled in. `noExpiry` is the one
-- way to say "no term" for a form that has one by default.
create or replace function private.complete_document_profile(p jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when p is null or p='null'::jsonb then p else p||jsonb_strip_nulls(jsonb_build_object(
   'validityMonths',case
     when coalesce((p->>'noExpiry')::boolean,false) then to_jsonb(0)
     when coalesce((p->>'validityMonths')::int,0)=0 then d->'validityMonths'
     else null end,
   'verificationKind',case when coalesce(btrim(p->>'verificationKind'),'')='' then d->'verificationKind' else null end,
   'protocolText',case when coalesce(btrim(p->>'protocolText'),'')='' then d->'protocolText' else null end,
   'decisionText',case when coalesce(btrim(p->>'decisionText'),'')='' then d->'decisionText' else null end
 ))||case when coalesce((p->>'hours')::int,0)=0 then jsonb_build_object('hours',d->'hours') else '{}'::jsonb end end
 from (select private.document_family_default(p->>'family',p->>'audience') d) t;
$$;
revoke all on function private.complete_document_profile(jsonb) from public,anon,authenticated,service_role;

-- The profile as it is printed: its own wording completed, and the commission
-- of the day written in.
create function private.complete_document_profile(p jsonb, c jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when p is null or p='null'::jsonb then p
   else private.complete_document_profile(p)||case when c is null then '{}'::jsonb
     else jsonb_build_object('commission',c->'signers','stampAssetId',c->'stampAssetId') end end;
$$;
revoke all on function private.complete_document_profile(jsonb,jsonb) from public,anon,authenticated,service_role;

-- 2. Every course has document settings -------------------------------------

-- A course renamed with a redirect keeps the profiles written for its old name.
update public.document_profiles profile
set course_slug = course.slug,
    body = profile.body || jsonb_build_object('courseSlug', course.slug),
    version = profile.version + 1, updated_at = now()
from public.course_slug_redirects redirect
join public.tests course on course.id = redirect.test_id
where profile.course_slug = redirect.old_slug
  and not exists (select 1 from public.tests t where t.slug = profile.course_slug)
  and not exists (select 1 from public.document_profiles taken
                  where taken.course_slug = course.slug and taken.audience = profile.audience);

-- 3. The company-wide category is retired; nothing reads it any more.
update public.document_batches set profile_id = null where profile_id is not null;
alter table public.document_batches drop constraint document_batches_profile_id_fkey;
alter table public.document_batches add constraint document_batches_profile_id_fkey
  foreign key (profile_id) references public.document_profiles(id) on delete set null;

-- A profile of a course that no longer exists under any name cannot be issued
-- from: issuance looks profiles up by the course of the certificate. Issued
-- documents carry their own copy of it.
do $$
declare v_removed integer;
begin
  delete from public.document_profiles profile
  where not exists (select 1 from public.tests t where t.slug = profile.course_slug);
  get diagnostics v_removed = row_count;
  if v_removed > 0 then raise notice 'document profiles of missing courses removed: %', v_removed; end if;
end $$;

alter table public.document_profiles add constraint document_profiles_course_slug_fkey
  foreign key (course_slug) references public.tests(slug) on update cascade on delete cascade;

-- The id a new profile gets: readable, and never one already taken.
create function private.document_profile_id(p_slug text, p_audience text) returns text
language sql volatile set search_path='' as $$
 select case when not exists(select 1 from public.document_profiles where id = base) then base
   else left(base, 110) || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8) end
 from (select left(case when p_slug ~ '^[a-z]' then p_slug else 'course-' || p_slug end, 100)
   || '-' || p_audience as base) b;
$$;
revoke all on function private.document_profile_id(text,text) from public,anon,authenticated,service_role;

-- What a course starts with: the general form, one category, every text taken
-- from the form until somebody writes their own.
create function private.default_document_profile_body(p_slug text, p_title text) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object(
   'courseSlug', p_slug, 'audience', 'all',
   'label', left(coalesce(nullif(btrim(p_title), ''), p_slug), 200),
   'programName', left(coalesce(nullif(btrim(p_title), ''), p_slug), 240),
   'family', 'general', 'hours', null, 'validityMonths', 0,
   'protocolText', '', 'decisionText', '', 'orderNumber', '', 'orderDate', '', 'verificationKind', '');
$$;
revoke all on function private.default_document_profile_body(text,text) from public,anon,authenticated,service_role;

create function private.create_course_document_profile() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_id text;
begin
 if not exists (select 1 from public.document_profiles where course_slug = new.slug) then
   v_id := private.document_profile_id(new.slug, 'all');
   insert into public.document_profiles(id, course_slug, audience, body)
   values (v_id, new.slug, 'all',
     private.default_document_profile_body(new.slug, new.title) || jsonb_build_object('id', v_id));
 end if;
 return new;
end; $$;
revoke all on function private.create_course_document_profile() from public,anon,authenticated,service_role;
create trigger tests_create_document_profile after insert on public.tests
 for each row execute function private.create_course_document_profile();

do $$
declare v_course record; v_id text;
begin
  for v_course in
    select t.slug, t.title from public.tests t
    where not exists (select 1 from public.document_profiles p where p.course_slug = t.slug)
    order by t.slug
  loop
    v_id := private.document_profile_id(v_course.slug, 'all');
    insert into public.document_profiles(id, course_slug, audience, body)
    values (v_id, v_course.slug, 'all',
      private.default_document_profile_body(v_course.slug, v_course.title) || jsonb_build_object('id', v_id));
  end loop;
end $$;

-- 3. The category of a person ------------------------------------------------

alter table public.profiles add column document_audience text
  check (document_audience in ('itr','worker'));
comment on column public.profiles.document_audience is
  'ИТР or рабочий for split programmes, set by an administrator; null means the position decides.';

-- The course a certificate belongs to under its present name: a certificate
-- records the slug of the revision it was issued from, which a rename leaves behind.
create function private.certificate_course_slug(p_revision_id uuid, p_fallback text) returns text
language sql stable set search_path='' as $$
 select coalesce(
   (select course.slug from public.test_revisions revision
    join public.tests course on course.id = revision.test_id
    where revision.id = p_revision_id),
   p_fallback);
$$;
revoke all on function private.certificate_course_slug(uuid,text) from public,anon,authenticated,service_role;

-- 4. The protocol of the sitting ---------------------------------------------

-- A protocol number with its part: «21.09», «21.09-2». Custom numbers may hold
-- any character, so the base is matched by position, never by LIKE.
create function private.protocol_part(p_number text, p_base text) returns integer
language sql immutable set search_path='' as $$
 select case
   when p_number = p_base then 1
   when left(p_number, char_length(p_base) + 1) = p_base || '-'
     and substr(p_number, char_length(p_base) + 2) ~ '^[0-9]{1,4}$'
     then substr(p_number, char_length(p_base) + 2)::integer
   else null end;
$$;
revoke all on function private.protocol_part(text,text) from public,anon,authenticated,service_role;

create or replace function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; p public.document_profiles; d date;
 c_max_participants constant integer := 50;
 v_org text := lower(btrim(new.organization)); v_course text; v_audience text;
 v_base text; v_number text; v_previous public.certificates;
 v_chosen_date text := nullif(current_setting('safetyhub.document_date', true), '');
 v_chosen_number text := nullif(btrim(current_setting('safetyhub.protocol_number', true)), '');
begin
 if tg_op='UPDATE' then
   if new.document_snapshot is distinct from old.document_snapshot then raise exception 'DOCUMENT_SNAPSHOT_IMMUTABLE'; end if;
   return new;
 end if;
 select private.certificate_settings_payload(false) into s;
 v_course := private.certificate_course_slug(new.revision_id, new.test_slug);
 -- One category: everybody is on it. «ИТР» and «рабочие»: the administrator's
 -- choice for the person, otherwise what the position says.
 select * into p from public.document_profiles where course_slug=v_course and audience='all';
 if p.id is null then
   v_audience := coalesce(
     (select document_audience from public.profiles where id=new.user_id),
     private.document_audience_for_position(new.job));
   select * into p from public.document_profiles where course_slug=v_course and audience=v_audience;
 end if;
 if exists(select 1 from public.document_profiles where course_slug=v_course) and p.id is null then
   raise exception using errcode='22023', message='DOCUMENT_PROFILE_REQUIRED';
 end if;
 if new.supersedes_certificate_id is not null then
   select * into v_previous from public.certificates where id=new.supersedes_certificate_id;
 end if;
 -- The date the administrator chose when issuing; a corrected name or company
 -- stays on the sitting of the document it replaces; otherwise the day of issue.
 d:=coalesce(
   v_chosen_date::date,
   case when new.issue_source='identity_correction' then (v_previous.document_snapshot->>'protocolDate')::date end,
   (new.issued_at at time zone 'Asia/Oral')::date);
 v_base:=coalesce(v_chosen_number,to_char(d,'DD.MM'));
 -- One sitting at a time: two issuances for the same protocol must not both
 -- count forty-nine and both take the fiftieth place.
 perform pg_advisory_xact_lock(hashtextextended('protocol:'||v_org||'|'||new.test_slug||'|'||d::text,0));
 -- A corrected document of the same company and category keeps its number.
 if new.issue_source='identity_correction' and v_chosen_number is null
   and v_previous.id is not null and lower(btrim(v_previous.organization))=v_org
   and v_previous.document_snapshot->>'protocolDate'=d::text
   and v_previous.document_snapshot#>>'{profile,id}' is not distinct from p.id then
   v_number:=v_previous.document_snapshot->>'protocolNumber';
 end if;
 -- A reissue on the same day stays on the protocol the person is already on.
 if v_number is null then
   select c.document_snapshot->>'protocolNumber' into v_number
   from public.certificates c
   where (c.id=new.supersedes_certificate_id or (c.user_id=new.user_id and c.revoked_at is null))
     and c.test_slug=new.test_slug and lower(btrim(c.organization))=v_org
     and c.document_snapshot->>'protocolDate'=d::text
     and c.document_snapshot#>>'{profile,id}' is not distinct from p.id
     and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null
   order by (c.id=new.supersedes_certificate_id) desc, c.issued_at desc limit 1;
 end if;
 if v_number is null then
   -- «ИТР» and «рабочий состав» sit on protocols of their own, as the centre
   -- prints them: a protocol takes one listener category and at most fifty
   -- people. The person joins the last protocol of their category that still
   -- has room; otherwise the day's next number opens.
   with protocols as (
     select c.document_snapshot->>'protocolNumber' as num,
            c.document_snapshot#>>'{profile,id}' as profile_id,
            count(distinct c.user_id) filter (where c.revoked_at is null) as people,
            private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) as part
     from public.certificates c
     where c.test_slug=new.test_slug and lower(btrim(c.organization))=v_org
       and c.document_snapshot->>'protocolDate'=d::text
       and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null
     group by 1,2
   )
   select coalesce(
     (select num from protocols
      where profile_id is not distinct from p.id and people<c_max_participants
      order by part desc limit 1),
     case when not exists(select 1 from protocols) then v_base
          else v_base||'-'||((select max(part) from protocols)+1)::text end)
   into v_number;
 end if;
 new.document_snapshot:=jsonb_build_object(
   'schemaVersion',1,'captureKind','issuance','capturedAt',statement_timestamp(),
   'settings',s,
   'profile',private.complete_document_profile(
     case when p.id is null then null
       else p.body||jsonb_build_object('id',p.id,'courseSlug',p.course_slug,'audience',p.audience) end,
     (select document_commission from public.certificate_settings where singleton)),
   'profileVersion',p.version,
   'protocolNumber',v_number,'protocolDate',d,
   'education',coalesce((select education from public.profiles where id=new.user_id),''),
   'photo', (select jsonb_build_object('objectKey',object_key,'legacyImported',legacy_imported) from private.profile_avatar_manifests where user_id=new.user_id)
 );
 return new;
end; $$;

-- A person's note follows them within the course: it is found in whichever
-- company's record of the course holds it, the present company first.
create or replace function private.validate_document_issuance() returns trigger
language plpgsql security definer set search_path='' as $$
declare p jsonb:=new.document_snapshot->'profile'; details jsonb; signer jsonb; defaults jsonb;
 v_person text:=new.user_id::text;
begin
 select participant_fields->v_person into details from public.document_batches
 where course_slug=private.certificate_course_slug(new.revision_id,new.test_slug)
   and participant_fields ? v_person
 order by (organization_key=lower(btrim(new.organization))) desc, updated_at desc limit 1;
 details:=coalesce(details,'{}'::jsonb);
 if p is not null and p<>'null'::jsonb then
   if coalesce(btrim(new.organization),'')='' or coalesce(btrim(new.job),'')='' then raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:organization,position'; end if;
   for signer in select value from jsonb_array_elements(coalesce(p->'commission','[]'::jsonb)) loop
     if signer->>'assetId' is not null and not exists(select 1 from public.document_assets a where a.id=(signer->>'assetId')::uuid and a.owner_id=signer->>'signerId' and a.kind='signature') then raise exception 'DOCUMENT_SIGNER_ASSET_MISMATCH'; end if;
   end loop;
   defaults:=private.document_family_default(p->>'family',p->>'audience');
   if coalesce(btrim(details->>'trainingReason'),'')='' then details:=details||jsonb_build_object('trainingReason',defaults->>'trainingReason'); end if;
   if p->>'family'='qualification' and coalesce(btrim(details->>'qualificationDecision'),'')='' then
     details:=details||jsonb_build_object('qualificationDecision',coalesce(p->>'programName',''));
   end if;
 end if;
 new.document_snapshot:=new.document_snapshot||jsonb_build_object('participantFields',
   details||jsonb_build_object('notes',coalesce(btrim(details->>'notes'),'')));
 return new;
end; $$;

-- The date and number the administrator chose reach the trigger through two
-- transaction-local settings: nothing is stored that a later issuance could
-- pick up by accident. Both are part of the request, so a replay with other
-- values is refused; they enter the hash only when given, which leaves the
-- hashes of every earlier request unchanged.
drop function public.execute_admin_attestation_action(uuid,text,uuid[],text,text,text);
create function public.execute_admin_attestation_action(
  p_idempotency_key uuid,
  p_action text,
  p_target_ids uuid[],
  p_field text default null,
  p_value text default null,
  p_reason text default null,
  p_document_date date default null,
  p_protocol_number text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capability text := case p_action
    when 'issue' then 'certificate.issue'
    when 'confirm_and_issue' then 'certificate.issue'
    when 'revoke' then 'certificate.revoke'
    else 'identity.manage'
  end;
  v_actor_id uuid := private.require_capability(v_capability);
  v_targets jsonb;
  v_request_hash text;
  v_receipt private.admin_operation_receipts%rowtype;
  v_items jsonb;
  v_completed integer;
  v_skipped integer;
  v_number text := nullif(btrim(p_protocol_number), '');
begin
  if p_idempotency_key is null
     or p_action not in ('confirm', 'update', 'issue', 'revoke', 'confirm_and_issue')
     or cardinality(p_target_ids) not between 1 and 500
     or (select count(*) from unnest(p_target_ids) target)
       <> (select count(distinct target) from unnest(p_target_ids) target) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_BULK_OPERATION';
  end if;
  if p_action = 'confirm_and_issue' then
    perform private.require_capability('identity.manage');
  end if;
  if p_document_date is not null and (
    p_document_date > (statement_timestamp() at time zone 'Asia/Oral')::date
    or p_document_date < date '2020-01-01') then
    raise exception using errcode = 'invalid_parameter_value', message = 'DOCUMENT_DATE_INVALID';
  end if;
  if v_number is not null and (char_length(v_number) > 40 or v_number ~ '[[:cntrl:]]') then
    raise exception using errcode = 'invalid_parameter_value', message = 'PROTOCOL_NUMBER_INVALID';
  end if;

  select jsonb_agg(target order by target::text) into v_targets
  from unnest(p_target_ids) target;
  v_request_hash := encode(extensions.digest(convert_to(
    (jsonb_build_object(
      'action', p_action,
      'targets', v_targets,
      'field', p_field,
      'value', p_value,
      'reason', p_reason
    ) || jsonb_strip_nulls(jsonb_build_object(
      'documentDate', p_document_date,
      'protocolNumber', v_number
    )))::text,
    'utf8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_idempotency_key::text,
    0
  ));

  select * into v_receipt
  from private.admin_operation_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  perform private.enforce_actor_quota(
    case when p_action = 'revoke'
      then 'admin.certificate.revoke'
      else 'admin.attestation.mutate'
    end
  );

  if p_action in ('issue', 'confirm_and_issue') then
    perform set_config('safetyhub.document_date', coalesce(p_document_date::text, ''), true);
    perform set_config('safetyhub.protocol_number', coalesce(v_number, ''), true);
  end if;

  if p_action = 'confirm' then
    v_items := private.sanitize_bulk_mutation_result(
      private.confirm_admin_identities_unmetered(p_target_ids)
    );
  elsif p_action = 'update' then
    if p_field not in ('name', 'surname', 'job', 'organization')
       or nullif(btrim(p_value), '') is null then
      raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_PROFILE_UPDATE';
    end if;
    v_items := private.sanitize_bulk_mutation_result(
      private.bulk_update_participants_unmetered(p_target_ids, p_field, p_value)
    );
  elsif p_action = 'issue' then
    v_items := private.sanitize_bulk_mutation_result(
      private.issue_certificates_unmetered(p_target_ids)
    );
  elsif p_action = 'confirm_and_issue' then
    v_items := private.sanitize_bulk_mutation_result(
      private.confirm_and_issue_certificates_unmetered(p_target_ids)
    );
  else
    if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
      raise exception using errcode = 'invalid_parameter_value', message = 'REVOKE_REASON_REQUIRED';
    end if;
    v_items := private.sanitize_bulk_mutation_result(
      private.revoke_certificates_unmetered(p_target_ids, p_reason)
    );
  end if;

  perform set_config('safetyhub.document_date', '', true);
  perform set_config('safetyhub.protocol_number', '', true);

  select
    count(*) filter (where item ->> 'status' = 'completed'),
    count(*) filter (where item ->> 'status' in ('skipped', 'failed', 'rejected'))
  into v_completed, v_skipped
  from jsonb_array_elements(v_items) item;

  v_receipt.result := jsonb_build_object(
    'operationId', p_idempotency_key,
    'action', p_action,
    'replayed', false,
    'items', v_items
  );

  insert into private.admin_operation_receipts (
    actor_user_id, idempotency_key, action, request_hash, result
  ) values (
    v_actor_id, p_idempotency_key, p_action, v_request_hash, v_receipt.result
  );

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, reason, batch_id
  ) values (
    v_actor_id,
    'attestation.bulk.' || p_action,
    'bulk_operation',
    p_idempotency_key::text,
    jsonb_build_object(
      'requested', cardinality(p_target_ids),
      'completed', coalesce(v_completed, 0),
      'skipped', coalesce(v_skipped, 0),
      'field', p_field
    ),
    case when p_action = 'revoke' then p_reason else null end,
    p_idempotency_key
  );

  return private.ensure_rpc_payload(v_receipt.result);
end;
$$;

revoke execute on function public.execute_admin_attestation_action(
  uuid,text,uuid[],text,text,text,date,text
) from public, anon, service_role;
grant execute on function public.execute_admin_attestation_action(
  uuid,text,uuid[],text,text,text,date,text
) to authenticated;

-- A person without a company or a position is a refusal the administrator can
-- act on — open the card and fill them in — so it reaches the list by name.
create or replace function private.sanitize_bulk_mutation_result(p_payload jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_payload) <> 'array' then p_payload
    else coalesce((
      select jsonb_agg(
        case
          when jsonb_typeof(item.value) = 'object'
            and item.value ->> 'status' = 'skipped'
            and item.value ? 'reason'
          then jsonb_set(
            item.value,
            '{reason}',
            to_jsonb(case
              when coalesce(item.value ->> 'reason', '')
                ~ '^[A-Z][A-Z0-9_]{1,95}(:[0-9]{1,10})?$'
                or item.value->>'reason' in (
                  'DOCUMENT_REQUIRED_FIELDS:education',
                  'DOCUMENT_REQUIRED_FIELDS:organization,position')
              then item.value ->> 'reason'
              else 'OPERATION_SKIPPED'
            end),
            false
          )
          else item.value
        end
        order by item.ordinality
      )
      from jsonb_array_elements(p_payload) with ordinality as item(value, ordinality)
    ), '[]'::jsonb)
  end;
$$;

-- Notes are kept per person in the company's record of a course; that record no
-- longer needs a date or a number of its own.
alter table public.document_batches alter column document_date drop not null;
alter table public.document_batches alter column protocol_number drop not null;
