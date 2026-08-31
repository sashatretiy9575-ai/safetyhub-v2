import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const snapshotRoot = path.join(root, 'content', 'snapshots', 'courses');
const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'tmp', 'course-materials', 'course-seed-payload.json');

const catalog = JSON.parse(await fs.readFile(path.join(snapshotRoot, 'catalog.json'), 'utf8'));
const courses = [];
for (const item of catalog.courses) {
  courses.push(JSON.parse(await fs.readFile(path.join(snapshotRoot, item.slug, 'course.json'), 'utf8')));
}

const payload = {
  schemaVersion: 1,
  catalogVersion: catalog.catalogVersion,
  catalogHash: catalog.catalogHash,
  courses,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(outputPath);
