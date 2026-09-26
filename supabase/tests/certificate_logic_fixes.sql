begin;

-- 20260926100000: a refused reissue is recorded, a closed course closes its
-- attempts, the sitting is counted per course across a rename, the public check
-- shows the printed date and a revoked state, the certificate year is Oral's,
-- a chosen date or journal number cannot contradict the record, and the
-- dashboard says which courses are open.

create temporary table logic_fixture(key text primary key, id uuid not null) on commit drop;

-- A learner of «plotnik» who passed the course three days ago with p_score.
create function pg_temp.learner(p_organization text, p_score integer, p_grant boolean default true)
returns uuid
language plpgsql as $$
declare learner uuid:=gen_random_uuid(); r public.test_revisions; a public.test_attempts; att uuid;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug='plotnik';
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
   values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@logic-fixes.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Слушатель',education='Высшее',job='Плотник',organization=p_organization where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job='Плотник',organization=p_organization,verified_at=now() where user_id=learner;
 update public.account_controls set approval_state='approved',approval_requested_at=null,approval_due_at=null,
   approval_decided_at=null,approval_decided_by=null,approval_rejection_reason=null where user_id=learner;
 insert into public.legal_acceptances(user_id,document_type,version,source)
 select learner,document.document_type,document.version,'profile' from public.legal_document_versions document
 where document.is_current and document.document_type in ('privacy','terms') on conflict do nothing;
 if p_grant then
   insert into public.course_access_grants(user_id,test_id) values(learner,r.test_id) on conflict do nothing;
 end if;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),p_score,now()-interval '3 days',now()-interval '3 days'+make_interval(mins=>r.duration_minutes),now()-interval '3 days'+interval '1 minute','ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 return att;
end; $$;

create function pg_temp.open_attempt(p_user uuid, p_slug text) returns public.test_attempts
language plpgsql as $$
declare r public.test_revisions; a public.test_attempts;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug=p_slug;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,started_at,expires_at,locale)
 select p_user,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,'started',now(),now()+make_interval(mins=>r.duration_minutes),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 return a;
end; $$;

-- Answers with the first p_correct questions right and the rest wrong.
create function pg_temp.answers(p_attempt uuid, p_correct integer) returns jsonb
language sql as $$
 select jsonb_agg(jsonb_build_object('questionId',question.value->>'id','optionId',
   case when question.ordinality<=p_correct then keys.correct_option_ids->>(question.ordinality::integer-1)
   else (select option->>'id' from jsonb_array_elements(question.value->'options') option
         where option->>'id'<>keys.correct_option_ids->>(question.ordinality::integer-1) limit 1) end)
   order by question.ordinality)
 from public.test_attempts attempt
 join public.test_revision_variants variant on variant.id=attempt.variant_id
 join private.test_revision_variant_answer_keys keys on keys.variant_id=variant.id
 cross join lateral jsonb_array_elements(variant.questions) with ordinality question(value,ordinality)
 where attempt.id=p_attempt;
$$;

