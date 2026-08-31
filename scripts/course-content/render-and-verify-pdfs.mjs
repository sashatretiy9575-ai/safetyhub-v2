import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  readPresentationQaInput,
  validateAndRenderPresentation,
} from './presentation-pdf-qa.mjs';

const root = process.cwd();

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return path.resolve(root, value);
}

const snapshotRoot = argumentValue(
  '--snapshot-root',
  path.join(root, 'content', 'snapshots', 'courses'),
);
const qaRoot = argumentValue(
  '--qa-root',
  path.join(root, 'tmp', 'course-materials', 'pdf-render'),
);
const sourceManifestPath = argumentValue(
  '--source-manifest',
  path.join(root, 'content', 'source-materials', 'derived', 'manifest.json'),
);
const visualQaApproved = process.argv.includes('--visual-qa-approved');

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readJsonIfPresent(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const catalog = await readJsonIfPresent(path.join(snapshotRoot, 'catalog.json'));
const sourceManifest = await readJsonIfPresent(sourceManifestPath);
const presentationInputs = Array.isArray(catalog?.courses)
  ? await Promise.all(
      catalog.courses.map(async (catalogCourse) => {
        const course = await readJson(
          path.join(snapshotRoot, catalogCourse.slug, 'course.json'),
        );
        return {
          slug: catalogCourse.slug,
          expectedByteSize: course.presentation?.byteSize,
          expectedPageCount: course.presentation?.pageCount,
          expectedSha256: course.presentation?.sha256,
          expectedThumbnailSha256: course.presentation?.thumbnailSha256,
        };
      }),
    )
  : Array.isArray(sourceManifest?.presentations)
    ? sourceManifest.presentations.map((presentation) => ({
        slug: presentation.slug,
        expectedPageCount: presentation.slideCount,
      }))
    : [];
if (presentationInputs.length < 1) {
  throw new Error('A catalog or derived presentation manifest with at least one course is required.');
}

await fs.rm(qaRoot, { recursive: true, force: true });
await fs.mkdir(qaRoot, { recursive: true });

const catalogResults = [];
for (const input of presentationInputs) {
  const slug = input.slug;
  const courseDirectory = path.join(snapshotRoot, slug);
  const manifestPath = path.join(courseDirectory, 'presentation-manifest.json');
  const existingManifest = await readJsonIfPresent(manifestPath);
  const existingThumbnailPath = path.join(courseDirectory, 'thumbnail.webp');
  const { pdfBytes, thumbnailBytes } = await readPresentationQaInput(
    path.join(courseDirectory, 'presentation.pdf'),
    await fs.access(existingThumbnailPath).then(() => existingThumbnailPath).catch(() => null),
  );
  const pdfSha256 =
    input.expectedSha256 ?? createHash('sha256').update(pdfBytes).digest('hex');
  const reviewedAt =
    visualQaApproved &&
    existingManifest?.sha256 === pdfSha256 &&
    existingManifest?.validation?.visual?.status === 'passed'
      ? existingManifest.validation.visual.reviewedAt
      : visualQaApproved
        ? new Date().toISOString()
        : null;

  const result = await validateAndRenderPresentation({
    slug,
    pdfBytes,
    thumbnailBytes,
    expectedByteSize: input.expectedByteSize ?? pdfBytes.byteLength,
    expectedPageCount: input.expectedPageCount,
    expectedSha256: pdfSha256,
    expectedThumbnailSha256: input.expectedThumbnailSha256,
    qaRoot,
    visualQaApproved,
    reviewedAt,
  });

  await fs.writeFile(path.join(courseDirectory, 'thumbnail.webp'), result.thumbnailBytes);
  await writeJson(manifestPath, result.manifest);
  catalogResults.push(result.manifest);
}

await writeJson(path.join(qaRoot, 'catalog-pdf-qa.json'), {
  schemaVersion: 1,
  courseCount: catalogResults.length,
  pageCount: catalogResults.reduce((sum, item) => sum + item.pageCount, 0),
  courses: catalogResults.map(({ slug, sha256, pageCount, renderedPageCount, validation }) => ({
    slug,
    sha256,
    pageCount,
    renderedPageCount,
    visualStatus: validation.visual.status,
  })),
});

console.log(
  JSON.stringify({
    ok: true,
    courseCount: catalogResults.length,
    pageCount: catalogResults.reduce((sum, item) => sum + item.pageCount, 0),
    visualStatus: visualQaApproved ? 'passed' : 'pending',
    qaRoot,
  }),
);
