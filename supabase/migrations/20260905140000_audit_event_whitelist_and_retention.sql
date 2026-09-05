-- История действий: только события уровня продукта, хранение 30 дней.
--
-- Продуктовое решение: журнал показывает шесть типов событий — регистрация
-- подтверждена администратором, тест пройден, сертификат выдан, пользователь
-- удалил свою учётную запись, администратор удалил учётную запись, назначен
-- администратор. Все технические/CMS-события больше не записываются.
--
-- Вместо переписывания ~40 функций, каждая из которых вставляет строки в
-- public.admin_audit_log, действует белый список на BEFORE INSERT: ни один
-- существующий insert не использует RETURNING и не читает строку обратно,
-- поэтому тихое отбрасывание безопасно. Существующий immutable-триггер
-- защищает только UPDATE/DELETE и не пересекается с новым.
--
-- Ретенция: разовая полная очистка здесь + почасовой pg_cron-джоб, который
-- удаляет строки старше 30 дней через узкое расширение guard-триггера.

-- 1. Белый список событий.
create function private.audit_event_allowed(p_action text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_action in (
    -- (a) регистрация прошла и администратор подтвердил — одно событие
    'account.approval.approved',
    -- (b) тест пройден
    'test.passed',
    -- (c) сертификат выдан
    'certificate.issued',
    -- (d) пользователь удалил свою учётную запись
    'user.self_delete_requested',
    -- (e) администратор удалил учётную запись
    'user.purged',
    -- (f) назначение администратора (все пути назначения)
    'role.changed',
    'role.changed_directly',
    'admin.provisioned_by_email',
    'superadmin.bootstrapped',
    'admin.break_glass_restored'
  );
$$;

create function private.filter_admin_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.audit_event_allowed(new.action) then
    return new;
  end if;
  return null;
end;
$$;

revoke all on function private.audit_event_allowed(text)
  from public, anon, authenticated, service_role;
revoke all on function private.filter_admin_audit_log()
  from public, anon, authenticated, service_role;

create trigger admin_audit_log_event_whitelist
before insert on public.admin_audit_log
for each row execute function private.filter_admin_audit_log();

-- 2. «Тест пройден» раньше не записывался вовсе. Пересоздаём завершение
-- попытки (копия 20260825000000) с одной новой вставкой после порога сдачи.
create or replace function private.complete_test_attempt_unmetered(
  p_attempt_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_attempt public.test_attempts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_key private.test_revision_variant_answer_keys%rowtype;
  v_answers smallint[] := '{}'::smallint[];
  v_score integer := 0;
  v_matched_questions integer := 0;
  v_matched_options integer := 0;
  v_became_best boolean := false;
  v_attestation_id uuid;
  v_active_certificate public.certificates%rowtype;
  v_batch_id uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_ANSWERS';
  end if;
  if jsonb_array_length(p_answers) > 100 or pg_column_size(p_answers) > 65536 then
    raise exception using errcode = 'program_limit_exceeded',
      message = 'ATTEMPT_ANSWERS_TOO_LARGE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select * into v_attempt
  from public.test_attempts
  where id = p_attempt_id and user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status in ('passed', 'failed') then
    return private.attempt_payload(v_attempt.id);
  end if;
  if v_attempt.status = 'expired' or v_attempt.expires_at <= statement_timestamp() then
    update public.test_attempts
    set status = 'expired', completed_at = coalesce(completed_at, statement_timestamp())
    where id = v_attempt.id;
    return private.attempt_payload(v_attempt.id);
  end if;

  select * into v_revision
  from public.test_revisions where id = v_attempt.revision_id;
  select * into v_variant
  from public.test_revision_variants variant
  where variant.id = v_attempt.variant_id
    and variant.revision_id = v_attempt.revision_id;
  select * into v_key
  from private.test_revision_variant_answer_keys answer_key
  where answer_key.variant_id = v_attempt.variant_id
    and answer_key.revision_id = v_attempt.revision_id;
  if v_variant.id is null or v_key.variant_id is null
    or jsonb_array_length(v_key.correct_option_ids) <> v_variant.question_count then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  if jsonb_array_length(p_answers) <> v_variant.question_count
    or (select count(distinct item ->> 'questionId')
        from jsonb_array_elements(p_answers) item)
      <> v_variant.question_count then
    raise exception using errcode = 'check_violation',
      message = 'DUPLICATE_OR_MISSING_QUESTION_ANSWER';
  end if;

  with submitted as (
    select item ->> 'questionId' as question_id,
      item ->> 'optionId' as option_id
    from jsonb_array_elements(p_answers) item
  ), matched as (
    select
      question.ordinality::integer as question_position,
      submitted.question_id,
      submitted.option_id,
      option.ordinality::integer - 1 as option_position
    from jsonb_array_elements(v_variant.questions)
      with ordinality question(value, ordinality)
    left join submitted on submitted.question_id = question.value ->> 'id'
    left join lateral (
      select candidate.ordinality
      from jsonb_array_elements(question.value -> 'options')
        with ordinality candidate(value, ordinality)
      where candidate.value ->> 'id' = submitted.option_id
      limit 1
    ) option on true
  )
  select
    coalesce(array_agg(
      matched.option_position::smallint order by matched.question_position
    ) filter (where matched.option_position is not null), '{}'::smallint[]),
    count(*) filter (
      where matched.option_id
        = v_key.correct_option_ids ->> (matched.question_position - 1)
    )::integer,
    count(matched.question_id)::integer,
    count(matched.option_position)::integer
  into v_answers, v_score, v_matched_questions, v_matched_options
  from matched;

  if v_matched_questions <> v_variant.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_QUESTION';
  end if;
  if v_matched_options <> v_variant.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_OPTION';
  end if;

  update public.test_attempts
  set answers = v_answers,
      score = v_score,
      status = case
        when v_score >= v_attempt.pass_score then 'passed'::public.attempt_status
        else 'failed'::public.attempt_status
      end,
      completed_at = statement_timestamp()
  where id = v_attempt.id
  returning * into v_attempt;

  -- A failed result remains an attempt only. Attestations (and therefore any
  -- certificate workflow) begin exclusively at the passing threshold.
  if v_attempt.status <> 'passed' then
    return private.attempt_payload(v_attempt.id);
  end if;

  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    after_data, batch_id
  ) values (
    null, v_attempt.user_id, 'test.passed', 'attempt', v_attempt.id::text,
    jsonb_build_object(
      'score', v_attempt.score,
      'passScore', v_attempt.pass_score,
      'revisionId', v_attempt.revision_id
    ),
    v_batch_id
  );

  insert into public.attestations (
    user_id, revision_id, best_attempt_id, best_score, best_completed_at
  ) values (
    v_attempt.user_id, v_attempt.revision_id, v_attempt.id,
    v_attempt.score, v_attempt.completed_at
  )
  on conflict (user_id, revision_id) do update
  set best_attempt_id = excluded.best_attempt_id,
      best_score = excluded.best_score,
      best_completed_at = excluded.best_completed_at,
      updated_at = statement_timestamp()
  where excluded.best_score > public.attestations.best_score
     or (excluded.best_score = public.attestations.best_score
       and (excluded.best_completed_at, excluded.best_attempt_id)
         > (public.attestations.best_completed_at, public.attestations.best_attempt_id))
  returning id, best_attempt_id = v_attempt.id
  into v_attestation_id, v_became_best;

  if v_attestation_id is null then
    select id, best_attempt_id = v_attempt.id
    into v_attestation_id, v_became_best
    from public.attestations
    where user_id = v_attempt.user_id and revision_id = v_attempt.revision_id;
  end if;

  if v_became_best then
    select * into v_active_certificate
    from public.certificates certificate
    where certificate.user_id = v_attempt.user_id
      and certificate.revision_id = v_attempt.revision_id
      and certificate.revoked_at is null
    for update;
    if found and v_attempt.score > v_active_certificate.score then
      update public.certificates
      set revoked_at = statement_timestamp(),
          revoked_by = null,
          revoke_reason = 'Результат улучшен'
      where id = v_active_certificate.id;
      insert into public.admin_audit_log (
        actor_user_id, target_user_id, action, target_type, target_id,
        after_data, reason, batch_id
      ) values (
        null, v_attempt.user_id, 'certificate.revoked', 'certificate',
        v_active_certificate.id::text,
        jsonb_build_object(
          'certificateNumber', v_active_certificate.certificate_number
        ),
        'Результат улучшен', v_batch_id
      );
      perform private.issue_certificate_for_attestation(
        v_attestation_id, null, 'score_improvement',
        v_active_certificate.id, v_batch_id
      );
    end if;
  end if;

  return private.attempt_payload(v_attempt.id);
end;
$$;

revoke all on function private.complete_test_attempt_unmetered(uuid,jsonb)
  from public, anon, authenticated, service_role;

-- 3. «Пользователь удалил свою учётную запись» раньше не записывалось.
-- Пересоздаём начало самоудаления (копия 20260813070000) с одной вставкой на
-- переходе deletion_pending false -> true. Обе ссылки на пользователя пустые,
-- чтобы строка пережила каскад auth.users и зачистку аудита при purge.
create or replace function public.begin_user_account_purge(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_pending boolean;
  v_tombstone private.account_storage_cleanup_tombstones%rowtype;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'USER_ID_REQUIRED';
  end if;
  perform private.lock_auth_admin_outbox();
  perform private.lock_active_superadmin_invariant();
  perform private.lock_signup_legal_operations();
  select lower(btrim(auth_user.email)) into v_email
  from auth.users auth_user
  where auth_user.id = p_target_id and auth_user.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object(
      'userId', p_target_id, 'exists', false, 'pending', false
    );
  end if;
  select control.deletion_pending into v_pending
  from public.account_controls control
  where control.user_id = p_target_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  if private.has_pending_auth_admin_operation(p_target_id, v_email) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS';
  end if;
  update public.account_controls
  set deletion_pending = true
  where user_id = p_target_id;

  if not coalesce(v_pending, false) then
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id
    ) values (
      null, null, 'user.self_delete_requested', 'user', p_target_id::text
    );
  end if;

  insert into private.account_storage_cleanup_tombstones (
    user_id, storage_prefix, cleanup_not_before, next_attempt_at
  ) values (
    p_target_id, p_target_id::text || '/',
    statement_timestamp() + interval '15 minutes',
    statement_timestamp() + interval '15 minutes'
  ) on conflict (user_id) do nothing;
  select * into v_tombstone
  from private.account_storage_cleanup_tombstones tombstone
  where tombstone.user_id = p_target_id
  for update;
  update private.avatar_upload_operations
  set state = 'cancel_requested', updated_at = statement_timestamp(),
      next_attempt_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      last_error_code = 'ACCOUNT_DELETION_REQUESTED'
  where user_id = p_target_id
    and state in ('prepared', 'staged', 'reconcile_required');
  return jsonb_build_object(
    'userId', p_target_id,
    'exists', true,
    'pending', true,
    'tombstoneId', v_tombstone.id,
    'state', v_tombstone.state,
    'cleanupNotBefore', v_tombstone.cleanup_not_before
  );
end;
$$;

revoke execute on function public.begin_user_account_purge(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_user_account_purge(uuid) to service_role;

-- 4. Guard: разрешаем ретенционное удаление, только под явным GUC и только
-- для строк старше 30 дней. Прочие удаления по-прежнему запрещены.
create or replace function private.guard_admin_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purge_actor text := coalesce(
    current_setting('safetyhub.purge_actor_id', true), ''
  );
  v_purge_operation_ids text[] := string_to_array(
    coalesce(current_setting('safetyhub.purge_operation_ids', true), ''), ','
  );
begin
  if tg_op = 'DELETE'
    and coalesce(current_setting('safetyhub.audit_retention', true), '') = 'on'
    and old.created_at < statement_timestamp() - interval '30 days' then
    return old;
  end if;
  if tg_op = 'DELETE' and v_purge_actor <> ''
    and (
      old.actor_user_id::text = v_purge_actor
      or old.target_user_id::text = v_purge_actor
      or (
        old.target_type = 'auth_admin_operation'
        and old.target_id = any(v_purge_operation_ids)
      )
    ) then
    return old;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'ADMIN_AUDIT_LOG_IMMUTABLE';
end;
$$;

revoke all on function private.guard_admin_audit_log()
  from public, anon, authenticated, service_role;

-- 5. Ретенционная функция и почасовой pg_cron-джоб.
create function public.prune_admin_audit_log(p_limit integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_deleted integer;
begin
  perform set_config('safetyhub.audit_retention', 'on', true);
  with victims as (
    select audit.id
    from public.admin_audit_log audit
    where audit.created_at < statement_timestamp() - interval '30 days'
    order by audit.created_at, audit.id
    limit v_limit
    for update skip locked
  )
  delete from public.admin_audit_log audit
  using victims
  where audit.id = victims.id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke execute on function public.prune_admin_audit_log(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_admin_audit_log(integer) to service_role;

-- Стабильное имя: повторный запуск в эфемерной базе заменяет джоб.
select cron.schedule(
  'safetyhub-audit-retention',
  '37 * * * *',
  'select public.prune_admin_audit_log(1000);'
);

-- 6. Разовая полная очистка существующей истории (по решению владельца).
-- Возрастная ветка guard-а не пропустила бы свежие строки, поэтому на время
-- очистки immutable-триггер выключается внутри этой же транзакции.
alter table public.admin_audit_log disable trigger admin_audit_log_immutable;
delete from public.admin_audit_log;
alter table public.admin_audit_log enable trigger admin_audit_log_immutable;
