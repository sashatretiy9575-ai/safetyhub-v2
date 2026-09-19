begin;
create function pg_temp.copy_exam_certificate(c public.certificates,number text) returns uuid
language plpgsql as $$ declare created uuid; begin
 insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'certificate_number',number,'document_snapshot',null,'issued_at',statement_timestamp()))).* returning id into created;
 return created;
end; $$;
do $test$
declare c public.certificates; actor uuid:=gen_random_uuid(); b public.document_batches; result jsonb; issued uuid; snapshot jsonb; blocked boolean;
begin
 select * into c from public.certificates where revoked_at is null and course_deleted_at is null order by (test_slug in ('plotnik','armaturshchik')) desc,id limit 1;
 if c.id is null then raise exception 'Formal exam regression requires a seeded issued certificate'; end if;
 update public.document_batches set profile_id=null where course_slug=c.test_slug;
 delete from public.document_profiles where course_slug=c.test_slug;
 insert into public.document_profiles(id,course_slug,audience,body) values('formal-exam-regression',c.test_slug,'all',jsonb_build_object('id','formal-exam-regression','courseSlug',c.test_slug,'audience','all','label','Regression','programName','Regression','family','industrial','hours',10,'validityMonths',0,'protocolText','Проверка','decisionText','Результат','orderNumber','','orderDate','','verificationKind','','commission','[]'::jsonb,'stampAssetId',null));
 insert into public.document_batches(organization,course_slug,document_date,protocol_number,profile_id)
 values(c.organization,c.test_slug,current_date,'FORMAL-REGRESSION','formal-exam-regression')
 on conflict(organization_key,course_slug) do update set profile_id=excluded.profile_id,participant_fields='{}',version=document_batches.version+1 returning * into b;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='formal exam regression' where id=c.id;
 blocked:=false;
 begin perform pg_temp.copy_exam_certificate(c,'SH-FORMAL-ABSENT');
 exception when others then if sqlerrm='DOCUMENT_FORMAL_EXAM_REQUIRED' then blocked:=true; else raise; end if; end;
 if not blocked then raise exception 'Learning quiz alone issued an industrial document'; end if;

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
 update public.document_profiles set version=version+1 where id='formal-exam-regression';
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='regression' where id=issued;
 blocked:=false;
 begin perform pg_temp.copy_exam_certificate(c,'SH-FORMAL-STALE-PROFILE');
 exception when others then if sqlerrm='DOCUMENT_FORMAL_EXAM_REQUIRED' then blocked:=true; else raise; end if; end;
 if not blocked then raise exception 'Changed profile accepted previous exam evidence'; end if;
 blocked:=false;
 begin perform public.save_document_participant_fields(b.id,c.user_id,jsonb_build_object('formalExamReference','Future invalid','formalExamDate',(current_date+10)::text,'formalExamResult','passed'),b.version);
 exception when others then if sqlerrm='DOCUMENT_FORMAL_EXAM_INVALID' then blocked:=true; else raise; end if; end;
 if not blocked then raise exception 'Future formal exam accepted'; end if;
 if (select document_snapshot from public.certificates where id=issued) is distinct from snapshot then raise exception 'Formal exam evidence changed after issuance'; end if;
end;
$test$;
rollback;
