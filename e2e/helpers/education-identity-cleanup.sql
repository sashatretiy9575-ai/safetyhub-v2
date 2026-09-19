create or replace function pg_temp.cleanup_document_certificate_fixture(learner uuid)
returns void language plpgsql as $$
begin
 perform 1 from auth.users where id=learner and email=learner::text||'@document-regression.invalid' for update;
 if not found then return; end if;
 -- This fixture only writes a photo timestamp. It never uploads any bytes.
 -- Refuse cleanup if any actual Storage or upload state has appeared.
 if exists(select 1 from storage.objects where name like learner::text||'/%' or owner_id=learner::text)
   or exists(select 1 from private.profile_avatar_manifests where user_id=learner)
   or exists(select 1 from private.avatar_upload_operations where user_id=learner)
 then raise exception 'SYNTHETIC_FIXTURE_HAS_STORAGE'; end if;
 update public.profiles set avatar_updated_at=null where id=learner;
 update public.account_controls set deletion_pending=true where user_id=learner;
 insert into private.account_storage_cleanup_tombstones
   (user_id,storage_prefix,state,requested_at,cleanup_not_before,empty_confirmed_at,storage_cleared_at)
 values(learner,learner::text||'/','storage_cleared',now(),now(),now(),now());
 perform public.purge_user_account(learner);
 -- No storage was ever allocated; remove this fixture's now-completed queue record.
 delete from private.account_storage_cleanup_tombstones where user_id=learner and state='post_purge_cleanup';
end; $$;
