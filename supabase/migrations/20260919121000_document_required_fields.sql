alter table public.document_batches add column participant_fields jsonb not null default '{}'::jsonb
 check(jsonb_typeof(participant_fields)='object' and octet_length(participant_fields::text)<=500000);

create function public.save_document_participant_fields(p_batch_id uuid,p_user_id uuid,p_fields jsonb,p_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.document_batches; k text;
begin
 perform private.require_capability('site.settings.manage');
 perform private.require_capability('results.export');
 perform private.enforce_actor_quota('site.settings.update');
 if jsonb_typeof(p_fields) is distinct from 'object' or octet_length(p_fields::text)>4000 then raise exception 'DOCUMENT_PARTICIPANT_FIELDS_INVALID'; end if;
 for k in select jsonb_object_keys(p_fields) loop
   if k not in ('trainingReason','notes','qualificationDecision') or jsonb_typeof(p_fields->k) is distinct from 'string' or char_length(p_fields->>k)>500 then raise exception 'DOCUMENT_PARTICIPANT_FIELDS_INVALID'; end if;
 end loop;
 update public.document_batches set participant_fields=jsonb_set(participant_fields,array[p_user_id::text],p_fields),version=version+1,updated_at=now()
 where id=p_batch_id and version=p_version and exists(select 1 from public.profiles p where p.id=p_user_id and lower(btrim(p.organization))=document_batches.organization_key)
 returning * into b;
 if b.id is null then raise exception using errcode='40001',message='DOCUMENT_BATCH_CONFLICT'; end if;
 return jsonb_build_object('version',b.version);
end; $$;
revoke all on function public.save_document_participant_fields(uuid,uuid,jsonb,bigint) from public,anon,authenticated,service_role;
grant execute on function public.save_document_participant_fields(uuid,uuid,jsonb,bigint) to authenticated;

alter function public.get_document_editor_data(text,text) rename to get_document_editor_data_before_profiles;
alter function public.get_document_editor_data_before_profiles(text,text) set schema private;
create function public.get_document_editor_data(p_organization text default null,p_course_slug text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; details jsonb;
begin
 result:=private.get_document_editor_data_before_profiles(p_organization,p_course_slug);
 details:=coalesce(result#>'{batch,participant_fields}','{}'::jsonb);
 return result||jsonb_build_object('participants',coalesce((select jsonb_agg(person||coalesce(details->(person->>'userId'),'{}'::jsonb)) from jsonb_array_elements(result->'participants') person),'[]'::jsonb));
end; $$;
revoke all on function private.get_document_editor_data_before_profiles(text,text) from public,anon,authenticated,service_role;
revoke all on function public.get_document_editor_data(text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_document_editor_data(text,text) to authenticated;

create function private.validate_document_issuance() returns trigger
language plpgsql security definer set search_path='' as $$
declare p jsonb:=new.document_snapshot->'profile'; details jsonb; signer jsonb;
begin
 select participant_fields->new.user_id::text into details from public.document_batches
 where organization_key=lower(btrim(new.organization)) and course_slug=new.test_slug;
 details:=coalesce(details,'{}'::jsonb);
 if p is not null and p<>'null'::jsonb then
   if p->>'family'='biot' and (coalesce(btrim(p->>'orderNumber'),'')='' or coalesce(p->>'orderDate','')='' or coalesce(btrim(p->>'verificationKind'),'')='') then
     raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:orderNumber,orderDate,verificationKind';
   end if;
   if p->>'family'='ptm' and coalesce(btrim(details->>'trainingReason'),'')='' then raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:trainingReason'; end if;
   if p->>'family'='qualification' and coalesce(btrim(details->>'qualificationDecision'),'')='' then raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:qualificationDecision'; end if;
   if coalesce(btrim(new.organization),'')='' or coalesce(btrim(new.job),'')='' then raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:organization,position'; end if;
   for signer in select value from jsonb_array_elements(p->'commission') loop
     if signer->>'assetId' is not null and not exists(select 1 from public.document_assets a where a.id=(signer->>'assetId')::uuid and a.owner_id=signer->>'signerId' and a.kind='signature') then raise exception 'DOCUMENT_SIGNER_ASSET_MISMATCH'; end if;
   end loop;
 end if;
 new.document_snapshot:=new.document_snapshot||jsonb_build_object('participantFields',details);
 return new;
end; $$;
revoke all on function private.validate_document_issuance() from public,anon,authenticated,service_role;
-- Alphabetical ordering: snapshot capture -> required-field check -> original
-- certificate identity/score guard. No trigger rewrites an existing snapshot.
create trigger capture_document_snapshot_details before insert on public.certificates
 for each row execute function private.validate_document_issuance();
