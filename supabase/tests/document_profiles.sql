begin;
do $test$
declare old_certificate public.certificates; created public.certificates; before_snapshot jsonb; changed boolean:=false; profile_body jsonb;
begin
 select * into old_certificate from public.certificates where revoked_at is null and course_deleted_at is null order by (test_slug in ('plotnik','armaturshchik')) desc,id limit 1;
 if old_certificate.id is null then raise exception 'Document snapshot regression requires a seeded issued certificate'; end if;
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
 changed:=false;
 begin
   insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(created)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','SH-DOCUMENT-REQUIRED-TEST','document_snapshot',null))).*;
 exception when others then if sqlerrm='DOCUMENT_REQUIRED_FIELDS:trainingReason' then changed:=true; else raise; end if; end;
 if not changed then raise exception 'PTM issuance accepted a missing training reason'; end if;
 update public.document_profiles set audience='worker',body=jsonb_set(body,'{audience}','"worker"') where id='regression-all';
 changed:=false;
 begin
   insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(created)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','SH-DOCUMENT-AUDIENCE-TEST','document_snapshot',null))).*;
 exception when others then if sqlerrm='DOCUMENT_PROFILE_REQUIRED' then changed:=true; else raise; end if; end;
 if not changed then raise exception 'Issuance guessed an audience without an explicit selection'; end if;
 if has_table_privilege('authenticated','public.document_assets','select') or has_table_privilege('anon','public.certificate_settings_versions','select') then raise exception 'Private asset metadata exposed'; end if;
 if exists(select 1 from public.certificates where document_snapshot#>>'{settings,stampPng}' is not null) then raise exception 'Image bytes copied to certificates'; end if;
end;
$test$;
rollback;
