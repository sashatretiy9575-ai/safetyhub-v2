export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  private: {
    Tables: {
      account_storage_cleanup_tombstones: {
        Row: {
          attempt_count: number
          auth_purged_at: string | null
          cleanup_not_before: string
          db_purged_at: string | null
          empty_confirmed_at: string | null
          id: string
          last_error_code: string | null
          lease_expires_at: string | null
          lease_owner: string | null
          next_attempt_at: string
          requested_at: string
          state: string
          storage_cleared_at: string | null
          storage_prefix: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          auth_purged_at?: string | null
          cleanup_not_before: string
          db_purged_at?: string | null
          empty_confirmed_at?: string | null
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          next_attempt_at?: string
          requested_at?: string
          state?: string
          storage_cleared_at?: string | null
          storage_prefix: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          auth_purged_at?: string | null
          cleanup_not_before?: string
          db_purged_at?: string | null
          empty_confirmed_at?: string | null
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          next_attempt_at?: string
          requested_at?: string
          state?: string
          storage_cleared_at?: string | null
          storage_prefix?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_operation_receipts: {
        Row: {
          action: string
          actor_user_id: string
          created_at: string
          expires_at: string
          idempotency_key: string
          request_hash: string
          result: Json
        }
        Insert: {
          action: string
          actor_user_id: string
          created_at?: string
          expires_at?: string
          idempotency_key: string
          request_hash: string
          result: Json
        }
        Update: {
          action?: string
          actor_user_id?: string
          created_at?: string
          expires_at?: string
          idempotency_key?: string
          request_hash?: string
          result?: Json
        }
        Relationships: []
      }
      auth_admin_outbox: {
        Row: {
          actor_user_id: string
          attempts: number
          completion_token_hash: string
          correlation_id: string
          created_at: string
          id: string
          last_error: string | null
          operation_type: string
          payload: Json
          processing_lease_expires_at: string | null
          state: string
          target_id: string | null
          updated_at: string
        }
        Insert: {
          actor_user_id: string
          attempts?: number
          completion_token_hash: string
          correlation_id?: string
          created_at?: string
          id?: string
          last_error?: string | null
          operation_type: string
          payload?: Json
          processing_lease_expires_at?: string | null
          state?: string
          target_id?: string | null
          updated_at?: string
        }
        Update: {
          actor_user_id?: string
          attempts?: number
          completion_token_hash?: string
          correlation_id?: string
          created_at?: string
          id?: string
          last_error?: string | null
          operation_type?: string
          payload?: Json
          processing_lease_expires_at?: string | null
          state?: string
          target_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      avatar_upload_operations: {
        Row: {
          artifacts_cleared_at: string | null
          attempt_count: number
          expected_bytes: number
          expected_sha256: string
          expires_at: string
          finalized_at: string | null
          last_error_code: string | null
          lease_expires_at: string | null
          lease_owner: string | null
          next_attempt_at: string
          object_key: string
          previous_object_key: string | null
          started_at: string
          state: string
          storage_write_lease_expires_at: string | null
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          artifacts_cleared_at?: string | null
          attempt_count?: number
          expected_bytes: number
          expected_sha256: string
          expires_at: string
          finalized_at?: string | null
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          next_attempt_at?: string
          object_key: string
          previous_object_key?: string | null
          started_at?: string
          state?: string
          storage_write_lease_expires_at?: string | null
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          artifacts_cleared_at?: string | null
          attempt_count?: number
          expected_bytes?: number
          expected_sha256?: string
          expires_at?: string
          finalized_at?: string | null
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          next_attempt_at?: string
          object_key?: string
          previous_object_key?: string | null
          started_at?: string
          state?: string
          storage_write_lease_expires_at?: string | null
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      business_rate_limits: {
        Row: {
          action: string
          actor_id: string
          consumed: number
          window_started_at: string
        }
        Insert: {
          action: string
          actor_id: string
          consumed?: number
          window_started_at: string
        }
        Update: {
          action?: string
          actor_id?: string
          consumed?: number
          window_started_at?: string
        }
        Relationships: []
      }
      certificate_export_jobs: {
        Row: {
          actor_user_id: string
          attestation_ids: string[]
          created_at: string
          downloaded_at: string | null
          eligible: number
          expires_at: string
          id: string
          requested: number
          skipped: number
          state: string
        }
        Insert: {
          actor_user_id: string
          attestation_ids: string[]
          created_at?: string
          downloaded_at?: string | null
          eligible: number
          expires_at?: string
          id?: string
          requested: number
          skipped: number
          state?: string
        }
        Update: {
          actor_user_id?: string
          attestation_ids?: string[]
          created_at?: string
          downloaded_at?: string | null
          eligible?: number
          expires_at?: string
          id?: string
          requested?: number
          skipped?: number
          state?: string
        }
        Relationships: []
      }
      coarse_ip_rate_limits: {
        Row: {
          action: string
          consumed: number
          ip_hash: string
          window_started_at: string
        }
        Insert: {
          action: string
          consumed?: number
          ip_hash: string
          window_started_at: string
        }
        Update: {
          action?: string
          consumed?: number
          ip_hash?: string
          window_started_at?: string
        }
        Relationships: []
      }
      course_catalog_runtime_state: {
        Row: {
          maintenance_enabled: boolean
          singleton: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          maintenance_enabled?: boolean
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          maintenance_enabled?: boolean
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      learning_history_delete_receipts: {
        Row: {
          actor_user_id: string
          created_at: string
          expires_at: string
          idempotency_key: string
          request_hash: string
          result: Json
          target_user_id: string
        }
        Insert: {
          actor_user_id: string
          created_at?: string
          expires_at?: string
          idempotency_key: string
          request_hash: string
          result: Json
          target_user_id: string
        }
        Update: {
          actor_user_id?: string
          created_at?: string
          expires_at?: string
          idempotency_key?: string
          request_hash?: string
          result?: Json
          target_user_id?: string
        }
        Relationships: []
      }
      password_change_contexts: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          purpose: string
          session_id: string | null
          token_hash: string
          user_id: string | null
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          purpose: string
          session_id?: string | null
          token_hash: string
          user_id?: string | null
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          purpose?: string
          session_id?: string | null
          token_hash?: string
          user_id?: string | null
        }
        Relationships: []
      }
      profile_avatar_manifests: {
        Row: {
          byte_length: number
          legacy_imported: boolean
          object_key: string
          operation_token: string
          sha256: string
          updated_at: string
          user_id: string
        }
        Insert: {
          byte_length: number
          legacy_imported?: boolean
          object_key: string
          operation_token: string
          sha256: string
          updated_at?: string
          user_id: string
        }
        Update: {
          byte_length?: number
          legacy_imported?: boolean
          object_key?: string
          operation_token?: string
          sha256?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      signup_legal_operations: {
        Row: {
          completed_at: string | null
          completed_user_id: string | null
          expires_at: string
          nonce_sha256: string
          normalized_email: string
          operation_id: string
          prepared_at: string
          privacy_body_revision: string
          privacy_version: string
          state: string
          terms_body_revision: string
          terms_version: string
        }
        Insert: {
          completed_at?: string | null
          completed_user_id?: string | null
          expires_at: string
          nonce_sha256: string
          normalized_email: string
          operation_id: string
          prepared_at?: string
          privacy_body_revision: string
          privacy_version: string
          state?: string
          terms_body_revision: string
          terms_version: string
        }
        Update: {
          completed_at?: string | null
          completed_user_id?: string | null
          expires_at?: string
          nonce_sha256?: string
          normalized_email?: string
          operation_id?: string
          prepared_at?: string
          privacy_body_revision?: string
          privacy_version?: string
          state?: string
          terms_body_revision?: string
          terms_version?: string
        }
        Relationships: []
      }
      test_revision_answer_keys: {
        Row: {
          correct_positions: number[]
          explanations: string[]
          revision_id: string
        }
        Insert: {
          correct_positions: number[]
          explanations: string[]
          revision_id: string
        }
        Update: {
          correct_positions?: number[]
          explanations?: string[]
          revision_id?: string
        }
        Relationships: []
      }
      test_revision_variant_answer_keys: {
        Row: {
          correct_option_ids: Json
          created_at: string
          explanations: Json
          revision_id: string
          variant_id: string
        }
        Insert: {
          correct_option_ids: Json
          created_at?: string
          explanations?: Json
          revision_id: string
          variant_id: string
        }
        Update: {
          correct_option_ids?: Json
          created_at?: string
          explanations?: Json
          revision_id?: string
          variant_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      admin_attestation_rows: {
        Row: {
          attestation_id: string | null
          avatar_available: boolean | null
          best_attempt_id: string | null
          certificate_id: string | null
          certificate_number: string | null
          certificate_score: number | null
          certificate_state: string | null
          completed_at: string | null
          course_title: string | null
          full_name: string | null
          identity_state: string | null
          issued_at: string | null
          job: string | null
          name: string | null
          organization: string | null
          organization_key: string | null
          pass_score: number | null
          revision_id: string | null
          revoked_at: string | null
          score: number | null
          score_improved: boolean | null
          surname: string | null
          test_id: string | null
          test_version: number | null
          total: number | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_current_legal_documents_unmetered: {
        Args: {
          p_privacy_body_revision: string
          p_privacy_version: string
          p_terms_body_revision: string
          p_terms_version: string
        }
        Returns: Json
      }
      activate_course_catalog_batch_unmetered: {
        Args: {
          p_actor_id: string
          p_batch_id: string
          p_idempotency_key: string
        }
        Returns: Json
      }
      actor_has_any_capability: {
        Args: { p_actor_id: string; p_capabilities: string[] }
        Returns: boolean
      }
      actor_has_capability: {
        Args: { p_actor_id: string; p_capability: string }
        Returns: boolean
      }
      advance_auth_admin_operation_invariant_inner: {
        Args: {
          p_completion_token: string
          p_error?: string
          p_external_target_id?: string
          p_operation_id: string
          p_state: string
        }
        Returns: Json
      }
      article_content_hash: {
        Args: {
          p_blocks: Json
          p_cover_image: string
          p_description: string
          p_title: string
        }
        Returns: string
      }
      article_content_hash_v2: {
        Args: {
          p_blocks: Json
          p_cover_image: string
          p_description: string
          p_effective_date: string
          p_jurisdiction: string
          p_seo: Json
          p_slug: string
          p_sources: Json
          p_title: string
        }
        Returns: string
      }
      article_draft_content_hash: {
        Args: {
          p_blocks: Json
          p_cover_image: string
          p_description: string
          p_seo: Json
          p_slug: string
          p_title: string
        }
        Returns: string
      }
      assert_active_superadmin_invariant: { Args: never; Returns: undefined }
      assert_legacy_course_mutation_allowed: { Args: never; Returns: undefined }
      attempt_payload: {
        Args: { p_attempt_id: string; p_retry_at?: string }
        Returns: Json
      }
      bulk_update_participants_unmetered: {
        Args: { p_field: string; p_user_ids: string[]; p_value: string }
        Returns: Json
      }
      capabilities_for_user: { Args: { p_user_id: string }; Returns: string[] }
      certificate_download_payload: {
        Args: { p_certificate_id: string }
        Returns: Json
      }
      certificate_state: { Args: { p_attestation_id: string }; Returns: string }
      claim_auth_admin_operation_confirmed_unmetered: {
        Args: {
          p_correlation_id: string
          p_ip_hash?: string
          p_operation_id: string
          p_reason: string
          p_request_id?: string
          p_user_agent?: string
        }
        Returns: Json
      }
      complete_test_attempt_unmetered: {
        Args: { p_answers: Json; p_attempt_id: string }
        Returns: Json
      }
      confirm_admin_identities_unmetered: {
        Args: { p_user_ids: string[] }
        Returns: Json
      }
      confirm_profile_identity: {
        Args: {
          p_action: string
          p_actor_id: string
          p_batch_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      consume_business_quota_for_actor: {
        Args: { p_action: string; p_actor_id: string }
        Returns: Json
      }
      correct_option_ids_from_draft: {
        Args: { p_questions: Json }
        Returns: Json
      }
      course_catalog_maintenance_enabled: { Args: never; Returns: boolean }
      course_catalog_v3_active: { Args: never; Returns: boolean }
      course_content_hash: {
        Args: {
          p_content: Json
          p_description: string
          p_duration_minutes: number
          p_icon: string
          p_questions: Json
          p_seo: Json
          p_slug: string
          p_title: string
        }
        Returns: string
      }
      course_content_hash_v2: {
        Args: {
          p_content: Json
          p_description: string
          p_duration_minutes: number
          p_effective_date: string
          p_icon: string
          p_jurisdiction: string
          p_questions: Json
          p_seo: Json
          p_slug: string
          p_sources: Json
          p_title: string
        }
        Returns: string
      }
      course_content_hash_v3: {
        Args: {
          p_attempt_reset_timezone: string
          p_attempts_per_calendar_day: number
          p_description: string
          p_display_order: number
          p_duration_minutes: number
          p_effective_date: string
          p_icon: string
          p_jurisdiction: string
          p_pass_score: number
          p_presentation_page_count: number
          p_presentation_sha256: string
          p_question_variants: Json
          p_seo: Json
          p_slug: string
          p_sources: Json
          p_title: string
        }
        Returns: string
      }
      course_question_variants_valid: {
        Args: { p_variants: Json }
        Returns: boolean
      }
      delete_admin_learning_history_unmetered: {
        Args: {
          p_actor_id: string
          p_idempotency_key: string
          p_reason: string
          p_target_user_id: string
        }
        Returns: Json
      }
      editor_course_question_variants: {
        Args: { p_variants: Json }
        Returns: Json
      }
      enforce_actor_quota: { Args: { p_action: string }; Returns: undefined }
      ensure_legacy_revision_variant: {
        Args: { p_revision_id: string }
        Returns: string
      }
      ensure_rpc_payload: { Args: { p_payload: Json }; Returns: Json }
      explanations_from_draft: { Args: { p_questions: Json }; Returns: Json }
      has_current_legal_acceptance: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      has_pending_auth_admin_operation: {
        Args: { p_email: string; p_user_id: string }
        Returns: boolean
      }
      identity_state: { Args: { p_user_id: string }; Returns: string }
      issue_certificate_for_attestation: {
        Args: {
          p_actor_id: string
          p_attestation_id: string
          p_batch_id?: string
          p_source: Database["public"]["Enums"]["certificate_issue_source"]
          p_supersedes?: string
        }
        Returns: string
      }
      issue_certificates_unmetered: {
        Args: { p_attestation_ids: string[] }
        Returns: Json
      }
      jsonb_canonical_text: { Args: { p_value: Json }; Returns: string }
      lock_active_superadmin_invariant: { Args: never; Returns: undefined }
      lock_auth_admin_outbox: { Args: never; Returns: undefined }
      lock_signup_legal_operations: { Args: never; Returns: undefined }
      manage_user_role_confirmed_unmetered: {
        Args: {
          p_correlation_id: string
          p_ip_hash?: string
          p_reason: string
          p_request_id?: string
          p_role: Database["public"]["Enums"]["app_role"]
          p_target_id: string
          p_user_agent?: string
        }
        Returns: Json
      }
      new_auth_admin_operation: {
        Args: {
          p_actor_id: string
          p_correlation_id: string
          p_operation_type: string
          p_payload: Json
          p_target_id: string
        }
        Returns: Json
      }
      normalize_course_question_variants: {
        Args: { p_variants: Json }
        Returns: Json
      }
      normalize_organization_key: { Args: { p_value: string }; Returns: string }
      normalize_profile_text: { Args: { p_value: string }; Returns: string }
      normalized_lookup_key: { Args: { p_value: string }; Returns: string }
      prepare_user_invite_unmetered: {
        Args: {
          p_correlation_id: string
          p_email: string
          p_ip_hash?: string
          p_job: string
          p_name: string
          p_password_ticket: string
          p_redirect_origin: string
          p_request_id?: string
          p_requested_role: Database["public"]["Enums"]["app_role"]
          p_surname: string
          p_user_agent?: string
        }
        Returns: Json
      }
      public_questions_from_draft: {
        Args: { p_questions: Json }
        Returns: Json
      }
      publish_course_revision_v2_unmetered: {
        Args: {
          p_actor_id: string
          p_expected_content_hash: string
          p_test_id: string
        }
        Returns: Json
      }
      publish_course_revision_v3_unmetered: {
        Args: {
          p_actor_id: string
          p_expected_content_hash: string
          p_test_id: string
        }
        Returns: Json
      }
      quota_policy: {
        Args: { p_action: string }
        Returns: {
          quota: number
          window_seconds: number
        }[]
      }
      reconstruct_course_question_variants: {
        Args: { p_revision_id: string }
        Returns: Json
      }
      request_account_suspension_confirmed_unmetered: {
        Args: {
          p_correlation_id: string
          p_ip_hash?: string
          p_reason: string
          p_request_id?: string
          p_suspended: boolean
          p_target_id: string
          p_user_agent?: string
        }
        Returns: Json
      }
      require_active_user: { Args: never; Returns: string }
      require_any_capability: {
        Args: { p_capabilities: string[] }
        Returns: string
      }
      require_capability: { Args: { p_capability: string }; Returns: string }
      resolve_certificate_export_unmetered: {
        Args: { p_attestation_ids: string[] }
        Returns: Json
      }
      resolve_profile_organization: {
        Args: { p_value: string }
        Returns: Database["public"]["Tables"]["organizations"]["Row"]
        SetofOptions: {
          from: "*"
          to: "organizations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_certificates_unmetered: {
        Args: { p_certificate_ids: string[]; p_reason: string }
        Returns: Json
      }
      revoke_user_identity_unmetered: {
        Args: { p_reason: string; p_target_id: string }
        Returns: Json
      }
      rpc_error_envelope: {
        Args: { p_detail?: string; p_message: string; p_sqlstate: string }
        Returns: Json
      }
      sanitize_bulk_mutation_result: {
        Args: { p_payload: Json }
        Returns: Json
      }
      save_article_draft_unmetered: {
        Args: {
          p_article_id: string
          p_blocks: Json
          p_content_metadata?: Json
          p_cover_image: string
          p_description: string
          p_original_slug: string
          p_slug: string
          p_title: string
        }
        Returns: Json
      }
      save_article_draft_v2_unmetered: {
        Args: {
          p_article_id: string
          p_blocks: Json
          p_content_metadata?: Json
          p_cover_image: string
          p_description: string
          p_original_slug: string
          p_slug: string
          p_title: string
        }
        Returns: Json
      }
      save_course_draft_v2_unmetered: {
        Args: {
          p_actor_id: string
          p_content: Json
          p_content_metadata?: Json
          p_description: string
          p_duration_minutes: number
          p_expected_version: number
          p_icon: string
          p_questions: Json
          p_seo: Json
          p_slug: string
          p_test_id: string
          p_title: string
        }
        Returns: Json
      }
      save_course_draft_v3_unmetered: {
        Args: {
          p_actor_id: string
          p_attempt_reset_timezone: string
          p_attempts_per_calendar_day: number
          p_content_metadata?: Json
          p_description: string
          p_display_order: number
          p_duration_minutes: number
          p_expected_version: number
          p_icon: string
          p_pass_score: number
          p_presentation_id: string
          p_question_variants: Json
          p_seo: Json
          p_slug: string
          p_test_id: string
          p_title: string
        }
        Returns: Json
      }
      set_article_status_v2_unmetered: {
        Args: {
          p_article_id: string
          p_expected_content_hash: string
          p_status: Database["public"]["Enums"]["article_status"]
        }
        Returns: Json
      }
      set_user_capabilities_confirmed_rollback_prone: {
        Args: {
          p_capabilities: string[]
          p_correlation_id: string
          p_ip_hash?: string
          p_reason: string
          p_request_id?: string
          p_target_id: string
          p_user_agent?: string
        }
        Returns: string[]
      }
      set_user_capabilities_confirmed_unmetered: {
        Args: {
          p_capabilities: string[]
          p_correlation_id: string
          p_ip_hash?: string
          p_reason: string
          p_request_id?: string
          p_target_id: string
          p_user_agent?: string
        }
        Returns: string[]
      }
      start_test_attempt_unmetered: {
        Args: { p_test_slug: string }
        Returns: Json
      }
      sync_content_asset_usages: {
        Args: {
          p_document: Json
          p_owner_id: string
          p_owner_type: string
          p_owner_version: number
        }
        Returns: undefined
      }
      update_profile_unmetered: {
        Args: {
          p_job: string
          p_name: string
          p_organization: string
          p_surname: string
        }
        Returns: Json
      }
      update_site_settings_unmetered: {
        Args: {
          p_expected_version: number
          p_phone_display: string
          p_phone_e164: string
          p_whatsapp_e164: string
          p_whatsapp_same_as_phone: boolean
        }
        Returns: Json
      }
      verify_user_identity_unmetered: {
        Args: {
          p_job: string
          p_name: string
          p_organization: string
          p_surname: string
          p_target_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      account_controls: {
        Row: {
          deletion_pending: boolean
          status: Database["public"]["Enums"]["account_status"]
          suspended_at: string | null
          suspended_by: string | null
          suspension_reason: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          deletion_pending?: boolean
          status?: Database["public"]["Enums"]["account_status"]
          suspended_at?: string | null
          suspended_by?: string | null
          suspension_reason?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          deletion_pending?: boolean
          status?: Database["public"]["Enums"]["account_status"]
          suspended_at?: string | null
          suspended_by?: string | null
          suspension_reason?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          after_data: Json | null
          batch_id: string | null
          before_data: Json | null
          correlation_id: string
          created_at: string
          id: number
          ip_hash: string | null
          reason: string | null
          request_id: string | null
          target_id: string | null
          target_type: string
          target_user_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_data?: Json | null
          batch_id?: string | null
          before_data?: Json | null
          correlation_id?: string
          created_at?: string
          id?: never
          ip_hash?: string | null
          reason?: string | null
          request_id?: string | null
          target_id?: string | null
          target_type: string
          target_user_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_data?: Json | null
          batch_id?: string | null
          before_data?: Json | null
          correlation_id?: string
          created_at?: string
          id?: never
          ip_hash?: string | null
          reason?: string | null
          request_id?: string | null
          target_id?: string | null
          target_type?: string
          target_user_id?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      admin_capability_catalog: {
        Row: {
          admin_default: boolean
          capability: string
          category: string
          label: string
          sensitive: boolean
        }
        Insert: {
          admin_default?: boolean
          capability: string
          category: string
          label: string
          sensitive?: boolean
        }
        Update: {
          admin_default?: boolean
          capability?: string
          category?: string
          label?: string
          sensitive?: boolean
        }
        Relationships: []
      }
      article_drafts: {
        Row: {
          article_id: string
          blocks: Json
          content_hash: string
          cover_image: string
          created_at: string
          description: string
          draft_version: number
          effective_date: string | null
          jurisdiction: string | null
          seo: Json
          slug: string
          sources: Json
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          article_id: string
          blocks?: Json
          content_hash?: string
          cover_image?: string
          created_at?: string
          description?: string
          draft_version?: number
          effective_date?: string | null
          jurisdiction?: string | null
          seo?: Json
          slug: string
          sources?: Json
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          article_id?: string
          blocks?: Json
          content_hash?: string
          cover_image?: string
          created_at?: string
          description?: string
          draft_version?: number
          effective_date?: string | null
          jurisdiction?: string | null
          seo?: Json
          slug?: string
          sources?: Json
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "article_drafts_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: true
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
        ]
      }
      article_revisions: {
        Row: {
          article_id: string
          blocks: Json
          content_hash: string
          cover_image: string
          description: string
          effective_date: string | null
          id: string
          jurisdiction: string | null
          published_at: string
          published_by: string | null
          seo: Json
          slug: string
          sources: Json
          title: string
          version: number
        }
        Insert: {
          article_id: string
          blocks: Json
          content_hash: string
          cover_image?: string
          description?: string
          effective_date?: string | null
          id?: string
          jurisdiction?: string | null
          published_at?: string
          published_by?: string | null
          seo?: Json
          slug: string
          sources?: Json
          title: string
          version: number
        }
        Update: {
          article_id?: string
          blocks?: Json
          content_hash?: string
          cover_image?: string
          description?: string
          effective_date?: string | null
          id?: string
          jurisdiction?: string | null
          published_at?: string
          published_by?: string | null
          seo?: Json
          slug?: string
          sources?: Json
          title?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "article_revisions_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
        ]
      }
      article_slug_redirects: {
        Row: {
          article_id: string
          created_at: string
          old_slug: string
        }
        Insert: {
          article_id: string
          created_at?: string
          old_slug: string
        }
        Update: {
          article_id?: string
          created_at?: string
          old_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "article_slug_redirects_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
        ]
      }
      articles: {
        Row: {
          blocks: Json
          content_hash: string
          content_version: number
          cover_image: string
          created_at: string
          created_by: string | null
          current_revision_id: string | null
          description: string
          effective_date: string | null
          id: string
          is_published: boolean
          jurisdiction: string | null
          published_at: string | null
          seo: Json
          slug: string
          sources: Json
          status: Database["public"]["Enums"]["article_status"]
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          blocks?: Json
          content_hash?: string
          content_version?: number
          cover_image?: string
          created_at?: string
          created_by?: string | null
          current_revision_id?: string | null
          description?: string
          effective_date?: string | null
          id?: string
          is_published?: boolean
          jurisdiction?: string | null
          published_at?: string | null
          seo?: Json
          slug: string
          sources?: Json
          status?: Database["public"]["Enums"]["article_status"]
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          blocks?: Json
          content_hash?: string
          content_version?: number
          cover_image?: string
          created_at?: string
          created_by?: string | null
          current_revision_id?: string | null
          description?: string
          effective_date?: string | null
          id?: string
          is_published?: boolean
          jurisdiction?: string | null
          published_at?: string | null
          seo?: Json
          slug?: string
          sources?: Json
          status?: Database["public"]["Enums"]["article_status"]
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "articles_current_revision_id_fkey"
            columns: ["current_revision_id"]
            isOneToOne: false
            referencedRelation: "article_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      attestations: {
        Row: {
          best_attempt_id: string
          best_completed_at: string
          best_score: number
          id: string
          revision_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          best_attempt_id: string
          best_completed_at: string
          best_score: number
          id?: string
          revision_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          best_attempt_id?: string
          best_completed_at?: string
          best_score?: number
          id?: string
          revision_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attestations_best_attempt_id_fkey"
            columns: ["best_attempt_id"]
            isOneToOne: false
            referencedRelation: "test_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attestations_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "test_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      certificates: {
        Row: {
          attempt_id: string | null
          attestation_id: string | null
          best_completed_at: string
          certificate_number: string
          course_deleted_at: string | null
          full_name: string
          id: string
          identity_version: number
          issue_source: Database["public"]["Enums"]["certificate_issue_source"]
          issued_at: string
          issued_by: string | null
          job: string
          organization: string
          pass_score: number
          revision_id: string | null
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          score: number
          supersedes_certificate_id: string | null
          template_version: number
          test_slug: string
          test_title: string
          total: number
          user_id: string
        }
        Insert: {
          attempt_id?: string | null
          attestation_id?: string | null
          best_completed_at: string
          certificate_number: string
          course_deleted_at?: string | null
          full_name: string
          id?: string
          identity_version: number
          issue_source?: Database["public"]["Enums"]["certificate_issue_source"]
          issued_at?: string
          issued_by?: string | null
          job: string
          organization: string
          pass_score: number
          revision_id?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          score: number
          supersedes_certificate_id?: string | null
          template_version?: number
          test_slug: string
          test_title: string
          total: number
          user_id: string
        }
        Update: {
          attempt_id?: string | null
          attestation_id?: string | null
          best_completed_at?: string
          certificate_number?: string
          course_deleted_at?: string | null
          full_name?: string
          id?: string
          identity_version?: number
          issue_source?: Database["public"]["Enums"]["certificate_issue_source"]
          issued_at?: string
          issued_by?: string | null
          job?: string
          organization?: string
          pass_score?: number
          revision_id?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          score?: number
          supersedes_certificate_id?: string | null
          template_version?: number
          test_slug?: string
          test_title?: string
          total?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "certificates_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "test_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificates_attestation_id_fkey"
            columns: ["attestation_id"]
            isOneToOne: false
            referencedRelation: "attestations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificates_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "test_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      content_asset_usages: {
        Row: {
          asset_id: string
          created_at: string
          owner_id: string
          owner_type: string
          owner_version: number
          usage_key: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          owner_id: string
          owner_type: string
          owner_version?: number
          usage_key: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          owner_id?: string
          owner_type?: string
          owner_version?: number
          usage_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_asset_usages_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "content_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      content_assets: {
        Row: {
          byte_size: number
          created_at: string
          created_by: string | null
          height: number
          id: string
          last_referenced_at: string | null
          mime_type: string
          original_filename: string
          sha256: string
          status: string
          storage_key: string
          width: number
        }
        Insert: {
          byte_size: number
          created_at?: string
          created_by?: string | null
          height: number
          id?: string
          last_referenced_at?: string | null
          mime_type: string
          original_filename: string
          sha256: string
          status?: string
          storage_key: string
          width: number
        }
        Update: {
          byte_size?: number
          created_at?: string
          created_by?: string | null
          height?: number
          id?: string
          last_referenced_at?: string | null
          mime_type?: string
          original_filename?: string
          sha256?: string
          status?: string
          storage_key?: string
          width?: number
        }
        Relationships: []
      }
      course_catalog_batch_items: {
        Row: {
          batch_id: string
          display_order: number
          expected_content_hash: string
          test_id: string
        }
        Insert: {
          batch_id: string
          display_order: number
          expected_content_hash: string
          test_id: string
        }
        Update: {
          batch_id?: string
          display_order?: number
          expected_content_hash?: string
          test_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_catalog_batch_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "course_catalog_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_catalog_batch_items_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      course_catalog_batches: {
        Row: {
          activated_at: string | null
          activation_idempotency_key: string | null
          created_at: string
          created_by: string | null
          id: string
          result: Json | null
          status: string
        }
        Insert: {
          activated_at?: string | null
          activation_idempotency_key?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          result?: Json | null
          status?: string
        }
        Update: {
          activated_at?: string | null
          activation_idempotency_key?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          result?: Json | null
          status?: string
        }
        Relationships: []
      }
      course_drafts: {
        Row: {
          attempt_reset_timezone: string
          attempts_per_calendar_day: number
          content: Json
          content_hash: string
          created_at: string
          description: string
          display_order: number
          draft_version: number
          duration_minutes: number
          effective_date: string | null
          icon: string
          jurisdiction: string | null
          pass_score: number
          presentation_id: string | null
          question_variants: Json
          questions: Json
          seo: Json
          slug: string
          sources: Json
          test_id: string
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          attempt_reset_timezone?: string
          attempts_per_calendar_day?: number
          content?: Json
          content_hash?: string
          created_at?: string
          description?: string
          display_order?: number
          draft_version?: number
          duration_minutes?: number
          effective_date?: string | null
          icon?: string
          jurisdiction?: string | null
          pass_score?: number
          presentation_id?: string | null
          question_variants?: Json
          questions?: Json
          seo?: Json
          slug: string
          sources?: Json
          test_id: string
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          attempt_reset_timezone?: string
          attempts_per_calendar_day?: number
          content?: Json
          content_hash?: string
          created_at?: string
          description?: string
          display_order?: number
          draft_version?: number
          duration_minutes?: number
          effective_date?: string | null
          icon?: string
          jurisdiction?: string | null
          pass_score?: number
          presentation_id?: string | null
          question_variants?: Json
          questions?: Json
          seo?: Json
          slug?: string
          sources?: Json
          test_id?: string
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "course_draft_presentation_id_fkey"
            columns: ["presentation_id"]
            isOneToOne: false
            referencedRelation: "course_presentations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_drafts_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: true
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      course_presentations: {
        Row: {
          aspect_ratio: string
          byte_size: number
          cleanup_claimed_at: string | null
          course_id: string | null
          created_at: string
          created_by: string | null
          id: string
          mime_type: string
          page_count: number
          retired_at: string | null
          sha256: string
          source_filename: string
          status: Database["public"]["Enums"]["course_presentation_status"]
          storage_bucket: string
          storage_path: string
          thumbnail_path: string | null
          validated_at: string | null
          validation_error: string | null
        }
        Insert: {
          aspect_ratio?: string
          byte_size: number
          cleanup_claimed_at?: string | null
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          mime_type?: string
          page_count: number
          retired_at?: string | null
          sha256: string
          source_filename: string
          status?: Database["public"]["Enums"]["course_presentation_status"]
          storage_bucket: string
          storage_path: string
          thumbnail_path?: string | null
          validated_at?: string | null
          validation_error?: string | null
        }
        Update: {
          aspect_ratio?: string
          byte_size?: number
          cleanup_claimed_at?: string | null
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          mime_type?: string
          page_count?: number
          retired_at?: string | null
          sha256?: string
          source_filename?: string
          status?: Database["public"]["Enums"]["course_presentation_status"]
          storage_bucket?: string
          storage_path?: string
          thumbnail_path?: string | null
          validated_at?: string | null
          validation_error?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "course_presentations_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      course_slug_redirects: {
        Row: {
          created_at: string
          old_slug: string
          test_id: string
        }
        Insert: {
          created_at?: string
          old_slug: string
          test_id: string
        }
        Update: {
          created_at?: string
          old_slug?: string
          test_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_slug_redirects_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_acceptances: {
        Row: {
          accepted_at: string
          document_type: Database["public"]["Enums"]["legal_document_type"]
          source: Database["public"]["Enums"]["legal_acceptance_source"]
          user_id: string
          version: string
        }
        Insert: {
          accepted_at?: string
          document_type: Database["public"]["Enums"]["legal_document_type"]
          source: Database["public"]["Enums"]["legal_acceptance_source"]
          user_id: string
          version: string
        }
        Update: {
          accepted_at?: string
          document_type?: Database["public"]["Enums"]["legal_document_type"]
          source?: Database["public"]["Enums"]["legal_acceptance_source"]
          user_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_acceptances_document_type_version_fkey"
            columns: ["document_type", "version"]
            isOneToOne: false
            referencedRelation: "legal_document_versions"
            referencedColumns: ["document_type", "version"]
          },
        ]
      }
      legal_document_versions: {
        Row: {
          body_revision: string
          created_at: string
          document_type: Database["public"]["Enums"]["legal_document_type"]
          effective_at: string
          is_current: boolean
          version: string
        }
        Insert: {
          body_revision: string
          created_at?: string
          document_type: Database["public"]["Enums"]["legal_document_type"]
          effective_at: string
          is_current?: boolean
          version: string
        }
        Update: {
          body_revision?: string
          created_at?: string
          document_type?: Database["public"]["Enums"]["legal_document_type"]
          effective_at?: string
          is_current?: boolean
          version?: string
        }
        Relationships: []
      }
      organization_aliases: {
        Row: {
          alias: string
          created_at: string
          id: string
          normalized_key: string
          organization_id: string
        }
        Insert: {
          alias: string
          created_at?: string
          id?: string
          normalized_key: string
          organization_id: string
        }
        Update: {
          alias?: string
          created_at?: string
          id?: string
          normalized_key?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          active: boolean
          canonical_name: string
          created_at: string
          id: string
          normalized_key: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          canonical_name: string
          created_at?: string
          id?: string
          normalized_key: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          canonical_name?: string
          created_at?: string
          id?: string
          normalized_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_updated_at: string | null
          created_at: string
          id: string
          job: string
          name: string
          onboarding_completed_at: string | null
          organization: string
          organization_id: string | null
          surname: string
          updated_at: string
        }
        Insert: {
          avatar_updated_at?: string | null
          created_at?: string
          id: string
          job?: string
          name?: string
          onboarding_completed_at?: string | null
          organization?: string
          organization_id?: string | null
          surname?: string
          updated_at?: string
        }
        Update: {
          avatar_updated_at?: string | null
          created_at?: string
          id?: string
          job?: string
          name?: string
          onboarding_completed_at?: string | null
          organization?: string
          organization_id?: string | null
          surname?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      site_settings: {
        Row: {
          phone_display: string
          phone_e164: string
          singleton: boolean
          updated_at: string
          updated_by: string | null
          version: number
          whatsapp_e164: string
          whatsapp_same_as_phone: boolean
        }
        Insert: {
          phone_display: string
          phone_e164: string
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
          version?: number
          whatsapp_e164: string
          whatsapp_same_as_phone?: boolean
        }
        Update: {
          phone_display?: string
          phone_e164?: string
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
          version?: number
          whatsapp_e164?: string
          whatsapp_same_as_phone?: boolean
        }
        Relationships: []
      }
      test_attempts: {
        Row: {
          answers: number[] | null
          attempts_per_day: number
          completed_at: string | null
          duration_minutes: number
          expires_at: string
          id: string
          pass_score: number
          reset_timezone: string
          revision_id: string
          score: number | null
          started_at: string
          status: Database["public"]["Enums"]["attempt_status"]
          test_id: string
          user_id: string
          variant_id: string
        }
        Insert: {
          answers?: number[] | null
          attempts_per_day?: number
          completed_at?: string | null
          duration_minutes: number
          expires_at: string
          id?: string
          pass_score: number
          reset_timezone?: string
          revision_id: string
          score?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["attempt_status"]
          test_id: string
          user_id: string
          variant_id: string
        }
        Update: {
          answers?: number[] | null
          attempts_per_day?: number
          completed_at?: string | null
          duration_minutes?: number
          expires_at?: string
          id?: string
          pass_score?: number
          reset_timezone?: string
          revision_id?: string
          score?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["attempt_status"]
          test_id?: string
          user_id?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_attempts_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "test_revisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_attempts_revision_variant_fk"
            columns: ["revision_id", "variant_id"]
            isOneToOne: false
            referencedRelation: "test_revision_variants"
            referencedColumns: ["revision_id", "id"]
          },
          {
            foreignKeyName: "test_attempts_test_revision_fk"
            columns: ["test_id", "revision_id"]
            isOneToOne: false
            referencedRelation: "test_revisions"
            referencedColumns: ["test_id", "id"]
          },
        ]
      }
      test_revision_variants: {
        Row: {
          created_at: string
          id: string
          question_count: number
          questions: Json
          revision_id: string
          stable_id: string
          variant_number: number
        }
        Insert: {
          created_at?: string
          id?: string
          question_count?: number
          questions: Json
          revision_id: string
          stable_id: string
          variant_number: number
        }
        Update: {
          created_at?: string
          id?: string
          question_count?: number
          questions?: Json
          revision_id?: string
          stable_id?: string
          variant_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "test_revision_variants_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "test_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      test_revisions: {
        Row: {
          attempt_reset_timezone: string
          attempts_per_calendar_day: number
          content: Json
          content_hash: string
          description: string
          display_order: number
          duration_minutes: number
          effective_date: string | null
          icon: string
          id: string
          jurisdiction: string | null
          pass_score: number
          presentation_id: string | null
          published_at: string
          published_by: string | null
          question_count: number
          questions: Json
          seo: Json
          slug: string
          sources: Json
          test_id: string
          title: string
          version: number
        }
        Insert: {
          attempt_reset_timezone?: string
          attempts_per_calendar_day?: number
          content?: Json
          content_hash?: string
          description: string
          display_order?: number
          duration_minutes: number
          effective_date?: string | null
          icon?: string
          id?: string
          jurisdiction?: string | null
          pass_score: number
          presentation_id?: string | null
          published_at?: string
          published_by?: string | null
          question_count: number
          questions: Json
          seo?: Json
          slug: string
          sources?: Json
          test_id: string
          title: string
          version: number
        }
        Update: {
          attempt_reset_timezone?: string
          attempts_per_calendar_day?: number
          content?: Json
          content_hash?: string
          description?: string
          display_order?: number
          duration_minutes?: number
          effective_date?: string | null
          icon?: string
          id?: string
          jurisdiction?: string | null
          pass_score?: number
          presentation_id?: string | null
          published_at?: string
          published_by?: string | null
          question_count?: number
          questions?: Json
          seo?: Json
          slug?: string
          sources?: Json
          test_id?: string
          title?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "test_revisions_presentation_id_fkey"
            columns: ["presentation_id"]
            isOneToOne: false
            referencedRelation: "course_presentations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_revisions_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      tests: {
        Row: {
          attempt_reset_timezone: string
          attempts_per_calendar_day: number
          content_hash: string
          content_version: number
          created_at: string
          created_by: string | null
          current_revision_id: string | null
          description: string
          display_order: number
          draft_content: Json
          duration_minutes: number
          effective_date: string | null
          icon: string
          id: string
          jurisdiction: string | null
          pass_score: number
          seo: Json
          slug: string
          sources: Json
          status: Database["public"]["Enums"]["test_status"]
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          attempt_reset_timezone?: string
          attempts_per_calendar_day?: number
          content_hash?: string
          content_version?: number
          created_at?: string
          created_by?: string | null
          current_revision_id?: string | null
          description?: string
          display_order?: number
          draft_content?: Json
          duration_minutes?: number
          effective_date?: string | null
          icon?: string
          id?: string
          jurisdiction?: string | null
          pass_score?: number
          seo?: Json
          slug: string
          sources?: Json
          status?: Database["public"]["Enums"]["test_status"]
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          attempt_reset_timezone?: string
          attempts_per_calendar_day?: number
          content_hash?: string
          content_version?: number
          created_at?: string
          created_by?: string | null
          current_revision_id?: string | null
          description?: string
          display_order?: number
          draft_content?: Json
          duration_minutes?: number
          effective_date?: string | null
          icon?: string
          id?: string
          jurisdiction?: string | null
          pass_score?: number
          seo?: Json
          slug?: string
          sources?: Json
          status?: Database["public"]["Enums"]["test_status"]
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tests_current_revision_fk"
            columns: ["current_revision_id"]
            isOneToOne: false
            referencedRelation: "test_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_capabilities: {
        Row: {
          capability: string
          created_at: string
          granted_by: string | null
          user_id: string
        }
        Insert: {
          capability: string
          created_at?: string
          granted_by?: string | null
          user_id: string
        }
        Update: {
          capability?: string
          created_at?: string
          granted_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_capabilities_capability_fkey"
            columns: ["capability"]
            isOneToOne: false
            referencedRelation: "admin_capability_catalog"
            referencedColumns: ["capability"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          created_by: string | null
          product_role: Database["public"]["Enums"]["product_role"]
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          product_role?: Database["public"]["Enums"]["product_role"]
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          product_role?: Database["public"]["Enums"]["product_role"]
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      verified_identities: {
        Row: {
          job: string
          name: string
          organization: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: Database["public"]["Enums"]["identity_verification_status"]
          surname: string
          user_id: string
          verified_at: string | null
          verified_by: string | null
          version: number
        }
        Insert: {
          job?: string
          name?: string
          organization?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: Database["public"]["Enums"]["identity_verification_status"]
          surname?: string
          user_id: string
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Update: {
          job?: string
          name?: string
          organization?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: Database["public"]["Enums"]["identity_verification_status"]
          surname?: string
          user_id?: string
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      abort_profile_avatar_upload: {
        Args: {
          p_error_code?: string
          p_operation_token: string
          p_user_id: string
        }
        Returns: Json
      }
      accept_current_legal_documents: {
        Args: {
          p_privacy_body_revision: string
          p_privacy_version: string
          p_terms_body_revision: string
          p_terms_version: string
        }
        Returns: Json
      }
      activate_course_catalog_batch: {
        Args: {
          p_actor_id: string
          p_batch_id: string
          p_idempotency_key: string
        }
        Returns: Json
      }
      advance_account_storage_cleanup: {
        Args: {
          p_error_code?: string
          p_outcome: string
          p_tombstone_id: string
          p_worker_id: string
        }
        Returns: Json
      }
      advance_auth_admin_operation: {
        Args: {
          p_completion_token: string
          p_error?: string
          p_external_target_id?: string
          p_operation_id: string
          p_state: string
        }
        Returns: Json
      }
      begin_profile_avatar_upload: {
        Args: {
          p_expected_bytes: number
          p_expected_sha256: string
          p_user_id: string
        }
        Returns: Json
      }
      begin_user_account_purge: { Args: { p_target_id: string }; Returns: Json }
      bootstrap_superadmin: { Args: { p_user_id: string }; Returns: string }
      bulk_update_participants: {
        Args: { p_field: string; p_user_ids: string[]; p_value: string }
        Returns: Json
      }
      change_course_slug: {
        Args: {
          p_actor_id: string
          p_expected_version: number
          p_new_slug: string
          p_test_id: string
        }
        Returns: Json
      }
      claim_account_storage_cleanup: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: Json
      }
      claim_auth_admin_operation_confirmed: {
        Args: {
          p_correlation_id: string
          p_ip_hash?: string
          p_operation_id: string
          p_reason: string
          p_request_id?: string
          p_user_agent?: string
        }
        Returns: Json
      }
      claim_password_change_context: {
        Args: {
          p_context_kind: string
          p_session_id: string
          p_token_hash: string
          p_user_id: string
        }
        Returns: boolean
      }
      claim_profile_avatar_reconciliation: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: Json
      }
      claim_stale_course_presentations: {
        Args: {
          p_lease_minutes?: number
          p_limit?: number
          p_ttl_hours?: number
        }
        Returns: Json
      }
      complete_course_presentation_cleanup: {
        Args: { p_presentation_ids: string[] }
        Returns: Json
      }
      complete_profile_avatar_reconciliation: {
        Args: {
          p_error_code?: string
          p_operation_token: string
          p_outcome: string
          p_worker_id: string
        }
        Returns: Json
      }
      complete_profile_onboarding: {
        Args: {
          p_job: string
          p_name: string
          p_organization: string
          p_surname: string
        }
        Returns: Json
      }
      complete_test_attempt: {
        Args: { p_answers: Json; p_attempt_id: string }
        Returns: Json
      }
      confirm_admin_identities: {
        Args: { p_user_ids: string[] }
        Returns: Json
      }
      consume_business_quota: { Args: { p_action: string }; Returns: Json }
      consume_business_quota_for_actor: {
        Args: { p_action: string; p_actor_id: string }
        Returns: Json
      }
      consume_coarse_ip_quota: {
        Args: { p_action: string; p_ip_hash: string }
        Returns: Json
      }
      consume_password_change_context: {
        Args: {
          p_context_kind: string
          p_session_id: string
          p_token_hash: string
          p_user_id: string
        }
        Returns: string
      }
      create_certificate_export_job: {
        Args: { p_attestation_ids: string[] }
        Returns: Json
      }
      create_password_change_context: {
        Args: {
          p_context_kind: string
          p_expires_at: string
          p_session_id: string
          p_token_hash: string
          p_user_id: string
        }
        Returns: undefined
      }
      delete_admin_learning_history: {
        Args: {
          p_actor_id: string
          p_idempotency_key: string
          p_reason: string
          p_target_user_id: string
        }
        Returns: Json
      }
      delete_article: {
        Args: { p_article_id: string; p_expected_version: number }
        Returns: Json
      }
      delete_course: {
        Args: {
          p_actor_id: string
          p_expected_version: number
          p_test_id: string
        }
        Returns: Json
      }
      delete_password_change_context: {
        Args: { p_token_hash: string }
        Returns: undefined
      }
      delete_verified_orphan_asset: {
        Args: { p_actor_id: string; p_asset_id: string }
        Returns: Json
      }
      execute_admin_attestation_action: {
        Args: {
          p_action: string
          p_field?: string
          p_idempotency_key: string
          p_reason?: string
          p_target_ids: string[]
          p_value?: string
        }
        Returns: Json
      }
      finalize_course_presentation_metadata: {
        Args: {
          p_actor_id: string
          p_course_id: string
          p_expected_byte_size: number
          p_expected_page_count: number
          p_expected_sha256: string
          p_expected_staging_pdf_path: string
          p_expected_staging_thumbnail_path: string
          p_presentation_id: string
        }
        Returns: Json
      }
      finalize_profile_avatar_upload: {
        Args: { p_operation_token: string; p_user_id: string }
        Returns: Json
      }
      finalize_signup_legal_operation: {
        Args: {
          p_operation_id: string
          p_signup_nonce: string
          p_user_id: string
        }
        Returns: Json
      }
      finish_profile_avatar_storage_write: {
        Args: {
          p_error_code?: string
          p_operation_token: string
          p_user_id: string
        }
        Returns: Json
      }
      get_admin_attestation_by_certificate_number: {
        Args: { p_query: string }
        Returns: Json
      }
      get_admin_attestation_filters: { Args: never; Returns: Json }
      get_admin_data_summary: { Args: never; Returns: Json }
      get_admin_learning_history: {
        Args: { p_actor_id: string; p_target_user_id: string }
        Returns: Json
      }
      get_admin_work_queue: { Args: never; Returns: Json }
      get_auth_context: {
        Args: never
        Returns: {
          capabilities: string[]
          deletion_pending: boolean
          email: string
          has_current_legal_acceptance: boolean
          profile_avatar_updated_at: string
          profile_created_at: string
          profile_id: string
          profile_identity_state: string
          profile_job: string
          profile_name: string
          profile_onboarding_completed_at: string
          profile_organization: string
          profile_surname: string
          profile_updated_at: string
          role: Database["public"]["Enums"]["product_role"]
          status: Database["public"]["Enums"]["account_status"]
          user_id: string
        }[]
      }
      get_capacity_metrics: { Args: never; Returns: Json }
      get_certificate_download_payload: {
        Args: { p_certificate_id: string }
        Returns: Json
      }
      get_certificate_export_job: { Args: { p_job_id: string }; Returns: Json }
      get_course_catalog_maintenance: {
        Args: { p_actor_id: string }
        Returns: Json
      }
      get_course_editor_payload_v3: {
        Args: { p_actor_id: string; p_test_id: string }
        Returns: Json
      }
      get_my_capabilities: { Args: never; Returns: string[] }
      get_my_profile_avatar_manifest: { Args: never; Returns: Json }
      get_profile_attestations: { Args: never; Returns: Json }
      get_profile_avatar_manifest: {
        Args: { p_user_id: string }
        Returns: Json
      }
      get_profile_avatar_upload_operation: {
        Args: { p_operation_token: string; p_user_id: string }
        Returns: Json
      }
      get_profile_dashboard: { Args: never; Returns: Json }
      get_public_certificate: {
        Args: { p_certificate_id: string }
        Returns: Json
      }
      get_published_course_snapshot_v3: {
        Args: { p_test_id: string }
        Returns: Json
      }
      get_site_settings: { Args: never; Returns: Json }
      get_test_attempt: { Args: { p_attempt_id: string }; Returns: Json }
      get_test_editor_payload: {
        Args: { p_actor_id: string; p_test_id: string }
        Returns: Json
      }
      get_test_editor_payload_v2: {
        Args: { p_actor_id: string; p_test_id: string }
        Returns: Json
      }
      get_user_identity: { Args: { p_target_id?: string }; Returns: Json }
      inspect_password_change_context: {
        Args: { p_session_id: string; p_token_hash: string; p_user_id: string }
        Returns: string
      }
      issue_certificates: {
        Args: { p_attestation_ids: string[] }
        Returns: Json
      }
      list_admin_access_outbox_page: {
        Args: {
          p_cursor_id?: string
          p_cursor_updated_at?: string
          p_limit?: number
          p_operation_type?: string
          p_state?: string
        }
        Returns: Json
      }
      list_admin_access_users_page: {
        Args: {
          p_cursor_created_at?: string
          p_cursor_id?: string
          p_limit?: number
          p_query?: string
        }
        Returns: Json
      }
      list_admin_attestations_page: {
        Args: {
          p_certificate_state?: string
          p_cursor?: Json
          p_from?: string
          p_limit?: number
          p_organization?: string
          p_query?: string
          p_result_state?: string
          p_sort?: string
          p_test_id?: string
          p_to?: string
        }
        Returns: Json
      }
      list_admin_audit_page: {
        Args: {
          p_action?: string
          p_actor?: string
          p_cursor_created_at?: string
          p_cursor_id?: number
          p_from?: string
          p_limit?: number
          p_target?: string
          p_to?: string
        }
        Returns: Json
      }
      list_admin_users_page: {
        Args: {
          p_cursor_created_at?: string
          p_cursor_id?: string
          p_limit?: number
          p_query?: string
          p_role?: Database["public"]["Enums"]["app_role"]
          p_status?: Database["public"]["Enums"]["account_status"]
        }
        Returns: Json
      }
      list_learning_history_targets_page: {
        Args: {
          p_actor_id: string
          p_cursor_created_at?: string
          p_cursor_id?: string
          p_limit?: number
          p_query?: string
        }
        Returns: Json
      }
      list_organization_cleanup_clusters: {
        Args: { p_limit?: number }
        Returns: Json
      }
      manage_user_role_confirmed: {
        Args: {
          p_correlation_id: string
          p_ip_hash?: string
          p_reason: string
          p_request_id?: string
          p_role: Database["public"]["Enums"]["app_role"]
          p_target_id: string
          p_user_agent?: string
        }
        Returns: Json
      }
      mark_content_asset_orphan: {
        Args: { p_actor_id: string; p_asset_id: string }
        Returns: Json
      }
      mark_profile_avatar_staged: {
        Args: {
          p_observed_bytes: number
          p_observed_sha256: string
          p_operation_token: string
          p_user_id: string
        }
        Returns: Json
      }
      merge_organizations: {
        Args: {
          p_idempotency_key: string
          p_reason: string
          p_reissue_certificates: boolean
          p_source_ids: string[]
          p_target_id: string
        }
        Returns: Json
      }
      prepare_course_catalog_batch: {
        Args: { p_actor_id: string; p_test_ids: string[] }
        Returns: Json
      }
      prepare_signup_legal_operation: {
        Args: {
          p_email: string
          p_nonce_sha256: string
          p_operation_id: string
          p_privacy_body_revision: string
          p_privacy_version: string
          p_terms_body_revision: string
          p_terms_version: string
        }
        Returns: Json
      }
      prepare_user_invite: {
        Args: {
          p_correlation_id: string
          p_email: string
          p_ip_hash?: string
          p_job: string
          p_name: string
          p_password_ticket: string
          p_redirect_origin: string
          p_request_id?: string
          p_requested_role: Database["public"]["Enums"]["app_role"]
          p_surname: string
          p_user_agent?: string
        }
        Returns: Json
      }
      preview_organization_merge: {
        Args: { p_source_ids: string[]; p_target_id: string }
        Returns: Json
      }
      profile_avatar_object_is_committed: {
        Args: { p_object_name: string }
        Returns: boolean
      }
      profile_avatar_storage_write_is_authorized: {
        Args: { p_object_name: string }
        Returns: boolean
      }
      provision_admin_by_email: { Args: { p_email: string }; Returns: string }
      prune_account_storage_cleanup_tombstones: {
        Args: { p_limit?: number }
        Returns: Json
      }
      prune_admin_operation_receipts: {
        Args: { p_limit?: number }
        Returns: number
      }
      prune_certificate_export_jobs: {
        Args: { p_limit?: number }
        Returns: number
      }
      prune_coarse_ip_rate_limits: { Args: { p_limit?: number }; Returns: Json }
      prune_learning_history_delete_receipts: {
        Args: { p_limit?: number }
        Returns: number
      }
      prune_signup_legal_operations: {
        Args: { p_limit?: number }
        Returns: Json
      }
      prune_terminal_auth_admin_outbox: {
        Args: { p_limit?: number }
        Returns: Json
      }
      prune_terminal_avatar_upload_operations: {
        Args: { p_limit?: number }
        Returns: Json
      }
      publish_course_revision: {
        Args: {
          p_actor_id: string
          p_expected_content_hash: string
          p_test_id: string
        }
        Returns: Json
      }
      publish_course_revision_v2: {
        Args: {
          p_actor_id: string
          p_expected_content_hash: string
          p_test_id: string
        }
        Returns: Json
      }
      publish_course_revision_v3: {
        Args: {
          p_actor_id: string
          p_expected_content_hash: string
          p_test_id: string
        }
        Returns: Json
      }
      publish_legal_document_version: {
        Args: {
          p_body_revision: string
          p_document_type: Database["public"]["Enums"]["legal_document_type"]
          p_effective_at: string
          p_version: string
        }
        Returns: Json
      }
      purge_user_account: { Args: { p_target_id: string }; Returns: Json }
      request_account_suspension_confirmed: {
        Args: {
          p_correlation_id: string
          p_ip_hash?: string
          p_reason: string
          p_request_id?: string
          p_suspended: boolean
          p_target_id: string
          p_user_agent?: string
        }
        Returns: Json
      }
      resolve_admin_attestation_selection: {
        Args: {
          p_certificate_state?: string
          p_from?: string
          p_organization?: string
          p_query?: string
          p_result_state?: string
          p_sort?: string
          p_test_id?: string
          p_to?: string
        }
        Returns: Json
      }
      resolve_article_slug: { Args: { p_old_slug: string }; Returns: string }
      resolve_certificate_export: {
        Args: { p_attestation_ids: string[] }
        Returns: Json
      }
      resolve_certificate_export_job: {
        Args: { p_job_id: string }
        Returns: Json
      }
      resolve_course_slug: { Args: { p_old_slug: string }; Returns: string }
      restore_admin_access: { Args: { p_user_id: string }; Returns: string }
      resume_test_attempt: { Args: { p_test_slug: string }; Returns: Json }
      retire_course_presentation: {
        Args: {
          p_actor_id: string
          p_course_id: string
          p_presentation_id: string
        }
        Returns: Json
      }
      revoke_certificate: {
        Args: { p_certificate_id: string; p_reason: string }
        Returns: Json
      }
      revoke_certificates: {
        Args: { p_certificate_ids: string[]; p_reason: string }
        Returns: Json
      }
      revoke_user_identity: {
        Args: { p_reason: string; p_target_id: string }
        Returns: Json
      }
      save_and_publish_article_v2: {
        Args: {
          p_article_id: string
          p_blocks: Json
          p_content_metadata?: Json
          p_cover_image: string
          p_description: string
          p_original_slug: string
          p_slug: string
          p_title: string
        }
        Returns: Json
      }
      save_and_publish_course_v2: {
        Args: {
          p_actor_id: string
          p_content: Json
          p_content_metadata?: Json
          p_description: string
          p_duration_minutes: number
          p_expected_version: number
          p_icon: string
          p_questions: Json
          p_seo: Json
          p_slug: string
          p_test_id: string
          p_title: string
        }
        Returns: Json
      }
      save_and_publish_course_v3: {
        Args: {
          p_actor_id: string
          p_attempt_reset_timezone: string
          p_attempts_per_calendar_day: number
          p_content_metadata?: Json
          p_description: string
          p_display_order: number
          p_duration_minutes: number
          p_expected_version: number
          p_icon: string
          p_pass_score: number
          p_presentation_id: string
          p_question_variants: Json
          p_seo: Json
          p_slug: string
          p_test_id: string
          p_title: string
        }
        Returns: Json
      }
      save_article_draft: {
        Args: {
          p_article_id: string
          p_blocks: Json
          p_content_metadata?: Json
          p_cover_image: string
          p_description: string
          p_original_slug: string
          p_slug: string
          p_title: string
        }
        Returns: Json
      }
      save_article_draft_v2: {
        Args: {
          p_article_id: string
          p_blocks: Json
          p_content_metadata?: Json
          p_cover_image: string
          p_description: string
          p_original_slug: string
          p_slug: string
          p_title: string
        }
        Returns: Json
      }
      save_course_draft: {
        Args: {
          p_actor_id: string
          p_content: Json
          p_content_metadata?: Json
          p_description: string
          p_duration_minutes: number
          p_expected_version: number
          p_icon: string
          p_questions: Json
          p_seo: Json
          p_slug: string
          p_test_id: string
          p_title: string
        }
        Returns: Json
      }
      save_course_draft_v2: {
        Args: {
          p_actor_id: string
          p_content: Json
          p_content_metadata?: Json
          p_description: string
          p_duration_minutes: number
          p_expected_version: number
          p_icon: string
          p_questions: Json
          p_seo: Json
          p_slug: string
          p_test_id: string
          p_title: string
        }
        Returns: Json
      }
      save_course_draft_v3: {
        Args: {
          p_actor_id: string
          p_attempt_reset_timezone: string
          p_attempts_per_calendar_day: number
          p_content_metadata?: Json
          p_description: string
          p_display_order: number
          p_duration_minutes: number
          p_expected_version: number
          p_icon: string
          p_pass_score: number
          p_presentation_id: string
          p_question_variants: Json
          p_seo: Json
          p_slug: string
          p_test_id: string
          p_title: string
        }
        Returns: Json
      }
      search_profile_organizations: {
        Args: { p_limit?: number; p_query: string }
        Returns: string[]
      }
      set_article_status: {
        Args: {
          p_article_id: string
          p_expected_content_hash?: string
          p_status: Database["public"]["Enums"]["article_status"]
        }
        Returns: Json
      }
      set_article_status_v2: {
        Args: {
          p_article_id: string
          p_expected_content_hash?: string
          p_status: Database["public"]["Enums"]["article_status"]
        }
        Returns: Json
      }
      set_course_catalog_maintenance: {
        Args: { p_actor_id: string; p_enabled: boolean }
        Returns: Json
      }
      set_test_status: {
        Args: {
          p_actor_id: string
          p_status: Database["public"]["Enums"]["test_status"]
          p_test_id: string
        }
        Returns: Json
      }
      set_user_capabilities_confirmed: {
        Args: {
          p_capabilities: string[]
          p_correlation_id: string
          p_ip_hash?: string
          p_reason: string
          p_request_id?: string
          p_target_id: string
          p_user_agent?: string
        }
        Returns: Json
      }
      start_test_attempt: { Args: { p_test_slug: string }; Returns: Json }
      update_profile: {
        Args: {
          p_job: string
          p_name: string
          p_organization: string
          p_surname: string
        }
        Returns: Json
      }
      update_site_settings: {
        Args: {
          p_expected_version: number
          p_phone_display: string
          p_phone_e164: string
          p_whatsapp_e164: string
          p_whatsapp_same_as_phone: boolean
        }
        Returns: Json
      }
      verify_user_identity: {
        Args: {
          p_job: string
          p_name: string
          p_organization: string
          p_surname: string
          p_target_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      account_status: "active" | "suspended"
      app_role: "user" | "admin" | "superadmin"
      article_status: "draft" | "published"
      attempt_status: "started" | "passed" | "failed" | "expired"
      certificate_issue_source:
        | "manual"
        | "score_improvement"
        | "identity_correction"
      course_presentation_status:
        | "staging"
        | "validating"
        | "ready"
        | "rejected"
        | "retired"
      identity_verification_status: "unverified" | "verified" | "revoked"
      legal_acceptance_source: "registration" | "profile"
      legal_document_type: "privacy" | "terms"
      product_role: "participant" | "admin"
      test_status: "draft" | "published"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  private: {
    Enums: {},
  },
  public: {
    Enums: {
      account_status: ["active", "suspended"],
      app_role: ["user", "admin", "superadmin"],
      article_status: ["draft", "published"],
      attempt_status: ["started", "passed", "failed", "expired"],
      certificate_issue_source: [
        "manual",
        "score_improvement",
        "identity_correction",
      ],
      course_presentation_status: [
        "staging",
        "validating",
        "ready",
        "rejected",
        "retired",
      ],
      identity_verification_status: ["unverified", "verified", "revoked"],
      legal_acceptance_source: ["registration", "profile"],
      legal_document_type: ["privacy", "terms"],
      product_role: ["participant", "admin"],
      test_status: ["draft", "published"],
    },
  },
} as const
