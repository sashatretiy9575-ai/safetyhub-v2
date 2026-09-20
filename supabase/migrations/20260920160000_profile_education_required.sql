-- Education stops being an administrator-only column: every participant fills
-- it in, for every course, because the certificate and the protocol print it.
-- A name goes on those same printed forms, where the owner's own protocols
-- spell Chinese participants in Latin letters, so a name may only carry Latin
-- or Cyrillic letters from now on.
create or replace function private.normalize_profile_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Anything outside Latin, Cyrillic, their combining marks, digits and the few
  -- marks a name really carries. Han, kana and emoji land here; Kazakh ә, ғ, қ,
  -- ң, ө, ұ, ү, һ, і and a Turkish ş do not.
  c_foreign_script constant text :=
    '[^ ''’.0-9A-Za-zÀ-˿̀-ͯЀ-ԯḀ-ỿ-]';
begin
  new.name := private.normalize_profile_text(new.name);
  new.surname := private.normalize_profile_text(new.surname);
  new.job := private.normalize_profile_text(new.job);
  new.organization := private.normalize_profile_text(new.organization);
  new.education := private.normalize_profile_text(new.education);
  if new.name ~ '[[:cntrl:]]' or new.surname ~ '[[:cntrl:]]'
    or new.job ~ '[[:cntrl:]]' or new.organization ~ '[[:cntrl:]]'
    or new.education ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation', message = 'PROFILE_CONTROL_CHARACTER';
  end if;
  -- Only a value this statement actually changes is judged, so the rows that
  -- already hold a Chinese name keep being read and keep accepting a write to
  -- any other column — education above all. A job title and a company are left
  -- alone: a real company name is written in Russian.
  if (tg_op = 'INSERT' or new.name is distinct from old.name)
    and new.name ~ c_foreign_script then
    raise exception using errcode = 'check_violation', message = 'PROFILE_NAME_SCRIPT';
  end if;
  if (tg_op = 'INSERT' or new.surname is distinct from old.surname)
    and new.surname ~ c_foreign_script then
    raise exception using errcode = 'check_violation', message = 'PROFILE_NAME_SCRIPT';
  end if;
  return new;
end;
$$;

-- Education joins the columns that wake the trigger: it now takes the same NFC
-- normalization and whitespace collapsing as the rest of the profile.
drop trigger profiles_normalize on public.profiles;
create trigger profiles_normalize
before insert or update of name, surname, job, organization, education
on public.profiles for each row execute function private.normalize_profile_row();

-- The profile forms prefill education, so the single read every server route
-- already makes has to carry it. Adding a column to the result needs a drop.
drop function public.get_auth_context();
create function public.get_auth_context()
returns table (
  user_id uuid,
  email text,
  profile_id uuid,
  profile_name text,
  profile_surname text,
  profile_job text,
  profile_organization text,
  profile_education text,
  profile_phone_country_iso2 text,
  profile_phone_e164 text,
  profile_preferred_locale public.app_locale,
  profile_avatar_updated_at timestamptz,
  profile_onboarding_completed_at timestamptz,
  profile_identity_state text,
  profile_created_at timestamptz,
  profile_updated_at timestamptz,
  role public.product_role,
  status public.account_status,
  deletion_pending boolean,
  approval_state public.account_approval_state,
  approval_requested_at timestamptz,
  approval_due_at timestamptz,
  approval_decided_at timestamptz,
  approval_rejection_reason text,
  capabilities text[],
  has_current_legal_acceptance boolean
)
language sql
stable
security definer
set search_path = ''
rows 1
as $$
  select
    auth_user.id,
    case when private.is_zh_synthetic_user(auth_user.id)
      then null else auth_user.email::text end,
    profile.id,
    profile.name,
    profile.surname,
    profile.job,
    profile.organization,
    profile.education,
    profile.phone_country_iso2,
    profile.phone_e164,
    profile.preferred_locale,
    profile.avatar_updated_at,
    profile.onboarding_completed_at,
    private.identity_state(profile.id),
    profile.created_at,
    profile.updated_at,
    user_role.product_role,
    control.status,
    control.deletion_pending,
    control.approval_state,
    control.approval_requested_at,
    control.approval_due_at,
    control.approval_decided_at,
    control.approval_rejection_reason,
    public.get_my_capabilities(),
    private.has_current_legal_acceptance(profile.id)
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  join public.user_roles user_role on user_role.user_id = auth_user.id
  join public.account_controls control on control.user_id = auth_user.id
  where auth_user.id = (select auth.uid())
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
    and private.zh_session_epoch_is_current(auth_user.id);
$$;
revoke execute on function public.get_auth_context() from public, anon, service_role;
grant execute on function public.get_auth_context() to authenticated;

-- The submission now carries education. The seven-argument function keeps its
-- body and its grants for anything still calling it; this one adds the column
-- write inside the same transaction, after the existing lock order.
create function public.submit_profile_for_approval_from_trusted_server_with_education(
  p_user_id uuid,
  p_name text,
  p_surname text,
  p_job text,
  p_organization text,
  p_education text,
  p_phone_country_iso2 text,
  p_phone_e164 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_education text := private.normalize_profile_text(p_education);
  v_result jsonb;
begin
  begin
    if char_length(v_education) not between 1 and 200 then
      raise exception using errcode = 'check_violation', message = 'PROFILE_FIELDS_REQUIRED';
    end if;
    v_result := public.submit_profile_for_approval_from_trusted_server(
      p_user_id, p_name, p_surname, p_job, p_organization,
      p_phone_country_iso2, p_phone_e164
    );
    -- The inner function answers with an envelope instead of raising, so a
    -- refused submission has to be re-raised here; otherwise the education
    -- below would be the only part of the request that survived.
    if v_result ? '__safetyhubRpcError' then
      raise exception using
        errcode = v_result #>> '{__safetyhubRpcError,code}',
        message = v_result #>> '{__safetyhubRpcError,message}';
    end if;
    update public.profiles set education = v_education where id = p_user_id;
    if not found then
      raise exception using errcode = 'check_violation', message = 'PROFILE_USER_REQUIRED';
    end if;
    return v_result;
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;
revoke execute on function public.submit_profile_for_approval_from_trusted_server_with_education(
  uuid,text,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.submit_profile_for_approval_from_trusted_server_with_education(
  uuid,text,text,text,text,text,text,text
) to service_role;
comment on function public.submit_profile_for_approval_from_trusted_server_with_education(
  uuid,text,text,text,text,text,text,text
) is
  'Отправка профиля на проверку вместе с образованием; образование обязательно для всех.';
