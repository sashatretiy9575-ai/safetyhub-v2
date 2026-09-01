import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const inspectionRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-inspection');
const workspaceRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization');
const localeArgument = process.argv.find((value) => value.startsWith('--locales='));
const locales = (localeArgument ? localeArgument.slice('--locales='.length).split(',') : ['kk', 'en', 'zh'])
  .filter((locale, index, values) => ['kk', 'en', 'zh'].includes(locale) && values.indexOf(locale) === index);

if (!locales.length) throw new Error('TARGET_LOCALES_INVALID');

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

const presentationRoot = path.join(stagedRoot, 'presentations');
const slugs = (await fs.readdir(presentationRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let workspaceCount = 0;
let slideCount = 0;
let editTargetCount = 0;

for (const slug of slugs) {
  const manifestPath = path.join(inspectionRoot, slug, 'template-inspect', 'template-manifest.json');
  const manifest = await readJson(manifestPath);
  const sourcePptx = path.join(repoRoot, 'content', 'source-materials', 'derived', slug, 'presentation.pptx');
  const layouts = await Promise.all(
    manifest.slideArtifacts.map((entry) => readJson(path.resolve(path.dirname(manifestPath), '..', entry.layoutRelativePath))),
  );

  if (layouts.length !== manifest.slideCount) throw new Error(`SOURCE_LAYOUT_COUNT_MISMATCH:${slug}`);

  for (const locale of locales) {
    const textMapPath = path.join(presentationRoot, slug, locale, 'text-map.json');
    const textMap = await readJson(textMapPath).catch(() => null);
    if (!textMap) throw new Error(`PRESENTATION_TEXT_MAP_MISSING:${slug}:${locale}`);
    if (textMap.slideCount !== manifest.slideCount || textMap.slides.length !== manifest.slideCount) {
      throw new Error(`PRESENTATION_TEXT_MAP_TOPOLOGY_MISMATCH:${slug}:${locale}`);
    }

    const workspace = path.join(workspaceRoot, locale, slug);
    await fs.mkdir(workspace, { recursive: true });

    const outputSlides = textMap.slides.map((slide, index) => {
      const sourceLayout = layouts[index];
      const sourceIds = new Set(sourceLayout.elements.map((element) => element.aid));
      for (const element of slide.elements) {
        if (!sourceIds.has(element.id)) {
          throw new Error(`PRESENTATION_EDIT_TARGET_MISSING:${slug}:${locale}:${slide.slide}:${element.id}`);
        }
      }
      editTargetCount += slide.elements.length;
      return {
        outputSlide: slide.slide,
        sourceSlide: slide.slide,
        narrativeRole: 'localized content rewrite',
        reuseMode: 'duplicate-slide',
        editTargets: slide.elements.map((element) => ({
          shapeId: element.id,
          action: element.text === element.translatedText ? 'keep' : 'rewrite',
          reason: element.text === element.translatedText
            ? 'Locale-neutral number or identifier is retained exactly.'
            : `Replace the inherited ${element.name || 'text'} element with the reviewed ${locale} translation.`,
          sourceTextSha256: element.sourceTextSha256,
        })),
      };
    });

    const sourceSlides = layouts.map((layout) => ({
      sourceSlide: layout.slide.slide,
      slideId: layout.slide.aid,
      layoutId: layout.slide.layoutId,
      layoutName: layout.slide.layoutName,
      masterLayoutId: layout.slide.masterLayoutId,
      masterLayoutName: layout.slide.masterLayoutName,
      frame: layout.slide.frame,
      elementCount: layout.elements.length,
      textElementCount: layout.elements.filter((element) => typeof element.text === 'string').length,
      inheritedLayerCount: layout.inheritedLayers.length,
      inheritedElementCount: layout.inheritedLayers.reduce((count, layer) => count + layer.elements.length, 0),
    }));

    await writeJson(path.join(workspace, 'template-frame-map.json'), {
      schemaVersion: 1,
      slug,
      locale,
      sourcePptx: relativeToRepo(sourcePptx),
      sourceInspection: relativeToRepo(path.join(inspectionRoot, slug, 'template-inspect', 'template-inspect.ndjson')),
      sourceSlides,
      outputSlides,
      omittedSourceSlides: [],
    });

    const completeInspection = layouts.flatMap((layout) => [
      {
        kind: 'slide',
        id: layout.slide.aid,
        slide: layout.slide.slide,
        title: layout.elements.find((element) => typeof element.text === 'string')?.text ?? '',
        textShapes: layout.elements.filter((element) => typeof element.text === 'string').length,
      },
      ...layout.elements.map((element) => ({
        kind: element.kind,
        id: element.aid,
        slide: layout.slide.slide,
        name: element.name,
        text: element.text,
        bbox: element.bbox,
        placeholder: element.placeholder,
        placeholderType: element.placeholderType,
      })),
      ...layout.inheritedLayers.flatMap((layer) => layer.elements.map((element) => ({
        kind: element.kind,
        id: element.aid,
        slide: layout.slide.slide,
        scope: layer.scope,
        name: element.name,
        text: element.text,
        bbox: element.bbox,
        placeholder: element.placeholder,
        placeholderType: element.placeholderType,
      }))),
    ]);
    await fs.writeFile(
      path.join(workspace, 'template-inspect-complete.ndjson'),
      `${completeInspection.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );

    const fonts = [...new Set(layouts.flatMap((layout) => layout.theme?.typefaces ?? []))].sort();
    const layoutNames = [...new Set(layouts.map((layout) => layout.slide.layoutName))].sort();
    const masterNames = [...new Set(layouts.map((layout) => layout.slide.masterLayoutName))].sort();
    await fs.writeFile(
      path.join(workspace, 'template-audit.txt'),
      [
        `Template audit: ${slug} -> ${locale}`,
        `Source: ${relativeToRepo(sourcePptx)}`,
        `Slides inspected at full source topology: ${manifest.slideCount}`,
        `Slide frame: ${sourceSlides[0]?.frame.width ?? 1280} x ${sourceSlides[0]?.frame.height ?? 720} px`,
        `Layouts: ${layoutNames.join('; ')}`,
        `Masters: ${masterNames.join('; ')}`,
        `Template typefaces: ${fonts.join(', ')}`,
        `Inherited layout/master elements: ${sourceSlides.reduce((sum, slide) => sum + slide.inheritedElementCount, 0)}`,
        '',
        'Reusable pattern and insertion contract:',
        '- Every output slide duplicates the corresponding source slide one-to-one.',
        '- Existing master, layout, geometry, fills, strokes, images, crops, logos, footer, spacing, and z-order are preserved.',
        '- Only inherited text elements listed in template-frame-map.json may be rewritten.',
        '- Locale-neutral page numbers and identifiers are retained exactly.',
        '- No new primitives, overlays, slides, images, charts, or tables are permitted.',
        '- The final deck must be imported from template-starter.pptx and exported with @oai/artifact-tool.',
        '- Final fidelity, overflow, placeholder, page-count, glyph, and rendered-slide checks are mandatory.',
        '',
      ].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(workspace, 'deviation-log.txt'),
      [
        `Deviation log: ${slug} -> ${locale}`,
        '- Intended deviation: text content only, using the staged reviewed locale text map.',
        '- Geometry/layout/master/theme/images/crops/brand assets: no deviation permitted.',
        '- Typeface: preserve source typography; ZH may use documented Noto Sans SC substitution only where Arial/Calibri lacks a glyph.',
        '- All slides remain in their original order; no source slide is omitted or duplicated beyond one-to-one starter duplication.',
        '',
      ].join('\n'),
      'utf8',
    );

    workspaceCount += 1;
    slideCount += textMap.slideCount;
  }
}

console.log(JSON.stringify({ ok: true, locales, workspaceCount, slideCount, editTargetCount, workspaceRoot }));
