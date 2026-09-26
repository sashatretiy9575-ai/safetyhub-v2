begin;

-- The protocol date and number are chosen when documents are issued. Nothing
-- saved for a company earlier sticks to a later issuance.
create function pg_temp.attestation(p_organization text) returns uuid
language plpgsql as $$
declare learner uuid:=gen_random_uuid(); r public.test_revisions; a public.test_attempts; att uuid;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug='plotnik' limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
   values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@issue-protocol.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Слушатель',education='Высшее',job='Плотник',organization=p_organization where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job='Плотник',organization=p_organization,verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 -- Sat three days ago: a sitting dated yesterday may not precede the exam.
 'passed',array_fill(1::smallint,array[v.question_count]),r.question_count,now()-interval '3 days',now()-interval '3 days'+make_interval(mins=>r.duration_minutes),now()-interval '3 days'+interval '1 minute','ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 return att;
end; $$;

do $test$
declare actor uuid:=gen_random_uuid(); key uuid; first uuid; second uuid; third uuid; result jsonb;
 today date:=(statement_timestamp() at time zone 'Asia/Oral')::date; snapshot jsonb; blocked boolean;
begin
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','issue-protocol@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);

 -- A date and a number chosen in the dialog are the ones printed.
 first:=pg_temp.attestation('Issue protocol fixture');
 key:=gen_random_uuid();
 result:=public.execute_admin_attestation_action(key,'issue',array[first],null,null,null,today-1,'15-П');
 if result#>>'{items,0,status}' is distinct from 'completed' then raise exception 'the issuance failed: %',result; end if;
 select document_snapshot into snapshot from public.certificates where attestation_id=first and revoked_at is null;
 if snapshot->>'protocolDate' is distinct from (today-1)::text or snapshot->>'protocolNumber' is distinct from '15-П' then
   raise exception 'the chosen sitting was not printed: % %',snapshot->>'protocolDate',snapshot->>'protocolNumber';
 end if;
 if coalesce(current_setting('safetyhub.document_date',true),'')<>'' or coalesce(current_setting('safetyhub.protocol_number',true),'')<>'' then
   raise exception 'the chosen sitting outlived the issuance';
 end if;
 -- The archive draws the document from the same snapshot.
 result:=public.resolve_certificate_export(array[first]);
 if result#>>'{items,0,documentSnapshot,protocolNumber}' is distinct from '15-П'
   or result#>>'{items,0,documentSnapshot,protocolDate}' is distinct from (today-1)::text then
   raise exception 'the archive does not carry the snapshot: %',result#>'{items,0}';
 end if;

 -- The same request again is a replay; the same key with another number is refused.
 result:=public.execute_admin_attestation_action(key,'issue',array[first],null,null,null,today-1,'15-П');
 if (result->>'replayed')::boolean is distinct from true then raise exception 'a repeated request was not a replay: %',result; end if;
 blocked:=false;
 begin
   perform public.execute_admin_attestation_action(key,'issue',array[first],null,null,null,today-1,'16-П');
 exception when others then blocked:=sqlerrm='IDEMPOTENCY_KEY_REUSED';
 end;
 if not blocked then raise exception 'one key carried two different protocols'; end if;

 -- Nothing sticks: a date and a number stored for the company earlier are not
 -- a later issuance's, which is dated by its own day.
 insert into public.document_batches(organization,course_slug,document_date,protocol_number)
 values('Issue protocol fixture 2','plotnik',date '2026-01-15','OLD-NUMBER')
 on conflict(organization_key,course_slug) do update set document_date=excluded.document_date,protocol_number=excluded.protocol_number;
 second:=pg_temp.attestation('Issue protocol fixture 2');
 result:=public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[second]);
 select document_snapshot into snapshot from public.certificates where attestation_id=second and revoked_at is null;
 if snapshot->>'protocolDate' is distinct from today::text or snapshot->>'protocolNumber' is distinct from to_char(today,'DD.MM') then
   raise exception 'an old record of the company stuck to a new issuance: % %',snapshot->>'protocolDate',snapshot->>'protocolNumber';
 end if;

 -- A protocol cannot be dated after today, and a number is a short line.
 third:=pg_temp.attestation('Issue protocol fixture 3');
 blocked:=false;
 begin
   perform public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[third],null,null,null,today+1,null);
 exception when others then blocked:=sqlerrm='DOCUMENT_DATE_INVALID';
 end;
 if not blocked then raise exception 'a protocol was dated in the future'; end if;
 blocked:=false;
 begin
   perform public.execute_admin_attestation_action(gen_random_uuid(),'issue',array[third],null,null,null,null,repeat('9',41));
 exception when others then blocked:=sqlerrm='PROTOCOL_NUMBER_INVALID';
 end;
 if not blocked then raise exception 'a 41-character protocol number was accepted'; end if;
 if exists(select 1 from public.certificates where attestation_id=third) then raise exception 'a refused issuance left a document'; end if;

 -- A corrected document keeps the sitting of the one it replaces.
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='Исправлены данные' where attestation_id=first and revoked_at is null;
 update public.verified_identities set version=version+1 where user_id=(select user_id from public.attestations where id=first);
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source,supersedes_certificate_id)
 select 'SH-ISSUE-PROTOCOL-CORRECTED',user_id,revision_id,attestation_id,attempt_id,identity_version+1,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,'identity_correction',id
 from public.certificates where attestation_id=first and certificate_number<>'SH-ISSUE-PROTOCOL-CORRECTED' order by issued_at desc limit 1
 returning document_snapshot into snapshot;
 if snapshot->>'protocolDate' is distinct from (today-1)::text or snapshot->>'protocolNumber' is distinct from '15-П' then
   raise exception 'a corrected document left its sitting: % %',snapshot->>'protocolDate',snapshot->>'protocolNumber';
 end if;
end; $test$;

rollback;
