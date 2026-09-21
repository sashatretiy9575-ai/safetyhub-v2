begin;

-- One commission sitting takes at most fifty people. People issued the same day
-- for the same company and course share a protocol; the fifty-first opens
-- «DD.MM-2» with the same date, and a reissue keeps the person where they were.
create function pg_temp.issue(p_organization text, p_job text default 'Плотник') returns public.certificates
language plpgsql as $$
declare learner uuid:=gen_random_uuid(); r public.test_revisions; a public.test_attempts; att uuid; c public.certificates; title text;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug='plotnik' limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
   values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@protocol-parts.invalid','{}','{}',now(),now());
   update public.profiles set name='Тестовый',surname='Слушатель',education='Высшее',job=p_job,organization=p_organization where id=learner;
   update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job=p_job,organization=p_organization,verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),r.question_count,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 select l.title into strict title from public.test_revision_localizations l where l.revision_id=r.id and l.locale='ru';
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-PARTS-'||replace(gen_random_uuid()::text,'-',''),learner,r.id,att,a.id,1,'Тестовый Слушатель',p_job,p_organization,r.slug,title,title,'ru',a.score,r.question_count,r.pass_score,a.completed_at,'manual') returning * into c;
 return c;
end; $$;

do $test$
declare c public.certificates; base text; first public.certificates; numbers jsonb;
begin
 delete from public.document_batches where course_slug='plotnik';
 base:=to_char((statement_timestamp() at time zone 'Asia/Oral')::date,'DD.MM');
 for i in 1..120 loop
   c:=pg_temp.issue('Protocol parts fixture');
   if i=1 then first:=c; end if;
 end loop;
 select jsonb_object_agg(n,cnt) into numbers from (
   select document_snapshot->>'protocolNumber' n,count(*) cnt from public.certificates
   where organization='Protocol parts fixture' group by 1) s;
 if numbers is distinct from jsonb_build_object(base,50,base||'-2',50,base||'-3',20) then
   raise exception 'protocols were not cut into fifty: %',numbers;
 end if;
 if exists(select 1 from public.certificates where organization='Protocol parts fixture'
   and document_snapshot->>'protocolDate'<>(statement_timestamp() at time zone 'Asia/Oral')::date::text) then
   raise exception 'a later part changed the protocol date';
 end if;

 -- A reissue for someone on the first protocol does not take a new place, even
 -- though the certificate it replaces is revoked first, as every reissue does.
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='Исправлены данные' where id=first.id and revoked_at is null;
 update public.verified_identities set version=version+1 where user_id=first.user_id;
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source,supersedes_certificate_id)
 select 'SH-PARTS-REISSUE',user_id,revision_id,attestation_id,attempt_id,identity_version+1,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,'identity_correction',id
 from public.certificates where id=first.id returning * into c;
 if c.document_snapshot->>'protocolNumber'<>base then
   raise exception 'a reissue moved the person to %',c.document_snapshot->>'protocolNumber';
 end if;

 -- Another company starts its own protocol at the plain number.
 c:=pg_temp.issue('Another protocol parts fixture');
 if c.document_snapshot->>'protocolNumber'<>base then
   raise exception 'another company inherited the count: %',c.document_snapshot->>'protocolNumber';
 end if;
end; $test$;

-- Engineers and workers are protocols of their own: the same company, course
-- and day gives «DD.MM» to one category and «DD.MM-2» to the other.
do $test$
declare c public.certificates; base text; itr text; worker text;
begin
 update public.document_batches set profile_id=null where course_slug='plotnik';
 delete from public.document_profiles where course_slug='plotnik';
 insert into public.document_profiles(id,course_slug,audience,body)
 select id,'plotnik',audience,jsonb_build_object('id',id,'courseSlug','plotnik','audience',audience,'label',id,'programName','БиОТ','family','biot',
   'hours',null,'validityMonths',0,'protocolText','','decisionText','','orderNumber','','orderDate','','verificationKind','',
   'commission',jsonb_build_array(jsonb_build_object('signerId','fixture','name','Проверяющий','position','Комиссия','assetId',null)),'stampAssetId',null)
 from (values ('split-itr','itr'),('split-worker','worker')) v(id,audience);
 base:=to_char((statement_timestamp() at time zone 'Asia/Oral')::date,'DD.MM');
 c:=pg_temp.issue('Split protocol fixture','Инженер'); itr:=c.document_snapshot->>'protocolNumber';
 if (c.document_snapshot->'profile'->>'hours')::int<>40 then raise exception 'БиОТ for engineers is not 40 hours: %',c.document_snapshot->'profile'->>'hours'; end if;
 c:=pg_temp.issue('Split protocol fixture','Плотник'); worker:=c.document_snapshot->>'protocolNumber';
 if (c.document_snapshot->'profile'->>'hours')::int<>10 then raise exception 'БиОТ for workers is not 10 hours'; end if;
 c:=pg_temp.issue('Split protocol fixture','Главный инженер');
 if itr<>base or worker<>base||'-2' or c.document_snapshot->>'protocolNumber'<>base then
   raise exception 'categories share a protocol: itr %, worker %, second engineer %',itr,worker,c.document_snapshot->>'protocolNumber';
 end if;
end; $test$;

rollback;
