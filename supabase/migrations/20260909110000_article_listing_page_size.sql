-- The blog listing and the sitemap stop at fifty articles: the caller asks for
-- `p_limit` 50 exactly once and never walks the keyset, while this function
-- refuses anything above 50 outright. The fifty-first published article would
-- simply never appear anywhere (B3-37).
--
-- The keyset itself was already here — `(published_at, id) <` with a matching
-- order — so only the ceiling and the caller needed fixing. The ceiling stays:
-- an unbounded page would let an anonymous request pull the whole table in one
-- statement, which is the reason the guard exists. One hundred rows per page
-- with the caller paging through is the same protection without the wall.
create or replace function public.list_published_articles_locale(
  p_locale public.app_locale,
  p_limit integer default 20,
  p_before_published_at timestamptz default null,
  p_before_id uuid default null
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
  if p_limit not between 1 and 100
    or ((p_before_published_at is null) <> (p_before_id is null)) then
    raise exception using errcode = 'check_violation',
      message = 'ARTICLE_PAGE_INVALID';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'revisionId', page.revision_id,
    'slug', page.slug,
    'locale', page.locale,
    'title', page.title,
    'description', page.description,
    'coverImage', page.cover_image,
    'publishedAt', page.published_at,
    'effectiveDate', coalesce(page.effective_date::text, ''),
    'seo', page.seo
  ) order by page.published_at desc, page.id desc), '[]'::jsonb)
  into v_result
  from (
    select
      article.id,
      revision.id as revision_id,
      revision.slug,
      localization.locale,
      localization.title,
      localization.description,
      revision.cover_image,
      revision.published_at,
      revision.effective_date,
      localization.seo
    from public.articles article
    join public.article_revisions revision
      on revision.id = article.current_revision_id
    join public.article_revision_localizations localization
      on localization.revision_id = revision.id
     and localization.locale = p_locale
    where article.status = 'published'
      and article.is_published
      and (
        p_before_published_at is null
        or (revision.published_at, article.id) <
          (p_before_published_at, p_before_id)
      )
    order by revision.published_at desc, article.id desc
    limit p_limit
  ) page;

  return jsonb_build_object('items', v_result);
end;
$$;
