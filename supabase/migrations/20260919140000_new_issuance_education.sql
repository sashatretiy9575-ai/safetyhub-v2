-- A user-requested prerequisite for new printable forms, not a learning gate.
-- Validate the final snapshot after capture; INSERT only preserves all historical rows.
create function private.require_document_education() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 new.document_snapshot:=new.document_snapshot||jsonb_build_object('protocolLayoutVersion',2);
 if coalesce(new.document_snapshot#>>'{profile,family}','general') in ('general','industrial')
   and coalesce(btrim(new.document_snapshot->>'education'),'')='' then
   raise exception using errcode='22023',message='DOCUMENT_REQUIRED_FIELDS:education';
 end if;
 return new;
end; $$;
revoke all on function private.require_document_education() from public,anon,authenticated,service_role;
create trigger capture_document_snapshot_education before insert on public.certificates
 for each row execute function private.require_document_education();

-- Identity verification may issue immediately. Store education before that call,
-- in the same rollback boundary, so both checks and snapshot see the new value.
-- Keep quota consumption outside the identity/education rollback boundary.
create or replace function public.verify_user_identity_with_education(
 p_target_id uuid,p_name text,p_surname text,p_job text,p_organization text,p_education text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; result jsonb; previous text;
begin
 perform private.enforce_actor_quota('admin.identity.mutate');
 begin
 actor:=private.require_capability('identity.manage');
 perform pg_advisory_xact_lock(hashtextextended(p_target_id::text,0));
 select education into previous from public.profiles where id=p_target_id for update;
 if not found then raise exception 'USER_NOT_FOUND'; end if;
 update public.profiles set education=btrim(coalesce(p_education,'')) where id=p_target_id;
 result:=private.verify_user_identity_unmetered(p_target_id,p_name,p_surname,p_job,p_organization);
 if result ? '__safetyhubRpcError' then
   raise exception using errcode=result#>>'{__safetyhubRpcError,code}',message=result#>>'{__safetyhubRpcError,message}';
 end if;
 if previous is distinct from btrim(coalesce(p_education,'')) then
   insert into public.admin_audit_log(actor_user_id,action,target_type,target_id,before_data,after_data)
   values(actor,'identity.education.update','user',p_target_id::text,jsonb_build_object('education',previous),jsonb_build_object('education',btrim(coalesce(p_education,''))));
 end if;
 return result || jsonb_build_object('education',btrim(coalesce(p_education,'')));
exception when others then return private.rpc_error_envelope(sqlstate,sqlerrm);
 end;
end; $$;
