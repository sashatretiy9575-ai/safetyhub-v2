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
 update public.profiles set name='Тестовый',surname='Слушатель',education='Среднее профессиональное',job='Рабочий',organization='Document regression fixture '||learner where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job='Рабочий',organization='Document regression fixture '||learner,verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),r.pass_score,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 select l.title into strict title from public.test_revision_localizations l where l.revision_id=r.id and l.locale='ru';
 update public.document_batches set profile_id=null where course_slug=r.slug;
 delete from public.document_profiles where course_slug=r.slug;
 insert into public.document_profiles(id,course_slug,audience,body) values('regression-fixture',r.slug,'all',jsonb_build_object('id','regression-fixture','courseSlug',r.slug,'audience','all','label','Regression','programName','Regression','family','general','hours',null,'validityMonths',0,'protocolText','Проверка','decisionText','Результат','orderNumber','','orderDate','','verificationKind','','commission','[]'::jsonb,'stampAssetId',null));
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-FIXTURE-'||learner,learner,r.id,att,a.id,1,'Тестовый Слушатель','Рабочий','Document regression fixture '||learner,r.slug,title,title,'ru',a.score,r.question_count,r.pass_score,a.completed_at,'manual') returning * into c;
 return c;
end; $$;
create function pg_temp.verify_education_recovery(recovery_action text) returns void language plpgsql as $test$
declare c public.certificates; a public.test_attempts; newer public.certificates; result jsonb; answers jsonb;
 actor uuid:=gen_random_uuid(); receipt uuid:=gen_random_uuid(); before_doc jsonb; blocked boolean:=false; selection jsonb;
