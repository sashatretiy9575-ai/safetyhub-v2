import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const locales = ['kk', 'en', 'zh'];
const cyrillicPattern = /\p{Script=Cyrillic}/u;

function normalizeText(value) {
  return value.replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function collectJsxText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(collectJsxText).join('');
  if (node.type === 'JSXText' || node.type === 'StringLiteral') return node.value;
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
        href: referenceName ? referenceLinks[referenceName] : hrefReference,
      };
    }).filter((link) => link.label && link.href);
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
    links: [],
  });
  return { schemaVersion: 1, ...metadata, sourceComponent: `components/legal/${fileName}`, sections };
}

function valueAtPath(value, segments) {
  return segments.reduce((current, segment) => current?.[segment], value);
}

function walkRussianStrings(value, visitor, segments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkRussianStrings(item, visitor, [...segments, index]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walkRussianStrings(child, visitor, [...segments, key]);
    return;
  }
  if (typeof value === 'string' && cyrillicPattern.test(value)) visitor(normalizeText(value), segments);
}

const corpus = new Map();
function addUnit(source, targets, context) {
  const normalizedSource = normalizeText(source);
  const normalizedTargets = Object.fromEntries(locales.map((locale) => [locale, normalizeText(targets[locale])]));
  const existing = corpus.get(normalizedSource);
  if (existing) {
    for (const locale of locales) {
      if (existing.targets[locale] !== normalizedTargets[locale]) {
        throw new Error(`INCONSISTENT_TARGET:${sha256(normalizedSource)}:${locale}`);
      }
    }
    existing.contexts.push(context);
    return;
  }
  corpus.set(normalizedSource, {
    source: normalizedSource,
    sourceSha256: sha256(normalizedSource),
    targets: normalizedTargets,
    contexts: [context],
  });
}

async function collectCourses() {
  const sourceRoot = path.join(repoRoot, 'content', 'snapshots', 'courses');
  const slugs = (await fs.readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const slug of slugs) {
    const source = await readJson(path.join(sourceRoot, slug, 'course.json'));
    const drafts = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
      locale,
      await readJson(path.join(stagedRoot, 'courses', slug, locale, 'course-draft.json')),
    ])));
    const draftSource = {
      title: source.title,
      description: source.description,
      jurisdiction: source.jurisdiction,
      seo: source.seo,
      sources: source.sources,
    };
    walkRussianStrings(draftSource, (text, segments) => {
      addUnit(text, Object.fromEntries(locales.map((locale) => [locale, valueAtPath(drafts[locale], segments)])), `course:${slug}:draft:${segments.join('.')}`);
    });

    const assessments = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
      locale,
      await readJson(path.join(stagedRoot, 'courses', slug, locale, 'assessment-import.json')),
    ])));
    for (const variant of source.variants) {
      for (const question of variant.questions) {
        const localizedQuestions = Object.fromEntries(locales.map((locale) => {
          const localizedVariant = assessments[locale].questionVariants.find((item) => item.id === variant.id);
          return [locale, localizedVariant?.questions.find((item) => item.id === question.id)];
        }));
        addUnit(question.text, Object.fromEntries(locales.map((locale) => [locale, localizedQuestions[locale].text])), `course:${slug}:question:${question.id}`);
        if (question.explanation) {
          addUnit(question.explanation, Object.fromEntries(locales.map((locale) => [locale, localizedQuestions[locale].explanation])), `course:${slug}:explanation:${question.id}`);
        }
        for (const option of question.options) {
          addUnit(option.text, Object.fromEntries(locales.map((locale) => [
            locale,
            localizedQuestions[locale].options.find((item) => item.id === option.id)?.text,
          ])), `course:${slug}:option:${option.id}`);
        }
      }
    }
  }
}

async function collectArticles() {
  const sourceRoot = path.join(repoRoot, 'content', 'articles');
  const files = (await fs.readdir(sourceRoot)).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    const slug = file.slice(0, -5);
    const source = await readJson(path.join(sourceRoot, file));
    const targets = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
      locale,
      await readJson(path.join(stagedRoot, 'articles', slug, `${locale}.json`)),
    ])));
    walkRussianStrings(source, (text, segments) => {
      addUnit(text, Object.fromEntries(locales.map((locale) => [locale, valueAtPath(targets[locale], segments)])), `article:${slug}:${segments.join('.')}`);
    });
  }
}

