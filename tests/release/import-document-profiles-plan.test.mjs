import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CANONICAL_FILE,
  OPERATION_KINDS,
  buildProfileBody,
  canonicalFileProblems,
  createPlanContext,
  formatPlan,
  parseImportArguments,
  patchProfileBindings,
  planDocumentImport,
  planProfile,
  resolveImportTarget,
  verifyBindings,
} from '../../scripts/lib/document-import-plan.mjs';

// Synthetic people and hashes only: the real facsimiles never enter this repository.
const sha = (character) => character.repeat(64);
const ASSETS = [
  { owner: 'signer-one', kind: 'signature', sha256: sha('a') },
  { owner: 'signer-two', kind: 'signature', sha256: sha('b') },
  { owner: 'test-stamp', kind: 'stamp', sha256: sha('c') },
];
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function template(id) {
  return {
    id,
    courseSlug: id,
    audience: 'all',
    stampOwner: 'test-stamp',
    body: {
      id,
      courseSlug: id,
      audience: 'all',
      label: `Programme ${id}`,
      programName: `Programme ${id}`,
      family: 'general',
      hours: null,
      validityMonths: 0,
      protocolText: 'Template protocol text.',
      decisionText: 'Template decision text.',
      orderNumber: '',
      orderDate: '',
      verificationKind: '',
      commission: [
        { signerId: 'signer-one', name: 'Signer One', position: 'Chair', assetId: null },
        { signerId: 'signer-two', name: 'Signer Two', position: 'Member', assetId: null },
      ],
      stampAssetId: null,
    },
  };
}
const TEMPLATES = [template('course-a'), template('course-b')];

// `nextId` plays the database: a new row gets an id that was never used before.
const emptyState = () => ({ assetRows: [], objectStates: {}, profiles: [], nextId: 1 });
const plan = (state, options = {}) =>
  planDocumentImport({
    assets: ASSETS,
    templates: TEMPLATES,
    ...state,
    objectStates: {
      ...Object.fromEntries(ASSETS.map((asset) => [asset.sha256, 'missing'])),
      ...state.objectStates,
    },
    ...options,
  });

/** What the script does with a plan, against memory instead of Supabase. */
function execute(state, planned, options = {}) {
  const next = structuredClone(state);
  for (const operation of planned.operations) {
    if (operation.kind === 'upload-object') next.objectStates[operation.sha256] = 'ok';
    if (operation.kind === 'insert-asset-row') {
      next.assetRows.push({
        id: uuid(next.nextId++),
        owner_id: operation.owner,
        kind: operation.assetKind,
        sha256: operation.sha256,
      });
    }
  }
  const context = createPlanContext({ assets: ASSETS, assetRows: next.assetRows, ...options });
  for (const operation of planned.operations) {
    const source = TEMPLATES.find((candidate) => candidate.id === operation.id);
    if (operation.kind === 'create-profile') {
      next.profiles.push({
        id: operation.id,
        version: 1,
        body: buildProfileBody(source, context.idsByOwner),
      });
    }
    if (operation.kind === 'bind-profile') {
      const profile = next.profiles.find((candidate) => candidate.id === operation.id);
      assert.equal(profile.version, operation.version, 'compare-and-swap on the planned version');
      profile.body = patchProfileBindings(profile.body, operation.bindings, context.idsByOwner);
      profile.version += 1;
    }
  }
  return next;
}

/** A fully imported stand, the starting point of every repair scenario. */
function installed() {
  const state = emptyState();
  return execute(state, plan(state));
}

const kinds = (planned) => planned.operations.map((operation) => operation.kind);
const profileOf = (state, id) => state.profiles.find((profile) => profile.id === id);
const bindingOf = (planned, id, name) =>
  planned.profiles
    .find((profile) => profile.id === id)
    .bindings.find((binding) => (binding.slot === 'stamp' ? 'stamp' : binding.owner) === name);

