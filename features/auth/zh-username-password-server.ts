import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';
import { requireCapability } from '@/features/auth/server';
import { ZhUsernamePasswordError } from '@/features/auth/zh-username-password-api';
import {
  TurnstileVerificationUnavailableError,
  verifyTurnstileRegistrationToken,
} from '@/features/auth/turnstile-server';
import type {
  ZhUsernamePasswordLogin,
  ZhUsernamePasswordProvision,
  ZhUsernamePasswordRegistration,
  ZhUsernamePasswordReset,
} from '@/features/auth/zh-username-password-validation';
import { getCurrentLegalPolicies } from '@/lib/legal-current';
import { createAdminClient } from '@/lib/supabase/admin';
import { createEphemeralAuthClient } from '@/lib/supabase/ephemeral-auth';
import { createClient } from '@/lib/supabase/server';
import type { ZhUsernamePasswordRegistrationResult } from '@/lib/supabase/types';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYNTHETIC_EMAIL_PATTERN = /^[0-9a-f]{32}@auth[.]invalid$/u;
const DECOY_EMAIL = '00000000000000000000000000000000@auth.invalid';

type RpcError = { message: string; code?: string; status?: number };
type RpcClient = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

type LoginMapping = Readonly<{
  userId: string;
  syntheticEmail: string;
}>;

type ProvisionTarget = Readonly<{
  userId: string;
  state: 'legacy_passkey' | 'username_password' | 'username_password_pending';
}>;

type PasswordSignInResult = Awaited<
  ReturnType<ReturnType<typeof createEphemeralAuthClient>['auth']['signInWithPassword']>
>;
type AdminCreateUserResult = Awaited<
  ReturnType<ReturnType<typeof createAdminClient>['auth']['admin']['createUser']>
>;
type AdminUpdateUserResult = Awaited<
  ReturnType<ReturnType<typeof createAdminClient>['auth']['admin']['updateUserById']>
>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function serviceClient() {
  return createAdminClient() as unknown as RpcClient;
}

