-- «Примечание» is a column of the «БиОТ» form and it is empty on every protocol
-- the training centre has ever printed. It was also the one box the editor asked
-- an operator to fill in for each person, so the production batch holds the
-- question somebody typed into it while trying to work out what it was for. The
-- issuance now writes the column empty whatever is stored, and the stored text
-- goes with it.
create or replace function private.validate_document_issuance() returns trigger
language plpgsql security definer set search_path='' as $$
declare p jsonb:=new.document_snapshot->'profile'; details jsonb; signer jsonb; defaults jsonb;
begin
 select participant_fields->new.user_id::text into details from public.document_batches
 where organization_key=lower(btrim(new.organization)) and course_slug=new.test_slug;
 details:=coalesce(details,'{}'::jsonb);
 if p is not null and p<>'null'::jsonb then
   if coalesce(btrim(new.organization),'')='' or coalesce(btrim(new.job),'')='' then raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:organization,position'; end if;
   for signer in select value from jsonb_array_elements(p->'commission') loop
     if signer->>'assetId' is not null and not exists(select 1 from public.document_assets a where a.id=(signer->>'assetId')::uuid and a.owner_id=signer->>'signerId' and a.kind='signature') then raise exception 'DOCUMENT_SIGNER_ASSET_MISMATCH'; end if;
   end loop;
   defaults:=private.document_family_default(p->>'family',p->>'audience');
   if coalesce(btrim(details->>'trainingReason'),'')='' then details:=details||jsonb_build_object('trainingReason',defaults->>'trainingReason'); end if;
   if p->>'family'='qualification' and coalesce(btrim(details->>'qualificationDecision'),'')='' then
     details:=details||jsonb_build_object('qualificationDecision',coalesce(p->>'programName',''));
   end if;
 end if;
 new.document_snapshot:=new.document_snapshot||jsonb_build_object('participantFields',details||jsonb_build_object('notes',''));
 return new;
end; $$;

update public.document_batches
set participant_fields=(
  select coalesce(jsonb_object_agg(person.key, person.value-'notes'),'{}'::jsonb)
  from jsonb_each(participant_fields) person
), version=version+1, updated_at=now()
where participant_fields::text like '%"notes"%';
