export const ADMIN_CAPABILITIES = [
  'content.manage',
  'test.manage',
  'support.view',
  'user.read',
  'user.invite',
  'user.suspend',
  'user.delete',
  'role.manage',
  'identity.read',
  'identity.manage',
  'certificate.read',
  'certificate.issue',
  'certificate.revoke',
  'results.read',
  'results.delete',
  'results.export',
  'site.settings.manage',
  'audit.read',
  'notifications.read',
  'capability.manage',
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

/**
 * Authoritative source of truth is the database: `get_auth_context` returns
 * the capabilities `private.actor_has_capability` grants, and the application
 * only ever narrows that list. Keeping a second preset here would document a
 * restriction the product does not enforce, which is exactly the failure this
 * module used to have.
 */
export function hasAdminCapability(capabilities: readonly string[], capability: AdminCapability) {
  return capabilities.includes(capability);
}

export function hasAnyAdminCapability(
  capabilities: readonly string[],
  required: readonly AdminCapability[],
) {
  return required.some((capability) => capabilities.includes(capability));
}

export function isAdminCapability(value: string): value is AdminCapability {
  return (ADMIN_CAPABILITIES as readonly string[]).includes(value);
}
