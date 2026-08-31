-- Correct the manual-approval queue cursor and make its idempotency receipt
-- retention self-contained.  This is a forward-only replacement of the
-- browser-facing functions from 20260831112000; it never changes historical
-- decisions or receipts other than an expired receipt for the exact request
-- currently being retried.

create or replace function public.list_pending_account_approval_page(
  p_limit integer default 25,
  p_cursor_due_at timestamptz default null,
  p_cursor_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_items jsonb;
  v_total integer;
  v_has_more boolean;
  v_cursor_due_at timestamptz;
  v_cursor_user_id uuid;
begin
  perform private.require_capability('identity.manage');

  if (p_cursor_due_at is null) <> (p_cursor_user_id is null) then
    raise exception using errcode = '22023', message = 'APPROVAL_CURSOR_INVALID';
  end if;

  select count(*)
  into v_total
  from public.account_controls control
  where control.approval_state = 'pending'
    and control.status = 'active'
    and not control.deletion_pending;

  with candidates as materialized (
    select
      control.user_id,
      auth_user.email::text as email,
      profile.name,
      profile.surname,
      profile.job,
      profile.organization,
      profile.phone_country_iso2,
      profile.phone_e164,
      (profile.avatar_updated_at is not null) as avatar_available,
      control.approval_requested_at,
      control.approval_due_at
    from public.account_controls control
    join auth.users auth_user on auth_user.id = control.user_id
    join public.profiles profile on profile.id = control.user_id
    where control.approval_state = 'pending'
      and control.status = 'active'
      and not control.deletion_pending
      and auth_user.deleted_at is null
      and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
      and (
        p_cursor_due_at is null
        or (control.approval_due_at, control.user_id) > (p_cursor_due_at, p_cursor_user_id)
      )
    order by control.approval_due_at asc, control.user_id asc
    limit v_limit + 1
  ),
  visible as materialized (
    select *
    from candidates
    order by approval_due_at asc, user_id asc
    limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', visible.user_id,
      'email', visible.email,
      'name', visible.name,
      'surname', visible.surname,
      'job', visible.job,
      'organization', visible.organization,
      'phoneCountryIso2', visible.phone_country_iso2,
      'phoneE164', visible.phone_e164,
      'avatarAvailable', visible.avatar_available,
      'requestedAt', visible.approval_requested_at,
      'dueAt', visible.approval_due_at
    ) order by visible.approval_due_at asc, visible.user_id asc), '[]'::jsonb),
    (select count(*) > v_limit from candidates),
    (
      select last_visible.approval_due_at
      from visible last_visible
      order by last_visible.approval_due_at desc, last_visible.user_id desc
      limit 1
    ),
    (
      select last_visible.user_id
      from visible last_visible
      order by last_visible.approval_due_at desc, last_visible.user_id desc
      limit 1
    )
  into v_items, v_has_more, v_cursor_due_at, v_cursor_user_id
  from visible;

  -- The cursor is the final item actually returned to the caller.  Using the
  -- look-ahead item here would skip it on the next `(due_at, user_id) > ...`
  -- page query.
  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'hasMore', v_has_more,
    'nextCursor', case
      when v_has_more and v_cursor_user_id is not null then
        jsonb_build_object('at', v_cursor_due_at, 'id', v_cursor_user_id)
      else null
    end
  );
end;
$$;

revoke all on function public.list_pending_account_approval_page(integer,timestamptz,uuid)
  from public, anon, service_role;
grant execute on function public.list_pending_account_approval_page(integer,timestamptz,uuid)
  to authenticated;

