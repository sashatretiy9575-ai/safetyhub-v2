import 'server-only';

import { cache } from 'react';
import { z } from 'zod';
import {
  createClient,
  hasSupabaseSessionCookie,
  isSupabaseConfigured,
} from '@/lib/supabase/server';
import type { AccountStatus, AppLocale, AppRole } from '@/lib/supabase/types';
import { ADMIN_CAPABILITIES, type AdminCapability } from '@/lib/security/capabilities';
import { resolveSiteOrigin } from '@/lib/site-url';

export type AuthProfile = Readonly<{
  id: string;
  name: string;
  surname: string;
  job: string;
  organization: string;
  phone_country_iso2: string | null;
  phone_e164: string | null;
  preferred_locale: AppLocale;
  avatar_updated_at: string | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type IdentityState = 'pending' | 'verified' | 'changed' | 'revoked';
export type AccountApprovalState = 'profile_incomplete' | 'pending' | 'approved' | 'rejected';

export type AuthContext = Readonly<{
  user: { id: string; email: string | null };
  profile: AuthProfile;
  identityState: IdentityState;
  role: AppRole;
  status: AccountStatus;
  deletionPending: boolean;
  approval: Readonly<{
    state: AccountApprovalState;
    requestedAt: string | null;
    dueAt: string | null;
    decidedAt: string | null;
    rejectionReason: string | null;
  }>;
  capabilities: AdminCapability[];
  hasCurrentLegalAcceptance: boolean;
}>;

const authContextRowSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email().nullable(),
  profile_id: z.string().uuid(),
  profile_name: z.string(),
  profile_surname: z.string(),
  profile_job: z.string(),
  profile_organization: z.string(),
  profile_phone_country_iso2: z.string().nullable(),
  profile_phone_e164: z.string().nullable(),
  profile_preferred_locale: z.enum(['ru', 'kk', 'en', 'zh']),
  profile_avatar_updated_at: z.string().nullable(),
  profile_onboarding_completed_at: z.string().nullable(),
  profile_identity_state: z.enum(['pending', 'verified', 'changed', 'revoked']),
  profile_created_at: z.string(),
  profile_updated_at: z.string(),
  role: z.enum(['participant', 'admin']),
  status: z.enum(['active', 'suspended']),
  deletion_pending: z.boolean(),
  approval_state: z.enum(['profile_incomplete', 'pending', 'approved', 'rejected']),
  approval_requested_at: z.string().nullable(),
  approval_due_at: z.string().nullable(),
  approval_decided_at: z.string().nullable(),
  approval_rejection_reason: z.string().nullable(),
  capabilities: z.array(z.string()),
  has_current_legal_acceptance: z.boolean(),
});

function unauthenticatedRpcError(error: { code?: string; message?: string }) {
  return (
    error.code === 'PGRST301' ||
    error.code === 'PGRST302' ||
    error.code === 'PGRST303' ||
    error.message?.toLowerCase().includes('jwt') === true
  );
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 | 503,
    public readonly code: string,
  ) {
    super(message);
  }
}

function authContextUnavailable() {
  return new AuthenticationError(
    'Не удалось загрузить контекст доступа',
    503,
    'AUTH_CONTEXT_UNAVAILABLE',
  );
}

async function loadAuthContextRow() {
  try {
    const supabase = await createClient();
    return await supabase.rpc('get_auth_context').maybeSingle();
  } catch {
    throw authContextUnavailable();
  }
}

