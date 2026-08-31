-- Publish new immutable copies after the passwordless-authentication and
-- manual-account-approval release. Existing acceptances keep their original
-- foreign-keyed versions; only the two new copies become current.
--
-- Do not replace these rows or change their bodies. A later material change
-- must add another forward-only migration and a matching rendered component.

do $$
begin
  perform public.publish_legal_document_version(
    'privacy',
    '1.2',
    'privacy-1.2',
    timestamptz '2026-08-31 00:00:00+00'
  );

  perform public.publish_legal_document_version(
    'terms',
    '2.2',
    'terms-2.2',
    timestamptz '2026-08-31 00:00:00+00'
  );
end;
$$;

comment on table public.legal_document_versions is
  'Immutable published legal copies. Current passwordless/manual-approval copies: privacy 1.2 and terms 2.2.';
