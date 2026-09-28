// The presentation a learner downloads must say what the reviewed deck.json
// says: every line of every slide is looked for on the page of the same number.
//
//   node scripts/content/batches/eb-2026-09/check-decks.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SLUGS } from './author-assessment-ru.mjs';

const LOCALES = ['ru', 'kk', 'en', 'zh'];
const failures = [];

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const squeeze = (text) => text.replace(/[\s ]+/gu, '').replace(/[«»"“”„]/gu, '');

for (const slug of SLUGS)
  for (const locale of LOCALES) {
    const ROOT = path.resolve('content/course-batch-2026-09-eb', slug);
    const deck = JSON.parse(await readFile(path.join(ROOT, locale, 'deck.json'), 'utf8'));
    const bytes = new Uint8Array(await readFile(path.join(ROOT, locale, 'presentation.pdf')));
    const document = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise;
    if (document.numPages !== deck.slides.length)
      failures.push(
        `${slug} ${locale}: ${document.numPages} pages for ${deck.slides.length} slides`,
      );
    for (const [index, slide] of deck.slides.entries()) {
      const page = await document.getPage(index + 1);
      const content = await page.getTextContent();
      const printed = squeeze(content.items.map((item) => item.str).join(' '));
      const lines = [slide.title, ...slide.body, slide.callout].filter(Boolean);
      for (const line of lines) {
        // deck.json joins what the slide keeps in separate boxes: a table cell and
        // its neighbour with « — », a numbered row with its number, a card's
        // bullet with the card's title. Each piece is looked for on its own.
        const parts = line
          .split(/\s—\s/u)
          .flatMap((part) => part.replace(/^\d{1,2}[.)]\s*/u, '').split(/:\s/u))
          .filter((part) => squeeze(part).length > 12);
        // A short numbered row (Chinese says a lot in few characters) is looked
        // for without its number, which the slide prints in a box of its own.
        for (const part of parts.length ? parts : [line.replace(/^\d{1,2}[.)]\s*/u, '')])
          if (squeeze(part).length > 12 && !printed.includes(squeeze(part)))
            failures.push(`${slug} ${locale} p.${index + 1}: not printed — ${part.slice(0, 60)}…`);
      }
    }
  }

console.log(
  JSON.stringify({ ok: failures.length === 0, failures: failures.slice(0, 40) }, null, 2),
);
if (failures.length) process.exitCode = 1;
