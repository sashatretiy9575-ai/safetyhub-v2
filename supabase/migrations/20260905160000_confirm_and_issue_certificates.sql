-- Одно действие «подтвердить данные и выдать сертификат».
--
-- Раньше оператор выполнял два шага с двумя модальными окнами: подтверждение
-- личности (identity.manage, по userIds) и выдача (certificate.issue, по
-- attestationIds). Новый вариант действия в существующем идемпотентном
-- конверте execute_admin_attestation_action делает оба шага в одной
-- транзакции, построчно и с прежними чеками; в журнал попадает только
-- certificate.issued (белый список 20260905140000 отбрасывает остальное).

alter table private.admin_operation_receipts
  drop constraint admin_operation_receipts_action;
alter table private.admin_operation_receipts
  add constraint admin_operation_receipts_action
  check (
    action in (
      'confirm', 'update', 'issue', 'revoke',
      'organization.merge', 'purge', 'role', 'confirm_and_issue'
    )
  );

create function private.confirm_and_issue_certificates_unmetered(
  p_attestation_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('certificate.issue');
  v_batch_id uuid := gen_random_uuid();
  v_attestation_id uuid;
  v_user_id uuid;
  v_certificate_id uuid;
  v_items jsonb := '[]'::jsonb;
begin
  perform private.require_capability('identity.manage');
  if coalesce(cardinality(p_attestation_ids), 0) not between 1 and 500 then
    raise exception using errcode = 'check_violation', message = 'BULK_SELECTION_INVALID';
  end if;
  for v_attestation_id in
    select requested.id from (select distinct unnest(p_attestation_ids) as id) requested
    left join public.attestations attestation on attestation.id = requested.id
    order by attestation.user_id nulls last, attestation.revision_id, requested.id
  loop
    begin
      select attestation.user_id into v_user_id
      from public.attestations attestation
      where attestation.id = v_attestation_id;
      if v_user_id is null then
        raise exception using errcode = 'no_data_found',
          message = 'ATTESTATION_NOT_FOUND';
      end if;
      perform private.confirm_profile_identity(
        v_user_id, v_actor_id, v_batch_id, 'identity.bulk_confirm'
      );
      if exists (
        select 1 from public.certificates certificate
        join public.attestations attestation on attestation.id = v_attestation_id
        where certificate.user_id = attestation.user_id
          and certificate.revision_id = attestation.revision_id
          and certificate.revoked_at is null
      ) then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'id', v_attestation_id, 'status', 'already_completed', 'reason', null
        ));
        continue;
      end if;
      v_certificate_id := private.issue_certificate_for_attestation(
        v_attestation_id, v_actor_id, 'manual', null, v_batch_id
      );
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'completed', 'reason', null,
        'certificateId', v_certificate_id
      ));
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'skipped', 'reason', left(sqlerrm, 160)
      ));
    end;
  end loop;
  return v_items;
end;
$$;

revoke all on function private.confirm_and_issue_certificates_unmetered(uuid[])
  from public, anon, authenticated, service_role;

create or replace function public.execute_admin_attestation_action(
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
    when 'confirm_and_issue' then 'certificate.issue'
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
     or p_action not in ('confirm', 'update', 'issue', 'revoke', 'confirm_and_issue')
     or cardinality(p_target_ids) not between 1 and 500
     or (select count(*) from unnest(p_target_ids) target)
       <> (select count(distinct target) from unnest(p_target_ids) target) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_BULK_OPERATION';
  end if;
  if p_action = 'confirm_and_issue' then
    perform private.require_capability('identity.manage');
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
  elsif p_action = 'confirm_and_issue' then
    v_items := private.sanitize_bulk_mutation_result(
      private.confirm_and_issue_certificates_unmetered(p_target_ids)
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
