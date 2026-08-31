export type IdentityStatus = 'unverified' | 'verified' | 'revoked';

export type VerifiedIdentity = {
  userId: string;
  status: IdentityStatus;
  version: number;
  name: string;
  surname: string;
  job: string;
  organization: string;
  verifiedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};
