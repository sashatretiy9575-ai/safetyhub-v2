-- Permit the server-only ZH registration flow to persist its immutable avatar
-- without weakening the existing authenticated avatar upload state machine.
-- The ZH path is bound to one exact, live registration operation and challenge;
-- browser roles cannot use it even if they can guess every identifier.

create or replace function private.guard_profile_avatar_storage_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_control public.account_controls%rowtype;
  v_operation private.avatar_upload_operations%rowtype;
  v_zh_operation private.zh_registration_operations%rowtype;
  v_zh_challenge private.zh_webauthn_challenges%rowtype;
  v_object_operation_id uuid;
begin
  if new.bucket_id is distinct from 'profile-avatars' then
    return new;
  end if;
  if new.name is null or new.name !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/objects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]webp$' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED';
  end if;
  v_user_id := split_part(new.name, '/', 1)::uuid;
  v_object_operation_id := split_part(split_part(new.name, '/', 3), '.', 1)::uuid;

  -- Preserve the established lock order for account cleanup and ordinary
  -- avatar uploads before consulting the ZH registration state.
  select * into v_control
  from public.account_controls control
  where control.user_id = v_user_id
  for share;
  if not found or v_control.status <> 'active' or v_control.deletion_pending then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED';
  end if;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.user_id = v_user_id and operation.object_key = new.name
  for share;
  if found
    and v_operation.state = 'prepared'
    and v_operation.started_at + interval '2 minutes' > clock_timestamp()
    and v_operation.expires_at > clock_timestamp()
    and v_operation.storage_write_lease_expires_at > clock_timestamp() then
    return new;
  end if;

  -- ZH registration never exposes a browser Storage credential. Only the
  -- server service role may use its exact operation UUID as the immutable key.
  if tg_op = 'INSERT'
    and coalesce((select auth.role()), '') = 'service_role' then
    select * into v_zh_operation
    from private.zh_registration_operations operation
    where operation.operation_id = v_object_operation_id
    for share;
    if found
      and v_zh_operation.auth_user_id = v_user_id
      and v_zh_operation.state = 'auth_created'
      and v_zh_operation.avatar_object_key is null
      and v_zh_operation.avatar_sha256 is null
      and v_zh_operation.avatar_bytes is null
      and new.name = v_user_id::text || '/objects/'
        || v_zh_operation.operation_id::text || '.webp'
      and exists (
        select 1
        from auth.users auth_user
        where auth_user.id = v_user_id
          and auth_user.deleted_at is null
          and lower(auth_user.email::text) = v_zh_operation.synthetic_email
          and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
          and auth_user.raw_app_meta_data ->> 'safetyhub_registration_operation_id'
            = v_zh_operation.operation_id::text
      ) then
      select * into v_zh_challenge
      from private.zh_webauthn_challenges challenge
      where challenge.id = v_zh_operation.operation_id
      for share;
      if found
        and v_zh_challenge.purpose = 'registration'
        and v_zh_challenge.request_hash = v_zh_operation.request_hash
        and v_zh_challenge.user_handle = v_zh_operation.user_handle
        and v_zh_challenge.consumed_at is null
        and v_zh_challenge.expires_at > clock_timestamp() then
        return new;
      end if;
    end if;
  end if;

  -- Internal maintenance of an already-published exact object remains valid;
  -- browser roles have no UPDATE policy and cannot reach this branch directly.
  if tg_op = 'UPDATE' and exists (
    select 1
    from private.profile_avatar_manifests manifest
    where manifest.user_id = v_user_id and manifest.object_key = new.name
    for share
  ) then
    return new;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED';
end;
$$;

revoke all on function private.guard_profile_avatar_storage_write()
  from public, anon, authenticated, service_role;
