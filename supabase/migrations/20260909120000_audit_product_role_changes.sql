-- Authorization reads `product_role`; the audit trail watched `role`. The
-- trigger was declared `after update of role`, so an update touching only
-- `product_role` — the column that actually decides access — did not fire it at
-- all, and a direct escalation left no trace (B1-47).
--
-- The legacy column is not retired here: `sync_product_role_from_legacy_role`
-- still derives one from the other, and the supported paths write both. This
-- only widens what the audit notices, so the escape hatch the legitimate paths
-- use (`safetyhub.skip_role_audit`) keeps working unchanged and they stay
-- recorded as `role.changed` rather than `role.changed_directly`.
create or replace function private.audit_direct_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
      new.role is distinct from old.role
      or new.product_role is distinct from old.product_role
    )
    and coalesce(current_setting('safetyhub.skip_role_audit', true), '') <> '1' then
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id,
      before_data, after_data
    ) values (
      (select auth.uid()), new.user_id, 'role.changed_directly', 'user', new.user_id::text,
      jsonb_build_object('role', old.role, 'productRole', old.product_role),
      jsonb_build_object('role', new.role, 'productRole', new.product_role)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists user_roles_audit_direct_change on public.user_roles;
create trigger user_roles_audit_direct_change
after update of role, product_role on public.user_roles
for each row execute function private.audit_direct_role_change();