async function serviceRpc(name: string, args?: Record<string, unknown>) {
  try {
    const response = await serviceClient().rpc(name, args);
    if (response.error) throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
    return response.data;
  } catch (error) {
    if (error instanceof ZhUsernamePasswordError) throw error;
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
}

function parseLoginMapping(value: unknown): LoginMapping | null {
  if (value === null) return null;
  const result = record(value);
  if (
    !result ||
    typeof result.userId !== 'string' ||
    !UUID_PATTERN.test(result.userId) ||
    typeof result.syntheticEmail !== 'string' ||
    !SYNTHETIC_EMAIL_PATTERN.test(result.syntheticEmail)
  ) {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  return { userId: result.userId, syntheticEmail: result.syntheticEmail };
}

function parseProvisionTarget(value: unknown): ProvisionTarget | null {
  if (value === null) return null;
  const result = record(value);
  if (
    !result ||
    typeof result.userId !== 'string' ||
    !UUID_PATTERN.test(result.userId) ||
    (result.state !== 'legacy_passkey' &&
      result.state !== 'username_password' &&
      result.state !== 'username_password_pending')
  ) {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  return { userId: result.userId, state: result.state };
}

function parsePendingRegistration(value: unknown): ZhUsernamePasswordRegistrationResult {
  const result = record(value);
  if (
    !result ||
    typeof result.userId !== 'string' ||
    !UUID_PATTERN.test(result.userId) ||
    result.approvalState !== 'pending' ||
    typeof result.approvalRequestedAt !== 'string' ||
    typeof result.approvalDueAt !== 'string'
  ) {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  return {
    userId: result.userId,
    approvalState: 'pending',
    approvalRequestedAt: result.approvalRequestedAt,
    approvalDueAt: result.approvalDueAt,
  };
}

async function getLoginMapping(username: string) {
  return parseLoginMapping(
    await serviceRpc('get_zh_username_login_mapping', { p_username: username }),
  );
}

async function requireZhUsernamePasswordRollout(
  failureCode: 'ZH_AUTHENTICATION_FAILED' | 'ZH_REGISTRATION_FAILED',
) {
  const enabled = await serviceRpc('get_zh_username_password_rollout_enabled');
  if (enabled !== true) {
    throw new ZhUsernamePasswordError(
      failureCode,
      failureCode === 'ZH_AUTHENTICATION_FAILED' ? 401 : 400,
    );
  }
}

async function getProvisionTarget(userId: string) {
  return parseProvisionTarget(
    await serviceRpc('get_zh_username_provision_target', { p_user_id: userId }),
  );
}

function providerUnavailable(error: unknown) {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  return !status || status >= 500;
}

function exactSyntheticAuthUser(value: unknown, userId: string, syntheticEmail: string) {
  const user = record(value);
  return (
    user?.id === userId &&
    typeof user.email === 'string' &&
    user.email.toLowerCase() === syntheticEmail
  );
}

async function hasExactSyntheticAuthUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  syntheticEmail: string,
) {
  try {
    const found = await admin.auth.admin.getUserById(userId);
    return !found.error && exactSyntheticAuthUser(found.data.user, userId, syntheticEmail);
  } catch {
    return false;
  }
}

async function createZhRegistrationAuthUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  syntheticEmail: string,
  password: string,
) {
  let created: AdminCreateUserResult;
  try {
    created = await admin.auth.admin.createUser({
      id: userId,
      email: syntheticEmail,
      password,
      email_confirm: true,
      app_metadata: { safetyhub_auth_kind: 'zh_username_password' },
      user_metadata: { preferred_locale: 'zh' },
    });
  } catch {
    if (await hasExactSyntheticAuthUser(admin, userId, syntheticEmail)) return;
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }

  if (created.error) {
    if (await hasExactSyntheticAuthUser(admin, userId, syntheticEmail)) return;
    if (providerUnavailable(created.error)) {
      throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
    }
    throw new ZhUsernamePasswordError('ZH_REGISTRATION_FAILED', 400);
  }
  if (!exactSyntheticAuthUser(created.data.user, userId, syntheticEmail)) {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
}

async function deleteUnmappedZhRegistrationAuthUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
) {
  try {
    const deleted = await admin.auth.admin.deleteUser(userId);
    if (deleted.error) throw new Error('AUTH_DELETE_FAILED');
  } catch {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
}

function zhLandingPath(value: unknown) {
  const context = record(value);
  if (!context) return null;
  if (context.has_current_legal_acceptance !== true) return '/zh/auth/legal';
  if (context.role === 'admin') return '/admin';
  if (
    context.approval_state === 'pending' ||
    context.approval_state === 'approved' ||
    context.approval_state === 'rejected'
  ) {
    return '/zh/profile';
  }
  if (context.profile_onboarding_completed_at === null) return '/zh/onboarding';
  if (typeof context.profile_onboarding_completed_at === 'string') return '/zh/profile';
  return null;
}

async function persistPasswordSession(
  mapping: LoginMapping,
  password: string,
  captchaToken?: string,
) {
  let signedIn: PasswordSignInResult;
  try {
    signedIn = await createEphemeralAuthClient().auth.signInWithPassword({
      email: mapping.syntheticEmail,
      password,
      options: { captchaToken },
    });
  } catch {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }

  if (signedIn.error || !signedIn.data.session || signedIn.data.user?.id !== mapping.userId) {
    if (providerUnavailable(signedIn.error)) {
      throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
    }
    throw new ZhUsernamePasswordError('ZH_AUTHENTICATION_FAILED', 401);
  }

  let cookieClient: Awaited<ReturnType<typeof createClient>>;
  try {
    cookieClient = await createClient();
  } catch {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  const persisted = await cookieClient.auth.setSession({
    access_token: signedIn.data.session.access_token,
    refresh_token: signedIn.data.session.refresh_token,
  });
  if (persisted.error || !persisted.data.session || persisted.data.user?.id !== mapping.userId) {
    await cookieClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }

  const { data: context, error: contextError } = await cookieClient
    .rpc('get_auth_context')
    .maybeSingle();
  const redirectTo = !contextError ? zhLandingPath(context) : null;
  if (!redirectTo) {
    await cookieClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  return { verified: true as const, redirectTo };
}

async function performDecoyPasswordAttempt(password: string, captchaToken?: string) {
  try {
    await createEphemeralAuthClient().auth.signInWithPassword({
      email: DECOY_EMAIL,
      password,
      options: { captchaToken },
    });
  } catch {
    // This preserves a generic login response when a provider is unavailable.
    // No account identifier or password is logged or persisted here.
  }
}

export async function loginWithZhUsernamePassword(input: ZhUsernamePasswordLogin) {
  await requireZhUsernamePasswordRollout('ZH_AUTHENTICATION_FAILED');
  const mapping = await getLoginMapping(input.username);
  if (!mapping) {
    await performDecoyPasswordAttempt(input.password, input.captchaToken);
    throw new ZhUsernamePasswordError('ZH_AUTHENTICATION_FAILED', 401);
  }
  return persistPasswordSession(mapping, input.password, input.captchaToken);
}

export async function registerZhUsernamePassword(input: ZhUsernamePasswordRegistration) {
  await requireZhUsernamePasswordRollout('ZH_REGISTRATION_FAILED');

  let captchaVerified: boolean;
  try {
    captchaVerified = await verifyTurnstileRegistrationToken(input.captchaToken ?? '');
  } catch (error) {
    if (error instanceof TurnstileVerificationUnavailableError) {
      throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
    }
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  if (!captchaVerified) {
    throw new ZhUsernamePasswordError('ZH_REGISTRATION_FAILED', 400);
  }

  if (await getLoginMapping(input.username)) {
    throw new ZhUsernamePasswordError('ZH_REGISTRATION_FAILED', 400);
  }
  let legal: Awaited<ReturnType<typeof getCurrentLegalPolicies>>;
  try {
    legal = await getCurrentLegalPolicies();
  } catch {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }

  const userId = randomUUID();
  const syntheticEmail = randomBytes(16).toString('hex') + '@auth.invalid';
  const admin = createAdminClient();
  await createZhRegistrationAuthUser(admin, userId, syntheticEmail, input.password);

  let mapping: LoginMapping | null = null;
  try {
    const completed = parsePendingRegistration(
      await serviceRpc('complete_zh_username_registration', {
        p_user_id: userId,
        p_username: input.username,
        p_synthetic_email: syntheticEmail,
        p_privacy_version: legal.privacy.version,
        p_privacy_body_revision: legal.privacy.bodyRevision,
        p_terms_version: legal.terms.version,
        p_terms_body_revision: legal.terms.bodyRevision,
      }),
    );
    if (completed.userId !== userId) {
      throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
    }
    mapping = { userId, syntheticEmail };
  } catch {
    let recovered: LoginMapping | null;
    try {
      recovered = await getLoginMapping(input.username);
    } catch {
      // A failed read cannot prove whether the transaction committed. Keep the
      // exact synthetic Auth user intact for a later reconciliation.
      throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
    }

    if (recovered?.userId === userId) {
      mapping = recovered;
    } else {
      // Only a definite absent or mismatched mapping proves this just-created
      // Auth identity is safe to remove. Never delete on an unavailable read.
      await deleteUnmappedZhRegistrationAuthUser(admin, userId);
      throw new ZhUsernamePasswordError('ZH_REGISTRATION_FAILED', 400);
    }
  }

  if (!mapping) throw new ZhUsernamePasswordError('ZH_REGISTRATION_FAILED', 400);
  return { registered: true as const, redirectTo: '/zh/auth/login' as const };
}

async function updatePasswordAtProvider(targetUserId: string, password: string) {
  let updated: AdminUpdateUserResult;
  try {
    updated = await createAdminClient().auth.admin.updateUserById(targetUserId, { password });
  } catch {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  if (updated.error || updated.data.user?.id !== targetUserId) {
    if (providerUnavailable(updated.error)) {
      throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
    }
    throw new ZhUsernamePasswordError('ZH_RECOVERY_FAILED', 403);
  }
}

async function recordAdminRecovery(
  rpcName:
    | 'begin_zh_username_password_reset'
    | 'complete_zh_username_password_reset'
    | 'provision_zh_username_password',
  args: Record<string, unknown>,
) {
  let client: Awaited<ReturnType<typeof createClient>>;
  try {
    client = await createClient();
  } catch {
    throw new ZhUsernamePasswordError('ZH_AUTH_UNAVAILABLE', 503);
  }
  try {
    const response = await (client as unknown as RpcClient).rpc(rpcName, args);
    unwrapRpcMutationResponse(response);
  } catch {
    throw new ZhUsernamePasswordError('ZH_RECOVERY_FAILED', 403);
  }
}

export async function resetZhUsernamePassword(
  targetUserId: string,
  input: ZhUsernamePasswordReset,
) {
  await requireCapability('identity.manage');
  const target = await getProvisionTarget(targetUserId);
  if (
    !target ||
    target.userId !== targetUserId ||
    (target.state !== 'username_password' && target.state !== 'username_password_pending')
  ) {
    throw new ZhUsernamePasswordError('ZH_RECOVERY_FAILED', 403);
  }
  await recordAdminRecovery('begin_zh_username_password_reset', {
    p_target_user_id: targetUserId,
    p_reason: input.reason,
  });
  await updatePasswordAtProvider(targetUserId, input.password);
  await recordAdminRecovery('complete_zh_username_password_reset', {
    p_target_user_id: targetUserId,
    p_reason: input.reason,
  });
  return { reset: true as const };
}

export async function provisionZhUsernamePassword(
  targetUserId: string,
  input: ZhUsernamePasswordProvision,
) {
  await requireCapability('identity.manage');
  const target = await getProvisionTarget(targetUserId);
  if (!target || target.userId !== targetUserId || target.state !== 'legacy_passkey') {
    throw new ZhUsernamePasswordError('ZH_RECOVERY_FAILED', 403);
  }
  await recordAdminRecovery('provision_zh_username_password', {
    p_target_user_id: targetUserId,
    p_username: input.username,
    p_reason: input.reason,
  });
  await updatePasswordAtProvider(targetUserId, input.password);
  await recordAdminRecovery('complete_zh_username_password_reset', {
    p_target_user_id: targetUserId,
    p_reason: input.reason,
  });
  return { provisioned: true as const };
}
