begin;

-- One commission and one stamp for every course, kept with «Общее». Issuance
-- writes the commission of the day into the document; a later commission
-- changes the next documents only.
create function pg_temp.issue(p_organization text) returns public.certificates
language plpgsql as $$
declare learner uuid:=gen_random_uuid(); r public.test_revisions; a public.test_attempts; att uuid; c public.certificates; title text;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug='plotnik' limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
   values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@shared-commission.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Слушатель',education='Высшее',job='Плотник',organization=p_organization where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job='Плотник',organization=p_organization,verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),r.question_count,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 select l.title into strict title from public.test_revision_localizations l where l.revision_id=r.id and l.locale='ru';
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-COMMISSION-'||replace(gen_random_uuid()::text,'-',''),learner,r.id,att,a.id,1,'Тестовый Слушатель','Плотник',p_organization,r.slug,title,title,'ru',a.score,r.question_count,r.pass_score,a.completed_at,'manual') returning * into c;
 return c;
end; $$;

do $test$
declare actor uuid:=gen_random_uuid(); chair text; signature uuid; foreign_signature uuid; stamp uuid;
 result jsonb; c public.certificates; later public.certificates; before jsonb;
 signers jsonb;
begin
 if exists(select 1 from public.document_profiles where body ? 'commission' or body ? 'stampAssetId') then
   raise exception 'a profile still keeps a commission of its own';
 end if;
 if not private.valid_document_commission((select document_commission from public.certificate_settings where singleton)) then
   raise exception 'the shared commission is not valid';
 end if;
 select document_commission#>>'{signers,0,signerId}' into strict chair from public.certificate_settings where singleton;
 insert into public.document_assets(owner_id,kind,sha256,object_key) values(chair,'signature',repeat('1',64),repeat('1',64)||'.png') returning id into signature;
 insert into public.document_assets(owner_id,kind,sha256,object_key) values('somebody-else','signature',repeat('2',64),repeat('2',64)||'.png') returning id into foreign_signature;
 insert into public.document_assets(owner_id,kind,sha256,object_key) values('work-safety','stamp',repeat('3',64),repeat('3',64)||'.png') returning id into stamp;

 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',actor,'authenticated','authenticated','shared-commission@safetyhub.invalid','{}','{}',now(),now());
 update public.user_roles set role='admin' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);

 -- A signature registered to somebody else is not this person's.
 result:=public.update_certificate_settings(jsonb_build_object('documentCommission',jsonb_build_object(
   'signers',jsonb_build_array(jsonb_build_object('signerId',chair,'name','Председатель','position','Директор','assetId',foreign_signature)),
   'stampAssetId',null)),(select version from public.certificate_settings));
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_SIGNER_ASSET_MISMATCH' then raise exception 'a foreign signature was accepted: %',result; end if;
 -- A signature is not a stamp.
 result:=public.update_certificate_settings(jsonb_build_object('documentCommission',jsonb_build_object(
   'signers',jsonb_build_array(jsonb_build_object('signerId',chair,'name','Председатель','position','Директор','assetId',signature)),
   'stampAssetId',signature)),(select version from public.certificate_settings));
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_STAMP_INVALID' then raise exception 'a signature was accepted as the stamp: %',result; end if;
 -- A commission without anybody in it signs nothing.
 result:=public.update_certificate_settings(jsonb_build_object('documentCommission',jsonb_build_object('signers','[]'::jsonb,'stampAssetId',null)),
   (select version from public.certificate_settings));
 if result#>>'{__safetyhubRpcError,message}' is distinct from 'DOCUMENT_COMMISSION_INVALID' then raise exception 'an empty commission was accepted: %',result; end if;

 signers:=jsonb_build_array(
   jsonb_build_object('signerId',chair,'name','Председатель','position','Директор','assetId',signature),
   jsonb_build_object('signerId','signer-0a1b2c3d','name','Новый член','position','Преподаватель','assetId',null));
 result:=public.update_certificate_settings(jsonb_build_object('documentCommission',jsonb_build_object('signers',signers,'stampAssetId',stamp)),
   (select version from public.certificate_settings));
 if result ? '__safetyhubRpcError' then raise exception 'the commission was not saved: %',result; end if;
 if result->'documentCommission'->'signers' is distinct from signers then raise exception 'the saved commission does not read back: %',result; end if;

 -- The commission of the day is written into the document.
 c:=pg_temp.issue('Shared commission fixture');
 if c.document_snapshot#>>'{profile,commission,0,assetId}' is distinct from signature::text
   or c.document_snapshot#>>'{profile,commission,1,name}' is distinct from 'Новый член'
   or c.document_snapshot#>>'{profile,stampAssetId}' is distinct from stamp::text then
   raise exception 'issuance did not write the commission in: %',c.document_snapshot->'profile';
 end if;
 before:=c.document_snapshot;

 -- A later commission changes the next document, never this one.
 result:=public.update_certificate_settings(jsonb_build_object('documentCommission',jsonb_build_object(
   'signers',jsonb_build_array(jsonb_build_object('signerId',chair,'name','Другой председатель','position','Директор','assetId',null)),
   'stampAssetId',null)),(select version from public.certificate_settings));
 if result ? '__safetyhubRpcError' then raise exception 'the second commission was not saved: %',result; end if;
 if (select document_snapshot from public.certificates where id=c.id) is distinct from before then
   raise exception 'a new commission rewrote an issued document';
 end if;
 later:=pg_temp.issue('Shared commission fixture, later');
 if later.document_snapshot#>>'{profile,commission,0,name}' is distinct from 'Другой председатель'
   or later.document_snapshot#>'{profile,stampAssetId}' is distinct from 'null'::jsonb then
   raise exception 'the next document did not take the new commission: %',later.document_snapshot->'profile';
 end if;
end; $test$;

rollback;