test('an empty stand gets every object, row and profile, and the second run changes nothing', () => {
  const first = plan(emptyState());
  assert.deepEqual(kinds(first), [
    'upload-object',
    'insert-asset-row',
    'upload-object',
    'insert-asset-row',
    'upload-object',
    'insert-asset-row',
    'create-profile',
    'create-profile',
  ]);
  assert.ok(first.assets.every((asset) => asset.row === 'missing' && asset.object === 'missing'));
  assert.ok(first.profiles.every((profile) => profile.action === 'create'));

  const state = execute(emptyState(), first);
  assert.equal(state.assetRows.length, 3);
  for (const profile of state.profiles) {
    assert.deepEqual(
      profile.body.commission.map((member) => member.assetId),
      [uuid(1), uuid(2)],
    );
    assert.equal(profile.body.stampAssetId, uuid(3));
  }

  const second = plan(state);
  assert.deepEqual(second.operations, []);
  assert.ok(second.assets.every((asset) => asset.row === 'exists' && asset.object === 'ok'));
  assert.ok(second.profiles.every((profile) => profile.action === 'keep'));
  assert.deepEqual(plan(execute(state, second)).operations, []);
});

test('a missing profile is created while the existing one is left alone', () => {
  const state = installed();
  state.profiles = state.profiles.filter((profile) => profile.id !== 'course-b');
  const planned = plan(state);
  assert.deepEqual(planned.operations, [{ kind: 'create-profile', id: 'course-b' }]);
  assert.ok(formatPlan(planned).some((line) => /course-b\s+create$/u.test(line)));
  assert.deepEqual(plan(execute(state, planned)).operations, []);
});

test('only the missing half of an asset is restored: the object or the row, never a duplicate', () => {
  const lostObject = installed();
  lostObject.objectStates[sha('c')] = 'missing';
  assert.deepEqual(plan(lostObject).operations, [
    { kind: 'upload-object', owner: 'test-stamp', sha256: sha('c'), objectKey: `${sha('c')}.png` },
  ]);

  const lostRow = installed();
  lostRow.assetRows = lostRow.assetRows.filter((row) => row.owner_id !== 'signer-two');
  const planned = plan(lostRow);
  // Every profile pointed at the lost row, so each binding now dangles.
  assert.deepEqual(kinds(planned), ['insert-asset-row', 'bind-profile', 'bind-profile']);
  assert.equal(bindingOf(planned, 'course-a', 'signer-two').state, 'dangling');
  const repaired = execute(lostRow, planned);
  assert.deepEqual(
    repaired.assetRows.filter((row) => row.owner_id === 'signer-two').map((row) => row.id),
    [uuid(4)],
  );
  for (const profile of repaired.profiles) {
    assert.equal(profile.body.commission[1].assetId, uuid(4));
    assert.equal(profile.version, 2);
  }
  assert.deepEqual(plan(repaired).operations, []);
});

test('edited profile text is kept, with and without a binding to repair', () => {
  const state = installed();
  const edited = profileOf(state, 'course-a');
  Object.assign(edited.body, {
    hours: 72,
    validityMonths: 36,
    protocolText: 'Reviewed by the administrator.',
    decisionText: 'Reviewed decision.',
    orderNumber: '17-П',
    reviewerNote: 'a field this importer has never heard of',
  });
  edited.body.commission[0].position = 'Reviewed position';
  edited.version = 7;

  const untouched = plan(state);
  assert.deepEqual(untouched.operations, []);
  assert.ok(
    formatPlan(untouched).every(
      (line) => !line.includes('course-a') || line.endsWith('text: kept'),
    ),
  );

  edited.body.commission[1].assetId = null;
  const before = structuredClone(edited.body);
  const planned = plan(state);
  assert.deepEqual(planned.operations, [
    {
      kind: 'bind-profile',
      id: 'course-a',
      version: 7,
      bindings: [{ slot: 'commission', index: 1, owner: 'signer-two' }],
    },
  ]);
  const after = profileOf(execute(state, planned), 'course-a');
  assert.equal(after.version, 8);
  assert.equal(after.body.commission[1].assetId, uuid(2));
  // Put the one repaired binding back and nothing else may differ.
  after.body.commission[1].assetId = null;
  assert.deepEqual(after.body, before);
});

