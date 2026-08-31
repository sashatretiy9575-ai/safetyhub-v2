-- Keep the account-management read model narrow. Verified identity, profile details,
-- activity timestamps and aggregate learning data belong to their dedicated screens.
create or replace function public.list_admin_users_page(
  p_limit integer default 25,
  p_query text default null,
  p_role public.app_role default null,
  p_status public.account_status default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('user.read');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_query text := nullif(private.normalized_lookup_key(p_query), '');
  v_can_inspect_capabilities boolean :=
    exists (
      select 1
      from public.user_roles actor_role
      where actor_role.user_id = v_actor_id
        and actor_role.role = 'superadmin'
    )
    and (
      private.actor_has_capability(v_actor_id, 'role.manage')
      or private.actor_has_capability(v_actor_id, 'user.delete')
    );
  v_items jsonb;
  v_total integer;
  v_more boolean;
  v_next jsonb;
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ADMIN_USERS_CURSOR';
  end if;

  with base_filtered as (
    select
      auth_user.id,
      auth_user.email::text as email,
      concat_ws(' ', nullif(profile.name, ''), nullif(profile.surname, '')) as label,
      profile.created_at,
      role.role,
      control.status as account_status,
      case
        when v_can_inspect_capabilities then private.capabilities_for_user(auth_user.id)
        else '{}'::text[]
      end as capabilities
    from auth.users auth_user
    join public.profiles profile on profile.id = auth_user.id
    join public.user_roles role on role.user_id = auth_user.id
    join public.account_controls control on control.user_id = auth_user.id
    where auth_user.deleted_at is null
      and (
        v_query is null
        or lower(auth_user.email::text) like '%' || v_query || '%'
        or private.normalized_lookup_key(profile.name || ' ' || profile.surname)
          like '%' || v_query || '%'
      )
      and (p_role is null or role.role = p_role)
      and (p_status is null or control.status = p_status)
  ), filtered as (
    select base_filtered.*
    from base_filtered
    where p_cursor_created_at is null
      or (base_filtered.created_at, base_filtered.id) < (p_cursor_created_at, p_cursor_id)
  ), ordered as (
    select filtered.*
    from filtered
    order by filtered.created_at desc, filtered.id desc
    limit v_limit + 1
  ), page as (
    select ordered.*
    from ordered
    order by ordered.created_at desc, ordered.id desc
    limit v_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', page.id,
          'email', page.email,
          'label', coalesce(nullif(page.label, ''), 'Без имени'),
          'role', page.role,
          'capabilities', page.capabilities,
          'status', page.account_status
        ) order by page.created_at desc, page.id desc
      ),
      '[]'::jsonb
    ),
    (select count(*) from base_filtered),
    (select count(*) > v_limit from ordered),
    (
      select jsonb_build_object('at', last.created_at, 'id', last.id)
      from page last
      order by last.created_at, last.id
      limit 1
    )
  into v_items, v_total, v_more, v_next
  from page;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'hasMore', v_more,
    'nextCursor', case when v_more then v_next else null end
  );
end;
$$;
