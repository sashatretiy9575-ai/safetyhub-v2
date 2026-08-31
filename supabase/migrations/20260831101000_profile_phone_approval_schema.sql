-- Approval is intentionally independent from account suspension. A pending
-- learner must remain active enough to accept legal documents, complete the
-- profile and use the private avatar state machine.

create type public.account_approval_state as enum (
  'profile_incomplete',
  'pending',
  'approved',
  'rejected'
);

alter table public.profiles
  add column phone_country_iso2 text,
  add column phone_e164 text,
  add constraint profiles_phone_pair
    check ((phone_country_iso2 is null) = (phone_e164 is null)),
  add constraint profiles_phone_country_iso2_shape
    check (phone_country_iso2 is null or phone_country_iso2 ~ '^[A-Z]{2}$'),
  add constraint profiles_phone_e164_shape
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{1,14}$');

-- Existing accounts are granted continuity when this forward-only migration is
-- applied to a non-empty project. The new-user trigger below explicitly gives
-- every subsequently created account the incomplete state.
alter table public.account_controls
  add column approval_state public.account_approval_state not null default 'approved',
  add column approval_requested_at timestamptz,
  add column approval_due_at timestamptz,
  add column approval_decided_at timestamptz,
  add column approval_decided_by uuid references auth.users(id) on delete set null,
  add column approval_rejection_reason text,
  add constraint account_controls_approval_reason_length
    check (
      approval_rejection_reason is null
      or (
        approval_rejection_reason = btrim(approval_rejection_reason)
        and char_length(approval_rejection_reason) between 3 and 500
        and approval_rejection_reason !~ '[[:cntrl:]]'
      )
    ),
  add constraint account_controls_approval_state_shape
    check (
      (
        approval_state = 'profile_incomplete'
        and approval_requested_at is null
        and approval_due_at is null
        and approval_decided_at is null
        and approval_decided_by is null
        and approval_rejection_reason is null
      )
      or (
        approval_state = 'pending'
        and approval_requested_at is not null
        and approval_due_at is not null
        and approval_due_at = approval_requested_at + interval '24 hours'
        and approval_decided_at is null
        and approval_decided_by is null
        and approval_rejection_reason is null
      )
      or (
        approval_state = 'approved'
        and approval_rejection_reason is null
        and (
          (
            approval_requested_at is null
            and approval_due_at is null
            and approval_decided_at is null
            and approval_decided_by is null
          )
          or (
            approval_requested_at is not null
            and approval_due_at is not null
            and approval_due_at = approval_requested_at + interval '24 hours'
            and approval_decided_at is not null
            and approval_decided_at >= approval_requested_at
          )
        )
      )
      or (
        approval_state = 'rejected'
        and approval_requested_at is not null
        and approval_due_at is not null
        and approval_due_at = approval_requested_at + interval '24 hours'
        and approval_decided_at is not null
        and approval_decided_at >= approval_requested_at
        and approval_rejection_reason is not null
      )
    );

create index account_controls_pending_approval_due_idx
  on public.account_controls (approval_due_at, user_id)
  where approval_state = 'pending';

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, surname, job)
  values (
    new.id,
    private.normalize_profile_text(new.raw_user_meta_data ->> 'name'),
    private.normalize_profile_text(new.raw_user_meta_data ->> 'surname'),
    private.normalize_profile_text(new.raw_user_meta_data ->> 'job')
  );
  insert into public.user_roles (user_id) values (new.id);
  insert into public.account_controls (user_id, approval_state)
  values (new.id, 'profile_incomplete');
  insert into public.verified_identities (user_id) values (new.id);
  return new;
end;
$$;

comment on column public.profiles.phone_country_iso2 is
  'User-selected ISO 3166-1 alpha-2 country for phone presentation; not an Auth/SMS identity.';
comment on column public.profiles.phone_e164 is
  'Normalized user contact number in E.164. Never expose it in public catalog or broad audit payloads.';
comment on column public.account_controls.approval_state is
  'Independent learner-access workflow. Never conflate with account_status suspension.';
comment on column public.account_controls.approval_due_at is
  '24-hour response SLA display deadline only; it never auto-approves an account.';