test('an empty binding is bound', () => {
  const state = installed();
  profileOf(state, 'course-a').body.commission[0].assetId = null;
  profileOf(state, 'course-b').body.stampAssetId = null;
  const planned = plan(state);
  assert.deepEqual(bindingOf(planned, 'course-a', 'signer-one'), {
    slot: 'commission',
    index: 0,
    owner: 'signer-one',
    state: 'unbound',
    action: 'bind',
  });
  assert.equal(bindingOf(planned, 'course-b', 'stamp').state, 'unbound');
  const lines = formatPlan(planned).join('\n');
  assert.match(lines, /signer-one: unbound→bind · signer-two: ok · stamp: ok · text: kept/u);
  assert.match(lines, /signer-one: ok · signer-two: ok · stamp: unbound→bind · text: kept/u);

  const repaired = execute(state, planned);
  assert.equal(profileOf(repaired, 'course-a').body.commission[0].assetId, uuid(1));
  assert.equal(profileOf(repaired, 'course-b').body.stampAssetId, uuid(3));
  assert.deepEqual(plan(repaired).operations, []);
});

test('a binding to a row that does not exist is bound again', () => {
  const state = installed();
  profileOf(state, 'course-a').body.stampAssetId = uuid(999);
  profileOf(state, 'course-a').body.commission[0].assetId = 'not-even-a-uuid';
  const planned = plan(state);
  assert.equal(bindingOf(planned, 'course-a', 'stamp').state, 'dangling');
  assert.equal(bindingOf(planned, 'course-a', 'signer-one').state, 'dangling');
  assert.match(
    formatPlan(planned).join('\n'),
    /signer-one: dangling→bind .* stamp: dangling→bind/u,
  );

  const repaired = execute(state, planned);
  assert.equal(profileOf(repaired, 'course-a').body.stampAssetId, uuid(3));
  assert.equal(profileOf(repaired, 'course-a').body.commission[0].assetId, uuid(1));
  assert.deepEqual(plan(repaired).operations, []);
});

test('a binding to another registered image is kept, and rebound only on request', () => {
  const state = installed();
  // An earlier generation of the same signature, still registered.
  state.assetRows.push({
    id: uuid(50),
    owner_id: 'signer-one',
    kind: 'signature',
    sha256: sha('d'),
  });
  profileOf(state, 'course-a').body.commission[0].assetId = uuid(50).toUpperCase();

  const kept = plan(state);
  assert.deepEqual(kept.operations, []);
  assert.deepEqual(
    { ...bindingOf(kept, 'course-a', 'signer-one') },
    { slot: 'commission', index: 0, owner: 'signer-one', state: 'differs', action: 'kept' },
  );
  assert.match(formatPlan(kept).join('\n'), /signer-one: differs→kept/u);

  const rebound = plan(state, { rebindCurrent: true });
  assert.deepEqual(kinds(rebound), ['bind-profile']);
  assert.match(formatPlan(rebound).join('\n'), /signer-one: differs→rebind/u);
  const repaired = execute(state, rebound, { rebindCurrent: true });
  assert.equal(profileOf(repaired, 'course-a').body.commission[0].assetId, uuid(1));
  assert.deepEqual(plan(repaired, { rebindCurrent: true }).operations, []);
  // The superseded row stays registered: issued documents still show it.
  assert.ok(repaired.assetRows.some((row) => row.id === uuid(50)));
});

test('the same id in another letter case is the same binding', () => {
  const state = installed();
  profileOf(state, 'course-a').body.stampAssetId = uuid(3).toUpperCase();
  assert.deepEqual(plan(state).operations, []);
});

test('a commission the administrator changed is respected', () => {
  const state = installed();
  const body = profileOf(state, 'course-a').body;
  body.commission = [
    body.commission[1],
    { signerId: 'guest-expert', name: 'Guest Expert', position: 'Invited', assetId: null },
  ];
  const planned = plan(state);
  assert.deepEqual(planned.operations, []);
  assert.match(
    formatPlan(planned).join('\n'),
    /course-a v1\s+signer-two: ok · guest-expert: unmanaged · signer-one: absent · stamp: ok/u,
  );
});

