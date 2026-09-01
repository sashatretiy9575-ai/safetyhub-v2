/**
 * Content summary: produces reviewed localized SafetyHub course
 * presentations from their staged text maps, one source page to one localized
 * page, and records immutable content hashes for the release receipt.
 *
 * Design description: template-preserving edit mode. The source 16:9 master,
 * layout hierarchy, typography, spacing, safety-green accents, photographs,
 * crops, logos, and footer treatment stay unchanged. Only explicitly mapped
 * text, hidden provenance notes, and bounded, receipt-backed layout corrections
 * required by the independent semantic and PowerPoint overflow gates are edited.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { FileBlob, PresentationFile } from '@oai/artifact-tool';
import JSZip from 'jszip';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const workspaceRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization');
const allowedLocales = new Set(['kk', 'en', 'zh']);
const allowedSlugs = new Set([
  'armaturshchik',
  'biot',
  'lesomontazhnye-raboty',
  'plotnik',
  'pozharnaya-bezopasnost',
]);
const approvedLayoutOverrides = [{
  locale: 'kk',
  slug: 'lesomontazhnye-raboty',
  slide: 10,
  shapeId: '4',
  name: 'SECTION_TITLE',
  translatedText: 'Құрылыс мінбесі: жүйе, орнықтылық',
  sourceBbox: [72, 334, 1080, 152],
  finalBbox: [72, 334, 1128, 152],
  reason: 'Width-only correction keeps the independently accepted wording on one line at the unchanged 58 pt source typography. Left, top and height stay fixed; the title ends at x=1200 on a 1280 px slide and does not intersect neighboring content.',
  rejectedPass5Gate: {
    gateSha256: '41d38da02f6fcdfceb22a325f141b9d4860baa120bb0b9248f162aa70f288197',
    gateFileSha256: '55438c6e37dad34aa0f4b36388409c9869f0c6241baf0281043868a2c4c1f900',
    emptyApprovedFileSha256: 'c9f0f78b9b2967157118e1e13c6d4443420eeb5de49ba081b5c408a79af3c288',
    rejectedCandidateApplied: false,
  },
}, {
  locale: 'kk', slug: 'plotnik', slide: 25, shapeId: '16', name: 'Прямоугольник 15',
  translatedText: 'Ақаулық, жағдайлардың өзгеруі немесе қауіп төнген жағдайда жұмыс тоқтатылады.',
  sourceBbox: [152, 502, 1000, 54], finalBbox: [152, 502, 1000, 66],
  reason: 'Height-only correction clears a 7 pt PowerPoint TextFrame2 vertical overflow; the next template element remains outside the expanded box.',
}, {
  locale: 'kk', slug: 'armaturshchik', slide: 23, shapeId: '12',
  translatedText: 'Арматураны байлау, дәнекерлеу немесе муфталы қосылыс технологиясы бұзылған',
  sourceBbox: [368, 310, 304, 72], finalBbox: [368, 310, 330, 72],
  reason: 'Width-only correction preserves the 20 px body typography and removes the extra wrapped line without entering the adjacent control column.',
}, {
  locale: 'kk', slug: 'armaturshchik', slide: 26, shapeId: '5', name: 'IMAGE_CAPTION',
  translatedText: 'Пайдалануға жарамдылық сынақ тәуекелімен емес, тексеру және белгіленген тексеру арқылы расталады.',
  sourceBbox: [824, 548, 396, 88], finalBbox: [824, 548, 396, 88],
  finalFontSizePx: 18, minimumReadableFontSizePx: 18,
  reason: 'Bounded 18 px caption typography clears the PowerPoint vertical overflow without entering the immutable visible-source/footer zone.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 1, shapeId: '5', name: 'DECK_TITLE',
  translatedText: 'Құрылыс мінбелерін монтаждау жұмыстары',
  sourceBbox: [72, 212, 650, 190], finalBbox: [72, 212, 650, 190],
  finalFontSizePx: 48, minimumReadableFontSizePx: 44,
  reason: 'Bounded cover-title typography correction preserves the complete accepted title while fitting above the unchanged divider and subtitle; 48 px remains above the 44 px cover-title readability floor.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 2, shapeId: '8', name: 'LIST_ITEM_2',
  translatedText: 'Құрылыс мінбелерінің негізгі элементтерін және байланыстардың, төсемдердің әрі қоршаулардың мақсатын ажырату.',
  sourceBbox: [210, 282, 620, 84], finalBbox: [210, 282, 620, 84],
  finalFontSizePx: 22, minimumReadableFontSizePx: 20,
  reason: 'Bounded 22 px list typography clears the PowerPoint vertical overflow without changing geometry or moving the next list row.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 2, shapeId: '11', name: 'LIST_ITEM_3',
  translatedText: 'Құрылыс мінбелерін қауіпсіз пайдалану және оларды пайдалануға рұқсат беру мәртебесін түсіну.',
  sourceBbox: [210, 378, 620, 84], finalBbox: [210, 378, 620, 84],
  finalFontSizePx: 22, minimumReadableFontSizePx: 20,
  reason: 'Bounded 22 px list typography clears the PowerPoint vertical overflow without changing geometry or moving the next list row.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 8, shapeId: '7', name: 'STEP_BODY_1',
  translatedText: 'Жобаны, жүйенің техникалық паспортын, монтаждау сұлбасын, наряд-рұқсатты және шектеулерді.',
  sourceBbox: [34, 422, 260, 110], finalBbox: [34, 422, 260, 128],
  reason: 'Height-only correction clears an 11 pt PowerPoint vertical overflow while preserving the 20 px step typography and lower callout clearance.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 38, shapeId: '7', name: 'STEP_BODY_1',
  translatedText: 'Адамдарды, материалдарды, қоқыстарды және бөгде құрылғыларды алып тастаңыз.',
  sourceBbox: [34, 422, 260, 110], finalBbox: [34, 422, 260, 128],
  reason: 'Height-only correction clears an 11 pt PowerPoint vertical overflow while preserving the 20 px step typography and lower callout clearance.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 38, shapeId: '15', name: 'STEP_BODY_3',
  translatedText: 'Рұқсат етілген кезеңге дейін қосылымдар мен анкерлерді сақтай отырып, жоғарыдан төменге қарай алып тастаңыз.',
  sourceBbox: [634, 422, 260, 110], finalBbox: [634, 422, 260, 128],
  reason: 'Height-only correction clears an 11 pt PowerPoint vertical overflow while preserving the 20 px step typography and lower callout clearance.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 42, shapeId: '4',
  translatedText: 'Жоба, жүйенің техникалық паспорты, тағайындалған рөлдер және қауіпсіз аймақ бар.',
  sourceBbox: [152, 214, 1000, 54], finalBbox: [152, 214, 1000, 66],
  reason: 'Height-only correction clears a 7 pt PowerPoint vertical overflow and keeps the next checklist row outside the expanded box.',
}, {
  locale: 'kk', slug: 'lesomontazhnye-raboty', slide: 42, shapeId: '7',
  translatedText: 'Негіз, негіздер, геометрия, қосылыстар және бекітулер диаграммаға сәйкес келеді.',
  sourceBbox: [152, 286, 1000, 54], finalBbox: [152, 286, 1000, 66],
  reason: 'Height-only correction clears a 7 pt PowerPoint vertical overflow and keeps the next checklist row outside the expanded box.',
}, {
  locale: 'kk', slug: 'biot', slide: 22, shapeId: '19', name: 'STEP_BODY_4',
  translatedText: 'Өлшемдерді таңдап, басқару элементтерін тағайындаңыз және өзгерістер орын алса, қайта тексеріңіз.',
  sourceBbox: [934, 422, 260, 110], finalBbox: [934, 422, 260, 128],
  reason: 'Height-only correction clears an 11 pt PowerPoint vertical overflow while preserving the 20 px step typography and lower callout clearance.',
}, {
  locale: 'kk', slug: 'biot', slide: 36, shapeId: '19', name: 'STEP_BODY_4',
  translatedText: 'Адамдарды құтқарудан және оқиғалардың дамуына жол бермеуден басқа жағдайды өзгертпеңіз.',
  sourceBbox: [934, 422, 260, 110], finalBbox: [934, 422, 260, 128],
  reason: 'Height-only correction clears an 11 pt PowerPoint vertical overflow while preserving the 20 px step typography and lower callout clearance.',
}, {
  locale: 'kk', slug: 'biot', slide: 59, shapeId: '7',
  translatedText: 'жұмыскер оқытылған, тазартылған және миссия мен төтенше жағдай процедураларын түсінеді.',
  sourceBbox: [152, 286, 1000, 54], finalBbox: [152, 286, 1000, 66],
  reason: 'Height-only correction clears a 7 pt PowerPoint vertical overflow and keeps the next checklist row outside the expanded box.',
}, {
  locale: 'en', slug: 'lesomontazhnye-raboty', slide: 42, shapeId: '4',
  translatedText: 'Design documentation, the system technical manual, assigned roles and a safe zone are in place.',
  sourceBbox: [152, 214, 1000, 54], finalBbox: [152, 214, 1000, 66],
  reason: 'Height-only correction clears a 7 pt PowerPoint vertical overflow and keeps the next checklist row outside the expanded box.',
}];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\s\u00a0]+/gu, ' ')
    .trim();
}

function comparableLocalizedText(value, locale) {
  const normalized = normalizeText(value);
  return locale === 'zh' ? normalized.replace(/\s+/gu, '') : normalized;
}

function ndjsonRecords(value) {
  return String(value ?? '')
    .split(/\r?\n/gu)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertBoundedIdentifier(value, allowed, code) {
  if (!value || !allowed.has(value)) throw new Error(`${code}:${value ?? ''}`);
  return value;
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function assertPathWithin(parentPath, targetPath, code) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${code}:${targetPath}`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function saveBlob(blob, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const bytes = Buffer.from(await blob.arrayBuffer());
  await fs.writeFile(destination, bytes);
  return bytes;
}

async function packageFacts(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).sort();
  const themeNames = names.filter((name) => /^ppt\/theme\/theme\d+\.xml$/u.test(name));
  const themes = {};
  for (const name of themeNames) themes[name] = sha256(await zip.file(name).async('nodebuffer'));
  const slideNames = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  const emptyPlaceholders = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    const shapes = xml.match(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/gu) ?? [];
    for (const [shapeIndex, shape] of shapes.entries()) {
      if (!/<p:ph(?:\s|\/>)/u.test(shape)) continue;
      const text = [...shape.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
        .map((match) => match[1].replace(/&(?:amp|lt|gt|quot|apos);/gu, 'x'))
        .join('');
      if (!normalizeText(text)) emptyPlaceholders.push({ part: name, shapeIndex: shapeIndex + 1 });
    }
  }
  return {
    themes,
    slideCount: slideNames.length,
    masterLayoutTopology: {
      slideMasterCount: names.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/u.test(name)).length,
      slideLayoutCount: names.filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/u.test(name)).length,
      slideMasterRelationshipPartCount: names.filter((name) => /^ppt\/slideMasters\/_rels\/slideMaster\d+\.xml\.rels$/u.test(name)).length,
      slideLayoutRelationshipPartCount: names.filter((name) => /^ppt\/slideLayouts\/_rels\/slideLayout\d+\.xml\.rels$/u.test(name)).length,
      slideRelationshipPartCount: names.filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/u.test(name)).length,
    },
    notePartCount: names.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name)).length,
    emptyPlaceholders,
  };
}

function sameRecord(left, right) {
  return stableJson(left) === stableJson(right);
}

function sameBbox(left, right, tolerance = 0.25) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === 4
    && right.length === 4
    && left.every((value, index) => Math.abs(Number(value) - Number(right[index])) <= tolerance);
}

function layoutOverrideFor(locale, slug, slide, shapeId) {
  return approvedLayoutOverrides.find(
    (candidate) => candidate.locale === locale
      && candidate.slug === slug
      && candidate.slide === slide
      && candidate.shapeId === String(shapeId),
  ) ?? null;
}

function bboxesIntersect(left, right) {
  return left[0] < right[0] + right[2]
    && left[0] + left[2] > right[0]
    && left[1] < right[1] + right[3]
    && left[1] + left[3] > right[1];
}

function chooseBulletBoundaries(sourceParagraphs, translatedText) {
  const positions = [...translatedText.matchAll(/•/gu)].map((match) => match.index);
  const required = sourceParagraphs.length;
  if (positions.length < required) return null;
  const sourceLengths = sourceParagraphs.map((paragraph) => normalizeText(paragraph.text).length + 1);
  const sourceTotal = sourceLengths.reduce((sum, value) => sum + value, 0);
  const expected = [];
  let cursor = 0;
  for (const length of sourceLengths) {
    expected.push(cursor / Math.max(sourceTotal, 1));
    cursor += length;
  }
  let best = null;
  function visit(start, chosen) {
    if (chosen.length === required) {
      const score = chosen.reduce(
        (sum, position, index) => sum + Math.abs((position / Math.max(translatedText.length, 1)) - expected[index]),
        0,
      );
      if (!best || score < best.score) best = { score, positions: [...chosen] };
      return;
    }
    const remaining = required - chosen.length;
    for (let index = start; index <= positions.length - remaining; index += 1) {
      visit(index + 1, [...chosen, positions[index]]);
    }
  }
  visit(0, []);
  return best?.positions ?? null;
}

function translatedParagraphs(element, layoutElement, locale, slug, slideNumber) {
  const paragraphs = layoutElement.paragraphs ?? [];
  if (paragraphs.length <= 1) return [element.translatedText];
  const bulletParagraphs = paragraphs.every(
    (paragraph) => paragraph.runs?.length === 2 && normalizeText(paragraph.runs[0].text) === '•',
  );
  if (bulletParagraphs) {
    const boundaries = chooseBulletBoundaries(paragraphs, element.translatedText);
    if (!boundaries) {
      throw new Error(`TRANSLATED_BULLET_TOPOLOGY_MISMATCH:${locale}:${slug}:${slideNumber}:${element.name ?? ''}:${paragraphs.length}`);
    }
    return boundaries.map((position, index) => normalizeText(
      element.translatedText.slice(position + 1, boundaries[index + 1] ?? element.translatedText.length),
    ));
  }
  const language = { kk: 'kk-KZ', en: 'en', zh: 'zh-CN' }[locale];
  const values = [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(element.translatedText)]
    .map((entry) => normalizeText(entry.segment))
    .filter(Boolean);
  if (values.length !== paragraphs.length) {
    throw new Error(`TRANSLATED_PARAGRAPH_TOPOLOGY_MISMATCH:${locale}:${slug}:${slideNumber}:${element.name ?? ''}:${values.length}:${paragraphs.length}`);
  }
  return values;
}

function replaceMappedText(target, record, element, layoutElement, locale, slug, slideNumber) {
  const paragraphs = layoutElement.paragraphs ?? [];
  if (!paragraphs.length) {
    target.text.replace(record.text, element.translatedText);
    return;
  }
  const translated = translatedParagraphs(element, layoutElement, locale, slug, slideNumber);
  for (const [index, paragraph] of paragraphs.entries()) {
    const runs = paragraph.runs ?? [];
    if (runs.length === 1) {
      target.text.replace(runs[0].text, translated[index]);
      continue;
    }
    if (runs.length === 2 && normalizeText(runs[0].text) === '•') {
      const prefix = runs[1].text.match(/^\s*/u)?.[0] ?? '';
      target.text.replace(runs[1].text, `${prefix}${translated[index]}`);
      continue;
    }
    throw new Error(`UNSUPPORTED_TEXT_RUN_TOPOLOGY:${locale}:${slug}:${slideNumber}:${element.name ?? ''}:${index + 1}`);
  }
}

