-- Preserve existing values. This migration only adds printable dimensions and education.
alter table public.profiles add column education text not null default ''
  check (char_length(education) <= 200 and education !~ '[[:cntrl:]]');

-- Education is edited through the existing identity-review transaction, not a public profile write.
create function public.verify_user_identity_with_education(
 p_target_id uuid,p_name text,p_surname text,p_job text,p_organization text,p_education text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; result jsonb; previous text;
begin
 actor:=private.require_capability('identity.manage');
 perform pg_advisory_xact_lock(hashtextextended(p_target_id::text,0));
 select education into previous from public.profiles where id=p_target_id for update;
 if not found then raise exception 'USER_NOT_FOUND'; end if;
 result:=public.verify_user_identity(p_target_id,p_name,p_surname,p_job,p_organization);
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
end; $$;
revoke all on function public.verify_user_identity_with_education(uuid,text,text,text,text,text) from public,anon,service_role;
grant execute on function public.verify_user_identity_with_education(uuid,text,text,text,text,text) to authenticated;

alter function private.valid_document_defaults(jsonb) rename to valid_document_defaults_v1;
create function private.valid_document_defaults(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text; n numeric;
begin
 if not private.valid_document_defaults_v1(v) then return false; end if;
 foreach k in array array['insertWidthCm','insertHeightCm'] loop
   if v ? k and v->k <> 'null'::jsonb then
     if jsonb_typeof(v->k) <> 'number' then return false; end if;
     n:=(v->>k)::numeric;
     if n < (case when k='insertWidthCm' then 8 else 4 end) or n > (case when k='insertWidthCm' then 60 else 30 end) then return false; end if;
   end if;
 end loop;
 return true;
end; $$;
revoke all on function private.valid_document_defaults(jsonb) from public,anon,authenticated;
alter table public.certificate_settings drop constraint document_defaults_valid;
alter table public.certificate_settings add constraint document_defaults_valid check(private.valid_document_defaults(document_defaults));

create or replace function public.get_document_editor_data(p_organization text default null,p_course_slug text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_capability('site.settings.manage');
 perform private.require_capability('results.read');
 perform private.require_capability('certificate.read');
 select jsonb_build_object(
 'organizations',coalesce((select jsonb_agg(org order by org) from (select min(btrim(organization)) org from public.profiles where btrim(organization)<>'' group by lower(btrim(organization))) orgs),'[]'::jsonb),
 'courses',coalesce((select jsonb_agg(jsonb_build_object('slug',slug,'title',title,'id',id) order by title) from public.tests),'[]'::jsonb),
 'batch',(select to_jsonb(b) from public.document_batches b where organization_key=lower(btrim(p_organization)) and course_slug=p_course_slug),
 'participants',coalesce((select jsonb_agg(jsonb_build_object(
   'userId',p.id,'fullName',btrim(p.surname||' '||p.name),'position',p.job,
   'education',p.education,'photoUrl',case when p.avatar_updated_at is not null then '/api/admin/documents/photo/'||p.id::text else null end,
   'status',coalesce(a.status::text,'none'),'score',a.score,'total',a.question_count,
   'certificateId',c.id) order by p.surname,p.name,p.id)
 from public.profiles p
 left join lateral (
   select ta.status,ta.score,r.question_count from public.test_attempts ta join public.test_revisions r on r.id=ta.revision_id
   where ta.user_id=p.id and r.slug=p_course_slug
   order by (ta.status='passed') desc,(ta.status in ('passed','failed')) desc,ta.score desc nulls last,ta.started_at desc,ta.id desc limit 1
 ) a on true
 left join lateral (
   select cert.id from public.certificates cert where cert.user_id=p.id and cert.test_slug=p_course_slug and cert.revoked_at is null
   order by cert.issued_at desc,cert.id desc limit 1
 ) c on true
 where lower(btrim(p.organization))=lower(btrim(p_organization))), '[]'::jsonb)
 ) into result;
 return result;
end; $$;
revoke all on function public.get_document_editor_data(text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_document_editor_data(text,text) to authenticated;
