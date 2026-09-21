begin;

-- Education belongs to every participant and is written by them; a name is
-- printed on a certificate and in a protocol, so it carries Latin or Cyrillic
-- letters only — the owner's protocols spell Chinese participants «Chen Binbin».
create function pg_temp.new_learner(p_suffix text, p_metadata jsonb default '{}'::jsonb)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users(
    instance_id, id, aud, role, email,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_id::text || '-' || p_suffix || '@profile-script.invalid', '{}', p_metadata, now(), now()
  );
  return v_id;
end; $$;

do $test$
declare
  v_learner uuid := pg_temp.new_learner('script');
  v_value text;
  v_blocked boolean;
begin
  -- Education takes the same NFC normalization and whitespace collapsing as the
  -- rest of the profile. It never did: the trigger did not fire on the column.
  update public.profiles
  set education = '  Неоконченное   высшее  '
  where id = v_learner;
  if (select education from public.profiles where id = v_learner)
    <> 'Неоконченное высшее' then
    raise exception 'education was not normalized: %',
      (select education from public.profiles where id = v_learner);
  end if;

  -- The protocol prints a level, never a school: a new answer is one of four.
  foreach v_value in array array['Высшее', 'Неоконченное высшее', 'Среднее специальное', 'Среднее'] loop
    update public.profiles set education = v_value where id = v_learner;
  end loop;
  foreach v_value in array array['КазНУ им. Аль-Фараби', 'высшее техническое'] loop
    v_blocked := false;
    begin
      update public.profiles set education = v_value where id = v_learner;
    exception when check_violation then
      if sqlerrm <> 'PROFILE_EDUCATION_LEVEL' then raise; end if;
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'education that is not a level was accepted: %', v_value;
    end if;
  end loop;
  if private.education_level('высшее техническое') <> 'Высшее'
    or private.education_level('Среднее профессиональное') <> 'Среднее специальное'
    or private.education_level('неполное высшее') <> 'Неоконченное высшее'
    or private.education_level('КазНУ им. Аль-Фараби') is not null then
    raise exception 'older answers are not read as the level they name';
  end if;

  -- Every alphabet a real participant writes their name in.
  foreach v_value in array array[
    'Chen Binbin', 'Li Haijian', 'Zhao Xiangfeng', 'An Hongli', 'Xie Zunfeng',
    'Ли', 'Әлібек', 'Şeyma', 'O''Brien', 'O’Brien', 'Анна-Мария', 'Ахметов 001'
  ] loop
    update public.profiles set name = v_value, surname = v_value where id = v_learner;
    if (select name from public.profiles where id = v_learner)
      <> private.normalize_profile_text(v_value) then
      raise exception 'a valid name was not stored: %', v_value;
    end if;
  end loop;

  -- Han, kana and emoji never reach a printed document.
  foreach v_value in array array['陈斌斌', '山田太郎', 'ひらがな', '😀', 'Chen 斌'] loop
    v_blocked := false;
    begin
      update public.profiles set name = v_value where id = v_learner;
    exception when check_violation then
      if sqlerrm <> 'PROFILE_NAME_SCRIPT' then raise; end if;
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'a foreign script was accepted as a name: %', v_value;
    end if;
    v_blocked := false;
    begin
      update public.profiles set surname = v_value where id = v_learner;
    exception when check_violation then
      if sqlerrm <> 'PROFILE_NAME_SCRIPT' then raise; end if;
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'a foreign script was accepted as a surname: %', v_value;
    end if;
  end loop;

  -- A job title and a company keep every script: one real company here is
  -- «Филиал Китайской Инжиниринговой Корпорации Тяньчэнь в Республике Казахстан».
  update public.profiles
  set job = '安全工程师',
      organization = 'Филиал Китайской Инжиниринговой Корпорации Тяньчэнь'
  where id = v_learner;

  -- The very first row an account gets is judged too.
  v_blocked := false;
  begin
    perform pg_temp.new_learner('registration', jsonb_build_object('name', '斌', 'surname', '陈'));
  exception when check_violation then
    if sqlerrm <> 'PROFILE_NAME_SCRIPT' then raise; end if;
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'registration accepted a name in a foreign script'; end if;
end; $test$;

do $test$
declare
  v_legacy uuid := pg_temp.new_learner('legacy');
  v_result jsonb;
begin
  -- A row planted the way the database held it before the rule.
  alter table public.profiles disable trigger profiles_normalize;
  update public.profiles set name = '伟', surname = '张' where id = v_legacy;
  alter table public.profiles enable trigger profiles_normalize;

  update public.profiles set education = 'Высшее' where id = v_legacy;
  if (select education from public.profiles where id = v_legacy) <> 'Высшее' then
    raise exception 'a legacy row refused a write to another column';
  end if;
  if (select name from public.profiles where id = v_legacy) <> '伟' then
    raise exception 'a legacy name was rewritten';
  end if;
  -- An administrator who saves the card without touching the name is not
  -- refused either: only a value the statement changes is judged.
  update public.profiles set name = '伟', job = 'Рабочий' where id = v_legacy;

  update public.profiles set education = 'Среднее специальное' where id = v_legacy;
  v_result := public.submit_profile_for_approval_from_trusted_server_with_education(
    v_legacy, 'Wei', 'Zhang', 'Рабочий', 'SafetyHub fixture', '   ', null, null
  );
  if v_result #>> '{__safetyhubRpcError,message}' <> 'PROFILE_FIELDS_REQUIRED' then
    raise exception 'a blank education was accepted: %', v_result;
  end if;
  -- This fixture has no photo, so the inner submission refuses it; the
  -- education write must roll back with everything else the call did.
  v_result := public.submit_profile_for_approval_from_trusted_server_with_education(
    v_legacy, 'Wei', 'Zhang', 'Рабочий', 'SafetyHub fixture', 'Высшее', null, null
  );
  if v_result #>> '{__safetyhubRpcError,message}' <> 'AVATAR_REQUIRED' then
    raise exception 'the submission fixture failed for the wrong reason: %', v_result;
  end if;
  if (select education from public.profiles where id = v_legacy)
    <> 'Среднее специальное' then
    raise exception 'a refused submission changed the education';
  end if;
end; $test$;

do $test$
declare
  v_signature constant text :=
    'public.submit_profile_for_approval_from_trusted_server_with_education('
      || 'uuid,text,text,text,text,text,text,text)';
begin
  -- Only the trusted server may submit a profile.
  if has_function_privilege('authenticated', v_signature, 'execute')
    or has_function_privilege('anon', v_signature, 'execute')
    or not has_function_privilege('service_role', v_signature, 'execute') then
    raise exception 'the education submission has the wrong grants';
  end if;
  -- The browser reads its own education from the one context call every server
  -- route already makes, so the forms open filled in.
  if pg_get_function_result('public.get_auth_context()'::regprocedure)
    not like '%profile_education text%' then
    raise exception 'the access context does not carry the education';
  end if;
  if has_function_privilege('anon', 'public.get_auth_context()', 'execute')
    or not has_function_privilege('authenticated', 'public.get_auth_context()', 'execute') then
    raise exception 'the access context has the wrong grants';
  end if;
  -- The seven-argument submission stays for anything still calling it.
  if to_regprocedure(
    'public.submit_profile_for_approval_from_trusted_server(uuid,text,text,text,text,text,text)'
  ) is null then
    raise exception 'the original submission was dropped';
  end if;
end; $test$;

rollback;
