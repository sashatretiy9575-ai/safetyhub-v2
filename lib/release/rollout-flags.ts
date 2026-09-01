export const ROLLOUT_FEATURE_ENV = {
  localeRoutes: 'SAFETYHUB_LOCALE_ROUTES_ENABLED',
  zhPasskey: 'SAFETYHUB_ZH_PASSKEY_ENABLED',
  adminInbox: 'SAFETYHUB_ADMIN_INBOX_ENABLED',
} as const;

export type RolloutFeature = keyof typeof ROLLOUT_FEATURE_ENV;

type RolloutEnvironment = Readonly<Record<string, string | undefined>>;

function productionLike(environment: RolloutEnvironment) {
  return (
    environment.NODE_ENV === 'production' ||
    environment.VERCEL_ENV === 'production' ||
    environment.VERCEL_ENV === 'preview'
  );
}

/**
 * New externally reachable surfaces default open for development/tests and
 * closed for production-like deployments. Release operators must opt in with
 * the exact string `true`; malformed values remain fail-closed.
 */
export function rolloutFeatureEnabled(
  feature: RolloutFeature,
  environment: RolloutEnvironment = process.env,
) {
  const value = environment[ROLLOUT_FEATURE_ENV[feature]]?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return !productionLike(environment);
}
