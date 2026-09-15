-- Shared document defaults and company/program protocol identity.
alter table public.certificate_settings add column document_defaults jsonb not null default '{"reviewerName":"Битемиров А.У.","commission":[{"name":"Ахметжанов Е.М.","position":"Преподаватель ТОО «Work Safety (Уорк Сэйфти)»"},{"name":"Кудияров А.М.","position":"Преподаватель ТОО «Work Safety (Уорк Сэйфти)»"}],"companyName":"Филиал Китайской Инжиниринговой Корпорации Тяньчэнь в Республике Казахстан","programName":"Работа на высоте","protocolText":"Проверка знаний проведена в соответствии с утвержденной программой на тему: «{program}»"}'::jsonb;

create function private.valid_document_defaults(v jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare m jsonb; k text;
begin
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v->'commission') is distinct from 'array' then return false; end if;
  if jsonb_array_length(v->'commission') > 20 then return false; end if;
  foreach k in array array['reviewerName','companyName','programName','protocolText'] loop
    if jsonb_typeof(v->k) is distinct from 'string' or char_length(v->>k) > (case when k='protocolText' then 1000 when k='programName' then 240 else 200 end) then return false; end if;
  end loop;
  for m in select value from jsonb_array_elements(v->'commission') loop
    if jsonb_typeof(m->'name') is distinct from 'string' or jsonb_typeof(m->'position') is distinct from 'string'
      or char_length(m->>'name') > 200 or char_length(m->>'position') > 200 then return false; end if;
  end loop;
  return true;
end; $$;
revoke all on function private.valid_document_defaults(jsonb) from public, anon, authenticated;
alter table public.certificate_settings add constraint document_defaults_valid check (private.valid_document_defaults(document_defaults));

-- Initialize the editor from the supplied protocol, as explicitly requested.
update public.certificate_settings set
  organization_name='ТОО «Work Safety (Уорк Сэйфти)»', bin='171140039242',
  chairman_name='Битемиров А.У.', chairman_position='Директор ТОО «Work Safety (Уорк Сэйфти)»',
  member_name='Ахметжанов Е.М.', member_position='Преподаватель ТОО «Work Safety (Уорк Сэйфти)»',
  second_member_name='Кудияров А.М.', second_member_position='Преподаватель ТОО «Work Safety (Уорк Сэйфти)»'
where singleton;
update public.certificate_settings set
  exam_text_ru='сдал (а) экзамен по программе «{program}» на основании протокола №{protocol}',
  knowledge_text_ru='Проверка знаний по программе «{program}». Протокол №{protocol}.',
  exam_text_kk='«{program}» бағдарламасы бойынша емтихан тапсырды. №{protocol} хаттама.',
  knowledge_text_kk='«{program}» бағдарламасы бойынша білімін тексеру. №{protocol} хаттама.',
  version=version+1,updated_at=now()
where singleton;
update public.certificate_settings set document_defaults = document_defaults || jsonb_build_object(
  'reviewerName', chairman_name,
  'commission', coalesce((select jsonb_agg(m) from (values
    (jsonb_build_object('name',member_name,'position',member_position)),
    (jsonb_build_object('name',second_member_name,'position',second_member_position))) x(m) where m->>'name' <> ''), '[]'::jsonb)
);

alter function private.certificate_settings_payload(boolean) rename to certificate_settings_payload_v1;
create function private.certificate_settings_payload(p_include_images boolean) returns jsonb
language sql stable set search_path='' as $$
 select private.certificate_settings_payload_v1(false) || jsonb_build_object(
   'documentDefaults',document_defaults,'hasStamp',false,'hasChairmanSignature',false,'hasMemberSignature',false,
   'stampPng',null,'chairmanSignaturePng',null,'memberSignaturePng',null)
 from public.certificate_settings where singleton;
$$;
revoke all on function private.certificate_settings_payload(boolean) from public,anon,authenticated,service_role;