test('stored bytes that do not match their name stop the whole run', () => {
  const state = installed();
  state.objectStates[sha('a')] = 'corrupt';
  state.objectStates[sha('b')] = 'missing';
  state.profiles = [];
  const planned = plan(state);
  assert.deepEqual(planned.blocked, ['signer-one']);
  assert.deepEqual(planned.operations, []);
  assert.match(
    formatPlan(planned).join('\n'),
    /signer-one\s+signature\s+a{12}\s+row: exists\s+object: corrupt/u,
  );
});

test('no plan ever deletes, overwrites or duplicates', () => {
  assert.deepEqual([...OPERATION_KINDS].sort(), [
    'bind-profile',
    'create-profile',
    'insert-asset-row',
    'upload-object',
  ]);
  const objectStates = ['ok', 'missing', 'corrupt'];
  const bindings = [undefined, null, '', uuid(1), uuid(50), uuid(999), 42];
  let plans = 0;
  for (const object of objectStates) {
    for (const rowExists of [true, false]) {
      for (const binding of bindings) {
        for (const rebindCurrent of [false, true]) {
          const state = installed();
          state.assetRows.push({
            id: uuid(50),
            owner_id: 'signer-one',
            kind: 'signature',
            sha256: sha('d'),
          });
          state.objectStates[sha('a')] = object;
          if (!rowExists) state.assetRows = state.assetRows.filter((row) => row.id !== uuid(1));
          profileOf(state, 'course-a').body.commission[0].assetId = binding;
          state.profiles = state.profiles.filter((profile) => profile.id !== 'course-b');

          const planned = plan(state, { rebindCurrent });
          plans += 1;
          for (const operation of planned.operations) {
            assert.ok(OPERATION_KINDS.includes(operation.kind), operation.kind);
            assert.doesNotMatch(operation.kind, /delete|remove|overwrite|replace|upsert|update/u);
          }
          if (object === 'corrupt') assert.deepEqual(planned.operations, []);
          // An upload only fills a gap, a row is only inserted where none exists.
          assert.equal(kinds(planned).includes('upload-object'), object === 'missing');
          assert.equal(
            kinds(planned).includes('insert-asset-row'),
            object !== 'corrupt' && !rowExists,
          );
          assert.ok(
            planned.operations.every(
              (operation) => operation.kind !== 'create-profile' || operation.id === 'course-b',
            ),
          );
          if (object !== 'corrupt') {
            assert.deepEqual(
              plan(execute(state, planned, { rebindCurrent }), { rebindCurrent }).operations,
              [],
            );
          }
        }
      }
    }
  }
  assert.equal(plans, 84);
});

test('a profile changed between plan and write is planned again from what was read', () => {
  const state = installed();
  const stale = structuredClone(profileOf(state, 'course-a'));
  stale.body.stampAssetId = null;
  const context = createPlanContext({ assets: ASSETS, assetRows: state.assetRows });
  assert.equal(planProfile(TEMPLATES[0], stale, context).operation.version, 1);

  // Meanwhile the administrator saved new text: the version moved on.
  const fresh = structuredClone(stale);
  fresh.version = 2;
  fresh.body.protocolText = 'Saved a second ago.';
  const replanned = planProfile(TEMPLATES[0], fresh, context);
  assert.equal(replanned.operation.version, 2);
  const body = patchProfileBindings(fresh.body, replanned.operation.bindings, context.idsByOwner);
  assert.equal(body.protocolText, 'Saved a second ago.');
  assert.equal(body.stampAssetId, uuid(3));
  assert.equal(fresh.body.stampAssetId, null, 'the body that was read is not mutated');

  assert.throws(
    () =>
      patchProfileBindings(
        fresh.body,
        [{ slot: 'commission', index: 1, owner: 'signer-one' }],
        context.idsByOwner,
      ),
    /IMPORT_BINDING_MISPLACED/u,
  );
  assert.throws(
    () =>
      buildProfileBody(TEMPLATES[0], {
        'signer-one': uuid(1),
        'signer-two': null,
        'test-stamp': uuid(3),
      }),
    /IMPORT_ASSET_ID_UNRESOLVED: signer-two/u,
  );
});

