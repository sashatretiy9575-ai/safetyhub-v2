/**
 * The decisions of scripts/import-document-profiles.mjs, kept free of I/O so
 * they are tested without a database or a real facsimile: what is missing,
 * what may be written to restore it, and what has to be left alone.
 *
 * The importer only ever adds. There is no operation kind for deleting or
 * overwriting, so no caller can be handed one: a stored object whose bytes do
 * not match its name stops the run instead of being replaced, and a reviewed
 * profile keeps every field except a binding that leads nowhere.
 */
import { parseArgs } from 'node:util';

export const OPERATION_KINDS = Object.freeze([
  'upload-object',
  'insert-asset-row',
  'create-profile',
  'bind-profile',
]);

const OBJECT_STATES = new Set(['ok', 'missing', 'corrupt']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export class ImportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ImportError';
    this.code = code;
  }
}

const ARGUMENTS = {
  manifest: { type: 'string' },
  target: { type: 'string' },
  'expected-host': { type: 'string' },
  apply: { type: 'boolean' },
  'rebind-current': { type: 'boolean' },
  // What --rebind-current was called while it could only redo the very first import.
  'replace-initial-assets': { type: 'boolean' },
  'normalize-to': { type: 'string' },
};

/** A misspelt flag must not quietly turn into a different run, so nothing unknown is accepted. */
export function parseImportArguments(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: ARGUMENTS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ImportError('IMPORT_ARGUMENT_INVALID', error.message);
  }
  if (!values.manifest) {
    throw new ImportError('IMPORT_MANIFEST_REQUIRED', '--manifest=<import-manifest.json>');
  }
  const options = {
    manifest: values.manifest,
    target: values.target ?? null,
    expectedHost: values['expected-host'] ?? null,
    apply: values.apply === true,
    rebindCurrent: values['rebind-current'] === true || values['replace-initial-assets'] === true,
    normalizeTo: values['normalize-to'] ?? null,
  };
  if (options.normalizeTo !== null) {
    if (options.normalizeTo === '')
      throw new ImportError('IMPORT_ARGUMENT_INVALID', '--normalize-to');
    if (options.apply) {
      throw new ImportError(
        'IMPORT_ARGUMENT_INVALID',
        '--normalize-to only writes local files; import the new manifest in a separate run',
      );
    }
    return options;
  }
  if (options.target !== 'local' && options.target !== 'linked') {
    throw new ImportError('IMPORT_TARGET_REQUIRED', '--target=local|linked');
  }
  return options;
}

/**
 * The environment decides where the run goes; the operator has to say the same
 * thing on the command line. The mismatch never names the host it found: an
 * operator who is told the right answer stops checking it.
 */
export function resolveImportTarget({ url, target, expectedHost }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImportError('IMPORT_ENVIRONMENT_INCOMPLETE');
  }
  const actual = LOCAL_HOSTS.has(parsed.hostname) ? 'local' : 'linked';
  if (target !== actual) {
    throw new ImportError('IMPORT_TARGET_MISMATCH', `the environment is a ${actual} project`);
  }
  if (actual === 'linked') {
    // The service key of a hosted project never travels in clear text.
    if (parsed.protocol !== 'https:') throw new ImportError('IMPORT_TARGET_INSECURE');
    if (expectedHost !== parsed.hostname) {
      throw new ImportError(
        'IMPORT_EXPECTED_HOST_MISMATCH',
        'a linked run needs --expected-host=<hostname of the project>',
      );
    }
  }
  return { target: actual, host: parsed.hostname };
}

// The import never re-encodes: the same file has the same sha256 on every
// machine, so the same facsimile is one row and one object everywhere. That
// only holds while the files are prepared once, to these limits.
export const CANONICAL_FILE = Object.freeze({
  maxLongSide: 720,
  minSide: 16,
  maxBytes: 1024 * 1024,
  minTransparentShare: 0.1,
});

