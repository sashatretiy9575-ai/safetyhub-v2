/**
 * Restores the private, content-addressed facsimiles and the course document
 * profiles: whatever is missing is created, whatever exists stays as it is.
 * It can be run as often as needed — a second run reports `changes: 0`.
 *
 *   node --env-file=.env.local scripts/import-document-profiles.mjs \
 *     --manifest=artifacts/document-assets-2026-09/optimized/import-manifest.json --target=local
 *
 * Without --apply this is a dry run: the plan is printed and nothing is written.
 *   --apply            upload missing objects, insert missing asset rows, create missing
 *                      profiles; in an existing profile repair only a binding that is empty
 *                      or points at a row that is gone. No other field is ever written.
 *   --rebind-current   also move a binding that points at another registered image to the
 *                      manifest's (accepted under its old name --replace-initial-assets)
 *   --target=linked --expected-host=<hostname>   needed for a hosted project
 *   --normalize-to=<dir>   only prepare files: write canonical copies and their manifest
 *                      into <dir>, which has to be outside the repository or git-ignored
 *
 * The import never re-encodes an image, so a file has the same sha256 — one row,
 * one object — on every machine. It deletes nothing and overwrites nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import {
  ImportError,
  boundAssetIds,
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
} from './lib/document-import-plan.mjs';

const BUCKET = 'document-facsimiles';
const MANIFEST_NAME = 'import-manifest.json';
const ASSET_COLUMNS = 'id,owner_id,kind,sha256';
const PROFILE_COLUMNS = 'id,body,version';
const PAGE = 1000;
const UNIQUE_VIOLATION = '23505';
const DECODE_PIXELS = 4096 * 4096;
const SOURCE_MAX_BYTES = 32 * 1024 * 1024;
// The ladder and the byte budget of the document editor's own upload
// (server/certificates/facsimile-image.ts): a facsimile prepared here is the
// file the editor would have stored. Every certificate of a large export
// decodes the image again, which is why it is kept this small.
const NORMALIZED_LONG_SIDES = [720, 560, 420];
const NORMALIZED_MAX_BYTES = 400 * 1024;

const STAMP_OWNER = 'work-safety';
const OWNERS = [
  ['bitemirov-au', 'signature'],
  ['akhmetzhanov-em', 'signature'],
  ['kudiyarov-am', 'signature'],
  [STAMP_OWNER, 'stamp'],
];
const COMMISSION = [
  ['bitemirov-au', 'Битемиров А.У.', 'Директор ТОО «Work Safety (Уорк Сэйфти)»'],
  ['akhmetzhanov-em', 'Ахметжанов Е.М.', 'Преподаватель ТОО «Work Safety (Уорк Сэйфти)»'],
  ['kudiyarov-am', 'Кудияров А.М.', 'Преподаватель ТОО «Work Safety (Уорк Сэйфти)»'],
];
const COURSES = [
  ['plotnik', 'Плотник', 'general'],
  ['armaturshchik', 'Арматурщик', 'general'],
  ['lesomontazhnye-raboty', 'Лесомонтажные работы', 'qualification'],
  ['biot', 'Безопасность и охрана труда', 'biot'],
  ['pozharnaya-bezopasnost', 'Пожарно-технический минимум', 'ptm'],
  ['svarshchik', 'Сварщик', 'general'],
  ['promyshlennaya-bezopasnost', 'Промышленная безопасность', 'industrial'],
];

/** What a profile looks like on its first import. An existing one is never compared with it. */
function profileTemplates() {
  const templates = [];
  for (const [courseSlug, programName, family] of COURSES) {
    const audiences = ['biot', 'ptm', 'industrial'].includes(family) ? ['worker', 'itr'] : ['all'];
    for (const audience of audiences) {
      const id = `${courseSlug}-${audience}`;
      const suffix =
        audience === 'itr' ? ' — ИТР' : audience === 'worker' ? ' — рабочий состав' : '';
      templates.push({
        id,
        courseSlug,
        audience,
        stampOwner: STAMP_OWNER,
        body: {
          id,
          courseSlug,
          audience,
          label: `${programName}${suffix}`,
          programName,
          family,
          hours: ['ptm', 'industrial'].includes(family) ? (audience === 'itr' ? 40 : 10) : null,
          validityMonths: 0,
          protocolText:
            'Проверка знаний проведена в соответствии с утверждённой программой на тему: «{program}».',
          decisionText:
            'Результаты проверки знаний зафиксированы настоящим протоколом. Допуск к самостоятельной работе оформляет работодатель в установленном порядке.',
          orderNumber: '',
          orderDate: '',
          verificationKind: '',
          commission: COMMISSION.map(([signerId, name, position]) => ({
            signerId,
            name,
            position,
            assetId: null,
          })),
          stampAssetId: null,
        },
      });
    }
  }
  return templates;
}

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readManifestFiles(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    throw new ImportError('IMPORT_MANIFEST_UNREADABLE');
  }
  const directory = path.dirname(path.resolve(manifestPath));
  const files = [];
  for (const [owner, kind] of OWNERS) {
    if (typeof manifest?.[owner] !== 'string' || manifest[owner] === '') {
      throw new ImportError('IMPORT_MANIFEST_ENTRY_MISSING', owner);
    }
    const file = path.resolve(directory, manifest[owner]);
    let bytes;
    try {
      const { size } = await fs.stat(file);
      if (size > SOURCE_MAX_BYTES) throw new Error('too large');
      bytes = await fs.readFile(file);
    } catch {
      throw new ImportError('IMPORT_FILE_UNREADABLE', owner);
    }
    files.push({ owner, kind, bytes });
  }
  return files;
}

