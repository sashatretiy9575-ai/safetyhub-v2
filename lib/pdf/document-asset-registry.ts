import type { DocumentProfile } from './document-profile.ts';

/**
 * «Подписи и печать» as people think of them: whose hand, whose seal. A profile
 * names its images by asset id and every course has a profile of its own, so
 * the same signature is referenced from a dozen places. This module folds those
 * references into one entry per person (and one per stamp), and is the only
 * place that turns an owner into a caption — neither the server nor the editor
 * ever has to show an id or an object key instead of a name.
 */
export type DocumentAssetKind = 'signature' | 'stamp';
/** One row of `document_assets`, without the object key: the browser never needs it. */
export type DocumentAssetInfo = {
  id: string;
  ownerId: string;
  kind: DocumentAssetKind;
  createdAt: string;
};
export type DocumentAssetUse = { profileId: string; label: string };
export type DocumentAssetEntry = {
  ownerId: string;
  kind: DocumentAssetKind;
  title: string;
  holder: string;
  role: string;
  position: string;
  /** The image most profiles draw; null until one is uploaded. */
  assetId: string | null;
  createdAt: string | null;
  /** Profiles that draw `assetId`. */
  usedIn: DocumentAssetUse[];
  /** Profiles that have a place for this image but draw another one or none. */
  behind: DocumentAssetUse[];
};

/** A profile stores only `stampAssetId`; until one is bound the stamp belongs to the organization. */
export const DEFAULT_STAMP_OWNER = 'work-safety';
/** Stamp owners are organizations, and an organization's name is not derivable from its id. */
export const STAMP_HOLDERS: Readonly<Record<string, string>> = { 'work-safety': 'Work Safety' };

const CHAIRMAN_ROLE = 'Председатель';
const MEMBER_ROLE = 'Член комиссии';
const STAMP_ROLE = 'Организация';
const UNNAMED_SIGNER = 'Подписант';
const UNNAMED_ORGANIZATION = 'Организация';
/** A UUID, a digest or a file name: text that identifies a record, not a person. */
const MACHINE_TEXT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\.(?:png|jpe?g|webp|gif|svg|pdf)(?![a-zа-яё0-9])/iu;

function readable(text: string, fallback: string) {
  const value = text.trim();
  return value && !MACHINE_TEXT.test(value) ? value : fallback;
}

/**
 * The caption of a stamp. A known owner has its name in `STAMP_HOLDERS`. An
 * unknown one is read from its id, which the database keeps to lowercase latin
 * words joined by hyphens: every word gets a capital and the hyphens become
 * spaces (`acme-training` → «Acme Training»). An id that is itself a record
 * identifier says nothing to a person and becomes the generic «Организация».
 */
