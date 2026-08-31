-- PostgreSQL requires a DISTINCT aggregate's ORDER BY expression to match the
-- aggregate argument. Repair projects that already applied the original
-- organization cleanup migration; fresh installs already contain the fixed
-- `order by id` definitions and make this migration a no-op.
do $migration$
declare
  v_signature regprocedure;
  v_definition text;
  v_fixed_definition text;
begin
  foreach v_signature in array array[
    'public.preview_organization_merge(uuid[],uuid)'::regprocedure,
    'public.merge_organizations(uuid,uuid[],uuid,boolean,text)'::regprocedure
  ]
  loop
    v_definition := pg_get_functiondef(v_signature);
    v_fixed_definition := replace(
      v_definition,
      'array_agg(distinct id order by id::text)',
      'array_agg(distinct id order by id)'
    );

    if v_fixed_definition <> v_definition then
      execute v_fixed_definition;
    end if;
  end loop;
end;
$migration$;