/** Decodes every pixel rather than trusting the header: a truncated PNG breaks each document that embeds it. */
async function inspectImage(owner, bytes) {
  try {
    const options = { failOn: 'warning', limitInputPixels: DECODE_PIXELS };
    const meta = await sharp(bytes, options).metadata();
    const { data, info } = await sharp(bytes, options)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let transparent = 0;
    for (let index = 3; index < data.length; index += info.channels) {
      if (data[index] < 16) transparent += 1;
    }
    return {
      format: meta.format,
      width: meta.width,
      height: meta.height,
      channels: meta.channels,
      depth: meta.depth,
      hasAlpha: meta.hasAlpha,
      palette: Boolean(meta.paletteBitDepth),
      pages: meta.pages ?? 1,
      bytes: bytes.length,
      transparentShare: transparent / (info.width * info.height),
    };
  } catch {
    throw new ImportError('IMPORT_FILE_UNREADABLE', owner);
  }
}

async function canonicalAssets(files) {
  const assets = [];
  for (const { owner, kind, bytes } of files) {
    const problems = canonicalFileProblems(await inspectImage(owner, bytes));
    if (problems.length > 0) {
      throw new ImportError(
        'IMPORT_FILE_NOT_CANONICAL',
        `${owner}: ${problems.join(', ')}; prepare the files once with --normalize-to=<dir>`,
      );
    }
    assets.push({ owner, kind, bytes, sha256: sha256Hex(bytes) });
  }
  return assets;
}

async function normalizeImage(bytes) {
  const options = { failOn: 'warning', limitInputPixels: DECODE_PIXELS };
  const trimmed = await sharp(bytes, options)
    .ensureAlpha()
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
    .png()
    .toBuffer()
    .catch(() => null);
  // A fully opaque image has no margin to trim; sharp refuses, the source stays.
  const base = trimmed ?? bytes;
  for (const side of NORMALIZED_LONG_SIDES) {
    const png = await sharp(base, options)
      .ensureAlpha()
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    if (png.byteLength <= NORMALIZED_MAX_BYTES) return png;
  }
  return null;
}

async function throughLinks(target) {
  const missing = [];
  for (let current = target; ; current = path.dirname(current)) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      missing.push(path.basename(current));
    }
  }
}

function gitIgnores(repository, relative) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relative], {
      cwd: repository,
      stdio: 'ignore',
    });
    return true;
  } catch {
    // Exit 1 says the path could be committed; any other failure means git could not tell.
    return false;
  }
}

