-- 1. Удаление аккаунта больше не отказывает из-за чека первичного импорта
--    курсов. У первого аккаунта владельца висела строка
--    `private.initial_course_import_operations.created_by`, ссылка была
--    `on delete restrict`, и удаление молча пропускалось с причиной
--    ACCOUNT_HAS_IMPORT_RECEIPT. Чек — системная запись, он переживает
--    удаление автора: ссылка теперь обнуляется.
alter table private.initial_course_import_operations
  alter column created_by drop not null;
alter table private.initial_course_import_operations
  drop constraint initial_course_import_operations_created_by_fkey;
alter table private.initial_course_import_operations
  add constraint initial_course_import_operations_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

-- Та же функция, что в 20260912100000, без проверки чека импорта.
create or replace function private.purge_user_account_immediate(
  p_actor_id uuid,
  p_target_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_status public.account_status;
  v_deletion_pending boolean;
  v_product_role public.product_role;
  v_tombstone private.account_storage_cleanup_tombstones%rowtype;
  v_operation_ids uuid[];
begin
  select lower(btrim(auth_user.email)) into v_email
  from auth.users auth_user
  where auth_user.id = p_target_id and auth_user.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'ALREADY_ABSENT'
    );
  end if;

  select control.status, control.deletion_pending
  into v_status, v_deletion_pending
  from public.account_controls control
  where control.user_id = p_target_id
  for update;
  if not found then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'USER_NOT_FOUND'
    );
  end if;

  select role.product_role into v_product_role
  from public.user_roles role
  where role.user_id = p_target_id
  for update;

  if private.has_pending_auth_admin_operation(p_target_id, v_email) then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped',
      'reason', 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS'
    );
  end if;


  update public.account_controls
  set deletion_pending = true
  where user_id = p_target_id;

  insert into private.account_storage_cleanup_tombstones (
    user_id, storage_prefix, requested_at, cleanup_not_before, next_attempt_at
  ) values (
    p_target_id, p_target_id::text || '/',
    statement_timestamp(), statement_timestamp(), statement_timestamp()
  ) on conflict (user_id) do nothing;

  update private.avatar_upload_operations
  set state = 'cancel_requested', updated_at = statement_timestamp(),
      next_attempt_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      last_error_code = 'ACCOUNT_DELETION_REQUESTED'
  where user_id = p_target_id
    and state in ('prepared', 'staged', 'reconcile_required');

  -- `account_storage_cleanup_times` requires the cleared timestamps to be at or
  -- after `cleanup_not_before`, so a tombstone left over from the staged path
  -- has its horizon pulled back to now before the state advances.
  update private.account_storage_cleanup_tombstones
  set cleanup_not_before = least(cleanup_not_before, statement_timestamp()),
      state = 'storage_cleared',
      empty_confirmed_at = statement_timestamp(),
      storage_cleared_at = statement_timestamp(),
      auth_purged_at = null,
      db_purged_at = null,
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp(),
      last_error_code = null
  where user_id = p_target_id
  returning * into v_tombstone;
  if v_tombstone.id is null then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'TOMBSTONE_MISSING'
    );
  end if;

  update private.avatar_upload_operations
  set state = case when state = 'committed' then state else 'aborted' end,
      finalized_at = coalesce(finalized_at, statement_timestamp()),
      artifacts_cleared_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      updated_at = statement_timestamp(), last_error_code = null
  where user_id = p_target_id;

  select coalesce(array_agg(operation.id order by operation.id), '{}'::uuid[])
  into v_operation_ids
  from private.auth_admin_outbox operation
  where operation.actor_user_id = p_target_id
    or operation.target_id = p_target_id
    or (
      operation.operation_type in ('suspend', 'restore')
      and operation.payload ->> 'targetId' = p_target_id::text
    )
    or (
      operation.operation_type = 'invite'
      and lower(btrim(operation.payload ->> 'email')) = v_email
    );

  perform set_config('safetyhub.purge_actor_id', p_target_id::text, true);
  perform set_config('safetyhub.storage_purge_user_id', p_target_id::text, true);
  perform set_config(
    'safetyhub.purge_operation_ids',
    array_to_string(v_operation_ids, ','),
    true
  );

  update public.test_revisions
  set published_by = null
  where published_by = p_target_id;
  -- The receipt of the initial course import outlives its author.
  update private.initial_course_import_operations
  set created_by = null
  where created_by = p_target_id;
  update public.certificates
  set issued_by = case when issued_by = p_target_id then null else issued_by end,
      revoked_by = case when revoked_by = p_target_id then null else revoked_by end
  where issued_by = p_target_id or revoked_by = p_target_id;

  delete from public.admin_audit_log audit
  where audit.actor_user_id = p_target_id
    or audit.target_user_id = p_target_id
    or (
      audit.target_type = 'auth_admin_operation'
      and audit.target_id = any(
        array(select operation_id::text from unnest(v_operation_ids) operation_id)
      )
    );
  delete from private.auth_admin_outbox operation
  where operation.id = any(v_operation_ids);
  delete from private.avatar_upload_operations operation
  where operation.user_id = p_target_id;
  delete from private.profile_avatar_manifests manifest
  where manifest.user_id = p_target_id;
  delete from private.signup_legal_operations operation
  where operation.completed_user_id = p_target_id
    or operation.normalized_email = v_email;
  delete from auth.users where id = p_target_id;

  update private.account_storage_cleanup_tombstones
  set state = 'post_purge_cleanup',
      auth_purged_at = statement_timestamp(),
      empty_confirmed_at = null,
      next_attempt_at = statement_timestamp() + interval '15 minutes',
      lease_owner = null, lease_expires_at = null,
      updated_at = statement_timestamp(), last_error_code = null
  where id = v_tombstone.id;

  -- Written after the delete on purpose: the statements above remove every
  -- audit row that references the target, so an entry inserted earlier would be
  -- erased along with them. `target_user_id` must stay null because the column
  -- is a foreign key to the row that no longer exists, and no personal data of
  -- the deleted account is recorded here — retaining it would defeat the
  -- deletion this row is describing.
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, reason, batch_id
  ) values (
    p_actor_id, null,
    case when p_actor_id is null then 'user.self_purged' else 'user.purged' end,
    'user', p_target_id::text,
    jsonb_build_object(
      'productRole', v_product_role,
      'accountStatus', v_status,
      'deletionAlreadyPending', v_deletion_pending
    ),
    btrim(p_reason), p_idempotency_key
  );

  -- The GUCs stay set for the rest of the transaction otherwise, and would keep
  -- authorizing audit deletions for this identifier while later targets run.
  perform set_config('safetyhub.purge_actor_id', '', true);
  perform set_config('safetyhub.storage_purge_user_id', '', true);
  perform set_config('safetyhub.purge_operation_ids', '', true);

  return jsonb_build_object('id', p_target_id, 'status', 'completed', 'reason', null);
