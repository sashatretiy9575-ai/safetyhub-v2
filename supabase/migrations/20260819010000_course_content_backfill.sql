-- Preserve the three reviewed launch courses while moving their lesson material
-- from repository JSON into the revisioned CMS document.

create temporary table course_content_backfill (
  slug text primary key,
  icon text not null,
  content jsonb not null
) on commit drop;

insert into course_content_backfill(slug, icon, content) values
('fire-safety', 'fire', $course${"modules":[{"id":"module-main","title":"Пожарная безопасность","lessons":[{"id":"lesson-01","title":"Что такое пожарная безопасность?","blocks":[{"type":"paragraph","content":"Пожарная безопасность — состояние объекта, при котором исключается возможность возникновения и развития пожара, а также обеспечивается защита людей и имущества от воздействия его опасных факторов."}]},{"id":"lesson-02","title":"Профилактика пожара","blocks":[{"type":"paragraph","content":"Правила пожарной безопасности требуют сохранять эвакуационные пути свободными, не ограничивать доступ к огнетушителям, пожарным кранам и системам защиты, а также поддерживать их в готовности."}]},{"id":"lesson-03","title":"Классы пожаров","blocks":[{"type":"paragraph","content":"Тип огнетушителя выбирают с учётом класса пожара по виду горючего материала. В Правилах используются классы A, B, C и D, а пригодность заряда для тушения электрооборудования обозначается отдельно как (E)."}]},{"id":"lesson-04","title":"Первичные средства пожаротушения","blocks":[{"type":"paragraph","content":"Вид и количество огнетушителей определяют по их огнетушащей способности, классу пожара и особенностям помещения или оборудования. Их размещают на видных местах и у эвакуационных выходов, не создавая помех эвакуации."}]},{"id":"lesson-05","title":"Действия при обнаружении пожара","blocks":[{"type":"paragraph","content":"1. Сообщить в пожарную службу (101/112). 2. Оповестить руководство. 3. Принять меры по эвакуации людей. 4. При возможности приступить к тушению первичными средствами. 5. Встретить пожарные подразделения."}]}]}]}$course$::jsonb),
('industrial-safety', 'factory', $course${"modules":[{"id":"module-main","title":"Промышленная безопасность","lessons":[{"id":"lesson-01","title":"Что такое промышленная безопасность?","blocks":[{"type":"paragraph","content":"Промышленная безопасность — состояние защищённости жизненно важных интересов личности и общества от аварий на опасных производственных объектах и последствий этих аварий."}]},{"id":"lesson-02","title":"Опасные производственные объекты (ОПО)","blocks":[{"type":"paragraph","content":"Опасный производственный объект определяют по признакам, установленным Законом «О гражданской защите». Организация проводит идентификацию и передаёт информацию для постановки объекта на учёт."}]},{"id":"lesson-03","title":"Идентификация и учёт","blocks":[{"type":"paragraph","content":"Постановка на учёт начинается с идентификации конкретного объекта по законным признакам. Результаты направляют в территориальное подразделение уполномоченного органа."}]},{"id":"lesson-04","title":"Обязанности работника на ОПО","blocks":[{"type":"paragraph","content":"Работник на ОПО соблюдает требования промышленной безопасности и локальные инструкции, проходит подготовку и сдаёт экзамен в объёме, который соответствует его работе. Конкретные действия при аварии определяются документами и планами организации."}]},{"id":"lesson-05","title":"Подготовка и экзамены","blocks":[{"type":"paragraph","content":"С 2026 года работники, выполняющие работы на ОПО, проходят подготовку и сдают экзамен ежегодно; руководители, специалисты и инженерно-технические работники — один раз в три года. Вновь принятые проходят подготовку и сдают экзамен не позднее одного месяца со дня назначения."}]}]}]}$course$::jsonb),
('occupational-health', 'shield', $course${"modules":[{"id":"module-main","title":"Охрана труда","lessons":[{"id":"lesson-01","title":"Что такое охрана труда?","blocks":[{"type":"paragraph","content":"Охрана труда — система обеспечения безопасности жизни и здоровья работников в процессе трудовой деятельности. Она включает правовые, организационно-технические, санитарно-эпидемиологические, лечебно-профилактические и иные мероприятия и средства."}]},{"id":"lesson-02","title":"Виды инструктажей","blocks":[{"type":"paragraph","content":"Правила предусматривают вводный, первичный на рабочем месте, повторный, внеплановый и целевой инструктажи. Конкретный вид и срок зависят от обстоятельств допуска к работе и требований к безопасности."}]},{"id":"lesson-03","title":"Права работника","blocks":[{"type":"paragraph","content":"Работник имеет право на рабочее место, оборудованное по требованиям безопасности и охраны труда, и на необходимые средства защиты. Если такие средства не предоставлены или ситуация угрожает жизни или здоровью, он может отказаться от работы, письменно уведомив непосредственного руководителя или работодателя."}]},{"id":"lesson-04","title":"Обязанности работника","blocks":[{"type":"paragraph","content":"Работник обязан: соблюдать требования охраны труда, правильно применять СИЗ, проходить обучение и инструктаж, немедленно извещать руководителя об опасной ситуации или несчастном случае, проходить медицинские осмотры."}]},{"id":"lesson-05","title":"Расследование несчастных случаев","blocks":[{"type":"paragraph","content":"Работодатель обеспечивает расследование несчастного случая, связанного с трудовой деятельностью, в установленном порядке. Тяжёлые, смертельные и групповые случаи оформляются актом специального расследования. Сроки и состав комиссии определяются кодексом и применимыми правилами для обстоятельств конкретного случая."}]}]}]}$course$::jsonb);

