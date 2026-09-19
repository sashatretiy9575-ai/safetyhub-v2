import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_STAMP_OWNER,
  bindDocumentAsset,
  buildDocumentAssetRegistry,
  isDocumentAssetOwner,
  referencedDocumentAssetIds,
  stampHolder,
} from '../../lib/pdf/document-asset-registry.ts';

// Synthetic people and ids: the repository is public and the register is not.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CHAIR = id(1),
  FIRST = id(2),
  SECOND = id(3),
  STAMP = id(4);
const CHAIR_NEW = id(11),
  STAMP_NEW = id(14);
const asset = (assetId, ownerId, kind, createdAt = '2026-09-19T10:00:00+00:00') => ({
  id: assetId,
  ownerId,
  kind,
  createdAt,
});
const ASSETS = [
  asset(CHAIR, 'ivanov-ii', 'signature'),
  asset(FIRST, 'petrov-pp', 'signature'),
  asset(SECOND, 'sidorov-ss', 'signature'),
  asset(STAMP, 'work-safety', 'stamp'),
];
const commission = (chair = CHAIR, first = FIRST, second = SECOND) => [
  { signerId: 'ivanov-ii', name: 'Иванов И.И.', position: 'Директор', assetId: chair },
  { signerId: 'petrov-pp', name: 'Петров П.П.', position: 'Преподаватель', assetId: first },
  { signerId: 'sidorov-ss', name: 'Сидоров С.С.', position: 'Преподаватель', assetId: second },
];
const profile = (profileId, overrides = {}) => ({
  revision: 2,
  id: profileId,
  courseSlug: profileId,
  audience: 'all',
  label: `Курс ${profileId}`,
  programName: 'Программа',
  family: 'general',
  hours: null,
  validityMonths: 0,
  protocolText: '',
  decisionText: '',
  orderNumber: '',
  orderDate: '',
  verificationKind: '',
  commission: commission(),
  stampAssetId: STAMP,
  ...overrides,
});
const uses = (list) => list.map((use) => use.profileId);
const MACHINE = /[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{16,}|\.png|\.jpe?g|\.webp/iu;

test('every signer and the stamp is one entry, however many profiles draw it', () => {
  const profiles = ['alpha', 'beta', 'gamma'].map((name) => profile(name));
  const registry = buildDocumentAssetRegistry(profiles, ASSETS);
  assert.deepEqual(
    registry.map((entry) => [entry.ownerId, entry.kind]),
    [
      ['ivanov-ii', 'signature'],
      ['petrov-pp', 'signature'],
      ['sidorov-ss', 'signature'],
      ['work-safety', 'stamp'],
    ],
  );
  assert.deepEqual(
    registry.map((entry) => entry.title),
    [
      'Иванов И.И. — подпись',
      'Петров П.П. — подпись',
      'Сидоров С.С. — подпись',
      'Work Safety — печать',
    ],
  );
  assert.deepEqual(
    registry.map((entry) => entry.role),
    ['Председатель', 'Член комиссии', 'Член комиссии', 'Организация'],
  );
  assert.deepEqual(
    registry.map((entry) => entry.position),
    ['Директор', 'Преподаватель', 'Преподаватель', ''],
  );
  assert.deepEqual(
    registry.map((entry) => entry.assetId),
    [CHAIR, FIRST, SECOND, STAMP],
  );
  for (const entry of registry) {
    assert.equal(entry.createdAt, '2026-09-19T10:00:00+00:00');
    assert.deepEqual(
      entry.usedIn,
      profiles.map((item) => ({ profileId: item.id, label: item.label })),
    );
    assert.deepEqual(entry.behind, []);
  }
});

test('the image most profiles draw is current; the rest are behind it', () => {
  const profiles = [
    profile('alpha', { commission: commission(CHAIR_NEW) }),
    profile('beta', { commission: commission(CHAIR_NEW) }),
    profile('gamma'),
    profile('delta', { commission: commission(null), stampAssetId: null }),
  ];
  const assets = [
    ...ASSETS,
    asset(CHAIR_NEW, 'ivanov-ii', 'signature', '2026-09-20T08:00:00+00:00'),
  ];
  const [chairman, , , stamp] = buildDocumentAssetRegistry(profiles, assets);
  assert.equal(chairman.assetId, CHAIR_NEW);
  assert.equal(chairman.createdAt, '2026-09-20T08:00:00+00:00');
  assert.deepEqual(uses(chairman.usedIn), ['alpha', 'beta']);
  assert.deepEqual(uses(chairman.behind), ['gamma', 'delta']);
  assert.equal(stamp.assetId, STAMP);
  assert.deepEqual(uses(stamp.behind), ['delta']);

  // A replacement that reached half of the profiles: the newer image is the one that was meant.
  const tied = buildDocumentAssetRegistry(profiles.slice(1, 3), assets)[0];
  assert.equal(tied.assetId, CHAIR_NEW);
  assert.deepEqual(uses(tied.behind), ['gamma']);
});

test('a signer nobody has uploaded yet is an empty entry with every profile behind', () => {
  const profiles = [
    profile('alpha', { commission: commission(null, null, null), stampAssetId: null }),
  ];
  const registry = buildDocumentAssetRegistry(profiles, []);
  assert.equal(registry.length, 4);
  for (const entry of registry) {
    assert.equal(entry.assetId, null);
    assert.equal(entry.createdAt, null);
    assert.deepEqual(entry.usedIn, []);
    assert.deepEqual(uses(entry.behind), ['alpha']);
  }
  // No profile has a stamp, so nothing says whose it is: it is the organization's.
  assert.equal(registry[3].ownerId, DEFAULT_STAMP_OWNER);
  assert.equal(buildDocumentAssetRegistry([], []).at(-1).title, 'Work Safety — печать');
});

test('only a registered image of that very owner counts', () => {
  const profiles = [
    // An id the index has never heard of, a stamp in a signature's place and somebody else's signature.
    profile('alpha', { commission: commission(id(99), STAMP, CHAIR), stampAssetId: FIRST }),
  ];
  for (const entry of buildDocumentAssetRegistry(profiles, ASSETS)) {
    assert.equal(entry.assetId, null, entry.title);
    assert.deepEqual(uses(entry.behind), ['alpha']);
  }
});

test('the stamp belongs to whoever the index says, and an unknown owner is read from its id', () => {
  const other = id(24);
  const assets = [...ASSETS, asset(other, 'acme-training', 'stamp')];
  const profiles = [
    profile('alpha', { stampAssetId: other }),
    profile('beta', { stampAssetId: other }),
    profile('gamma'),
  ];
  const stamps = buildDocumentAssetRegistry(profiles, assets).filter(
    (entry) => entry.kind === 'stamp',
  );
  assert.deepEqual(
    stamps.map((entry) => entry.title),
    ['Acme Training — печать', 'Work Safety — печать'],
  );
  assert.deepEqual(uses(stamps[0].usedIn), ['alpha', 'beta']);
  // Replacing a stamp rebinds every profile, so the profiles on another stamp are behind this one.
  assert.deepEqual(uses(stamps[0].behind), ['gamma']);
  assert.deepEqual(uses(stamps[1].usedIn), ['gamma']);
  assert.deepEqual(uses(stamps[1].behind), ['alpha', 'beta']);
  assert.equal(stampHolder('work-safety'), 'Work Safety');
  assert.equal(stampHolder('uc-42'), 'Uc 42');
  // A valid owner id that is also a property every object inherits.
  assert.equal(stampHolder('constructor'), 'Constructor');
  // An owner id may legally be shaped like a UUID or a digest; neither is a name.
  assert.equal(stampHolder('a0000000-0000-4000-8000-000000000001'), 'Организация');
  assert.equal(stampHolder('deadbeefdeadbeefdeadbeef'), 'Организация');
});

test('the open profile words its own people; the lists of profiles do not move with it', () => {
  const swapped = [
    {
      signerId: 'petrov-pp',
      name: 'Петров Пётр Петрович',
      position: 'Председатель комиссии',
      assetId: FIRST,
    },
    { signerId: 'ivanov-ii', name: 'Иванов И.И.', position: 'Директор', assetId: CHAIR },
    { signerId: 'kim-aa', name: 'Ким А.А.', position: 'Инженер', assetId: null },
  ];
  const profiles = [profile('alpha'), profile('beta', { commission: swapped })];
  const plain = buildDocumentAssetRegistry(profiles, ASSETS);
  assert.deepEqual(
    plain.map((entry) => entry.ownerId),
    ['ivanov-ii', 'petrov-pp', 'sidorov-ss', 'kim-aa', 'work-safety'],
  );
  const focused = buildDocumentAssetRegistry(profiles, ASSETS, 'beta');
  // The open commission leads in its own order; people it does not seat follow.
  assert.deepEqual(
    focused.map((entry) => entry.ownerId),
    ['petrov-pp', 'ivanov-ii', 'kim-aa', 'sidorov-ss', 'work-safety'],
  );
  assert.deepEqual(
    focused.slice(0, 2).map((entry) => [entry.holder, entry.role, entry.position]),
    [
      ['Петров Пётр Петрович', 'Председатель', 'Председатель комиссии'],
      ['Иванов И.И.', 'Член комиссии', 'Директор'],
    ],
  );
  assert.deepEqual(uses(focused[0].usedIn), ['alpha', 'beta']);
  assert.deepEqual(uses(focused[2].behind), ['beta']);
  assert.deepEqual(buildDocumentAssetRegistry(profiles, ASSETS, 'no-such-profile'), plain);
  // A chairman met only in a later profile still stands before the members.
  const chaired = [
    { signerId: 'kim-aa', name: 'Ким А.А.', position: 'Директор', assetId: null },
    commission()[1],
  ];
  assert.deepEqual(
    buildDocumentAssetRegistry(
      [profile('alpha'), profile('beta', { commission: chaired })],
      ASSETS,
    ).map((entry) => entry.ownerId),
    ['ivanov-ii', 'kim-aa', 'petrov-pp', 'sidorov-ss', 'work-safety'],
  );
});

test('no caption ever shows an id, a digest or a file name', () => {
  const digest = 'ab'.repeat(32);
  const hostile = [
    { signerId: 'ivanov-ii', name: `${digest}.png`, position: 'Директор', assetId: CHAIR },
    { signerId: 'petrov-pp', name: CHAIR, position: '', assetId: FIRST },
    { signerId: 'sidorov-ss', name: 'podpis-final (2).PNG', position: '', assetId: SECOND },
  ];
  const stampId = id(34);
  const assets = [...ASSETS, asset(stampId, 'b1111111-2222-4333-8444-555555555555', 'stamp')];
  const registries = [
    buildDocumentAssetRegistry([profile('alpha'), profile('beta')], ASSETS, 'beta'),
    buildDocumentAssetRegistry(
      [profile('alpha', { commission: hostile, stampAssetId: stampId })],
      assets,
    ),
  ];
  for (const entry of registries.flat()) {
    for (const caption of [entry.title, entry.holder, entry.role]) {
      assert.ok(caption.length > 0);
      assert.doesNotMatch(caption, MACHINE, `${entry.ownerId}: ${caption}`);
      assert.ok(entry.assetId && !caption.includes(entry.assetId), `${entry.ownerId}: ${caption}`);
    }
  }
  assert.deepEqual(
    registries[1].map((entry) => entry.title),
    ['Подписант — подпись', 'Подписант — подпись', 'Подписант — подпись', 'Организация — печать'],
  );
});

test('binding touches the seats of one signer, or the one place of the stamp, and nothing else', () => {
  const stored = profile('alpha');
  const frozen = structuredClone(stored);
  const signed = bindDocumentAsset(stored, 'ivanov-ii', 'signature', CHAIR_NEW);
  assert.deepEqual(stored, frozen, 'the stored profile is not edited in place');
  assert.deepEqual(signed, { ...frozen, commission: commission(CHAIR_NEW) });
  assert.equal(signed.revision, 2);
  // Already bound, or no seat for this signer in the commission: nothing to write.
  assert.equal(bindDocumentAsset(signed, 'ivanov-ii', 'signature', CHAIR_NEW), null);
  assert.equal(bindDocumentAsset(stored, 'kim-aa', 'signature', CHAIR_NEW), null);
  // A person seated twice signs twice with the same hand.
  const twice = profile('beta', {
    commission: [...commission(), { ...commission()[0], position: 'Эксперт', assetId: null }],
  });
  assert.deepEqual(
    bindDocumentAsset(twice, 'ivanov-ii', 'signature', CHAIR_NEW).commission.map(
      (person) => person.assetId,
    ),
    [CHAIR_NEW, FIRST, SECOND, CHAIR_NEW],
  );

  const stamped = bindDocumentAsset(stored, 'work-safety', 'stamp', STAMP_NEW);
  assert.deepEqual(stamped, { ...frozen, stampAssetId: STAMP_NEW });
  assert.equal(bindDocumentAsset(stamped, 'work-safety', 'stamp', STAMP_NEW), null);
  assert.equal(
    bindDocumentAsset(profile('gamma', { stampAssetId: null }), 'work-safety', 'stamp', null),
    null,
  );
});

test('an upload needs somewhere to go: a seat for a signature, the stamp in use for a stamp', () => {
  const profiles = [profile('alpha'), profile('beta', { stampAssetId: null })];
  assert.equal(isDocumentAssetOwner(profiles, [], 'petrov-pp', 'signature'), true);
  assert.equal(isDocumentAssetOwner(profiles, [], 'kim-aa', 'signature'), false);
  // The organization's own stamp can always be uploaded, even as the very first image.
  assert.equal(isDocumentAssetOwner([], [], DEFAULT_STAMP_OWNER, 'stamp'), true);
  assert.equal(isDocumentAssetOwner(profiles, ASSETS, 'acme-training', 'stamp'), false);
  assert.equal(
    isDocumentAssetOwner(
      [profile('alpha', { stampAssetId: id(24) })],
      [asset(id(24), 'acme-training', 'stamp')],
      'acme-training',
      'stamp',
    ),
    true,
  );
  // A signer is not a stamp owner, and a signature asset in the stamp's place gives nobody the stamp.
  assert.equal(isDocumentAssetOwner(profiles, ASSETS, 'ivanov-ii', 'stamp'), false);
  assert.equal(
    isDocumentAssetOwner([profile('alpha', { stampAssetId: CHAIR })], ASSETS, 'ivanov-ii', 'stamp'),
    false,
  );
  assert.deepEqual(
    referencedDocumentAssetIds([...profiles, profile('gamma', { commission: commission(null) })]),
    [CHAIR, FIRST, SECOND, STAMP],
  );
});
