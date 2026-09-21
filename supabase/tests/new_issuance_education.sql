begin;

-- Self-contained issuance fixture: migrations seed course revisions, but the
-- CI database tests run before optional operator workspace/accounts are seeded.
create function pg_temp.document_certificate_fixture() returns public.certificates
language plpgsql as $$
declare learner uuid:=gen_random_uuid(); r public.test_revisions; a public.test_attempts; att uuid; c public.certificates; title text;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug in ('plotnik','armaturshchik') order by t.slug limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@document-regression.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Слушатель',education='Среднее специальное',job='Рабочий',organization='Document regression fixture' where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job='Рабочий',organization='Document regression fixture',verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),r.question_count,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 select l.title into strict title from public.test_revision_localizations l where l.revision_id=r.id and l.locale='ru';
 update public.document_batches set profile_id=null where course_slug=r.slug;
 delete from public.document_profiles where course_slug=r.slug;
 insert into public.document_profiles(id,course_slug,audience,body) values('regression-fixture',r.slug,'all',jsonb_build_object('id','regression-fixture','courseSlug',r.slug,'audience','all','label','Regression','programName','Regression','family','general','hours',null,'validityMonths',0,'protocolText','Проверка','decisionText','Результат','orderNumber','','orderDate','','verificationKind','','commission','[]'::jsonb,'stampAssetId',null));
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-FIXTURE-'||learner,learner,r.id,att,a.id,1,'Тестовый Слушатель','Рабочий','Document regression fixture',r.slug,title,title,'ru',a.score,r.question_count,r.pass_score,a.completed_at,'manual') returning * into c;
 return c;
end; $$;
do $test$
declare c public.certificates; created public.certificates; snapshot jsonb; family text; blocked boolean; actor uuid:=gen_random_uuid(); result jsonb;
begin
 c:=pg_temp.document_certificate_fixture();
 snapshot:=c.document_snapshot;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='education regression' where id=c.id;
 update public.profiles set education='   ' where id=c.user_id;
 foreach family in array array['general','industrial'] loop
  update public.document_profiles set body=jsonb_set(body,'{family}',to_jsonb(family)) where course_slug=c.test_slug;
  blocked:=false;
  begin
   insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','EDU-'||family,'document_snapshot',null))).*;
  exception when others then if sqlerrm='DOCUMENT_REQUIRED_FIELDS:education' then blocked:=true; else raise; end if; end;
  if not blocked then raise exception 'Blank education allowed for %',family; end if;
 end loop;
 update public.document_profiles set body=jsonb_set(body,'{family}','"first-aid"') where course_slug=c.test_slug;
 insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','EDU-FIRSTAID','issued_at',c.issued_at+interval '1 millisecond','document_snapshot',null))).* returning * into created;
 if created.document_snapshot->>'protocolLayoutVersion'<>'2' then raise exception 'New layout marker missing'; end if;
 if (select document_snapshot from public.certificates where id=c.id) is distinct from snapshot then raise exception 'Historical snapshot changed'; end if;
 if private.certificate_download_payload(c.id)->'documentSnapshot' is distinct from snapshot then raise exception 'Historical download requires new education'; end if;
 -- Verification may create a replacement document. It must see the new education,
 -- not the empty old value, and rollback that value on any subsequent failure.
 update public.document_profiles set body=jsonb_set(body,'{family}','"general"') where course_slug=c.test_slug;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated',actor::text||'@education-test.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 update public.profiles set avatar_updated_at=now() where id=c.user_id;
 result:=public.verify_user_identity_with_education(c.user_id,'Тестовый','Обновлённый','Рабочий',c.organization,'Неоконченное высшее');
 if result ? '__safetyhubRpcError' then raise exception 'Atomic verification failed: %',result; end if;
 if (select education from public.profiles where id=c.user_id)<>'Неоконченное высшее' then raise exception 'Education not saved'; end if;
 if not exists(select 1 from public.certificates where user_id=c.user_id and revoked_at is null and document_snapshot->>'education'='Неоконченное высшее') then raise exception 'Automatic issuance captured old education'; end if;
 result:=public.verify_user_identity_with_education(c.user_id,'Тестовый','Слушатель','Рабочий',c.organization,repeat('x',201));
 if not (result ? '__safetyhubRpcError') then raise exception 'Invalid education accepted'; end if;
 if (select education from public.profiles where id=c.user_id)<>'Неоконченное высшее' then raise exception 'Failed identity mutation changed education'; end if;
end; $test$;
rollback;