async function collectLegal() {
  const sources = [
    await extractLegalSource('privacy-policy-v1-2.tsx', {
      documentType: 'privacy', title: 'Политика конфиденциальности', version: '1.2', bodyRevision: 'privacy-1.2', effectiveDate: '2026-08-31',
    }),
    await extractLegalSource('terms-policy-v2-2.tsx', {
      documentType: 'terms', title: 'Условия использования', version: '2.2', bodyRevision: 'terms-2.2', effectiveDate: '2026-08-31',
    }),
  ];
  for (const source of sources) {
    const targets = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
      locale,
      await readJson(path.join(stagedRoot, 'legal', source.documentType, source.version, `${locale}.json`)),
    ])));
    walkRussianStrings(source, (text, segments) => {
      const context = `legal:${source.documentType}:${source.version}:${segments.join('.')}`;
      const localizedValues = Object.fromEntries(locales.map((locale) => [locale, valueAtPath(targets[locale], segments)]));
      const missingLocales = locales.filter((locale) => typeof localizedValues[locale] !== 'string');
      if (missingLocales.length) {
        throw new Error(`MISSING_LEGAL_TARGET:${context}:${missingLocales.join(',')}:${sha256(text)}`);
      }
      addUnit(text, localizedValues, context);
    });
  }

  const currentSources = [
    path.join(repoRoot, 'content', 'legal', 'privacy', '1.3.ru.json'),
    path.join(repoRoot, 'content', 'legal', 'terms', '2.3.ru.json'),
  ];
  for (const sourcePath of currentSources) {
    const source = await readJson(sourcePath);
    const targets = Object.fromEntries(await Promise.all(locales.map(async (locale) => {
      const payload = await readJson(path.join(
        stagedRoot,
        'legal',
        source.documentType,
        source.version,
        locale,
        'save-rpc.json',
      ));
      return [locale, { title: payload.args.p_title, body: payload.args.p_body }];
    })));
    const localizedSource = { title: source.title, body: source.body };
    walkRussianStrings(localizedSource, (text, segments) => {
      const context = `legal:${source.documentType}:${source.version}:${segments.join('.')}`;
      const localizedValues = Object.fromEntries(locales.map((locale) => [locale, valueAtPath(targets[locale], segments)]));
      const missingLocales = locales.filter((locale) => typeof localizedValues[locale] !== 'string');
      if (missingLocales.length) {
        throw new Error(`MISSING_LEGAL_TARGET:${context}:${missingLocales.join(',')}:${sha256(text)}`);
      }
      addUnit(text, localizedValues, context);
    });
  }
}

async function collectPresentations() {
  const presentationRoot = path.join(stagedRoot, 'presentations');
  const slugs = (await fs.readdir(presentationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const slug of slugs) {
    const maps = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
      locale,
      await readJson(path.join(presentationRoot, slug, locale, 'text-map.json')),
    ])));
    const reference = maps.en;
    for (let slideIndex = 0; slideIndex < reference.slides.length; slideIndex += 1) {
      const slide = reference.slides[slideIndex];
      for (let elementIndex = 0; elementIndex < slide.elements.length; elementIndex += 1) {
        const element = slide.elements[elementIndex];
        addUnit(element.text, Object.fromEntries(locales.map((locale) => [
          locale,
          maps[locale].slides[slideIndex].elements[elementIndex].translatedText,
        ])), `presentation:${slug}:slide:${slide.slide}:element:${element.id}`);
        for (let cellIndex = 0; cellIndex < (element.cells?.length ?? 0); cellIndex += 1) {
          const cell = element.cells[cellIndex];
          addUnit(cell.text, Object.fromEntries(locales.map((locale) => [
            locale,
            maps[locale].slides[slideIndex].elements[elementIndex].cells[cellIndex].translatedText,
          ])), `presentation:${slug}:slide:${slide.slide}:cell:${cell.row}:${cell.column}`);
        }
      }
    }
  }
}

await Promise.all([collectCourses(), collectArticles(), collectLegal(), collectPresentations()]);

