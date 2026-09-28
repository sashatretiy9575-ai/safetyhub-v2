-- Work at height becomes a course of its own, and its documents a form of
-- their own: «Работы на высоте».
--
-- Rules No. 109 on work at height (order of the Minister of Labour and Social
-- Protection of the Population of 31 March 2022) set no protocol and no
-- certificate of their own, and no groups either. The knowledge is checked on
-- the form of the rules on training in safety and labour protection — the
-- protocol of the examination commission with an order, a kind of check and the
-- bilingual table, and the ordinary certificate — and the check is repeated
-- every year. So the family is the «БиОТ» form with its own wording and a term
-- of twelve months for every listener.

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
  when 'height' then jsonb_build_object(
    'hours',null,'validityMonths',12,'verificationKind','периодический','trainingReason','',
    'protocolText','Проверка знаний по безопасности и охране труда при работе на высоте проведена по утверждённой программе «{program}» в соответствии с Правилами по обеспечению безопасности и охраны труда при работе на высоте (приказ Министра труда и социальной защиты населения Республики Казахстан от 31 марта 2022 года № 109).',
    'decisionText','Лица, прошедшие проверку знаний, допускаются к самостоятельному выполнению работ на высоте. Не прошедшие проверку подлежат повторной проверке знаний не позднее одного месяца.')
  else jsonb_build_object(
    'hours',null,'validityMonths',12,'verificationKind','','trainingReason','',
    'protocolText','Проверка знаний проведена по утверждённой программе учебного курса «{program}».',
    'decisionText','Лица, получившие положительные оценки, допускаются к самостоятельной работе, к выполнению (руководству) соответствующих работ на опасных производственных объектах.')
 end;
$$;

create or replace function private.valid_document_course(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text; c jsonb; t jsonb;
begin
 if jsonb_typeof(p) is distinct from 'object' then return false; end if;
 if exists(select 1 from jsonb_object_keys(p) key where key not in (
   'family','split','programName','protocolText','decisionText','orderNumber','orderDate',
   'verificationKind','booklet','electrical','categories')) then return false; end if;
 if coalesce(p->>'family','') not in ('general','biot','ptm','industrial','qualification','first-aid','electrical','height')
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
   'orderNumber', case when p->>'family' in ('biot','height') then btrim(p->>'orderNumber') else '' end,
   'orderDate', case when p->>'family' in ('biot','height') then p->>'orderDate' else '' end,
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
