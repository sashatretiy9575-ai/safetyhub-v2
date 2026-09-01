export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type AppRole = 'participant' | 'admin';
export type AccountStatus = 'active' | 'suspended';
export type ArticleStatus = 'draft' | 'published';
export type TestStatus = 'draft' | 'published';
export type AttemptStatus = 'started' | 'passed' | 'failed' | 'expired';
export type CoursePresentationStatus = 'staging' | 'validating' | 'ready' | 'rejected' | 'retired';
export type IdentityVerificationStatus = 'unverified' | 'verified' | 'revoked';
export type CertificateIssueSource = 'manual' | 'score_improvement' | 'identity_correction';
export type LegalDocumentType = 'privacy' | 'terms';
export type LegalAcceptanceSource = 'registration' | 'profile';
export type AppLocale = 'ru' | 'kk' | 'en' | 'zh';
export type AccountApprovalState = 'profile_incomplete' | 'pending' | 'approved' | 'rejected';

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};
export type ProfileRow = {
  id: string;
  name: string;
  surname: string;
  job: string;
  organization: string;
  organization_id: string | null;
  phone_country_iso2: string | null;
  phone_e164: string | null;
  preferred_locale: AppLocale;
  avatar_updated_at: string | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AuthContextRpcRow = {
  user_id: string;
  email: string | null;
  profile_id: string;
  profile_name: string;
  profile_surname: string;
  profile_job: string;
  profile_organization: string;
  profile_phone_country_iso2: string | null;
  profile_phone_e164: string | null;
  profile_preferred_locale: AppLocale;
  profile_avatar_updated_at: string | null;
  profile_onboarding_completed_at: string | null;
  profile_identity_state: 'pending' | 'verified' | 'changed' | 'revoked';
  profile_created_at: string;
  profile_updated_at: string;
  role: AppRole;
  status: AccountStatus;
  deletion_pending: boolean;
  approval_state: AccountApprovalState;
  approval_requested_at: string | null;
  approval_due_at: string | null;
  approval_decided_at: string | null;
  approval_rejection_reason: string | null;
  capabilities: string[];
  has_current_legal_acceptance: boolean;
};

export type ArticleRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  cover_image: string;
  blocks: Json;
  seo: Json;
  current_revision_id: string | null;
  content_version: number;
  status: ArticleStatus;
  is_published: boolean;
  published_at: string | null;
  jurisdiction: string | null;
  effective_date: string | null;
  sources: Json;
  content_hash: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TestRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  icon: string;
  display_order: number;
  seo: Json;
  draft_content: Json;
  current_revision_id: string | null;
  content_version: number;
  duration_minutes: number;
  pass_score: number;
  attempts_per_calendar_day: number;
  attempt_reset_timezone: string;
  status: TestStatus;
  jurisdiction: string | null;
  effective_date: string | null;
  sources: Json;
  content_hash: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TestRevisionRow = {
  id: string;
  test_id: string;
  version: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  display_order: number;
  presentation_id: string | null;
  content: Json;
  seo: Json;
  content_hash: string;
  jurisdiction: string | null;
  effective_date: string | null;
  sources: Json;
  questions: Json;
  question_count: number;
  duration_minutes: number;
  pass_score: number;
  attempts_per_calendar_day: number;
  attempt_reset_timezone: string;
  published_at: string;
  published_by: string | null;
};

export type CourseDraftRow = {
  test_id: string;
  slug: string;
  title: string;
  description: string;
  icon: string;
  display_order: number;
  presentation_id: string | null;
  duration_minutes: number;
  pass_score: number;
  attempts_per_calendar_day: number;
  attempt_reset_timezone: string;
  content: Json;
  questions: Json;
  question_variants: Json;
  seo: Json;
  jurisdiction: string | null;
  effective_date: string | null;
  sources: Json;
  content_hash: string;
  draft_version: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ArticleDraftRow = Omit<
  ArticleRow,
  | 'id'
  | 'status'
  | 'is_published'
  | 'published_at'
  | 'current_revision_id'
  | 'content_version'
  | 'created_by'
> & {
  article_id: string;
  draft_version: number;
};

export type ContentAssetRow = {
  id: string;
  storage_key: string;
  mime_type: 'image/webp';
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  original_filename: string;
  status: 'active' | 'orphan_candidate' | 'delete_pending';
  created_by: string | null;
  created_at: string;
  last_referenced_at: string | null;
};

export type AttemptRow = {
  id: string;
  user_id: string;
  test_id: string;
  revision_id: string;
  variant_id: string;
  duration_minutes: number;
  pass_score: number;
  attempts_per_day: number;
  reset_timezone: string;
  locale: AppLocale;
  status: AttemptStatus;
  answers: number[] | null;
  score: number | null;
  started_at: string;
  expires_at: string;
  completed_at: string | null;
};

export type CoursePresentationRow = {
  id: string;
  course_id: string | null;
  locale: AppLocale;
  storage_bucket: 'course-presentations-staging' | 'course-presentations';
  storage_path: string;
  thumbnail_path: string | null;
  source_filename: string;
  mime_type: 'application/pdf';
  byte_size: number;
  sha256: string;
  page_count: number;
  aspect_ratio: '16:9';
  status: CoursePresentationStatus;
  validation_error: string | null;
  created_by: string | null;
  created_at: string;
  validated_at: string | null;
  retired_at: string | null;
  cleanup_claimed_at: string | null;
};

export type TestRevisionVariantRow = {
  id: string;
  stable_id: string;
  revision_id: string;
  variant_number: number;
  questions: Json;
  question_count: number;
  created_at: string;
};

export type AttestationRow = {
  id: string;
  user_id: string;
  revision_id: string;
  best_attempt_id: string;
  best_score: number;
  best_completed_at: string;
  updated_at: string;
};

export type CertificateRow = {
  id: string;
  certificate_number: string;
  user_id: string;
  revision_id: string | null;
  attestation_id: string | null;
  attempt_id: string | null;
  identity_version: number;
  full_name: string;
  job: string;
  organization: string;
  test_slug: string;
  test_title: string;
  localized_test_title: string;
  locale: AppLocale;
  score: number;
  total: number;
  pass_score: number;
  best_completed_at: string;
  issued_at: string;
  issued_by: string | null;
  issue_source: CertificateIssueSource;
  supersedes_certificate_id: string | null;
  template_version: number;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  course_deleted_at: string | null;
};

export type LegalAcceptanceRow = {
  user_id: string;
  document_type: LegalDocumentType;
  version: string;
  accepted_at: string;
  source: LegalAcceptanceSource;
};

export type DraftLocalizationRow = {
  locale: AppLocale;
  title: string;
  description: string;
  content_hash: string;
  reviewed_content_hash: string | null;
  translation_qa: Json;
  status: 'missing' | 'draft' | 'complete';
  draft_version: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RevisionLocalizationRow = {
  revision_id: string;
  locale: AppLocale;
  title: string;
  description: string;
  content_hash: string;
  translation_qa: Json;
  published_at: string;
  published_by: string | null;
};

type JsonRpc = { Args: Record<string, unknown>; Returns: Json };

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow>;
      organizations: Table<{
        id: string;
        canonical_name: string;
        normalized_key: string;
        active: boolean;
        created_at: string;
        updated_at: string;
      }>;
      organization_aliases: Table<{
        id: string;
        organization_id: string;
        alias: string;
        normalized_key: string;
        created_at: string;
      }>;
      user_roles: Table<{
        user_id: string;
        role: 'user' | 'admin' | 'superadmin';
        product_role: AppRole;
        created_by: string | null;
        created_at: string;
        updated_at: string;
      }>;
      account_controls: Table<{
        user_id: string;
        status: AccountStatus;
        deletion_pending: boolean;
        approval_state: AccountApprovalState;
        approval_requested_at: string | null;
        approval_due_at: string | null;
        approval_decided_at: string | null;
        approval_decided_by: string | null;
        approval_rejection_reason: string | null;
        suspended_at: string | null;
        suspended_by: string | null;
        suspension_reason: string | null;
        updated_at: string;
      }>;
      admin_capability_catalog: Table<{
        capability: string;
        category: string;
        label: string;
        admin_default: boolean;
        sensitive: boolean;
      }>;
      user_capabilities: Table<{
        user_id: string;
        capability: string;
        granted_by: string | null;
        created_at: string;
      }>;
      verified_identities: Table<{
        user_id: string;
        status: IdentityVerificationStatus;
        version: number;
        name: string;
        surname: string;
        job: string;
        organization: string;
        verified_at: string | null;
        verified_by: string | null;
        revoked_at: string | null;
        revoked_by: string | null;
        revoke_reason: string | null;
      }>;
      articles: Table<ArticleRow>;
      article_drafts: Table<ArticleDraftRow>;
      article_draft_localizations: Table<
        DraftLocalizationRow & {
          article_id: string;
          blocks: Json;
          seo: Json;
          sources: Json;
        }
      >;
      article_revisions: Table<{
        id: string;
        article_id: string;
        version: number;
        slug: string;
        title: string;
        description: string;
        cover_image: string;
        blocks: Json;
        seo: Json;
        jurisdiction: string | null;
        effective_date: string | null;
        sources: Json;
        content_hash: string;
        published_at: string;
        published_by: string | null;
      }>;
      article_revision_localizations: Table<
        RevisionLocalizationRow & {
          blocks: Json;
          seo: Json;
          sources: Json;
        }
      >;
      article_slug_redirects: Table<{ old_slug: string; article_id: string; created_at: string }>;
      tests: Table<TestRow>;
      course_drafts: Table<CourseDraftRow>;
      course_draft_localizations: Table<
        DraftLocalizationRow & {
          test_id: string;
          content: Json;
          question_variants: Json;
          seo: Json;
          sources: Json;
        }
      >;
      course_draft_presentations: Table<{
        test_id: string;
        locale: AppLocale;
        presentation_id: string;
      }>;
      course_slug_redirects: Table<{ old_slug: string; test_id: string; created_at: string }>;
      test_revisions: Table<TestRevisionRow>;
      test_revision_localizations: Table<
        RevisionLocalizationRow & {
          content: Json;
          seo: Json;
          sources: Json;
        }
      >;
      test_revision_variants: Table<TestRevisionVariantRow>;
      test_revision_variant_localizations: Table<{
        revision_id: string;
        variant_id: string;
        locale: AppLocale;
        questions: Json;
        explanations: Json;
        question_count: number;
        structure_hash: string;
        content_hash: string;
        created_at: string;
      }>;
      test_revision_presentations: Table<{
        revision_id: string;
        locale: AppLocale;
        presentation_id: string;
        created_at: string;
      }>;
      course_presentations: Table<CoursePresentationRow>;
      course_catalog_batches: Table<{
        id: string;
        status: 'staging' | 'activated' | 'cancelled';
        created_by: string | null;
        activation_idempotency_key: string | null;
        result: Json | null;
        created_at: string;
        activated_at: string | null;
      }>;
      course_catalog_batch_items: Table<{
        batch_id: string;
        test_id: string;
        display_order: number;
        expected_content_hash: string;
      }>;
      content_assets: Table<ContentAssetRow>;
      content_asset_usages: Table<{
        asset_id: string;
        owner_type: 'course_draft' | 'course_revision' | 'article_draft' | 'article_revision';
        owner_id: string;
        owner_version: number;
        usage_key: string;
        created_at: string;
      }>;
      test_attempts: Table<AttemptRow>;
      attestations: Table<AttestationRow>;
      certificates: Table<CertificateRow>;
      legal_document_versions: Table<{
        document_type: LegalDocumentType;
        version: string;
        body_revision: string;
        effective_at: string;
        is_current: boolean;
        created_at: string;
      }>;
      legal_document_localizations: Table<{
        document_type: LegalDocumentType;
        version: string;
        locale: AppLocale;
        title: string;
        body: Json;
        body_hash: string;
        status: 'draft' | 'complete' | 'published';
        published_at: string | null;
        published_by: string | null;
        created_at: string;
        updated_at: string;
      }>;
      legal_acceptances: Table<LegalAcceptanceRow>;
      site_settings: Table<{
        singleton: boolean;
        phone_e164: string;
        phone_display: string;
        whatsapp_e164: string;
        whatsapp_same_as_phone: boolean;
        version: number;
        updated_at: string;
        updated_by: string | null;
      }>;
      admin_audit_log: Table<{
        id: number;
        actor_user_id: string | null;
        target_user_id: string | null;
        action: string;
        target_type: string;
        target_id: string | null;
        before_data: Json | null;
        after_data: Json | null;
        reason: string | null;
        batch_id: string | null;
        correlation_id: string;
        request_id: string | null;
        ip_hash: string | null;
        user_agent: string | null;
        created_at: string;
      }>;
    };
    Views: Record<never, never>;
    Functions: {
      get_my_capabilities: { Args: Record<PropertyKey, never>; Returns: string[] };
      get_auth_context: { Args: Record<PropertyKey, never>; Returns: AuthContextRpcRow[] };
      complete_zh_username_registration: {
        Args: {
          p_user_id: string;
          p_username: string;
          p_synthetic_email: string;
          p_privacy_version: string;
          p_privacy_body_revision: string;
          p_terms_version: string;
          p_terms_body_revision: string;
        };
        Returns: Json;
      };
      get_zh_username_login_mapping: { Args: { p_username: string }; Returns: Json | null };
      get_zh_username_password_rollout_enabled: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      get_zh_username_provision_target: {
        Args: { p_user_id: string };
        Returns: Json | null;
      };
      provision_zh_username_password: {
        Args: { p_target_user_id: string; p_username: string; p_reason: string };
        Returns: Json;
      };
      begin_zh_username_password_reset: {
        Args: { p_target_user_id: string; p_reason: string };
        Returns: Json;
      };
      complete_zh_username_password_reset: {
        Args: { p_target_user_id: string; p_reason: string };
        Returns: Json;
      };
      prune_zh_username_authorized_sessions: {
        Args: { p_limit?: number };
        Returns: Json;
      };
      set_preferred_locale: { Args: { p_locale: AppLocale }; Returns: Json };
      update_profile: {
        Args: { p_name: string; p_surname: string; p_job: string; p_organization: string };
        Returns: Json;
      };
      complete_profile_onboarding: {
        Args: { p_name: string; p_surname: string; p_job: string; p_organization: string };
        Returns: Json;
      };
      begin_profile_avatar_upload: {
        Args: { p_user_id: string; p_expected_sha256: string; p_expected_bytes: number };
        Returns: Json;
      };
      finish_profile_avatar_storage_write: {
        Args: { p_user_id: string; p_operation_token: string; p_error_code?: string | null };
        Returns: Json;
      };
      mark_profile_avatar_staged: {
        Args: {
          p_user_id: string;
          p_operation_token: string;
          p_observed_sha256: string;
          p_observed_bytes: number;
        };
        Returns: Json;
      };
      finalize_profile_avatar_upload: {
        Args: { p_user_id: string; p_operation_token: string };
        Returns: Json;
      };
      abort_profile_avatar_upload: {
        Args: { p_user_id: string; p_operation_token: string; p_error_code?: string | null };
        Returns: Json;
      };
      get_profile_avatar_upload_operation: {
        Args: { p_user_id: string; p_operation_token: string };
        Returns: Json;
      };
      get_profile_avatar_manifest: { Args: { p_user_id: string }; Returns: Json };
      get_my_profile_avatar_manifest: { Args: Record<PropertyKey, never>; Returns: Json };
      claim_profile_avatar_reconciliation: {
        Args: { p_worker_id: string; p_limit?: number };
        Returns: Json;
      };
      claim_course_presentation_download_lease: {
        Args: { p_actor_id: string; p_lease_seconds?: number };
        Returns: Json;
      };
      complete_profile_avatar_reconciliation: {
        Args: {
          p_operation_token: string;
          p_worker_id: string;
          p_outcome: string;
          p_error_code?: string | null;
        };
        Returns: Json;
      };
      prune_terminal_avatar_upload_operations: { Args: { p_limit?: number }; Returns: Json };
      issue_email_otp_challenge: {
        Args: {
          p_challenge_hash: string;
          p_email_hash: string;
          p_expires_in_seconds?: number;
        };
        Returns: Json;
      };
      consume_email_otp_challenge_attempt: {
        Args: { p_challenge_hash: string; p_email_hash: string };
        Returns: Json;
      };
      complete_email_otp_challenge: {
        Args: { p_challenge_hash: string; p_email_hash: string };
        Returns: boolean;
      };
      prune_email_otp_challenges: { Args: { p_limit?: number }; Returns: Json };
      release_course_presentation_download_lease: {
        Args: { p_actor_id: string; p_lease_id: string };
        Returns: boolean;
      };
      search_profile_organizations: {
        Args: { p_query: string; p_limit?: number };
        Returns: string[];
      };
      prepare_signup_legal_operation: {
        Args: {
          p_operation_id: string;
          p_nonce_sha256: string;
          p_email: string;
          p_privacy_version: string;
          p_privacy_body_revision: string;
          p_terms_version: string;
          p_terms_body_revision: string;
        };
        Returns: Json;
      };
      finalize_signup_legal_operation: {
        Args: { p_operation_id: string; p_user_id: string; p_signup_nonce: string };
        Returns: Json;
      };
      prune_signup_legal_operations: { Args: { p_limit?: number }; Returns: Json };
      publish_legal_document_version: {
        Args: {
          p_document_type: LegalDocumentType;
          p_version: string;
          p_body_revision: string;
          p_effective_at: string;
        };
        Returns: Json;
      };
      get_legal_document_localization: {
        Args: {
          p_document_type: LegalDocumentType;
          p_version: string | null;
          p_locale: AppLocale;
        };
        Returns: Json;
      };
      save_legal_document_localization: JsonRpc;
      stage_legal_document_version: JsonRpc;
      publish_legal_document_localizations: JsonRpc;
      accept_current_legal_documents: {
        Args: {
          p_privacy_version: string;
          p_privacy_body_revision: string;
          p_terms_version: string;
          p_terms_body_revision: string;
        };
        Returns: Json;
      };
      save_article_localization_draft: JsonRpc;
      publish_article_revision_v3: JsonRpc;
      get_article_editor_localizations: JsonRpc;
      list_published_articles_locale: JsonRpc;
      get_published_article_locale: {
        Args: { p_slug: string; p_locale: AppLocale };
        Returns: Json;
      };
      save_article_draft: JsonRpc;
      save_article_draft_v2: JsonRpc;
      save_and_publish_article_v2: JsonRpc;
      set_article_status: {
        Args: {
          p_article_id: string;
          p_status: ArticleStatus;
          p_expected_content_hash?: string | null;
        };
        Returns: Json;
      };
      set_article_status_v2: JsonRpc;
      delete_article: JsonRpc;
      resolve_article_slug: { Args: { p_old_slug: string }; Returns: string | null };
      save_course_localization_draft: JsonRpc;
      import_course_assessment_localization: JsonRpc;
      publish_course_revision_v4: JsonRpc;
      get_course_editor_localizations: JsonRpc;
      get_published_course_locale: {
        Args: { p_slug: string; p_locale: AppLocale };
        Returns: Json;
      };
      get_approved_course_presentation_locale: {
        Args: { p_course_slug: string; p_asset: string; p_locale: AppLocale };
        Returns: {
          presentation_id: string;
          content_type: string;
          byte_size: number | null;
        }[];
      };
      save_course_draft: JsonRpc;
      save_course_draft_v2: JsonRpc;
      save_and_publish_course_v2: JsonRpc;
      save_course_draft_v3: {
        Args: {
          p_actor_id: string;
          p_test_id: string | null;
          p_expected_version: number | null;
          p_slug: string;
          p_title: string;
          p_description: string;
          p_icon: string;
          p_display_order: number;
          p_presentation_id: string | null;
          p_duration_minutes: number;
          p_pass_score: number;
          p_attempts_per_calendar_day: number;
          p_attempt_reset_timezone: string;
          p_question_variants: Json;
          p_seo: Json;
          p_content_metadata?: Json;
        };
        Returns: Json;
      };
      save_and_publish_course_v3: {
        Args: {
          p_actor_id: string;
          p_test_id: string | null;
          p_expected_version: number | null;
          p_slug: string;
          p_title: string;
          p_description: string;
          p_icon: string;
          p_display_order: number;
          p_presentation_id: string | null;
          p_duration_minutes: number;
          p_pass_score: number;
          p_attempts_per_calendar_day: number;
          p_attempt_reset_timezone: string;
          p_question_variants: Json;
          p_seo: Json;
          p_content_metadata?: Json;
        };
        Returns: Json;
      };
      change_course_slug: JsonRpc;
      publish_course_revision: JsonRpc;
      publish_course_revision_v2: JsonRpc;
      publish_course_revision_v3: {
        Args: { p_actor_id: string; p_test_id: string; p_expected_content_hash: string };
        Returns: Json;
      };
      get_test_editor_payload: { Args: { p_actor_id: string; p_test_id: string }; Returns: Json };
      get_test_editor_payload_v2: {
        Args: { p_actor_id: string; p_test_id: string };
        Returns: Json;
      };
      get_course_editor_payload_v3: {
        Args: { p_actor_id: string; p_test_id: string };
        Returns: Json;
      };
      get_published_course_snapshot_v3: {
        Args: { p_test_id: string };
        Returns: Json;
      };
      set_test_status: {
        Args: { p_actor_id: string; p_test_id: string; p_status: TestStatus };
        Returns: Json;
      };
      resolve_course_slug: { Args: { p_old_slug: string }; Returns: string | null };
      delete_course: JsonRpc;
      mark_content_asset_orphan: JsonRpc;
      delete_verified_orphan_asset: JsonRpc;
      start_test_attempt: { Args: { p_test_slug: string }; Returns: Json };
      start_test_attempt_locale: {
        Args: { p_test_slug: string; p_locale: AppLocale };
        Returns: Json;
      };
      resume_test_attempt: { Args: { p_test_slug: string }; Returns: Json };
      get_test_attempt: { Args: { p_attempt_id: string }; Returns: Json };
      complete_test_attempt: { Args: { p_attempt_id: string; p_answers: Json }; Returns: Json };
      get_profile_attestations: { Args: Record<PropertyKey, never>; Returns: Json };
      get_profile_dashboard: { Args: Record<PropertyKey, never>; Returns: Json };
      list_admin_attestations_page: JsonRpc;
      get_admin_attestation_filters: { Args: Record<PropertyKey, never>; Returns: Json };
      get_admin_work_queue: { Args: Record<PropertyKey, never>; Returns: Json };
      get_admin_learning_history: {
        Args: { p_actor_id: string; p_target_user_id: string };
        Returns: Json;
      };
      list_learning_history_targets_page: {
        Args: {
          p_actor_id: string;
          p_limit?: number;
          p_query?: string | null;
          p_cursor_created_at?: string | null;
          p_cursor_id?: string | null;
        };
        Returns: Json;
      };
      delete_admin_learning_history: {
        Args: {
          p_actor_id: string;
          p_target_user_id: string;
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      prune_learning_history_delete_receipts: {
        Args: { p_limit?: number };
        Returns: number;
      };
      prepare_course_catalog_batch: {
        Args: { p_actor_id: string; p_test_ids: string[] };
        Returns: Json;
      };
      activate_course_catalog_batch: {
        Args: { p_actor_id: string; p_batch_id: string; p_idempotency_key: string };
        Returns: Json;
      };
      begin_initial_course_import: {
        Args: {
          p_actor_id: string;
          p_project_ref: string;
          p_catalog_hash: string;
          p_confirmation: string;
        };
        Returns: Json;
      };
      stage_initial_course_import: {
        Args: { p_operation_id: string; p_catalog_hash: string; p_payload: Json };
        Returns: Json;
      };
      prepare_initial_course_import: {
        Args: { p_operation_id: string; p_catalog_hash: string };
        Returns: Json;
      };
      activate_initial_course_import: {
        Args: { p_operation_id: string; p_catalog_hash: string; p_idempotency_key: string };
        Returns: Json;
      };
      complete_initial_course_import: {
        Args: { p_operation_id: string; p_catalog_hash: string };
        Returns: Json;
      };
      get_course_catalog_maintenance: {
        Args: { p_actor_id: string };
        Returns: Json;
      };
      set_course_catalog_maintenance: {
        Args: { p_actor_id: string; p_enabled: boolean };
        Returns: Json;
      };
      finalize_course_presentation_metadata: {
        Args: {
          p_actor_id: string;
          p_course_id: string;
          p_presentation_id: string;
          p_expected_sha256: string;
          p_expected_page_count: number;
          p_expected_byte_size: number;
          p_expected_staging_pdf_path: string;
          p_expected_staging_thumbnail_path: string;
        };
        Returns: Json;
      };
      retire_course_presentation: {
        Args: {
          p_actor_id: string;
          p_course_id: string;
          p_presentation_id: string;
        };
        Returns: Json;
      };
      claim_stale_course_presentations: {
        Args: { p_limit?: number; p_ttl_hours?: number; p_lease_minutes?: number };
        Returns: Json;
      };
      complete_course_presentation_cleanup: {
        Args: { p_presentation_ids: string[] };
        Returns: Json;
      };
      get_admin_attestation_by_certificate_number: {
        Args: { p_query: string };
        Returns: Json;
      };
      resolve_admin_attestation_selection: JsonRpc;
      get_user_identity: { Args: { p_target_id?: string | null }; Returns: Json };
      verify_user_identity: JsonRpc;
      revoke_user_identity: JsonRpc;
      confirm_admin_identities: { Args: { p_user_ids: string[] }; Returns: Json };
      bulk_update_participants: {
        Args: { p_user_ids: string[]; p_field: string; p_value: string };
        Returns: Json;
      };
      issue_certificates: { Args: { p_attestation_ids: string[] }; Returns: Json };
      revoke_certificates: {
        Args: { p_certificate_ids: string[]; p_reason: string };
        Returns: Json;
      };
      revoke_certificate: { Args: { p_certificate_id: string; p_reason: string }; Returns: Json };
      execute_admin_attestation_action: {
        Args: {
          p_idempotency_key: string;
          p_action: string;
          p_target_ids: string[];
          p_field?: string | null;
          p_value?: string | null;
          p_reason?: string | null;
        };
        Returns: Json;
      };
      get_certificate_download_payload: { Args: { p_certificate_id: string }; Returns: Json };
      get_public_certificate: { Args: { p_certificate_id: string }; Returns: Json };
      resolve_certificate_export: { Args: { p_attestation_ids: string[] }; Returns: Json };
      create_certificate_export_job: {
        Args: { p_attestation_ids: string[] };
        Returns: Json;
      };
      get_certificate_export_job: { Args: { p_job_id: string }; Returns: Json };
      resolve_certificate_export_job: { Args: { p_job_id: string }; Returns: Json };
      prune_certificate_export_jobs: { Args: { p_limit?: number }; Returns: number };
      list_admin_notification_inbox: JsonRpc;
      mark_admin_notifications_read: { Args: { p_event_ids: string[] }; Returns: Json };
      retry_admin_notification_delivery: { Args: { p_event_id: string }; Returns: Json };
      emit_system_notification_alert: JsonRpc;
      claim_notification_deliveries: JsonRpc;
      complete_notification_delivery: JsonRpc;
      fail_notification_delivery: JsonRpc;
      prune_notification_data: JsonRpc;
      set_runtime_feature_flag: JsonRpc;
      configure_notification_dispatch_vault: {
        Args: {
          p_dispatch_url: string;
          p_dispatch_secret: string;
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      list_organization_cleanup_clusters: { Args: { p_limit?: number }; Returns: Json };
      preview_organization_merge: {
        Args: { p_source_ids: string[]; p_target_id: string };
        Returns: Json;
      };
      merge_organizations: {
        Args: {
          p_idempotency_key: string;
          p_source_ids: string[];
          p_target_id: string;
          p_reissue_certificates: boolean;
          p_reason: string;
        };
        Returns: Json;
      };
      get_site_settings: { Args: Record<PropertyKey, never>; Returns: Json };
      update_site_settings: {
        Args: {
          p_phone_e164: string;
          p_phone_display: string;
          p_whatsapp_e164: string;
          p_whatsapp_same_as_phone: boolean;
          p_expected_version: number;
        };
        Returns: Json;
      };
      get_capacity_metrics: { Args: Record<PropertyKey, never>; Returns: Json };
      collect_capacity_monitor_snapshot: {
        Args: { p_force?: boolean };
        Returns: Json;
      };
      set_capacity_monitor_monthly_active_learner_budget: {
        Args: {
          p_monthly_active_learner_limit: number;
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      consume_business_quota_for_actor: {
        Args: { p_actor_id: string; p_action: string };
        Returns: Json;
      };
      consume_coarse_ip_quota: { Args: { p_action: string; p_ip_hash: string }; Returns: Json };
      prune_coarse_ip_rate_limits: { Args: { p_limit?: number }; Returns: Json };
      profile_avatar_storage_write_is_authorized: {
        Args: { p_object_name: string };
        Returns: boolean;
      };
      prepare_user_invite: {
        Args: {
          p_email: string;
          p_name: string;
          p_surname: string;
          p_job: string;
          p_requested_role: AppRole;
          p_password_ticket: string;
          p_redirect_origin: string;
          p_correlation_id: string;
          p_request_id?: string | null;
          p_ip_hash?: string | null;
          p_user_agent?: string | null;
        };
        Returns: Json;
      };
      request_account_suspension_confirmed: {
        Args: {
          p_target_id: string;
          p_suspended: boolean;
          p_reason: string;
          p_correlation_id: string;
          p_request_id?: string | null;
          p_ip_hash?: string | null;
          p_user_agent?: string | null;
        };
        Returns: Json;
      };
      advance_auth_admin_operation: {
        Args: {
          p_operation_id: string;
          p_completion_token: string;
          p_state: string;
          p_external_target_id?: string | null;
          p_error?: string | null;
        };
        Returns: Json;
      };
      claim_auth_admin_operation_confirmed: {
        Args: {
          p_operation_id: string;
          p_reason: string;
          p_correlation_id: string;
          p_request_id?: string | null;
          p_ip_hash?: string | null;
          p_user_agent?: string | null;
        };
        Returns: Json;
      };
      manage_user_role_confirmed: {
        Args: {
          p_target_id: string;
          p_role: AppRole;
          p_reason: string;
          p_correlation_id: string;
          p_request_id?: string | null;
          p_ip_hash?: string | null;
          p_user_agent?: string | null;
        };
        Returns: Json;
      };
      set_user_capabilities_confirmed: {
        Args: {
          p_target_id: string;
          p_capabilities: string[];
          p_reason: string;
          p_correlation_id: string;
          p_request_id?: string | null;
          p_ip_hash?: string | null;
          p_user_agent?: string | null;
        };
        Returns: Json;
      };
      prune_terminal_auth_admin_outbox: { Args: { p_limit?: number }; Returns: Json };
      bootstrap_email_otp_admin: { Args: { p_user_id: string }; Returns: string };
      bootstrap_superadmin: { Args: { p_user_id: string }; Returns: string };
      restore_admin_access: { Args: { p_user_id: string }; Returns: string };
      provision_admin_by_email: { Args: { p_email: string }; Returns: string };
      begin_user_account_purge: { Args: { p_target_id: string }; Returns: Json };
      purge_user_account: { Args: { p_target_id: string }; Returns: Json };
      claim_account_storage_cleanup: {
        Args: { p_worker_id: string; p_limit?: number };
        Returns: Json;
      };
      advance_account_storage_cleanup: {
        Args: {
          p_tombstone_id: string;
          p_worker_id: string;
          p_outcome: string;
          p_error_code?: string | null;
        };
        Returns: Json;
      };
      prune_account_storage_cleanup_tombstones: { Args: { p_limit?: number }; Returns: Json };
      get_admin_data_summary: { Args: Record<PropertyKey, never>; Returns: Json };
      list_admin_users_page: JsonRpc;
      list_admin_audit_page: JsonRpc;
      list_admin_access_users_page: JsonRpc;
      list_admin_access_outbox_page: JsonRpc;
    };
    Enums: {
      app_locale: AppLocale;
      account_approval_state: AccountApprovalState;
      app_role: 'user' | 'admin' | 'superadmin';
      product_role: AppRole;
      account_status: AccountStatus;
      article_status: ArticleStatus;
      test_status: TestStatus;
      attempt_status: AttemptStatus;
      course_presentation_status: CoursePresentationStatus;
      identity_verification_status: IdentityVerificationStatus;
      certificate_issue_source: CertificateIssueSource;
      legal_document_type: LegalDocumentType;
      legal_acceptance_source: LegalAcceptanceSource;
    };
    CompositeTypes: Record<never, never>;
  };
};