create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user)::text,true);
 perform set_config('request.jwt.claim.sub',p_user::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
end; $$;

-- «plotnik» gets one general profile of its own, whatever the database had.
create function pg_temp.plotnik_profile(p_family text, p_electrical jsonb default null) returns void
language plpgsql as $$
begin
 update public.document_batches set profile_id=null where course_slug='plotnik';
 delete from public.document_profiles where course_slug='plotnik';
 insert into public.document_profiles(id,course_slug,audience,body) values('logic-fixture','plotnik','all',
   jsonb_build_object('id','logic-fixture','courseSlug','plotnik','audience','all','label','Logic','programName','Плотник',
     'family',p_family,'hours',null,'validityMonths',0,'protocolText','','decisionText','','orderNumber','','orderDate','',
     'verificationKind','','commission','[]'::jsonb,'stampAssetId',null)
   || case when p_electrical is null then '{}'::jsonb else jsonb_build_object('electrical',p_electrical) end);
end; $$;

-- Contracts ------------------------------------------------------------------
do $test$
declare v_definition text;
begin
 if not private.audit_event_allowed('certificate.reissue_refused') then
   raise exception 'a refused reissue is dropped from the history';
 end if;
 v_definition:=lower(pg_get_functiondef('private.complete_test_attempt_unmetered(uuid,jsonb)'::regprocedure));
 if position('lock_not_available then raise' in v_definition)=0
   or position('certificate.reissue_refused' in v_definition)=0
   or position('private.has_course_access(' in v_definition)=0 then
   raise exception 'completion does not retry a lock, record a refusal or check the course';
 end if;
 if position('private.has_course_access(' in lower(pg_get_functiondef('public.get_test_attempt(uuid)'::regprocedure)))=0 then
   raise exception 'the attempt read does not check the course';
 end if;
 if position('statement_timestamp() at time zone ''asia/oral'', ''yyyy''' in lower(pg_get_functiondef(
     'private.issue_certificate_for_attestation(uuid,uuid,public.certificate_issue_source,uuid,uuid)'::regprocedure)))=0 then
   raise exception 'the certificate year is not taken in Oral';
 end if;
 if has_function_privilege('anon','public.get_public_certificate(uuid)','EXECUTE')
   or has_function_privilege('authenticated','public.get_public_certificate(uuid)','EXECUTE')
   or not has_function_privilege('service_role','public.get_public_certificate(uuid)','EXECUTE') then
   raise exception 'the public verification boundary moved';
 end if;
end; $test$;

do $test$
declare actor uuid:=gen_random_uuid();
begin
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','logic-fixes-admin@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 insert into logic_fixture values('admin',actor);
 perform pg_temp.plotnik_profile('general');
end; $test$;

-- 2. A closed course closes its attempts -------------------------------------
do $test$
declare actor uuid:=(select id from logic_fixture where key='admin');
 att uuid; learner uuid; a public.test_attempts; other public.test_attempts; result jsonb; blocked boolean;
 plotnik uuid; armaturshchik uuid;
begin
 select id into strict plotnik from public.tests where slug='plotnik';
 select id into armaturshchik from public.tests where slug='armaturshchik' and status='published';
 att:=pg_temp.learner('Logic fixes access',7);
 select user_id into strict learner from public.attestations where id=att;
 a:=pg_temp.open_attempt(learner,'plotnik');

 -- A grant taken away behind the attempt's back: the submission is refused
 -- and nothing is recorded.
 delete from public.course_access_grants where user_id=learner and test_id=plotnik;
 perform pg_temp.act_as(learner);
 blocked:=false;
 begin
   perform private.complete_test_attempt_unmetered(a.id,pg_temp.answers(a.id,10));
 exception when insufficient_privilege then blocked:=sqlerrm='COURSE_ACCESS_REQUIRED';
 end;
 if not blocked then raise exception 'a closed course accepted a submission'; end if;
 if (select status from public.test_attempts where id=a.id)<>'started'
   or (select best_score from public.attestations where id=att)<>7 then
   raise exception 'a refused submission left a result';
 end if;
 -- The public submission answers with the code the quiz explains.
 result:=public.complete_test_attempt(a.id,pg_temp.answers(a.id,10));
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'COURSE_ACCESS_REQUIRED' then
   raise exception 'the submission envelope lost the course refusal: %',result;
 end if;
 -- The attempt read hands out no questions of a closed course.
 blocked:=false;
 begin
   perform public.get_test_attempt(a.id);
 exception when insufficient_privilege then blocked:=sqlerrm='COURSE_ACCESS_REQUIRED';
 end;
 if not blocked then raise exception 'a closed course handed out its attempt'; end if;

 -- With the grant back, the same attempt reads again.
 insert into public.course_access_grants(user_id,test_id) values(learner,plotnik);
 result:=public.get_test_attempt(a.id);
 if result->>'status' is distinct from 'started' then raise exception 'an open course did not read: %',result; end if;

 -- Taking the course away through the administrator expires its open attempt;
 -- an attempt on a course that stays open is untouched.
 if armaturshchik is not null then
   insert into public.course_access_grants(user_id,test_id) values(learner,armaturshchik);
   other:=pg_temp.open_attempt(learner,'armaturshchik');
 end if;
 perform pg_temp.act_as(actor);
 result:=public.set_course_access(learner,case when armaturshchik is null then '{}'::uuid[] else array[armaturshchik] end);
 if (select status from public.test_attempts where id=a.id)<>'expired'
   or (select completed_at from public.test_attempts where id=a.id) is null
   or (select score from public.test_attempts where id=a.id) is not null then
   raise exception 'a course taken away left its attempt open: %',(select to_jsonb(t) from public.test_attempts t where id=a.id);
 end if;
 if armaturshchik is not null and (select status from public.test_attempts where id=other.id)<>'started' then
   raise exception 'an attempt on a course still open was closed';
 end if;
 if not exists(select 1 from public.admin_audit_log where target_user_id=learner and action='course.access.changed') then
   raise exception 'the course change was not recorded';
 end if;
 -- The learner's late submission finds the attempt closed, not scored.
 insert into public.course_access_grants(user_id,test_id) values(learner,plotnik);
 perform pg_temp.act_as(learner);
 result:=private.complete_test_attempt_unmetered(a.id,pg_temp.answers(a.id,10));
 if result->>'status' is distinct from 'expired' then raise exception 'an expired attempt was scored: %',result; end if;
end; $test$;

-- 1. A refused reissue is recorded; a lock not granted is retried ------------
create function pg_temp.lock_not_granted() returns trigger
language plpgsql as $$
begin
 raise exception using errcode='lock_not_available', message='canceling statement due to lock timeout';
end; $$;

do $test$
declare actor uuid:=(select id from logic_fixture where key='admin');
 att uuid; learner uuid; a public.test_attempts; c public.certificates; before_doc jsonb; result jsonb; entry public.admin_audit_log; blocked boolean;
begin
 perform pg_temp.act_as(actor);
 att:=pg_temp.learner('Logic fixes reissue',7);
 select user_id into strict learner from public.attestations where id=att;
 perform private.issue_certificate_for_attestation(att,actor,'manual');
 select * into strict c from public.certificates where attestation_id=att and revoked_at is null;
 before_doc:=to_jsonb(c);
 a:=pg_temp.open_attempt(learner,'plotnik');

 -- Only an «ИТР» sitting exists and the learner is a worker: the better
 -- document is refused. The result stands, the old document stays and the
 -- refusal is written down with its reason.
 update public.document_profiles set audience='itr',body=jsonb_set(body,'{audience}','"itr"') where course_slug='plotnik';
 update public.profiles set document_audience='worker' where id=learner;
 perform pg_temp.act_as(learner);
 result:=private.complete_test_attempt_unmetered(a.id,pg_temp.answers(a.id,10));
 if result->>'status'<>'passed' or (result->>'score')::integer<>10 then raise exception 'the refusal lost the result: %',result; end if;
 if (select to_jsonb(cert) from public.certificates cert where id=c.id) is distinct from before_doc then
   raise exception 'the refusal changed the earlier certificate';
 end if;
 select * into entry from public.admin_audit_log
 where action='certificate.reissue_refused' and target_user_id=learner order by id desc limit 1;
 if entry.id is null
   or entry.target_id is distinct from c.id::text
   or entry.after_data->>'certificateId' is distinct from c.id::text
   or entry.after_data->>'reason' is distinct from 'DOCUMENT_PROFILE_REQUIRED'
   or entry.after_data->>'sqlstate' is distinct from '22023'
   or (entry.after_data->>'score')::integer is distinct from 10
   or entry.reason is distinct from 'DOCUMENT_PROFILE_REQUIRED' then
   raise exception 'the refusal was not recorded with its reason: %',to_jsonb(entry);
 end if;
 update public.document_profiles set audience='all',body=jsonb_set(body,'{audience}','"all"') where course_slug='plotnik';

 -- A lock not granted in time is not a refusal: the submission fails, the
 -- attempt stays open and the learner submits again.
 perform pg_temp.act_as(actor);
 att:=pg_temp.learner('Logic fixes lock',7);
 select user_id into strict learner from public.attestations where id=att;
 perform private.issue_certificate_for_attestation(att,actor,'manual');
 a:=pg_temp.open_attempt(learner,'plotnik');
 create trigger aaa_logic_fixes_lock before insert on public.certificates
 for each row execute function pg_temp.lock_not_granted();
 perform pg_temp.act_as(learner);
 blocked:=false;
 begin
   perform private.complete_test_attempt_unmetered(a.id,pg_temp.answers(a.id,10));
 exception when lock_not_available then blocked:=true;
 end;
 drop trigger aaa_logic_fixes_lock on public.certificates;
 if not blocked then raise exception 'a lock timeout was swallowed as a refusal'; end if;
 if (select status from public.test_attempts where id=a.id)<>'started'
   or exists(select 1 from public.admin_audit_log where action='certificate.reissue_refused' and target_user_id=learner) then
   raise exception 'a lock timeout recorded a result or a refusal';
 end if;
 -- The retry replaces the document.
 result:=private.complete_test_attempt_unmetered(a.id,pg_temp.answers(a.id,10));
 if result->>'status'<>'passed'
   or (select score from public.certificates where user_id=learner and revoked_at is null)<>10 then
   raise exception 'the retry did not replace the document: %',result;
 end if;
end; $test$;

-- 3. The sitting of a renamed course -----------------------------------------
do $test$
declare actor uuid:=(select id from logic_fixture where key='admin');
 today date:=(statement_timestamp() at time zone 'Asia/Oral')::date; base text; revision uuid; att uuid; number text;
begin
 base:=to_char(today,'DD.MM');
 select current_revision_id into strict revision from public.tests where slug='plotnik';
 perform pg_temp.act_as(actor);

 -- Electrical, numbered by the day: somebody sat the course under its former
 -- slug and took «DD.MM» today; the next person takes «DD.MM-2».
 perform pg_temp.plotnik_profile('electrical',jsonb_build_object('group','II','voltage','up-to-1000','role','electrotechnical'));
 execute 'set local session_replication_role = replica';
 insert into public.certificates(certificate_number,user_id,revision_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,score,total,pass_score,best_completed_at,issue_source,document_snapshot)
 values('SH-LOGIC-RENAMED-E',gen_random_uuid(),revision,1,'Прежний Слушатель','Электромонтёр','Logic rename electrical','plotnik-before-rename','Плотник','Плотник',10,10,7,now(),'manual',
   jsonb_build_object('protocolNumber',base,'protocolDate',today,'profile',jsonb_build_object('id','logic-fixture','family','electrical')));
 execute 'set local session_replication_role = origin';
 att:=pg_temp.learner('Logic rename electrical',10);
 perform private.issue_certificate_for_attestation(att,actor,'manual');
 select document_snapshot->>'protocolNumber' into strict number from public.certificates where attestation_id=att and revoked_at is null;
 if number is distinct from base||'-2' then
   raise exception 'a renamed electrical course repeated a sheet: %',number;
 end if;

 -- General: fifty people of the company sat today under the former slug, so
 -- the next person opens the second protocol.
 perform pg_temp.plotnik_profile('general');
 execute 'set local session_replication_role = replica';
 insert into public.certificates(certificate_number,user_id,revision_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,score,total,pass_score,best_completed_at,issue_source,document_snapshot)
 select 'SH-LOGIC-RENAMED-G-'||i,gen_random_uuid(),revision,1,'Прежний Слушатель','Плотник','Logic rename general','plotnik-before-rename','Плотник','Плотник',10,10,7,now(),'manual',
   jsonb_build_object('protocolNumber',base,'protocolDate',today,'profile',jsonb_build_object('id','logic-fixture','family','general'))
 from generate_series(1,50) i;
 execute 'set local session_replication_role = origin';
 att:=pg_temp.learner('Logic rename general',10);
 perform private.issue_certificate_for_attestation(att,actor,'manual');
 select document_snapshot->>'protocolNumber' into strict number from public.certificates where attestation_id=att and revoked_at is null;
 if number is distinct from base||'-2' then
   raise exception 'a renamed course put a fifty-first person on a full protocol: %',number;
 end if;
end; $test$;

-- 6. A chosen date or journal number cannot contradict the record ------------
do $test$
declare actor uuid:=(select id from logic_fixture where key='admin'); att uuid; exam date; result jsonb;
begin
 perform pg_temp.act_as(actor);
 att:=pg_temp.learner('Logic chosen date',10);
 select (best_completed_at at time zone 'Asia/Oral')::date into strict exam from public.attestations where id=att;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[att],null,null,null,exam-1,null);
 if result#>>'{items,0,status}' is distinct from 'skipped'
   or result#>>'{items,0,reason}' is distinct from 'DOCUMENT_DATE_BEFORE_EXAM' then
   raise exception 'a sitting dated before the exam was accepted: %',result;
 end if;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[att],null,null,null,exam,null);
 if result#>>'{items,0,status}' is distinct from 'completed'
   or (select document_snapshot->>'protocolDate' from public.certificates where attestation_id=att and revoked_at is null) is distinct from exam::text then
   raise exception 'the day of the exam was refused: %',result;
 end if;

 -- An electrical journal at 700.
 perform pg_temp.plotnik_profile('electrical',jsonb_build_object('group','II','voltage','up-to-1000','role','electrotechnical','journalStart',700));
 att:=pg_temp.learner('Logic journal',10);
 insert into logic_fixture values('journal-first',att);
 insert into logic_fixture values('journal-second',pg_temp.learner('Logic journal',10));
 insert into logic_fixture values('journal-third',pg_temp.learner('Logic journal',10));
 insert into logic_fixture values('journal-fourth',pg_temp.learner('Logic journal',10));
 insert into logic_fixture values('journal-fifth',pg_temp.learner('Logic journal',10));
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[att]);
 if (select document_snapshot->>'protocolNumber' from public.certificates where attestation_id=att and revoked_at is null) is distinct from '700' then
   raise exception 'the journal did not start at 700: %',result;
 end if;