update public.course_drafts draft
set icon = source.icon,
    content = source.content
from course_content_backfill source
where source.slug = draft.slug;

update public.course_drafts draft
set content_hash = private.course_content_hash(
      draft.slug, draft.title, draft.description, draft.icon,
      draft.duration_minutes, draft.content, draft.questions, draft.seo
    ),
    reviewed_content_hash = case
      when draft.reviewed_content_hash is null then null
      else private.course_content_hash(
        draft.slug, draft.title, draft.description, draft.icon,
        draft.duration_minutes, draft.content, draft.questions, draft.seo
      )
    end,
    draft_version = draft_version + 1,
    updated_at = statement_timestamp()
where exists (select 1 from course_content_backfill source where source.slug = draft.slug);

update public.tests test
set icon = draft.icon,
    content_hash = draft.content_hash,
    reviewed_content_hash = case
      when test.reviewed_content_hash is null then null else draft.content_hash
    end
from public.course_drafts draft
where draft.test_id = test.id
  and exists (select 1 from course_content_backfill source where source.slug = draft.slug);

with source_revision as (
  select
    test.id as test_id,
    test.content_version + 1 as next_version,
    revision.slug,
    revision.title,
    revision.description,
    draft.icon,
    draft.content,
    revision.seo,
    draft.content_hash,
    revision.jurisdiction,
    revision.effective_date,
    revision.reviewer,
    revision.reviewed_at,
    revision.next_review_at,
    revision.sources,
    revision.questions,
    revision.question_count,
    revision.duration_minutes,
    revision.pass_score,
    revision.published_at,
    revision.published_by,
    answer_key.correct_positions,
    answer_key.explanations
  from public.tests test
  join public.course_drafts draft on draft.test_id = test.id
  join public.test_revisions revision on revision.id = test.current_revision_id
  join private.test_revision_answer_keys answer_key
    on answer_key.revision_id = revision.id
  where exists (
    select 1 from course_content_backfill source where source.slug = draft.slug
  )
),
inserted_revision as (
  insert into public.test_revisions (
    id, test_id, version, slug, title, description, icon, content, seo,
    content_hash, jurisdiction, effective_date, reviewer, reviewed_at,
    next_review_at, sources, questions, question_count, duration_minutes,
    pass_score, published_at, published_by
  )
  select
    gen_random_uuid(), source.test_id, source.next_version, source.slug,
    source.title, source.description, source.icon, source.content, source.seo,
    source.content_hash, source.jurisdiction, source.effective_date,
    source.reviewer, source.reviewed_at, source.next_review_at, source.sources,
    source.questions, source.question_count, source.duration_minutes,
    source.pass_score, source.published_at, source.published_by
  from source_revision source
  returning id, test_id, version
),
copied_answer_key as (
  insert into private.test_revision_answer_keys (
    revision_id, correct_positions, explanations
  )
  select inserted.id, source.correct_positions, source.explanations
  from inserted_revision inserted
  join source_revision source on source.test_id = inserted.test_id
  returning revision_id
)
update public.tests test
set current_revision_id = inserted.id,
    content_version = inserted.version
from inserted_revision inserted
where test.id = inserted.test_id
  and exists (
    select 1 from copied_answer_key copied where copied.revision_id = inserted.id
  );

do $migration$
begin
  if exists (
    select 1
    from public.tests test
    join public.course_drafts draft on draft.test_id = test.id
    join public.test_revisions revision on revision.id = test.current_revision_id
    where exists (
      select 1 from course_content_backfill source where source.slug = draft.slug
    )
      and revision.content_hash is distinct from draft.content_hash
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_CONTENT_BACKFILL_INCOMPLETE';
  end if;
end;
$migration$;
