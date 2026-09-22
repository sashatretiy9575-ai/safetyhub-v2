-- The documents of a course of electrical safety.
--
-- The training centre's electrical papers are not the papers of every other
-- programme: the qualification check of «Правила работы с персоналом в
-- энергетических организациях Республики Казахстан» is a protocol per person,
-- numbered in the centre's journal, and the booklet states an admission —
-- a group, a voltage and the kind of personnel — instead of the usual
-- statements. This migration teaches the database that form:
--
-- 1. A new document family, `electrical`, with the wording and the term of
--    that form (a year until the next check).
-- 2. A course states the usual admission; an administrator may give one person
--    another group or another voltage from their card.
-- 3. A protocol of that family takes one person. A number typed as a plain
--    number continues as the journal does — 128, 129, 130 — and is never given
--    to two people of the same course; an automatic number keeps the shape
--    every other form uses («22.09», «22.09-2»).

-- 1. The form ---------------------------------------------------------------

create or replace function private.document_family_default(p_family text, p_audience text) returns jsonb
language sql immutable set search_path='' as $$
 select case coalesce(p_family,'general')
  when 'biot' then jsonb_build_object(
    'hours',case when p_audience='worker' then 10 else 40 end,'validityMonths',case when p_audience='worker' then 12 else 36 end,
    'verificationKind','периодический','trainingReason','',
    'protocolText','Проверка знаний по безопасности и охране труда проведена по утверждённой программе «{program}».',
    'decisionText','Лица, прошедшие проверку знаний, допускаются к самостоятельной работе. Не прошедшие проверку подлежат повторной проверке знаний по безопасности и охране труда.')
  when 'ptm' then jsonb_build_object(
    'hours',case when p_audience='worker' then 10 else 40 end,'validityMonths',case when p_audience='worker' then 12 else 36 end,
    'verificationKind','','trainingReason','Первичный',
    'protocolText','Экзамен по пожарной безопасности принят в объёме пожарно-технического минимума по утверждённой программе «{program}».',
    'decisionText','Лица, получившие положительные оценки, допускаются к самостоятельной работе, к выполнению (руководству) соответствующих работ на опасных производственных объектах.')
  when 'industrial' then jsonb_build_object(
    'hours',case when p_audience='worker' then 10 else 40 end,'validityMonths',36,
    'verificationKind','','trainingReason','',
    'protocolText','Проверка знаний проведена в соответствии с утверждённой программой «Подготовка, переподготовка специалистов, работников опасных производственных объектов по вопросам промышленной безопасности» на основании Закона Республики Казахстан от 11 апреля 2014 года № 188-V «О гражданской защите» — «{program}».',
    'decisionText','Лица, получившие положительные оценки, допускаются к самостоятельной работе, к выполнению (руководству) соответствующих работ на опасных производственных объектах.')
  when 'qualification' then jsonb_build_object(
    'hours',null,'validityMonths',0,'verificationKind','','trainingReason','',
    'protocolText','Подведены итоги профессиональной подготовки по специальности «{program}» и принято решение о выдаче свидетельства.',
    'decisionText','Квалификационная комиссия приняла решение о выдаче свидетельства по специальности.')
  when 'first-aid' then jsonb_build_object(
    'hours',8,'validityMonths',12,'verificationKind','','trainingReason','',
    'protocolText','Обучение проведено по утверждённой программе «{program}».',
    'decisionText','Лица, прошедшие обучение, допускаются к оказанию первой доврачебной помощи в объёме программы.')
  when 'electrical' then jsonb_build_object(
    'hours',null,'validityMonths',12,'verificationKind','очередная','trainingReason','',
    'protocolText','Квалификационная проверка знаний по электробезопасности проведена по программе «{program}».',
    'decisionText','Комиссия присвоила группу допуска по электробезопасности и допустила к работе в электроустановках.')
  else jsonb_build_object(
    'hours',null,'validityMonths',12,'verificationKind','','trainingReason','',
    'protocolText','Проверка знаний проведена по утверждённой программе учебного курса «{program}».',
    'decisionText','Лица, получившие положительные оценки, допускаются к самостоятельной работе, к выполнению (руководству) соответствующих работ на опасных производственных объектах.')
 end;