end;
$$;

revoke all on function private.purge_user_account_immediate(uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role;

-- 2. Единые настройки документов: реквизиты учебной организации, состав
--    комиссии с должностями, номер протокола, тексты корочки, срок действия и
--    три PNG (печать, две подписи). Ими собираются и удостоверение, и протокол
--    заседания комиссии. Одна строка на весь продукт; браузерные роли к
--    таблице не ходят.
create table public.certificate_settings (
  singleton boolean primary key default true check (singleton),
  organization_name text not null default 'SafetyHub',
  bin text not null default '',
  chairman_name text not null default '',
  chairman_position text not null default '',
  member_name text not null default '',
  member_position text not null default '',
  second_member_name text not null default '',
  second_member_position text not null default '',
  protocol_number text not null default '',
  validity_months integer not null default 12 check (validity_months between 0 and 120),
  exam_text_kk text not null default '',
  exam_text_ru text not null default '',
  knowledge_text_kk text not null default '',
  knowledge_text_ru text not null default '',
  stamp_png text,
  chairman_signature_png text,
  member_signature_png text,
  version bigint not null default 1,
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint certificate_settings_text_lengths check (
    char_length(organization_name) <= 200
    and char_length(bin) <= 32
    and char_length(chairman_name) <= 200
    and char_length(chairman_position) <= 200
    and char_length(member_name) <= 200
    and char_length(member_position) <= 200
    and char_length(second_member_name) <= 200
    and char_length(second_member_position) <= 200
    and char_length(protocol_number) <= 64
    and char_length(exam_text_kk) <= 1000
    and char_length(exam_text_ru) <= 1000
    and char_length(knowledge_text_kk) <= 1000
    and char_length(knowledge_text_ru) <= 1000
  ),
  constraint certificate_settings_image_sizes check (
    coalesce(octet_length(stamp_png), 0) <= 600000
    and coalesce(octet_length(chairman_signature_png), 0) <= 600000
    and coalesce(octet_length(member_signature_png), 0) <= 600000
  )
);

alter table public.certificate_settings enable row level security;
revoke all on public.certificate_settings from public, anon, authenticated;
grant select on public.certificate_settings to service_role;

insert into public.certificate_settings (
  singleton, exam_text_kk, exam_text_ru, knowledge_text_kk, knowledge_text_ru
) values (
  true,
  '№{protocol} хаттама негіздемесі бойынша еңбек қауіпсіздігі және еңбекті қорғау жөніндегі нормалар мен нұсқаулықтар біліміне емтихан тапсырды',
  'в том, что он (а) сдал (а) экзамены знаний, правил, норм и инструкций по безопасности и охране труда на основании протокола №{protocol}',
  '№{protocol} хаттама негіздемесі бойынша өрт-техникалық минимумы көлемінде өрт қауіпсіздігі саласындағы білімі бойынша емтихан тапсырды',
  'в том, что он (а) сдал (а) экзамены в области пожарной безопасности в объеме пожарно-технического минимума на основании протокола №{protocol}'
) on conflict (singleton) do nothing;

create function private.certificate_settings_payload(p_include_images boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'organizationName', settings.organization_name,
    'bin', settings.bin,
    'chairmanName', settings.chairman_name,
    'chairmanPosition', settings.chairman_position,
    'memberName', settings.member_name,
    'memberPosition', settings.member_position,
    'secondMemberName', settings.second_member_name,
    'secondMemberPosition', settings.second_member_position,
    'protocolNumber', settings.protocol_number,
    'validityMonths', settings.validity_months,
    'examTextKk', settings.exam_text_kk,
    'examTextRu', settings.exam_text_ru,
    'knowledgeTextKk', settings.knowledge_text_kk,
    'knowledgeTextRu', settings.knowledge_text_ru,
    'hasStamp', settings.stamp_png is not null,
    'hasChairmanSignature', settings.chairman_signature_png is not null,
    'hasMemberSignature', settings.member_signature_png is not null,
    'stampPng', case when p_include_images then settings.stamp_png else null end,
    'chairmanSignaturePng',
      case when p_include_images then settings.chairman_signature_png else null end,
    'memberSignaturePng',
      case when p_include_images then settings.member_signature_png else null end,
    'version', settings.version,
    'updatedAt', settings.updated_at
  )
  from public.certificate_settings settings
  where settings.singleton;
$$;

-- Читают сервер (service_role: рендер сертификатов и раздача картинок) и
-- администратор с правом настроек сайта. Картинки уходят только серверу.
create function public.get_certificate_settings(p_include_images boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    perform private.require_capability('site.settings.manage');
    return private.certificate_settings_payload(false);
  end if;
  return private.certificate_settings_payload(p_include_images);
end;
$$;

-- Частичное обновление: в p_patch только те ключи, что меняются. Картинка
-- в ключе со значением null снимается, отсутствующий ключ не трогается.
create function public.update_certificate_settings(
  p_patch jsonb,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('site.settings.manage');
  v_current public.certificate_settings%rowtype;
  v_validity integer;
begin
  perform private.enforce_actor_quota('site.settings.update');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'CERTIFICATE_SETTINGS_INVALID';
  end if;

  select * into v_current
  from public.certificate_settings settings
  where settings.singleton
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'CERTIFICATE_SETTINGS_MISSING';
  end if;
  if p_expected_version is distinct from v_current.version then
    raise exception using errcode = '40001', message = 'CERTIFICATE_SETTINGS_VERSION_CONFLICT';
  end if;

  v_validity := coalesce(
    (p_patch ->> 'validityMonths')::integer, v_current.validity_months
  );

  update public.certificate_settings
  set organization_name = private.normalize_profile_text(
        coalesce(p_patch ->> 'organizationName', organization_name)),
      bin = private.normalize_profile_text(coalesce(p_patch ->> 'bin', bin)),
      chairman_name = private.normalize_profile_text(
        coalesce(p_patch ->> 'chairmanName', chairman_name)),
      chairman_position = private.normalize_profile_text(
        coalesce(p_patch ->> 'chairmanPosition', chairman_position)),
      member_name = private.normalize_profile_text(
        coalesce(p_patch ->> 'memberName', member_name)),
      member_position = private.normalize_profile_text(
        coalesce(p_patch ->> 'memberPosition', member_position)),
      second_member_name = private.normalize_profile_text(
        coalesce(p_patch ->> 'secondMemberName', second_member_name)),
      second_member_position = private.normalize_profile_text(
        coalesce(p_patch ->> 'secondMemberPosition', second_member_position)),
      protocol_number = private.normalize_profile_text(
        coalesce(p_patch ->> 'protocolNumber', protocol_number)),
      validity_months = v_validity,
      exam_text_kk = btrim(coalesce(p_patch ->> 'examTextKk', exam_text_kk)),
      exam_text_ru = btrim(coalesce(p_patch ->> 'examTextRu', exam_text_ru)),
      knowledge_text_kk = btrim(coalesce(p_patch ->> 'knowledgeTextKk', knowledge_text_kk)),
      knowledge_text_ru = btrim(coalesce(p_patch ->> 'knowledgeTextRu', knowledge_text_ru)),
      stamp_png = case
        when p_patch ? 'stampPng' then p_patch ->> 'stampPng' else stamp_png end,
      chairman_signature_png = case
        when p_patch ? 'chairmanSignaturePng' then p_patch ->> 'chairmanSignaturePng'
        else chairman_signature_png end,
      member_signature_png = case
        when p_patch ? 'memberSignaturePng' then p_patch ->> 'memberSignaturePng'
        else member_signature_png end,
      version = version + 1,
      updated_at = statement_timestamp(),
      updated_by = v_actor_id
  where singleton;

  return private.ensure_rpc_payload(private.certificate_settings_payload(false));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

revoke all on function private.certificate_settings_payload(boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.get_certificate_settings(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.get_certificate_settings(boolean)
  to authenticated, service_role;
revoke all on function public.update_certificate_settings(jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.update_certificate_settings(jsonb, bigint)
  to authenticated;

comment on table public.certificate_settings is
  'Единые реквизиты корочки: организация, БИН, комиссия, тексты, срок, печать и подписи (PNG как data URL).';
comment on function public.update_certificate_settings(jsonb, bigint) is
  'Частичное обновление настроек сертификата с проверкой версии; право site.settings.manage.';