export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  if (!isSupabaseConfigured()) return null;
  if (!(await hasSupabaseSessionCookie())) return null;

  const { data, error } = await loadAuthContextRow();
  if (error) {
    if (unauthenticatedRpcError(error)) return null;
    throw authContextUnavailable();
  }
  if (data === null) return null;
  const parsed = authContextRowSchema.safeParse(data);
  if (!parsed.success) {
    console.error('AUTH_CONTEXT_INVALID', { issues: parsed.error.issues });
    throw new AuthenticationError('Контекст доступа неполон', 503, 'AUTH_CONTEXT_INCOMPLETE');
  }

  const row = parsed.data;
  const capabilities = row.role === 'admin' ? [...ADMIN_CAPABILITIES] : [];

  return {
    user: { id: row.user_id, email: row.email },
    profile: {
      id: row.profile_id,
      name: row.profile_name,
      surname: row.profile_surname,
      job: row.profile_job,
      organization: row.profile_organization,
      phone_country_iso2: row.profile_phone_country_iso2,
      phone_e164: row.profile_phone_e164,
      preferred_locale: row.profile_preferred_locale,
      avatar_updated_at: row.profile_avatar_updated_at,
      onboarding_completed_at: row.profile_onboarding_completed_at,
      created_at: row.profile_created_at,
      updated_at: row.profile_updated_at,
    },
    identityState: row.profile_identity_state,
    role: row.role,
    status: row.status,
    deletionPending: row.deletion_pending,
    approval: {
      state: row.approval_state,
      requestedAt: row.approval_requested_at,
      dueAt: row.approval_due_at,
      decidedAt: row.approval_decided_at,
      rejectionReason: row.approval_rejection_reason,
    },
    capabilities,
    hasCurrentLegalAcceptance: row.has_current_legal_acceptance,
  };
});

export async function requireUser(options: { enforceLegal?: boolean } = {}) {
  if (!isSupabaseConfigured()) {
    throw new AuthenticationError('Supabase не настроен', 503, 'SUPABASE_NOT_CONFIGURED');
  }
  const context = await getAuthContext();
  if (!context) throw new AuthenticationError('Требуется вход', 401, 'UNAUTHENTICATED');
  if (context.status !== 'active') {
    throw new AuthenticationError('Аккаунт приостановлен', 403, 'ACCOUNT_SUSPENDED');
  }
  if (context.deletionPending) {
    throw new AuthenticationError('Удаление аккаунта уже выполняется', 403, 'DELETION_PENDING');
  }
  if (options.enforceLegal !== false && !context.hasCurrentLegalAcceptance) {
    throw new AuthenticationError(
      'Примите текущие версии юридических документов',
      403,
      'LEGAL_ACCEPTANCE_REQUIRED',
    );
  }
  return context;
}

/**
 * Authorizes only the account owner's irreversible DELETE retry.
 *
 * `begin_user_account_purge` deliberately blocks every normal authenticated
 * action by setting `deletion_pending` before Storage and Auth data are
 * removed. A transient failure after that point must not make the purge
 * impossible to resume, so this narrow guard omits only the deletion-pending
 * rejection. It intentionally keeps the regular authentication and account
 * suspension checks and accepts no caller-supplied target ID.
 */
export async function requireAccountDeletionUser() {
  if (!isSupabaseConfigured()) {
    throw new AuthenticationError('Supabase не настроен', 503, 'SUPABASE_NOT_CONFIGURED');
  }
  const context = await getAuthContext();
  if (!context) throw new AuthenticationError('Требуется вход', 401, 'UNAUTHENTICATED');
  if (context.status !== 'active') {
    throw new AuthenticationError('Аккаунт приостановлен', 403, 'ACCOUNT_SUSPENDED');
  }
  return context;
}

export async function requireRole(roles: AppRole[]) {
  const context = await requireUser();
  if (!roles.includes(context.role)) {
    throw new AuthenticationError('Недостаточно прав', 403, 'FORBIDDEN');
  }
  return context;
}

export async function requireCapability(capability: AdminCapability) {
  void capability;
  const context = await requireRole(['admin']);
  return context;
}

export async function requireAnyCapability(capabilities: readonly AdminCapability[]) {
  void capabilities;
  const context = await requireRole(['admin']);
  return context;
}

export function safeRedirectPath(value: string | null | undefined, fallback = '/profile') {
  if (!value || !value.startsWith('/') || value.includes('\\')) return fallback;
  try {
    const base = new URL('https://safetyhub.local');
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

export function authenticatedLandingPath(role: AppRole) {
  return role === 'admin' ? '/admin' : '/profile';
}

export function getSiteUrl() {
  return resolveSiteOrigin();
}
