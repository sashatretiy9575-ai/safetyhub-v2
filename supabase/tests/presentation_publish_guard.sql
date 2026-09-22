begin;

-- The server publishes a presentation with its own key: it stages the file,
-- moves it to validating and finalises it. The guard that protects a ready
-- presentation must not stop that, and must still protect a ready one.
do $test$
declare v_course uuid; v_id uuid := gen_random_uuid(); v_actor uuid := gen_random_uuid();
 v_blocked boolean;
begin
 select id into strict v_course from public.tests order by slug limit 1;
 insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',v_actor,'authenticated','authenticated','presentation-guard@safetyhub.invalid','{}','{}',now(),now());
 insert into public.course_presentations(id,course_id,locale,storage_bucket,storage_path,thumbnail_path,
   source_filename,mime_type,byte_size,sha256,page_count,aspect_ratio,status,created_by)
 values(v_id,v_course,'ru','course-presentations-staging',v_id::text||'/staged.pdf',v_id::text||'/staged.webp',
   'staged.pdf','application/pdf',1024,repeat('e',64),42,'16:9','staging',v_actor);

 set local role service_role;
 update public.course_presentations set status='validating', validation_error=null
 where id=v_id and status='staging';
 if not found then raise exception 'the server could not stage a presentation for validation'; end if;

 -- A presentation already in the catalogue keeps its bytes whoever asks. A ready
 -- one lives in the catalogue's own bucket, so it moves there as it is finalised.
 reset role;
 update public.course_presentations set status='ready', validated_at=now(),
   storage_bucket='course-presentations',
   storage_path=v_course::text||'/ru/'||v_id::text||'/'||repeat('e',64)||'.pdf',
   thumbnail_path=v_course::text||'/ru/'||v_id::text||'/'||repeat('e',64)||'-thumb.webp'
 where id=v_id;
 set local role service_role;
 v_blocked := false;
 begin
   update public.course_presentations set sha256=repeat('f',64) where id=v_id;
 exception when others then v_blocked := sqlerrm = 'PRESENTATION_IN_USE';
 end;
 reset role;
 if not v_blocked then raise exception 'a published presentation was rewritten'; end if;
end; $test$;

rollback;
