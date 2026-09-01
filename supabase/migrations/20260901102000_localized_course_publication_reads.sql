-- Locale-aware course drafts, atomic four-locale publication and bounded reads.

create function private.localized_public_questions(p_questions jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', question.value ->> 'id',
      'text', question.value ->> 'text',
      'displayOrder', question.ordinality,
      'options', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', option.value ->> 'id',
            'text', option.value ->> 'text',
            'displayOrder', option.ordinality
          ) order by option.ordinality
        ), '[]'::jsonb)
        from jsonb_array_elements(question.value -> 'options')
          with ordinality option(value, ordinality)
      )
    ) order by question.ordinality
  ), '[]'::jsonb)
  from jsonb_array_elements(p_questions)
    with ordinality question(value, ordinality)
$$;

create function private.localized_explanations(p_questions jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    to_jsonb(coalesce(question.value ->> 'explanation', ''))
    order by question.ordinality
  ), '[]'::jsonb)
  from jsonb_array_elements(p_questions)
    with ordinality question(value, ordinality)
$$;

create function private.localized_course_variants_valid(p_variants jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_variant jsonb;
  v_question jsonb;
  v_numbers smallint[] := '{}'::smallint[];
  v_number smallint;
begin
  if jsonb_typeof(p_variants) is distinct from 'array'
    or jsonb_array_length(p_variants) <> 3
    or pg_column_size(p_variants) > 1048576 then
    return false;
  end if;
  for v_variant in select value from jsonb_array_elements(p_variants)
  loop
    if jsonb_typeof(v_variant) is distinct from 'object'
      or coalesce(v_variant ->> 'id', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(v_variant ->> 'variantNumber', '') !~ '^[1-3]$'
      or not private.localized_questions_valid(v_variant -> 'questions')
      or jsonb_array_length(v_variant -> 'questions') <> 10 then
      return false;
    end if;
    v_number := (v_variant ->> 'variantNumber')::smallint;
    if v_number = any(v_numbers) then
      return false;
    end if;
    v_numbers := array_append(v_numbers, v_number);
    for v_question in select value
      from jsonb_array_elements(v_variant -> 'questions')
    loop
      if jsonb_array_length(v_question -> 'options') <> 4 then
        return false;
      end if;
    end loop;
  end loop;
  return v_numbers @> array[1,2,3]::smallint[];
end;
$$;

create function private.localized_course_content_hash(
  p_title text,
  p_description text,
  p_content jsonb,
  p_variants jsonb,
  p_seo jsonb,
  p_sources jsonb,
  p_presentation_sha256 text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'title', btrim(p_title),
          'description', coalesce(btrim(p_description), ''),
          'content', p_content,
          'variants', p_variants,
          'seo', p_seo,
          'sources', p_sources,
          'presentationSha256', p_presentation_sha256
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

create function private.localized_assessment_structure(p_variants jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', variant.value ->> 'id',
      'variantNumber', (variant.value ->> 'variantNumber')::smallint,
      'position', variant.ordinality,
      'questions', private.assessment_structure(variant.value -> 'questions')
    ) order by variant.ordinality
  ), '[]'::jsonb)
  from jsonb_array_elements(p_variants)
    with ordinality variant(value, ordinality)
$$;

create function private.assert_course_draft_localizations_complete(p_test_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_locale public.app_locale;
  v_localization public.course_draft_localizations%rowtype;
  v_variant jsonb;
  v_reference jsonb;
  v_signature text;
begin
  if (
    select count(*)
    from public.course_draft_localizations localization
    where localization.test_id = p_test_id
      and localization.status = 'complete'
  ) <> 4 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_LOCALIZATIONS_INCOMPLETE';
  end if;

  if (
    select count(*)
    from public.course_draft_presentations mapping
    join public.course_presentations presentation
      on presentation.id = mapping.presentation_id
    where mapping.test_id = p_test_id
      and presentation.course_id = p_test_id
      and presentation.locale = mapping.locale
      and presentation.status = 'ready'
  ) <> 4 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_PRESENTATION_LOCALIZATIONS_INCOMPLETE';
  end if;

  if exists (
    select 1
    from public.course_draft_presentations mapping
    where mapping.test_id = p_test_id
      and mapping.locale = 'ru'
      and mapping.presentation_id is distinct from (
        select draft.presentation_id
        from public.course_drafts draft
        where draft.test_id = p_test_id
      )
  ) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'COURSE_RU_PRESENTATION_MISMATCH';
  end if;

  for v_localization in
    select * from public.course_draft_localizations localization
    where localization.test_id = p_test_id
    order by localization.locale
  loop
    if not private.localized_course_variants_valid(v_localization.question_variants)
      or v_localization.reviewed_content_hash is distinct from v_localization.content_hash
      or (
        v_localization.locale <> 'ru'
        and coalesce(
          (v_localization.translation_qa ->> 'assessmentImported')::boolean,
          false
        ) is not true
      ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'COURSE_LOCALIZATIONS_INCOMPLETE';
    end if;
  end loop;

  select localization.question_variants into v_reference
  from public.course_draft_localizations localization
  where localization.test_id = p_test_id and localization.locale = 'ru';

  foreach v_locale in array enum_range(null::public.app_locale)
  loop
    for v_variant in
      select value
      from jsonb_array_elements((
        select localization.question_variants
        from public.course_draft_localizations localization
        where localization.test_id = p_test_id
          and localization.locale = v_locale
      )) item(value)
    loop
      select private.assessment_structure_hash(reference_variant.value -> 'questions')
      into v_signature
      from jsonb_array_elements(v_reference) reference_variant(value)
      where (reference_variant.value ->> 'variantNumber')::smallint
        = (v_variant ->> 'variantNumber')::smallint;
      if not exists (
        select 1
        from jsonb_array_elements(v_reference) reference_variant(value)
        where (reference_variant.value ->> 'variantNumber')::smallint
          = (v_variant ->> 'variantNumber')::smallint
          and reference_variant.value ->> 'id' = v_variant ->> 'id'
      ) or v_signature is distinct from
        private.assessment_structure_hash(v_variant -> 'questions') then
        raise exception using errcode = 'integrity_constraint_violation',
          message = 'COURSE_LOCALIZATION_STRUCTURE_MISMATCH';
      end if;
    end loop;
  end loop;
end;
$$;

create function private.attach_course_revision_localizations(
  p_actor_id uuid,
  p_test_id uuid,
  p_revision_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_localization public.course_draft_localizations%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_localized_variant jsonb;
  v_questions jsonb;
  v_explanations jsonb;
begin
  perform private.assert_course_draft_localizations_complete(p_test_id);

  insert into public.test_revision_localizations (
    revision_id, locale, title, description, content, seo, sources,
    content_hash, translation_qa, published_by
  )
  select
    p_revision_id, localization.locale, localization.title,
    localization.description, localization.content, localization.seo,
    localization.sources, localization.content_hash,
    localization.translation_qa, p_actor_id
  from public.course_draft_localizations localization
  where localization.test_id = p_test_id
  on conflict (revision_id, locale) do nothing;

  for v_localization in
    select * from public.course_draft_localizations localization
    where localization.test_id = p_test_id
    order by localization.locale
  loop
    for v_variant in
      select * from public.test_revision_variants variant
      where variant.revision_id = p_revision_id
      order by variant.variant_number
    loop
      if v_localization.locale = 'ru' then
        v_questions := v_variant.questions;
        select answer_key.explanations into v_explanations
        from private.test_revision_variant_answer_keys answer_key
        where answer_key.revision_id = p_revision_id
          and answer_key.variant_id = v_variant.id;
      else
        select value into v_localized_variant
        from jsonb_array_elements(v_localization.question_variants) item(value)
        where (value ->> 'variantNumber')::smallint = v_variant.variant_number;
        v_questions := private.localized_public_questions(
          v_localized_variant -> 'questions'
        );
        v_explanations := private.localized_explanations(
          v_localized_variant -> 'questions'
        );
      end if;
      if private.assessment_structure_hash(v_questions) is distinct from
        private.assessment_structure_hash(v_variant.questions) then
        raise exception using errcode = 'integrity_constraint_violation',
          message = 'COURSE_LOCALIZATION_STRUCTURE_MISMATCH';
      end if;
      insert into public.test_revision_variant_localizations (
        revision_id, variant_id, locale, questions, explanations,
        question_count, structure_hash, content_hash
      ) values (
        p_revision_id, v_variant.id, v_localization.locale, v_questions,
        v_explanations, v_variant.question_count,
        private.assessment_structure_hash(v_questions),
        encode(
          extensions.digest(
            convert_to(
              jsonb_build_object(
                'questions', v_questions,
                'explanations', v_explanations
              )::text,
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        )
      )
      on conflict (variant_id, locale) do nothing;
    end loop;
  end loop;

  insert into public.test_revision_presentations (
    revision_id, locale, presentation_id
  )
  select p_revision_id, mapping.locale, mapping.presentation_id
  from public.course_draft_presentations mapping
  where mapping.test_id = p_test_id
  on conflict (revision_id, locale) do nothing;
end;
$$;

create function private.assert_course_revision_localizations_complete(
  p_revision_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.test_revision_localizations localization
      where localization.revision_id = p_revision_id) <> 4
    or (select count(*) from public.test_revision_presentations mapping
        where mapping.revision_id = p_revision_id) <> 4
    or (select count(*) from public.test_revision_variant_localizations localization
        where localization.revision_id = p_revision_id) <> 12
    or (select count(*) from public.test_revision_variants variant
        where variant.revision_id = p_revision_id
          and variant.question_count = 10) <> 3 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_LOCALIZATIONS_INCOMPLETE';
  end if;

  if exists (
    select 1
    from public.test_revision_variant_localizations localization
    join public.test_revision_variants variant
      on variant.id = localization.variant_id
     and variant.revision_id = localization.revision_id
    where localization.revision_id = p_revision_id
      and (
        localization.question_count <> 10
        or localization.structure_hash is distinct from
          private.assessment_structure_hash(variant.questions)
        or exists (
          select 1
          from jsonb_array_elements(localization.questions) question(value)
          where jsonb_array_length(question.value -> 'options') <> 4
        )
      )
  ) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'COURSE_LOCALIZATION_STRUCTURE_MISMATCH';
  end if;

  if exists (
    select 1
    from public.test_revision_presentations mapping
    join public.test_revisions revision on revision.id = mapping.revision_id
    join public.course_presentations presentation
      on presentation.id = mapping.presentation_id
    where mapping.revision_id = p_revision_id
      and (
        presentation.course_id is distinct from revision.test_id
        or presentation.locale is distinct from mapping.locale
        or presentation.status <> 'ready'
      )
  ) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'COURSE_PRESENTATION_LOCALIZATION_MISMATCH';
  end if;
end;
$$;

-- Trusted offline import for translated assessment wording. Browser editors
-- deliberately receive only assessment counts and submit no stable IDs.
create function public.import_course_assessment_localization(
  p_actor_id uuid,
  p_test_id uuid,
  p_locale public.app_locale,
  p_expected_version bigint,
  p_question_variants jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_draft public.course_drafts%rowtype;
  v_localization public.course_draft_localizations%rowtype;
  v_presentation public.course_presentations%rowtype;
  v_variant record;
  v_question record;
  v_option record;
  v_hash text;
  v_qa jsonb;
  v_quota jsonb;
begin
  if auth.role() is distinct from 'service_role'
    or not private.actor_has_capability(p_actor_id, 'test.manage') then
    raise exception using errcode = 'insufficient_privilege', message = 'FORBIDDEN';
  end if;
  -- This RPC is intentionally service-role-only, so auth.uid() is absent and
  -- enforce_actor_quota(text) cannot identify the reviewed operator. Meter the
  -- explicit capability-checked actor through the same durable quota ledger.
  v_quota := private.consume_business_quota_for_actor(
    p_actor_id,
    'admin.test.mutate'
  );
  if coalesce((v_quota ->> 'allowed')::boolean, false) is not true then
    raise exception using
      errcode = 'program_limit_exceeded',
      message = 'RATE_LIMITED:' || greatest(
        1,
        coalesce((v_quota ->> 'retryAfter')::integer, 1)
      );
  end if;
  if p_locale is null or p_locale = 'ru' then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'ASSESSMENT_LOCALE_INVALID';
  end if;
  if not private.localized_course_variants_valid(p_question_variants) then
    raise exception using errcode = 'check_violation',
      message = 'ASSESSMENT_LOCALIZATION_INVALID';
  end if;

  -- Accept an exact public wording shape only. This rejects every answer-key
  -- spelling (including future/unknown fields) instead of maintaining a
  -- fragile deny-list.
  for v_variant in
    select item.value, item.ordinality
    from jsonb_array_elements(p_question_variants)
      with ordinality item(value, ordinality)
  loop
    if exists (
      select 1
      from jsonb_object_keys(v_variant.value) key_item(key_name)
      where key_item.key_name not in ('id', 'variantNumber', 'questions')
    ) then
      raise exception using errcode = 'check_violation',
        message = 'ASSESSMENT_LOCALIZATION_INVALID';
    end if;
    for v_question in
      select item.value, item.ordinality
      from jsonb_array_elements(v_variant.value -> 'questions')
        with ordinality item(value, ordinality)
    loop
      if exists (
        select 1
        from jsonb_object_keys(v_question.value) key_item(key_name)
        where key_item.key_name not in (
          'id', 'text', 'explanation', 'position', 'displayOrder', 'options'
        )
      ) or char_length(btrim(v_question.value ->> 'text')) not between 1 and 2000
        or char_length(coalesce(v_question.value ->> 'explanation', '')) > 4000
        or (
          v_question.value ? 'position'
          and v_question.value ->> 'position' <> v_question.ordinality::text
        )
        or (
          v_question.value ? 'displayOrder'
          and v_question.value ->> 'displayOrder' <> v_question.ordinality::text
        ) then
        raise exception using errcode = 'check_violation',
          message = 'ASSESSMENT_LOCALIZATION_INVALID';
      end if;
      for v_option in
        select item.value, item.ordinality
        from jsonb_array_elements(v_question.value -> 'options')
          with ordinality item(value, ordinality)
      loop
        if exists (
          select 1
          from jsonb_object_keys(v_option.value) key_item(key_name)
          where key_item.key_name not in (
            'id', 'text', 'position', 'displayOrder'
          )
        ) or char_length(btrim(v_option.value ->> 'text')) not between 1 and 2000
          or (
            v_option.value ? 'position'
            and v_option.value ->> 'position' <> v_option.ordinality::text
          )
          or (
            v_option.value ? 'displayOrder'
            and v_option.value ->> 'displayOrder' <> v_option.ordinality::text
          ) then
          raise exception using errcode = 'check_violation',
            message = 'ASSESSMENT_LOCALIZATION_INVALID';
        end if;
      end loop;
    end loop;
  end loop;

  select * into v_draft
  from public.course_drafts draft
  where draft.test_id = p_test_id
  for share;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'COURSE_DRAFT_NOT_FOUND';
  end if;
  if private.localized_assessment_structure(p_question_variants)
    is distinct from private.localized_assessment_structure(
      private.localized_variants_from_source(v_draft.question_variants)
    ) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'ASSESSMENT_LOCALIZATION_STRUCTURE_MISMATCH';
  end if;

  select * into v_localization
  from public.course_draft_localizations localization
  where localization.test_id = p_test_id
    and localization.locale = p_locale
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'COURSE_LOCALIZATION_NOT_FOUND';
  end if;
  if p_expected_version is null
    or p_expected_version is distinct from v_localization.draft_version then
    raise exception using errcode = 'serialization_failure',
      message = 'COURSE_LOCALIZATION_CONFLICT';
  end if;

  select presentation.* into v_presentation
  from public.course_draft_presentations mapping
  join public.course_presentations presentation
    on presentation.id = mapping.presentation_id
  where mapping.test_id = p_test_id
    and mapping.locale = p_locale
    and presentation.course_id = p_test_id
    and presentation.locale = p_locale
    and presentation.status = 'ready'
  for share of presentation;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_NOT_READY';
  end if;

  v_hash := private.localized_course_content_hash(
    v_localization.title,
    v_localization.description,
    v_localization.content,
    p_question_variants,
    v_localization.seo,
    v_localization.sources,
    v_presentation.sha256
  );
  v_qa := v_localization.translation_qa || jsonb_build_object(
    'assessmentImported', true,
    'assessmentImportedAt', statement_timestamp()
  );
  if pg_column_size(v_qa) > 65536 then
    raise exception using errcode = 'check_violation',
      message = 'ASSESSMENT_LOCALIZATION_INVALID';
  end if;

  update public.course_draft_localizations
  set question_variants = p_question_variants,
      content_hash = v_hash,
      reviewed_content_hash = null,
      translation_qa = v_qa,
      status = 'draft',
      draft_version = draft_version + 1,
      updated_by = p_actor_id
  where test_id = p_test_id
    and locale = p_locale
    and draft_version = p_expected_version
  returning * into v_localization;
  if not found then
    raise exception using errcode = 'serialization_failure',
      message = 'COURSE_LOCALIZATION_CONFLICT';
  end if;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    p_actor_id,
    'course.localization_assessment_imported',
    'course_localization',
    p_test_id::text || ':' || p_locale::text,
    jsonb_build_object(
      'courseId', p_test_id,
      'locale', p_locale,
      'variantCount', jsonb_array_length(p_question_variants),
      'questionCount', 30,
      'contentHash', v_hash,
      'draftVersion', v_localization.draft_version
    )
  );

  return private.ensure_rpc_payload(jsonb_build_object(
    'courseId', p_test_id,
    'locale', p_locale,
    'status', v_localization.status,
    'variantCount', 3,
    'questionCount', 30,
    'draftVersion', v_localization.draft_version,
    'contentHash', v_localization.content_hash
  ));
end;
$$;

create function public.save_course_localization_draft(
  p_actor_id uuid,
  p_test_id uuid,
  p_locale public.app_locale,
  p_expected_version bigint,
  p_title text,
  p_description text,
  p_content jsonb,
  p_question_variants jsonb,
  p_seo jsonb,
  p_sources jsonb,
  p_reviewed_content_hash text,
  p_translation_qa jsonb,
  p_presentation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_draft public.course_drafts%rowtype;
  v_existing public.course_draft_localizations%rowtype;
  v_presentation public.course_presentations%rowtype;
  v_question_variants jsonb;
  v_hash text;
  v_status text;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;
  begin
    if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200
      or char_length(coalesce(p_description, '')) > 2000
      or jsonb_typeof(p_content) is distinct from 'object'
      or pg_column_size(p_content) > 524288
      or p_question_variants is distinct from '[]'::jsonb
      or jsonb_typeof(p_seo) is distinct from 'object'
      or pg_column_size(p_seo) > 32768
      or jsonb_typeof(p_sources) is distinct from 'array'
      or pg_column_size(p_sources) > 131072
      or jsonb_typeof(p_translation_qa) is distinct from 'object'
      or pg_column_size(p_translation_qa) > 65536 then
      raise exception using errcode = 'check_violation',
        message = 'COURSE_LOCALIZATION_INVALID';
    end if;

    select * into v_draft
    from public.course_drafts draft
    where draft.test_id = p_test_id
    for share;
    if not found then
      raise exception using errcode = 'no_data_found',
        message = 'COURSE_DRAFT_NOT_FOUND';
    end if;

    if p_locale = 'ru' and (
      btrim(p_title) is distinct from v_draft.title
      or coalesce(btrim(p_description), '') is distinct from v_draft.description
      or p_content is distinct from v_draft.content
      or p_seo is distinct from v_draft.seo
      or p_sources is distinct from v_draft.sources
      or p_presentation_id is distinct from v_draft.presentation_id
    ) then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'COURSE_RU_LOCALIZATION_MISMATCH';
    end if;

    select * into v_presentation
    from public.course_presentations presentation
    where presentation.id = p_presentation_id
      and presentation.course_id = p_test_id
      and presentation.locale = p_locale
      and presentation.status = 'ready'
    for share;
    if not found then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'PRESENTATION_NOT_READY';
    end if;

    select * into v_existing
    from public.course_draft_localizations localization
    where localization.test_id = p_test_id and localization.locale = p_locale
    for update;
    if found and (
      p_expected_version is null
      or p_expected_version is distinct from v_existing.draft_version
    ) then
      raise exception using errcode = 'serialization_failure',
        message = 'COURSE_LOCALIZATION_CONFLICT';
    end if;
    if not found and p_expected_version is not null then
      raise exception using errcode = 'serialization_failure',
        message = 'COURSE_LOCALIZATION_CONFLICT';
    end if;

    -- The authenticated browser RPC never accepts stable assessment IDs.
    -- Existing imported wording is preserved; a new locale receives a
    -- source-shaped placeholder that cannot publish until the service-only
    -- assessment import marks its QA receipt.
    v_question_variants := case
      when v_existing.test_id is not null then v_existing.question_variants
      else private.localized_variants_from_source(v_draft.question_variants)
    end;

    v_hash := private.localized_course_content_hash(
      p_title, p_description, p_content, v_question_variants, p_seo,
      p_sources, v_presentation.sha256
    );
    v_status := case
      when p_reviewed_content_hash = v_hash
        and coalesce(p_translation_qa ->> 'status', '') in ('passed', 'source')
      then 'complete'
      else 'draft'
    end;

    insert into public.course_draft_localizations (
      test_id, locale, title, description, content, question_variants,
      seo, sources, content_hash, reviewed_content_hash, translation_qa,
      status, draft_version, updated_by
    ) values (
      p_test_id, p_locale, btrim(p_title), coalesce(btrim(p_description), ''),
      p_content, v_question_variants, p_seo, p_sources, v_hash,
      case when v_status = 'complete' then v_hash else null end,
      p_translation_qa, v_status, 1, v_actor_id
    )
    on conflict (test_id, locale) do update
    set title = excluded.title,
        description = excluded.description,
        content = excluded.content,
        question_variants = excluded.question_variants,
        seo = excluded.seo,
        sources = excluded.sources,
        content_hash = excluded.content_hash,
        reviewed_content_hash = excluded.reviewed_content_hash,
        translation_qa = excluded.translation_qa,
        status = excluded.status,
        draft_version = public.course_draft_localizations.draft_version + 1,
        updated_by = excluded.updated_by;

    insert into public.course_draft_presentations(test_id, locale, presentation_id)
    values (p_test_id, p_locale, p_presentation_id)
    on conflict (test_id, locale) do update
    set presentation_id = excluded.presentation_id;

    insert into public.admin_audit_log (
      actor_user_id, action, target_type, target_id, after_data
    ) values (
      v_actor_id,
      'course.localization_saved',
      'course_localization',
      p_test_id::text || ':' || p_locale::text,
      jsonb_build_object(
        'courseId', p_test_id,
        'locale', p_locale,
        'status', v_status,
        'contentHash', v_hash,
        'presentationId', p_presentation_id
      )
    );

    select * into v_existing
    from public.course_draft_localizations localization
    where localization.test_id = p_test_id and localization.locale = p_locale;
    return private.ensure_rpc_payload(jsonb_build_object(
      'courseId', p_test_id,
      'locale', p_locale,
      'status', v_existing.status,
      'draftVersion', v_existing.draft_version,
      'contentHash', v_existing.content_hash,
      'presentationId', p_presentation_id
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.publish_course_revision_v4(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_result jsonb;
  v_revision_id uuid;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;
  begin
    -- Serialize the canonical draft and every locale row before validating.
    -- This preserves the exact reviewed four-locale snapshot while the legacy
    -- editor remains live during the rolling deployment.
    perform 1
    from public.course_drafts draft
    where draft.test_id = p_test_id
    for update;
    perform 1
    from public.course_presentations presentation
    where presentation.id in (
      select mapping.presentation_id
      from public.course_draft_presentations mapping
      where mapping.test_id = p_test_id
    )
    order by presentation.id
    for share;
    perform 1
    from public.course_draft_localizations localization
    where localization.test_id = p_test_id
    order by localization.locale
    for update;
    perform 1
    from public.course_draft_presentations mapping
    where mapping.test_id = p_test_id
    order by mapping.locale
    for update;

    perform private.assert_course_draft_localizations_complete(p_test_id);
    v_result := private.publish_course_revision_v3_unmetered(
      v_actor_id, p_test_id, p_expected_content_hash
    );
    v_revision_id := (v_result ->> 'revisionId')::uuid;
    perform private.attach_course_revision_localizations(
      v_actor_id, p_test_id, v_revision_id
    );
    perform private.assert_course_revision_localizations_complete(v_revision_id);
    insert into public.admin_audit_log (
      actor_user_id, action, target_type, target_id, after_data
    ) values (
      v_actor_id,
      'course.localizations_published',
      'test_revision',
      v_revision_id::text,
      jsonb_build_object(
        'courseId', p_test_id,
        'revisionId', v_revision_id,
        'locales', jsonb_build_array('ru', 'kk', 'en', 'zh')
      )
    );
    return private.ensure_rpc_payload(
      v_result || jsonb_build_object('locales', jsonb_build_array('ru','kk','en','zh'))
    );
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.get_course_editor_localizations(
  p_actor_id uuid,
  p_test_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_result jsonb;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if not exists (select 1 from public.tests test where test.id = p_test_id) then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'locale', locales.locale,
    'status', coalesce(localization.status, 'missing'),
    'title', coalesce(localization.title, ''),
    'description', coalesce(localization.description, ''),
    'content', coalesce(localization.content, '{"modules":[]}'::jsonb),
    'assessment', case when localization.test_id is null then null else
      jsonb_build_object(
        'variantCount', jsonb_array_length(localization.question_variants),
        'questionCounts', coalesce((
          select jsonb_agg(
            jsonb_array_length(variant.value -> 'questions')
            order by (variant.value ->> 'variantNumber')::smallint
          )
          from jsonb_array_elements(localization.question_variants) variant(value)
        ), '[]'::jsonb)
      )
    end,
    'seo', coalesce(localization.seo, '{}'::jsonb),
    'sources', coalesce(localization.sources, '[]'::jsonb),
    'contentHash', localization.content_hash,
    'reviewedContentHash', localization.reviewed_content_hash,
    'translationQa', coalesce(localization.translation_qa, '{}'::jsonb),
    'draftVersion', localization.draft_version,
    'presentation', case when presentation.id is null then null else jsonb_build_object(
      'id', presentation.id,
      'locale', presentation.locale,
      'pageCount', presentation.page_count,
      'sha256', presentation.sha256,
      'byteSize', presentation.byte_size,
      'status', presentation.status
    ) end
  ) order by array_position(enum_range(null::public.app_locale), locales.locale)), '[]'::jsonb)
  into v_result
  from unnest(enum_range(null::public.app_locale)) locales(locale)
  left join public.course_draft_localizations localization
    on localization.test_id = p_test_id and localization.locale = locales.locale
  left join public.course_draft_presentations mapping
    on mapping.test_id = p_test_id and mapping.locale = locales.locale
  left join public.course_presentations presentation
    on presentation.id = mapping.presentation_id;
  return jsonb_build_object('courseId', p_test_id, 'localizations', v_result);
end;
$$;

create function public.list_published_courses_locale(
  p_locale public.app_locale
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if p_locale is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'LOCALE_REQUIRED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', page.slug,
    'locale', page.locale,
    'title', page.title,
    'description', page.description,
    'icon', page.icon,
    'displayOrder', page.display_order,
    'durationMinutes', page.duration_minutes,
    'passScore', page.pass_score,
    'publishedAt', page.published_at
  ) order by page.display_order, page.slug), '[]'::jsonb)
  into v_items
  from (
    select
      revision.slug,
      localization.locale,
      localization.title,
      localization.description,
      revision.icon,
      revision.display_order,
      revision.duration_minutes,
      revision.pass_score,
      localization.published_at
    from public.tests test
    join public.test_revisions revision
      on revision.id = test.current_revision_id
    join public.test_revision_localizations localization
      on localization.revision_id = revision.id
     and localization.locale = p_locale
    where test.status = 'published'
    order by revision.display_order, revision.slug
    limit 100
  ) page;

  return jsonb_build_object('items', v_items);
end;
$$;

-- Preserve the established bounded profile projection while replacing every
-- course title from the immutable localization receipt selected by the route.
-- A missing localization fails closed instead of silently falling back to RU
-- or dropping an attestation from the learner's history.
create function public.get_profile_dashboard_locale(
  p_locale public.app_locale
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dashboard jsonb;
  v_attestations jsonb;
  v_expected integer;
  v_actual integer;
begin
  if p_locale is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'LOCALE_REQUIRED';
  end if;

  v_dashboard := public.get_profile_dashboard();
  v_expected := jsonb_array_length(
    coalesce(v_dashboard -> 'attestations', '[]'::jsonb)
  );

  select
    coalesce(jsonb_agg(
      attestation.item || jsonb_build_object(
        'courseTitle', localization.title
      )
      order by localization.title,
        (attestation.item ->> 'testVersion')::integer desc
    ), '[]'::jsonb),
    count(*)::integer
  into v_attestations, v_actual
  from jsonb_array_elements(
    coalesce(v_dashboard -> 'attestations', '[]'::jsonb)
  ) attestation(item)
  join public.tests test
    on test.id = (attestation.item ->> 'testId')::uuid
  join public.test_revisions revision
    on revision.id = test.current_revision_id
  join public.test_revision_localizations localization
    on localization.revision_id = revision.id
   and localization.locale = p_locale;

  if v_actual is distinct from v_expected then
    raise exception using errcode = 'no_data_found',
      message = 'COURSE_LOCALIZATION_NOT_FOUND';
  end if;

  return jsonb_set(v_dashboard, '{attestations}', v_attestations, false);
end;
$$;

create function public.get_published_course_locale(
  p_slug text,
  p_locale public.app_locale
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_slug is null or char_length(p_slug) not between 1 and 120
    or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception using errcode = 'no_data_found', message = 'COURSE_NOT_FOUND';
  end if;
  select jsonb_build_object(
    'id', test.id,
    'revisionId', revision.id,
    'slug', revision.slug,
    'locale', localization.locale,
    'title', localization.title,
    'description', localization.description,
    'icon', revision.icon,
    'displayOrder', revision.display_order,
    'content', localization.content,
    'seo', localization.seo,
    'sources', localization.sources,
    'jurisdiction', coalesce(revision.jurisdiction, ''),
    'effectiveDate', coalesce(revision.effective_date::text, ''),
    'durationMinutes', revision.duration_minutes,
    'passScore', revision.pass_score,
    'attemptsPerCalendarDay', revision.attempts_per_calendar_day,
    'resetTimezone', revision.attempt_reset_timezone,
    'presentation', jsonb_build_object(
      'id', presentation.id,
      'pageCount', presentation.page_count,
      'sha256', presentation.sha256
    ),
    'publishedAt', localization.published_at
  )
  into v_result
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  join public.test_revision_localizations localization
    on localization.revision_id = revision.id and localization.locale = p_locale
  join public.test_revision_presentations mapping
    on mapping.revision_id = revision.id and mapping.locale = p_locale
  join public.course_presentations presentation
    on presentation.id = mapping.presentation_id
   and presentation.status = 'ready'
  where test.slug = p_slug and test.status = 'published';
  if v_result is null then
    raise exception using errcode = 'no_data_found',
      message = 'COURSE_LOCALIZATION_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

create function public.get_approved_course_presentation_locale(
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
begin
  perform private.require_approved_learner();
  if p_course_slug is null
    or char_length(p_course_slug) not between 1 and 120
    or p_course_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or p_asset is null
    or p_asset not in ('presentation', 'thumbnail') then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;
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

-- Rolling-deployment compatibility: legacy RU editors continue writing the
-- canonical draft while the locale-aware application is deploying. Mirror
-- that source row without ever copying its private answer key fields.
create function private.sync_ru_course_draft_localization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.course_draft_localizations (
    test_id, locale, title, description, content, question_variants, seo,
    sources, content_hash, reviewed_content_hash, translation_qa, status,
    draft_version, updated_by, created_at, updated_at
  ) values (
    new.test_id,
    'ru',
    new.title,
    new.description,
    new.content,
    private.localized_variants_from_source(new.question_variants),
    new.seo,
    new.sources,
    new.content_hash,
    new.content_hash,
    jsonb_build_object('mode', 'source', 'locale', 'ru'),
    'complete',
    new.draft_version,
    new.updated_by,
    new.created_at,
    new.updated_at
  )
  on conflict (test_id, locale) do update
  set title = excluded.title,
      description = excluded.description,
      content = excluded.content,
      question_variants = excluded.question_variants,
      seo = excluded.seo,
      sources = excluded.sources,
      content_hash = excluded.content_hash,
      reviewed_content_hash = excluded.reviewed_content_hash,
      translation_qa = excluded.translation_qa,
      status = excluded.status,
      draft_version = excluded.draft_version,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  if new.presentation_id is null then
    delete from public.course_draft_presentations mapping
    where mapping.test_id = new.test_id and mapping.locale = 'ru';
  else
    insert into public.course_draft_presentations(
      test_id, locale, presentation_id
    ) values (
      new.test_id, 'ru', new.presentation_id
    )
    on conflict (test_id, locale) do update
    set presentation_id = excluded.presentation_id;
  end if;
  return new;
end;
$$;

create trigger course_drafts_sync_ru_localization
after insert or update of title, description, content, question_variants, seo,
  sources, content_hash, draft_version, presentation_id
on public.course_drafts
for each row execute function private.sync_ru_course_draft_localization();

-- The legacy v3 publisher finishes all variant/key inserts before updating
-- `tests.current_revision_id`, so this trigger can create an explicit RU
-- localization receipt for a revision published during a rolling deploy.
create function private.sync_ru_course_revision_localization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision public.test_revisions%rowtype;
begin
  if new.current_revision_id is null
    or new.current_revision_id is not distinct from old.current_revision_id then
    return new;
  end if;
  select * into v_revision
  from public.test_revisions revision
  where revision.id = new.current_revision_id;
  if not found then
    return new;
  end if;

  insert into public.test_revision_localizations (
    revision_id, locale, title, description, content, seo, sources,
    content_hash, translation_qa, published_at, published_by
  ) values (
    v_revision.id,
    'ru',
    v_revision.title,
    v_revision.description,
    v_revision.content,
    v_revision.seo,
    v_revision.sources,
    v_revision.content_hash,
    jsonb_build_object('mode', 'source', 'locale', 'ru'),
    v_revision.published_at,
    v_revision.published_by
  )
  on conflict (revision_id, locale) do nothing;

  insert into public.test_revision_variant_localizations (
    revision_id, variant_id, locale, questions, explanations,
    question_count, structure_hash, content_hash
  )
  select
    variant.revision_id,
    variant.id,
    'ru',
    variant.questions,
    answer_key.explanations,
    variant.question_count,
    private.assessment_structure_hash(variant.questions),
    encode(
      extensions.digest(convert_to(variant.questions::text, 'UTF8'), 'sha256'),
      'hex'
    )
  from public.test_revision_variants variant
  join private.test_revision_variant_answer_keys answer_key
    on answer_key.revision_id = variant.revision_id
   and answer_key.variant_id = variant.id
  where variant.revision_id = v_revision.id
  on conflict (variant_id, locale) do nothing;

  if v_revision.presentation_id is not null then
    insert into public.test_revision_presentations (
      revision_id, locale, presentation_id
    ) values (
      v_revision.id, 'ru', v_revision.presentation_id
    )
    on conflict (revision_id, locale) do nothing;
  end if;
  return new;
end;
$$;

create trigger tests_sync_ru_revision_localization
after update of current_revision_id on public.tests
for each row execute function private.sync_ru_course_revision_localization();

revoke all on function private.localized_public_questions(jsonb),
  private.localized_explanations(jsonb),
  private.localized_course_variants_valid(jsonb),
  private.localized_course_content_hash(text,text,jsonb,jsonb,jsonb,jsonb,text),
  private.localized_assessment_structure(jsonb),
  private.assert_course_draft_localizations_complete(uuid),
  private.attach_course_revision_localizations(uuid,uuid,uuid),
  private.assert_course_revision_localizations_complete(uuid),
  private.sync_ru_course_draft_localization(),
  private.sync_ru_course_revision_localization()
from public, anon, authenticated, service_role;

revoke all on function public.save_course_localization_draft(
  uuid,uuid,public.app_locale,bigint,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb,uuid
), public.import_course_assessment_localization(
  uuid,uuid,public.app_locale,bigint,jsonb
), public.publish_course_revision_v4(uuid,uuid,text),
  public.get_course_editor_localizations(uuid,uuid),
  public.list_published_courses_locale(public.app_locale),
  public.get_published_course_locale(text,public.app_locale),
  public.get_approved_course_presentation_locale(text,text,public.app_locale)
from public, anon, authenticated, service_role;

grant execute on function public.save_course_localization_draft(
  uuid,uuid,public.app_locale,bigint,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb,uuid
) to authenticated;
grant execute on function public.import_course_assessment_localization(
  uuid,uuid,public.app_locale,bigint,jsonb
) to service_role;
grant execute on function public.publish_course_revision_v4(uuid,uuid,text)
  to authenticated;
grant execute on function public.get_course_editor_localizations(uuid,uuid)
  to authenticated;
grant execute on function public.list_published_courses_locale(public.app_locale)
  to anon, authenticated;
revoke all on function public.get_profile_dashboard_locale(public.app_locale)
  from public, anon, authenticated, service_role;
grant execute on function public.get_profile_dashboard_locale(public.app_locale)
  to authenticated;
grant execute on function public.get_published_course_locale(text,public.app_locale)
  to anon, authenticated;
grant execute on function public.get_approved_course_presentation_locale(
  text,text,public.app_locale
) to authenticated;

comment on function public.publish_course_revision_v4(uuid,uuid,text) is
  'Atomically publishes one course revision only after RU/KK/EN/ZH text, variants and immutable presentations are complete.';
comment on function public.get_published_course_locale(text,public.app_locale) is
  'Bounded locale-specific course projection. It never returns variants, questions or answer keys.';
