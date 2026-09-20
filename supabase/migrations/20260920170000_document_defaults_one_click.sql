-- Issuing a document asked the operator to retype what the paper form has always
-- said: the kind of knowledge check, the reason for the training, the decision of
-- the commission, the listener category. Every blank refused the issuance. The
-- wording below is the wording of the training centre's own protocols and is the
-- twin of lib/pdf/document-family-defaults.ts; the two must be changed together.
create function private.document_family_default(p_family text, p_audience text) returns jsonb
language sql immutable set search_path='' as $$
 select case coalesce(p_family,'general')
  when 'biot' then jsonb_build_object(
    'hours',null,'validityMonths',case when p_audience='worker' then 12 else 36 end,
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

-- A stored value always wins; only a blank is filled in.
create function private.complete_document_profile(p jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when p is null or p='null'::jsonb then p else p||jsonb_strip_nulls(jsonb_build_object(
   'validityMonths',case when coalesce((p->>'validityMonths')::int,0)=0 then d->'validityMonths' else null end,
   'verificationKind',case when coalesce(btrim(p->>'verificationKind'),'')='' then d->'verificationKind' else null end,
   'protocolText',case when coalesce(btrim(p->>'protocolText'),'')='' then d->'protocolText' else null end,
   'decisionText',case when coalesce(btrim(p->>'decisionText'),'')='' then d->'decisionText' else null end
 ))||case when coalesce((p->>'hours')::int,0)=0 then jsonb_build_object('hours',d->'hours') else '{}'::jsonb end end
 from (select private.document_family_default(p->>'family',p->>'audience') d) t;
$$;

-- Programmes split into «ИТР» and «рабочий состав» refused every issuance until
-- somebody opened the editor and picked a category by hand. The position the
-- person holds already says which one it is; the editor still shows the choice.
create function private.document_audience_for_position(p_position text) returns text
language sql immutable set search_path='' as $$
 select case when coalesce(p_position,'') ~* '(руковод|директор|начальн|замести|инженер|мастер|бригадир|прораб|специалист|технолог|менеджер|главн|завед|супервайз|superv|manager|engineer|foreman|director|chief|head)'
   then 'itr' else 'worker' end;
$$;
revoke all on function private.document_family_default(text,text) from public,anon,authenticated,service_role;
revoke all on function private.complete_document_profile(jsonb) from public,anon,authenticated,service_role;
revoke all on function private.document_audience_for_position(text) from public,anon,authenticated,service_role;

create or replace function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; b public.document_batches; p public.document_profiles; d date;
begin
 if tg_op='UPDATE' then
   if new.document_snapshot is distinct from old.document_snapshot then raise exception 'DOCUMENT_SNAPSHOT_IMMUTABLE'; end if;
   return new;
 end if;
 select private.certificate_settings_payload(false) into s;
 select * into b from public.document_batches where organization_key=lower(btrim(new.organization)) and course_slug=new.test_slug;
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
 new.document_snapshot:=jsonb_build_object(
   'schemaVersion',1,'captureKind','issuance','capturedAt',statement_timestamp(),
   'settings',s,'profile',private.complete_document_profile(p.body),'profileVersion',p.version,
   'protocolNumber',coalesce(b.protocol_number,to_char(d,'DD.MM')),'protocolDate',d,
   'education',coalesce((select education from public.profiles where id=new.user_id),''),
   'photo', (select jsonb_build_object('objectKey',object_key,'legacyImported',legacy_imported) from private.profile_avatar_manifests where user_id=new.user_id)
 );
 return new;
end; $$;

-- The per-listener cells are the same word for the whole group, so they are
-- derived rather than demanded. Only the two facts that genuinely belong to the
-- person — where they work and what they do — still refuse a blank.
create or replace function private.validate_document_issuance() returns trigger
language plpgsql security definer set search_path='' as $$
declare p jsonb:=new.document_snapshot->'profile'; details jsonb; signer jsonb; defaults jsonb;
begin
 select participant_fields->new.user_id::text into details from public.document_batches
 where organization_key=lower(btrim(new.organization)) and course_slug=new.test_slug;
 details:=coalesce(details,'{}'::jsonb);
 if p is not null and p<>'null'::jsonb then
   if coalesce(btrim(new.organization),'')='' or coalesce(btrim(new.job),'')='' then raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:organization,position'; end if;
   for signer in select value from jsonb_array_elements(p->'commission') loop
     if signer->>'assetId' is not null and not exists(select 1 from public.document_assets a where a.id=(signer->>'assetId')::uuid and a.owner_id=signer->>'signerId' and a.kind='signature') then raise exception 'DOCUMENT_SIGNER_ASSET_MISMATCH'; end if;
   end loop;
   defaults:=private.document_family_default(p->>'family',p->>'audience');
   if coalesce(btrim(details->>'trainingReason'),'')='' then details:=details||jsonb_build_object('trainingReason',defaults->>'trainingReason'); end if;
   if p->>'family'='qualification' and coalesce(btrim(details->>'qualificationDecision'),'')='' then
     details:=details||jsonb_build_object('qualificationDecision',coalesce(p->>'programName',''));
   end if;
 end if;
 -- «Примечание» is a column on the biot form, never a question for the operator.
 details:=details||jsonb_build_object('notes',coalesce(details->>'notes',''));
 new.document_snapshot:=new.document_snapshot||jsonb_build_object('participantFields',details);
 return new;
end; $$;

-- The sitting recorded by this very protocol is the examination record: the
-- commission, the programme and the date are the ones printed on the sheet. What
-- still cannot be waved through is a person who did not pass.
create or replace function private.require_industrial_exam_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare p jsonb:=new.document_snapshot->'profile'; evidence jsonb:=coalesce(new.document_snapshot->'participantFields','{}'::jsonb);
begin
 if new.test_slug='promyshlennaya-bezopasnost' or p->>'family'='industrial' then
   -- A learner who did not pass, and an examination an operator deliberately
   -- recorded as failed, are still refused.
   if new.score<new.pass_score or coalesce(evidence->>'formalExamResult','passed')='failed' then
     raise exception using errcode='22023',message='DOCUMENT_FORMAL_EXAM_REQUIRED';
   end if;
   if coalesce(btrim(evidence->>'formalExamReference'),'')='' then
     evidence:=evidence||jsonb_build_object(
       'formalExamReference','Протокол № '||coalesce(new.document_snapshot->>'protocolNumber','')||' заседания комиссии',
       'formalExamDate',coalesce(new.document_snapshot->>'protocolDate',(new.issued_at at time zone 'Asia/Oral')::date::text),
       'formalExamResult','passed','formalExamConfirmedAt',statement_timestamp()::text);
   end if;
   -- The evidence names the profile this very document is drawn from, whatever
   -- revision it was confirmed against.
   new.document_snapshot:=new.document_snapshot||jsonb_build_object('participantFields',
     evidence||jsonb_build_object('formalExamProfileId',p->>'id','formalExamProfileVersion',new.document_snapshot->>'profileVersion'));
 end if;
 return new;
end; $$;

-- The gate that demanded «номер и дата приказа, вид проверки знаний» before a
-- «БиОТ» document could be issued shipped on 19 September, and the only values it
-- ever produced were typed to get past it — an order «№ 1» of that same day, and
-- the caption of the field itself in place of the kind of check. The training
-- centre's own protocols leave that line empty, so these go back to blank and
-- take the wording of the form below.
update public.document_profiles
set body=body||jsonb_build_object('orderNumber','','orderDate','','verificationKind','','hours',null,'validityMonths',0)
where body->>'family'='biot' and coalesce(body->>'orderDate','')>='2026-09-19';

-- Bring the stored profiles up to the same standard, so the editor shows the
-- wording instead of an empty box the administrator has to guess at. The two
-- sentences cleared first are what the import script wrote for every programme
-- alike — they were never a choice anybody made.
update public.document_profiles set body=body
  ||case when body->>'protocolText'='Проверка знаний проведена в соответствии с утверждённой программой на тему: «{program}».' then jsonb_build_object('protocolText','') else '{}'::jsonb end
  ||case when body->>'decisionText'='Результаты проверки знаний зафиксированы настоящим протоколом. Допуск к самостоятельной работе оформляет работодатель в установленном порядке.' then jsonb_build_object('decisionText','') else '{}'::jsonb end;
update public.document_profiles set body=private.complete_document_profile(body), version=version+1
where body is distinct from private.complete_document_profile(body);
