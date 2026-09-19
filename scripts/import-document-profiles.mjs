/** Private, content-addressed facsimiles and explicit course document profiles.
 * Dry run by default. Example: node --env-file=.env.local scripts/import-document-profiles.mjs
 * --manifest=artifacts/document-assets-2026-09/import-manifest.json --target=local --apply
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

const args = new Map(process.argv.slice(2).map(arg => { const [key, ...v] = arg.replace(/^--/u, '').split('='); return [key, v.join('=') || true]; }));
const manifestPath = args.get('manifest');
if (typeof manifestPath !== 'string') throw new Error('Provide --manifest=<JSON with bitemirov-au, akhmetzhanov-em, kudiyarov-am, work-safety paths>');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const owners = ['bitemirov-au', 'akhmetzhanov-em', 'kudiyarov-am', 'work-safety'];
const images = await Promise.all(owners.map(async owner => {
  if (typeof manifest[owner] !== 'string') throw new Error(`Missing ${owner}`);
  const file = path.resolve(path.dirname(manifestPath), manifest[owner]);
  const bytes = await fs.readFile(file);
  if (bytes.length > 2097152) throw new Error(`PNG exceeds 2 MiB: ${owner}`);
  const meta = await sharp(bytes).metadata();
  if (meta.format !== 'png' || !meta.hasAlpha) throw new Error(`Transparent PNG required: ${owner}`);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i] < 16) transparent++;
  if (transparent < info.width * info.height * .1) throw new Error(`Insufficient transparent background: ${owner}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { owner, bytes, sha256, kind: owner === 'work-safety' ? 'stamp' : 'signature', object_key: `${sha256}.png` };
}));
console.log(JSON.stringify({ assets: images.map(({ owner, sha256, bytes }) => ({ owner, sha256, bytes: bytes.length })), mode: args.has('apply') ? 'apply' : 'plan' }, null, 2));
if (!args.has('apply')) process.exit(0);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Supabase environment is incomplete');
const local = ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);
if (args.get('target') !== (local ? 'local' : 'linked')) throw new Error('Explicit matching --target=local|linked required');
if (!local && args.get('expected-host') !== new URL(url).hostname) throw new Error('Linked writes require --expected-host matching environment');
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const ids = {};
for (const asset of images) {
  const prior = await client.from('document_assets').select('id').eq('owner_id', asset.owner).eq('kind', asset.kind).eq('sha256', asset.sha256).maybeSingle();
  if (prior.error) throw prior.error;
  if (prior.data) { ids[asset.owner] = prior.data.id; continue; }
  const uploaded = await client.storage.from('document-facsimiles').upload(asset.object_key, asset.bytes, { contentType: 'image/png', upsert: false, cacheControl: '31536000' });
  if (uploaded.error && !/already exists|duplicate/iu.test(uploaded.error.message)) throw uploaded.error;
  const inserted = await client.from('document_assets').insert({ owner_id: asset.owner, kind: asset.kind, sha256: asset.sha256, object_key: asset.object_key }).select('id').single();
  if (inserted.error) throw inserted.error;
  ids[asset.owner] = inserted.data.id;
}
const commission = [
  ['bitemirov-au', 'Битемиров А.У.', 'Директор ТОО «Work Safety (Уорк Сэйфти)»'],
  ['akhmetzhanov-em', 'Ахметжанов Е.М.', 'Преподаватель ТОО «Work Safety (Уорк Сэйфти)»'],
  ['kudiyarov-am', 'Кудияров А.М.', 'Преподаватель ТОО «Work Safety (Уорк Сэйфти)»'],
].map(([signerId, name, position]) => ({ signerId, name, position, assetId: ids[signerId] }));
const courses = [
  ['plotnik','Плотник','general'], ['armaturshchik','Арматурщик','general'],
  ['lesomontazhnye-raboty','Лесомонтажные работы','qualification'],
  ['biot','Безопасность и охрана труда','biot'], ['pozharnaya-bezopasnost','Пожарно-технический минимум','ptm'],
  ['svarshchik','Сварщик','general'], ['promyshlennaya-bezopasnost','Промышленная безопасность','industrial'],
];
for (const [courseSlug, programName, family] of courses) {
  const audiences = ['biot','ptm','industrial'].includes(family) ? ['worker','itr'] : ['all'];
  for (const audience of audiences) {
    const id = `${courseSlug}-${audience}`;
    const body = {
      id, courseSlug, audience, label: `${programName}${audience === 'itr' ? ' — ИТР' : audience === 'worker' ? ' — рабочий состав' : ''}`,
      programName, family, hours: ['ptm','industrial'].includes(family) ? audience === 'itr' ? 40 : 10 : null,
      validityMonths: 0,
      protocolText: 'Проверка знаний проведена в соответствии с утверждённой программой на тему: «{program}».',
      decisionText: 'Результаты проверки знаний зафиксированы настоящим протоколом. Допуск к самостоятельной работе оформляет работодатель в установленном порядке.',
      orderNumber: '', orderDate: '', verificationKind: '', commission, stampAssetId: ids['work-safety'],
    };
    const existing = await client.from('document_profiles').select('body,version').eq('id', id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const same = isDeepStrictEqual(existing.data.body, body);
      if (!same) {
        const withoutAssets = value => ({ ...value, stampAssetId: null, commission: value.commission.map(person => ({ ...person, assetId: null })) });
        const oldText = withoutAssets(existing.data.body), newText = withoutAssets(body);
        const onlyAssets = isDeepStrictEqual(oldText, newText);
        if (!args.has('replace-initial-assets') || existing.data.version !== 1 || !onlyAssets) throw new Error(`DOCUMENT_PROFILE_CONFLICT:${id}; do not overwrite reviewed configuration`);
        const updated = await client.from('document_profiles').update({ body, version: 2, updated_at: new Date().toISOString() }).eq('id', id).eq('version', 1).select('id').maybeSingle();
        if (updated.error) throw updated.error;
        if (!updated.data) throw new Error(`DOCUMENT_PROFILE_CONFLICT:${id}`);
      }
      continue;
    }
    const inserted = await client.from('document_profiles').insert({ id, course_slug: courseSlug, audience, body });
    if (inserted.error) throw inserted.error;
  }
}
console.log('Private assets and profiles installed; no courses created.');
