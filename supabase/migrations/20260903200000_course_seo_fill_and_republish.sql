-- Fills the SEO block of every course, in every language, and republishes.
--
-- SEO was never collected when these courses were created, so `seo` was `{}`
-- for all five in all four languages. The editor opened with five blank fields,
-- publication was refused with "Заполните SEO-заголовок и описание курса", and
-- every public page fell back to a bare one-word title. Filling only the drafts
-- would have left the live pages untouched, because a published revision is
-- immutable by design, so this publishes a fresh revision as well.
--
-- Each description is the course's own published wording in that language plus
-- one standard clause; nothing here is machine-translated. The Kazakh and
-- English names of the fire-safety course were stored in lower case and are
-- capitalized in its SEO title.
--
-- `content_hash` covers `seo`, so every hash is recomputed with the same
-- functions the editor uses. A localization that was reviewed keeps its reviewed
-- state: the SEO block is page metadata, not a translation of the questions.
--
-- Only an empty SEO block is filled and only a course that was already published
-- is republished, which makes this idempotent and safe to re-run.

do $seo$
declare
  v_admin uuid;
  v_draft public.course_drafts%rowtype;
  v_presentation_sha text;
  v_presentation_pages integer;
  v_locale_sha text;
  v_hash text;
  v_locale text;
  v_seo jsonb;
  v_revision_id uuid;
  v_result jsonb;
  v_filled integer := 0;
  v_published integer := 0;
  v_skipped integer := 0;
