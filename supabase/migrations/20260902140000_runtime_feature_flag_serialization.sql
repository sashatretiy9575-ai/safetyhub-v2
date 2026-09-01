-- Serialize the entire runtime-feature dependency graph.
--
-- The previous per-idempotency advisory lock protected retries of one request,
-- but independent service-role requests could concurrently read stale values of
-- different feature rows and commit an invalid dependency combination. This
-- constant transaction lock is deliberately acquired before the per-request
-- lock so all enable/disable transitions observe one committed graph.
create or replace function public.set_runtime_feature_flag(
  p_feature_name text,
  p_enabled boolean,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing private.runtime_feature_flag_receipts%rowtype;
  v_before private.runtime_feature_flags%rowtype;
  v_after private.runtime_feature_flags%rowtype;
  v_result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_feature_name is null
    or p_feature_name not in (
      'notification_events',
      'telegram_delivery',
      'telegram_application_details',
      'zh_username_password'
    )
    or p_enabled is null
    or p_idempotency_key is null
    or p_reason is null
    or char_length(p_reason) not between 8 and 500
    or p_reason ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation',
      message = 'RUNTIME_FEATURE_REQUEST_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('safetyhub.runtime_feature_flags.v1', 0));
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_existing
  from private.runtime_feature_flag_receipts receipt
  where receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.feature_name <> p_feature_name
      or v_existing.requested_enabled <> p_enabled
      or v_existing.reason <> p_reason then
      raise exception using errcode = 'unique_violation',
        message = 'RUNTIME_FEATURE_IDEMPOTENCY_CONFLICT';
    end if;
    return v_existing.result;
  end if;

  select * into v_before
  from private.runtime_feature_flags flag
  where flag.feature_name = p_feature_name
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'RUNTIME_FEATURE_NOT_FOUND';
  end if;

  if p_feature_name = 'telegram_delivery'
    and p_enabled
    and not private.runtime_feature_enabled('notification_events') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_EVENTS_MUST_BE_ENABLED_FIRST';
  end if;
  if p_feature_name = 'telegram_application_details'
    and p_enabled
    and (
      not private.runtime_feature_enabled('notification_events')
      or not private.runtime_feature_enabled('telegram_delivery')
    ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_DELIVERY_MUST_BE_ENABLED_FIRST';
  end if;
  if p_feature_name = 'notification_events'
    and not p_enabled
    and (
      private.runtime_feature_enabled('telegram_delivery')
      or private.runtime_feature_enabled('telegram_application_details')
    ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_DEPENDENCIES_MUST_BE_DISABLED_FIRST';
  end if;
  if p_feature_name = 'telegram_delivery'
    and not p_enabled
    and private.runtime_feature_enabled('telegram_application_details') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_APPLICATION_DETAILS_MUST_BE_DISABLED_FIRST';
  end if;

  if v_before.enabled is distinct from p_enabled then
    update private.runtime_feature_flags
    set enabled = p_enabled,
        updated_at = statement_timestamp(),
        updated_by = (select auth.uid())
    where feature_name = p_feature_name
    returning * into v_after;

    insert into public.admin_audit_log (
      actor_user_id,
      action,
      target_type,
      target_id,
      before_data,
      after_data,
      reason,
      correlation_id
    ) values (
      (select auth.uid()),
      'runtime_feature.updated',
      'runtime_feature',
      p_feature_name,
      jsonb_build_object('enabled', v_before.enabled),
      jsonb_build_object('enabled', v_after.enabled),
      p_reason,
      p_idempotency_key
    );
  else
    v_after := v_before;
  end if;

  v_result := jsonb_build_object(
    'featureName', p_feature_name,
    'enabled', v_after.enabled,
    'changed', v_before.enabled is distinct from v_after.enabled,
    'updatedAt', v_after.updated_at
  );
  insert into private.runtime_feature_flag_receipts (
    idempotency_key,
    feature_name,
    requested_enabled,
    reason,
    result
  ) values (
    p_idempotency_key,
    p_feature_name,
    p_enabled,
    p_reason,
    v_result
  );

  if p_feature_name = 'telegram_delivery' and p_enabled then
    perform private.request_notification_dispatch('scheduled', null);
  end if;
  return v_result;
end;
$$;

comment on function public.set_runtime_feature_flag(text,boolean,text,uuid) is
  'Service-only, reasoned runtime feature transition; a shared transaction advisory lock serializes the complete dependency graph before per-idempotency handling.';
