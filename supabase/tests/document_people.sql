begin;

-- «ИТР» or «рабочий» belongs to the person: an administrator may override what
-- the position says, and give the choice back. «Примечание» of one person in
-- one course is merged into what is stored for them, never written over it.
create function pg_temp.issue(p_learner uuid) returns public.certificates
language plpgsql as $$
declare r public.test_revisions; a public.test_attempts; att uuid; c public.certificates; title text; person public.profiles;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug='plotnik' limit 1;
 select * into strict person from public.profiles where id=p_learner;
 select * into a from public.test_attempts where user_id=p_learner and revision_id=r.id;
 if a.id is null then
   insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
   select p_learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
   'passed',array_fill(1::smallint,array[v.question_count]),r.question_count,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
   from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
   insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(p_learner,r.id,a.id,a.score,a.completed_at);
 end if;
 select id into strict att from public.attestations where user_id=p_learner and revision_id=r.id;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='document people regression' where user_id=p_learner and revoked_at is null;
 select l.title into strict title from public.test_revision_localizations l where l.revision_id=r.id and l.locale='ru';
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-PEOPLE-'||replace(gen_random_uuid()::text,'-',''),p_learner,r.id,att,a.id,1,'Тестовый Слушатель',person.job,person.organization,r.slug,title,title,'ru',a.score,r.question_count,r.pass_score,a.completed_at,'manual') returning * into c;
 return c;
end; $$;

do $test$
declare actor uuid:=gen_random_uuid(); learner uuid:=gen_random_uuid(); result jsonb; c public.certificates; fields jsonb;
begin
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated','document-people-learner@safetyhub.invalid','{}','{}',now(),now()),
       ('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','document-people-admin@safetyhub.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Слушатель',education='Высшее',job='Инженер',organization='Document people fixture' where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job='Инженер',organization='Document people fixture',verified_at=now() where user_id=learner;
 update public.user_roles set role='admin' where user_id=actor;

 -- The course prints «ИТР» and «рабочие» on protocols of their own.
 delete from public.document_profiles where course_slug='plotnik';
 insert into public.document_profiles(id,course_slug,audience,body)
 select id,'plotnik',audience,private.document_course_body('plotnik',audience,jsonb_build_object(
   'family','biot','split',true,'programName','БиОТ','protocolText','','decisionText','','orderNumber','','orderDate','','verificationKind','',
   'booklet',null,'categories','{}'::jsonb))||jsonb_build_object('id',id)
 from (values ('people-itr','itr'),('people-worker','worker')) v(id,audience);

 c:=pg_temp.issue(learner);
 if c.document_snapshot#>>'{profile,audience}' is distinct from 'itr' then raise exception 'the position did not decide: %',c.document_snapshot#>>'{profile,audience}'; end if;

 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 result:=public.set_document_audience(learner,'worker');
 if result ? '__safetyhubRpcError' then raise exception 'the category was not saved: %',result; end if;
 result:=public.set_document_audience(learner,'manager');
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_AUDIENCE_INVALID' then raise exception 'an unknown category was accepted: %',result; end if;
 c:=pg_temp.issue(learner);
 if c.document_snapshot#>>'{profile,audience}' is distinct from 'worker' then raise exception 'the administrator''s choice was not printed'; end if;
 perform public.set_document_audience(learner,null);
 c:=pg_temp.issue(learner);
 if c.document_snapshot#>>'{profile,audience}' is distinct from 'itr' then raise exception 'giving the choice back did not return to the position'; end if;

 -- A note is merged into what is stored for the person, and printed.
 insert into public.document_batches(organization,course_slug,participant_fields)
 values('Document people fixture','plotnik',jsonb_build_object(learner::text,jsonb_build_object('formalExamReference','Протокол № 1')))
 on conflict(organization_key,course_slug) do update set participant_fields=excluded.participant_fields;
 result:=public.save_document_note(learner,'plotnik','  Пересдача  ');
 if result ? '__safetyhubRpcError' then raise exception 'the note was not saved: %',result; end if;
 select participant_fields->learner::text into fields from public.document_batches where organization_key='document people fixture' and course_slug='plotnik';
 if fields is distinct from jsonb_build_object('formalExamReference','Протокол № 1','notes','Пересдача') then
   raise exception 'the note replaced what was stored for the person: %',fields;
 end if;
 c:=pg_temp.issue(learner);
 if c.document_snapshot#>>'{participantFields,notes}' is distinct from 'Пересдача' then raise exception 'the note was not printed'; end if;
 result:=public.save_document_note(learner,'plotnik','');
 select participant_fields->learner::text into fields from public.document_batches where organization_key='document people fixture' and course_slug='plotnik';
 if fields is distinct from jsonb_build_object('formalExamReference','Протокол № 1') then raise exception 'a blank note was kept: %',fields; end if;
 result:=public.save_document_note(learner,'plotnik',repeat('x',501));
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_NOTE_INVALID' then raise exception 'a 501-character note was accepted: %',result; end if;

 if has_column_privilege('authenticated','public.profiles','document_audience','update')
   or has_function_privilege('anon','public.set_document_audience(uuid,text)','execute')
   or has_function_privilege('anon','public.save_document_note(uuid,text,text)','execute') then
   raise exception 'a browser role can set a category or a note';
 end if;
end; $test$;

rollback;
