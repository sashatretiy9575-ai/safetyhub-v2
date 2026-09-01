import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCurrentLegalPolicies } from '@/lib/legal-current';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNUP_NONCE_PATTERN = /^[0-9a-f]{64}$/;

type SignupLegalRpcError = { message: string };
type SignupLegalRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: SignupLegalRpcError | null }>;
};

export type SignupLegalCorrelation = {
  operationId: string;
  signupNonce: string;
};

export type PreparedSignupLegalOperation = SignupLegalCorrelation & {
  status: 'prepared' | 'completed';
  expiresAt?: string;
};

export type FinalizedSignupLegalOperation = {
  status: 'completed' | 'not_owned' | 'expired';
  accepted: boolean;
};

function rpcClient() {
  return createAdminClient() as unknown as SignupLegalRpcClient;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validSignupNonce(value: unknown): value is string {
  return typeof value === 'string' && SIGNUP_NONCE_PATTERN.test(value);
}

function parsePreparedOperation(
  value: unknown,
  expectedOperationId: string,
): Omit<PreparedSignupLegalOperation, keyof SignupLegalCorrelation> {
  const result = value as Record<string, unknown> | null;
  if (
    !result ||
    Array.isArray(result) ||
    (result.status !== 'prepared' && result.status !== 'completed') ||
    result.operationId !== expectedOperationId ||
    (result.expiresAt !== undefined && typeof result.expiresAt !== 'string')
  ) {
    throw new Error('SIGNUP_LEGAL_PREPARE_RESULT_INVALID');
  }
  return {
    status: result.status,
    ...(typeof result.expiresAt === 'string' ? { expiresAt: result.expiresAt } : {}),
  };
}

function parseFinalizedOperation(value: unknown): FinalizedSignupLegalOperation {
  const result = value as Record<string, unknown> | null;
  if (
    !result ||
    Array.isArray(result) ||
    (result.status !== 'completed' &&
      result.status !== 'not_owned' &&
      result.status !== 'expired') ||
    typeof result.accepted !== 'boolean' ||
    (result.status === 'completed' ? !result.accepted : result.accepted)
  ) {
    throw new Error('SIGNUP_LEGAL_FINALIZE_RESULT_INVALID');
  }
  return { status: result.status, accepted: result.accepted };
}

export async function prepareSignupLegalOperation(
  email: string,
): Promise<PreparedSignupLegalOperation> {
  const currentLegal = await getCurrentLegalPolicies();
  const operationId = randomUUID();
  const signupNonce = randomBytes(32).toString('hex');
  const nonceSha256 = createHash('sha256').update(signupNonce, 'utf8').digest('hex');
  const { data, error } = await rpcClient().rpc('prepare_signup_legal_operation', {
    p_operation_id: operationId,
    p_nonce_sha256: nonceSha256,
    p_email: email,
    p_privacy_version: currentLegal.privacy.version,
    p_privacy_body_revision: currentLegal.privacy.bodyRevision,
    p_terms_version: currentLegal.terms.version,
    p_terms_body_revision: currentLegal.terms.bodyRevision,
  });
  if (error) throw new Error('SIGNUP_LEGAL_PREPARE_FAILED');
  return {
    operationId,
    signupNonce,
    ...parsePreparedOperation(data, operationId),
  };
}

export async function finalizeSignupLegalOperation(
  correlation: SignupLegalCorrelation,
  userId: string,
): Promise<FinalizedSignupLegalOperation> {
  if (
    !validUuid(correlation.operationId) ||
    !validUuid(userId) ||
    !validSignupNonce(correlation.signupNonce)
  ) {
    return { status: 'not_owned', accepted: false };
  }
  const { data, error } = await rpcClient().rpc('finalize_signup_legal_operation', {
    p_operation_id: correlation.operationId,
    p_user_id: userId,
    p_signup_nonce: correlation.signupNonce,
  });
  if (error) throw new Error('SIGNUP_LEGAL_FINALIZE_FAILED');
  return parseFinalizedOperation(data);
}

export function signupLegalCorrelationFromUserMetadata(
  userMetadata: unknown,
): SignupLegalCorrelation | null {
  if (!userMetadata || typeof userMetadata !== 'object' || Array.isArray(userMetadata)) return null;
  const metadata = userMetadata as Record<string, unknown>;
  const operationId = metadata.safetyhubSignupOperationId;
  const signupNonce = metadata.safetyhubSignupNonce;
  if (!validUuid(operationId) || !validSignupNonce(signupNonce)) return null;
  return { operationId, signupNonce };
}
