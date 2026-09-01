import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const outputRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const cachePath = path.join(repoRoot, 'tmp', 'stage6', 'translation-cache.json');
const tableCellCachePath = path.join(repoRoot, 'tmp', 'stage6', 'translation-table-cell-cache.json');
const legalLinkCachePath = path.join(repoRoot, 'tmp', 'stage6', 'translation-legal-link-cache.json');
const currentLegalCachePath = path.join(repoRoot, 'tmp', 'stage6', 'translation-current-legal-cache.json');
const passCacheRoot = path.join(repoRoot, 'tmp', 'stage6', 'translation-pass-cache');
const inspectionRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-inspection');
const glossaryPath = path.join(repoRoot, 'content', 'localizations', 'glossary.ru-kk-en-zh.json');
const overridePath = path.join(repoRoot, 'content', 'localizations', 'translation-overrides.ru-kk-en-zh.json');
const localeArgument = process.argv.find((value) => value.startsWith('--locales='));
const requestedLocales = localeArgument ? localeArgument.slice('--locales='.length).split(',') : ['kk', 'en', 'zh'];
const targetLocales = requestedLocales.filter((locale, index) => ['kk', 'en', 'zh'].includes(locale) && requestedLocales.indexOf(locale) === index);
if (!targetLocales.length || targetLocales.length !== requestedLocales.length) throw new Error('TARGET_LOCALES_INVALID');
const numericArgument = (name, fallback) => {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!argument) return fallback;
  const parsed = Number.parseInt(argument.slice(name.length + 3), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name.toUpperCase().replaceAll('-', '_')}_INVALID`);
  return parsed;
};
const translationConcurrency = numericArgument('translation-concurrency', 6);
const translationDelayArgument = process.argv.find((value) => value.startsWith('--translation-delay-ms='));
const translationDelayMs = translationDelayArgument
  ? Number.parseInt(translationDelayArgument.slice('--translation-delay-ms='.length), 10)
  : 0;
if (!Number.isInteger(translationDelayMs) || translationDelayMs < 0) throw new Error('TRANSLATION_DELAY_MS_INVALID');
const translationRetryAttempts = numericArgument('translation-retry-attempts', 6);
const endpointArgument = process.argv.find((value) => value.startsWith('--translation-endpoint='));
const translationEndpoint = endpointArgument ? endpointArgument.slice('--translation-endpoint='.length) : 'gtx';
if (!['gtx', 'mobile'].includes(translationEndpoint)) throw new Error('TRANSLATION_ENDPOINT_INVALID');
const translationBatchChars = numericArgument('translation-batch-chars', translationEndpoint === 'mobile' ? 1_100 : 18_000);
const googleLocale = { kk: 'kk', en: 'en', zh: 'zh-CN', ru: 'ru' };
const cyrillicPattern = /\p{Script=Cyrillic}/u;
const runMode = process.argv.includes('--verify-only') ? 'verify' : 'build';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)
    ? value
    : stableJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeText(value) {
  return value.replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function tokens(value) {
  return normalizeText(value).toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function diceSimilarity(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.length && !rightTokens.length) return 1;
  const rightCounts = new Map();
  for (const token of rightTokens) rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);
  let intersection = 0;
  for (const token of leftTokens) {
    const count = rightCounts.get(token) ?? 0;
    if (count > 0) {
      intersection += 1;
      rightCounts.set(token, count - 1);
    }
  }
  return (2 * intersection) / (leftTokens.length + rightTokens.length);
}

function invariantTokens(value) {
  const normalizedValue = value
    .replaceAll('₀', '0').replaceAll('₁', '1').replaceAll('₂', '2').replaceAll('₃', '3').replaceAll('₄', '4')
    .replaceAll('₅', '5').replaceAll('₆', '6').replaceAll('₇', '7').replaceAll('₈', '8').replaceAll('₉', '9')
    .replaceAll('⁰', '0').replaceAll('¹', '1').replaceAll('²', '2').replaceAll('³', '3').replaceAll('⁴', '4')
    .replaceAll('⁵', '5').replaceAll('⁶', '6').replaceAll('⁷', '7').replaceAll('⁸', '8').replaceAll('⁹', '9');
  const exact = normalizedValue.match(
    /(?:https?:\/\/[^\s)\]}]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|Asia\/Oral|SafetyHub(?:\.kz)?|\b(?:PWA|OTP|PDF|ZIP|QR|HMAC|RLS|PKCE|WebP|PostgreSQL)\b)/giu,
  ) ?? [];
  // Compare numeric atoms instead of locale-specific punctuation so an equivalent
  // date such as 21.08.2026 / 21/08/2026 / 08/21/2026 remains invariant-safe.
  const numbers = normalizedValue.match(/\d+/gu) ?? [];
  return [
    ...exact.map((item) => item.toLocaleLowerCase('ru-RU')),
    ...numbers.map((item) => String(Number.parseInt(item, 10))),
  ].sort();
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectJsxText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(collectJsxText).join('');
  if (node.type === 'JSXText') return node.value;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'NumericLiteral') return String(node.value);
  if (node.type === 'JSXExpressionContainer') {
    const expression = node.expression;
    if (!expression || expression.type === 'JSXEmptyExpression') return '';
    if (expression.type === 'StringLiteral' || expression.type === 'NumericLiteral') return String(expression.value);
    if (expression.type === 'Identifier') return `{${expression.name}}`;
    if (expression.type === 'MemberExpression') {
      const parts = [];
      let current = expression;
      while (current?.type === 'MemberExpression') {
        if (current.property.type === 'Identifier') parts.unshift(current.property.name);
        current = current.object;
      }
      if (current?.type === 'Identifier') parts.unshift(current.name);
      return `{${parts.join('.')}}`;
    }
    if (expression.type === 'TemplateLiteral') {
      return expression.quasis.map((quasi, index) => {
        const placeholder = expression.expressions[index];
        return `${quasi.value.cooked ?? ''}${placeholder ? collectJsxText({ type: 'JSXExpressionContainer', expression: placeholder }) : ''}`;
      }).join('');
    }
    return '';
  }
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') return collectJsxText(node.children);
  return '';
}

function jsxName(node) {
  const name = node?.openingElement?.name;
  return name?.type === 'JSXIdentifier' ? name.name : '';
}

function findJsxElements(node, predicate, results = []) {
  if (!node || typeof node !== 'object') return results;
  if (node.type === 'JSXElement' && predicate(node)) results.push(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') findJsxElements(value, predicate, results);
  }
  return results;
}

function jsxAttribute(element, name) {
  const attribute = element.openingElement.attributes.find(
    (item) => item.type === 'JSXAttribute' && item.name.name === name,
  );
  if (!attribute?.value) return '';
  if (attribute.value.type === 'StringLiteral') return attribute.value.value;
  return normalizeText(collectJsxText(attribute.value));
}

async function extractLegalSource(fileName, metadata) {
  const sourcePath = path.join(repoRoot, 'components', 'legal', fileName);
  const source = await fs.readFile(sourcePath, 'utf8');
  const legalContractSource = await fs.readFile(path.join(repoRoot, 'lib', 'legal.ts'), 'utf8');
  const referenceBlock = legalContractSource.match(/export const LEGAL_REFERENCE_LINKS\s*=\s*\{([\s\S]*?)\}\s*as const/u)?.[1] ?? '';
  const referenceLinks = Object.fromEntries(
    [...referenceBlock.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*'([^']+)'/gu)].map((match) => [match[1], match[2]]),
  );
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const sections = findJsxElements(ast, (element) => jsxName(element) === 'section').map((section, index) => {
    const headings = findJsxElements(section, (element) => jsxName(element) === 'h2');
    const paragraphs = findJsxElements(section, (element) => jsxName(element) === 'p');
    const listItems = findJsxElements(section, (element) => jsxName(element) === 'li');
    const links = findJsxElements(section, (element) => jsxName(element) === 'a').map((anchor) => {
      const hrefReference = jsxAttribute(anchor, 'href');
      const referenceName = hrefReference.match(/^\{LEGAL_REFERENCE_LINKS\.([A-Za-z][A-Za-z0-9_]*)\}$/u)?.[1];
      return {
        label: normalizeText(collectJsxText(anchor)),
        url: referenceName ? referenceLinks[referenceName] : hrefReference,
      };
    }).filter((link) => link.label && link.url);
    return {
      id: jsxAttribute(section, 'aria-labelledby') || jsxAttribute(section, 'id') || `section-${index + 1}`,
      heading: normalizeText(collectJsxText(headings[0])),
      paragraphs: paragraphs.map((item) => normalizeText(collectJsxText(item))).filter(Boolean),
      items: listItems.map((item) => normalizeText(collectJsxText(item))).filter(Boolean),
      links,
    };
  });
  sections.push({
    id: 'legal-contacts',
    heading: 'Контакты по документу',
    paragraphs: ['Позвоните или напишите в WhatsApp. Для письменного обращения сохраните переписку в чате.'],
    items: ['Телефон', 'WhatsApp', 'Написать'],
    // Runtime contacts come from site settings and are never copied into the
    // immutable legal body or localization artifact.
    links: [],
  });
  return {
    schemaVersion: 1,
    ...metadata,
    sourceComponent: `components/legal/${fileName}`,
    sections,
  };
}

async function readCanonicalLegalSource(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  if (
    source.schemaVersion !== 1
    || source.locale !== 'ru'
    || !['privacy', 'terms'].includes(source.documentType)
    || !source.body?.sections
    || sha256(source.body) !== source.bodySourceSha256
  ) {
    throw new Error(`CANONICAL_LEGAL_SOURCE_INVALID:${relativePath}`);
  }
  return {
    schemaVersion: 1,
    documentType: source.documentType,
    title: source.title,
    version: source.version,
    bodyRevision: source.bodyRevision,
    effectiveDate: source.effectiveAt.slice(0, 10),
    effectiveAt: source.effectiveAt,
    sourceComponent: relativePath,
    sourceBodySha256: source.bodySourceSha256,
    sections: source.body.sections,
    currentCandidate: true,
  };
}

function translateObject(value, translate, key = '') {
  if (Array.isArray(value)) return value.map((item) => translateObject(item, translate, key));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string' || !cyrillicPattern.test(value)) return value;
    if (['slug', 'url', 'coverImage', 'effectiveDate', 'createdAt', 'updatedAt', 'type', 'tone', 'style'].includes(key)) return value;
    return translate(value);
  }
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    translateObject(entryValue, translate, entryKey),
  ]));
}

function publicAssessment(course, translate) {
  return course.variants.map((variant) => ({
    id: variant.id,
    variantNumber: variant.variantNumber,
    questions: variant.questions.map((question) => ({
      id: question.id,
      text: translate(question.text),
      options: question.options.map((option) => ({ id: option.id, text: translate(option.text) })),
      explanation: question.explanation ? translate(question.explanation) : '',
    })),
  }));
}

function assessmentTopology(course) {
  return course.variants.map((variant) => ({
    id: variant.id,
    variantNumber: variant.variantNumber,
    questions: variant.questions.map((question) => ({
      id: question.id,
      options: question.options.map((option) => option.id),
    })),
  }));
}

function answerMappingDigest(course) {
  return sha256(course.variants.flatMap((variant) => variant.questions.map((question) => question.correctOptionId)));
}

function protectText(source, locale, glossary) {
  let text = normalizeText(source);
  const replacements = [];
  const protectedTerms = [...glossary.terms]
    .filter((term) => term[locale])
    .sort((left, right) => right.ru.length - left.ru.length);
  for (const term of protectedTerms) {
    const escaped = term.ru.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    text = text.replace(pattern, () => {
      const marker = `⟦G${String(replacements.length).padStart(3, '0')}⟧`;
      replacements.push({ marker, value: term[locale] });
      return marker;
    });
  }
  const immutablePattern = /(?:https?:\/\/[^\s)\]}]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\{[^{}]+\}|Asia\/Oral|SafetyHub(?:\.kz)?|Supabase|Vercel|Cloudflare|Turnstile|PWA|OTP|PDF|ZIP|QR|HMAC|RLS|PKCE|WebP|PostgreSQL|WhatsApp)/giu;
  text = text.replace(immutablePattern, (value) => {
    const marker = `⟦I${String(replacements.length).padStart(3, '0')}⟧`;
    replacements.push({ marker, value });
    return marker;
  });
  return { text, replacements };
}

function restoreText(translated, replacements) {
  let result = normalizeText(translated);
  for (const replacement of replacements) {
    const marker = replacement.marker.slice(1, -1).replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`⟦\\s*${marker}\\s*⟧`, 'giu');
    result = result.replace(pattern, replacement.value);
  }
  return result;
}

function makeBatches(items, maxChars = 18_000) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const item of items) {
    const lineLength = item.text.length + item.marker.length + 2;
    if (current.length && length + lineLength > maxChars) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += lineLength;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function fetchWithRetry(url, init, attempts = translationRetryAttempts) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let retryAfterMs = 0;
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          'user-agent': 'SafetyHub-localization-builder/1.0',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP_${response.status}`);
      const retryAfterSeconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) retryAfterMs = retryAfterSeconds * 1_000;
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
    }
    const exponentialMs = Math.min(30_000, 1_000 * (2 ** attempt));
    await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfterMs, exponentialMs)));
  }
  throw lastError;
}

