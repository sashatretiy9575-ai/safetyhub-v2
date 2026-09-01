begin;

-- These checks intentionally use EXPLAIN rather than timing assertions. CI
-- runners are noisy, while an index-selected plan is deterministic and guards
-- the exact lookup shapes that must remain bounded on the Free Tier.
set local statement_timeout = '15s';
set local lock_timeout = '2s';
set local enable_seqscan = off;

create function pg_temp.explain_json(p_sql text)
returns jsonb
language plpgsql
as $$
declare
  v_plan jsonb;
begin
  execute 'explain (format json, costs off, verbose off) ' || p_sql into v_plan;
  return v_plan;
end;
$$;

create function pg_temp.assert_index_ready(
  p_index regclass,
  p_contract text
)
returns void
language plpgsql
as $$
declare
  v_ready boolean;
begin
  select index_state.indisvalid and index_state.indisready
  into v_ready
  from pg_catalog.pg_index index_state
  where index_state.indexrelid = p_index;

  if v_ready is distinct from true then
    raise exception 'performance contract %: index % is not valid and ready',
      p_contract, p_index;
  end if;
end;
$$;

create function pg_temp.assert_plan_uses_index(
  p_contract text,
  p_sql text,
  p_expected_indexes text[]
)
returns void
language plpgsql
as $$
declare
  v_plan jsonb := pg_temp.explain_json(p_sql);
  v_indexes text[];
begin
  with recursive plan_nodes(node) as (
    select v_plan -> 0 -> 'Plan'
    union all
    select child.node
    from plan_nodes parent
    cross join lateral jsonb_array_elements(
      coalesce(parent.node -> 'Plans', '[]'::jsonb)
    ) child(node)
  )
  select coalesce(
    array_agg(node ->> 'Index Name')
      filter (where node ->> 'Index Name' is not null),
    '{}'::text[]
  )
  into v_indexes
  from plan_nodes;

  if not (v_indexes && p_expected_indexes) then
    raise exception 'performance contract %: expected one of %, plan used %; plan=%',
      p_contract, p_expected_indexes, v_indexes, v_plan;
  end if;
end;
$$;

create function pg_temp.assert_function_matches(
  p_function regprocedure,
  p_contract text,
  p_patterns text[]
)
returns void
language plpgsql
as $$
declare
  v_definition text := lower(pg_catalog.pg_get_functiondef(p_function));
  v_pattern text;
begin
  foreach v_pattern in array p_patterns loop
    if v_definition !~ v_pattern then
      raise exception 'performance contract %: function % no longer matches %',
        p_contract, p_function, v_pattern;
    end if;
  end loop;
end;
$$;

