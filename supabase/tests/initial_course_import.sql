begin;

do $test$
declare
  v_signature text;
begin
  if to_regclass('private.initial_course_import_operations') is null then
    raise exception 'initial course import operation table missing';
  end if;

  foreach v_signature in array array[
    'public.begin_initial_course_import(uuid,text,text,text)',
    'public.stage_initial_course_import(uuid,text,jsonb)',
    'public.prepare_initial_course_import(uuid,text)',
    'public.activate_initial_course_import(uuid,text,uuid)',
    'public.complete_initial_course_import(uuid,text)'
  ]
  loop
    if to_regprocedure(v_signature) is null then
      raise exception 'initial course import routine missing: %', v_signature;
    end if;
    if has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'initial course import routine ACL invalid: %', v_signature;
    end if;
  end loop;

  if has_table_privilege('anon', 'private.initial_course_import_operations', 'SELECT')
    or has_table_privilege('authenticated', 'private.initial_course_import_operations', 'SELECT')
    or has_table_privilege('service_role', 'private.initial_course_import_operations', 'SELECT') then
    raise exception 'initial course import receipt table is directly readable';
  end if;

  if to_regprocedure('private.initial_import_expected_courses()') is null
    or has_function_privilege('anon',
      'private.initial_import_expected_courses()', 'EXECUTE')
    or has_function_privilege('authenticated',
      'private.initial_import_expected_courses()', 'EXECUTE')
    or has_function_privilege('service_role',
      'private.initial_import_expected_courses()', 'EXECUTE') then
    raise exception 'initial import control manifest boundary invalid';
  end if;
end;
$test$;

rollback;
