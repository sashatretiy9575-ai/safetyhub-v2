-- Доступ к курсам выдаётся вручную. До этой миграции подтверждение заявки
-- открывало ученику все опубликованные курсы сразу. Теперь подтверждение
-- аккаунта остаётся обязательным условием, но само по себе не открывает ни
-- одного курса: администратор отмечает курсы при подтверждении (сколько угодно
-- за раз) и может изменить набор позже в карточке сотрудника.
--
-- Заодно телефон при регистрации становится необязательным: обязательны только
-- имя, фамилия, должность и компания.

-- 1. Таблица выданных доступов. Браузерные роли к ней не ходят: чтение и запись
--    только через функции с security definer и через service_role на сервере.
create table public.course_access_grants (
  user_id uuid not null references auth.users(id) on delete cascade,
  test_id uuid not null references public.tests(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default statement_timestamp(),
  primary key (user_id, test_id)
);

create index course_access_grants_test_id_idx
  on public.course_access_grants (test_id);

alter table public.course_access_grants enable row level security;
revoke all on public.course_access_grants from public, anon, authenticated;
grant select, insert, delete on public.course_access_grants to service_role;

comment on table public.course_access_grants is
  'Курсы, открытые ученику администратором. Без строки здесь подтверждённый аккаунт не может ни открыть презентацию, ни начать тест.';

-- 2. Проверка доступа. Администраторы проходят всегда: они проверяют курсы сами.
create function private.has_course_access(p_user_id uuid, p_test_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.course_access_grants grant_row
    where grant_row.user_id = p_user_id
      and grant_row.test_id = p_test_id
  ) or exists (
    select 1
    from public.user_roles user_role
    where user_role.user_id = p_user_id
      and user_role.product_role = 'admin'
  );
$$;

create function private.require_course_access_by_slug(p_user_id uuid, p_test_slug text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_test_id uuid;
begin
  select test.id into v_test_id
  from public.tests test
  where test.slug = p_test_slug
    and test.status = 'published';
  -- Неизвестный курс сообщает сам вызывающий (TEST_NOT_FOUND /
  -- PRESENTATION_NOT_FOUND); здесь важно не выдать существование курса.
  if not found then
    return;
  end if;
  if not private.has_course_access(p_user_id, v_test_id) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'COURSE_ACCESS_REQUIRED';
  end if;
end;
$$;

revoke all on function private.has_course_access(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.require_course_access_by_slug(uuid, text)
  from public, anon, authenticated, service_role;

-- 3. Гейты. Начало попытки и выдача презентации проверяют доступ сразу после
--    подтверждения аккаунта и до расходования квот.
create or replace function public.start_test_attempt_locale(
  p_test_slug text,
  p_locale public.app_locale
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_detail text;
  v_user_id uuid := private.require_approved_learner();
begin
  perform private.assert_locale_matches_auth_realm(v_user_id, p_locale);
  perform private.require_course_access_by_slug(v_user_id, p_test_slug);
  perform private.enforce_actor_quota('attempt.start');
  begin
    perform set_config('safetyhub.request_locale', p_locale::text, true);
    v_result := private.start_test_attempt_unmetered(p_test_slug);
    return private.ensure_rpc_payload(v_result);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return private.rpc_error_envelope(sqlstate, sqlerrm, v_detail);
  end;
end;
$$;

create or replace function public.get_approved_course_presentation_locale(
  p_course_slug text,
  p_asset text,
  p_locale public.app_locale
)
returns table (
  presentation_id uuid,
  content_type text,
  byte_size bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_approved_learner();
begin
  perform private.assert_locale_matches_auth_realm(v_user_id, p_locale);
  if p_course_slug is null
    or char_length(p_course_slug) not between 1 and 120
    or p_course_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or p_asset is null
    or p_asset not in ('presentation', 'thumbnail') then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;
  perform private.require_course_access_by_slug(v_user_id, p_course_slug);
  return query
  select
    presentation.id,
    case when p_asset = 'presentation' then 'application/pdf' else 'image/webp' end,
    case when p_asset = 'presentation' then presentation.byte_size else null end
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  join public.test_revision_presentations mapping
    on mapping.revision_id = revision.id and mapping.locale = p_locale
  join public.course_presentations presentation
    on presentation.id = mapping.presentation_id
  where test.slug = p_course_slug
    and test.status = 'published'
    and presentation.status = 'ready'
    and presentation.storage_bucket = 'course-presentations'
    and (p_asset = 'presentation' or presentation.thumbnail_path is not null)
  limit 1;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;
end;
$$;

-- 4. Решение по заявке с набором курсов. Прежняя четырёхаргументная форма
--    остаётся тонкой обёрткой (её зовут SQL-тесты и старые клиенты); сервер
--    приложения всегда передаёт p_course_ids, так что PostgREST выбирает
--    именно пятиаргументную функцию по именам параметров.
create function public.decide_account_approval(
  p_idempotency_key uuid,
  p_target_user_id uuid,
  p_decision text,
  p_reason text,
  p_course_ids uuid[]
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
  v_course_ids uuid[] := (
    select coalesce(array_agg(distinct course_id order by course_id), '{}'::uuid[])
    from unnest(coalesce(p_course_ids, '{}'::uuid[])) as course_id
  );
  v_known_course_count integer;
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
    or (v_decision = 'approved' and v_reason <> '')
    or (v_decision = 'rejected' and cardinality(v_course_ids) > 0)
    or cardinality(v_course_ids) > 200 then
    raise exception using errcode = '22023', message = 'ACCOUNT_APPROVAL_DECISION_INVALID';
  end if;
  if p_target_user_id = v_actor_id then
    raise exception using errcode = '42501', message = 'ACCOUNT_APPROVAL_SELF_DECISION_FORBIDDEN';
  end if;
  if cardinality(v_course_ids) > 0 then
    select count(*) into v_known_course_count
    from public.tests test
    where test.id = any(v_course_ids);
    if v_known_course_count <> cardinality(v_course_ids) then
      raise exception using errcode = '22023', message = 'COURSE_ACCESS_COURSE_UNKNOWN';
    end if;
  end if;

  v_request_hash := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'targetUserId', p_target_user_id,
      'decision', v_decision,
      'reason', nullif(v_reason, ''),
      'courseIds', case when cardinality(v_course_ids) > 0 then to_jsonb(v_course_ids) else null end
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

    if v_decision = 'approved' and cardinality(v_course_ids) > 0 then
      insert into public.course_access_grants (user_id, test_id, granted_by)
      select p_target_user_id, course_id, v_actor_id
      from unnest(v_course_ids) as course_id
      on conflict (user_id, test_id) do nothing;
    end if;

    v_result := jsonb_build_object(
      'userId', p_target_user_id,
      'approvalState', v_control.approval_state,
      'decidedAt', v_control.approval_decided_at,
      'grantedCourseIds', to_jsonb(v_course_ids),
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
        'decidedAt', v_control.approval_decided_at,
        'courseIds', to_jsonb(v_course_ids)
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

create or replace function public.decide_account_approval(
  p_idempotency_key uuid,
  p_target_user_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.decide_account_approval(
    p_idempotency_key, p_target_user_id, p_decision, p_reason, null::uuid[]
  );
$$;

revoke all on function public.decide_account_approval(uuid, uuid, text, text, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.decide_account_approval(uuid, uuid, text, text, uuid[])
  to authenticated;
revoke all on function public.decide_account_approval(uuid, uuid, text, text)
  from public, anon, service_role;
grant execute on function public.decide_account_approval(uuid, uuid, text, text)
  to authenticated;

-- 5. Изменение набора курсов у уже подтверждённого (или любого) ученика.
--    Заменяет набор целиком: то, чего нет в списке, отзывается.
create function public.set_course_access(
  p_target_user_id uuid,
  p_course_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_course_ids uuid[] := (
    select coalesce(array_agg(distinct course_id order by course_id), '{}'::uuid[])
    from unnest(coalesce(p_course_ids, '{}'::uuid[])) as course_id
  );
  v_known_course_count integer;
  v_before uuid[];
  v_after uuid[];
begin
  if p_target_user_id is null or cardinality(v_course_ids) > 200 then
    raise exception using errcode = '22023', message = 'COURSE_ACCESS_REQUEST_INVALID';
  end if;
  if cardinality(v_course_ids) > 0 then
    select count(*) into v_known_course_count
    from public.tests test
    where test.id = any(v_course_ids);
    if v_known_course_count <> cardinality(v_course_ids) then
      raise exception using errcode = '22023', message = 'COURSE_ACCESS_COURSE_UNKNOWN';
    end if;
  end if;
  if not exists (
    select 1
    from public.account_controls control
    where control.user_id = p_target_user_id
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    raise exception using errcode = '55000', message = 'ACCOUNT_UNAVAILABLE';
  end if;

  perform private.enforce_actor_quota('admin.identity.mutate');
  perform pg_advisory_xact_lock(hashtextextended(
    'safetyhub:course-access:' || p_target_user_id::text, 0
  ));

  select coalesce(array_agg(grant_row.test_id order by grant_row.test_id), '{}'::uuid[])
    into v_before
  from public.course_access_grants grant_row
  where grant_row.user_id = p_target_user_id;

  delete from public.course_access_grants grant_row
  where grant_row.user_id = p_target_user_id
    and grant_row.test_id <> all(v_course_ids);

  insert into public.course_access_grants (user_id, test_id, granted_by)
  select p_target_user_id, course_id, v_actor_id
  from unnest(v_course_ids) as course_id
  on conflict (user_id, test_id) do nothing;

  select coalesce(array_agg(grant_row.test_id order by grant_row.test_id), '{}'::uuid[])
    into v_after
  from public.course_access_grants grant_row
  where grant_row.user_id = p_target_user_id;

  if v_before is distinct from v_after then
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id, before_data, after_data
    ) values (
      v_actor_id,
      p_target_user_id,
      'course.access.changed',
      'course_access',
      p_target_user_id::text,
      jsonb_build_object('courseIds', to_jsonb(v_before)),
      jsonb_build_object('courseIds', to_jsonb(v_after))
    );
  end if;

  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', p_target_user_id,
    'courseIds', to_jsonb(v_after)
  ));
end;
$$;

revoke all on function public.set_course_access(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.set_course_access(uuid, uuid[]) to authenticated;

-- Изменение доступа — событие уровня продукта, оно попадает в «Историю действий».
create or replace function private.audit_event_allowed(p_action text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_action in (
    'account.approval.approved',
    'course.access.changed',
    'test.passed',
    'certificate.issued',
    'user.self_delete_requested',
    'user.purged',
    'user.self_purged',
    'role.changed',
    'role.changed_directly',
    'admin.provisioned_by_email',
    'superadmin.bootstrapped',
    'admin.break_glass_restored'
  );
$$;

-- 6. Перенос: кого уже подтвердили по старым правилам, тот сохраняет доступ ко
--    всем опубликованным на этот момент курсам. Новые курсы им откроет админ.
insert into public.course_access_grants (user_id, test_id, granted_by)
select control.user_id, test.id, control.approval_decided_by
from public.account_controls control
cross join public.tests test
where control.approval_state = 'approved'
  and test.status = 'published'
  and not exists (
    select 1
    from public.user_roles user_role
    where user_role.user_id = control.user_id
      and user_role.product_role = 'admin'
  )
on conflict (user_id, test_id) do nothing;

-- 7. Телефон необязателен. Пустая пара страна/номер сохраняется как null;
--    заполненная проверяется по-прежнему.
create or replace function public.submit_profile_for_approval_from_trusted_server(
  p_user_id uuid,
  p_name text,
  p_surname text,
  p_job text,
  p_organization text,
  p_phone_country_iso2 text,
  p_phone_e164 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := private.normalize_profile_text(p_name);
  v_surname text := private.normalize_profile_text(p_surname);
  v_job text := private.normalize_profile_text(p_job);
  v_organization text := private.normalize_profile_text(p_organization);
  v_phone_country_iso2 text := nullif(upper(btrim(coalesce(p_phone_country_iso2, ''))), '');
  v_phone_e164 text := nullif(btrim(coalesce(p_phone_e164, '')), '');
  v_profile public.profiles%rowtype;
  v_previous_profile public.profiles%rowtype;
  v_control public.account_controls%rowtype;
  v_is_admin boolean := false;
  v_same_profile boolean;
  v_requested_at timestamptz;
  v_due_at timestamptz;
  v_next_state public.account_approval_state;
  v_action text;
begin
  begin
    if p_user_id is null then
      raise exception using errcode = 'check_violation', message = 'PROFILE_USER_REQUIRED';
    end if;
    if char_length(v_name) not between 1 and 80
      or char_length(v_surname) not between 1 and 80
      or char_length(v_job) not between 1 and 160
      or char_length(v_organization) not between 1 and 160
      or v_name ~ '[[:cntrl:]]' or v_surname ~ '[[:cntrl:]]'
      or v_job ~ '[[:cntrl:]]' or v_organization ~ '[[:cntrl:]]' then
      raise exception using errcode = 'check_violation', message = 'PROFILE_FIELDS_REQUIRED';
    end if;
    -- Обе половины номера либо пусты, либо заполнены и корректны.
    if (v_phone_country_iso2 is null) <> (v_phone_e164 is null)
      or (v_phone_country_iso2 is not null and (
        v_phone_country_iso2 !~ '^[A-Z]{2}$'
        or v_phone_e164 !~ '^\+[1-9][0-9]{1,14}$'
      )) then
      raise exception using errcode = 'check_violation', message = 'PROFILE_PHONE_INVALID';
    end if;

    -- `private.require_approved_learner()` acquires account_controls before
    -- it reaches a learner profile/attempt lock.  Acquire the exclusive
    -- control lock first here as well, then lock the profile, so submitting a
    -- profile and starting a course cannot form an inverse row-lock cycle.
    select control.* into v_control
    from public.account_controls control
    where control.user_id = p_user_id
    for update;
    if not found
      or v_control.status <> 'active'
      or v_control.deletion_pending
      or not exists (
        select 1
        from auth.users auth_user
        where auth_user.id = p_user_id
          and auth_user.deleted_at is null
          and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
      ) then
      raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
    end if;

    select profile.* into v_profile
    from public.profiles profile
    where profile.id = p_user_id
    for update;
    if not found then
      raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
    end if;

    if not exists (
      select 1
      from private.profile_avatar_manifests manifest
      where manifest.user_id = p_user_id
        and v_profile.avatar_updated_at is not null
        and (
          (
            not manifest.legacy_imported
            and manifest.object_key =
              p_user_id::text || '/objects/' || manifest.operation_token::text || '.webp'
          )
          or (
            manifest.legacy_imported
            and manifest.object_key = p_user_id::text || '/avatar.webp'
          )
        )
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state', message = 'AVATAR_REQUIRED';
    end if;
    if not private.has_current_legal_acceptance(p_user_id) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'LEGAL_ACCEPTANCE_REQUIRED';
    end if;

    v_previous_profile := v_profile;

    update public.profiles
    set name = v_name,
        surname = v_surname,
        job = v_job,
        organization = v_organization,
        phone_country_iso2 = v_phone_country_iso2,
        phone_e164 = v_phone_e164,
        onboarding_completed_at = coalesce(onboarding_completed_at, statement_timestamp())
    where id = p_user_id
    returning * into v_profile;

    -- `profiles_attach_organization` may map aliases or casing to one
    -- canonical organization. Compare the locked old row with the post-trigger
    -- row so a semantically identical resubmit neither resets the 24-hour SLA
    -- nor creates noisy audit records.
    v_same_profile :=
      v_previous_profile.name is not distinct from v_profile.name
      and v_previous_profile.surname is not distinct from v_profile.surname
      and v_previous_profile.job is not distinct from v_profile.job
      and v_previous_profile.organization is not distinct from v_profile.organization
      and v_previous_profile.phone_country_iso2 is not distinct from v_profile.phone_country_iso2
      and v_previous_profile.phone_e164 is not distinct from v_profile.phone_e164;

    select coalesce(user_role.product_role = 'admin', false)
      into v_is_admin
    from public.user_roles user_role
    where user_role.user_id = p_user_id;

    -- Admins manage review; they are not placed into their own learner queue.
    if v_is_admin then
      update public.account_controls
      set approval_state = 'approved',
          approval_requested_at = null,
          approval_due_at = null,
          approval_decided_at = null,
          approval_decided_by = null,
          approval_rejection_reason = null
      where user_id = p_user_id;
      return private.ensure_rpc_payload(jsonb_build_object(
        'completed', true,
        'approvalState', 'approved',
        'approvalRequestedAt', null,
        'approvalDueAt', null
      ));
    end if;

    if v_control.approval_state = 'approved' and v_same_profile then
      return private.ensure_rpc_payload(jsonb_build_object(
        'completed', true,
        'approvalState', v_control.approval_state,
        'approvalRequestedAt', v_control.approval_requested_at,
        'approvalDueAt', v_control.approval_due_at
      ));
    end if;
    if v_control.approval_state = 'pending' and v_same_profile then
      return private.ensure_rpc_payload(jsonb_build_object(
        'completed', true,
        'approvalState', v_control.approval_state,
        'approvalRequestedAt', v_control.approval_requested_at,
        'approvalDueAt', v_control.approval_due_at
      ));
    end if;

    v_requested_at := statement_timestamp();
    v_due_at := v_requested_at + interval '24 hours';
    v_next_state := 'pending';
    v_action := case
      when v_control.approval_state = 'rejected' then 'account.approval_resubmitted'
      when v_control.approval_state = 'pending' then 'account.approval_profile_changed'
      when v_control.approval_state = 'approved' then 'account.approval_profile_changed'
      else 'account.approval_requested'
    end;

    update public.account_controls
    set approval_state = v_next_state,
        approval_requested_at = v_requested_at,
        approval_due_at = v_due_at,
        approval_decided_at = null,
        approval_decided_by = null,
        approval_rejection_reason = null
    where user_id = p_user_id;

    -- This audit intentionally contains state/timestamps only. Contact phone
    -- details stay on the narrow self profile and admin-queue read models.
    insert into public.admin_audit_log (
      actor_user_id,
      target_user_id,
      action,
      target_type,
      target_id,
      before_data,
      after_data
    ) values (
      p_user_id,
      p_user_id,
      v_action,
      'account_approval',
      p_user_id::text,
      jsonb_build_object('approvalState', v_control.approval_state),
      jsonb_build_object(
        'approvalState', v_next_state,
        'requestedAt', v_requested_at,
        'dueAt', v_due_at
      )
    );

    return private.ensure_rpc_payload(jsonb_build_object(
      'completed', true,
      'approvalState', v_next_state,
      'approvalRequestedAt', v_requested_at,
      'approvalDueAt', v_due_at
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

comment on function public.decide_account_approval(uuid, uuid, text, text, uuid[]) is
  'Решение по заявке; при подтверждении открывает ученику перечисленные курсы.';
comment on function public.set_course_access(uuid, uuid[]) is
  'Заменяет набор курсов, открытых ученику; пустой список отзывает всё.';
comment on function private.require_course_access_by_slug(uuid, text) is
  'COURSE_ACCESS_REQUIRED, если опубликованный курс не открыт ученику; администраторы проходят всегда.';
comment on function public.submit_profile_for_approval_from_trusted_server(
  uuid,text,text,text,text,text,text
) is
  'Отправка профиля на проверку; телефон необязателен, обязательны имя, фамилия, должность и компания.';