do $test$
begin
  -- Locale reads: the catalog remains capped at 100 rows, while point reads
  -- and each locale/presentation join resolve through selective keys.
  perform pg_temp.assert_function_matches(
    'public.list_published_courses_locale(public.app_locale)'::regprocedure,
    'locale catalog RPC shape',
    array['localization[.]locale = p_locale', 'limit 100']
  );
  perform pg_temp.assert_function_matches(
    'public.get_published_course_locale(text,public.app_locale)'::regprocedure,
    'locale course RPC shape',
    array[
      'test[.]slug = p_slug',
      'localization[.]locale = p_locale',
      'mapping[.]locale = p_locale'
    ]
  );
  perform pg_temp.assert_index_ready(
    'public.tests_slug_key'::regclass,
    'locale course slug lookup'
  );
  perform pg_temp.assert_index_ready(
    'public.test_revision_localizations_pkey'::regclass,
    'locale revision lookup'
  );
  perform pg_temp.assert_index_ready(
    'public.test_revision_presentations_pkey'::regclass,
    'locale presentation lookup'
  );
  perform pg_temp.assert_plan_uses_index(
    'locale course slug lookup',
    $query$
      select test.id, test.current_revision_id
      from public.tests test
      where test.slug = 'pozharnaya-bezopasnost'
    $query$,
    array['tests_slug_key']
  );
  perform pg_temp.assert_plan_uses_index(
    'locale revision lookup',
    $query$
      select localization.title, localization.content
      from public.test_revision_localizations localization
      where localization.revision_id =
        '00000000-0000-4000-8000-000000000001'::uuid
        and localization.locale = 'zh'::public.app_locale
    $query$,
    array['test_revision_localizations_pkey']
  );
  perform pg_temp.assert_plan_uses_index(
    'locale presentation lookup',
    $query$
      select mapping.presentation_id
      from public.test_revision_presentations mapping
      where mapping.revision_id =
        '00000000-0000-4000-8000-000000000001'::uuid
        and mapping.locale = 'zh'::public.app_locale
    $query$,
    array['test_revision_presentations_pkey']
  );

  -- Admin inbox keyset pagination must not degrade into an offset/full-table
  -- path as retained events approach the 90-day bound.
  perform pg_temp.assert_function_matches(
    'public.list_admin_notification_inbox(integer,timestamptz,uuid)'::regprocedure,
    'admin inbox keyset shape',
    array[
      '[(]event[.]occurred_at, event[.]id[)] <',
      'order by event[.]occurred_at desc, event[.]id desc',
      'limit p_limit'
    ]
  );
  perform pg_temp.assert_index_ready(
    'private.notification_events_inbox_idx'::regclass,
    'admin inbox keyset pagination'
  );
  perform pg_temp.assert_plan_uses_index(
    'admin inbox keyset pagination',
    $query$
      select event.id, event.event_type, event.occurred_at
      from private.notification_events event
      where (event.occurred_at, event.id) < (
        '2099-01-01T00:00:00Z'::timestamptz,
        'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid
      )
      order by event.occurred_at desc, event.id desc
      limit 50
    $query$,
    array['notification_events_inbox_idx']
  );

  -- Delivery workers rely on one partial ordered index for due rows. EXPLAIN
  -- the same OR predicate and lock discipline used by the claim RPC.
  perform pg_temp.assert_function_matches(
    'private.claim_notification_deliveries_unmetered(uuid,integer,integer)'::regprocedure,
    'notification delivery claim shape',
    array[
      'order by delivery[.]next_attempt_at, delivery[.]id',
      'for update skip locked',
      'delivery[.]attempts < 10'
    ]
  );
  perform pg_temp.assert_index_ready(
    'private.notification_deliveries_claim_idx'::regclass,
    'notification delivery claim'
  );
  perform pg_temp.assert_plan_uses_index(
    'notification delivery claim',
    $query$
      select delivery.id
      from private.notification_deliveries delivery
      where delivery.attempts < 10
        and (
          (
            delivery.status in ('pending', 'retry')
            and delivery.next_attempt_at <= statement_timestamp()
          )
          or (
            delivery.status = 'leased'
            and delivery.lease_expires_at <= statement_timestamp()
          )
        )
      order by delivery.next_attempt_at, delivery.id
      limit 50
      for update skip locked
    $query$,
    array['notification_deliveries_claim_idx']
  );

  -- Username-less assertions select a single opaque credential id. The active
  -- state check must remain a filter on the primary-key lookup, never a scan.
  perform pg_temp.assert_function_matches(
    'public.get_zh_authentication_context(uuid,text)'::regprocedure,
    'ZH credential lookup shape',
    array[
      'credential[.]credential_id = p_credential_id',
      'credential[.]state = ''active''',
      'challenge[.]id = p_request_id'
    ]
  );
  perform pg_temp.assert_index_ready(
    'private.zh_webauthn_credentials_pkey'::regclass,
    'ZH credential lookup'
  );
  perform pg_temp.assert_plan_uses_index(
    'ZH credential lookup',
    $query$
      select credential.user_id, credential.public_key,
        credential.signature_counter
      from private.zh_webauthn_credentials credential
      where credential.credential_id = repeat('a', 43)
        and credential.state = 'active'
    $query$,
    array['zh_webauthn_credentials_pkey']
  );

  -- Presentation relay capacity uses both expiry cleanup and actor-scoped
  -- counts/minimum expiry. The table is globally capped at twelve live rows,
  -- but both selective paths still have explicit indexes.
  perform pg_temp.assert_function_matches(
    'public.claim_course_presentation_download_lease(uuid,integer)'::regprocedure,
    'presentation lease lookup shape',
    array[
      'lease[.]expires_at <= statement_timestamp[(][)]',
      'lease[.]actor_id = p_actor_id',
      'select count[(][*][)]::integer into v_global_count'
    ]
  );
  perform pg_temp.assert_index_ready(
    'private.course_presentation_download_leases_actor_expires_idx'::regclass,
    'presentation actor lease lookup'
  );
  perform pg_temp.assert_index_ready(
    'private.course_presentation_download_leases_expires_idx'::regclass,
    'presentation expired lease lookup'
  );
  perform pg_temp.assert_plan_uses_index(
    'presentation actor lease lookup',
    $query$
      select count(*)
      from private.course_presentation_download_leases lease
      where lease.actor_id = '00000000-0000-4000-8000-000000000001'::uuid
    $query$,
    array['course_presentation_download_leases_actor_expires_idx']
  );
  perform pg_temp.assert_plan_uses_index(
    'presentation expired lease lookup',
    $query$
      select lease.id
      from private.course_presentation_download_leases lease
      where lease.expires_at <= statement_timestamp()
      order by lease.expires_at
    $query$,
    array['course_presentation_download_leases_expires_idx']
  );
end;
$test$;

rollback;
