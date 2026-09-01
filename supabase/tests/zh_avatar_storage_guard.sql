begin;

do $test$
declare
  v_live_user_id uuid := '7e000000-0000-4000-8000-000000000001';
  v_expired_user_id uuid := '7e000000-0000-4000-8000-000000000002';
  v_live_operation_id uuid := '7e000000-0000-4000-8000-000000000010';
  v_expired_operation_id uuid := '7e000000-0000-4000-8000-000000000011';
  v_unknown_operation_id uuid := '7e000000-0000-4000-8000-000000000012';
  v_live_object_id uuid := '7e000000-0000-4000-8000-000000000020';
  v_live_replay_object_id uuid := '7e000000-0000-4000-8000-000000000021';
  v_expired_object_id uuid := '7e000000-0000-4000-8000-000000000022';
  v_unknown_object_id uuid := '7e000000-0000-4000-8000-000000000023';
  v_live_key text := v_live_user_id::text || '/objects/'
    || v_live_operation_id::text || '.webp';
  v_failed boolean;
  v_definition text;
begin
  select lower(pg_get_functiondef(
    'private.guard_profile_avatar_storage_write()'::regprocedure
  )) into v_definition;
  if position('auth.role()' in v_definition) = 0
    or position('service_role' in v_definition) = 0
    or position('zh_registration_operations' in v_definition) = 0
    or position('zh_webauthn_challenges' in v_definition) = 0
    or position('auth_created' in v_definition) = 0
    or position('consumed_at is null' in v_definition) = 0
    or position('expires_at > clock_timestamp()' in v_definition) = 0
    or position('safetyhub_registration_operation_id' in v_definition) = 0 then
    raise exception 'ZH avatar Storage guard binding is incomplete';
  end if;
  if has_function_privilege(
    'anon', 'private.guard_profile_avatar_storage_write()', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'private.guard_profile_avatar_storage_write()', 'EXECUTE'
  ) or has_function_privilege(
    'service_role', 'private.guard_profile_avatar_storage_write()', 'EXECUTE'
  ) then
    raise exception 'private avatar Storage trigger function is directly executable';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_live_user_id,
      'authenticated', 'authenticated',
      repeat('a', 32) || '@auth.invalid', '', statement_timestamp(),
      jsonb_build_object(
        'safetyhub_auth_kind', 'zh_passkey',
        'safetyhub_registration_operation_id', v_live_operation_id
      ),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_expired_user_id,
      'authenticated', 'authenticated',
      repeat('b', 32) || '@auth.invalid', '', statement_timestamp(),
      jsonb_build_object(
        'safetyhub_auth_kind', 'zh_passkey',
        'safetyhub_registration_operation_id', v_expired_operation_id
      ),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(), statement_timestamp()
    );

  insert into private.zh_webauthn_challenges (
    id, purpose, challenge_sha256, request_hash, user_handle,
    created_at, expires_at
  ) values
    (
      v_live_operation_id, 'registration', repeat('1', 64), repeat('2', 64),
      repeat('L', 43), statement_timestamp(),
      statement_timestamp() + interval '5 minutes'
    ),
    (
      v_expired_operation_id, 'registration', repeat('3', 64), repeat('4', 64),
      repeat('E', 43), statement_timestamp() - interval '6 minutes',
      statement_timestamp() - interval '1 minute'
    );
  insert into private.zh_registration_operations (
    operation_id, synthetic_email, user_handle, request_hash,
    state, auth_user_id
  ) values
    (
      v_live_operation_id, repeat('a', 32) || '@auth.invalid', repeat('L', 43),
      repeat('2', 64), 'auth_created', v_live_user_id
    ),
    (
      v_expired_operation_id, repeat('b', 32) || '@auth.invalid', repeat('E', 43),
      repeat('4', 64), 'auth_created', v_expired_user_id
    );

  -- Possessing every identifier is insufficient for a browser role.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_live_user_id::text, true);
  v_failed := false;
  begin
    insert into storage.objects (id, bucket_id, name)
    values (v_live_object_id, 'profile-avatars', v_live_key);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'authenticated role used the server-only ZH avatar write path';
  end if;

  -- The service role is still bound to an existing exact operation key.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_failed := false;
  begin
    insert into storage.objects (id, bucket_id, name)
    values (
      v_unknown_object_id,
      'profile-avatars',
      v_live_user_id::text || '/objects/' || v_unknown_operation_id::text || '.webp'
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'service role wrote an avatar without an exact ZH operation';
  end if;

  insert into storage.objects (id, bucket_id, name)
  values (v_live_object_id, 'profile-avatars', v_live_key);
  if not exists (
    select 1 from storage.objects object
    where object.id = v_live_object_id
      and object.bucket_id = 'profile-avatars'
      and object.name = v_live_key
  ) then
    raise exception 'exact live ZH avatar Storage write was rejected';
  end if;

  -- Once the operation advances, its former write capability is dead.
  perform public.mark_zh_registration_storage_written(
    v_live_operation_id, v_live_user_id, v_live_key, repeat('5', 64), 100
  );
  delete from storage.objects where id = v_live_object_id;
  v_failed := false;
  begin
    insert into storage.objects (id, bucket_id, name)
    values (v_live_replay_object_id, 'profile-avatars', v_live_key);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'storage_written ZH operation replayed its avatar write';
  end if;

  -- A correctly shaped operation with an expired challenge is also inert.
  v_failed := false;
  begin
    insert into storage.objects (id, bucket_id, name)
    values (
      v_expired_object_id,
      'profile-avatars',
      v_expired_user_id::text || '/objects/' || v_expired_operation_id::text || '.webp'
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'expired ZH registration challenge authorized an avatar write';
  end if;
end;
$test$;

rollback;
