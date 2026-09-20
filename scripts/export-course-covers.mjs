// The catalogue cover of a course is the first page of the course's own
// presentation. The two courses of September already shipped theirs that way;
// the five older ones carried hand-drawn illustrations that had nothing to do
// with the material. Every ready presentation already stores a thumbnail of its
// first page, so the covers are exported from those rather than drawn again.
//
//   node --env-file=.env.local scripts/export-course-covers.mjs
//   node --env-file=.env.local scripts/export-course-covers.mjs --apply
//
// Without --apply nothing is written: the plan says which files would change.
// Reading is done with the service key, which every local stand has; the files
// land in the public bundle, exactly where the September covers already live.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

const OUT_DIR = path.resolve('public', 'images', 'course-covers');
// The card is 16:9 and never wider than 640 CSS pixels; twice that is enough for
// a dense screen and keeps every cover under a hundred kilobytes.
const WIDTH = 1280;
const HEIGHT = 720;
const QUALITY = 78;

export function coverFile(slug, locale) {
  return `${slug}-${locale}.webp`;
}

export function coverPath(slug, locale) {
  return `/images/course-covers/${coverFile(slug, locale)}`;
}

async function readExisting(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const apply = process.argv.includes('--apply');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error('ENVIRONMENT_REQUIRED');

const service = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await service
  .from('course_presentations')
  .select('locale,status,storage_bucket,thumbnail_path,course_id,tests!inner(slug)')
  .eq('status', 'ready')
  .order('locale');
if (error) throw new Error(`PRESENTATIONS_READ_FAILED: ${error.message}`);

await mkdir(OUT_DIR, { recursive: true });
const plan = [];
for (const row of data ?? []) {
  const slug = row.tests?.slug;
  if (!slug || !row.thumbnail_path) continue;
  const download = await service.storage.from(row.storage_bucket).download(row.thumbnail_path);
  if (download.error) throw new Error(`THUMBNAIL_DOWNLOAD_FAILED: ${slug}/${row.locale}`);
  const source = Buffer.from(await download.data.arrayBuffer());
  // `cover` keeps the slide's own proportions and trims the excess rather than
  // letterboxing it, so the card has no empty bars.
  const rendered = await sharp(source)
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
    .webp({ quality: QUALITY })
    .toBuffer();
  const file = path.join(OUT_DIR, coverFile(slug, row.locale));
  const existing = await readExisting(file);
  const changed =
    !existing || createHash('sha256').update(existing).digest('hex') !==
      createHash('sha256').update(rendered).digest('hex');
  plan.push({ slug, locale: row.locale, bytes: rendered.length, changed });
  if (apply && changed) await writeFile(file, rendered);
}

// The manifest is what the site reads: a cover is offered only for a course and
// language that actually has one, so adding a course never points a card at a
// file that was never exported.
const manifest = plan.map((entry) => `${entry.slug}/${entry.locale}`).sort();
const manifestFile = path.resolve('lib', 'content', 'course-cover-manifest.json');
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
const manifestChanged = (await readExisting(manifestFile))?.toString('utf8') !== manifestText;
if (apply && manifestChanged) await writeFile(manifestFile, manifestText, 'utf8');

const changed = plan.filter((entry) => entry.changed).length;
for (const entry of plan) {
  console.log(
    `${entry.changed ? (apply ? 'записан ' : 'изменится') : 'без правок'} ` +
      `${entry.slug.padEnd(28)}${entry.locale}  ${entry.bytes} Б`,
  );
}
console.log(`${plan.length} обложек, изменений: ${changed}${apply ? '' : ' (сухой прогон)'}`);
