import 'server-only';

import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import type { Json, LegalAcceptanceRow } from '@/lib/supabase/types';
import type {
  ApprovedIdentity,
  ProfileIdentityState,
  ProfileValues,
} from '@/features/profile/fields';
import type { AppLocale } from '@/i18n/config';

export type ProfileAttestation = {
  attestationId: string;
  testId: string;
  testVersion: number;
  testSlug: string;
  courseTitle: string;
  isCurrent: boolean;
  score: number | null;
  total: number;
  passScore: number;
  completedAt: string | null;
  resultState: 'not_started' | 'passed' | 'failed';
  certificateState: 'not_eligible' | 'pending_identity' | 'ready' | 'issued' | 'revoked';
  certificateId: string | null;
  certificateNumber: string | null;
  certificateScore: number | null;
  issuedAt: string | null;
};

export type LegalAcceptance = Omit<LegalAcceptanceRow, 'user_id'>;

export type ProfileDashboard = {
  profile: ProfileValues & {
    id: string;
    avatarUpdatedAt: string | null;
    onboardingCompletedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  approvedIdentity: ApprovedIdentity | null;
  identityState: ProfileIdentityState;
  attestations: ProfileAttestation[];
  legalAcceptances: LegalAcceptance[];
};

type SectionResult<T> = { state: 'ready'; data: T } | { state: 'failed'; correlationId: string };

type UntypedRpcClient = {
  rpc(
    name:
      | 'get_profile_dashboard'
      | 'get_profile_dashboard_locale'
      | 'get_my_profile_avatar_manifest',
    args?: Record<string, never> | { p_locale: AppLocale },
  ): PromiseLike<{
    data: Json;
    error: { message: string; code?: string | null } | null;
  }>;
};

const avatarManifestSchema = z.object({
  objectKey: z.string().min(1).max(256),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024),
  legacyImported: z.boolean(),
  updatedAt: z.string(),
});

function isOwnedAvatarObjectKey(userId: string, objectKey: string, legacyImported: boolean) {
  if (legacyImported) return objectKey === `${userId}/avatar.webp`;
  return new RegExp(
    `^${userId}/objects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`,
    'iu',
  ).test(objectKey);
}

const profileAttestationSchema = z.object({
  attestationId: z.string().uuid(),
  testId: z.string().uuid(),
  testVersion: z.number().int().positive(),
  testSlug: z.string().min(1),
  courseTitle: z.string().min(1),
  isCurrent: z.boolean(),
  score: z.number().int().nonnegative().nullable(),
  total: z.number().int().positive(),
  passScore: z.number().int().nonnegative(),
  completedAt: z.string().nullable(),
  resultState: z.enum(['not_started', 'passed', 'failed']),
  certificateState: z.enum(['not_eligible', 'pending_identity', 'ready', 'issued', 'revoked']),
  certificateId: z.string().uuid().nullable(),
  certificateNumber: z.string().nullable(),
  certificateScore: z.number().int().nonnegative().nullable(),
  issuedAt: z.string().nullable(),
});

const dashboardSchema = z.object({
  profile: z.object({
    id: z.string().uuid(),
    name: z.string(),
    surname: z.string(),
    job: z.string(),
    organization: z.string(),
    avatarUpdatedAt: z.string().nullable(),
    onboardingCompletedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  approvedIdentity: z
    .object({
      version: z.number().int().nonnegative(),
      name: z.string(),
      surname: z.string(),
      job: z.string(),
      organization: z.string(),
      verifiedAt: z.string(),
      verifiedBy: z.string().uuid().nullable(),
    })
    .nullable(),
  identityState: z.enum(['pending', 'verified', 'changed', 'revoked']),
  attestations: z.array(profileAttestationSchema),
  legalAcceptances: z.array(
    z
      .object({
        documentType: z.enum(['privacy', 'terms']),
        version: z.string(),
        acceptedAt: z.string(),
        source: z.enum(['registration', 'profile']),
      })
      .transform((value) => ({
        document_type: value.documentType,
        version: value.version,
        accepted_at: value.acceptedAt,
        source: value.source,
      })),
  ),
});

function loadFailure(section: string, error: unknown): SectionResult<never> {
  const correlationId = randomUUID();
  const cause =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code.slice(0, 64)
      : error instanceof z.ZodError
        ? 'INVALID_RESPONSE_SHAPE'
        : 'UNKNOWN_PROFILE_DATA_ERROR';
  console.error('PROFILE_SECTION_LOAD_FAILED', { correlationId, section, cause });
  return { state: 'failed', correlationId };
}

export const getProfileDashboard = cache(
  async (locale: AppLocale): Promise<SectionResult<ProfileDashboard>> => {
  try {
    const supabase = (await createClient()) as unknown as UntypedRpcClient;
    const { data, error } = await supabase.rpc('get_profile_dashboard_locale', {
      p_locale: locale,
    });
    if (error) return loadFailure('dashboard', error);
    const parsed = dashboardSchema.safeParse(data);
    if (!parsed.success) return loadFailure('dashboard', parsed.error);
    return { state: 'ready', data: parsed.data };
  } catch (error) {
    return loadFailure('dashboard', error);
  }
  },
);

export const getProfileAvatarUrl = cache(async (userId: string) => {
  try {
    const supabase = (await createClient()) as unknown as UntypedRpcClient;
    const manifestResult = await supabase.rpc('get_my_profile_avatar_manifest');
    if (manifestResult.error) return null;
    const manifest = avatarManifestSchema.safeParse(manifestResult.data);
    if (
      !manifest.success ||
      !isOwnedAvatarObjectKey(userId, manifest.data.objectKey, manifest.data.legacyImported)
    )
      return null;
    const storage = await createClient();
    const { data, error } = await storage.storage
      .from('profile-avatars')
      .createSignedUrl(manifest.data.objectKey, 10 * 60);
    if (error) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
});
