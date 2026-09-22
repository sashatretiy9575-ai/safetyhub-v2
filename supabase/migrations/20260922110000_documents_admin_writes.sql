-- The writes behind the new «Документы» section and the person card.
--
-- * A course's documents are saved in one call: the form of its protocol, one
--   category or «ИТР» and «рабочий состав», the hours and the term of each,
--   the wording and the booklet. Switching between one category and two
--   creates and removes profile rows in the same transaction, guarded by the
--   versions the administrator was looking at.
-- * The shared commission is written with the rest of «Общее»; every signature
--   and the stamp must be an image registered to that very person or stamp.
-- * A person's category and a person's note are written from their card. The
--   note is merged: it used to replace everything else stored for the person.
-- * The old editor's writes are withdrawn.
-- * The documents archive carries the snapshot of every document it draws.

create function private.valid_document_course(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text; c jsonb; t jsonb;
begin
 if jsonb_typeof(p) is distinct from 'object' then return false; end if;
 if exists(select 1 from jsonb_object_keys(p) key where key not in (
   'family','split','programName','protocolText','decisionText','orderNumber','orderDate',
   'verificationKind','booklet','categories')) then return false; end if;
 if coalesce(p->>'family','') not in ('general','biot','ptm','industrial','qualification','first-aid')
   or jsonb_typeof(p->'split') is distinct from 'boolean'
   or jsonb_typeof(p->'programName') is distinct from 'string'
   or char_length(btrim(p->>'programName')) not between 1 and 240 then return false; end if;
 foreach k in array array['protocolText','decisionText','orderNumber','verificationKind'] loop
   if jsonb_typeof(p->k) is distinct from 'string'
     or char_length(p->>k) > (case k when 'orderNumber' then 100 when 'verificationKind' then 120 else 1000 end)
     or (k in ('orderNumber','verificationKind') and p->>k ~ '[[:cntrl:]]') then return false; end if;
 end loop;
 if jsonb_typeof(p->'orderDate') is distinct from 'string'
   or (p->>'orderDate' <> '' and p->>'orderDate' !~ '^\d{4}-\d{2}-\d{2}$') then return false; end if;
 if p->>'orderDate' <> '' then
   begin perform (p->>'orderDate')::date; exception when others then return false; end;
 end if;
 if jsonb_typeof(p->'booklet') not in ('null','object') then return false; end if;
 if jsonb_typeof(p->'booklet') = 'object' then
   t := p->'booklet'->'texts';
   if exists(select 1 from jsonb_object_keys(p->'booklet') key where key not in ('layout','texts'))
     or coalesce(p->'booklet'->>'layout','standard') <> 'standard'
     or jsonb_typeof(t) is distinct from 'object'
     or exists(select 1 from jsonb_object_keys(t) key where key not in ('examTextKk','examTextRu','knowledgeTextKk','knowledgeTextRu')) then
     return false;
   end if;
   foreach k in array array['examTextKk','examTextRu','knowledgeTextKk','knowledgeTextRu'] loop
     if jsonb_typeof(t->k) is distinct from 'string' or char_length(t->>k) > 1000 then return false; end if;
   end loop;
 end if;
 if jsonb_typeof(p->'categories') is distinct from 'object' then return false; end if;
 for k, c in select key, value from jsonb_each(p->'categories') loop
   if k not in ('all','itr','worker') or jsonb_typeof(c) is distinct from 'object'
     or exists(select 1 from jsonb_object_keys(c) key where key not in ('hours','validityMonths'))
     or coalesce(jsonb_typeof(c->'hours'),'null') not in ('null','number')
     or coalesce(jsonb_typeof(c->'validityMonths'),'null') not in ('null','number') then return false; end if;
   if jsonb_typeof(c->'hours') = 'number' and ((c->>'hours')::numeric <> trunc((c->>'hours')::numeric)
     or (c->>'hours')::numeric not between 1 and 5000) then return false; end if;
   if jsonb_typeof(c->'validityMonths') = 'number' and ((c->>'validityMonths')::numeric <> trunc((c->>'validityMonths')::numeric)
     or (c->>'validityMonths')::numeric not between 0 and 120) then return false; end if;
 end loop;
 return true;
end; $$;
revoke all on function private.valid_document_course(jsonb) from public,anon,authenticated;

-- The stored body of one category. An empty box stays empty and takes the
-- form's wording at print time; «0 месяцев» is «без срока».
create function private.document_course_body(p_slug text, p_audience text, p jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object(
   'courseSlug', p_slug, 'audience', p_audience,
   'label', left(btrim(p->>'programName') || case p_audience
     when 'itr' then ' — ИТР' when 'worker' then ' — рабочий состав' else '' end, 200),
   'programName', btrim(p->>'programName'),
   'family', p->>'family',
   'hours', case when jsonb_typeof(c->'hours') = 'number' then c->'hours' else 'null'::jsonb end,
   'validityMonths', case when jsonb_typeof(c->'validityMonths') = 'number' then c->'validityMonths' else to_jsonb(0) end,
   'protocolText', btrim(p->>'protocolText'),
   'decisionText', btrim(p->>'decisionText'),
   'orderNumber', case when p->>'family' = 'biot' then btrim(p->>'orderNumber') else '' end,
   'orderDate', case when p->>'family' = 'biot' then p->>'orderDate' else '' end,
   'verificationKind', btrim(p->>'verificationKind'))
 || case when jsonb_typeof(c->'validityMonths') = 'number' and (c->>'validityMonths')::int = 0
      then jsonb_build_object('noExpiry', true) else '{}'::jsonb end
 || case when jsonb_typeof(p->'booklet') = 'object'
      then jsonb_build_object('booklet', jsonb_build_object('layout', 'standard', 'texts', p->'booklet'->'texts'))
      else '{}'::jsonb end
 from (select coalesce(p->'categories'->p_audience, '{}'::jsonb) as c) category;
$$;
revoke all on function private.document_course_body(text,text,jsonb) from public,anon,authenticated,service_role;

create function private.document_course_payload(p_test_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object(
   'courseId', course.id, 'slug', course.slug, 'title', course.title,
   'profiles', coalesce((
     select jsonb_agg(jsonb_build_object('id', profile.id, 'audience', profile.audience,
       'version', profile.version, 'body', profile.body) order by profile.audience)
     from public.document_profiles profile where profile.course_slug = course.slug), '[]'::jsonb))
 from public.tests course where course.id = p_test_id;
$$;
revoke all on function private.document_course_payload(uuid) from public,anon,authenticated,service_role;

create function public.save_document_course(p_test_id uuid, p_course jsonb, p_expected jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_course public.tests; v_current jsonb; v_audience text; v_body jsonb; v_id text;
 v_audiences text[];
begin
 perform private.require_capability('site.settings.manage');
 begin
 perform private.enforce_actor_quota('site.settings.update');
 select * into v_course from public.tests where id = p_test_id for update;
 if not found then raise exception using errcode = 'P0002', message = 'COURSE_NOT_FOUND'; end if;
 if not private.valid_document_course(p_course) then
   raise exception using errcode = '22023', message = 'DOCUMENT_COURSE_INVALID';
 end if;
 -- The versions the administrator was looking at: one save made in another
 -- tab in between is never overwritten.
 select coalesce(jsonb_object_agg(id, version), '{}'::jsonb) into v_current
 from public.document_profiles where course_slug = v_course.slug;
 if jsonb_typeof(p_expected) is distinct from 'object' or v_current <> p_expected then
   raise exception using errcode = '40001', message = 'DOCUMENT_PROFILE_CONFLICT';
 end if;
 v_audiences := case when (p_course->>'split')::boolean then array['itr','worker'] else array['all'] end;
 delete from public.document_profiles
 where course_slug = v_course.slug and audience <> all(v_audiences);
 foreach v_audience in array v_audiences loop
   v_body := private.document_course_body(v_course.slug, v_audience, p_course);
   select id into v_id from public.document_profiles
   where course_slug = v_course.slug and audience = v_audience;
   if v_id is null then
     v_id := private.document_profile_id(v_course.slug, v_audience);
     insert into public.document_profiles(id, course_slug, audience, body)
     values (v_id, v_course.slug, v_audience, v_body || jsonb_build_object('id', v_id));
   else
     update public.document_profiles
     set body = v_body || jsonb_build_object('id', v_id), version = version + 1, updated_at = now()
     where id = v_id and body is distinct from v_body || jsonb_build_object('id', v_id);
   end if;
 end loop;
 return private.ensure_rpc_payload(private.document_course_payload(p_test_id));
 exception when others then
   return private.rpc_error_envelope(sqlstate, sqlerrm);
 end;
end; $$;
revoke all on function public.save_document_course(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_document_course(uuid,jsonb,jsonb) to authenticated;

-- «Общее»: the shared commission joins the settings patch. Every image must be
-- registered to its own person, the stamp to a stamp.
create or replace function public.update_certificate_settings(p_patch jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; current_version bigint; image_key text; signer jsonb; v_commission jsonb;
begin
 perform private.require_capability('site.settings.manage');
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'CERTIFICATE_SETTINGS_INVALID'; end if;
 -- null снимает картинку, строка заменяет её; строка обязана быть PNG в data URL.
 foreach image_key in array array['stampPng','chairmanSignaturePng','memberSignaturePng','protocolSignaturePng'] loop
   if p_patch ? image_key then
     if jsonb_typeof(p_patch->image_key) not in ('null','string')
       or (jsonb_typeof(p_patch->image_key) = 'string' and (
         octet_length(p_patch->>image_key) > 600000
         or p_patch->>image_key !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$')) then
       raise exception using errcode='22023',message='CERTIFICATE_IMAGE_INVALID';
     end if;
   end if;
 end loop;
 select version into current_version from public.certificate_settings where singleton for update;
 if p_expected_version is distinct from current_version then raise exception using errcode='40001',message='CERTIFICATE_SETTINGS_VERSION_CONFLICT'; end if;
 if p_patch ? 'documentDefaults' then
   if not private.valid_document_defaults(p_patch->'documentDefaults') then raise exception 'DOCUMENT_DEFAULTS_INVALID'; end if;
   update public.certificate_settings set document_defaults=p_patch->'documentDefaults' where singleton;
 end if;
 if p_patch ? 'documentCommission' then
   v_commission := p_patch->'documentCommission';
   if not private.valid_document_commission(v_commission) then
     raise exception using errcode='22023',message='DOCUMENT_COMMISSION_INVALID';
   end if;
   for signer in select value from jsonb_array_elements(v_commission->'signers') loop
     if signer->>'assetId' is not null and not exists(
       select 1 from public.document_assets a
       where a.id=(signer->>'assetId')::uuid and a.owner_id=signer->>'signerId' and a.kind='signature') then
       raise exception using errcode='22023',message='DOCUMENT_SIGNER_ASSET_MISMATCH';
     end if;
   end loop;
   if v_commission->>'stampAssetId' is not null and not exists(
     select 1 from public.document_assets a
     where a.id=(v_commission->>'stampAssetId')::uuid and a.kind='stamp') then
     raise exception using errcode='22023',message='DOCUMENT_STAMP_INVALID';
   end if;
   update public.certificate_settings set document_commission=v_commission where singleton;
 end if;
 if p_patch ? 'protocolSignaturePng' then
   update public.certificate_settings set protocol_signature_png=p_patch->>'protocolSignaturePng' where singleton;
 end if;
 result := private.update_certificate_settings_v1(p_patch-'documentDefaults'-'documentCommission'-'protocolSignaturePng',p_expected_version);
 if result ? '__safetyhubRpcError' then
   raise exception using errcode=result#>>'{__safetyhubRpcError,code}',message=result#>>'{__safetyhubRpcError,message}';
 end if;
 -- The legacy writer answers with the payload it knew about; the full one is read again.
 return private.ensure_rpc_payload(private.certificate_settings_payload(false));
exception when others then
 return private.rpc_error_envelope(sqlstate,sqlerrm);
end; $$;
revoke all on function public.update_certificate_settings(jsonb,bigint) from public,anon,authenticated,service_role;
grant execute on function public.update_certificate_settings(jsonb,bigint) to authenticated;

-- «ИТР» or «Рабочий» for one person, or null to let the position decide again.
create function public.set_document_audience(p_user_id uuid, p_audience text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_capability('certificate.issue');
 begin
 perform private.enforce_actor_quota('admin.attestation.mutate');
 if p_audience is not null and p_audience not in ('itr','worker') then
   raise exception using errcode='22023', message='DOCUMENT_AUDIENCE_INVALID';
 end if;
 update public.profiles set document_audience=p_audience where id=p_user_id;
 if not found then raise exception using errcode='P0002', message='USER_NOT_FOUND'; end if;
 return jsonb_build_object('audience', p_audience);
 exception when others then
   return private.rpc_error_envelope(sqlstate, sqlerrm);
 end;
end; $$;
revoke all on function public.set_document_audience(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.set_document_audience(uuid,text) to authenticated;

-- «Примечание» of one person in one course, kept with everything else stored
-- for them: only the note changes, a blank one is removed.
create function public.save_document_note(p_user_id uuid, p_course_slug text, p_notes text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_org text; v_notes text := btrim(coalesce(p_notes, '')); v_key text := p_user_id::text;
begin
 v_actor := private.require_capability('certificate.issue');
 begin
 perform private.enforce_actor_quota('admin.attestation.mutate');
 if char_length(v_notes) > 500 or v_notes ~ '[\x01-\x09\x0b-\x1f\x7f]' then
   raise exception using errcode='22023', message='DOCUMENT_NOTE_INVALID';
 end if;
 if not exists(select 1 from public.tests where slug=p_course_slug) then
   raise exception using errcode='P0002', message='COURSE_NOT_FOUND';
 end if;
 select btrim(organization) into v_org from public.profiles where id=p_user_id;
 if not found then raise exception using errcode='P0002', message='USER_NOT_FOUND'; end if;
 if coalesce(v_org,'')='' then raise exception using errcode='22023', message='DOCUMENT_COMPANY_NOT_FOUND'; end if;
 insert into public.document_batches(organization, course_slug, updated_by)
 values (v_org, p_course_slug, v_actor)
 on conflict (organization_key, course_slug) do nothing;
 update public.document_batches
 set participant_fields = case
     when v_notes = '' then case
       when participant_fields ? v_key then participant_fields || jsonb_build_object(v_key, (participant_fields->v_key) - 'notes')
       else participant_fields end
     else participant_fields || jsonb_build_object(v_key,
       coalesce(participant_fields->v_key, '{}'::jsonb) || jsonb_build_object('notes', v_notes)) end,
   version = version + 1, updated_at = now(), updated_by = v_actor
 where organization_key = lower(v_org) and course_slug = p_course_slug;
 return jsonb_build_object('notes', v_notes);
 exception when others then
   return private.rpc_error_envelope(sqlstate, sqlerrm);
 end;
end; $$;
revoke all on function public.save_document_note(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.save_document_note(uuid,text,text) to authenticated;

-- The old editor's writes and reads are withdrawn; the functions go in a later
-- release, once no running deployment can call them.
revoke execute on function public.get_document_editor_data(text,text) from authenticated;
revoke execute on function public.select_document_profile(uuid,text,bigint) from authenticated;
revoke execute on function public.save_document_batch(text,text,date,text,boolean,bigint) from authenticated;
revoke execute on function public.save_document_batch(text,text,date,text,boolean,bigint,text) from authenticated;
revoke execute on function public.save_document_participant_fields(uuid,uuid,jsonb,bigint) from authenticated;

-- The documents archive draws every document from the snapshot it was issued
-- with. The export returned the certificate rows alone, so the archive fell
-- back to today's settings: no listener category, no hours, not the protocol
-- number of the sitting, the settings' old images. The snapshot now travels
-- with every row, as it does for a single download.
create function private.with_document_snapshots(p jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when jsonb_typeof(p->'items') is distinct from 'array' then p else
   p || jsonb_build_object('items', coalesce((
     select jsonb_agg(item.value || jsonb_build_object('documentSnapshot', certificate.document_snapshot)
       order by item.ordinality)
     from jsonb_array_elements(p->'items') with ordinality item(value, ordinality)
     left join public.certificates certificate on certificate.id = (item.value->>'id')::uuid
   ), '[]'::jsonb)) end;
$$;
revoke all on function private.with_document_snapshots(jsonb) from public,anon,authenticated,service_role;

alter function private.resolve_certificate_export_unmetered(uuid[])
  rename to resolve_certificate_export_unmetered_without_snapshots;
create function private.resolve_certificate_export_unmetered(p_attestation_ids uuid[]) returns jsonb
language sql security definer set search_path='' as $$
 select private.with_document_snapshots(
   private.resolve_certificate_export_unmetered_without_snapshots(p_attestation_ids));
$$;
revoke all on function private.resolve_certificate_export_unmetered(uuid[]) from public,anon,authenticated,service_role;
revoke all on function private.resolve_certificate_export_unmetered_without_snapshots(uuid[]) from public,anon,authenticated,service_role;

alter function public.resolve_certificate_export_job(uuid)
  rename to resolve_certificate_export_job_without_snapshots;
alter function public.resolve_certificate_export_job_without_snapshots(uuid) set schema private;
revoke all on function private.resolve_certificate_export_job_without_snapshots(uuid) from public,anon,authenticated,service_role;
create function public.resolve_certificate_export_job(p_job_id uuid) returns jsonb
language sql security definer set search_path='' as $$
 select private.with_document_snapshots(private.resolve_certificate_export_job_without_snapshots(p_job_id));
$$;
revoke all on function public.resolve_certificate_export_job(uuid) from public,anon,authenticated,service_role;
grant execute on function public.resolve_certificate_export_job(uuid) to authenticated;
