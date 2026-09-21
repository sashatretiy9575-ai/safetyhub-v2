begin;

-- Issuing a document used to stop on a box nobody had filled in: the kind of
-- knowledge check, the reason for the training, the decision of the commission,
-- the listener category. Each of those is the wording of the paper form, and the
-- database now fills it the way lib/pdf/document-family-defaults.ts does.
create function pg_temp.issuance_fixture(p_job text) returns public.certificates
language plpgsql as $$
declare learner uuid:=gen_random_uuid(); r public.test_revisions; a public.test_attempts; att uuid; c public.certificates; title text;
begin
 select revision.* into strict r from public.tests t join public.test_revisions revision on revision.id=t.current_revision_id where t.slug='plotnik' limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',learner::text||'@document-defaults.invalid','{}','{}',now(),now());
 update public.profiles set name='Тестовый',surname='Слушатель',education='Высшее',job=p_job,organization='Document defaults fixture' where id=learner;
 update public.verified_identities set status='verified',version=1,name='Тестовый',surname='Слушатель',job=p_job,organization='Document defaults fixture',verified_at=now() where user_id=learner;
 insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
 select learner,r.id,r.test_id,v.id,r.duration_minutes,r.pass_score,r.attempts_per_calendar_day,r.attempt_reset_timezone,
 'passed',array_fill(1::smallint,array[v.question_count]),r.question_count,now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>r.duration_minutes),now(),'ru'
 from public.test_revision_variants v where v.revision_id=r.id order by v.id limit 1 returning * into strict a;
 insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at) values(learner,r.id,a.id,a.score,a.completed_at) returning id into att;
 select l.title into strict title from public.test_revision_localizations l where l.revision_id=r.id and l.locale='ru';
 insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
 values('SH-DEFAULTS-'||learner,learner,r.id,att,a.id,1,'Тестовый Слушатель',p_job,'Document defaults fixture',r.slug,title,title,'ru',a.score,r.question_count,r.pass_score,a.completed_at,'manual') returning * into c;
 return c;
end; $$;

create function pg_temp.install_profile(p_id text,p_audience text,p_family text) returns void
language plpgsql as $$
begin
 insert into public.document_profiles(id,course_slug,audience,body) values(p_id,'plotnik',p_audience,
  jsonb_build_object('id',p_id,'courseSlug','plotnik','audience',p_audience,'label',p_id,'programName','Программа '||p_id,
  'family',p_family,'hours',null,'validityMonths',0,'protocolText','','decisionText','','orderNumber','','orderDate','','verificationKind','',
  'commission',jsonb_build_array(jsonb_build_object('signerId','fixture','name','Проверяющий','position','Комиссия','assetId',null)),'stampAssetId',null));
end; $$;

