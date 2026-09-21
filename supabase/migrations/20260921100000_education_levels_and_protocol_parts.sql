-- Two answers to the training centre's review of 21 September 2026.
--
-- 1. The protocol's «Образование» column holds a level — «Высшее», «Среднее
--    специальное» — never the name of a school. The profile forms now offer the
--    four levels only; the database refuses anything else written from now on
--    and turns the older answers that already name a level into that level.
--    The list is mirrored in lib/profile/education.ts.
--
-- 2. A protocol lists at most fifty people: that is how many one commission
--    sitting takes. People issued the same day for the same company and course
--    still share one protocol; the fifty-first opens «DD.MM-2» with the same
--    date, the hundred-and-first «DD.MM-3». Mirrored by PROTOCOL_MAX_PARTICIPANTS
--    in lib/pdf/document-editor.ts.

create or replace function private.education_level(p_value text) returns text
language sql immutable set search_path='' as $$
 select case
   when v is null or v='' then null
   when v in ('высшее','неоконченное высшее','среднее специальное','среднее')
     then (array['Высшее','Неоконченное высшее','Среднее специальное','Среднее'])
          [array_position(array['высшее','неоконченное высшее','среднее специальное','среднее'],v)]
   when v ~ '(неоконч|незаконч|неполн)[^,;]*высш' then 'Неоконченное высшее'
   when v ~ 'высш' then 'Высшее'
   when v ~ '(средн[^,;]*(спец|проф|техн)|колледж|техникум|училищ)' then 'Среднее специальное'
   when v ~ 'средн' then 'Среднее'
 end
 from (select lower(btrim(regexp_replace(coalesce(p_value,''),'\s+',' ','g'))) as v) s;
$$;
revoke all on function private.education_level(text) from public,anon,authenticated,service_role;

-- Older answers that already say the level become exactly that level. A school's
-- name is left as it is: the person picks a level the next time they save, and
-- documents already issued keep the value frozen in their snapshot.
update public.profiles
set education=private.education_level(education)
where private.education_level(education) is not null
  and education is distinct from private.education_level(education);

create or replace function private.normalize_profile_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Anything outside Latin, Cyrillic, their combining marks, digits and the few
  -- marks a name really carries. Han, kana and emoji land here; Kazakh ә, ғ, қ,
  -- ң, ө, ұ, ү, һ, і and a Turkish ş do not.
  c_foreign_script constant text :=
    '[^ ''’.0-9A-Za-zÀ-˿̀-ͯЀ-ԯḀ-ỿ-]';
begin
  new.name := private.normalize_profile_text(new.name);
  new.surname := private.normalize_profile_text(new.surname);
  new.job := private.normalize_profile_text(new.job);
  new.organization := private.normalize_profile_text(new.organization);
  new.education := private.normalize_profile_text(new.education);
  if new.name ~ '[[:cntrl:]]' or new.surname ~ '[[:cntrl:]]'
    or new.job ~ '[[:cntrl:]]' or new.organization ~ '[[:cntrl:]]'
    or new.education ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation', message = 'PROFILE_CONTROL_CHARACTER';
  end if;
  -- Only a value this statement actually changes is judged, so the rows that
  -- already hold a Chinese name keep being read and keep accepting a write to
  -- any other column — education above all. A job title and a company are left
  -- alone: a real company name is written in Russian.
  if (tg_op = 'INSERT' or new.name is distinct from old.name)
    and new.name ~ c_foreign_script then
    raise exception using errcode = 'check_violation', message = 'PROFILE_NAME_SCRIPT';
  end if;
  if (tg_op = 'INSERT' or new.surname is distinct from old.surname)
    and new.surname ~ c_foreign_script then
    raise exception using errcode = 'check_violation', message = 'PROFILE_NAME_SCRIPT';
  end if;
  -- The same rule for education: a new answer is one of the four levels, while
  -- an older school name stays readable until the person replaces it.
  if coalesce(new.education, '') <> ''
    and (tg_op = 'INSERT' or new.education is distinct from old.education)
    and new.education not in ('Высшее', 'Неоконченное высшее', 'Среднее специальное', 'Среднее') then
    raise exception using errcode = 'check_violation', message = 'PROFILE_EDUCATION_LEVEL';
  end if;
  return new;
