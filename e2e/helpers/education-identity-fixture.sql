create function pg_temp.document_certificate_fixture(learner uuid) returns public.certificates
language plpgsql as $$
declare r public.test_revisions; a public.test_attempts; att uuid; c public.certificates; title text;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where exists(select 1 from public.document_profiles dp where dp.course_slug=t.slug and dp.audience='all' and dp.body->>'family'='general') order by t.slug limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@document-regression.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Слушатель',education='Среднее профессиональное',job='Рабочий',organization='Document regression fixture '||learner where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job='Рабочий',organization='Document regression fixture '||learner,verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),r.pass_score,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 select l.title into strict title from public.test_revision_localizations l where l.revision_id=r.id and l.locale='ru';
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-FIXTURE-'||learner,learner,r.id,att,a.id,1,'Тестовый Слушатель','Рабочий','Document regression fixture '||learner,r.slug,title,title,'ru',a.score,r.question_count,r.pass_score,a.completed_at,'manual') returning * into c;
 return c;
end; $$;
