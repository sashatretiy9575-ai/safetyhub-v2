-- The training centre prints «ИТР» and «рабочий состав» on separate protocols
-- for БиОТ, промышленная безопасность and ПТМ, with the volume the law sets for
-- each: 40 hours for engineers and managers, 10 for workers.
--
-- 1. БиОТ now states those hours too (ПТМ and промбез already did). The twin is
--    lib/pdf/document-family-defaults.ts.
-- 2. At issue, each listener category gets protocols of its own: the engineers
--    of a company, course and day share «21.09», the workers open «21.09-2»,
--    and a fifty-first person of either category opens the next number.
-- 3. An administrator downloads any course presentation without applying for
--    the course: the gate asked every account for an approved application, and
--    an administrator's own account never has one.

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
  else jsonb_build_object(
    'hours',null,'validityMonths',12,'verificationKind','','trainingReason','',
    'protocolText','Проверка знаний проведена по утверждённой программе учебного курса «{program}».',
    'decisionText','Лица, получившие положительные оценки, допускаются к самостоятельной работе, к выполнению (руководству) соответствующих работ на опасных производственных объектах.')
 end;
$$;

create or replace function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; b public.document_batches; p public.document_profiles; d date;
 c_max_participants constant integer := 50;
 v_org text := lower(btrim(new.organization)); v_base text; v_number text;
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
   -- «ИТР» and «рабочий состав» sit on protocols of their own, as the centre
   -- prints them: a protocol takes one listener category and at most fifty
   -- people. The person joins the last protocol of their category that still
   -- has room; otherwise the day's next number opens.
   with protocols as (
     select c.document_snapshot->>'protocolNumber' as num,
            c.document_snapshot->'profile'->>'id' as profile_id,
            count(distinct c.user_id) filter (where c.revoked_at is null) as people,
            case when c.document_snapshot->>'protocolNumber'=v_base then 1
                 when substr(c.document_snapshot->>'protocolNumber',length(v_base)+2) ~ '^[0-9]{1,4}$'
                   then substr(c.document_snapshot->>'protocolNumber',length(v_base)+2)::int
                 else 0 end as part
     from public.certificates c
     where c.test_slug=new.test_slug and lower(btrim(c.organization))=v_org
       and c.document_snapshot->>'protocolDate'=d::text
       and (c.document_snapshot->>'protocolNumber'=v_base or c.document_snapshot->>'protocolNumber' like v_base||'-%')
     group by 1,2
   )
   select coalesce(
     (select num from protocols
      where profile_id is not distinct from p.id and people<c_max_participants and part>0
      order by part desc limit 1),
     case when not exists(select 1 from protocols) then v_base
          else v_base||'-'||((select max(part) from protocols)+1)::text end)
   into v_number;
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

create or replace function public.get_approved_course_presentation_locale(
  p_course_slug text,
  p_asset text,
  p_locale public.app_locale
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
declare
  v_user_id uuid := (select auth.uid());
begin
  -- An administrator checks the material without enrolling: no application,
  -- no approval, every course. A learner still passes the full gate.
  if v_user_id is null or not exists (
    select 1
    from public.user_roles user_role
    join public.account_controls control on control.user_id = user_role.user_id
    where user_role.user_id = v_user_id
      and user_role.product_role = 'admin'
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    v_user_id := private.require_approved_learner();
  end if;
  perform private.assert_locale_matches_auth_realm(v_user_id, p_locale);
  if p_course_slug is null
    or char_length(p_course_slug) not between 1 and 120
    or p_course_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or p_asset is null
    or p_asset not in ('presentation', 'thumbnail') then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;
  perform private.require_course_access_by_slug(v_user_id, p_course_slug);
  return query
  select
    presentation.id,
    case when p_asset = 'presentation' then 'application/pdf' else 'image/webp' end,
    case when p_asset = 'presentation' then presentation.byte_size else null end
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  join public.test_revision_presentations mapping
    on mapping.revision_id = revision.id and mapping.locale = p_locale
  join public.course_presentations presentation
    on presentation.id = mapping.presentation_id
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