do $test$
declare c public.certificates; profile jsonb; details jsonb;
begin
 update public.document_batches set profile_id=null where course_slug='plotnik';
 delete from public.document_profiles where course_slug='plotnik';

 -- A protocol of the «БиОТ» form: the order line stays empty on the paper, and
 -- the kind of check is the same word on every one of them.
 perform pg_temp.install_profile('defaults-biot','all','biot');
 c:=pg_temp.issuance_fixture('Плотник');
 profile:=c.document_snapshot->'profile';
 if profile->>'verificationKind'<>'периодический' then raise exception 'BIOT_VERIFICATION_KIND: %',profile->>'verificationKind'; end if;
 if coalesce(profile->>'orderNumber','')<>'' then raise exception 'BIOT_ORDER_NUMBER_FILLED'; end if;
 if (profile->>'validityMonths')::int<>36 then raise exception 'BIOT_VALIDITY: %',profile->>'validityMonths'; end if;
 if coalesce(btrim(profile->>'protocolText'),'')='' or coalesce(btrim(profile->>'decisionText'),'')='' then raise exception 'BIOT_TEXTS_EMPTY'; end if;
 if coalesce(c.document_snapshot#>>'{participantFields,notes}','X')<>'' then raise exception 'BIOT_NOTES_NOT_EMPTY'; end if;
 -- Empty is the default, not the only possibility: a note somebody deliberately
 -- wrote for one listener is printed in their row.
 insert into public.document_batches(organization,course_slug,document_date,protocol_number,participant_fields)
 values(c.organization,c.test_slug,current_date,'NOTE-REGRESSION',jsonb_build_object(c.user_id::text,jsonb_build_object('notes','Повторная проверка')))
 on conflict(organization_key,course_slug) do update set participant_fields=excluded.participant_fields,version=document_batches.version+1;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='notes regression' where id=c.id;
 insert into public.certificates select (jsonb_populate_record(null::public.certificates,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'certificate_number','SH-DEFAULTS-NOTE','document_snapshot',null,'revoked_at',null,'revoke_reason',null))).* returning * into c;
 if c.document_snapshot#>>'{participantFields,notes}'<>'Повторная проверка' then raise exception 'BIOT_NOTE_LOST: %',c.document_snapshot#>>'{participantFields,notes}'; end if;
 update public.certificates set revoked_at=statement_timestamp(),revoke_reason='notes regression' where id=c.id;

 -- «Причина обучения» of a fire-safety protocol, and its volume in hours.
 delete from public.document_profiles where course_slug='plotnik';
 perform pg_temp.install_profile('defaults-ptm','worker','ptm');
 c:=pg_temp.issuance_fixture('Плотник');
 profile:=c.document_snapshot->'profile';
 details:=c.document_snapshot->'participantFields';
 if details->>'trainingReason'<>'Первичный' then raise exception 'PTM_TRAINING_REASON: %',details->>'trainingReason'; end if;
 if (profile->>'hours')::int<>10 then raise exception 'PTM_HOURS: %',profile->>'hours'; end if;

 -- The decision of a qualification commission is the trade it awards.
 delete from public.document_profiles where course_slug='plotnik';
 perform pg_temp.install_profile('defaults-qualification','all','qualification');
 c:=pg_temp.issuance_fixture('Плотник');
 details:=c.document_snapshot->'participantFields';
 if details->>'qualificationDecision'<>'Программа defaults-qualification' then raise exception 'QUALIFICATION_DECISION: %',details->>'qualificationDecision'; end if;
 if ((c.document_snapshot->'profile')->>'validityMonths')::int<>0 then raise exception 'QUALIFICATION_VALIDITY'; end if;

 -- Industrial safety: the sitting recorded by this protocol is the examination
 -- record, so nothing is typed in first — but a failed attempt is still refused.
 delete from public.document_profiles where course_slug='plotnik';
 perform pg_temp.install_profile('defaults-industrial','itr','industrial');
 c:=pg_temp.issuance_fixture('Инженер');
 details:=c.document_snapshot->'participantFields';
 if details->>'formalExamResult'<>'passed' then raise exception 'INDUSTRIAL_EXAM_RESULT: %',details->>'formalExamResult'; end if;
 if coalesce(btrim(details->>'formalExamReference'),'')='' then raise exception 'INDUSTRIAL_EXAM_REFERENCE_EMPTY'; end if;
 -- A programme split by category binds by the position the person holds.
 if (c.document_snapshot->'profile')->>'id'<>'defaults-industrial' then raise exception 'AUDIENCE_BY_POSITION: %',(c.document_snapshot->'profile')->>'id'; end if;
end; $test$;

-- A person whose position is not a supervisory one takes the worker profile of
-- the same programme, and one who does takes the engineers' profile.
do $test$
declare c public.certificates;
begin
 update public.document_batches set profile_id=null where course_slug='plotnik';
 delete from public.document_profiles where course_slug='plotnik';
 perform pg_temp.install_profile('split-worker','worker','ptm');
 perform pg_temp.install_profile('split-itr','itr','ptm');
 c:=pg_temp.issuance_fixture('Стропальщик');
 if (c.document_snapshot->'profile')->>'id'<>'split-worker' then raise exception 'WORKER_AUDIENCE: %',(c.document_snapshot->'profile')->>'id'; end if;
 c:=pg_temp.issuance_fixture('Начальник участка');
 if (c.document_snapshot->'profile')->>'id'<>'split-itr' then raise exception 'ITR_AUDIENCE: %',(c.document_snapshot->'profile')->>'id'; end if;
end; $test$;

-- The learner who did not pass still cannot receive an industrial-safety document.
do $test$
declare c public.certificates; refused boolean:=false;
begin
 update public.document_batches set profile_id=null where course_slug='plotnik';
 delete from public.document_profiles where course_slug='plotnik';
 perform pg_temp.install_profile('defaults-industrial-fail','all','industrial');
 c:=pg_temp.issuance_fixture('Инженер');
 -- The guard reads the row being inserted, so a failing score is built directly.
 begin
  insert into public.certificates(certificate_number,user_id,revision_id,attestation_id,attempt_id,identity_version,full_name,job,organization,test_slug,test_title,localized_test_title,locale,score,total,pass_score,best_completed_at,issue_source)
  select 'SH-DEFAULTS-FAIL-'||c.user_id,c.user_id,c.revision_id,c.attestation_id,c.attempt_id,1,c.full_name,c.job,c.organization,c.test_slug,c.test_title,c.localized_test_title,'ru',0,c.total,c.pass_score,c.best_completed_at,'manual';
 exception when others then if sqlerrm='DOCUMENT_FORMAL_EXAM_REQUIRED' then refused:=true; else raise; end if;
 end;
 if not refused then raise exception 'FAILED_ATTEMPT_NOT_REFUSED'; end if;
end; $test$;

rollback;
