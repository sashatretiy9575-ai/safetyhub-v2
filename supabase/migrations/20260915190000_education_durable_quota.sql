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
 result:=private.verify_user_identity_unmetered(p_target_id,p_name,p_surname,p_job,p_organization);
 if result ? '__safetyhubRpcError' then
   raise exception using errcode=result#>>'{__safetyhubRpcError,code}',message=result#>>'{__safetyhubRpcError,message}';
 end if;
 update public.profiles set education=btrim(coalesce(p_education,'')) where id=p_target_id;
 if previous is distinct from btrim(coalesce(p_education,'')) then
   insert into public.admin_audit_log(actor_user_id,action,target_type,target_id,before_data,after_data)
   values(actor,'identity.education.update','user',p_target_id::text,jsonb_build_object('education',previous),jsonb_build_object('education',btrim(coalesce(p_education,''))));
 end if;
 return result || jsonb_build_object('education',btrim(coalesce(p_education,'')));
exception when others then return private.rpc_error_envelope(sqlstate,sqlerrm);
 end;
end; $$;
