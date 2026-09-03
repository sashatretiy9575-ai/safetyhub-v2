import type { AccountStatus, AppLocale, AppRole } from '@/lib/supabase/types';
import type { AdminCapability } from '@/lib/security/capabilities';
import type { ContentSource } from '@/lib/content/content-metadata';
import type { ContentSeo } from '@/lib/validation/content-seo';
import type { IconId } from '@/lib/course-icons';

/**
 * Minimal account-management payload allowed across the Server/Client boundary.
 * Detailed profile, verified identity, activity and certificate data stay server-only.
 */
export type AdminUserListItem = {
  id: string;
  email: string | null;
  label: string;
  role: AppRole;
  capabilities: AdminCapability[];
  status: AccountStatus;
};

/** Minimal PII read model for the capability-gated manual learner-approval queue. */
export type AdminAccountApprovalItem = {
  id: string;
  email: string | null;
  /** Present only for a private ZH username/password mapping in this queue. */
  username?: string | null;
  name: string;
  surname: string;
  job: string;
  organization: string;
  phoneCountryIso2: string | null;
  phoneE164: string | null;
  avatarAvailable: boolean;
  requestedAt: string;
  dueAt: string;
};

/** Deletion-specific directory entry; deliberately excludes capabilities and history detail. */
export type LearningHistoryTarget = {
  id: string;
  email: string | null;
  label: string;
  role: 'participant';
  status: AccountStatus;
  createdAt: string;
};

export type AdminPageCursor = { at: string; id: string };

export type AdminPage<T> = {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor: AdminPageCursor | null;
};

export type AdminAccessUser = {
  id: string;
  email: string | null;
  label: string;
  capabilities: AdminCapability[];
};

