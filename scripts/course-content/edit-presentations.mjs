import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_WORK_ROOT = path.join(REPOSITORY_ROOT, "tmp/course-materials");
const DEFAULT_OUTPUT_ROOT = path.join(REPOSITORY_ROOT, "content/source-materials/derived");
const FINAL_CTA = "Нажмите «Начать тест»";

const decks = [
  { slug: "plotnik", workspace: "plotnik-inspect" },
  { slug: "armaturshchik", workspace: "armaturshchik-inspect" },
  { slug: "lesomontazhnye-raboty", workspace: "lesomontazhnye-inspect" },
  { slug: "biot", workspace: "biot-inspect" },
  { slug: "pozharnaya-bezopasnost", workspace: "fire-inspect" },
];

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : path.resolve(process.argv[index + 1]);
}
function records(ndjson) {
  return String(ndjson || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function saveBlob(blob, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, Buffer.from(await blob.arrayBuffer()));
}

const workRoot = readArgument("--work-root", DEFAULT_WORK_ROOT);
const outputRoot = readArgument("--output-root", DEFAULT_OUTPUT_ROOT);

for (const deck of decks) {
  const workspace = path.join(workRoot, deck.workspace);
  const starterPath = path.join(workspace, "template-starter.pptx");
  const outputPath = path.join(outputRoot, deck.slug, "presentation.pptx");
  const renderDir = path.join(workspace, "final-render");
  const layoutDir = path.join(workspace, "final-layout");

  const presentation = await PresentationFile.importPptx(await FileBlob.load(starterPath));
  const slides = presentation.slides.items;
  const before = await presentation.inspect({
    kind: "textbox",
    search: "отдельном документе с\\s*тестами",
    maxChars: 20_000,
  });
  const candidates = records(before.ndjson).filter((record) => record.kind === "textbox");
  if (candidates.length !== 1 || candidates[0].slide !== slides.length) {
    throw new Error(`${deck.slug}: expected exactly one CTA textbox on the final slide`);
  }

  const target = presentation.resolve(candidates[0].id);
  target.text.replace(candidates[0].text, FINAL_CTA);
  for (const slide of slides) {
    slide.speakerNotes.clear();
    slide.speakerNotes.setVisible(false);
  }

  const after = await presentation.inspect({ kind: "slide,textbox,notes", maxChars: 2_000_000 });
  const afterRecords = records(after.ndjson);
  const ctaRecords = afterRecords.filter(
    (record) => record.kind === "textbox" && record.text === FINAL_CTA,
  );
  const nonEmptyNotes = afterRecords.filter(
    (record) => record.kind === "notes" && String(record.text || "").trim(),
  );
  if (ctaRecords.length !== 1 || ctaRecords[0].slide !== slides.length) {
    throw new Error(`${deck.slug}: final CTA verification failed`);
  }
  if (nonEmptyNotes.length !== 0) {
    throw new Error(`${deck.slug}: speaker notes remain after sanitization`);
  }

  await fs.rm(renderDir, { recursive: true, force: true });
  await fs.rm(layoutDir, { recursive: true, force: true });
  for (let index = 0; index < slides.length; index += 1) {
    const padded = String(index + 1).padStart(3, "0");
    await saveBlob(
      await presentation.export({ slide: slides[index], format: "png", scale: 1.25 }),
      path.join(renderDir, `slide-${padded}.png`),
    );
    await saveBlob(
      await presentation.export({ slide: slides[index], format: "layout" }),
      path.join(layoutDir, `slide-${padded}.layout.json`),
    );
  }

  await saveBlob(
    await presentation.export({ format: "webp", montage: true, scale: 1 }),
    path.join(workspace, "final-montage.webp"),
  );
  await saveBlob(await PresentationFile.exportPptx(presentation), outputPath);
  await fs.writeFile(path.join(workspace, "final-inspect.ndjson"), `${after.ndjson}\n`, "utf8");
}