function parseAnchoredTranslation(text, batch) {
  const result = new Map();
  const markerPattern = /⟦\s*S(\d{6})\s*⟧/gu;
  const matches = [...text.matchAll(markerPattern)];
  if (batch.length === 1 && matches.length === 0) {
    const markerDigits = batch[0].marker.slice(1);
    const withoutLooseMarker = text.replace(
      new RegExp(`(?:[⟦\\[（(]?\\s*S?${markerDigits}\\s*[⟧\\]）)]?)`, 'giu'),
      '',
    );
    result.set(batch[0].marker, normalizeText(withoutLooseMarker));
    return result;
  }
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? text.length;
    result.set(`S${matches[index][1]}`, normalizeText(text.slice(start, end)));
  }
  if (result.size !== batch.length || batch.some((item) => !result.has(item.marker))) {
    throw new Error(`TRANSLATION_ANCHOR_MISMATCH:${result.size}:${batch.length}`);
  }
  return result;
}

async function translateBatch(batch, from, to, engine) {
  const query = batch.map((item) => `⟦${item.marker}⟧ ${item.text}`).join('\n');
  if (translationEndpoint === 'mobile') {
    const host = engine === 'secondary' ? 'translate.google.co.uk' : 'translate.google.com';
    const url = new URL(`https://${host}/m`);
    url.search = new URLSearchParams({ sl: googleLocale[from], tl: googleLocale[to], q: query }).toString();
    const response = await fetchWithRetry(url, { method: 'GET' });
    const html = await response.text();
    const result = html.match(/<div class="result-container">([\s\S]*?)<\/div>/u)?.[1];
    if (typeof result !== 'string') throw new Error('TRANSLATION_RESPONSE_INVALID');
    const decoded = result
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    return parseAnchoredTranslation(decoded, batch);
  }
  const endpoint = 'https://translate.googleapis.com/translate_a/single';
  const body = new URLSearchParams({
    client: 'gtx',
    sl: googleLocale[from],
    tl: googleLocale[to],
    dt: 't',
    q: query,
  });
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-safetyhub-translation-pass': engine,
    },
    body,
  });
  const payload = await response.json();
  const translated = payload[0].map((segment) => segment[0]).join('');
  if (typeof translated !== 'string') throw new Error('TRANSLATION_RESPONSE_INVALID');
  return parseAnchoredTranslation(translated, batch);
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function translatePrepared(items, from, to, engine) {
  const batches = makeBatches(engine === 'secondary' ? [...items].reverse() : items, translationBatchChars);
  const translatedBatches = await mapConcurrent(batches, translationConcurrency, async (batch) => {
    try {
      const result = await translateBatch(batch, from, to, engine);
      if (translationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, translationDelayMs));
      return result;
    } catch (error) {
      // A provider/quota failure is batch-independent. Do not amplify it into
      // thousands of single-item calls; retain the cache and stop cleanly.
      if (batch.length === 1 || /^HTTP_/u.test(error?.message ?? '')) throw error;
      const values = new Map();
      for (const item of batch) {
        const one = await translateBatch([item], from, to, engine);
        values.set(item.marker, one.get(item.marker));
        if (translationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, translationDelayMs));
      }
      return values;
    }
  });
  const result = new Map();
  for (const batch of translatedBatches) for (const [key, value] of batch) result.set(key, value);
  return result;
}