$$;

-- The lists the admission is chosen from; `lib/pdf/electrical.ts` repeats them.
create function private.valid_electrical_admission(v jsonb) returns boolean
language sql immutable set search_path='' as $$
 select jsonb_typeof(v) = 'object'
   and not exists(select 1 from jsonb_object_keys(v) k where k not in ('group','voltage','role'))
   and v->>'group' in ('II','III','IV','V')
   and v->>'voltage' in ('up-to-1000','above-1000')
   and v->>'role' in ('electrotechnical','electrotechnological','administrative','operational','maintenance');
$$;
revoke all on function private.valid_electrical_admission(jsonb) from public,anon,authenticated;

-- 2. A course of electrical safety ------------------------------------------

create or replace function private.valid_document_course(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text; c jsonb; t jsonb;
begin
 if jsonb_typeof(p) is distinct from 'object' then return false; end if;
 if exists(select 1 from jsonb_object_keys(p) key where key not in (
   'family','split','programName','protocolText','decisionText','orderNumber','orderDate',
   'verificationKind','booklet','electrical','categories')) then return false; end if;
 if coalesce(p->>'family','') not in ('general','biot','ptm','industrial','qualification','first-aid','electrical')
   or jsonb_typeof(p->'split') is distinct from 'boolean'
   or jsonb_typeof(p->'programName') is distinct from 'string'
   or char_length(btrim(p->>'programName')) not between 1 and 240 then return false; end if;
 -- One protocol per person: an electrical course is never split in two.
 if p->>'family' = 'electrical' and (p->>'split')::boolean then return false; end if;
 foreach k in array array['protocolText','decisionText','orderNumber','verificationKind'] loop
   if jsonb_typeof(p->k) is distinct from 'string'
     or char_length(p->>k) > (case k when 'orderNumber' then 100 when 'verificationKind' then 120 else 1000 end)
     or (k in ('orderNumber','verificationKind') and p->>k ~ '[[:cntrl:]]') then return false; end if;
 end loop;
 if jsonb_typeof(p->'orderDate') is distinct from 'string'
   or (p->>'orderDate' <> '' and p->>'orderDate' !~ '^\d{4}-\d{2}-\d{2}$') then return false; end if;
 if p->>'orderDate' <> '' then
   begin perform (p->>'orderDate')::date; exception when others then return false; end;
 end if;
 if jsonb_typeof(p->'electrical') not in ('null','object') then return false; end if;
 if jsonb_typeof(p->'electrical') = 'object' and not private.valid_electrical_admission(p->'electrical') then
   return false;
 end if;
 if jsonb_typeof(p->'booklet') not in ('null','object') then return false; end if;
 if jsonb_typeof(p->'booklet') = 'object' then
   t := p->'booklet'->'texts';
   if exists(select 1 from jsonb_object_keys(p->'booklet') key where key not in ('layout','texts'))
     or coalesce(p->'booklet'->>'layout','standard') <> 'standard'
     or jsonb_typeof(t) is distinct from 'object'
     or exists(select 1 from jsonb_object_keys(t) key where key not in ('examTextKk','examTextRu','knowledgeTextKk','knowledgeTextRu')) then
     return false;
   end if;
   foreach k in array array['examTextKk','examTextRu','knowledgeTextKk','knowledgeTextRu'] loop
     if jsonb_typeof(t->k) is distinct from 'string' or char_length(t->>k) > 1000 then return false; end if;
   end loop;
 end if;
 if jsonb_typeof(p->'categories') is distinct from 'object' then return false; end if;
 for k, c in select key, value from jsonb_each(p->'categories') loop
   if k not in ('all','itr','worker') or jsonb_typeof(c) is distinct from 'object'
     or exists(select 1 from jsonb_object_keys(c) key where key not in ('hours','validityMonths'))
     or coalesce(jsonb_typeof(c->'hours'),'null') not in ('null','number')
     or coalesce(jsonb_typeof(c->'validityMonths'),'null') not in ('null','number') then return false; end if;
   if jsonb_typeof(c->'hours') = 'number' and ((c->>'hours')::numeric <> trunc((c->>'hours')::numeric)
     or (c->>'hours')::numeric not between 1 and 5000) then return false; end if;
   if jsonb_typeof(c->'validityMonths') = 'number' and ((c->>'validityMonths')::numeric <> trunc((c->>'validityMonths')::numeric)
     or (c->>'validityMonths')::numeric not between 0 and 120) then return false; end if;
 end loop;
 return true;
end; $$;

create or replace function private.document_course_body(p_slug text, p_audience text, p jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object(
   'courseSlug', p_slug, 'audience', p_audience,
   'label', left(btrim(p->>'programName') || case p_audience
     when 'itr' then ' — ИТР' when 'worker' then ' — рабочий состав' else '' end, 200),
   'programName', btrim(p->>'programName'),
   'family', p->>'family',
   'hours', case when jsonb_typeof(c->'hours') = 'number' then c->'hours' else 'null'::jsonb end,
   'validityMonths', case when jsonb_typeof(c->'validityMonths') = 'number' then c->'validityMonths' else to_jsonb(0) end,
   'protocolText', btrim(p->>'protocolText'),
   'decisionText', btrim(p->>'decisionText'),
   'orderNumber', case when p->>'family' = 'biot' then btrim(p->>'orderNumber') else '' end,
   'orderDate', case when p->>'family' = 'biot' then p->>'orderDate' else '' end,
   'verificationKind', btrim(p->>'verificationKind'))
 || case when jsonb_typeof(c->'validityMonths') = 'number' and (c->>'validityMonths')::int = 0
      then jsonb_build_object('noExpiry', true) else '{}'::jsonb end
 || case when p->>'family' <> 'electrical' and jsonb_typeof(p->'booklet') = 'object'
      then jsonb_build_object('booklet', jsonb_build_object('layout', 'standard', 'texts', p->'booklet'->'texts'))
      else '{}'::jsonb end
 -- The booklet of an electrical course is the booklet of the energy rules, and
 -- it prints the admission rather than a wording of its own.
 || case when p->>'family' = 'electrical'
      then jsonb_build_object('electrical', case when private.valid_electrical_admission(p->'electrical')
        then p->'electrical'
        else jsonb_build_object('group','II','voltage','up-to-1000','role','electrotechnical') end)
      else '{}'::jsonb end
 from (select coalesce(p->'categories'->p_audience, '{}'::jsonb) as c) category;
$$;

-- 3. The number of a protocol that takes one person --------------------------

create or replace function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; p public.document_profiles; d date;
 c_max_participants constant integer := 50;
 v_org text := lower(btrim(new.organization)); v_course text; v_audience text;
 v_base text; v_number text; v_previous public.certificates; v_family text; v_part integer;
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
 v_family:=coalesce(p.body->>'family','general');
 if v_family='electrical' then
   -- The journal of the course is one for every company, so the lock is too.
   perform pg_advisory_xact_lock(hashtextextended('protocol:electrical|'||v_course,0));
   -- A corrected document keeps the sheet it replaces; so does a person reissued
   -- on the same day.
   if v_chosen_number is null then
     if new.issue_source='identity_correction' and v_previous.id is not null then
       v_number:=v_previous.document_snapshot->>'protocolNumber';
     else
       select c.document_snapshot->>'protocolNumber' into v_number
       from public.certificates c
       where (c.id=new.supersedes_certificate_id or (c.user_id=new.user_id and c.revoked_at is null))
         and c.test_slug=new.test_slug and c.document_snapshot->>'protocolDate'=d::text
         and c.document_snapshot#>>'{profile,id}' is not distinct from p.id
       order by (c.id=new.supersedes_certificate_id) desc, c.issued_at desc limit 1;
     end if;
   end if;
   if v_number is null then
     if v_base ~ '^[0-9]{1,9}$' then
       -- «128» runs on as the journal does: the first number from the one chosen
       -- that no document of this course holds.
       select min(candidate) into v_number
       from generate_series(v_base::bigint, v_base::bigint + 999) candidate
       where not exists (
         select 1 from public.certificates c
         where c.test_slug=new.test_slug
           and c.document_snapshot->>'protocolNumber'=candidate::text);
       if v_number is null then raise exception using errcode='22023', message='PROTOCOL_NUMBER_TAKEN'; end if;
     else
       select coalesce(max(private.protocol_part(c.document_snapshot->>'protocolNumber',v_base)),0)+1
       into v_part
       from public.certificates c
       where c.test_slug=new.test_slug and c.document_snapshot->>'protocolDate'=d::text
         and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null;
       v_number:=case when v_part<=1 then v_base else v_base||'-'||v_part::text end;
     end if;
   end if;
 else
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

-- The admission travels with the document: what the person was admitted to on
-- the day, not what the course states today.
create or replace function private.validate_document_issuance() returns trigger
language plpgsql security definer set search_path='' as $$
declare p jsonb:=new.document_snapshot->'profile'; details jsonb; signer jsonb; defaults jsonb;
 v_person text:=new.user_id::text; admission jsonb;
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
   if p->>'family'='electrical' then
     admission:=case when private.valid_electrical_admission(p->'electrical') then p->'electrical'
       else jsonb_build_object('group','II','voltage','up-to-1000','role','electrotechnical') end;
     details:=details||jsonb_build_object(
       'electricalGroup',case when details->>'electricalGroup' in ('II','III','IV','V')
         then details->>'electricalGroup' else admission->>'group' end,
       'electricalVoltage',case when details->>'electricalVoltage' in ('up-to-1000','above-1000')
         then details->>'electricalVoltage' else admission->>'voltage' end);
   end if;
 end if;
 new.document_snapshot:=new.document_snapshot||jsonb_build_object('participantFields',
   details||jsonb_build_object('notes',coalesce(btrim(details->>'notes'),'')));
 return new;
end; $$;

-- 4. The admission of one person --------------------------------------------

create function public.save_document_electrical(
  p_user_id uuid, p_course_slug text, p_group text, p_voltage text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_org text; v_key text := p_user_id::text;
begin
 v_actor := private.require_capability('certificate.issue');
 begin
 perform private.enforce_actor_quota('admin.attestation.mutate');
 if (p_group is not null and p_group not in ('II','III','IV','V'))
   or (p_voltage is not null and p_voltage not in ('up-to-1000','above-1000')) then
   raise exception using errcode='22023', message='DOCUMENT_ELECTRICAL_INVALID';
 end if;
 if not exists(select 1 from public.tests where slug=p_course_slug) then
   raise exception using errcode='P0002', message='COURSE_NOT_FOUND';
 end if;
 select btrim(organization) into v_org from public.profiles where id=p_user_id;
 if not found then raise exception using errcode='P0002', message='USER_NOT_FOUND'; end if;
 if coalesce(v_org,'')='' then raise exception using errcode='22023', message='DOCUMENT_COMPANY_NOT_FOUND'; end if;
 insert into public.document_batches(organization, course_slug, updated_by)
 values (v_org, p_course_slug, v_actor)
 on conflict (organization_key, course_slug) do nothing;
 -- Null is «as the course states it»: the key is removed rather than stored.
 update public.document_batches
 set participant_fields = participant_fields || jsonb_build_object(v_key,
       (coalesce(participant_fields->v_key, '{}'::jsonb)
         - (case when p_group is null then 'electricalGroup' else '' end)
         - (case when p_voltage is null then 'electricalVoltage' else '' end))
       || jsonb_strip_nulls(jsonb_build_object(
            'electricalGroup', p_group, 'electricalVoltage', p_voltage))),
     version = version + 1, updated_at = now(), updated_by = v_actor
 where organization_key = lower(v_org) and course_slug = p_course_slug;
 return jsonb_build_object('group', p_group, 'voltage', p_voltage);
 exception when others then
   return private.rpc_error_envelope(sqlstate, sqlerrm);
 end;
end; $$;
revoke all on function public.save_document_electrical(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.save_document_electrical(uuid,text,text,text) to authenticated;
