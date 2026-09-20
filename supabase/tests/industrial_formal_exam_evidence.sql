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
 update public.profiles set name='Тестовый',surname='Слушатель',education='Среднее профессиональное',job='Рабочий',organization='Document regression fixture' where id=learner;
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
create function pg_temp.copy_exam_certificate(c public.certificates,number text) returns uuid
language plpgsql as $$ declare created uuid; begin
 insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'certificate_number',number,'document_snapshot',null,'issued_at',statement_timestamp()))).* returning id into created;
 return created;
end; $$;
do $test$
declare c public.certificates; actor uuid:=gen_random_uuid(); b public.document_batches; result jsonb; issued uuid; snapshot jsonb; blocked boolean;
begin
 c:=pg_temp.document_certificate_fixture();
 update public.document_batches set profile_id=null where course_slug=c.test_slug;
 delete from public.document_profiles where course_slug=c.test_slug;
 insert into public.document_profiles(id,course_slug,audience,body) values('formal-exam-regression',c.test_slug,'all',jsonb_build_object('id','formal-exam-regression','courseSlug',c.test_slug,'audience','all','label','Regression','programName','Regression','family','industrial','hours',10,'validityMonths',0,'protocolText','Проверка','decisionText','Результат','orderNumber','','orderDate','','verificationKind','','commission','[]'::jsonb,'stampAssetId',null));
 insert into public.document_batches(organization,course_slug,document_date,protocol_number,profile_id)
 values(c.organization,c.test_slug,current_date,'FORMAL-REGRESSION','formal-exam-regression')
 on conflict(organization_key,course_slug) do update set profile_id=excluded.profile_id,participant_fields='{}',version=document_batches.version+1 returning * into b;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='formal exam regression' where id=c.id;
 -- The sitting this protocol records is the examination record: its number and
 -- its date are what the sheet is printed with, so nothing is typed in first.
 issued:=pg_temp.copy_exam_certificate(c,'SH-FORMAL-ABSENT');
 select document_snapshot into snapshot from public.certificates where id=issued;
 if snapshot#>>'{participantFields,formalExamResult}'<>'passed'
   or snapshot#>>'{participantFields,formalExamReference}' not like '%FORMAL-REGRESSION%'
   or snapshot#>>'{participantFields,formalExamProfileId}'<>'formal-exam-regression'
   then raise exception 'Issuance did not record the sitting as the examination: %',snapshot->'participantFields'; end if;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='formal exam regression' where id=issued;

 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','formal-exam-test@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 result:=public.save_document_participant_fields(b.id,c.user_id,jsonb_build_object('formalExamReference','Protocol evidence fixture','formalExamDate',current_date::text,'formalExamResult','failed'),b.version);
 b.version:=(result->>'version')::bigint;
 blocked:=false;
 begin perform pg_temp.copy_exam_certificate(c,'SH-FORMAL-FAILED');
 exception when others then if sqlerrm='DOCUMENT_FORMAL_EXAM_REQUIRED' then blocked:=true; else raise; end if; end;
 if not blocked then raise exception 'Failed formal exam issued an industrial document'; end if;
 result:=public.save_document_participant_fields(b.id,c.user_id,jsonb_build_object('formalExamReference','Protocol evidence fixture','formalExamDate',current_date::text,'formalExamResult','passed'),b.version);
 b.version:=(result->>'version')::bigint;
 issued:=pg_temp.copy_exam_certificate(c,'SH-FORMAL-PASSED');
 select document_snapshot into snapshot from public.certificates where id=issued;
 if snapshot#>>'{participantFields,formalExamConfirmedBy}' is distinct from actor::text
   or snapshot#>>'{participantFields,formalExamResult}'<>'passed'
   or snapshot#>>'{participantFields,formalExamProfileId}'<>'formal-exam-regression' then raise exception 'Formal exam evidence was not captured with its confirmer/profile'; end if;
 -- A later revision of the profile does not invalidate the evidence; the
 -- document names the revision it is actually drawn from.
 update public.document_profiles set version=version+1 where id='formal-exam-regression';
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='regression' where id=issued;
 issued:=pg_temp.copy_exam_certificate(c,'SH-FORMAL-NEW-PROFILE-VERSION');
 if (select document_snapshot#>>'{participantFields,formalExamProfileVersion}' from public.certificates where id=issued)
   <> (select document_snapshot->>'profileVersion' from public.certificates where id=issued)
   then raise exception 'Evidence did not follow the profile revision it was issued with'; end if;
 select document_snapshot into snapshot from public.certificates where id=issued;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='regression' where id=issued;
 blocked:=false;
 begin perform public.save_document_participant_fields(b.id,c.user_id,jsonb_build_object('formalExamReference','Future invalid','formalExamDate',(current_date+10)::text,'formalExamResult','passed'),b.version);
 exception when others then if sqlerrm='DOCUMENT_FORMAL_EXAM_INVALID' then blocked:=true; else raise; end if; end;
 if not blocked then raise exception 'Future formal exam accepted'; end if;
 if (select document_snapshot from public.certificates where id=issued) is distinct from snapshot then raise exception 'Formal exam evidence changed after issuance'; end if;
end;
$test$;
rollback;
