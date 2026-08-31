revoke all on function public.save_course_draft_v2(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.publish_course_revision_v2(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.save_and_publish_course_v2(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.get_test_editor_payload_v2(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.save_article_draft_v2(
  uuid,text,text,text,text,text,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.set_article_status_v2(uuid,public.article_status,text)
  from public, anon, authenticated, service_role;
revoke all on function public.save_and_publish_article_v2(
  uuid,text,text,text,text,text,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.delete_course(uuid,uuid,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_article(uuid,bigint)
  from public, anon, authenticated, service_role;

grant execute on function public.save_course_draft_v2(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) to authenticated;
grant execute on function public.publish_course_revision_v2(uuid,uuid,text) to authenticated;
grant execute on function public.save_and_publish_course_v2(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) to authenticated;
grant execute on function public.get_test_editor_payload_v2(uuid,uuid) to authenticated;
grant execute on function public.save_article_draft_v2(
  uuid,text,text,text,text,text,jsonb,jsonb
) to authenticated;
grant execute on function public.set_article_status_v2(uuid,public.article_status,text)
  to authenticated;
grant execute on function public.save_and_publish_article_v2(
  uuid,text,text,text,text,text,jsonb,jsonb
) to authenticated;
grant execute on function public.delete_course(uuid,uuid,bigint) to authenticated;
grant execute on function public.delete_article(uuid,bigint) to authenticated;

revoke all on function private.publish_course_revision_v2_unmetered(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function private.save_course_draft_v2_unmetered(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.save_article_draft_v2_unmetered(
  uuid,text,text,text,text,text,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.set_article_status_v2_unmetered(uuid,public.article_status,text)
  from public, anon, authenticated, service_role;
revoke all on function private.course_content_hash_v2(
  text,text,text,text,integer,jsonb,jsonb,jsonb,text,date,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.article_content_hash_v2(
  text,text,text,text,jsonb,jsonb,text,date,jsonb
) from public, anon, authenticated, service_role;