test('an unreadable body and a profile outside the templates are reported, never rewritten', () => {
  const state = installed();
  profileOf(state, 'course-a').body = { commission: 'lost' };
  state.profiles.push({
    id: 'made-by-hand',
    version: 3,
    body: { commission: [], stampAssetId: uuid(999) },
  });
  const planned = plan(state);
  assert.deepEqual(planned.operations, []);
  assert.deepEqual(planned.unmanagedProfiles, ['made-by-hand']);
  const lines = formatPlan(planned).join('\n');
  assert.match(lines, /course-a v1\s+unreadable→kept/u);
  assert.match(lines, /made-by-hand\s+unmanaged→kept/u);

  const verified = verifyBindings(state);
  assert.deepEqual(verified.problems, [
    'course-a: unreadable body',
    'made-by-hand stamp: asset row missing',
  ]);
});

test('verification follows every binding to a row of the right person and to intact bytes', () => {
  const healthy = installed();
  assert.deepEqual(verifyBindings(healthy), { bindings: 6, problems: [] });

  const broken = installed();
  broken.objectStates[sha('a')] = 'missing';
  delete broken.objectStates[sha('b')];
  profileOf(broken, 'course-b').body.stampAssetId = uuid(1);
  profileOf(broken, 'course-b').body.commission[1].assetId = null;
  assert.deepEqual(verifyBindings(broken).problems, [
    'course-a signer-one: object missing',
    'course-a signer-two: object unchecked',
    'course-b signer-one: object missing',
    'course-b stamp: bound to a signature of signer-one',
    'course-b stamp: object missing',
  ]);
});

test('the plan prints hashes and states, not file contents or paths', () => {
  const lines = formatPlan(plan(emptyState()));
  assert.deepEqual(lines, [
    'assets',
    `  signer-one  signature  ${'a'.repeat(12)}  row: missing  object: missing`,
    `  signer-two  signature  ${'b'.repeat(12)}  row: missing  object: missing`,
    `  test-stamp  stamp      ${'c'.repeat(12)}  row: missing  object: missing`,
    'profiles',
    '  course-a  create',
    '  course-b  create',
  ]);
  assert.ok(lines.every((line) => !line.includes(sha('a'))));
});

test('arguments: dry run by default, the old flag name still works, nothing unknown is accepted', () => {
  assert.deepEqual(parseImportArguments(['--manifest=m.json', '--target=local']), {
    manifest: 'm.json',
    target: 'local',
    expectedHost: null,
    apply: false,
    rebindCurrent: false,
    normalizeTo: null,
  });
  const linked = parseImportArguments([
    '--manifest=m.json',
    '--target=linked',
    '--expected-host=project.example',
    '--apply',
    '--replace-initial-assets',
  ]);
  assert.equal(linked.apply, true);
  assert.equal(linked.rebindCurrent, true);
  assert.equal(linked.expectedHost, 'project.example');
  assert.equal(
    parseImportArguments(['--manifest=m', '--target=local', '--rebind-current']).rebindCurrent,
    true,
  );
  assert.equal(
    parseImportArguments(['--manifest=m', '--normalize-to=../out']).normalizeTo,
    '../out',
  );

  assert.throws(() => parseImportArguments(['--target=local']), /IMPORT_MANIFEST_REQUIRED/u);
  assert.throws(() => parseImportArguments(['--manifest=m']), /IMPORT_TARGET_REQUIRED/u);
  assert.throws(
    () => parseImportArguments(['--manifest=m', '--target=prod']),
    /IMPORT_TARGET_REQUIRED/u,
  );
  assert.throws(
    () => parseImportArguments(['--manifest=m', '--target=local', '--aply']),
    /IMPORT_ARGUMENT_INVALID/u,
  );
  assert.throws(
    () => parseImportArguments(['--manifest=m', '--target=local', '--apply=no']),
    /IMPORT_ARGUMENT_INVALID/u,
  );
  assert.throws(
    () => parseImportArguments(['--manifest=m', '--normalize-to=out', '--apply']),
    /IMPORT_ARGUMENT_INVALID/u,
  );
});

