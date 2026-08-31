-- Previously saved assessment variants contain correct-option identifiers and
-- explanations. They must never cross a browser/RSC/RPC boundary, including
-- an authenticated administrator session. The admin editor now receives a
-- metadata-only seed and submits only a newly authored in-memory variant set.
--
-- Keep the functions for migration compatibility and server-side operational
-- inspection, but retire every browser-role execution grant. The service-only
-- linked-content export remains `get_published_course_snapshot_v3`, which is
-- intentionally separate and still never callable by browser roles.

revoke all on function public.get_test_editor_payload(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_test_editor_payload_v2(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_course_editor_payload_v3(uuid,uuid)
  from public, anon, authenticated, service_role;

comment on function public.get_test_editor_payload(uuid,uuid) is
  'Retired browser editor-key read surface. Existing assessment keys must remain server-only.';
comment on function public.get_test_editor_payload_v2(uuid,uuid) is
  'Retired browser editor-key read surface. Existing assessment keys must remain server-only.';
comment on function public.get_course_editor_payload_v3(uuid,uuid) is
  'Retired browser editor-key read surface. Existing assessment keys must remain server-only.';