export type AuthAdminOutboxItem = {
  id: string;
  operationType: 'invite' | 'suspend' | 'restore';
  state: 'prepared' | 'external_succeeded' | 'committed' | 'retryable' | 'rolled_back' | 'failed';
  actorUserId: string;
  actorLabel: string;
  targetId: string | null;
  targetLabel: string;
  attempts: number;
  lastError: string | null;
  originalReason: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminDataFailure = {
  state: 'failed';
  correlationId: string;
};

export type AdminDataResult<T> = { state: 'ready'; data: T } | AdminDataFailure;

export type AdminDataSummary = {
  users: number | null;
  activeUsers: number | null;
  suspendedUsers: number | null;
  attempts: number | null;
  passedAttempts: number | null;
  activeCertificates: number | null;
  revokedCertificates: number | null;
  auditEvents24h: number | null;
  tests: number | null;
  generatedAt: string;
};

export type AdminAttestationIdentityState = 'pending' | 'verified' | 'changed' | 'revoked';

export type AdminAttestationCertificateState =
  | 'not_eligible'
  | 'pending_identity'
  | 'ready'
  | 'issued'
  | 'revoked';

export type AdminAttestationRow = {
  /** Stable row key. Historical certificate rows use the certificate id. */
  recordId: string;
  kind: 'attestation' | 'deleted-course-certificate';
  attestationId: string | null;
  userId: string;
  bestAttemptId: string | null;
  revisionId: string | null;
  testId: string | null;
  testVersion: number | null;
  name: string;
  surname: string;
  fullName: string;
  job: string;
  organization: string;
  organizationGroupCount: number;
  avatarAvailable: boolean;
  avatarUrl: string | null;
  courseTitle: string;
  score: number;
  total: number;
  passScore: number;
  completedAt: string;
  identityState: AdminAttestationIdentityState;
  certificateState: AdminAttestationCertificateState;
  certificateId: string | null;
  certificateScore: number | null;
  certificateNumber: string | null;
  scoreImproved: boolean;
  courseDeleted: boolean;
};

export type AdminAttestationCourseOption = { id: string; title: string };

export type AdminAttestationCursor = { values: unknown[]; id: string };

export type AdminAttestationPage = {
  items: AdminAttestationRow[];
  total: number;
  hasMore: boolean;
  nextCursor: AdminAttestationCursor | null;
};

export type AdminAttestationFilters = {
  organizations: string[];
  courses: AdminAttestationCourseOption[];
};

export type AdminWorkQueue = {
  pendingIdentity: number;
  readyToIssue: number;
  companyIssues: number;
  activeCertificates: number;
  generatedAt: string;
};

export type AdminAttestationSelection = {
  /** Stable row ids, including retained certificates for deleted courses. */
  recordIds: string[];
  attestationIds: string[];
  userIds: string[];
  certificateIds: string[];
  total: number;
  uniquePeople: number;
  pendingIdentity: number;
  ready: number;
  issued: number;
  exportable: number;
};

export type AdminAttestationMutationItem = {
  id: string;
  status: 'completed' | 'already_completed' | 'skipped';
  reason: string | null;
};

export type AdminAuditEvent = {
  id: string;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  details: Record<string, unknown>;
  correlationId: string;
  requestId: string | null;
  userAgent: string | null;
  createdAt: string;
};

export type AdminPresentation = {
  id: string;
  locale: AppLocale;
  pageCount: number;
  sha256: string;
  byteSize: number;
  status: 'staging' | 'validating' | 'ready' | 'rejected' | 'retired';
};

export type CoursePresentationRetirement = {
  presentationId: string;
  courseId: string;
  status: 'retired';
  retiredAt: string;
  changed: boolean;
};

export type AdminLearningHistoryCounts = {
  attempts: number;
  startedAttempts: number;
  attestations: number;
  activeCertificates: number;
  revokedCertificates: number;
};

export type AdminLearningHistory = {
  user: {
    id: string;
    name: string;
    surname: string;
    email: string | null;
    role: string;
  };
  counts: AdminLearningHistoryCounts;
  lastActivityAt: string | null;
  deletable: boolean;
};

export type AdminLearningHistoryDeletion = {
  operationId: string;
  targetUserId: string;
  deleted: boolean;
  replayed: boolean;
  counts: AdminLearningHistoryCounts & { certificateExportJobs: number };
};

export type PreparedCourseCatalogBatch = {
  batchId: string;
  status: 'staging';
  courseCount: 5;
};

export type CourseCatalogMaintenanceState = {
  enabled: boolean;
  updatedAt: string;
};

export type CourseCatalogMaintenance = CourseCatalogMaintenanceState & {
  changed: boolean;
};

export type ActivatedCourseCatalogBatch = {
  batchId: string;
  activationId: string;
  status: 'activated';
  replayed: boolean;
  maintenanceEnabled: true;
  catalogChecksum: string;
  published: {
    courses: 5;
    revisions: 5;
    variants: 15;
    questions: 150;
    options: 600;
  };
  deleted: {
    courses: number;
    attempts: number;
    attestations: number;
    certificates: number;
    certificateExportJobs: number;
  };
  preserved: {
    authUsers: number;
    profiles: number;
  };
};

export type AdminTestQuestion = {
  id: string;
  text: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
  explanation: string;
};

export type AdminTestVariant = {
  id: string;
  variantNumber: 1 | 2 | 3;
  questions: AdminTestQuestion[];
};

export type AdminCourseRevisionSummary = {
  id: string;
  version: number;
  publishedAt: string;
  contentHash: string;
  presentationId: string | null;
  current: boolean;
};

export type TestEditorPayload = {
  id?: string;
  slug: string;
  title: string;
  description: string;
  icon: IconId;
  displayOrder: number;
  durationMinutes: number;
  passScore: number;
  attemptsPerCalendarDay: number;
  attemptResetTimezone: string;
  presentationId: string | null;
  presentation: AdminPresentation | null;
  jurisdiction: string;
  effectiveDate: string;
  sources: ContentSource[];
  status?: 'draft' | 'published';
  publicationState?: 'never_published' | 'draft' | 'published' | 'published_with_draft_changes';
  draftVersion?: number;
  contentHash?: string;
  seo: ContentSeo;
  questionVariants: [AdminTestVariant, AdminTestVariant, AdminTestVariant];
  revisionHistory: AdminCourseRevisionSummary[];
};

/**
 * Server-to-client seed for the course editor. Since 20260903090000 it carries
 * the saved question bank — texts, options and the correct option — for an
 * administrator holding `test.manage`, and every such read is written to the
 * audit log by `public.read_course_question_bank_v4`. `null` means the stored
 * bank is absent or incomplete, and the editor starts from blank variants.
 * Immutable storage locations and learner payloads stay server-only.
 *
 * `questionBankReadable` is false only when the audited read function itself is absent —
 * an environment where the application already runs but the migration has not
 * been applied yet. The bank is then unknown rather than empty, so the editor
 * must refuse to write instead of shipping blank variants over a full bank.
 */
export type TestEditorSeed = Omit<TestEditorPayload, 'questionVariants'> & {
  questionVariants: [AdminTestVariant, AdminTestVariant, AdminTestVariant] | null;
  questionBankReadable: boolean;
};