alter function public.update_certificate_settings(jsonb,bigint) rename to update_certificate_settings_v1;
alter function public.update_certificate_settings_v1(jsonb,bigint) set schema private;
revoke all on function private.update_certificate_settings_v1(jsonb,bigint) from public,anon,authenticated,service_role;
create function public.update_certificate_settings(p_patch jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; current_version bigint;
begin
 perform private.require_capability('site.settings.manage');
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'CERTIFICATE_SETTINGS_INVALID'; end if;
 if p_patch ?| array['stampPng','chairmanSignaturePng','memberSignaturePng'] then raise exception 'DOCUMENT_IMAGES_DISABLED'; end if;
 select version into current_version from public.certificate_settings where singleton for update;
 if p_expected_version is distinct from current_version then raise exception using errcode='40001',message='CERTIFICATE_SETTINGS_VERSION_CONFLICT'; end if;
 if p_patch ? 'documentDefaults' then
   if not private.valid_document_defaults(p_patch->'documentDefaults') then raise exception 'DOCUMENT_DEFAULTS_INVALID'; end if;
   update public.certificate_settings set document_defaults=p_patch->'documentDefaults' where singleton;
 end if;
 result := private.update_certificate_settings_v1(p_patch-'documentDefaults',p_expected_version);
 if result ? '__safetyhubRpcError' then
   raise exception using errcode=result#>>'{__safetyhubRpcError,code}',message=result#>>'{__safetyhubRpcError,message}';
 end if;
 -- The legacy writer returns the established success/error envelope.
 return result;
exception when others then
 return private.rpc_error_envelope(sqlstate,sqlerrm);
end; $$;
revoke all on function public.update_certificate_settings(jsonb,bigint) from public,anon,authenticated,service_role;
grant execute on function public.update_certificate_settings(jsonb,bigint) to authenticated;

create table public.document_batches (
 id uuid primary key default gen_random_uuid(),
 organization text not null check (char_length(organization) between 1 and 200),
 organization_key text generated always as (lower(btrim(organization))) stored,
 course_slug text not null references public.tests(slug) on update cascade on delete cascade,
 document_date date not null,
 protocol_number text not null check (char_length(protocol_number) between 1 and 64),
 automatic boolean not null default true,
 version bigint not null default 1,
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 unique (organization_key,course_slug)
);
alter table public.document_batches enable row level security;
revoke all on public.document_batches from public,anon,authenticated;
grant select on public.document_batches to service_role;

create function public.save_document_batch(p_organization text,p_course_slug text,p_date date,p_number text,p_automatic boolean,p_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; saved public.document_batches;
begin
 actor:=private.require_capability('site.settings.manage');
 perform private.require_capability('results.export');
 perform private.enforce_actor_quota('site.settings.update');
 if not exists(select 1 from public.profiles where lower(btrim(organization))=lower(btrim(p_organization))) then raise exception 'DOCUMENT_COMPANY_NOT_FOUND'; end if;
 if p_version=0 then
   insert into public.document_batches(organization,course_slug,document_date,protocol_number,automatic,updated_by)
   values(btrim(p_organization),p_course_slug,p_date,case when p_automatic then to_char(p_date,'DD.MM') else btrim(p_number) end,p_automatic,actor)
   on conflict(organization_key,course_slug) do nothing returning * into saved;
 else
   update public.document_batches set document_date=p_date,protocol_number=case when p_automatic then to_char(p_date,'DD.MM') else btrim(p_number) end,
   automatic=p_automatic,version=version+1,updated_at=now(),updated_by=actor
   where organization_key=lower(btrim(p_organization)) and course_slug=p_course_slug and version=p_version returning * into saved;
 end if;
 if saved.id is null then raise exception using errcode='40001',message='DOCUMENT_BATCH_CONFLICT'; end if;
 return to_jsonb(saved);
end; $$;
revoke all on function public.save_document_batch(text,text,date,text,boolean,bigint) from public,anon,authenticated,service_role;
grant execute on function public.save_document_batch(text,text,date,text,boolean,bigint) to authenticated;

-- Aggregate inside PostgreSQL: PostgREST's row limit never truncates a company.
create function public.get_document_editor_data(p_organization text default null,p_course_slug text default null)
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
