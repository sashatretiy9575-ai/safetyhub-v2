type DeploymentEnvironment = Record<string, string | undefined>;

const MINIMUM_SECRET_CHARACTERS = 32;

// Every value is read inside request handlers, never at module scope, so a
// deployment that is missing one still builds and still boots. It fails later:
// on the login screen, on every admin mutation, for a user who can do nothing
// about it. Asserting at build time turns that into a failed deployment, and a
// failed deployment leaves the previous one serving traffic.
const REQUIRED_DEPLOYMENT_SECRETS = [
  // Salts the coarse anti-abuse quota identifiers. Until this branch it fell
  // back to SUPABASE_SECRET_KEY, so an environment that never declared it kept
  // working by accident; dropping the fallback is what makes it mandatory.
  'RATE_LIMIT_HMAC_SECRET',
  // Signs the verification links printed onto issued certificates. Rotating it
  // without carrying the old value in CERTIFICATE_VERIFICATION_PREVIOUS_SECRET
  // invalidates every link already in circulation.
  'CERTIFICATE_VERIFICATION_SECRET',
  // The service-role key behind every createAdminClient() call: without it
  // sign-in, certificates and the whole admin area answer 500.
  'SUPABASE_SECRET_KEY',
] as const;

// Only production receives the Supabase Auth "Send Email" hook, so only
// production must verify it: without it the hook refuses every message and
// nobody receives a sign-in code. Preview deployments never get the hook, and
// the Vercel project keeps this secret in production alone.
const PRODUCTION_ONLY_SECRETS = ['SUPABASE_SEND_EMAIL_HOOK_SECRETS'] as const;

/**
 * Runs from next.config.ts, beside assertDeploymentSiteUrl. Local builds and CI
 * leave VERCEL_ENV unset and are deliberately untouched: the disposable stacks
 * supply their own throwaway values, and a missing secret there costs nothing.
 */
export function assertDeploymentRuntimeSecrets(environment: DeploymentEnvironment = process.env) {
  const target = environment.VERCEL_ENV;
  if (target !== 'production' && target !== 'preview') return;

  const missing: string[] = [];
  const tooShort: string[] = [];

  const required = [
    ...REQUIRED_DEPLOYMENT_SECRETS,
    ...(target === 'production' ? PRODUCTION_ONLY_SECRETS : []),
  ];
  for (const name of required) {
    const value = environment[name]?.trim();
    if (!value) missing.push(name);
    else if (value.length < MINIMUM_SECRET_CHARACTERS) tooShort.push(name);
  }

  if (missing.length === 0 && tooShort.length === 0) return;

  const problems = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
    tooShort.length > 0
      ? `shorter than ${MINIMUM_SECRET_CHARACTERS} characters: ${tooShort.join(', ')}`
      : null,
  ].filter(Boolean);

  throw new Error(
    `The ${target} deployment cannot serve requests — ${problems.join('; ')}. ` +
      'Add them to the Vercel project (Settings -> Environment Variables, or ' +
      '`vercel env add <NAME> production`) and redeploy. The previous deployment ' +
      'keeps serving traffic until this one builds.',
  );
}
