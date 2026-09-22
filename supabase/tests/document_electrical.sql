begin;

-- A course of electrical safety prints a protocol per person, numbered in the
-- journal of the centre, and states the admission each person was given.
create function pg_temp.attestation(p_organization text, p_job text default 'Электромонтёр') returns uuid
language plpgsql as $$
declare learner uuid:=gen_random_uuid(); r public.test_revisions; a public.test_attempts; att uuid;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug='plotnik' limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
   values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@electrical.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Электрик',education='Среднее специальное',job=p_job,organization=p_organization where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Электрик',job=p_job,organization=p_organization,verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),r.question_count,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 return att;
end; $$;

do $test$
declare actor uuid:=gen_random_uuid(); course uuid; expected jsonb; setup jsonb; sheet text;
 first uuid; second uuid; third uuid; fourth uuid; snapshot jsonb; person uuid;
 today date:=(statement_timestamp() at time zone 'Asia/Oral')::date;
begin
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','electrical@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);

 select id into strict course from public.tests where slug='plotnik';
 select coalesce(jsonb_object_agg(id,version),'{}'::jsonb) into expected from public.document_profiles where course_slug='plotnik';

 -- One protocol per person: the form is never split in two.
 setup:=public.save_document_course(course,jsonb_build_object(
     'family','electrical','split',true,'programName','Электробезопасность',
     'protocolText','','decisionText','','orderNumber','','orderDate','','verificationKind','',
     'booklet',null,'electrical',jsonb_build_object('group','II','voltage','up-to-1000','role','electrotechnical'),
     'categories',jsonb_build_object('itr',jsonb_build_object('hours',null,'validityMonths',null),
                                     'worker',jsonb_build_object('hours',null,'validityMonths',null))),expected);
 if setup#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_COURSE_INVALID' then
   raise exception 'an electrical course was split in two: %',setup;
 end if;

 setup:=public.save_document_course(course,jsonb_build_object(
   'family','electrical','split',false,'programName','Электробезопасность и работы на высоте',
   'protocolText','','decisionText','','orderNumber','','orderDate','','verificationKind','очередная',
   'booklet',null,'electrical',jsonb_build_object('group','II','voltage','up-to-1000','role','electrotechnical'),
   'categories',jsonb_build_object('all',jsonb_build_object('hours',null,'validityMonths',12))),expected);
 if setup#>>'{profiles,0,body,electrical,group}' is distinct from 'II'
   or setup#>>'{profiles,0,body,family}' is distinct from 'electrical' then
   raise exception 'the course did not keep its admission: %',setup;
 end if;

 -- «128» runs on as the journal does, across companies and in one action.
 first:=pg_temp.attestation('Electrical fixture A');
 second:=pg_temp.attestation('Electrical fixture B');
 third:=pg_temp.attestation('Electrical fixture A');
 perform public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[first,second,third],null,null,null,null,'128');
 if (select count(distinct document_snapshot->>'protocolNumber') from public.certificates
     where attestation_id in (first,second,third) and revoked_at is null) <> 3 then
   raise exception 'two people shared one electrical protocol: %',
     (select jsonb_agg(document_snapshot->>'protocolNumber') from public.certificates where attestation_id in (first,second,third));
 end if;
 if (select array_agg(number order by number) from (
       select document_snapshot->>'protocolNumber' as number from public.certificates
       where attestation_id in (first,second,third) and revoked_at is null) issued) <> array['128','129','130'] then
   raise exception 'the journal did not run on: %',
     (select jsonb_agg(document_snapshot->>'protocolNumber') from public.certificates
      where attestation_id in (first,second,third) and revoked_at is null);
 end if;

 -- What the course states reaches the document; what the card states wins.
 select document_snapshot into snapshot from public.certificates where attestation_id=first and revoked_at is null;
 if snapshot#>>'{participantFields,electricalGroup}' is distinct from 'II'
   or snapshot#>>'{participantFields,electricalVoltage}' is distinct from 'up-to-1000'
   or snapshot#>>'{profile,electrical,role}' is distinct from 'electrotechnical' then
   raise exception 'the admission of the course was not printed: %',snapshot->'participantFields';
 end if;

 fourth:=pg_temp.attestation('Electrical fixture C','Главный энергетик');
 select user_id into strict person from public.attestations where id=fourth;
 perform public.save_document_electrical(person,'plotnik','IV','above-1000');
 perform public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[fourth],null,null,null,null,'128');
 select document_snapshot into snapshot from public.certificates where attestation_id=fourth and revoked_at is null;
 if snapshot#>>'{participantFields,electricalGroup}' is distinct from 'IV'
   or snapshot#>>'{participantFields,electricalVoltage}' is distinct from 'above-1000' then
   raise exception 'the card of the person was not printed: %',snapshot->'participantFields';
 end if;
 if snapshot->>'protocolNumber' is distinct from '131' then
   raise exception 'the journal repeated a number: %',snapshot->>'protocolNumber';
 end if;
 -- Null gives the course's admission back.
 perform public.save_document_electrical(person,'plotnik',null,null);
 if exists(select 1 from public.document_batches where course_slug='plotnik'
   and participant_fields#>>array[person::text,'electricalGroup'] is not null) then
   raise exception 'the override outlived its removal';
 end if;

 -- Without a number of its own the sheet is numbered as every other protocol.
 perform public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[pg_temp.attestation('Electrical fixture D')]);
 perform public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[pg_temp.attestation('Electrical fixture D')]);
 if not exists(select 1 from public.certificates where test_slug='plotnik'
     and document_snapshot->>'protocolDate'=today::text
     and document_snapshot->>'protocolNumber'=to_char(today,'DD.MM'))
   or not exists(select 1 from public.certificates where test_slug='plotnik'
     and document_snapshot->>'protocolDate'=today::text
     and document_snapshot->>'protocolNumber'=to_char(today,'DD.MM')||'-2') then
   raise exception 'automatic numbers did not open a sheet each: %',
     (select jsonb_agg(document_snapshot->>'protocolNumber') from public.certificates where test_slug='plotnik' and document_snapshot->>'protocolDate'=today::text);
 end if;

 -- A document reissued the same day stays on the sheet the person is on.
 select document_snapshot->>'protocolNumber' into strict sheet from public.certificates
 where attestation_id=first and revoked_at is null;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='Исправлены данные' where attestation_id=first and revoked_at is null;
 update public.verified_identities set version=version+1 where user_id=(select user_id from public.attestations where id=first);
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source,supersedes_certificate_id)
 select 'SH-ELECTRICAL-CORRECTED',user_id,revision_id,attestation_id,attempt_id,identity_version+1,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,'identity_correction',id
 from public.certificates where attestation_id=first order by issued_at desc limit 1
 returning document_snapshot into snapshot;
 if snapshot->>'protocolNumber' is distinct from sheet then
   raise exception 'a corrected sheet took a new number: % instead of %',snapshot->>'protocolNumber',sheet;
 end if;
end; $test$;

rollback;