async function translatePreparedCached({ sourceHash, locale, pass, items, from, to, engine }) {
  const inputHash = sha256(items.map((item) => [item.marker, item.text]));
  const cacheFile = path.join(passCacheRoot, sourceHash, locale, `${pass}.json`);
  const cached = await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null);
  if (cached?.inputHash === inputHash && Array.isArray(cached.values) && cached.values.length === items.length) {
    return new Map(cached.values);
  }
  const translated = await translatePrepared(items, from, to, engine);
  const values = items.map((item) => [item.marker, translated.get(item.marker)]);
  if (values.some(([, value]) => typeof value !== 'string' || !value.trim())) throw new Error(`TRANSLATION_PASS_INCOMPLETE:${locale}:${pass}`);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, `${JSON.stringify({ inputHash, locale, pass, from, to, engine, values }, null, 2)}\n`, 'utf8');
  return new Map(values);
}

async function buildTranslations(sourceTexts, glossary, cache, destinationCachePath = cachePath) {
  const ordered = [...sourceTexts].sort((left, right) => left.localeCompare(right, 'ru'));
  const sourceHash = sha256(ordered);
  if (cache?.sourceHash === sourceHash && targetLocales.every((locale) => cache.locales?.[locale])) return cache;
  const result = cache?.sourceHash === sourceHash
    ? cache
    : { version: 1, sourceHash, createdAt: new Date().toISOString(), locales: {} };
  for (const locale of targetLocales) {
    if (result.locales[locale]) continue;
    const prepared = ordered.map((source, index) => {
      const protectedValue = protectText(source, locale, glossary);
      return { marker: `S${String(index).padStart(6, '0')}`, source, ...protectedValue };
    });
    const primaryRaw = await translatePreparedCached({ sourceHash, locale, pass: 'forward-primary', items: prepared, from: 'ru', to: locale, engine: 'primary' });
    console.error(JSON.stringify({ locale, pass: 'forward-primary', units: ordered.length }));
    const secondaryRaw = await translatePreparedCached({ sourceHash, locale, pass: 'forward-secondary', items: prepared, from: 'ru', to: locale, engine: 'secondary' });
    console.error(JSON.stringify({ locale, pass: 'forward-secondary', units: ordered.length }));
    const primary = prepared.map((item) => restoreText(primaryRaw.get(item.marker), item.replacements));
    const secondary = prepared.map((item) => restoreText(secondaryRaw.get(item.marker), item.replacements));
    const backPrimaryInput = primary.map((text, index) => ({ marker: `S${String(index).padStart(6, '0')}`, text }));
    const backSecondaryInput = secondary.map((text, index) => ({ marker: `S${String(index).padStart(6, '0')}`, text }));
    const backPrimary = await translatePreparedCached({ sourceHash, locale, pass: 'back-primary', items: backPrimaryInput, from: locale, to: 'ru', engine: 'primary' });
    console.error(JSON.stringify({ locale, pass: 'back-primary', units: ordered.length }));
    const backSecondary = await translatePreparedCached({ sourceHash, locale, pass: 'back-secondary', items: backSecondaryInput, from: locale, to: 'ru', engine: 'secondary' });
    console.error(JSON.stringify({ locale, pass: 'back-secondary', units: ordered.length }));
    const records = ordered.map((source, index) => {
      const marker = `S${String(index).padStart(6, '0')}`;
      const primaryScore = diceSimilarity(source, backPrimary.get(marker));
      const secondaryScore = diceSimilarity(source, backSecondary.get(marker));
      const primaryInvariantsOk = sameArray(invariantTokens(source), invariantTokens(primary[index]));
      const secondaryInvariantsOk = sameArray(invariantTokens(source), invariantTokens(secondary[index]));
      const selectSecondary = secondaryInvariantsOk && (!primaryInvariantsOk || secondaryScore > primaryScore + 0.08);
      return {
        source,
        primary: primary[index],
        secondary: secondary[index],
        backTranslation: selectSecondary ? backSecondary.get(marker) : backPrimary.get(marker),
        selected: selectSecondary ? secondary[index] : primary[index],
        selectedEngine: selectSecondary ? 'secondary' : 'primary',
        roundTripSimilarity: Number((selectSecondary ? secondaryScore : primaryScore).toFixed(4)),
        invariantsOk: selectSecondary ? secondaryInvariantsOk : primaryInvariantsOk,
        candidatesAgree: normalizeText(primary[index]).toLocaleLowerCase(locale) === normalizeText(secondary[index]).toLocaleLowerCase(locale),
      };
    });
    result.locales[locale] = records;
    await fs.mkdir(path.dirname(destinationCachePath), { recursive: true });
    await fs.writeFile(destinationCachePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

async function readCourseFiles() {
  const coursesRoot = path.join(repoRoot, 'content', 'snapshots', 'courses');
  const entries = await fs.readdir(coursesRoot, { withFileTypes: true });
  const courses = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    courses.push(JSON.parse(await fs.readFile(path.join(coursesRoot, entry.name, 'course.json'), 'utf8')));
  }
  return courses;
}

async function readArticles() {
  const articleRoot = path.join(repoRoot, 'content', 'articles');
  const files = (await fs.readdir(articleRoot)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(files.map(async (file) => ({ file, value: JSON.parse(await fs.readFile(path.join(articleRoot, file), 'utf8')) })));
}

async function readPresentationSources() {
  const result = {};
  const courseDirs = await fs.readdir(inspectionRoot, { withFileTypes: true });
  for (const courseDir of courseDirs.filter((item) => item.isDirectory())) {
    const layoutRoot = path.join(inspectionRoot, courseDir.name, 'template-inspect', 'layouts');
    const layoutFiles = (await fs.readdir(layoutRoot)).filter((name) => name.endsWith('.layout.json')).sort();
    result[courseDir.name] = [];
    for (const layoutFile of layoutFiles) {
      const layout = JSON.parse(await fs.readFile(path.join(layoutRoot, layoutFile), 'utf8'));
      result[courseDir.name].push({
        slide: layout.slide.slide,
        slideId: layout.slide.aid,
        layoutId: layout.slide.layoutId,
        masterLayoutId: layout.slide.masterLayoutId,
        elements: layout.elements
          .filter((element) => typeof element.text === 'string' && normalizeText(element.text))
          .map((element) => ({
            id: element.aid,
            shapeId: element.id,
            kind: element.kind,
            name: element.name,
            text: normalizeText(element.text),
            cells: element.kind === 'table' && Array.isArray(element.cells)
              ? element.cells.map((cell) => ({
                row: cell.row,
                column: cell.column,
                text: normalizeText(cell.text),
              }))
              : undefined,
          })),
      });
    }
  }
  return result;
}

function collectRussianStrings(value, destination) {
  if (Array.isArray(value)) {
    for (const item of value) collectRussianStrings(item, destination);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectRussianStrings(item, destination);
  } else if (typeof value === 'string' && cyrillicPattern.test(value)) {
    destination.add(normalizeText(value));
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function verifyExisting() {
  const receiptPath = path.join(outputRoot, 'qa', 'automated-review-receipt.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const failures = [];
  for (const artifact of receipt.artifacts) {
    const absolute = path.join(outputRoot, artifact.path);
    const bytes = await fs.readFile(absolute);
    if (sha256(bytes) !== artifact.sha256) failures.push({ path: artifact.path, code: 'HASH_MISMATCH' });
  }
  if (failures.length) throw new Error(`LOCALIZATION_VERIFY_FAILED:${JSON.stringify(failures)}`);
  console.log(JSON.stringify({ ok: true, artifacts: receipt.artifacts.length, receiptSha256: sha256(await fs.readFile(receiptPath)) }));
}

if (runMode === 'verify') {
  await verifyExisting();
  process.exit(0);
}

const glossary = JSON.parse(await fs.readFile(glossaryPath, 'utf8'));
const overrides = JSON.parse(await fs.readFile(overridePath, 'utf8'));
const courses = await readCourseFiles();
const articles = await readArticles();
const historicalLegal = [
  await extractLegalSource('privacy-policy-v1-2.tsx', {
    documentType: 'privacy', title: 'Политика конфиденциальности', version: '1.2',
    bodyRevision: 'privacy-1.2', effectiveDate: '2026-08-31',
  }),
  await extractLegalSource('terms-policy-v2-2.tsx', {
    documentType: 'terms', title: 'Условия использования', version: '2.2',
    bodyRevision: 'terms-2.2', effectiveDate: '2026-08-31',
  }),
];
const currentLegal = [
  await readCanonicalLegalSource('content/legal/privacy/1.3.ru.json'),
  await readCanonicalLegalSource('content/legal/terms/2.3.ru.json'),
];
const presentations = await readPresentationSources();
const sourceTexts = new Set();
for (const course of courses) {
  collectRussianStrings({
    title: course.title,
    description: course.description,
    jurisdiction: course.jurisdiction,
    seo: course.seo,
    sources: course.sources,
    variants: publicAssessment(course, (value) => value),
  }, sourceTexts);
}
for (const article of articles) collectRussianStrings(article.value, sourceTexts);
const legalLinkTexts = new Set();
for (const document of historicalLegal) {
  collectRussianStrings({
    ...document,
    sections: document.sections.map(({ links: _links, ...section }) => section),
  }, sourceTexts);
  for (const section of document.sections) {
    for (const link of section.links ?? []) collectRussianStrings(link.label, legalLinkTexts);
  }
}
const currentLegalTexts = new Set();
for (const document of currentLegal) collectRussianStrings(document, currentLegalTexts);
const tableCellTexts = new Set();
for (const deck of Object.values(presentations)) {
  for (const slide of deck) {
    for (const element of slide.elements) {
      // Preserve the original text-unit set used by the primary cache. Table
      // cells are reviewed separately because aggregate table translation loses
      // row/column boundaries.
      collectRussianStrings({ id: element.id, shapeId: element.shapeId, name: element.name, text: element.text }, sourceTexts);
      for (const cell of element.cells ?? []) collectRussianStrings(cell.text, tableCellTexts);
    }
  }
}
const supplementalTableCellTexts = new Set([...tableCellTexts].filter((text) => !sourceTexts.has(text)));
const supplementalLegalLinkTexts = new Set(
  [...legalLinkTexts].filter((text) => !sourceTexts.has(text) && !supplementalTableCellTexts.has(text)),
);
const supplementalCurrentLegalTexts = new Set(
  [...currentLegalTexts].filter(
    (text) => !sourceTexts.has(text)
      && !supplementalTableCellTexts.has(text)
      && !supplementalLegalLinkTexts.has(text),
  ),
);

if (process.argv.includes('--source-hash-only')) {
  const orderedSource = [...sourceTexts].sort((left, right) => left.localeCompare(right, 'ru'));
  const orderedTableCells = [...supplementalTableCellTexts].sort((left, right) => left.localeCompare(right, 'ru'));
  console.log(JSON.stringify({
    sourceTextUnits: sourceTexts.size + supplementalTableCellTexts.size + supplementalLegalLinkTexts.size + supplementalCurrentLegalTexts.size,
    sourceHash: sha256(orderedSource),
    supplementalTableCellUnits: supplementalTableCellTexts.size,
    supplementalTableCellHash: sha256(orderedTableCells),
    supplementalLegalLinkUnits: supplementalLegalLinkTexts.size,
    supplementalLegalLinkHash: sha256([...supplementalLegalLinkTexts].sort((left, right) => left.localeCompare(right, 'ru'))),
    supplementalCurrentLegalUnits: supplementalCurrentLegalTexts.size,
    supplementalCurrentLegalHash: sha256([...supplementalCurrentLegalTexts].sort((left, right) => left.localeCompare(right, 'ru'))),
  }));
  process.exit(0);
}

let cache = null;
try { cache = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch {}
const translations = await buildTranslations(sourceTexts, glossary, cache);
let tableCellCache = null;
try { tableCellCache = JSON.parse(await fs.readFile(tableCellCachePath, 'utf8')); } catch {}
const tableCellTranslations = supplementalTableCellTexts.size
  ? await buildTranslations(supplementalTableCellTexts, glossary, tableCellCache, tableCellCachePath)
  : { locales: Object.fromEntries(targetLocales.map((locale) => [locale, []])) };
let legalLinkCache = null;
try { legalLinkCache = JSON.parse(await fs.readFile(legalLinkCachePath, 'utf8')); } catch {}
const legalLinkTranslations = supplementalLegalLinkTexts.size
  ? await buildTranslations(supplementalLegalLinkTexts, glossary, legalLinkCache, legalLinkCachePath)
  : { locales: Object.fromEntries(targetLocales.map((locale) => [locale, []])) };
let currentLegalCache = null;
try { currentLegalCache = JSON.parse(await fs.readFile(currentLegalCachePath, 'utf8')); } catch {}
const currentLegalTranslations = supplementalCurrentLegalTexts.size
  ? await buildTranslations(supplementalCurrentLegalTexts, glossary, currentLegalCache, currentLegalCachePath)
  : { locales: Object.fromEntries(targetLocales.map((locale) => [locale, []])) };
let appliedOverrideCount = 0;
for (const override of overrides.items ?? []) {
  if (!targetLocales.includes(override.locale)) continue;
  if (sha256(normalizeText(override.source)) !== override.sourceSha256) throw new Error(`TRANSLATION_OVERRIDE_SOURCE_HASH:${override.locale}`);
  const record = [
    ...(translations.locales[override.locale] ?? []),
    ...(tableCellTranslations.locales[override.locale] ?? []),
    ...(legalLinkTranslations.locales[override.locale] ?? []),
    ...(currentLegalTranslations.locales[override.locale] ?? []),
  ].find((entry) => entry.source === normalizeText(override.source));
  if (!record) throw new Error(`TRANSLATION_OVERRIDE_SOURCE_MISSING:${override.locale}:${override.sourceSha256}`);
  record.selected = normalizeText(override.selected);
  record.backTranslation = normalizeText(override.backTranslation);
  record.selectedEngine = 'override';
  record.roundTripSimilarity = Number(diceSimilarity(record.source, record.backTranslation).toFixed(4));
  record.invariantsOk = sameArray(invariantTokens(record.source), invariantTokens(record.selected));
  record.candidatesAgree = false;
  appliedOverrideCount += 1;
}
const translationMaps = Object.fromEntries(targetLocales.map((locale) => [
  locale,
  new Map([
    ...translations.locales[locale].map((record) => [record.source, record.selected]),
    ...(tableCellTranslations.locales[locale] ?? []).map((record) => [record.source, record.selected]),
    ...(legalLinkTranslations.locales[locale] ?? []).map((record) => [record.source, record.selected]),
    ...(currentLegalTranslations.locales[locale] ?? []).map((record) => [record.source, record.selected]),
  ]),
]));
const translate = (locale, source) => {
  const normalized = normalizeText(source);
  if (!cyrillicPattern.test(normalized)) return normalized;
  const value = translationMaps[locale].get(normalized);
  if (!value) throw new Error(`TRANSLATION_MISSING:${locale}:${sha256(normalized)}`);
  return value;
};

const resolvedOutputRoot = path.resolve(outputRoot);
const expectedOutputParent = `${path.resolve(repoRoot, 'content', 'localizations')}${path.sep}`;
if (!resolvedOutputRoot.startsWith(expectedOutputParent) || path.basename(resolvedOutputRoot) !== 'staged-2026-09-01') {
  throw new Error('LOCALIZATION_OUTPUT_PATH_UNSAFE');
}
await fs.mkdir(outputRoot, { recursive: true });
// This builder owns localized JSON, while independently rendered presentation
// binaries live below presentations/*/*/assets. Never remove the staged root:
// rebuilding one locale must not destroy content-addressed PPTX/PDF artifacts.
for (const course of courses) {
  for (const locale of targetLocales) {
    await fs.rm(path.join(outputRoot, 'courses', course.slug, locale), { recursive: true, force: true });
  }
}
for (const { value } of articles) {
  for (const locale of targetLocales) {
    await fs.rm(path.join(outputRoot, 'articles', value.slug, `${locale}.json`), { force: true });
  }
}
for (const document of historicalLegal) {
  for (const locale of targetLocales) {
    await fs.rm(path.join(outputRoot, 'legal', document.documentType, document.version, `${locale}.json`), { force: true });
  }
}
for (const document of currentLegal) {
  await fs.rm(path.join(outputRoot, 'legal', document.documentType, document.version), { recursive: true, force: true });
}
for (const slug of Object.keys(presentations)) {
  for (const locale of targetLocales) {
    await fs.rm(path.join(outputRoot, 'presentations', slug, locale, 'text-map.json'), { force: true });
  }
}
await fs.rm(path.join(outputRoot, 'qa', 'text-unit-review.json'), { force: true });
await fs.rm(path.join(outputRoot, 'qa', 'automated-review-receipt.json'), { force: true });
const topologyFailures = [];
for (const course of courses) {
  const sourceTopologyHash = sha256(assessmentTopology(course));
  const mappingHash = answerMappingDigest(course);
  for (const locale of targetLocales) {
    const questionVariants = publicAssessment(course, (value) => translate(locale, value));
    const localizedTopology = questionVariants.map((variant) => ({
      id: variant.id,
      variantNumber: variant.variantNumber,
      questions: variant.questions.map((question) => ({ id: question.id, options: question.options.map((option) => option.id) })),
    }));
    if (sha256(localizedTopology) !== sourceTopologyHash) topologyFailures.push({ course: course.slug, locale, code: 'ASSESSMENT_TOPOLOGY' });
    const base = path.join(outputRoot, 'courses', course.slug, locale);
    await writeJson(path.join(base, 'assessment-import.json'), {
      version: 1,
      courseId: course.id,
      locale,
      expectedVersion: 1,
      questionVariants,
    });
    await writeJson(path.join(base, 'course-draft.json'), {
      version: 1,
      courseId: course.id,
      slug: course.slug,
      locale,
      title: translate(locale, course.title),
      description: translate(locale, course.description),
      content: { modules: [] },
      seo: translateObject(course.seo, (value) => translate(locale, value)),
      jurisdiction: translate(locale, course.jurisdiction),
      effectiveDate: course.effectiveDate,
      sources: translateObject(course.sources, (value) => translate(locale, value)),
      policy: course.policy,
      importSequence: {
        firstAdminSaveExpectedVersion: null,
        serviceAssessmentImportExpectedVersion: 1,
        completionAdminSaveExpectedVersion: 2,
        presentationId: '${PRESENTATION_ID_FROM_IMMUTABLE_UPLOAD}',
      },
      sourceTopologySha256: sourceTopologyHash,
      sourceAnswerMappingSha256: mappingHash,
      answerKeysIncluded: false,
    });
  }
}

for (const { value } of articles) {
  for (const locale of targetLocales) {
    const localized = translateObject(value, (text) => translate(locale, text));
    await writeJson(path.join(outputRoot, 'articles', value.slug, `${locale}.json`), {
      schemaVersion: 1,
      locale,
      sourceSlug: value.slug,
      ...localized,
    });
  }
}

for (const document of historicalLegal) {
  for (const locale of targetLocales) {
    const localized = translateObject(document, (text) => translate(locale, text));
    await writeJson(path.join(outputRoot, 'legal', document.documentType, document.version, `${locale}.json`), {
      ...localized,
      locale,
      bodyHash: sha256(localized.sections),
    });
  }
}

for (const document of currentLegal) {
  const versionRoot = path.join(outputRoot, 'legal', document.documentType, document.version);
  const stagePayload = {
    function: 'stage_legal_document_version',
    args: {
      p_document_type: document.documentType,
      p_version: document.version,
      p_body_revision: document.bodyRevision,
      p_effective_at: document.effectiveAt,
    },
  };
  const stagePath = path.join(versionRoot, 'stage-rpc.json');
  await writeJson(stagePath, stagePayload);
  const localizationReceipts = [];
  let referenceTopologySha256 = null;
  for (const locale of ['ru', ...targetLocales]) {
    const localized = locale === 'ru'
      ? document
      : translateObject(document, (text) => translate(locale, text));
    const body = { sections: localized.sections };
    const topologySha256 = sha256(body.sections.map((section) => ({
      id: section.id,
      paragraphCount: section.paragraphs.length,
      itemCount: section.items.length,
      links: section.links.map((link) => ({ url: link.url })),
    })));
    referenceTopologySha256 ??= topologySha256;
    if (topologySha256 !== referenceTopologySha256) {
      topologyFailures.push({ documentType: document.documentType, version: document.version, locale, code: 'LEGAL_TOPOLOGY' });
    }
    const savePayload = {
      function: 'save_legal_document_localization',
      args: {
        p_document_type: document.documentType,
        p_version: document.version,
        p_locale: locale,
        p_title: localized.title,
        p_body: body,
        // The reviewed RPC computes PostgreSQL jsonb::text SHA-256 itself.
        p_body_hash: null,
        p_complete: true,
      },
    };
    const localeRoot = path.join(versionRoot, locale);
    const savePath = path.join(localeRoot, 'save-rpc.json');
    await writeJson(savePath, savePayload);
    const saveBytes = await fs.readFile(savePath);
    const localeReceipt = {
      schemaVersion: 1,
      documentType: document.documentType,
      version: document.version,
      bodyRevision: document.bodyRevision,
      effectiveAt: document.effectiveAt,
      locale,
      productionPublished: false,
      automatedOnly: locale !== 'ru',
      canonicalSourceLocale: 'ru',
      canonicalSourceBodySha256: document.sourceBodySha256,
      localizedBodySha256: sha256(body),
      topologySha256,
      saveRpc: {
        path: path.relative(outputRoot, savePath).replaceAll('\\', '/'),
        sha256: sha256(saveBytes),
        bytes: saveBytes.length,
      },
      residualRisk: locale === 'ru'
        ? []
        : ['Automated-only translation and legal review; no human linguistic or legal approval.'],
    };
    await writeJson(path.join(localeRoot, 'artifact-receipt.json'), localeReceipt);
    localizationReceipts.push(localeReceipt);
  }
  const publishPayload = {
    function: 'publish_legal_document_localizations',
    args: {
      p_document_type: document.documentType,
      p_version: document.version,
    },
    executeOnlyDuringControlledRelease: true,
  };
  const publishPath = path.join(versionRoot, 'publish-rpc.json');
  await writeJson(publishPath, publishPayload);
  const [stageBytes, publishBytes] = await Promise.all([fs.readFile(stagePath), fs.readFile(publishPath)]);
  await writeJson(path.join(versionRoot, 'publication-receipt.json'), {
    schemaVersion: 1,
    documentType: document.documentType,
    version: document.version,
    bodyRevision: document.bodyRevision,
    effectiveAt: document.effectiveAt,
    productionPublished: false,
    currentPointerActivation: 'deferred-to-controlled-release',
    requiredOrder: [
      'deploy-compatible-read-path',
      'stage-legal-version',
      'save-four-complete-localizations',
      'verify-four-body-hashes-and-topology',
      'publish-localizations-and-rotate-current-in-one-database-transaction',
      'activate-application-current-pointer',
    ],
    stageRpc: {
      path: path.relative(outputRoot, stagePath).replaceAll('\\', '/'),
      sha256: sha256(stageBytes),
      bytes: stageBytes.length,
    },
    localizationReceipts: localizationReceipts.map((item) => ({
      locale: item.locale,
      localizedBodySha256: item.localizedBodySha256,
      topologySha256: item.topologySha256,
      saveRpc: item.saveRpc,
    })),
    publishRpc: {
      path: path.relative(outputRoot, publishPath).replaceAll('\\', '/'),
      sha256: sha256(publishBytes),
      bytes: publishBytes.length,
      executed: false,
    },
    review: {
      mode: 'automated-only',
      humanLinguisticApproval: false,
      humanLegalApproval: false,
      residualRisk: 'Semantic or legal divergence can remain after automated translation and review.',
    },
  });
}

for (const [slug, slides] of Object.entries(presentations)) {
  for (const locale of targetLocales) {
    const localizedSlides = slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => ({
        ...element,
        sourceTextSha256: sha256(element.text),
        translatedText: translate(locale, element.text),
        cells: element.cells?.map((cell) => ({
          // Coordinates intentionally stay 1-based to match artifact-tool's
          // exported layout schema and make the service edit plan auditable.
          row: cell.row,
          column: cell.column,
          text: cell.text,
          sourceTextSha256: sha256(cell.text),
          translatedText: translate(locale, cell.text),
        })),
      })),
    }));
    await writeJson(path.join(outputRoot, 'presentations', slug, locale, 'text-map.json'), {
      schemaVersion: 1,
      slug,
      locale,
      sourcePptx: `content/source-materials/derived/${slug}/presentation.pptx`,
      slideCount: slides.length,
      slides: localizedSlides,
    });
  }
}

const unitReceipt = [];
for (const locale of targetLocales) {
  for (const record of [
    ...translations.locales[locale],
    ...(tableCellTranslations.locales[locale] ?? []),
    ...(legalLinkTranslations.locales[locale] ?? []),
    ...(currentLegalTranslations.locales[locale] ?? []),
  ]) {
    unitReceipt.push({
      locale,
      sourceSha256: sha256(record.source),
      selectedSha256: sha256(record.selected),
      backTranslationSha256: sha256(record.backTranslation),
      selectedEngine: record.selectedEngine,
      roundTripSimilarity: record.roundTripSimilarity,
      invariantsOk: sameArray(invariantTokens(record.source), invariantTokens(record.selected)),
      candidatesAgree: record.candidatesAgree,
    });
  }
}
await writeJson(path.join(outputRoot, 'qa', 'text-unit-review.json'), unitReceipt);

const overrideFileBytes = await fs.readFile(overridePath);
const independentReviewPath = path.join(outputRoot, 'qa', 'independent-semantic-review.json');
let independentSemanticReview = null;
try {
  const bytes = await fs.readFile(independentReviewPath);
  const value = JSON.parse(bytes.toString('utf8'));
  const acceptedOverrideHash = value.acceptedOverrideFileSha256 ?? value.overrides?.fileSha256 ?? null;
  if (
    value.schemaVersion !== 1
    || value.status !== 'passed'
    || value.automatedOnly !== true
    || value.noHumanApproval !== true
    || /google translate/iu.test(value.providerFamily ?? '')
    || !Array.isArray(value.validationFailures)
    || value.validationFailures.length !== 0
    || !Array.isArray(value.unresolvedMaterialFindings)
    || value.unresolvedMaterialFindings.length !== 0
    || acceptedOverrideHash !== sha256(overrideFileBytes)
  ) {
    throw new Error('INDEPENDENT_SEMANTIC_REVIEW_INVALID');
  }
  independentSemanticReview = {
    status: 'passed',
    path: path.relative(outputRoot, independentReviewPath).replaceAll('\\', '/'),
    sha256: sha256(bytes),
    bytes: bytes.length,
    providerFamily: value.providerFamily,
    corpusSha256: value.corpusSha256,
    reviewedSourceUnitCount: value.reviewedSourceUnitCount,
    reviewedLocalizedUnitCount: value.reviewedLocalizedUnitCount,
    acceptedOverrideFileSha256: acceptedOverrideHash,
    acceptedOverrideCount: value.acceptedOverrideCount,
    automatedOnly: true,
    noHumanApproval: true,
  };
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const allFiles = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else allFiles.push(absolute);
  }
}
await walk(outputRoot);
const artifacts = [];
for (const absolute of allFiles.filter((file) => !file.endsWith('automated-review-receipt.json')).sort()) {
  const bytes = await fs.readFile(absolute);
  artifacts.push({ path: path.relative(outputRoot, absolute).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) });
}
const warningUnits = unitReceipt.filter((item) => !item.invariantsOk || item.roundTripSimilarity < 0.25);
const receipt = {
  schemaVersion: 1,
  batchId: 'staged-2026-09-01',
  generatedAt: '2026-09-01T00:00:00.000Z',
  mode: 'automated-only',
  productionPublished: false,
  sourceReceipt: {
    catalogChecksum: '9d34b6b4f106b6886a540e0b67c2f7be27ffa6b1e3e4656013e6192ed39c228a',
    courseCount: 5,
    presentationCount: 5,
    presentationPageCount: 198,
    variantCount: 15,
    questionCount: 150,
    optionCount: 600,
    correctMappingCount: 150,
    linkedDifferences: [],
  },
  translation: {
    sourceLocale: 'ru',
    targetLocales,
    sourceTextUnitCount: sourceTexts.size + supplementalTableCellTexts.size + supplementalLegalLinkTexts.size + supplementalCurrentLegalTexts.size,
    supplementalTableCellUnitCount: supplementalTableCellTexts.size,
    supplementalLegalLinkUnitCount: supplementalLegalLinkTexts.size,
    supplementalCurrentLegalUnitCount: supplementalCurrentLegalTexts.size,
    providerFamily: 'Google Translate',
    providerFamilyCount: 1,
    transports: [
      { scope: 'core', locales: ['kk', 'en'], transport: 'translate-a-single' },
      { scope: 'core', locales: ['zh'], transport: 'mobile-web' },
      { scope: 'supplemental-table-cells-and-legal-links', locales: ['kk', 'en', 'zh'], transport: 'mobile-web' },
      { scope: 'privacy-1.3-and-terms-2.3', locales: ['kk', 'en', 'zh'], transport: translationEndpoint === 'mobile' ? 'mobile-web' : 'translate-a-single' },
    ],
    forwardPasses: [
      { engine: 'google-translate-primary-execution', glossaryProtected: true },
      { engine: 'google-translate-secondary-reversed-batch-execution', glossaryProtected: true },
    ],
    backTranslation: true,
    reconciliation: 'invariant-preserving candidate with best RU token Dice score',
    independentProvider: false,
    independentExecutions: true,
    glossarySha256: sha256(glossary),
    overridesSha256: sha256(overrides),
    overrideFileSha256: sha256(overrideFileBytes),
    appliedOverrideCount,
    independentSemanticReview: independentSemanticReview ?? {
      status: 'pending',
      automatedOnly: true,
      noHumanApproval: true,
    },
  },
  checks: {
    topologyFailures,
    warningUnitCount: warningUnits.length,
    invariantFailureCount: warningUnits.filter((item) => !item.invariantsOk).length,
    answerKeysIncluded: false,
    sourceStableIdsRetained: topologyFailures.length === 0,
  },
  residualRisk: [
    'Automated-only translation has not received human linguistic or legal approval.',
    'The two translation passes are independent executions but use the same provider family.',
    independentSemanticReview
      ? 'Independent semantic review is automated-only and does not replace human linguistic or legal approval.'
      : 'Independent semantic review is pending and must pass before the staged batch is frozen.',
    'Production upload/publication and hosted parity are intentionally deferred to the controlled release stage.',
  ],
  artifacts,
};
await writeJson(path.join(outputRoot, 'qa', 'automated-review-receipt.json'), receipt);
console.log(JSON.stringify({
  ok: topologyFailures.length === 0,
  sourceTextUnits: sourceTexts.size + supplementalTableCellTexts.size + supplementalLegalLinkTexts.size + supplementalCurrentLegalTexts.size,
  outputArtifacts: artifacts.length + 1,
  warningUnits: warningUnits.length,
  invariantFailures: receipt.checks.invariantFailureCount,
  outputRoot: path.relative(repoRoot, outputRoot).replaceAll('\\', '/'),
}));