export function stampHolder(ownerId: string) {
  // `constructor` is a valid owner id; only the map's own keys are names.
  const known = Object.hasOwn(STAMP_HOLDERS, ownerId) ? STAMP_HOLDERS[ownerId] : undefined;
  if (known) return known;
  if (MACHINE_TEXT.test(ownerId)) return UNNAMED_ORGANIZATION;
  const words = ownerId.split('-').filter(Boolean);
  if (!words.length) return UNNAMED_ORGANIZATION;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Every asset id the profiles refer to, once: what the index has to be read for. */
export function referencedDocumentAssetIds(profiles: readonly DocumentProfile[]) {
  const ids = new Set<string>();
  for (const profile of profiles) {
    for (const person of profile.commission) if (person.assetId) ids.add(person.assetId);
    if (profile.stampAssetId) ids.add(profile.stampAssetId);
  }
  return [...ids];
}

type Reference = { profile: DocumentProfile; assetId: string | null };

/**
 * The image most profiles draw is the current one. Votes tie while a
 * replacement is half applied; the newer image is then the one that was meant.
 */
function settle(references: readonly Reference[], index: ReadonlyMap<string, DocumentAssetInfo>) {
  const votes = new Map<string, number>();
  for (const { assetId } of references) {
    if (assetId) votes.set(assetId, (votes.get(assetId) ?? 0) + 1);
  }
  const ranked = [...votes]
    .flatMap(([assetId, count]) => {
      const asset = index.get(assetId);
      return asset ? [{ asset, count }] : [];
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        Date.parse(b.asset.createdAt) - Date.parse(a.asset.createdAt) ||
        // Nothing else tells two images apart; the order only has to be the same every time.
        (a.asset.id < b.asset.id ? 1 : -1),
    );
  const current = ranked[0]?.asset ?? null;
  const use = ({ profile }: Reference) => ({ profileId: profile.id, label: profile.label });
  return {
    assetId: current?.id ?? null,
    createdAt: current?.createdAt ?? null,
    usedIn: references.filter((reference) => current && reference.assetId === current.id).map(use),
    behind: references.filter((reference) => !current || reference.assetId !== current.id).map(use),
  };
}

/**
 * One entry per signer and per stamp across all profiles: the chairman, the
 * members in commission order, the stamp last. Only registered images count —
 * an id the index does not know, or one registered to somebody else, is a
 * profile pointing elsewhere. `focusProfileId` is the profile open in the
 * editor: the same person may chair one commission and sit on another, and the
 * open profile is the one whose wording the administrator is looking at.
 */
export function buildDocumentAssetRegistry(
  profiles: readonly DocumentProfile[],
  assets: readonly DocumentAssetInfo[],
  focusProfileId?: string | null,
): DocumentAssetEntry[] {
  const index = new Map(assets.map((asset) => [asset.id, asset]));
  const focus = profiles.find((profile) => profile.id === focusProfileId);
  const naming = focus ? [focus, ...profiles.filter((profile) => profile !== focus)] : profiles;

  const signers = new Map<string, { holder: string; position: string; chairman: boolean }>();
  for (const profile of naming) {
    profile.commission.forEach((person, place) => {
      if (signers.has(person.signerId)) return;
      signers.set(person.signerId, {
        holder: readable(person.name, UNNAMED_SIGNER),
        position: person.position,
        chairman: place === 0,
      });
    });
  }

  const entries: DocumentAssetEntry[] = [];
  // Array.prototype.sort is stable: within a role the commission order survives.
  const seated = [...signers].sort(([, a], [, b]) => Number(b.chairman) - Number(a.chairman));
  for (const [ownerId, signer] of seated) {
    const references: Reference[] = [];
    for (const profile of profiles) {
      const seats = profile.commission.filter((person) => person.signerId === ownerId);
      if (!seats.length) continue;
      const drawn = new Set(
        seats.map((person) => {
          const asset = person.assetId ? index.get(person.assetId) : undefined;
          return asset?.kind === 'signature' && asset.ownerId === ownerId ? asset.id : null;
        }),
      );
      // Seats of one person that disagree are a profile to rebind, not a vote.
      references.push({ profile, assetId: drawn.size === 1 ? [...drawn][0]! : null });
    }
    entries.push({
      ownerId,
      kind: 'signature',
      title: `${signer.holder} — подпись`,
      holder: signer.holder,
      role: signer.chairman ? CHAIRMAN_ROLE : MEMBER_ROLE,
      position: signer.position,
      ...settle(references, index),
    });
  }

  const stamps = profiles.map((profile) => {
    const asset = profile.stampAssetId ? index.get(profile.stampAssetId) : undefined;
    return { profile, asset: asset?.kind === 'stamp' ? asset : null };
  });
  const bound = new Map<string, number>();
  for (const { asset } of stamps) {
    if (asset) bound.set(asset.ownerId, (bound.get(asset.ownerId) ?? 0) + 1);
  }
  const stampOwners = bound.size
    ? [...bound].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([ownerId]) => ownerId)
    : [DEFAULT_STAMP_OWNER];
  for (const ownerId of stampOwners) {
    const holder = stampHolder(ownerId);
    entries.push({
      ownerId,
      kind: 'stamp',
      title: `${holder} — печать`,
      holder,
      role: STAMP_ROLE,
      position: '',
      // Every profile has a place for the stamp, so every profile is either on this image or behind it.
      ...settle(
        stamps.map(({ profile, asset }) => ({
          profile,
          assetId: asset?.ownerId === ownerId ? asset.id : null,
        })),
        index,
      ),
    });
  }
  return entries;
}

/**
 * Whether an upload for this owner has anywhere to go. A signature needs a
 * seat in some commission; a stamp needs to be the one already in use, or the
 * organization's own when no profile has a stamp yet.
 */
export function isDocumentAssetOwner(
  profiles: readonly DocumentProfile[],
  assets: readonly DocumentAssetInfo[],
  ownerId: string,
  kind: DocumentAssetKind,
) {
  if (kind === 'signature') {
    return profiles.some((profile) =>
      profile.commission.some((person) => person.signerId === ownerId),
    );
  }
  if (ownerId === DEFAULT_STAMP_OWNER) return true;
  const index = new Map(assets.map((asset) => [asset.id, asset]));
  return profiles.some((profile) => {
    const asset = profile.stampAssetId ? index.get(profile.stampAssetId) : undefined;
    return asset?.kind === 'stamp' && asset.ownerId === ownerId;
  });
}

/**
 * The profile with the image bound, or null when it already is (or when the
 * signer has no seat in this commission). A stamp has one place per profile,
 * so its owner decides nothing here; a signature goes to every seat of its owner.
 */
export function bindDocumentAsset(
  profile: DocumentProfile,
  ownerId: string,
  kind: DocumentAssetKind,
  assetId: string | null,
): DocumentProfile | null {
  if (kind === 'stamp') {
    return profile.stampAssetId === assetId ? null : { ...profile, stampAssetId: assetId };
  }
  let changed = false;
  const commission = profile.commission.map((person) => {
    if (person.signerId !== ownerId || person.assetId === assetId) return person;
    changed = true;
    return { ...person, assetId };
  });
  return changed ? { ...profile, commission } : null;
}
