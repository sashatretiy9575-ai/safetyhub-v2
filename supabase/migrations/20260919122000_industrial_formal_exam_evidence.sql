-- The site's 10-question learning assessment is not the formal industrial
-- safety exam. An issuing operator must record the separate exam evidence.
create or replace function public.save_document_participant_fields(p_batch_id uuid,p_user_id uuid,p_fields jsonb,p_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.document_batches; k text; actor uuid; evidence jsonb:=p_fields;
begin
 perform private.require_capability('site.settings.manage');
 perform private.require_capability('results.export');
 perform private.enforce_actor_quota('site.settings.update');
 if jsonb_typeof(p_fields) is distinct from 'object' or octet_length(p_fields::text)>6000 then raise exception 'DOCUMENT_PARTICIPANT_FIELDS_INVALID'; end if;
 for k in select jsonb_object_keys(p_fields) loop
   if k not in ('trainingReason','notes','qualificationDecision','formalExamReference','formalExamDate','formalExamResult') or jsonb_typeof(p_fields->k) is distinct from 'string' or char_length(p_fields->>k)>500 then raise exception 'DOCUMENT_PARTICIPANT_FIELDS_INVALID'; end if;
 end loop;
 if coalesce(p_fields->>'formalExamResult','') not in ('','passed','failed') then raise exception 'DOCUMENT_FORMAL_EXAM_INVALID'; end if;
 if coalesce(p_fields->>'formalExamDate','')<>'' then
   if p_fields->>'formalExamDate' !~ '^\d{4}-\d{2}-\d{2}$' or (p_fields->>'formalExamDate')::date>(statement_timestamp() at time zone 'Asia/Oral')::date then raise exception 'DOCUMENT_FORMAL_EXAM_INVALID'; end if;
 end if;
 if coalesce(btrim(p_fields->>'formalExamReference'),'')<>'' or coalesce(p_fields->>'formalExamDate','')<>'' or coalesce(p_fields->>'formalExamResult','')<>'' then
   actor:=private.require_capability('certificate.issue');
   select * into b from public.document_batches where id=p_batch_id and version=p_version for update;
   if b.id is null then raise exception using errcode='40001',message='DOCUMENT_BATCH_CONFLICT'; end if;
   if not exists(select 1 from public.document_profiles p where p.id=b.profile_id and p.course_slug=b.course_slug and p.body->>'family'='industrial') then raise exception 'DOCUMENT_PROFILE_REQUIRED'; end if;
   evidence:=evidence||jsonb_build_object('formalExamConfirmedBy',actor,'formalExamConfirmedAt',statement_timestamp(),'formalExamProfileId',b.profile_id,'formalExamProfileVersion',(select version from public.document_profiles where id=b.profile_id));
 end if;
 update public.document_batches set participant_fields=jsonb_set(participant_fields,array[p_user_id::text],evidence),version=version+1,updated_at=now()
 where id=p_batch_id and version=p_version and exists(select 1 from public.profiles p where p.id=p_user_id and lower(btrim(p.organization))=document_batches.organization_key)
 returning * into b;
 if b.id is null then raise exception using errcode='40001',message='DOCUMENT_BATCH_CONFLICT'; end if;
 return jsonb_build_object('version',b.version,'formalExamProfileId',evidence->>'formalExamProfileId','formalExamProfileVersion',evidence->'formalExamProfileVersion');
end; $$;

create or replace function private.require_industrial_exam_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare p jsonb:=new.document_snapshot->'profile'; evidence jsonb:=new.document_snapshot->'participantFields';
begin
 if (new.test_slug='promyshlennaya-bezopasnost' or p->>'family'='industrial') and (
   coalesce(length(btrim(evidence->>'formalExamReference')),0)<3
   or coalesce(evidence->>'formalExamResult','')<>'passed'
   or coalesce(evidence->>'formalExamDate','') !~ '^\d{4}-\d{2}-\d{2}$'
   or coalesce(evidence->>'formalExamConfirmedBy','')=''
   or coalesce(evidence->>'formalExamConfirmedAt','')=''
   or evidence->>'formalExamProfileId' is distinct from p->>'id'
   or evidence->>'formalExamProfileVersion' is distinct from new.document_snapshot->>'profileVersion'
 ) then raise exception using errcode='22023',message='DOCUMENT_FORMAL_EXAM_REQUIRED'; end if;
 if (new.test_slug='promyshlennaya-bezopasnost' or p->>'family'='industrial') and (evidence->>'formalExamDate')::date>(new.issued_at at time zone 'Asia/Oral')::date then
   raise exception using errcode='22023',message='DOCUMENT_FORMAL_EXAM_REQUIRED';
 end if;
 return new;
end; $$;
revoke all on function private.require_industrial_exam_evidence() from public,anon,authenticated,service_role;
create trigger capture_document_snapshot_formal_exam before insert on public.certificates
 for each row execute function private.require_industrial_exam_evidence();
