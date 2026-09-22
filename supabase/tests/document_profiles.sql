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
declare old_certificate public.certificates; created public.certificates; before_snapshot jsonb; changed boolean:=false; profile_body jsonb;
begin
 old_certificate:=pg_temp.document_certificate_fixture();
 profile_body:=jsonb_build_object('id','regression-all','courseSlug',old_certificate.test_slug,'audience','all','label','Regression','programName','Regression',
 'family','general','hours',null,'validityMonths',0,'protocolText','Проверка знаний: {program}','decisionText','Результаты зафиксированы','orderNumber','','orderDate','','verificationKind','',
 'commission',jsonb_build_array(jsonb_build_object('signerId','fixture','name','Проверяющий','position','Комиссия','assetId',null)),'stampAssetId',null);
 -- Scope this temporary profile to the fixture course without depending on
 -- the external asset import. The entire test rolls back.
 update public.document_batches set profile_id=null where course_slug=old_certificate.test_slug;
 delete from public.document_profiles where course_slug=old_certificate.test_slug;
 insert into public.document_profiles(id,course_slug,audience,body) values('regression-all',old_certificate.test_slug,'all',profile_body);
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='regression successor' where id=old_certificate.id;
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-DOCUMENT-SNAPSHOT-TEST',old_certificate.user_id,old_certificate.revision_id,old_certificate.attestation_id,old_certificate.attempt_id,old_certificate.identity_version,old_certificate.full_name,old_certificate.job,old_certificate.organization,old_certificate.test_slug,old_certificate.test_title,old_certificate.localized_test_title,old_certificate.locale,old_certificate.score,old_certificate.total,old_certificate.pass_score,old_certificate.best_completed_at,'manual') returning * into created;
 if created.document_snapshot->>'captureKind'<>'issuance' or created.document_snapshot#>>'{profile,id}'<>'regression-all' then raise exception 'Issuance failed to capture selected profile'; end if;
 before_snapshot:=created.document_snapshot;
 update public.document_profiles set body=jsonb_set(body,'{programName}','"Changed after issuance"'),version=version+1 where id='regression-all';
 update public.certificate_settings set organization_name='Changed after issuance',version=version+1;
 if (select document_snapshot from public.certificates where id=created.id) is distinct from before_snapshot then raise exception 'Configuration edits changed existing issuance'; end if;
 if private.certificate_download_payload(created.id)->'documentSnapshot' is distinct from before_snapshot then raise exception 'Download did not return immutable snapshot'; end if;
 if not exists(select 1 from public.certificate_settings_versions where version=(before_snapshot#>>'{settings,version}')::bigint) then raise exception 'Referenced image settings version lost'; end if;
 begin update public.certificates set document_snapshot='{}' where id=created.id;
 exception when others then if sqlerrm in ('DOCUMENT_SNAPSHOT_IMMUTABLE','CERTIFICATE_SNAPSHOT_IMMUTABLE') then changed:=true; else raise; end if; end;
 if not changed then raise exception 'Snapshot can be rewritten'; end if;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='required field regression' where id=created.id;
 update public.document_batches set participant_fields=participant_fields-created.user_id::text where course_slug=created.test_slug;
 update public.document_profiles set body=jsonb_set(body,'{family}','"ptm"') where id='regression-all';
 -- «Причина обучения» is the same word for the whole group, so it is the wording
 -- of the form rather than a box the operator has to fill in for each person.
 insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(created)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','SH-DOCUMENT-REQUIRED-TEST','document_snapshot',null))).* returning * into created;
 if created.document_snapshot#>>'{participantFields,trainingReason}'<>'Первичный' then raise exception 'PTM issuance did not carry the default training reason: %',created.document_snapshot#>>'{participantFields,trainingReason}'; end if;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='audience regression' where id=created.id;
 -- A programme split by category binds by the position the person holds, and
 -- still refuses when no profile covers that half of it.
 update public.document_profiles set audience='worker',body=jsonb_set(body,'{audience}','"worker"') where id='regression-all';
 insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(created)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','SH-DOCUMENT-AUDIENCE-TEST','document_snapshot',null,'revoked_at',null,'revoke_reason',null))).* returning * into created;
 if created.document_snapshot#>>'{profile,audience}'<>'worker' then raise exception 'Worker position did not bind the worker profile'; end if;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='audience regression' where id=created.id;
 changed:=false;
 begin
   insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(created)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','SH-DOCUMENT-AUDIENCE-GAP-TEST','document_snapshot',null,'job','Начальник участка','revoked_at',null,'revoke_reason',null))).*;
 exception when others then if sqlerrm='DOCUMENT_PROFILE_REQUIRED' then changed:=true; else raise; end if; end;
 if not changed then raise exception 'Issuance invented a profile for an uncovered category'; end if;
 if has_table_privilege('authenticated','public.document_assets','select') or has_table_privilege('anon','public.certificate_settings_versions','select') then raise exception 'Private asset metadata exposed'; end if;
 if exists(select 1 from public.certificates where document_snapshot#>>'{settings,stampPng}' is not null) then raise exception 'Image bytes copied to certificates'; end if;
end;
$test$;

-- Replacing a registered signature or stamp rebinds profiles by version. What
-- was issued before keeps the asset ids it was issued with; only a document
-- issued afterwards draws the new image.
do $rebind$
declare prior public.certificates; issued public.certificates; successor public.certificates;
 old_signature uuid; new_signature uuid; old_stamp uuid; new_stamp uuid; v bigint; n integer; snapshots jsonb;
begin
 select * into strict prior from public.certificates where certificate_number='SH-DOCUMENT-SNAPSHOT-TEST';
 insert into public.document_assets(owner_id,kind,sha256,object_key) values('fixture','signature',repeat('a',64),repeat('a',64)||'.png') returning id into old_signature;
 insert into public.document_assets(owner_id,kind,sha256,object_key) values('fixture','signature',repeat('b',64),repeat('b',64)||'.png') returning id into new_signature;
 insert into public.document_assets(owner_id,kind,sha256,object_key) values('fixture-organization','stamp',repeat('c',64),repeat('c',64)||'.png') returning id into old_stamp;
 insert into public.document_assets(owner_id,kind,sha256,object_key) values('fixture-organization','stamp',repeat('d',64),repeat('d',64)||'.png') returning id into new_stamp;
 -- The commission and the stamp are one for every course and live on the
 -- settings row; a profile no longer carries a copy of them.
 update public.document_profiles set audience='all',version=version+1,
   body=body||jsonb_build_object('audience','all','family','general')
 where id='regression-all';
 update public.certificate_settings set version=version+1,
   document_commission=jsonb_build_object('stampAssetId',old_stamp,
     'signers',jsonb_build_array(jsonb_build_object('signerId','fixture','name','Проверяющий','position','Комиссия','assetId',old_signature)))
 where singleton;
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-DOCUMENT-REBIND-TEST',prior.user_id,prior.revision_id,prior.attestation_id,prior.attempt_id,prior.identity_version,prior.full_name,prior.job,prior.organization,prior.test_slug,prior.test_title,prior.localized_test_title,prior.locale,prior.score,prior.total,prior.pass_score,prior.best_completed_at,'manual') returning * into issued;
 if issued.document_snapshot#>>'{profile,commission,0,assetId}' is distinct from old_signature::text or issued.document_snapshot#>>'{profile,stampAssetId}' is distinct from old_stamp::text then raise exception 'Issuance did not capture the bound assets: %',issued.document_snapshot->'profile'->'commission'; end if;
 select jsonb_object_agg(id::text,document_snapshot) into snapshots from public.certificates;

 -- The statement the server runs: compare-and-swap on the version it read.
 select version into strict v from public.certificate_settings where singleton;
 update public.certificate_settings set version=v+1,updated_at=statement_timestamp(),
   document_commission=jsonb_set(jsonb_set(document_commission,'{signers,0,assetId}',to_jsonb(new_signature::text)),'{stampAssetId}',to_jsonb(new_stamp::text))
 where singleton and version=v;
 get diagnostics n=row_count;
 if n<>1 then raise exception 'Rebinding the current version wrote % rows',n; end if;
 update public.certificate_settings set version=v+1,document_commission=jsonb_set(document_commission,'{stampAssetId}','null') where singleton and version=v;
 get diagnostics n=row_count;
 if n<>0 then raise exception 'A stale version overwrote a rebound commission'; end if;

 if (select jsonb_object_agg(id::text,document_snapshot) from public.certificates) is distinct from snapshots then raise exception 'Rebinding the commission rewrote an issued snapshot'; end if;
 if private.certificate_download_payload(issued.id)#>>'{documentSnapshot,profile,commission,0,assetId}'<>old_signature::text then raise exception 'An issued document lost the signature it was issued with'; end if;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='rebind regression successor' where id=issued.id;
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-DOCUMENT-REBOUND-TEST',prior.user_id,prior.revision_id,prior.attestation_id,prior.attempt_id,prior.identity_version,prior.full_name,prior.job,prior.organization,prior.test_slug,prior.test_title,prior.localized_test_title,prior.locale,prior.score,prior.total,prior.pass_score,prior.best_completed_at,'manual') returning * into successor;
 if successor.document_snapshot#>>'{profile,commission,0,assetId}' is distinct from new_signature::text or successor.document_snapshot#>>'{profile,stampAssetId}' is distinct from new_stamp::text then raise exception 'A new issuance did not draw the replaced images'; end if;
 if (select document_snapshot from public.certificates where id=issued.id) is distinct from issued.document_snapshot then raise exception 'Revocation or reissue rewrote the earlier snapshot'; end if;
 -- The registry is written by the server alone; a browser role reaches neither table.
 if exists(select 1 from unnest(array['anon','authenticated']) r, unnest(array['select','insert','update','delete']) p
   where has_table_privilege(r,'public.document_assets',p) or has_table_privilege(r,'public.document_profiles',p)) then raise exception 'Browser roles can reach the asset registry'; end if;
 -- A registered picture is added and read, never rewritten: issued documents keep its id.
 if exists(select 1 from unnest(array['update','delete','truncate']) p where has_table_privilege('service_role','public.document_assets',p)) then raise exception 'The server role can rewrite registered assets'; end if;
 if not (has_table_privilege('service_role','public.document_assets','select') and has_table_privilege('service_role','public.document_assets','insert')) then raise exception 'The server role lost the registry it writes'; end if;
end;
$rebind$;
rollback;