end;
$$;

create or replace function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; b public.document_batches; p public.document_profiles; d date;
 c_max_participants constant integer := 50;
 v_org text := lower(btrim(new.organization)); v_base text; v_number text; v_people integer;
begin
 if tg_op='UPDATE' then
   if new.document_snapshot is distinct from old.document_snapshot then raise exception 'DOCUMENT_SNAPSHOT_IMMUTABLE'; end if;
   return new;
 end if;
 select private.certificate_settings_payload(false) into s;
 select * into b from public.document_batches where organization_key=v_org and course_slug=new.test_slug;
 if b.profile_id is not null then select * into p from public.document_profiles where id=b.profile_id and course_slug=new.test_slug; end if;
 if p.id is null then select * into p from public.document_profiles where course_slug=new.test_slug and audience='all'; end if;
 if p.id is null then
   select * into p from public.document_profiles
   where course_slug=new.test_slug and audience=private.document_audience_for_position(new.job);
 end if;
 if exists(select 1 from public.document_profiles where course_slug=new.test_slug) and p.id is null then
   raise exception using errcode='22023', message='DOCUMENT_PROFILE_REQUIRED';
 end if;
 d:=coalesce(b.document_date,(new.issued_at at time zone 'Asia/Oral')::date);
 v_base:=coalesce(b.protocol_number,to_char(d,'DD.MM'));
 -- One sitting at a time: two issuances for the same protocol must not both
 -- count forty-nine and both take the fiftieth place.
 perform pg_advisory_xact_lock(hashtextextended('protocol:'||v_org||'|'||new.test_slug||'|'||d::text,0));
 -- A reissue on the same day — a better score, a corrected name — stays on
 -- the protocol the person is already on instead of taking a second place. The
 -- certificate it replaces is revoked a moment earlier, so it is found by the
 -- link the reissue carries rather than by being active.
 select c.document_snapshot->>'protocolNumber' into v_number
 from public.certificates c
 where (c.id=new.supersedes_certificate_id or (c.user_id=new.user_id and c.revoked_at is null))
   and c.test_slug=new.test_slug and lower(btrim(c.organization))=v_org
   and c.document_snapshot->>'protocolDate'=d::text
   and (c.document_snapshot->>'protocolNumber'=v_base or c.document_snapshot->>'protocolNumber' like v_base||'-%')
 order by (c.id=new.supersedes_certificate_id) desc, c.issued_at desc limit 1;
 if v_number is null then
   select count(distinct c.user_id) into v_people
   from public.certificates c
   where c.test_slug=new.test_slug and lower(btrim(c.organization))=v_org and c.revoked_at is null
     and c.document_snapshot->>'protocolDate'=d::text
     and (c.document_snapshot->>'protocolNumber'=v_base or c.document_snapshot->>'protocolNumber' like v_base||'-%');
   v_number:=case when v_people<c_max_participants then v_base
                  else v_base||'-'||(v_people/c_max_participants+1)::text end;
 end if;
 new.document_snapshot:=jsonb_build_object(
   'schemaVersion',1,'captureKind','issuance','capturedAt',statement_timestamp(),
   'settings',s,'profile',private.complete_document_profile(p.body),'profileVersion',p.version,
   'protocolNumber',v_number,'protocolDate',d,
   'education',coalesce((select education from public.profiles where id=new.user_id),''),
   'photo', (select jsonb_build_object('objectKey',object_key,'legacyImported',legacy_imported) from private.profile_avatar_manifests where user_id=new.user_id)
 );
 return new;
end; $$;