begin
 if private.rpc_error_envelope('22023','DOCUMENT_REQUIRED_FIELDS:education')#>>'{__safetyhubRpcError,message}'<>'DOCUMENT_REQUIRED_FIELDS:education' then raise exception 'Safe education envelope was lost'; end if;
 if private.rpc_error_envelope('42501','DOCUMENT_REQUIRED_FIELDS:education')#>>'{__safetyhubRpcError,message}'='DOCUMENT_REQUIRED_FIELDS:education' then raise exception 'Education envelope accepted the wrong SQLSTATE'; end if;
 if private.rpc_error_envelope('22023','DOCUMENT_REQUIRED_FIELDS:education,email')#>>'{__safetyhubRpcError,message}'='DOCUMENT_REQUIRED_FIELDS:education,email' then raise exception 'Unsafe field suffix escaped sanitizer'; end if;
 if private.sanitize_bulk_mutation_result('[{"status":"skipped","reason":"DOCUMENT_REQUIRED_FIELDS:education,email"}]')#>>'{0,reason}'<>'OPERATION_SKIPPED' then raise exception 'Unsafe bulk suffix escaped sanitizer'; end if;
 c:=pg_temp.document_certificate_fixture();
 if c.score >= c.total then raise exception 'Fixture must permit a score improvement'; end if;
 before_doc:=to_jsonb(c);
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,'started',null,null,now(),now()+make_interval(mins=>duration_minutes),null,locale
 from public.test_attempts where id=c.attempt_id returning * into a;
 select jsonb_agg(jsonb_build_object('questionId',question.value->>'id','optionId',keys.correct_option_ids->>(question.ordinality::integer-1)) order by question.ordinality)
 into answers from public.test_revision_variants variant
 join private.test_revision_variant_answer_keys keys on keys.variant_id=variant.id
 cross join lateral jsonb_array_elements(variant.questions) with ordinality question(value,ordinality)
 where variant.id=a.variant_id;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',c.user_id)::text,true);
 perform set_config('request.jwt.claim.sub',c.user_id::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 -- Only the education refusal is caught. Existing unrelated requirements stay strict.
 update public.document_profiles set body=jsonb_set(body,'{family}','"ptm"') where course_slug=c.test_slug;
 begin perform private.complete_test_attempt_unmetered(a.id,answers);
 exception when sqlstate '22023' then
  if sqlerrm='DOCUMENT_REQUIRED_FIELDS:trainingReason' then blocked:=true; else raise; end if;
 end;
 if not blocked then raise exception 'Non-education issuance error was silently swallowed'; end if;
 if (select status from public.test_attempts where id=a.id)<>'started' then raise exception 'Unrelated exception did not rollback completion'; end if;
 update public.document_profiles set body=jsonb_set(body,'{family}','"general"') where course_slug=c.test_slug;
 update public.profiles set education='' where id=c.user_id;
 result:=private.complete_test_attempt_unmetered(a.id,answers);
 if result->>'status'<>'passed' or (result->>'score')::integer<>c.total then raise exception 'Improved attempt not completed: %',result; end if;
 if not exists(select 1 from public.attestations where id=c.attestation_id and best_attempt_id=a.id and best_score=c.total) then raise exception 'Improved attestation was lost'; end if;
 if (select to_jsonb(cert) from public.certificates cert where id=c.id) is distinct from before_doc then raise exception 'Refused auto-replacement changed historical certificate'; end if;
 if (select count(*) from public.certificates where user_id=c.user_id)<>1 then raise exception 'Refused replacement created a certificate'; end if;
 if exists(select 1 from public.admin_audit_log where target_id=c.id::text and action='certificate.revoked') then raise exception 'Refused replacement left a phantom revocation audit'; end if;
 if not exists(select 1 from public.admin_audit_log where target_id=a.id::text and action='test.passed') then raise exception 'Successful training audit was lost'; end if;
 if not exists(select 1 from private.admin_attestation_rows where attestation_id=c.attestation_id and certificate_state='issued' and score_improved) then raise exception 'Read model lost old download or new result'; end if;
 -- Retry completion is idempotent even before education is supplied.
 result:=private.complete_test_attempt_unmetered(a.id,answers);
 if (result->>'score')::integer<>c.total then raise exception 'Completion retry lost best score'; end if;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated',actor::text||'@education-recovery.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 update public.profiles set avatar_updated_at=now() where id=c.user_id;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 selection:=public.resolve_admin_attestation_selection(p_organization=>c.organization);
 if (selection->>'ready')::integer<>1 or (selection->>'exportable')::integer<>1 then raise exception 'Recovery not counted as both actionable and exportable: %',selection; end if;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),recovery_action,array[c.attestation_id]);
 if result#>>'{items,0,reason}'<>'DOCUMENT_REQUIRED_FIELDS:education' or result#>>'{items,0,status}'<>'skipped' then raise exception 'Explicit issue must still enforce education: %',result; end if;
 if (select to_jsonb(cert) from public.certificates cert where id=c.id) is distinct from before_doc then raise exception 'Failed explicit issue changed old certificate'; end if;
 update public.profiles set education='Среднее профессиональное' where id=c.user_id;
 result:=public.execute_admin_attestation_action(receipt,recovery_action,array[c.attestation_id]);
 if result#>>'{items,0,status}'<>'completed' then raise exception 'Explicit recovery failed: %',result; end if;
 select * into strict newer from public.certificates where user_id=c.user_id and revoked_at is null;
 if newer.score<>c.total or newer.attempt_id<>a.id or newer.supersedes_certificate_id<>c.id or newer.document_snapshot->>'education'<>'Среднее профессиональное' then raise exception 'Recovery lost score, predecessor or education'; end if;
 if (select document_snapshot from public.certificates where id=c.id) is distinct from c.document_snapshot then raise exception 'Recovery rewrote historical snapshot'; end if;
 result:=public.execute_admin_attestation_action(receipt,recovery_action,array[c.attestation_id]);
 if not (result->>'replayed')::boolean then raise exception 'Receipt retry was not replayed'; end if;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),recovery_action,array[c.attestation_id]);
 if result#>>'{items,0,status}'<>'already_completed' then raise exception 'Equal-score issue was not idempotent'; end if;
 update public.profiles set avatar_updated_at=now() where id=c.user_id;
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'confirm_and_issue',array[c.attestation_id]);
 if result#>>'{items,0,status}'<>'already_completed' then raise exception 'Equal-score confirm and issue was not idempotent: %',result; end if;
 if (select count(*) from public.certificates where user_id=c.user_id)<>2 then raise exception 'Idempotent retries created another document'; end if;
end; $test$;
select pg_temp.verify_education_recovery('issue');
select pg_temp.verify_education_recovery('confirm_and_issue');
rollback;
