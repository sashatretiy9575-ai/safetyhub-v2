begin;
do $test$
declare actor uuid:=gen_random_uuid(); learner uuid; test_slug text; revision uuid; course_id uuid;
 data jsonb; settings jsonb; changed jsonb; batch jsonb; count_before integer; blocked boolean:=false;
begin
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','document-admin@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 select slug,id,current_revision_id into test_slug,course_id,revision from public.tests where current_revision_id is not null order by slug limit 1;
 if test_slug is null then raise exception 'Test requires a seeded published course'; end if;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select '00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated',
 'document-person-'||n||'@safetyhub.invalid','{}','{}',now(),now() from generate_series(1,1101) n;
 update public.profiles set organization='Document editor regression',name='Участник',surname=substring(u.email from 'document-person-([0-9]+)')
 from auth.users u where u.id=profiles.id and u.email like 'document-person-%@safetyhub.invalid';
 select id into learner from public.profiles where organization='Document editor regression' order by surname limit 1;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'failed',array_fill(1::smallint,array[v.question_count]),0,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now()
 from public.test_revisions r join public.test_revision_variants v on v.revision_id=r.id where r.id=revision limit 1;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 data:=public.get_document_editor_data('Document editor regression',test_slug);
 if jsonb_array_length(data->'participants')<>1101 then raise exception 'Company was truncated'; end if;
 select count(*) into count_before from jsonb_array_elements(data->'participants') p where p->>'status'='failed';
 if count_before<>1 then raise exception 'Failed result missing'; end if;
 if exists(select 1 from jsonb_array_elements(data->'participants') p where p->>'status'='passed' or p->>'certificateId' is not null) then raise exception 'Fabricated pass or certificate'; end if;
 settings:=public.get_certificate_settings(false);
 changed:=public.update_certificate_settings(jsonb_build_object('documentDefaults',(settings->'documentDefaults')||'{"reviewerName":"Новый проверяющий","commission":[]}'::jsonb),(settings->>'version')::bigint);
 if changed ? '__safetyhubRpcError' or changed#>>'{documentDefaults,reviewerName}'<>'Новый проверяющий' then raise exception 'Defaults save failed: %',changed; end if;
 changed:=public.update_certificate_settings('{"organizationName":"Incorrect overwrite"}',(settings->>'version')::bigint);
 if changed#>>'{__safetyhubRpcError,message}' is distinct from 'CERTIFICATE_SETTINGS_VERSION_CONFLICT' then raise exception 'Missing version conflict: %',changed; end if;
 if (public.get_certificate_settings(false)->>'organizationName')='Incorrect overwrite' then raise exception 'Conflict overwrote data'; end if;
 batch:=public.save_document_batch('Document editor regression',test_slug,'2026-09-08','ignored',true,0);
 if batch->>'protocol_number'<>'08.09' then raise exception 'Wrong date number'; end if;
 batch:=public.save_document_batch('Document editor regression',test_slug,'2026-09-09','MANUAL/7',false,(batch->>'version')::bigint);
 if batch->>'protocol_number'<>'MANUAL/7' then raise exception 'Manual number lost'; end if;
 data:=public.get_document_editor_data('Document editor regression',test_slug);
 if data#>>'{batch,protocol_number}'<>'MANUAL/7' then raise exception 'Batch not restored'; end if;
 begin perform public.save_document_batch('Document editor regression',test_slug,'2026-09-09','wrong',false,1);
 exception when serialization_failure then blocked:=true; end;
 if not blocked then raise exception 'Stale batch update accepted'; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',learner)::text,true);
 perform set_config('request.jwt.claim.sub',learner::text,true);
 blocked:=false;
 begin perform public.get_document_editor_data('Document editor regression',test_slug);
 exception when others then if sqlerrm like '%CAPABILITY%' or sqlerrm like '%FORBIDDEN%' then blocked:=true; else raise; end if; end;
 if not blocked then raise exception 'Learner read company documents'; end if;
 if has_table_privilege('authenticated','public.document_batches','select') or has_function_privilege('anon','public.get_document_editor_data(text,text)','execute') then raise exception 'Public data exposure'; end if;
end;
$test$;
rollback;
