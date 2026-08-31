create table private.admin_operation_receipts (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  action text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '24 hours',
  primary key (actor_user_id, idempotency_key),
  constraint admin_operation_receipts_action
    check (action in ('confirm', 'update', 'issue', 'revoke'))
);

create index admin_operation_receipts_expiry_idx
  on private.admin_operation_receipts (expires_at);

create function public.execute_admin_attestation_action(
  p_idempotency_key uuid,
  p_action text,
  p_target_ids uuid[],
  p_field text default null,
  p_value text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capability text := case p_action
    when 'issue' then 'certificate.issue'
    when 'revoke' then 'certificate.revoke'
    else 'identity.manage'
  end;
  v_actor_id uuid := private.require_capability(v_capability);
  v_targets jsonb;
  v_request_hash text;
  v_receipt private.admin_operation_receipts%rowtype;
  v_items jsonb;
  v_completed integer;
  v_skipped integer;
begin
  if p_idempotency_key is null
     or p_action not in ('confirm', 'update', 'issue', 'revoke')
     or cardinality(p_target_ids) not between 1 and 500
     or (select count(*) from unnest(p_target_ids) target)
       <> (select count(distinct target) from unnest(p_target_ids) target) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_BULK_OPERATION';
  end if;

  select jsonb_agg(target order by target::text) into v_targets
  from unnest(p_target_ids) target;
  v_request_hash := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'action', p_action,
      'targets', v_targets,
      'field', p_field,
      'value', p_value,
      'reason', p_reason
    )::text,
    'utf8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_idempotency_key::text,
    0
  ));

  select * into v_receipt
  from private.admin_operation_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  perform private.enforce_actor_quota(
    case when p_action = 'revoke'
      then 'admin.certificate.revoke'
      else 'admin.attestation.mutate'
    end
  );

  if p_action = 'confirm' then
    v_items := private.sanitize_bulk_mutation_result(
      private.confirm_admin_identities_unmetered(p_target_ids)
    );
  elsif p_action = 'update' then
    if p_field not in ('name', 'surname', 'job', 'organization')
       or nullif(btrim(p_value), '') is null then
      raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_PROFILE_UPDATE';
    end if;
    v_items := private.sanitize_bulk_mutation_result(
      private.bulk_update_participants_unmetered(p_target_ids, p_field, p_value)
    );
  elsif p_action = 'issue' then
    v_items := private.sanitize_bulk_mutation_result(
      private.issue_certificates_unmetered(p_target_ids)
    );
  else
    if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
      raise exception using errcode = 'invalid_parameter_value', message = 'REVOKE_REASON_REQUIRED';
    end if;
    v_items := private.sanitize_bulk_mutation_result(
      private.revoke_certificates_unmetered(p_target_ids, p_reason)
    );
  end if;

  select
    count(*) filter (where item ->> 'status' = 'completed'),
    count(*) filter (where item ->> 'status' in ('skipped', 'failed', 'rejected'))
  into v_completed, v_skipped
  from jsonb_array_elements(v_items) item;

  v_receipt.result := jsonb_build_object(
    'operationId', p_idempotency_key,
    'action', p_action,
    'replayed', false,
    'items', v_items
  );

  insert into private.admin_operation_receipts (
    actor_user_id, idempotency_key, action, request_hash, result
  ) values (
    v_actor_id, p_idempotency_key, p_action, v_request_hash, v_receipt.result
  );

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, reason, batch_id
  ) values (
    v_actor_id,
    'attestation.bulk.' || p_action,
    'bulk_operation',
    p_idempotency_key::text,
    jsonb_build_object(
      'requested', cardinality(p_target_ids),
      'completed', coalesce(v_completed, 0),
      'skipped', coalesce(v_skipped, 0),
      'field', p_field
    ),
    case when p_action = 'revoke' then p_reason else null end,
    p_idempotency_key
  );

  return private.ensure_rpc_payload(v_receipt.result);
end;
$$;

revoke execute on function public.execute_admin_attestation_action(
  uuid,text,uuid[],text,text,text
) from public, anon, service_role;
grant execute on function public.execute_admin_attestation_action(
  uuid,text,uuid[],text,text,text
) to authenticated;

create function public.prune_admin_operation_receipts(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_deleted integer;
begin
  with expired as (
    select actor_user_id, idempotency_key
    from private.admin_operation_receipts
    where expires_at < statement_timestamp()
    order by expires_at
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
    for update skip locked
  )
  delete from private.admin_operation_receipts receipt
  using expired
  where receipt.actor_user_id = expired.actor_user_id
    and receipt.idempotency_key = expired.idempotency_key;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.prune_admin_operation_receipts(integer)
  from public, anon, authenticated;
grant execute on function public.prune_admin_operation_receipts(integer) to service_role;