const glossary = await readJson(path.join(repoRoot, 'content', 'localizations', 'glossary.ru-kk-en-zh.json'));
const ordered = [...corpus.values()].sort((left, right) => left.source.localeCompare(right.source, 'ru'));

const immutableTokens = (value) => [
  ...(value.match(/(?:https?:\/\/[^\s)\]}]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|Asia\/Oral|SafetyHub(?:\.kz)?|\{[^{}]+\})/giu) ?? []),
  ...(value.replaceAll('₀', '0').replaceAll('₁', '1').replaceAll('₂', '2').replaceAll('₃', '3')
    .replaceAll('₄', '4').replaceAll('₅', '5').replaceAll('₆', '6').replaceAll('₇', '7')
    .replaceAll('₈', '8').replaceAll('₉', '9').match(/\d+/gu) ?? []),
].map((item) => item.toLocaleLowerCase('ru-RU')).sort();

function normalizedImmutableTokens(value) {
  return immutableTokens(value).map((token) => (
    /^\d+$/u.test(token) ? token.replace(/^0+(?=\d)/u, '') : token
  )).sort();
}

function letterCount(value) {
  return (value.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function semanticLengthRatio(source, target, locale) {
  const sourceLength = letterCount(source);
  if (sourceLength < 18) return 1;
  const targetLength = letterCount(target);
  const expectedCompression = locale === 'zh' ? 0.18 : 1;
  return targetLength / (sourceLength * expectedCompression);
}

const sourceNegation = /(?:^|[^\p{L}])(?:не|ни|нельзя|запрещ(?:ен[аоы]?|ается|ено)|недопустим(?:о|ы|а)?|без|отсутств(?:ие|уют)|никогда)(?:$|[^\p{L}])/iu;
const targetNegation = {
  kk: /(?:^|[^\p{L}])(?:емес|жоқ|болмайды|тыйым|рұқсат етілмейді|жасамаңыз|қолданбаңыз|тоқтатпай|орындамаңыз|ешқашан|рұқсатсыз|қауіпсіз емес|жол берілмейді)(?:$|[^\p{L}])/iu,
  en: /(?:^|[^\p{L}])(?:no|not|never|without|prohibit(?:ed|s)?|forbid(?:den)?|mustn['’]?t|shouldn['’]?t|cannot|can['’]?t|do not|does not|isn['’]?t|aren['’]?t|unavailable|absence|lack)(?:$|[^\p{L}])/iu,
  zh: /[不无未禁得勿严否莫]/u,
};

const findings = [];
for (const unit of ordered) {
  for (const locale of locales) {
    const target = unit.targets[locale];
    const categories = [];
    if (!target) categories.push('EMPTY_TARGET');
    if (locale !== 'kk' && cyrillicPattern.test(target)) categories.push('UNTRANSLATED_CYRILLIC');
    if (target.toLocaleLowerCase(locale) === unit.source.toLocaleLowerCase('ru-RU')) categories.push('IDENTICAL_TARGET');
    if (stableJson(normalizedImmutableTokens(unit.source)) !== stableJson(normalizedImmutableTokens(target))) categories.push('INVARIANT_MISMATCH');
    if ((unit.source.match(/•/gu) ?? []).length !== (target.match(/•/gu) ?? []).length) categories.push('BULLET_TOPOLOGY_REVIEW');
    if ((unit.source.match(/\|/gu) ?? []).length !== (target.match(/\|/gu) ?? []).length) categories.push('TABLE_TOPOLOGY_REVIEW');
    if (semanticLengthRatio(unit.source, target, locale) < 0.45) categories.push('OMISSION_RATIO_REVIEW');
    if (sourceNegation.test(unit.source) && !targetNegation[locale].test(target)) categories.push('NEGATION_REVIEW');
    for (const term of glossary.terms) {
      const escaped = term.ru.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(unit.source)
        && !target.toLocaleLowerCase(locale).includes(term[locale].toLocaleLowerCase(locale))) {
        categories.push(`GLOSSARY:${term.ru}`);
      }
    }
    if (categories.length) findings.push({ sourceSha256: unit.sourceSha256, locale, categories, contexts: unit.contexts.slice(0, 5) });
  }
}

const filterLocale = process.argv.find((argument) => argument.startsWith('--locale='))?.slice('--locale='.length);
const filterCategory = process.argv.find((argument) => argument.startsWith('--category='))?.slice('--category='.length);
const filterPattern = process.argv.find((argument) => argument.startsWith('--pattern='))?.slice('--pattern='.length);
const filterContext = process.argv.find((argument) => argument.startsWith('--context='))?.slice('--context='.length);
const offset = Number.parseInt(process.argv.find((argument) => argument.startsWith('--offset='))?.slice('--offset='.length) ?? '0', 10);
const limit = Number.parseInt(process.argv.find((argument) => argument.startsWith('--limit='))?.slice('--limit='.length) ?? '100', 10);

let output = ordered;
if (filterLocale) output = output.map((unit) => ({ ...unit, targets: { [filterLocale]: unit.targets[filterLocale] } }));
if (filterCategory) {
  const hashes = new Set(findings.filter((finding) => (
    (!filterLocale || finding.locale === filterLocale)
    && finding.categories.some((category) => category.includes(filterCategory))
  )).map((finding) => finding.sourceSha256));
  output = output.filter((unit) => hashes.has(unit.sourceSha256));
}
if (filterPattern) {
  const pattern = new RegExp(filterPattern, 'iu');
  output = output.filter((unit) => pattern.test(unit.source) || Object.values(unit.targets).some((target) => pattern.test(target)));
}
if (filterContext) {
  const pattern = new RegExp(filterContext, 'iu');
  output = output.filter((unit) => unit.contexts.some((context) => pattern.test(context)));
}
if (process.argv.includes('--sort-context')) {
  output = [...output].sort((left, right) => left.contexts[0].localeCompare(right.contexts[0], 'en'));
}

const categoryCounts = {};
for (const finding of findings) {
  for (const category of finding.categories) categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
}

const proposalPathArgument = process.argv.find((argument) => argument.startsWith('--proposal='))?.slice('--proposal='.length);
if (proposalPathArgument) {
  const proposalPath = path.resolve(repoRoot, proposalPathArgument);
  const proposal = await readJson(proposalPath);
  const proposedItems = Array.isArray(proposal.items) ? proposal.items : [];
  const proposalSources = new Set();
  const proposalFailures = [];
  const severityCounts = {};
  const proposalCategoryCounts = {};
  const expandedItems = [];

  for (const [index, item] of proposedItems.entries()) {
    const normalizedSource = normalizeText(item.source ?? '');
    const unit = corpus.get(normalizedSource);
    if (!normalizedSource) proposalFailures.push({ index, code: 'EMPTY_SOURCE' });
    if (proposalSources.has(normalizedSource)) proposalFailures.push({ index, code: 'DUPLICATE_SOURCE', sourceSha256: sha256(normalizedSource) });
    proposalSources.add(normalizedSource);
    if (!unit) {
      proposalFailures.push({ index, code: 'SOURCE_NOT_IN_CORPUS', sourceSha256: sha256(normalizedSource) });
      continue;
    }

    severityCounts[item.severity] = (severityCounts[item.severity] ?? 0) + 1;
    proposalCategoryCounts[item.category] = (proposalCategoryCounts[item.category] ?? 0) + 1;
    const targetEvidence = {};
    const proposedLocales = Object.keys(item.targets ?? {});
    for (const locale of proposedLocales) {
      if (!locales.includes(locale)) {
        proposalFailures.push({ index, locale, sourceSha256: unit.sourceSha256, codes: ['UNSUPPORTED_LOCALE'] });
        continue;
      }
      const proposedTarget = normalizeText(item.targets[locale] ?? '');
      const validationCodes = [];
      if (!proposedTarget) validationCodes.push('EMPTY_PROPOSED_TARGET');
      if (locale !== 'kk' && cyrillicPattern.test(proposedTarget)) validationCodes.push('UNTRANSLATED_CYRILLIC');
      if (stableJson(normalizedImmutableTokens(normalizedSource)) !== stableJson(normalizedImmutableTokens(proposedTarget))) {
        validationCodes.push('INVARIANT_MISMATCH');
      }
      if ((normalizedSource.match(/•/gu) ?? []).length !== (proposedTarget.match(/•/gu) ?? []).length) {
        validationCodes.push('BULLET_TOPOLOGY_MISMATCH');
      }
      if ((normalizedSource.match(/\|/gu) ?? []).length !== (proposedTarget.match(/\|/gu) ?? []).length) {
        validationCodes.push('TABLE_TOPOLOGY_MISMATCH');
      }
      if (validationCodes.length) {
        proposalFailures.push({ index, locale, sourceSha256: unit.sourceSha256, codes: validationCodes });
      }
      targetEvidence[locale] = {
        currentTargetSha256: sha256(unit.targets[locale]),
        proposedTargetSha256: sha256(proposedTarget),
        changed: unit.targets[locale] !== proposedTarget,
      };
    }
    expandedItems.push({
      source: normalizedSource,
      sourceSha256: unit.sourceSha256,
      severity: item.severity,
      category: item.category,
      rationale: item.rationale,
      contexts: unit.contexts,
      currentTargets: unit.targets,
      proposedTargets: Object.fromEntries(proposedLocales.map((locale) => [locale, normalizeText(item.targets?.[locale] ?? '')])),
      targetEvidence,
    });
  }

  const result = {
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:00:00.000Z',
    reviewer: proposal.reviewer,
    scope: proposal.scope,
    corpusSha256: sha256(ordered.map(({ sourceSha256, targets }) => ({
      sourceSha256,
      targetSha256: Object.fromEntries(locales.map((locale) => [locale, sha256(targets[locale])])),
    }))),
    proposalSha256: sha256(proposal),
    itemCount: expandedItems.length,
    severityCounts,
    categoryCounts: proposalCategoryCounts,
    validationFailures: proposalFailures,
    items: expandedItems,
  };
  const writePathArgument = process.argv.find((argument) => argument.startsWith('--write='))?.slice('--write='.length);
  if (writePathArgument) {
    const writePath = path.resolve(repoRoot, writePathArgument);
    await fs.mkdir(path.dirname(writePath), { recursive: true });
    await fs.writeFile(writePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({
    ok: proposalFailures.length === 0,
    corpusSha256: result.corpusSha256,
    proposalSha256: result.proposalSha256,
    itemCount: result.itemCount,
    severityCounts,
    categoryCounts: proposalCategoryCounts,
    validationFailures: proposalFailures,
    writePath: writePathArgument ?? null,
  }, null, 2));
  process.exit(proposalFailures.length === 0 ? 0 : 1);
}

if (process.argv.includes('--debug-source-diff')) {
  const builderCache = await readJson(path.join(repoRoot, 'tmp', 'stage6', 'translation-cache.json'));
  const builderSources = new Set((builderCache.locales?.en ?? []).map((record) => normalizeText(record.source)));
  const corpusSources = new Set(ordered.map((unit) => unit.source));
  console.log(JSON.stringify({
    onlyCorpus: ordered.filter((unit) => !builderSources.has(unit.source)).map((unit) => ({ source: unit.source, contexts: unit.contexts })),
    onlyBuilder: [...builderSources].filter((source) => !corpusSources.has(source)),
  }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--summary')) {
  const contextCategoryCounts = {};
  for (const unit of ordered) {
    for (const category of new Set(unit.contexts.map((context) => context.split(':')[0]))) {
      contextCategoryCounts[category] = (contextCategoryCounts[category] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify({
    ok: true,
    sourceUnits: ordered.length,
    targetUnits: ordered.length * locales.length,
    corpusSha256: sha256(ordered.map(({ sourceSha256, targets }) => ({ sourceSha256, targetSha256: Object.fromEntries(locales.map((locale) => [locale, sha256(targets[locale])])) }))),
    deterministicFindingCount: findings.length,
    categoryCounts,
    contextCategoryCounts,
  }, null, 2));
} else {
  const sliced = output.slice(offset, offset + limit);
  const units = process.argv.includes('--compact')
    ? sliced.map((unit) => ({ source: unit.source, targets: unit.targets, context: unit.contexts[0] }))
    : sliced;
  console.log(JSON.stringify({ total: output.length, offset, limit, units }, null, 2));
}
