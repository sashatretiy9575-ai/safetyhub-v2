begin;

-- Every course has document settings, from the moment it is created, and keeps
-- them when it is renamed. A course's documents are saved in one call; switching
-- between one category and «ИТР» and «рабочие» creates and removes the rows.
do $test$
declare actor uuid:=gen_random_uuid(); course_id uuid:=gen_random_uuid(); slug text:='documents-fixture-course';
 result jsonb; versions jsonb; split jsonb; single jsonb; blocked boolean:=false;
begin
 if exists(select 1 from public.tests t where not exists(select 1 from public.document_profiles p where p.course_slug=t.slug)) then
   raise exception 'a course has no document settings';
 end if;
 begin
   insert into public.document_profiles(id,course_slug,audience,body) values('orphan-fixture','no-such-course','all','{}');
   raise exception 'a profile of a course that does not exist was accepted';
 exception when foreign_key_violation then null;
 end;

 insert into public.tests(id, slug, title, description, icon, display_order, seo, draft_content, duration_minutes, pass_score, attempts_per_calendar_day, attempt_reset_timezone, status, content_hash)
 values (course_id, slug, 'Новый курс', '', 'factory', 901, '{}'::jsonb, jsonb_build_object('questions','[]'::jsonb), 15, 7, 8, 'Asia/Oral', 'draft', repeat('a',64));
 if (select jsonb_agg(jsonb_build_array(audience, body->>'family', body->>'programName')) from public.document_profiles where course_slug=slug)
   is distinct from '[["all","general","Новый курс"]]'::jsonb then
   raise exception 'a new course did not start with the general form';
 end if;

 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','document-courses@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);

 split:=jsonb_build_object('family','biot','split',true,'programName','Безопасность и охрана труда',
   'protocolText','','decisionText','','orderNumber','№ 7','orderDate','2026-09-01','verificationKind','','booklet',null,
   'categories',jsonb_build_object('itr',jsonb_build_object('hours',40,'validityMonths',36),'worker',jsonb_build_object('hours',null,'validityMonths',0)));
 select jsonb_object_agg(id,version) into versions from public.document_profiles where course_slug=slug;
 result:=public.save_document_course(course_id,split,versions);
 if result ? '__safetyhubRpcError' then raise exception 'the split was not saved: %',result; end if;
 if (select array_agg(audience order by audience) from public.document_profiles where course_slug=slug) is distinct from array['itr','worker'] then
   raise exception 'one category did not become two';
 end if;
 if (select body->>'orderNumber' from public.document_profiles where course_slug=slug and audience='itr') is distinct from '№ 7'
   or (select (body->>'hours')::int from public.document_profiles where course_slug=slug and audience='itr') is distinct from 40
   or (select body->'noExpiry' from public.document_profiles where course_slug=slug and audience='worker') is distinct from 'true'::jsonb then
   raise exception 'the categories were not written as sent: %',(select jsonb_agg(body) from public.document_profiles where course_slug=slug);
 end if;
 if private.complete_document_profile((select body from public.document_profiles where course_slug=slug and audience='worker'))->'validityMonths' is distinct from '0'::jsonb
   or private.complete_document_profile((select body from public.document_profiles where course_slug=slug and audience='worker'))->'hours' is distinct from '10'::jsonb then
   raise exception '«без срока» or the hours of the form were lost at print time';
 end if;

 -- The versions the page was looking at are gone: the second save is refused.
 result:=public.save_document_course(course_id,split,versions);
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_PROFILE_CONFLICT' then raise exception 'a stale save was accepted: %',result; end if;

 single:=jsonb_build_object('family','general','split',false,'programName','Новый курс',
   'protocolText','','decisionText','','orderNumber','№ 7','orderDate','2026-09-01','verificationKind','',
   'booklet',jsonb_build_object('layout','standard','texts',jsonb_build_object('examTextKk','Өз','examTextRu','Своя корочка','knowledgeTextKk','Өз','knowledgeTextRu','Своя')),
   'categories',jsonb_build_object('all',jsonb_build_object('hours',null,'validityMonths',null)));
 select jsonb_object_agg(id,version) into versions from public.document_profiles where course_slug=slug;
 result:=public.save_document_course(course_id,single,versions);
 if result ? '__safetyhubRpcError' then raise exception 'one category was not saved: %',result; end if;
 if (select array_agg(audience) from public.document_profiles where course_slug=slug) is distinct from array['all'] then
   raise exception 'two categories did not become one';
 end if;
 if (select body#>>'{booklet,texts,examTextRu}' from public.document_profiles where course_slug=slug) is distinct from 'Своя корочка'
   or (select body->>'orderNumber' from public.document_profiles where course_slug=slug) <> '' then
   raise exception 'the booklet or the order were not written as the form says: %',(select body from public.document_profiles where course_slug=slug);
 end if;

 select jsonb_object_agg(id,version) into versions from public.document_profiles where course_slug=slug;
 result:=public.save_document_course(course_id,single||jsonb_build_object('family','unknown'),versions);
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_COURSE_INVALID' then raise exception 'an unknown form was accepted: %',result; end if;
 result:=public.save_document_course(course_id,single||jsonb_build_object('categories',jsonb_build_object('all',jsonb_build_object('hours',0,'validityMonths',null))),versions);
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_COURSE_INVALID' then raise exception 'zero hours were accepted: %',result; end if;

 -- A renamed course keeps its documents.
 update public.tests set slug='documents-fixture-renamed' where id=course_id;
 if not exists(select 1 from public.document_profiles where course_slug='documents-fixture-renamed') then
   raise exception 'a rename left the documents of the course behind';
 end if;

 if has_function_privilege('anon','public.save_document_course(uuid,jsonb,jsonb)','execute') then
   raise exception 'an anonymous caller may save course documents';
 end if;
 perform set_config('request.jwt.claims',jsonb_build_object('role','anon')::text,true);
 perform set_config('request.jwt.claim.sub','',true);
 begin
   perform public.save_document_course(course_id,single,versions);
 exception when others then blocked:=true;
 end;
 if not blocked then raise exception 'a caller without the capability saved course documents'; end if;
end; $test$;

rollback;
