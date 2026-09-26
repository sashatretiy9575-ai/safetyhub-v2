// Turns the owner's own deck into the files the publisher reads: one deck.json
// per language beside the presentation it describes, the thumbnail of its first
// page and the catalogue cover.
//
// All four are built by `scripts/content/decks/build_locale.py` from the
// owner's own generator — Russian from his own slide data, the other three from
// its translation — and exported to PDF through PowerPoint.
//
//   node scripts/content/batches/eb-2026-09/build-decks.mjs
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { contentSeoSchema } from '../../../../lib/validation/content-seo.ts';
import { SLUG } from './author-assessment-ru.mjs';

const LOCALES = ['ru', 'kk', 'en', 'zh'];
// The translated slide data is part of the release; the PowerPoint build that
// turns it into PDFs runs in a working directory with the owner's photographs.
const SOURCE_DIR = path.resolve('content/course-batch-2026-09-eb/deck-source');
const BUILD_DIR = path.resolve(process.env.EB_DECK_BUILD ?? 'artifacts/eb-2026-09/deck');
const CONTENT = path.resolve('content/course-batch-2026-09-eb', SLUG);
const PDFS = {
  ru: 'deck-ru.pdf',
  kk: 'deck-kk.pdf',
  en: 'deck-en.pdf',
  zh: 'deck-zh.pdf',
};

/** The acts the deck cites, each under its own name. Every address was opened. */
const SOURCES = [
  {
    id: 'labour-code',
    url: 'https://old.adilet.zan.kz/rus/docs/K1500000414',
    title: {
      ru: 'Трудовой кодекс Республики Казахстан',
      kk: 'Қазақстан Республикасының Еңбек кодексі',
      en: 'Labour Code of the Republic of Kazakhstan',
      zh: '哈萨克斯坦共和国《劳动法典》',
    },
  },
  {
    id: 'civil-protection',
    url: 'https://old.adilet.zan.kz/rus/docs/Z1400000188',
    title: {
      ru: 'Закон РК «О гражданской защите»',
      kk: 'ҚР «Азаматтық қорғау туралы» Заңы',
      en: 'Law of the RK “On Civil Protection”',
      zh: '哈萨克斯坦共和国《民防法》',
    },
  },
  {
    id: 'installation-code',
    url: 'https://old.adilet.zan.kz/rus/docs/V1500010851',
    title: {
      ru: 'Правила устройства электроустановок, приказ № 230',
      kk: 'Электр қондырғыларын орнату қағидалары, № 230 бұйрық',
      en: 'Electrical Installation Code, Order No. 230',
      zh: '《电气装置安装规程》（第230号命令）',
    },
  },
  {
    id: 'safety-rules',
    url: 'https://old.adilet.zan.kz/rus/docs/V1500010889',
    title: {
      ru: 'Правила техники безопасности при эксплуатации электроустановок потребителей, приказ № 222',
      kk: 'Тұтынушылардың электр қондырғыларын пайдалану кезіндегі қауіпсіздік техникасы қағидалары, № 222 бұйрық',
      en: "Safety Rules for the Operation of Consumers' Electrical Installations, Order No. 222",
      zh: '《用户电气装置运行安全技术规程》（第222号命令）',
    },
  },
  {
    id: 'personnel-rules',
    url: 'https://old.adilet.zan.kz/rus/docs/V1500010830',
    title: {
      ru: 'Правила работы с персоналом в энергетических организациях РК, приказ № 234',
      kk: 'ҚР энергетикалық ұйымдарындағы персоналмен жұмыс қағидалары, № 234 бұйрық',
      en: 'Rules for Work with Personnel in Energy Organisations of the RK, Order No. 234',
      zh: '《哈萨克斯坦共和国能源组织人员工作规程》（第234号命令）',
    },
  },
  {
    id: 'height-rules',
    url: 'https://old.adilet.zan.kz/rus/docs/V2200027349',
    title: {
      ru: 'Правила по обеспечению безопасности и охраны труда при работе на высоте, приказ № 109',
      kk: 'Биіктікте жұмыс істеу кезінде еңбек қауіпсіздігі мен еңбекті қорғау қағидалары, № 109 бұйрық',
      en: 'Rules on Occupational Safety and Health for Work at Height, Order No. 109',
      zh: '《高处作业劳动安全与卫生保障规程》（第109号命令）',
    },
  },
];

/**
 * A manual line break becomes a space, except in Chinese, where a space between
 * two Han characters is a typographic error: there the lines simply run together.
 */