test('the target named on the command line has to be the one the environment points at', () => {
  assert.deepEqual(
    resolveImportTarget({ url: 'http://127.0.0.1:54321', target: 'local', expectedHost: null }),
    {
      target: 'local',
      host: '127.0.0.1',
    },
  );
  assert.deepEqual(
    resolveImportTarget({
      url: 'https://project.example',
      target: 'linked',
      expectedHost: 'project.example',
    }),
    { target: 'linked', host: 'project.example' },
  );
  const hosted = { url: 'https://project.example', expectedHost: 'project.example' };
  assert.throws(
    () => resolveImportTarget({ ...hosted, target: 'local' }),
    /IMPORT_TARGET_MISMATCH/u,
  );
  assert.throws(
    () =>
      resolveImportTarget({
        url: 'http://localhost:54321',
        target: 'linked',
        expectedHost: 'localhost',
      }),
    /IMPORT_TARGET_MISMATCH/u,
  );
  assert.throws(
    () => resolveImportTarget({ ...hosted, target: 'linked', expectedHost: null }),
    /IMPORT_EXPECTED_HOST_MISMATCH/u,
  );
  assert.throws(
    () => resolveImportTarget({ ...hosted, target: 'linked', expectedHost: 'other.example' }),
    /IMPORT_EXPECTED_HOST_MISMATCH/u,
  );
  assert.throws(
    () =>
      resolveImportTarget({
        url: 'http://project.example',
        target: 'linked',
        expectedHost: 'project.example',
      }),
    /IMPORT_TARGET_INSECURE/u,
  );
  assert.throws(
    () => resolveImportTarget({ url: undefined, target: 'local', expectedHost: null }),
    /IMPORT_ENVIRONMENT_INCOMPLETE/u,
  );
  // The refusal must not hand over the host it was supposed to be told.
  assert.throws(
    () => resolveImportTarget({ ...hosted, target: 'linked', expectedHost: 'other.example' }),
    (error) => !error.message.includes('project.example'),
  );
});

test('only a prepared file is imported: 8-bit RGBA PNG, 720 px, 1 MiB, transparent background', () => {
  const canonical = {
    format: 'png',
    width: 720,
    height: 283,
    channels: 4,
    depth: 'uchar',
    hasAlpha: true,
    palette: false,
    pages: 1,
    bytes: CANONICAL_FILE.maxBytes,
    transparentShare: 0.1,
  };
  assert.deepEqual(canonicalFileProblems(canonical), []);
  const problems = (change) => canonicalFileProblems({ ...canonical, ...change });
  assert.deepEqual(problems({ format: 'webp' }), ['not a PNG']);
  assert.deepEqual(problems({ channels: 3, hasAlpha: false }), ['not an 8-bit RGBA PNG']);
  assert.deepEqual(problems({ depth: 'ushort' }), ['not an 8-bit RGBA PNG']);
  assert.deepEqual(problems({ palette: true }), ['not an 8-bit RGBA PNG']);
  assert.deepEqual(problems({ pages: 2 }), ['more than one frame']);
  assert.deepEqual(problems({ height: 721 }), ['long side over 720 px']);
  assert.deepEqual(problems({ width: 8 }), ['smaller than 16 px']);
  assert.deepEqual(problems({ bytes: CANONICAL_FILE.maxBytes + 1 }), ['over 1 MiB']);
  assert.deepEqual(problems({ transparentShare: 0.09 }), ['background is not transparent']);
  assert.deepEqual(problems({ transparentShare: Number.NaN }), ['background is not transparent']);
});

test('the script itself has no call that deletes or overwrites, and keeps its guards', async () => {
  const source = await readFile(
    new URL('../../scripts/import-document-profiles.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\.(?:delete|remove|upsert|move|copy|emptyBucket|deleteBucket)\(/u);
  assert.doesNotMatch(source, /upsert:\s*true/u);
  assert.match(source, /upsert: false/u);
  assert.match(source, /flag: 'wx'/u);
  assert.match(source, /resolveImportTarget\(/u);
  assert.match(source, /\.eq\('version', existing\.version\)/u);
  assert.doesNotMatch(source, /DOCUMENT_PROFILE_CONFLICT/u);
  // The planner stays importable without a database client or an image codec.
  const planner = await readFile(
    new URL('../../scripts/lib/document-import-plan.mjs', import.meta.url),
    'utf8',
  );
  assert.deepEqual(
    [...planner.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]),
    ['node:util'],
  );
});
