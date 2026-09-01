begin;

do $test$
declare
  v_queue_definition text;
  v_decision_definition text;
  v_submission_definition text;
  v_control_lock_offset integer;
  v_profile_lock_offset integer;
begin
  if to_regclass('private.account_approval_decision_receipts') is null
    or to_regprocedure('public.list_pending_account_approval_page(integer,timestamp with time zone,uuid)') is null
    or to_regprocedure('public.decide_account_approval(uuid,uuid,text,text)') is null
    or to_regprocedure('public.submit_profile_for_approval_from_trusted_server(uuid,text,text,text,text,text,text)') is null
    or to_regprocedure('public.prune_account_approval_decision_receipts(integer)') is null then
    raise exception 'account approval queue contract missing';
  end if;

  if has_function_privilege(
      'anon',
      'public.list_pending_account_approval_page(integer,timestamp with time zone,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.decide_account_approval(uuid,uuid,text,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated',
      'public.list_pending_account_approval_page(integer,timestamp with time zone,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated',
      'public.decide_account_approval(uuid,uuid,text,text)',
      'EXECUTE'
    ) then
    raise exception 'approval queue grant boundary invalid';
  end if;

  v_queue_definition := lower(pg_get_functiondef(
    'public.list_pending_account_approval_page(integer,timestamp with time zone,uuid)'::regprocedure
  )) || lower(pg_get_functiondef(
    'private.list_pending_account_approval_page_provider_internal(integer,timestamp with time zone,uuid)'::regprocedure
  ));
  if position('private.require_capability(''identity.manage'')' in v_queue_definition) = 0
    or position('control.approval_state = ''pending''' in v_queue_definition) = 0
    or position('phone_e164' in v_queue_definition) = 0
    or position('select count(*) > v_limit from candidates' in v_queue_definition) = 0
    or position('last_visible.user_id' in v_queue_definition) = 0
    or position('next_item' in v_queue_definition) > 0
    or position('test_revision_variant_answer_keys' in v_queue_definition) > 0
    or position('questions' in v_queue_definition) > 0 then
    raise exception 'approval queue PII/authorization boundary invalid';
  end if;

  v_decision_definition := lower(pg_get_functiondef(
    'public.decide_account_approval(uuid,uuid,text,text)'::regprocedure
  ));
  if position('private.require_capability(''identity.manage'')' in v_decision_definition) = 0
    or position('private.enforce_actor_quota(''admin.identity.mutate'')' in v_decision_definition) = 0
    or position('for update' in v_decision_definition) = 0
    or position('account_approval_not_pending' in v_decision_definition) = 0
    or position('idempotency_key_reused' in v_decision_definition) = 0
    or position('receipt.expires_at <= statement_timestamp()' in v_decision_definition) = 0
    or position('delete from private.account_approval_decision_receipts receipt' in v_decision_definition) = 0
    or position('v_receipt := null' in v_decision_definition) = 0
    or position('private.rpc_error_envelope' in v_decision_definition) = 0
    or position('insert into public.admin_audit_log' in v_decision_definition) = 0
    or position('account_approval_self_decision_forbidden' in v_decision_definition) = 0 then
    raise exception 'approval decision concurrency/idempotency/audit boundary invalid';
  end if;

  v_submission_definition := lower(pg_get_functiondef(
    'public.submit_profile_for_approval_from_trusted_server(uuid,text,text,text,text,text,text)'::regprocedure
  ));
  v_control_lock_offset := position(
    'select control.* into v_control' in v_submission_definition
  );
  v_profile_lock_offset := position(
    'select profile.* into v_profile' in v_submission_definition
  );
  if v_control_lock_offset = 0
    or v_profile_lock_offset = 0
    or v_control_lock_offset >= v_profile_lock_offset
    or position('for update' in substring(v_submission_definition from v_control_lock_offset)) = 0
    or position('for update' in substring(v_submission_definition from v_profile_lock_offset)) = 0 then
    raise exception 'profile approval submission lock order invalid';
  end if;
end;
$test$;

rollback;