end; $test$;

-- A later request: a number the journal has passed is refused, a later one is
-- taken as typed, and the rest of one request follows on from it.
do $test$
declare actor uuid:=(select id from logic_fixture where key='admin'); result jsonb;
 second uuid:=(select id from logic_fixture where key='journal-second');
 third uuid:=(select id from logic_fixture where key='journal-third');
 fourth uuid:=(select id from logic_fixture where key='journal-fourth');
 fifth uuid:=(select id from logic_fixture where key='journal-fifth');
begin
 perform pg_temp.act_as(actor);
 foreach result in array array[
   public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[second],null,null,null,null,'700'),
   public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[second],null,null,null,null,'650')
 ] loop
   if result#>>'{items,0,status}' is distinct from 'skipped'
     or result#>>'{items,0,reason}' is distinct from 'PROTOCOL_NUMBER_TAKEN' then
     raise exception 'a journal number already passed was accepted: %',result;
   end if;
 end loop;
 if exists(select 1 from public.certificates where attestation_id=second) then
   raise exception 'a refused number left a document';
 end if;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[second],null,null,null,null,'800');
 if (select document_snapshot->>'protocolNumber' from public.certificates where attestation_id=second and revoked_at is null) is distinct from '800' then
   raise exception 'a free journal number was not printed as typed: %',result;
 end if;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[third,fourth],null,null,null,null,'900');
 if (select array_agg(document_snapshot->>'protocolNumber' order by document_snapshot->>'protocolNumber')
     from public.certificates where attestation_id in (third,fourth) and revoked_at is null) is distinct from array['900','901'] then
   raise exception 'one request did not run on from its number: %',result;
 end if;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[fifth]);
 if (select document_snapshot->>'protocolNumber' from public.certificates where attestation_id=fifth and revoked_at is null) is distinct from '902' then
   raise exception 'the journal did not continue after a typed number: %',result;
 end if;
