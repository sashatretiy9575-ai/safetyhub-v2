-- Печать и подписи возвращаются на документы. Редактор документов (20260915120000)
-- выключил их целиком: владелец ставил печать вручную. Теперь он загружает PNG в
-- конструкторе, и они стоят на каждой корочке и каждом протоколе, пока он не
-- заменит их. У протокола своя подпись: его подписывает не тот же человек.
alter table public.certificate_settings add column protocol_signature_png text;

alter table public.certificate_settings drop constraint certificate_settings_image_sizes;
alter table public.certificate_settings add constraint certificate_settings_image_sizes check (
  coalesce(octet_length(stamp_png), 0) <= 600000
  and coalesce(octet_length(chairman_signature_png), 0) <= 600000
  and coalesce(octet_length(member_signature_png), 0) <= 600000
  and coalesce(octet_length(protocol_signature_png), 0) <= 600000
);

-- Флаги и байты снова настоящие. Байты по-прежнему получает только сервер:
-- get_certificate_settings отдаёт администратору payload(false).
create or replace function private.certificate_settings_payload(p_include_images boolean) returns jsonb
language sql stable set search_path='' as $$
 select private.certificate_settings_payload_v1(p_include_images) || jsonb_build_object(
   'documentDefaults',document_defaults,
   'hasProtocolSignature',protocol_signature_png is not null,
   'protocolSignaturePng',case when p_include_images then protocol_signature_png else null end)
 from public.certificate_settings where singleton;
$$;
revoke all on function private.certificate_settings_payload(boolean) from public,anon,authenticated,service_role;

create or replace function public.update_certificate_settings(p_patch jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; current_version bigint; image_key text;
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
 if p_patch ? 'protocolSignaturePng' then
   update public.certificate_settings set protocol_signature_png=p_patch->>'protocolSignaturePng' where singleton;
 end if;
 result := private.update_certificate_settings_v1(p_patch-'documentDefaults'-'protocolSignaturePng',p_expected_version);
 if result ? '__safetyhubRpcError' then
   raise exception using errcode=result#>>'{__safetyhubRpcError,code}',message=result#>>'{__safetyhubRpcError,message}';
 end if;
 return result;
exception when others then
 return private.rpc_error_envelope(sqlstate,sqlerrm);
end; $$;
revoke all on function public.update_certificate_settings(jsonb,bigint) from public,anon,authenticated,service_role;
grant execute on function public.update_certificate_settings(jsonb,bigint) to authenticated;

comment on column public.certificate_settings.protocol_signature_png is
  'Подпись председателя на протоколе (PNG как data URL); отдельная от подписи на корочке.';