create or replace function public.decide_account_approval(
  p_idempotency_key uuid,
  p_target_user_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := private.normalize_profile_text(coalesce(p_reason, ''));
  v_request_hash text;
  v_receipt private.account_approval_decision_receipts%rowtype;
  v_control public.account_controls%rowtype;
  v_result jsonb;
begin
  if p_idempotency_key is null
    or p_target_user_id is null
    or v_decision not in ('approved', 'rejected')
    or (v_decision = 'rejected' and (
      char_length(v_reason) not between 3 and 500
      or v_reason ~ '[[:cntrl:]]'
    ))
    or (v_decision = 'approved' and v_reason <> '') then
    raise exception using errcode = '22023', message = 'ACCOUNT_APPROVAL_DECISION_INVALID';
  end if;
  if p_target_user_id = v_actor_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_APPROVAL_SELF_DECISION_FORBIDDEN';
  end if;

  v_request_hash := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'targetUserId', p_target_user_id,
      'decision', v_decision,
      'reason', nullif(v_reason, '')
    )::text,
    'utf8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_idempotency_key::text,
    0
  ));

  -- Lock exactly this actor/key receipt before deciding whether its 24-hour
  -- replay window is still live.  The primary-key predicate prevents an
  -- expired retry from deleting another administrator's receipt or a receipt
  -- for a different request.
  select * into v_receipt
  from private.account_approval_decision_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = p_idempotency_key
  for update;

  if found and v_receipt.expires_at <= statement_timestamp() then
    delete from private.account_approval_decision_receipts receipt
    where receipt.actor_user_id = v_actor_id
      and receipt.idempotency_key = p_idempotency_key
      and receipt.expires_at <= statement_timestamp();
  end if;

  -- Re-read after the narrowly locked expiry cleanup.  A fresh receipt is
  -- replayed; an expired one is treated as a new mutation even if a periodic
  -- retention worker has not run yet.
  v_receipt := null;
  select * into v_receipt
  from private.account_approval_decision_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = '23000', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return private.ensure_rpc_payload(
      v_receipt.result || jsonb_build_object('replayed', true)
    );
  end if;

  -- Keep a durable per-actor budget even when the domain decision below is
  -- rejected. The inner exception block rolls back only the decision/audit.
  perform private.enforce_actor_quota('admin.identity.mutate');

  begin
    select * into v_control
    from public.account_controls control
    where control.user_id = p_target_user_id
      and control.approval_state = 'pending'
      and control.status = 'active'
      and not control.deletion_pending
    for update;

    if not found then
      raise exception using errcode = '55000', message = 'ACCOUNT_APPROVAL_NOT_PENDING';
    end if;

    update public.account_controls
    set approval_state = v_decision::public.account_approval_state,
        approval_decided_at = statement_timestamp(),
        approval_decided_by = v_actor_id,
        approval_rejection_reason = case
          when v_decision = 'rejected' then v_reason
          else null
        end
    where user_id = p_target_user_id
    returning * into v_control;

    v_result := jsonb_build_object(
      'userId', p_target_user_id,
      'approvalState', v_control.approval_state,
      'decidedAt', v_control.approval_decided_at,
      'replayed', false
    );

    insert into private.account_approval_decision_receipts (
      actor_user_id, idempotency_key, request_hash, result
    ) values (
      v_actor_id, p_idempotency_key, v_request_hash, v_result
    );

    insert into public.admin_audit_log (
      actor_user_id,
      target_user_id,
      action,
      target_type,
      target_id,
      before_data,
      after_data,
      reason,
      batch_id
    ) values (
      v_actor_id,
      p_target_user_id,
      'account.approval.' || v_decision,
      'account_approval',
      p_target_user_id::text,
      jsonb_build_object(
        'approvalState', 'pending',
        'requestedAt', v_control.approval_requested_at,
        'dueAt', v_control.approval_due_at
      ),
      jsonb_build_object(
        'approvalState', v_control.approval_state,
        'decidedAt', v_control.approval_decided_at
      ),
      nullif(v_reason, ''),
      p_idempotency_key
    );

    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke all on function public.decide_account_approval(uuid,uuid,text,text)
  from public, anon, service_role;
grant execute on function public.decide_account_approval(uuid,uuid,text,text)
  to authenticated;

comment on function public.list_pending_account_approval_page(integer,timestamptz,uuid) is
  'Capability-gated, minimal-PII manual learner-approval queue. Its cursor is the final visible item, so look-ahead rows are never skipped.';
comment on function public.decide_account_approval(uuid,uuid,text,text) is
  'Idempotent admin approval/rejection. An expired receipt is synchronously removed only for its locked actor/key before live replay lookup.';
