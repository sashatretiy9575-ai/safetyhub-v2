begin;

-- A course of work at height keeps the order and the kind of check of the
-- «БиОТ» form, prints its own wording and is re-checked every year.
do $test$
declare actor uuid:=gen_random_uuid(); course uuid; expected jsonb; setup jsonb; defaults jsonb;
begin
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','height@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);

 defaults:=private.document_family_default('height','all');
 if defaults->>'verificationKind' is distinct from 'периодический'
   or (defaults->>'validityMonths')::int is distinct from 12
   or defaults->'hours' is distinct from 'null'::jsonb
   or defaults->>'protocolText' not like '%при работе на высоте%№ 109%'
   or defaults->>'decisionText' not like '%работ на высоте%' then
   raise exception 'the defaults of work at height are not its own: %',defaults;
 end if;

 select id into strict course from public.tests where slug='plotnik';
 select coalesce(jsonb_object_agg(id,version),'{}'::jsonb) into expected from public.document_profiles where course_slug='plotnik';

 setup:=public.save_document_course(course,jsonb_build_object(
   'family','height','split',false,'programName','Безопасность и охрана труда при работе на высоте',
   'protocolText','','decisionText','','orderNumber','№ 15-п','orderDate','2026-09-28','verificationKind','',
   'booklet',null,'electrical',null,
   'categories',jsonb_build_object('all',jsonb_build_object('hours',null,'validityMonths',12))),expected);
 if setup ? '__safetyhubRpcError' then
   raise exception 'a course of work at height was refused: %',setup;
 end if;
 if setup#>>'{profiles,0,body,family}' is distinct from 'height'
   or setup#>>'{profiles,0,body,orderNumber}' is distinct from '№ 15-п'
   or setup#>>'{profiles,0,body,orderDate}' is distinct from '2026-09-28'
   or (setup#>>'{profiles,0,body,validityMonths}')::int is distinct from 12
   or setup#>'{profiles,0,body}' ? 'electrical' then
   raise exception 'the course did not keep the order of the protocol: %',setup;
 end if;

 -- A family nobody knows is still refused.
 if private.valid_document_course(jsonb_build_object(
   'family','heights','split',false,'programName','Высота','protocolText','','decisionText','',
   'orderNumber','','orderDate','','verificationKind','','booklet',null,'electrical',null,
   'categories',jsonb_build_object('all',jsonb_build_object('hours',null,'validityMonths',12)))) then
   raise exception 'an unknown family was accepted';
 end if;
end
$test$;

rollback;