/** The repository is public: a signature written into a tracked directory is one `git add` from being published. */
async function privateDirectory(directory) {
  const repository = await fs.realpath(path.resolve(import.meta.dirname, '..'));
  const target = await throughLinks(path.resolve(directory));
  const inside = path.relative(repository, target);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    return target;
  }
  // Inside the repository only git can say whether the files would stay untracked.
  if (inside !== '' && gitIgnores(repository, path.join(inside, MANIFEST_NAME))) return target;
  throw new ImportError(
    'IMPORT_NORMALIZE_TARGET_TRACKED',
    'write the files outside the repository or into a git-ignored directory',
  );
}

/** Prepared files are what the sha256 of a registered facsimile stands for, so none is ever replaced. */
async function writeOnce(file, content) {
  const bytes = Buffer.from(content);
  try {
    await fs.writeFile(file, bytes, { flag: 'wx' });
    return 'written';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (bytes.equals(await fs.readFile(file))) return 'unchanged';
    throw new ImportError('IMPORT_NORMALIZE_TARGET_EXISTS', path.basename(file));
  }
}

async function normalizeInto(directory, files, log) {
  const target = await privateDirectory(directory);
  const prepared = [];
  for (const { owner, bytes } of files) {
    const source = await inspectImage(owner, bytes);
    // Encoding a canonical file again would give the same picture a second
    // sha256, and with it a second row and object: it is copied as it is.
    const canonical = canonicalFileProblems(source).length === 0;
    const png = canonical ? bytes : await normalizeImage(bytes);
    if (!png) {
      throw new ImportError(
        'IMPORT_FILE_NOT_CANONICAL',
        `${owner}: over ${NORMALIZED_MAX_BYTES / 1024} KiB even at ${NORMALIZED_LONG_SIDES.at(-1)} px`,
      );
    }
    const result = canonical ? source : await inspectImage(owner, png);
    const problems = canonicalFileProblems(result);
    if (problems.length > 0) {
      throw new ImportError('IMPORT_FILE_NOT_CANONICAL', `${owner}: ${problems.join(', ')}`);
    }
    prepared.push({ owner, png, result, how: canonical ? 'copied' : 'normalized' });
  }
  // Nothing is written until every file has passed.
  await fs.mkdir(target, { recursive: true });
  const width = Math.max(...prepared.map(({ owner }) => owner.length));
  for (const { owner, png, result, how } of prepared) {
    const state = await writeOnce(path.join(target, `${owner}.png`), png);
    log(
      `${how.padEnd(10)}  ${owner.padEnd(width)}  ${result.width}×${result.height}  ` +
        `${png.length} B  ${sha256Hex(png).slice(0, 12)}  ${state}`,
    );
  }
  const manifest = Object.fromEntries(prepared.map(({ owner }) => [owner, `${owner}.png`]));
  await writeOnce(path.join(target, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest: ${path.join(target, MANIFEST_NAME)}`);
}

// Only the code and the message: an error object may carry the request it came from.
const failure = (code, step, error) =>
  new ImportError(code, `${step}: ${[error?.code, error?.message].filter(Boolean).join(' ')}`);

function connect(options) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ImportError('IMPORT_ENVIRONMENT_INCOMPLETE');
  const target = resolveImportTarget({
    url,
    target: options.target,
    expectedHost: options.expectedHost,
  });
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, ...target };
}

async function readAll(client, table, columns) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw failure('IMPORT_DATABASE_FAILED', `read ${table}`, error);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function readProfile(client, id) {
  const { data, error } = await client
    .from('document_profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw failure('IMPORT_DATABASE_FAILED', `read profile ${id}`, error);
  return data;
}

async function requirePrivateBucket(client) {
  const { data, error } = await client.storage.getBucket(BUCKET);
  if (error) throw failure('IMPORT_BUCKET_UNAVAILABLE', BUCKET, error);
  if (data.public) throw new ImportError('IMPORT_BUCKET_PUBLIC', BUCKET);
}

async function objectState(client, sha256) {
  const { data, error } = await client.storage.from(BUCKET).download(`${sha256}.png`);
  if (error) {
    // The local stack answers 400 with statusCode "404", a hosted project answers 404.
    const missing = error.status === 404 || String(error.statusCode) === '404';
    if (missing) return 'missing';
    // Anything else leaves the state unknown, and an unknown state is not "missing".
    throw failure('IMPORT_STORAGE_FAILED', `read object ${sha256.slice(0, 12)}`, error);
  }
  return sha256Hex(Buffer.from(await data.arrayBuffer())) === sha256 ? 'ok' : 'corrupt';
}

/** Everything a plan and a verification need, read in one pass. */
async function readState(client, assets) {
  const assetRows = await readAll(client, 'document_assets', ASSET_COLUMNS);
  const profiles = await readAll(client, 'document_profiles', PROFILE_COLUMNS);
  const bound = boundAssetIds(profiles);
  const hashes = new Set(assets.map((asset) => asset.sha256));
  for (const row of assetRows) if (bound.has(row.id.toLowerCase())) hashes.add(row.sha256);
  const objectStates = {};
  for (const sha256 of hashes) objectStates[sha256] = await objectState(client, sha256);
  return { assetRows, profiles, objectStates };
}

async function applyAssetOperation(client, operation, bytes) {
  if (operation.kind === 'upload-object') {
    const { error } = await client.storage.from(BUCKET).upload(operation.objectKey, bytes, {
      contentType: 'image/png',
      upsert: false,
      cacheControl: '31536000',
    });
    if (!error) return 'uploaded';
    // A parallel run stored the same bytes first; the verification reads them back.
    if (/already exists|duplicate/iu.test(error.message)) return null;
    throw failure('IMPORT_STORAGE_FAILED', `upload ${operation.owner}`, error);
  }
  const { error } = await client.from('document_assets').insert({
    owner_id: operation.owner,
    kind: operation.assetKind,
    sha256: operation.sha256,
    object_key: operation.objectKey,
  });
  if (!error) return 'inserted';
  if (error.code === UNIQUE_VIOLATION) return null;
  throw failure('IMPORT_DATABASE_FAILED', `insert asset ${operation.owner}`, error);
}

/**
 * The first attempt acts on the profile as the plan saw it. If somebody saved
 * it in between, the version no longer matches: it is read once more, planned
 * again from that body, and a second miss ends the run.
 */
async function ensureProfile(client, template, snapshot, context, log) {
  let existing = snapshot;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const planned = planProfile(template, existing, context);
    if (!planned.operation) return 0;
    if (planned.action === 'create') {
      const { error } = await client.from('document_profiles').insert({
        id: template.id,
        course_slug: template.courseSlug,
        audience: template.audience,
        body: buildProfileBody(template, context.idsByOwner),
      });
      if (!error) {
        log(`  created   ${template.id}`);
        return 1;
      }
      if (error.code !== UNIQUE_VIOLATION) {
        throw failure('IMPORT_DATABASE_FAILED', `create profile ${template.id}`, error);
      }
      existing = await readProfile(client, template.id);
      // The course and audience belong to a profile with another id: not ours to touch.
      if (!existing) throw new ImportError('IMPORT_PROFILE_SLOT_TAKEN', template.id);
      continue;
    }
    const { data, error } = await client
      .from('document_profiles')
      .update({
        body: patchProfileBindings(existing.body, planned.operation.bindings, context.idsByOwner),
        version: existing.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', template.id)
      .eq('version', existing.version)
      .select('version')
      .maybeSingle();
    if (error) throw failure('IMPORT_DATABASE_FAILED', `bind profile ${template.id}`, error);
    if (data) {
      const names = planned.operation.bindings.map(({ slot, owner }) =>
        slot === 'stamp' ? 'stamp' : owner,
      );
      log(`  bound     ${template.id} v${existing.version}→v${data.version}: ${names.join(', ')}`);
      return 1;
    }
    existing = await readProfile(client, template.id);
  }
  throw new ImportError('IMPORT_PROFILE_CONFLICT', template.id);
}

async function applyPlan(client, { assets, templates, plan, state, rebindCurrent }, progress, log) {
  log('applied');
  const bytesByOwner = new Map(assets.map((asset) => [asset.owner, asset.bytes]));
  for (const operation of plan.operations) {
    if (operation.kind !== 'upload-object' && operation.kind !== 'insert-asset-row') continue;
    const done = await applyAssetOperation(client, operation, bytesByOwner.get(operation.owner));
    if (!done) continue;
    progress.changes += 1;
    log(`  ${done.padEnd(8)}  ${operation.owner} ${operation.sha256.slice(0, 12)}`);
  }
  // The database chose the ids of the new rows; profiles are planned against them.
  const assetRows = await readAll(client, 'document_assets', ASSET_COLUMNS);
  const context = createPlanContext({ assets, assetRows, rebindCurrent });
  const snapshots = new Map(state.profiles.map((profile) => [profile.id, profile]));
  for (const template of templates) {
    progress.changes += await ensureProfile(
      client,
      template,
      snapshots.get(template.id) ?? null,
      context,
      log,
    );
  }
  if (progress.changes === 0) log('  nothing');
}

/** Read-only: nothing is left to do and every binding of every profile leads to intact bytes. */
function verify(state, { assets, templates, rebindCurrent }, log) {
  const after = planDocumentImport({ assets, templates, rebindCurrent, ...state });
  const { bindings, problems } = verifyBindings(state);
  for (const owner of after.blocked) problems.push(`${owner}: object corrupt`);
  if (after.operations.length > 0) problems.push(`${after.operations.length} operations pending`);
  if (problems.length === 0) {
    const objects = Object.keys(state.objectStates).length;
    log(`verify: ok (${state.profiles.length} profiles, ${bindings} bindings, ${objects} objects)`);
    return true;
  }
  log('verify: failed');
  for (const problem of problems) log(`  ${problem}`);
  return false;
}

async function main(argv, progress, log) {
  const options = parseImportArguments(argv);
  const files = await readManifestFiles(options.manifest);
  if (options.normalizeTo !== null) {
    await normalizeInto(options.normalizeTo, files, log);
    return;
  }
  const assets = await canonicalAssets(files);
  const templates = profileTemplates();
  const { client, target, host } = connect(options);
  const { rebindCurrent } = options;
  log(
    `target: ${target} (${host}) · mode: ${options.apply ? 'apply' : 'plan'}` +
      `${rebindCurrent ? ' · rebind-current' : ''}`,
  );

  await requirePrivateBucket(client);
  const state = await readState(client, assets);
  const plan = planDocumentImport({ assets, templates, rebindCurrent, ...state });
  for (const line of formatPlan(plan)) log(line);
  if (plan.blocked.length > 0) {
    throw new ImportError(
      'IMPORT_OBJECT_CORRUPT',
      `${plan.blocked.join(', ')}; nothing was written`,
    );
  }

  let verified = true;
  if (options.apply) {
    await applyPlan(client, { assets, templates, plan, state, rebindCurrent }, progress, log);
    // Everything is read again: the check is of what the database holds now, not of what was sent.
    verified = verify(await readState(client, assets), { assets, templates, rebindCurrent }, log);
  } else {
    progress.changes = plan.operations.length;
    // A dry run that would change something has nothing finished to verify yet.
    if (progress.changes === 0) verified = verify(state, { assets, templates, rebindCurrent }, log);
  }
  const dryRun = !options.apply && progress.changes > 0;
  log(`changes: ${progress.changes}${dryRun ? ' (dry run, nothing written)' : ''}`);
  progress.reported = true;
  if (!verified) throw new ImportError('IMPORT_VERIFICATION_FAILED');
}

const progress = { changes: 0, reported: false };
try {
  await main(process.argv.slice(2), progress, console.log);
} catch (error) {
  if (progress.changes > 0 && !progress.reported) {
    console.log(`changes: ${progress.changes} (stopped by an error)`);
  }
  console.error(error instanceof ImportError ? error.message : `IMPORT_FAILED: ${error?.message}`);
  process.exitCode = 1;
}