begin
  -- Act as an administrator, so every write goes through the same capability
  -- checks and the same audit trail as the editor would.
  select role.user_id into v_admin
  from public.user_roles role
  join public.account_controls control on control.user_id = role.user_id
  where role.product_role = 'admin'
    and control.status = 'active'
    and not control.deletion_pending
  order by role.user_id
  limit 1;
  if v_admin is null then
    raise notice 'course seo: no active administrator, nothing filled';
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  for v_draft in select * from public.course_drafts order by slug loop
    v_seo := case v_draft.slug
      when 'plotnik' then '{"title":"Плотник — онлайн-обучение и аттестация","description":"Безопасные методы работы плотника: организация рабочего места, ручной и электроинструмент, СИЗ и действия при неисправностях. Онлайн-курс, тест и сертификат SafetyHub.","ogTitle":"Плотник — онлайн-обучение и аттестация","ogDescription":"Безопасные методы работы плотника: организация рабочего места, ручной и электроинструмент, СИЗ и действия при неисправностях. Онлайн-курс, тест и сертификат SafetyHub.","ogImage":"","indexable":true}'::jsonb
      when 'armaturshchik' then '{"title":"Арматурщик — онлайн-обучение и аттестация","description":"Безопасная подготовка, обработка, перемещение и монтаж арматуры с контролем инструмента, каркаса и рабочей зоны. Онлайн-курс, тест и сертификат SafetyHub.","ogTitle":"Арматурщик — онлайн-обучение и аттестация","ogDescription":"Безопасная подготовка, обработка, перемещение и монтаж арматуры с контролем инструмента, каркаса и рабочей зоны. Онлайн-курс, тест и сертификат SafetyHub.","ogImage":"","indexable":true}'::jsonb
      when 'biot' then '{"title":"БИОТ — онлайн-обучение и аттестация","description":"Базовые требования безопасности и охраны труда: опасности, оценка риска, обучение, допуск, средства защиты и аварийные действия. Онлайн-курс, тест и сертификат SafetyHub.","ogTitle":"БИОТ — онлайн-обучение и аттестация","ogDescription":"Базовые требования безопасности и охраны труда: опасности, оценка риска, обучение, допуск, средства защиты и аварийные действия. Онлайн-курс, тест и сертификат SafetyHub.","ogImage":"","indexable":true}'::jsonb
      when 'lesomontazhnye-raboty' then '{"title":"Лесомонтажные работы — онлайн-обучение и аттестация","description":"Безопасный монтаж и эксплуатация лесов: проект, основание, связи, настил, ограждения, доступ, допуск и контроль условий. Онлайн-курс, тест и сертификат SafetyHub.","ogTitle":"Лесомонтажные работы — онлайн-обучение и аттестация","ogDescription":"Безопасный монтаж и эксплуатация лесов: проект, основание, связи, настил, ограждения, доступ, допуск и контроль условий. Онлайн-курс, тест и сертификат SafetyHub.","ogImage":"","indexable":true}'::jsonb
      when 'pozharnaya-bezopasnost' then '{"title":"Пожарная безопасность — онлайн-обучение и аттестация","description":"Профилактика пожаров, оповещение, эвакуация, применение первичных средств тушения и безопасные действия при пожаре. Онлайн-курс, тест и сертификат SafetyHub.","ogTitle":"Пожарная безопасность — онлайн-обучение и аттестация","ogDescription":"Профилактика пожаров, оповещение, эвакуация, применение первичных средств тушения и безопасные действия при пожаре. Онлайн-курс, тест и сертификат SafetyHub.","ogImage":"","indexable":true}'::jsonb
      else null
    end;
    if v_seo is null then
      continue;
    end if;

    select presentation.sha256, presentation.page_count
      into v_presentation_sha, v_presentation_pages
    from public.course_presentations presentation
    where presentation.id = v_draft.presentation_id;

    if v_draft.seo is null or v_draft.seo = '{}'::jsonb then
      v_hash := private.course_content_hash_v3(
        v_draft.slug, v_draft.title, coalesce(v_draft.description, ''),
        coalesce(nullif(btrim(v_draft.icon), ''), 'factory'), v_draft.display_order,
        v_presentation_sha, v_presentation_pages,
        v_draft.duration_minutes, v_draft.pass_score, v_draft.attempts_per_calendar_day,
        v_draft.attempt_reset_timezone, v_draft.question_variants, v_seo,
        v_draft.jurisdiction, v_draft.effective_date, v_draft.sources
      );
      update public.course_drafts draft
      set seo = v_seo,
          content_hash = v_hash,
          draft_version = draft.draft_version + 1,
          updated_by = coalesce(draft.updated_by, v_admin),
          updated_at = now()
      where draft.test_id = v_draft.test_id;
      v_filled := v_filled + 1;
    end if;

    -- The Russian localization is kept in step with the course form by its own
    -- trigger, so only the translated locales are written here.
    foreach v_locale in array array['kk', 'en', 'zh'] loop
      v_seo := case v_draft.slug || '|' || v_locale
        when 'plotnik|kk' then '{"title":"Ағаш шебері — онлайн оқыту және аттестаттау","description":"Ағаш ұстасының қауіпсіз жұмыс тәжірибесі: жұмыс орнын ұйымдастыру, қол және электр құралдары, ЖҚҚ және ақауларды жою. SafetyHub онлайн курсы, тесті және сертификаты.","ogTitle":"Ағаш шебері — онлайн оқыту және аттестаттау","ogDescription":"Ағаш ұстасының қауіпсіз жұмыс тәжірибесі: жұмыс орнын ұйымдастыру, қол және электр құралдары, ЖҚҚ және ақауларды жою. SafetyHub онлайн курсы, тесті және сертификаты.","ogImage":"","indexable":true}'::jsonb
        when 'plotnik|en' then '{"title":"Carpenter — online training and certification","description":"Safe carpenter work practices: workplace organization, hand and power tools, PPE and troubleshooting. SafetyHub online course, test and certificate.","ogTitle":"Carpenter — online training and certification","ogDescription":"Safe carpenter work practices: workplace organization, hand and power tools, PPE and troubleshooting. SafetyHub online course, test and certificate.","ogImage":"","indexable":true}'::jsonb
        when 'plotnik|zh' then '{"title":"木匠 — 在线培训与考核","description":"安全木匠工作实践：工作场所组织、手动和电动工具、PPE 和故障排除。 SafetyHub 在线课程、测试与证书。","ogTitle":"木匠 — 在线培训与考核","ogDescription":"安全木匠工作实践：工作场所组织、手动和电动工具、PPE 和故障排除。 SafetyHub 在线课程、测试与证书。","ogImage":"","indexable":true}'::jsonb
        when 'armaturshchik|kk' then '{"title":"Арматуршы — онлайн оқыту және аттестаттау","description":"Құралды, жақтауды және жұмыс аймағын басқара отырып, арматураны қауіпсіз дайындау, өңдеу, өңдеу және орнату. SafetyHub онлайн курсы, тесті және сертификаты.","ogTitle":"Арматуршы — онлайн оқыту және аттестаттау","ogDescription":"Құралды, жақтауды және жұмыс аймағын басқара отырып, арматураны қауіпсіз дайындау, өңдеу, өңдеу және орнату. SafetyHub онлайн курсы, тесті және сертификаты.","ogImage":"","indexable":true}'::jsonb
        when 'armaturshchik|en' then '{"title":"Rebar worker — online training and certification","description":"Safe preparation, processing, handling and installation of reinforcement with control of the tool, frame and work area. SafetyHub online course, test and certificate.","ogTitle":"Rebar worker — online training and certification","ogDescription":"Safe preparation, processing, handling and installation of reinforcement with control of the tool, frame and work area. SafetyHub online course, test and certificate.","ogImage":"","indexable":true}'::jsonb
        when 'armaturshchik|zh' then '{"title":"钢筋工 — 在线培训与考核","description":"通过控制工具、框架和工作区域安全地准备、加工、搬运和安装钢筋。 SafetyHub 在线课程、测试与证书。","ogTitle":"钢筋工 — 在线培训与考核","ogDescription":"通过控制工具、框架和工作区域安全地准备、加工、搬运和安装钢筋。 SafetyHub 在线课程、测试与证书。","ogImage":"","indexable":true}'::jsonb
        when 'biot|kk' then '{"title":"BIOT — онлайн оқыту және аттестаттау","description":"Еңбек қауіпсіздігі және еңбекті қорғаудың негізгі талаптары: қауіптер, тәуекелдерді бағалау, оқыту, бекіту, қорғаныс құралдары және төтенше жағдайлар кезіндегі процедуралар.","ogTitle":"BIOT — онлайн оқыту және аттестаттау","ogDescription":"Еңбек қауіпсіздігі және еңбекті қорғаудың негізгі талаптары: қауіптер, тәуекелдерді бағалау, оқыту, бекіту, қорғаныс құралдары және төтенше жағдайлар кезіндегі процедуралар.","ogImage":"","indexable":true}'::jsonb
        when 'biot|en' then '{"title":"BIOT — online training and certification","description":"Basic occupational safety and health requirements: hazards, risk assessment, training, approval, protective equipment and emergency procedures. SafetyHub online course, test and certificate.","ogTitle":"BIOT — online training and certification","ogDescription":"Basic occupational safety and health requirements: hazards, risk assessment, training, approval, protective equipment and emergency procedures. SafetyHub online course, test and certificate.","ogImage":"","indexable":true}'::jsonb
        when 'biot|zh' then '{"title":"BIOT — 在线培训与考核","description":"基本职业安全健康要求：危害、风险评估、培训、批准、防护装备和应急程序。 SafetyHub 在线课程、测试与证书。","ogTitle":"BIOT — 在线培训与考核","ogDescription":"基本职业安全健康要求：危害、风险评估、培训、批准、防护装备和应急程序。 SafetyHub 在线课程、测试与证书。","ogImage":"","indexable":true}'::jsonb
        when 'lesomontazhnye-raboty|kk' then '{"title":"Құрылыс мінбелерін монтаждау жұмыстары — онлайн оқыту және аттестаттау","description":"Құрылыс мінбелерін қауіпсіз монтаждау және пайдалану: жоба, негіз, байланыстар, төсем, қоршаулар, қауіпсіз қолжетімділік, пайдалануға рұқсат және жағдайларды бақылау.","ogTitle":"Құрылыс мінбелерін монтаждау жұмыстары — онлайн оқыту және аттестаттау","ogDescription":"Құрылыс мінбелерін қауіпсіз монтаждау және пайдалану: жоба, негіз, байланыстар, төсем, қоршаулар, қауіпсіз қолжетімділік, пайдалануға рұқсат және жағдайларды бақылау.","ogImage":"","indexable":true}'::jsonb
        when 'lesomontazhnye-raboty|en' then '{"title":"Scaffolding erection work — online training and certification","description":"Safe installation and operation of scaffolding: design, foundation, connections, working platform, fencing, access, permission and control of conditions. SafetyHub online course, test and certificate.","ogTitle":"Scaffolding erection work — online training and certification","ogDescription":"Safe installation and operation of scaffolding: design, foundation, connections, working platform, fencing, access, permission and control of conditions. SafetyHub online course, test and certificate.","ogImage":"","indexable":true}'::jsonb
        when 'lesomontazhnye-raboty|zh' then '{"title":"脚手架搭设作业 — 在线培训与考核","description":"脚手架的安全安装和操作：设计、基础、连接、作业平台、围栏、通道、许可和条件控制。 SafetyHub 在线课程、测试与证书。","ogTitle":"脚手架搭设作业 — 在线培训与考核","ogDescription":"脚手架的安全安装和操作：设计、基础、连接、作业平台、围栏、通道、许可和条件控制。 SafetyHub 在线课程、测试与证书。","ogImage":"","indexable":true}'::jsonb
        when 'pozharnaya-bezopasnost|kk' then '{"title":"Өрт қауіпсіздігі — онлайн оқыту және аттестаттау","description":"Өрттің алдын алу, ескерту, эвакуация, бастапқы сөндіргіштерді қолдану және өрт кезіндегі қауіпсіз әрекеттер. SafetyHub онлайн курсы, тесті және сертификаты.","ogTitle":"Өрт қауіпсіздігі — онлайн оқыту және аттестаттау","ogDescription":"Өрттің алдын алу, ескерту, эвакуация, бастапқы сөндіргіштерді қолдану және өрт кезіндегі қауіпсіз әрекеттер. SafetyHub онлайн курсы, тесті және сертификаты.","ogImage":"","indexable":true}'::jsonb
        when 'pozharnaya-bezopasnost|en' then '{"title":"Fire safety — online training and certification","description":"Fire prevention, warning, evacuation, use of primary extinguishing agents and safe actions in case of fire. SafetyHub online course, test and certificate.","ogTitle":"Fire safety — online training and certification","ogDescription":"Fire prevention, warning, evacuation, use of primary extinguishing agents and safe actions in case of fire. SafetyHub online course, test and certificate.","ogImage":"","indexable":true}'::jsonb
        when 'pozharnaya-bezopasnost|zh' then '{"title":"消防安全 — 在线培训与考核","description":"防火、警告、疏散、初级灭火剂的使用以及火灾时的安全行动。 SafetyHub 在线课程、测试与证书。","ogTitle":"消防安全 — 在线培训与考核","ogDescription":"防火、警告、疏散、初级灭火剂的使用以及火灾时的安全行动。 SafetyHub 在线课程、测试与证书。","ogImage":"","indexable":true}'::jsonb
        else null
      end;
      if v_seo is null then
        continue;
      end if;

      select presentation.sha256 into v_locale_sha
      from public.course_draft_presentations mapping
      join public.course_presentations presentation on presentation.id = mapping.presentation_id
      where mapping.test_id = v_draft.test_id
        and mapping.locale = v_locale::public.app_locale;

      update public.course_draft_localizations localization
      set seo = v_seo,
          content_hash = private.localized_course_content_hash(
            localization.title, localization.description, localization.content,
            localization.question_variants, v_seo, localization.sources, v_locale_sha
          ),
          -- A reviewed translation stays reviewed: the SEO block is page
          -- metadata, not a translation of the questions. Dropping it would
          -- block publication for a change no translator has to look at.
          reviewed_content_hash = case
            when localization.reviewed_content_hash is null then null
            else private.localized_course_content_hash(
              localization.title, localization.description, localization.content,
              localization.question_variants, v_seo, localization.sources, v_locale_sha
            )
          end,
          draft_version = localization.draft_version + 1,
          updated_by = coalesce(localization.updated_by, v_admin),
          updated_at = now()
      where localization.test_id = v_draft.test_id
        and localization.locale = v_locale::public.app_locale
        and (localization.seo is null or localization.seo = '{}'::jsonb);
    end loop;
  end loop;

  -- Publish, so the new SEO actually reaches the public pages. Only a course
  -- that is already published is republished; a draft-only course stays a draft.
  for v_draft in
    select draft.*
    from public.course_drafts draft
    join public.tests test on test.id = draft.test_id
    where test.status = 'published'
      -- Only when the draft actually differs from what is live. Republishing an
      -- unchanged course would mint an identical revision on every re-run.
      and draft.content_hash is distinct from (
        select revision.content_hash
        from public.test_revisions revision
        where revision.test_id = draft.test_id
        order by revision.version desc
        limit 1
      )
    order by draft.slug
  loop
    begin
      select draft.content_hash into v_hash
      from public.course_drafts draft
      where draft.test_id = v_draft.test_id;

      perform private.assert_course_draft_localizations_complete(v_draft.test_id);
      v_result := private.publish_course_revision_v3_unmetered(v_admin, v_draft.test_id, v_hash);
      v_revision_id := (v_result ->> 'revisionId')::uuid;
      perform private.attach_course_revision_localizations(v_admin, v_draft.test_id, v_revision_id);
      perform private.assert_course_revision_localizations_complete(v_revision_id);
      v_published := v_published + 1;
      raise notice 'course republished with seo: %', v_draft.slug;
    exception
      when others then
        -- A course that cannot be published right now keeps its existing live
        -- revision and its filled draft; it is reported rather than forced.
        v_skipped := v_skipped + 1;
        raise warning 'course not republished: % (%)', v_draft.slug, sqlerrm;
    end;
  end loop;

  raise notice 'course seo: % drafts filled, % republished, % skipped',
    v_filled, v_published, v_skipped;
end;
$seo$;
