-- CMS v1 adds public SEO metadata to the live article projection. PostgreSQL
-- does not extend an existing column-level SELECT grant to columns added later,
-- so expose only the new non-sensitive column to the public read roles.
grant select (seo) on public.articles to anon, authenticated;