/** `info` is what sharp reports about the file plus its size and share of transparent pixels. */
export function canonicalFileProblems(info) {
  const problems = [];
  if (info.format !== 'png') problems.push('not a PNG');
  else if (info.channels !== 4 || !info.hasAlpha || info.depth !== 'uchar' || info.palette) {
    problems.push('not an 8-bit RGBA PNG');
  }
  if ((info.pages ?? 1) !== 1) problems.push('more than one frame');
  const sides = [info.width, info.height];
  if (!sides.every((side) => Number.isInteger(side) && side >= CANONICAL_FILE.minSide)) {
    problems.push(`smaller than ${CANONICAL_FILE.minSide} px`);
  } else if (Math.max(...sides) > CANONICAL_FILE.maxLongSide) {
    problems.push(`long side over ${CANONICAL_FILE.maxLongSide} px`);
  }
  if (!(info.bytes <= CANONICAL_FILE.maxBytes)) problems.push('over 1 MiB');
  if (!(info.transparentShare >= CANONICAL_FILE.minTransparentShare)) {
    problems.push('background is not transparent');
  }
  return problems;
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUnbound = (value) => value === null || value === undefined || value === '';
// Postgres prints a uuid in lower case; a body may carry the same id in upper case.
const idKey = (value) => (typeof value === 'string' ? value.toLowerCase() : value);

/** The id of the row that registers each manifest file, or null while that row is missing. */
export function assetIdsByOwner(assets, assetRows) {
  const ids = {};
  for (const asset of assets) {
    const row = assetRows.find(
      (candidate) =>
        candidate.owner_id === asset.owner &&
        candidate.kind === asset.kind &&
        candidate.sha256 === asset.sha256,
    );
    ids[asset.owner] = row ? row.id : null;
  }
  return ids;
}

/**
 * `assetRows` has to be the whole table: a binding whose row is not in it is
 * taken for dangling and bound again, which would be wrong for a row that was
 * merely not read.
 */
export function createPlanContext({ assets, assetRows, rebindCurrent = false }) {
  const owners = new Set();
  for (const asset of assets) {
    if (owners.has(asset.owner)) throw new ImportError('IMPORT_MANIFEST_DUPLICATE', asset.owner);
    owners.add(asset.owner);
  }
  const ownersOf = (kind) =>
    new Set(assets.filter((asset) => asset.kind === kind).map((asset) => asset.owner));
  return {
    idsByOwner: assetIdsByOwner(assets, assetRows),
    signatureOwners: ownersOf('signature'),
    stampOwners: ownersOf('stamp'),
    rowsById: new Map(assetRows.map((row) => [idKey(row.id), row])),
    rebindCurrent,
  };
}

function classifyBinding(current, desiredId, context) {
  if (isUnbound(current)) return { state: 'unbound', action: 'bind' };
  if (desiredId !== null && idKey(current) === idKey(desiredId)) {
    return { state: 'ok', action: 'none' };
  }
  if (!context.rowsById.has(idKey(current))) return { state: 'dangling', action: 'bind' };
  // Another registered image: somebody chose it, or an earlier import did.
  return { state: 'differs', action: context.rebindCurrent ? 'rebind' : 'kept' };
}

/**
 * One profile: created when it is missing, otherwise only its bindings are
 * examined. `existing` is `{ body, version }` exactly as read, or null.
 */
export function planProfile(template, existing, context) {
  if (!context.stampOwners.has(template.stampOwner)) {
    throw new ImportError('IMPORT_TEMPLATE_STAMP_UNKNOWN', template.id);
  }
  if (!existing) {
    return {
      id: template.id,
      action: 'create',
      version: null,
      bindings: [],
      operation: { kind: 'create-profile', id: template.id },
    };
  }
  const { body, version } = existing;
  if (!isRecord(body) || !Array.isArray(body.commission)) {
    return { id: template.id, action: 'unreadable', version, bindings: [], operation: null };
  }

  const bindings = [];
  const present = new Set();
  body.commission.forEach((member, index) => {
    const owner = isRecord(member) && typeof member.signerId === 'string' ? member.signerId : '?';
    present.add(owner);
    if (!context.signatureOwners.has(owner)) {
      // A signer this manifest has no file for: nothing here could be bound.
      bindings.push({ slot: 'commission', index, owner, state: 'unmanaged', action: 'none' });
      return;
    }
    bindings.push({
      slot: 'commission',
      index,
      owner,
      ...classifyBinding(member.assetId, context.idsByOwner[owner], context),
    });
  });
  for (const member of template.body.commission) {
    // Removed from the commission on purpose; the importer does not bring people back.
    if (!present.has(member.signerId)) {
      bindings.push({
        slot: 'commission',
        index: null,
        owner: member.signerId,
        state: 'absent',
        action: 'none',
      });
    }
  }
  bindings.push({
    slot: 'stamp',
    index: null,
    owner: template.stampOwner,
    ...classifyBinding(body.stampAssetId, context.idsByOwner[template.stampOwner], context),
  });

  const writes = bindings
    .filter((binding) => binding.action === 'bind' || binding.action === 'rebind')
    .map(({ slot, index, owner }) => ({ slot, index, owner }));
  return {
    id: template.id,
    action: writes.length > 0 ? 'bind' : 'keep',
    version,
    bindings,
    operation:
      writes.length > 0
        ? { kind: 'bind-profile', id: template.id, version, bindings: writes }
        : null,
  };
}

/**
 * assets     [{ owner, kind, sha256 }] — the manifest files
 * assetRows  [{ id, owner_id, kind, sha256 }] — every row of document_assets
 * objectStates { [sha256]: 'ok' | 'missing' | 'corrupt' } — at least the manifest files
 * templates  [{ id, courseSlug, audience, stampOwner, body }]
 * profiles   [{ id, body, version }] — every row of document_profiles
 */
export function planDocumentImport({
  assets,
  assetRows,
  objectStates,
  templates,
  profiles,
  rebindCurrent = false,
}) {
  const context = createPlanContext({ assets, assetRows, rebindCurrent });
  const assetPlans = assets.map((asset) => {
    const object = objectStates[asset.sha256];
    if (!OBJECT_STATES.has(object)) throw new ImportError('IMPORT_OBJECT_UNCHECKED', asset.owner);
    const assetId = context.idsByOwner[asset.owner];
    return { ...asset, row: assetId === null ? 'missing' : 'exists', assetId, object };
  });

  const existing = new Map(profiles.map((profile) => [profile.id, profile]));
  const profilePlans = templates.map((template) =>
    planProfile(template, existing.get(template.id) ?? null, context),
  );
  const templateIds = new Set(templates.map((template) => template.id));
  const unmanagedProfiles = profiles
    .map((profile) => profile.id)
    .filter((id) => !templateIds.has(id));

  // Stored bytes that do not hash to their own name: the importer can neither
  // trust nor replace them, so the whole run stops before the first write.
  const blocked = assetPlans
    .filter((asset) => asset.object === 'corrupt')
    .map(({ owner }) => owner);
  const operations = [];
  if (blocked.length === 0) {
    for (const asset of assetPlans) {
      const objectKey = `${asset.sha256}.png`;
      // The object goes first: a row must never point at bytes that are not there.
      if (asset.object === 'missing') {
        operations.push({
          kind: 'upload-object',
          owner: asset.owner,
          sha256: asset.sha256,
          objectKey,
        });
      }
      if (asset.row === 'missing') {
        operations.push({
          kind: 'insert-asset-row',
          owner: asset.owner,
          assetKind: asset.kind,
          sha256: asset.sha256,
          objectKey,
        });
      }
    }
    for (const profile of profilePlans) if (profile.operation) operations.push(profile.operation);
  }
  return { assets: assetPlans, profiles: profilePlans, unmanagedProfiles, blocked, operations };
}

function requireAssetId(idsByOwner, owner) {
  const id = idsByOwner[owner];
  // Rows are inserted before any profile is written, so this is a bug, not a state.
  if (!id) throw new ImportError('IMPORT_ASSET_ID_UNRESOLVED', owner);
  return id;
}

/** The body of a profile that does not exist yet. A signer without a manifest file stays unbound. */
export function buildProfileBody(template, idsByOwner) {
  return {
    ...structuredClone(template.body),
    commission: template.body.commission.map((member) => ({
      ...member,
      assetId: member.signerId in idsByOwner ? requireAssetId(idsByOwner, member.signerId) : null,
    })),
    stampAssetId: requireAssetId(idsByOwner, template.stampOwner),
  };
}

/** A copy of `body` in which only the planned bindings differ; everything else is the admin's. */
export function patchProfileBindings(body, bindings, idsByOwner) {
  const next = structuredClone(body);
  for (const binding of bindings) {
    const assetId = requireAssetId(idsByOwner, binding.owner);
    if (binding.slot === 'stamp') {
      next.stampAssetId = assetId;
      continue;
    }
    const member = next.commission[binding.index];
    if (!isRecord(member) || member.signerId !== binding.owner) {
      throw new ImportError('IMPORT_BINDING_MISPLACED', binding.owner);
    }
    member.assetId = assetId;
  }
  return next;
}

/** Every asset id any profile refers to, so the caller knows which stored objects to check. */
export function boundAssetIds(profiles) {
  const ids = new Set();
  for (const { body } of profiles) {
    if (!isRecord(body)) continue;
    if (Array.isArray(body.commission)) {
      for (const member of body.commission) {
        if (isRecord(member) && !isUnbound(member.assetId)) ids.add(idKey(member.assetId));
      }
    }
    if (!isUnbound(body.stampAssetId)) ids.add(idKey(body.stampAssetId));
  }
  return ids;
}

/**
 * The read-only check after a run, over every profile and not only the
 * templates: a binding has to lead to a row of the right person and kind, and
 * that row to stored bytes with its sha256. An object nobody looked at counts
 * as a failure rather than as fine.
 */
export function verifyBindings({ profiles, assetRows, objectStates }) {
  const rowsById = new Map(assetRows.map((row) => [idKey(row.id), row]));
  const problems = [];
  let bindings = 0;
  for (const { id, body } of profiles) {
    if (!isRecord(body) || !Array.isArray(body.commission)) {
      problems.push(`${id}: unreadable body`);
      continue;
    }
    const check = (label, assetId, kind, owner) => {
      if (isUnbound(assetId)) return;
      bindings += 1;
      const row = rowsById.get(idKey(assetId));
      if (!row) {
        problems.push(`${id} ${label}: asset row missing`);
        return;
      }
      if (row.kind !== kind || (owner !== null && row.owner_id !== owner)) {
        problems.push(`${id} ${label}: bound to a ${row.kind} of ${row.owner_id}`);
      }
      const object = objectStates[row.sha256] ?? 'unchecked';
      if (object !== 'ok') problems.push(`${id} ${label}: object ${object}`);
    };
    for (const member of body.commission) {
      const owner = isRecord(member) && typeof member.signerId === 'string' ? member.signerId : '?';
      check(owner, isRecord(member) ? member.assetId : null, 'signature', owner);
    }
    check('stamp', body.stampAssetId, 'stamp', null);
  }
  return { bindings, problems };
}

function bindingLabel(binding) {
  const name = binding.slot === 'stamp' ? 'stamp' : binding.owner;
  const verdict = binding.action === 'none' ? binding.state : `${binding.state}→${binding.action}`;
  return `${name}: ${verdict}`;
}

/** The plan as printed. Ids, hashes and states only — never a path, a key or file contents. */
export function formatPlan(plan) {
  const width = (values) => Math.max(0, ...values.map((value) => value.length));
  const ownerWidth = width(plan.assets.map((asset) => asset.owner));
  const lines = ['assets'];
  for (const asset of plan.assets) {
    lines.push(
      `  ${asset.owner.padEnd(ownerWidth)}  ${asset.kind.padEnd(9)}  ${asset.sha256.slice(0, 12)}` +
        `  row: ${asset.row.padEnd(7)}  object: ${asset.object}`,
    );
  }
  lines.push('profiles');
  const label = (profile) =>
    profile.version === null ? profile.id : `${profile.id} v${profile.version}`;
  const labelWidth = width(plan.profiles.map(label));
  for (const profile of plan.profiles) {
    const detail =
      profile.action === 'create'
        ? 'create'
        : profile.action === 'unreadable'
          ? 'unreadable→kept'
          : [...profile.bindings.map(bindingLabel), 'text: kept'].join(' · ');
    lines.push(`  ${label(profile).padEnd(labelWidth)}  ${detail}`);
  }
  for (const id of plan.unmanagedProfiles) lines.push(`  ${id.padEnd(labelWidth)}  unmanaged→kept`);
  return lines;
}