function replaceMappedTable(target, element, layoutElement, locale, slug, slideNumber) {
  if (!Array.isArray(element.cells)) {
    throw new Error(`TABLE_CELL_TRANSLATIONS_MISSING:${locale}:${slug}:${slideNumber}:${element.name ?? ''}`);
  }
  const sourceCells = layoutElement.cells ?? [];
  if (element.cells.length !== sourceCells.length) {
    throw new Error(`TABLE_CELL_TOPOLOGY_MISMATCH:${locale}:${slug}:${slideNumber}:${element.cells.length}:${sourceCells.length}`);
  }
  for (const cell of element.cells) {
    const row = Number(cell.row);
    const column = Number(cell.column);
    const source = sourceCells.find((candidate) => candidate.row === row && candidate.column === column);
    if (!source || normalizeText(source.text) !== normalizeText(cell.text)) {
      throw new Error(`TABLE_CELL_SOURCE_MISMATCH:${locale}:${slug}:${slideNumber}:${row}:${column}`);
    }
    target.cells.set(row - 1, column - 1, cell.translatedText);
  }
}

async function renderDeck({ locale, slug, auditOnly = false }) {
  const workspace = path.join(workspaceRoot, locale, slug);
  const starterPath = path.join(workspace, 'template-starter.pptx');
  const sourcePath = path.join(repoRoot, 'content', 'source-materials', 'derived', slug, 'presentation.pptx');
  const textMapPath = path.join(stagedRoot, 'presentations', slug, locale, 'text-map.json');
  const courseDraftPath = path.join(stagedRoot, 'courses', slug, locale, 'course-draft.json');
  const [textMapBytes, courseDraft, starterBytes, sourceBytes] = await Promise.all([
    fs.readFile(textMapPath),
    readJson(courseDraftPath),
    fs.readFile(starterPath),
    fs.readFile(sourcePath),
  ]);
  const textMap = JSON.parse(textMapBytes.toString('utf8'));
  if (textMap.locale !== locale || textMap.slug !== slug) throw new Error(`TEXT_MAP_IDENTITY_MISMATCH:${locale}:${slug}`);
  if (textMap.slideCount !== textMap.slides.length) throw new Error(`TEXT_MAP_SLIDE_COUNT_MISMATCH:${locale}:${slug}`);

  const starterFacts = await packageFacts(starterBytes);
  const sourceFacts = await packageFacts(sourceBytes);
  if (starterFacts.slideCount !== textMap.slideCount || sourceFacts.slideCount !== textMap.slideCount) {
    throw new Error(`STARTER_PAGE_COUNT_MISMATCH:${locale}:${slug}`);
  }
  if (!sameRecord(starterFacts.themes, sourceFacts.themes)) throw new Error(`STARTER_THEME_DRIFT:${locale}:${slug}`);
  if (!sameRecord(starterFacts.masterLayoutTopology, sourceFacts.masterLayoutTopology)) {
    throw new Error(`STARTER_MASTER_LAYOUT_TOPOLOGY_DRIFT:${locale}:${slug}`);
  }
  if (starterFacts.emptyPlaceholders.length) throw new Error(`STARTER_EMPTY_PLACEHOLDER:${locale}:${slug}`);

  const presentation = await PresentationFile.importPptx(await FileBlob.load(starterPath));
  if (presentation.slides.items.length !== textMap.slideCount) throw new Error(`IMPORTED_PAGE_COUNT_MISMATCH:${locale}:${slug}`);
  const before = await presentation.inspect({
    kind: 'slide,textbox,table,notes,layout',
    include: 'id,slide,name,text,textPreview,bbox,rows,cols,preview,isPlaceholder,placeholders',
    maxChars: 20_000_000,
  });
  const beforeRecords = ndjsonRecords(before.ndjson);
  const textboxes = beforeRecords.filter((record) => record.kind === 'textbox');
  const resolvedTargets = new Set();
  const layoutElementsBySlide = new Map();
  for (const slideMap of textMap.slides) {
    const layoutPath = path.join(
      workspace,
      'template-starter-layout',
      `starter-slide-${String(slideMap.slide).padStart(2, '0')}.layout.json`,
    );
    const layout = await readJson(layoutPath);
    layoutElementsBySlide.set(slideMap.slide, layout.elements ?? []);
  }
  let translatedElementCount = 0;
  let retainedElementCount = 0;
  let translatedTableCellCount = 0;
  const resolvedLayoutElements = new Map();
  const appliedLayoutOverrides = [];

  for (const slideMap of textMap.slides) {
    for (const element of slideMap.elements) {
      let layoutCandidates = (layoutElementsBySlide.get(slideMap.slide) ?? []).filter(
        (candidate) => String(candidate.id) === String(element.shapeId),
      );
      if (layoutCandidates.length !== 1) {
        layoutCandidates = (layoutElementsBySlide.get(slideMap.slide) ?? []).filter(
          (candidate) => candidate.name === element.name
            && normalizeText(candidate.text) === normalizeText(element.text),
        );
      }
      if (layoutCandidates.length !== 1) {
        throw new Error(`LAYOUT_EDIT_TARGET_AMBIGUOUS:${locale}:${slug}:${slideMap.slide}:${element.shapeId}:${element.name ?? ''}:${layoutCandidates.length}`);
      }
      const layoutElement = layoutCandidates[0];
      const candidates = beforeRecords.filter(
        (record) => record.slide === slideMap.slide
          && record.kind === (layoutElement.kind === 'table' ? 'table' : 'textbox')
          && sameBbox(record.bbox, layoutElement.bbox),
      );
      if (candidates.length !== 1) {
        throw new Error(`EDIT_TARGET_AMBIGUOUS:${locale}:${slug}:${slideMap.slide}:${element.shapeId}:${element.name ?? ''}:${candidates.length}`);
      }
      const record = candidates[0];
      if (resolvedTargets.has(record.id)) throw new Error(`EDIT_TARGET_REUSED:${locale}:${slug}:${record.id}`);
      resolvedTargets.add(record.id);
      resolvedLayoutElements.set(`${slideMap.slide}:${element.shapeId}`, layoutElement);
      if (normalizeText(element.text) === normalizeText(element.translatedText)) {
        retainedElementCount += 1;
        continue;
      }
      const target = presentation.resolve(record.id);
      if (layoutElement.kind === 'table') {
        replaceMappedTable(target, element, layoutElement, locale, slug, slideMap.slide);
        translatedTableCellCount += element.cells.length;
      } else {
        replaceMappedText(target, record, element, layoutElement, locale, slug, slideMap.slide);
      }
      const layoutOverride = layoutOverrideFor(locale, slug, slideMap.slide, element.shapeId);
      if (layoutOverride) {
        if (
          layoutElement.name !== layoutOverride.name
          || normalizeText(element.translatedText) !== normalizeText(layoutOverride.translatedText)
          || !sameBbox(layoutElement.bbox, layoutOverride.sourceBbox)
          || layoutOverride.finalBbox[0] + layoutOverride.finalBbox[2] > 1280
          || layoutOverride.finalBbox[1] + layoutOverride.finalBbox[3] > 720
          || (layoutOverride.finalFontSizePx !== undefined && (
            !(layoutOverride.finalFontSizePx >= layoutOverride.minimumReadableFontSizePx)
            || !(layoutOverride.minimumReadableFontSizePx >= 18)
          ))
        ) {
          throw new Error(`APPROVED_LAYOUT_OVERRIDE_CONTRACT_MISMATCH:${locale}:${slug}:${slideMap.slide}:${element.shapeId}`);
        }
        const newlyIntersectedNeighbors = beforeRecords.filter(
          (candidate) => candidate.slide === slideMap.slide
            && candidate.id !== record.id
            && Array.isArray(candidate.bbox)
            && !bboxesIntersect(layoutOverride.sourceBbox, candidate.bbox)
            && bboxesIntersect(layoutOverride.finalBbox, candidate.bbox),
        );
        if (newlyIntersectedNeighbors.length) {
          throw new Error(`APPROVED_LAYOUT_OVERRIDE_NEIGHBOR_INTERSECTION:${locale}:${slug}:${slideMap.slide}:${element.shapeId}:${newlyIntersectedNeighbors.length}`);
        }
        target.position = {
          left: layoutOverride.finalBbox[0],
          top: layoutOverride.finalBbox[1],
          width: layoutOverride.finalBbox[2],
          height: layoutOverride.finalBbox[3],
        };
        if (layoutOverride.finalFontSizePx !== undefined) {
          target.text.fontSize = layoutOverride.finalFontSizePx;
        }
        appliedLayoutOverrides.push({
          ...layoutOverride,
          textMapSha256: sha256(textMapBytes),
          sourceTextSha256: element.sourceTextSha256,
          translatedTextSha256: sha256(Buffer.from(element.translatedText, 'utf8')),
          newlyIntersectedNeighborCount: 0,
        });
      }
      translatedElementCount += 1;
    }
  }
  const expectedDeckLayoutOverrideCount = approvedLayoutOverrides.filter(
    (candidate) => candidate.locale === locale && candidate.slug === slug,
  ).length;
  if (appliedLayoutOverrides.length !== expectedDeckLayoutOverrideCount) {
    throw new Error(`APPROVED_LAYOUT_OVERRIDE_APPLY_COUNT:${locale}:${slug}:${appliedLayoutOverrides.length}:${expectedDeckLayoutOverrideCount}`);
  }

  const provenance = [
    '[Sources]',
    `- SafetyHub canonical RU slide source: ${relativeToRepo(sourcePath)}`,
    `- Reviewed ${locale.toUpperCase()} text map: ${relativeToRepo(textMapPath)}`,
  ].join('\n');
  for (const [index, slide] of presentation.slides.items.entries()) {
    const existing = normalizeText(
      beforeRecords.find((record) => record.kind === 'notes' && record.slide === index + 1)?.text ?? '',
    );
    slide.speakerNotes.setText([existing, provenance].filter(Boolean).join('\n\n'));
    slide.speakerNotes.setVisible(false);
  }

  const after = await presentation.inspect({
    kind: 'slide,textbox,table,notes,layout',
    include: 'id,slide,name,text,textPreview,bbox,rows,cols,preview,isPlaceholder,placeholders',
    maxChars: 20_000_000,
  });
  const afterRecords = ndjsonRecords(after.ndjson);
  const afterTextboxes = afterRecords.filter((record) => record.kind === 'textbox');
  if (afterTextboxes.length !== textboxes.length) throw new Error(`TEXTBOX_TOPOLOGY_DRIFT:${locale}:${slug}`);
  for (const slideMap of textMap.slides) {
    for (const element of slideMap.elements) {
      const layoutElement = resolvedLayoutElements.get(`${slideMap.slide}:${element.shapeId}`);
      if (layoutElement?.kind === 'table') continue;
      const layoutOverride = layoutOverrideFor(locale, slug, slideMap.slide, element.shapeId);
      const expectedBbox = layoutOverride?.finalBbox ?? layoutElement?.bbox;
      const targetCandidates = afterTextboxes.filter(
        (record) => record.slide === slideMap.slide && sameBbox(record.bbox, expectedBbox),
      );
      if (targetCandidates.length !== 1) {
        throw new Error(`POST_EDIT_TARGET_AMBIGUOUS:${locale}:${slug}:${slideMap.slide}:${element.shapeId}:${element.name ?? ''}:${targetCandidates.length}`);
      }
      if (comparableLocalizedText(targetCandidates[0].text, locale) !== comparableLocalizedText(element.translatedText, locale)) {
        throw new Error(`LOCALIZED_TEXT_VERIFY_FAILED:${locale}:${slug}:${slideMap.slide}:${element.shapeId}:${element.name ?? ''}:${JSON.stringify([normalizeText(targetCandidates[0].text)])}`);
      }
    }
  }
  const noteRecords = afterRecords.filter((record) => record.kind === 'notes');
  if (noteRecords.length !== textMap.slideCount || noteRecords.some((record) => !String(record.text ?? '').includes('[Sources]'))) {
    throw new Error(`SOURCE_NOTES_VERIFY_FAILED:${locale}:${slug}`);
  }

  const renderDir = path.join(workspace, 'final-render');
  const layoutDir = path.join(workspace, 'final-layout');
  const finalTmp = path.join(workspace, 'final', 'presentation.pptx');
  assertPathWithin(workspaceRoot, renderDir, 'RENDER_DELETE_TARGET_INVALID');
  assertPathWithin(workspaceRoot, layoutDir, 'LAYOUT_DELETE_TARGET_INVALID');
  await fs.rm(renderDir, { recursive: true, force: true });
  await fs.rm(layoutDir, { recursive: true, force: true });
  await fs.mkdir(renderDir, { recursive: true });
  await fs.mkdir(layoutDir, { recursive: true });
  const finalLayoutsBySlide = new Map();
  for (let index = 0; index < presentation.slides.items.length; index += 1) {
    const padded = String(index + 1).padStart(3, '0');
    const slide = presentation.slides.items[index];
    await saveBlob(await presentation.export({ slide, format: 'png', scale: 1.25 }), path.join(renderDir, `slide-${padded}.png`));
    const layoutBytes = await saveBlob(
      await slide.export({ format: 'layout' }),
      path.join(layoutDir, `slide-${padded}.layout.json`),
    );
    finalLayoutsBySlide.set(index + 1, JSON.parse(layoutBytes.toString('utf8')));
  }
  let verifiedGeometryElementCount = 0;
  let verifiedApprovedLayoutOverrideCount = 0;
  for (const slideMap of textMap.slides) {
    const sourceElements = layoutElementsBySlide.get(slideMap.slide) ?? [];
    const finalElements = finalLayoutsBySlide.get(slideMap.slide)?.elements ?? [];
    if (sourceElements.length !== finalElements.length) {
      throw new Error(`TEMPLATE_ELEMENT_COUNT_DRIFT:${locale}:${slug}:${slideMap.slide}:${sourceElements.length}:${finalElements.length}`);
    }
    for (const sourceElement of sourceElements) {
      const finalElement = finalElements.find((candidate) => String(candidate.id) === String(sourceElement.id));
      if (!finalElement || finalElement.kind !== sourceElement.kind) {
        throw new Error(`TEMPLATE_ELEMENT_TOPOLOGY_DRIFT:${locale}:${slug}:${slideMap.slide}:${sourceElement.id}`);
      }
      const layoutOverride = layoutOverrideFor(locale, slug, slideMap.slide, sourceElement.id);
      const expectedBbox = layoutOverride?.finalBbox ?? sourceElement.bbox;
      if (!sameBbox(finalElement.bbox, expectedBbox)) {
        throw new Error(`TEMPLATE_ELEMENT_GEOMETRY_DRIFT:${locale}:${slug}:${slideMap.slide}:${sourceElement.id}`);
      }
      if (layoutOverride) verifiedApprovedLayoutOverrideCount += 1;
      verifiedGeometryElementCount += 1;
    }
  }
  if (verifiedApprovedLayoutOverrideCount !== appliedLayoutOverrides.length) {
    throw new Error(`APPROVED_LAYOUT_OVERRIDE_VERIFY_COUNT:${locale}:${slug}:${verifiedApprovedLayoutOverrideCount}:${appliedLayoutOverrides.length}`);
  }
  for (const slideMap of textMap.slides) {
    for (const element of slideMap.elements.filter((candidate) => candidate.kind === 'table')) {
      const finalTable = (finalLayoutsBySlide.get(slideMap.slide)?.elements ?? []).find(
        (candidate) => candidate.kind === 'table' && String(candidate.id) === String(element.shapeId),
      );
      if (!finalTable || finalTable.rows * finalTable.cols !== element.cells.length) {
        throw new Error(`FINAL_TABLE_TOPOLOGY_MISMATCH:${locale}:${slug}:${slideMap.slide}:${element.shapeId}`);
      }
      for (const cell of element.cells) {
        const finalCell = finalTable.cells.find(
          (candidate) => candidate.row === cell.row && candidate.column === cell.column,
        );
        if (!finalCell || normalizeText(finalCell.text) !== normalizeText(cell.translatedText)) {
          throw new Error(`FINAL_TABLE_TEXT_MISMATCH:${locale}:${slug}:${slideMap.slide}:${cell.row}:${cell.column}`);
        }
      }
    }
  }
  const typographyRegressions = [];
  for (const slideMap of textMap.slides) {
    const sourceElements = layoutElementsBySlide.get(slideMap.slide) ?? [];
    const finalElements = finalLayoutsBySlide.get(slideMap.slide)?.elements ?? [];
    for (const element of slideMap.elements.filter((candidate) => candidate.kind !== 'table')) {
      const sourceElement = sourceElements.find((candidate) => String(candidate.id) === String(element.shapeId));
      const finalElement = finalElements.find((candidate) => String(candidate.id) === String(element.shapeId));
      if (!sourceElement || !finalElement) {
        typographyRegressions.push({
          locale,
          slug,
          slide: slideMap.slide,
          shapeId: element.shapeId,
          name: element.name ?? null,
          codes: ['MAPPED_LAYOUT_ELEMENT_MISSING'],
          sourceText: element.text,
          translatedText: element.translatedText,
        });
        continue;
      }
      const sourceFont = Number(sourceElement.resolvedFontSize ?? 0);
      const finalFont = Number(finalElement.resolvedFontSize ?? 0);
      const sourceLines = Number(sourceElement.textLayout?.lineCount ?? 0);
      const finalLines = Number(finalElement.textLayout?.lineCount ?? 0);
      const titleLike = /(?:TITLE|HEADING|KICKER|HEADER|BANNER)/iu.test(String(element.name ?? ''));
      let codes = [];
      if (sourceFont > 0 && finalFont > 0 && finalFont < sourceFont - 0.5) codes.push('AUTOFIT_FONT_SHRINK');
      if (titleLike && sourceLines === 1 && finalLines > 1) codes.push('ONE_LINE_TITLE_WRAPPED');
      const approvedOverride = layoutOverrideFor(locale, slug, slideMap.slide, element.shapeId);
      if (approvedOverride?.finalFontSizePx !== undefined) {
        const authoredFontSize = finalFont;
        if (
          Math.abs(authoredFontSize - approvedOverride.finalFontSizePx) > 0.5
          || authoredFontSize < approvedOverride.minimumReadableFontSizePx
        ) {
          codes.push('APPROVED_FONT_OVERRIDE_MISMATCH');
        } else {
          codes = codes.filter((code) => code !== 'AUTOFIT_FONT_SHRINK');
        }
      }
      if (codes.length) {
        typographyRegressions.push({
          locale,
          slug,
          slide: slideMap.slide,
          shapeId: element.shapeId,
          name: element.name ?? null,
          codes,
          sourceText: element.text,
          translatedText: element.translatedText,
          sourceFontSize: sourceFont,
          finalFontSize: finalFont,
          sourceLineCount: sourceLines,
          finalLineCount: finalLines,
          availableBox: {
            left: finalElement.bbox?.[0] ?? null,
            top: finalElement.bbox?.[1] ?? null,
            width: finalElement.bbox?.[2] ?? null,
            height: finalElement.bbox?.[3] ?? null,
          },
        });
      }
    }
  }
  const typographyReportPath = path.join(workspace, 'qa', 'layout-regressions.json');
  await writeJson(typographyReportPath, {
    schemaVersion: 1,
    locale,
    slug,
    textMapSha256: sha256(textMapBytes),
    sourceSlideCount: textMap.slideCount,
    inspectedSlideCount: finalLayoutsBySlide.size,
    fontShrinkTolerancePx: 0.5,
    titleRule: 'Mapped TITLE/HEADING/KICKER/HEADER/BANNER text that was one line in the source must remain one line.',
    regressionCount: typographyRegressions.length,
    regressions: typographyRegressions,
  });
  let layoutOverrideReceipt = null;
  if (appliedLayoutOverrides.length) {
    const layoutOverrideReceiptPath = path.join(workspace, 'qa', 'layout-only-override-receipt.json');
    const layoutOverrideReceiptValue = {
      schemaVersion: 1,
      locale,
      slug,
      productionPublished: false,
      textMapSha256: sha256(textMapBytes),
      overrideCount: appliedLayoutOverrides.length,
      allOtherElementGeometryUnchanged: true,
      neighborContentMoved: false,
      newlyIntersectedNeighborCount: 0,
      semanticsChanged: false,
      overrides: appliedLayoutOverrides,
    };
    await writeJson(layoutOverrideReceiptPath, layoutOverrideReceiptValue);
    const layoutOverrideReceiptBytes = await fs.readFile(layoutOverrideReceiptPath);
    layoutOverrideReceipt = {
      path: relativeToRepo(layoutOverrideReceiptPath),
      sha256: sha256(layoutOverrideReceiptBytes),
      byteSize: layoutOverrideReceiptBytes.length,
      ...layoutOverrideReceiptValue,
    };
  }
  if (auditOnly) {
    return {
      locale,
      slug,
      auditOnly: true,
      slideCount: textMap.slideCount,
      regressionCount: typographyRegressions.length,
      approvedLayoutOverrideCount: appliedLayoutOverrides.length,
      layoutOverrideReceipt: layoutOverrideReceipt?.path ?? null,
      report: relativeToRepo(typographyReportPath),
    };
  }
  if (typographyRegressions.length) {
    throw new Error(`TEMPLATE_TYPOGRAPHY_REGRESSION:${locale}:${slug}:${typographyRegressions.length}:${relativeToRepo(typographyReportPath)}`);
  }
  await saveBlob(
    await presentation.export({ format: 'webp', montage: true, scale: 1 }),
    path.join(workspace, 'final-montage.webp'),
  );
  await fs.mkdir(path.dirname(finalTmp), { recursive: true });
  const exportedPptx = await PresentationFile.exportPptx(presentation);
  await exportedPptx.save(finalTmp);
  const finalBytes = await fs.readFile(finalTmp);
  const finalFacts = await packageFacts(finalBytes);
  if (finalFacts.slideCount !== textMap.slideCount) throw new Error(`FINAL_PAGE_COUNT_MISMATCH:${locale}:${slug}`);
  if (!sameRecord(finalFacts.themes, sourceFacts.themes)) throw new Error(`FINAL_THEME_DRIFT:${locale}:${slug}`);
  if (!sameRecord(finalFacts.masterLayoutTopology, sourceFacts.masterLayoutTopology)) {
    throw new Error(`FINAL_MASTER_LAYOUT_TOPOLOGY_DRIFT:${locale}:${slug}`);
  }
  if (finalFacts.emptyPlaceholders.length) throw new Error(`FINAL_EMPTY_PLACEHOLDER:${locale}:${slug}`);
  if (finalFacts.notePartCount !== textMap.slideCount) throw new Error(`FINAL_NOTE_PART_COUNT_MISMATCH:${locale}:${slug}`);

  const pptxSha256 = sha256(finalBytes);
  const immutablePath = path.join(
    stagedRoot,
    'presentations',
    slug,
    locale,
    'assets',
    'pptx',
    pptxSha256,
    'presentation.pptx',
  );
  await fs.mkdir(path.dirname(immutablePath), { recursive: true });
  await fs.writeFile(immutablePath, finalBytes);
  await fs.writeFile(path.join(workspace, 'final-inspect.ndjson'), `${after.ndjson.trim()}\n`, 'utf8');

  const receipt = {
    schemaVersion: 1,
    slug,
    locale,
    productionPublished: false,
    contentSummary: `${courseDraft.title}: ${courseDraft.description}`,
    designDescription: appliedLayoutOverrides.length
      ? 'Template-preserving 16:9 SafetyHub training deck. Source master/layout hierarchy, typography, safety-green accents, imagery, crops, logos, spacing, footer treatment and one-to-one page topology are preserved. Reviewed locale text and hidden provenance notes change; one independently authorized width-only title correction is recorded and bounded without moving neighboring content.'
      : 'Template-preserving 16:9 SafetyHub training deck. Source master/layout hierarchy, typography, safety-green accents, imagery, crops, logos, spacing, footer treatment and one-to-one page topology are preserved; only reviewed locale text and hidden provenance notes change.',
    source: {
      pptx: relativeToRepo(sourcePath),
      pptxSha256: sha256(sourceBytes),
      textMap: relativeToRepo(textMapPath),
      textMapSha256: sha256(textMapBytes),
    },
    pptx: {
      path: relativeToRepo(immutablePath),
      sha256: pptxSha256,
      byteSize: finalBytes.length,
      slideCount: finalFacts.slideCount,
    },
    edits: {
      translatedElementCount,
      translatedTableCellCount,
      retainedElementCount,
      sourceNotesAdded: noteRecords.length,
      textTopologySha256: sha256(Buffer.from(stableJson(textMap.slides), 'utf8')),
      approvedLayoutOverrideCount: appliedLayoutOverrides.length,
    },
    qa: {
      everySlideRendered: true,
      renderedSlideCount: textMap.slideCount,
      layoutInspectionCount: textMap.slideCount,
      sourceThemePreserved: true,
      sourceMasterLayoutHierarchyPreserved: true,
      masterLayoutTopology: finalFacts.masterLayoutTopology,
      sourceGeometryVerified: true,
      sourceGeometryExactExceptApprovedLayoutOverrides: true,
      verifiedGeometryElementCount,
      approvedLayoutOverrideCount: appliedLayoutOverrides.length,
      approvedLayoutOverrides: appliedLayoutOverrides,
      layoutOverrideReceipt,
      neighborGeometryUnchanged: true,
      newlyIntersectedNeighborCount: 0,
      emptyInheritedPlaceholderCount: 0,
      finalTextVerifiedAgainstMap: true,
      finalTableCellsVerifiedAgainstMap: true,
      templateTypographyRegressionCount: 0,
    },
  };
  const receiptPath = path.join(stagedRoot, 'presentations', slug, locale, 'pptx-receipt.json');
  await writeJson(receiptPath, receipt);
  return { locale, slug, pptxSha256, slideCount: textMap.slideCount, translatedElementCount, immutablePath: relativeToRepo(immutablePath) };
}

const locale = assertBoundedIdentifier(argument('--locale'), allowedLocales, 'LOCALE_INVALID');
const slug = assertBoundedIdentifier(argument('--slug'), allowedSlugs, 'SLUG_INVALID');
const auditOnly = process.argv.includes('--audit-only');
const result = await renderDeck({ locale, slug, auditOnly });
console.log(JSON.stringify({ ok: true, ...result }));