end; $test$;

-- 4, 5. The public check and the certificate number --------------------------
do $test$
declare actor uuid:=(select id from logic_fixture where key='admin');
 att uuid; learner uuid; c public.certificates; payload jsonb; revision uuid; legacy uuid:=gen_random_uuid();
begin
 perform pg_temp.plotnik_profile('general');
 perform pg_temp.act_as(actor);
 att:=pg_temp.learner('Logic public check',10);
 select user_id into strict learner from public.attestations where id=att;
 perform private.issue_certificate_for_attestation(att,actor,'manual');
 select * into strict c from public.certificates where attestation_id=att and revoked_at is null;

 if c.certificate_number not like 'SH-'||to_char(statement_timestamp() at time zone 'Asia/Oral','YYYY')||'-%' then
   raise exception 'the certificate year is not Oral''s: %',c.certificate_number;
 end if;

 payload:=public.get_public_certificate(c.id);
 if payload->>'status' is distinct from 'valid'
   or payload->>'documentDate' is distinct from c.document_snapshot->>'protocolDate'
   or payload ? 'revokedAt' or payload ? 'revokeReason' then
   raise exception 'a current certificate did not verify with its printed date: %',payload;
 end if;

 update public.verified_identities set status='revoked',revoked_at=now(),revoked_by=actor,revoke_reason='Проверка подлинности' where user_id=learner;
 if public.get_public_certificate(c.id)->>'status' is distinct from 'revoked' then
   raise exception 'a certificate of a revoked identity still verifies';
 end if;
 update public.verified_identities set status='verified',revoked_at=null,revoked_by=null,revoke_reason=null where user_id=learner;
 if public.get_public_certificate(c.id)->>'status' is distinct from 'valid' then
   raise exception 'a restored identity did not verify again';
 end if;

 update public.account_controls set status='suspended',suspended_at=now(),suspended_by=actor,suspension_reason='Проверка' where user_id=learner;
 if public.get_public_certificate(c.id)->>'status' is distinct from 'revoked' then
   raise exception 'a certificate of a suspended account still verifies';
 end if;
 update public.account_controls set status='active',suspended_at=null,suspended_by=null,suspension_reason=null where user_id=learner;

 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='Отозван администратором' where id=c.id;
 payload:=public.get_public_certificate(c.id);
 if payload->>'status' is distinct from 'revoked' or payload->>'certificateNumber' is distinct from c.certificate_number then
   raise exception 'a withdrawn certificate did not answer as revoked: %',payload;
 end if;

 -- A document older than snapshots is dated by its day of issue in Oral:
 -- 20:30 UTC on 26 September is already the 27th.
 select current_revision_id into strict revision from public.tests where slug='plotnik';
 execute 'set local session_replication_role = replica';
 insert into public.certificates(id,certificate_number,user_id,revision_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,score,total,pass_score,best_completed_at,issued_at,issue_source,document_snapshot)
 values(legacy,'SH-LOGIC-LEGACY',learner,null,1,'Тестовый Слушатель','Плотник','Logic public check','plotnik','Плотник','Плотник',10,10,7,
   timestamptz '2026-09-26 20:00:00+00',timestamptz '2026-09-26 20:30:00+00','manual',null);
 execute 'set local session_replication_role = origin';
 if public.get_public_certificate(legacy)->>'documentDate' is distinct from '2026-09-27' then
   raise exception 'a legacy document was dated by UTC: %',public.get_public_certificate(legacy);
 end if;
end; $test$;

-- 7. The dashboard says which courses are open --------------------------------
do $test$
declare att uuid; learner uuid; dashboard jsonb; plotnik uuid;
begin
 select id into strict plotnik from public.tests where slug='plotnik';
 att:=pg_temp.learner('Logic dashboard',10);
 select user_id into strict learner from public.attestations where id=att;
 perform pg_temp.act_as(learner);
 dashboard:=public.get_profile_dashboard_locale('ru');
 if jsonb_array_length(dashboard->'attestations')=0
   or exists(select 1 from jsonb_array_elements(dashboard->'attestations') row
             where jsonb_typeof(row->'accessible') is distinct from 'boolean') then
   raise exception 'a dashboard row does not say whether the course is open: %',dashboard->'attestations';
 end if;
 if exists(select 1 from jsonb_array_elements(dashboard->'attestations') row
           where (row->>'accessible')::boolean <> ((row->>'testId')::uuid=plotnik)) then
   raise exception 'the dashboard misreports open courses: %',dashboard->'attestations';
 end if;
end; $test$;

rollback;
