begin;

-- Stage 6 stores the exact raw staged assessment projection in the course
-- draft receipt. Per-variant hashes belong exclusively to their localization
-- rows, otherwise adding those receipt fields changes the course hash input.
do $contract$
declare
  v_localization_count integer;
  v_variant_count integer;
begin
  select count(*) into v_localization_count
  from public.course_draft_localizations localization
  where localization.locale in ('kk'::public.app_locale, 'en'::public.app_locale, 'zh'::public.app_locale);
  if v_localization_count <> 15 then
    raise exception 'expected 15 seeded non-RU course localizations, got %', v_localization_count;
  end if;

  if exists (
    select 1
    from public.course_draft_localizations draft
    join public.course_draft_presentations draft_presentation
      on draft_presentation.test_id = draft.test_id
     and draft_presentation.locale = draft.locale
    join public.course_presentations presentation
      on presentation.id = draft_presentation.presentation_id
    where draft.locale in ('kk'::public.app_locale, 'en'::public.app_locale, 'zh'::public.app_locale)
      and private.localized_course_content_hash(
        draft.title,
        draft.description,
        draft.content,
        draft.question_variants,
        draft.seo,
        draft.sources,
        presentation.sha256
      ) is distinct from draft.content_hash
  ) then
    raise exception 'localized raw course projection does not match its published receipt';
  end if;

  if exists (
    select 1
    from public.course_draft_localizations draft
    cross join lateral jsonb_array_elements(draft.question_variants) variant(value)
    where draft.locale in ('kk'::public.app_locale, 'en'::public.app_locale, 'zh'::public.app_locale)
      and (variant.value ? 'structureHash' or variant.value ? 'contentHash')
  ) then
    raise exception 'variant receipts leaked into localized course hash input';
  end if;

  select count(*) into v_variant_count
  from public.test_revision_variant_localizations localization
  where localization.locale in ('kk'::public.app_locale, 'en'::public.app_locale, 'zh'::public.app_locale);
  if v_variant_count <> 45 then
    raise exception 'expected 45 seeded non-RU variant localizations, got %', v_variant_count;
  end if;

  if exists (
    select 1
    from public.test_revision_variant_localizations localization
    where localization.locale in ('kk'::public.app_locale, 'en'::public.app_locale, 'zh'::public.app_locale)
      and encode(
        extensions.digest(
          convert_to(
            jsonb_build_object(
              'questions', localization.questions,
              'explanations', localization.explanations
            )::text,
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) is distinct from localization.content_hash
  ) then
    raise exception 'localized per-variant receipt does not match its own public projection';
  end if;
end;
$contract$;

rollback;