const lineBreak = (locale) => (locale === 'zh' ? '' : ' ');

/** The lines of a slide, whatever shape its layout keeps them in. */
function slideBody(slide, locale) {
  const lines = [];
  const push = (value) => {
    const text = String(value ?? '')
      .replaceAll('\n', lineBreak(locale))
      .replace(/^•\s*/u, '')
      .trim();
    if (text) lines.push(text);
  };
  for (const bullet of slide.bullets ?? []) push(bullet);
  for (const [number, text] of slide.objectives ?? slide.parts ?? []) push(`${number}. ${text}`);
  for (const step of slide.steps ?? []) push(`${step[1]} — ${step[2]}`);
  for (const row of slide.rows ?? []) push(row.join(' — '));
  for (const item of slide.checklist ?? []) push(item.join(' — '));
  for (const card of ['left', 'right'])
    for (const bullet of slide[`${card}_card_bullets`] ?? [])
      push(`${slide[`${card}_card_title`]}: ${bullet}`);
  if (!lines.length) {
    push(slide.subtitle);
    push(slide.description);
    push(slide.audience);
    push(slide.warning_title);
  }
  return lines;
}

async function build(locale) {
  const slides = JSON.parse(await readFile(path.join(SOURCE_DIR, `slides-${locale}.json`), 'utf8'));
  const meta = JSON.parse(await readFile(path.join(CONTENT, locale, 'meta.json'), 'utf8'));
  const directory = path.join(CONTENT, locale);
  await mkdir(directory, { recursive: true });

  const pdf = await readFile(path.resolve(BUILD_DIR, PDFS[locale]));
  await writeFile(path.join(directory, 'presentation.pdf'), pdf);
  const pageCount = (await PDFDocument.load(pdf)).getPageCount();
  if (pageCount !== slides.length) throw new Error(`DECK_LENGTH_MISMATCH:${locale}:${pageCount}`);

  const seo = contentSeoSchema.parse({
    title: `${meta.title} | SafetyHub`,
    description: meta.description,
    ogTitle: meta.title,
    ogDescription: meta.description,
    ogImage: `/images/course-batch/${SLUG}-${locale}.webp`,
    indexable: true,
  });
  const deck = {
    schemaVersion: 1,
    slug: SLUG,
    locale,
    title: meta.title,
    description: meta.description,
    status: 'draft-awaiting-independent-review',
    sources: SOURCES.map(({ id, url, title }) => ({ id, url, title: title[locale] })),
    slides: slides.map((slide) => ({
      id: `slide-${String(slide.slide_num).padStart(2, '0')}`,
      title: slide.title ?? '',
      body: slideBody(slide, locale),
      callout: (slide.callout_text ?? slide.bottom_banner ?? '').replaceAll(
        '\n',
        lineBreak(locale),
      ),
    })),
    seo,
  };
  await writeFile(path.join(directory, 'deck.json'), JSON.stringify(deck, null, 2) + '\n');
  return { locale, pageCount, pdf };
}

const built = [];
for (const locale of LOCALES) built.push(await build(locale));

// The first page of the deck is the thumbnail of the presentation and, cropped
// to the card, the cover of the course in the catalogue.
const { default: pdfjs } = await import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => ({
  default: module,
}));
const { createCanvas } = await import('@napi-rs/canvas');
for (const { locale, pdf } of built) {
  const document = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false })
    .promise;
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  const rendered = canvas.toBuffer('image/png');
  await sharp(rendered)
    .resize(1600, 900, { fit: 'cover', position: 'centre' })
    .webp({ quality: 80 })
    .toFile(path.join(CONTENT, locale, 'thumbnail.webp'));
  await copyFile(
    path.join(CONTENT, locale, 'thumbnail.webp'),
    path.resolve('public/images/course-batch', `${SLUG}-${locale}.webp`),
  );
  await sharp(rendered)
    .resize(1280, 720, { fit: 'cover', position: 'centre' })
    .webp({ quality: 78 })
    .toFile(path.resolve('public/images/course-covers', `${SLUG}-${locale}.webp`));
}

// The site offers a cover only for a course and language the manifest names.
const manifestFile = path.resolve('lib/content/course-cover-manifest.json');
const manifest = new Set(JSON.parse(await readFile(manifestFile, 'utf8')));
for (const locale of LOCALES) manifest.add(`${SLUG}/${locale}`);
await writeFile(manifestFile, JSON.stringify([...manifest].sort(), null, 2) + '\n');

console.log(JSON.stringify(built.map(({ locale, pageCount }) => ({ locale, pageCount }))));
