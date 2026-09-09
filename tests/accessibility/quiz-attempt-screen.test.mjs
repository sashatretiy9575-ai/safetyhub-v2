import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const client = await readFile(new URL('../../components/quiz/quiz-client.ts' + 'x', import.meta.url), 'utf8');
const styles = await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8');

test('the question navigation wraps instead of running off the screen', () => {
  // Ten 44 px targets with 8 px gaps need 512 px in one row. The container never
  // wrapped and never scrolled, and the app shell clips horizontal overflow, so
  // from about the fifth question onward the remaining buttons were physically
  // unreachable — including the one that returns to the first question.
  const nav = client.slice(client.indexOf("aria-label={t('questionsAria')}"));
  const openingTag = nav.slice(0, nav.indexOf('>'));
  assert.match(openingTag, /flex-wrap/u);
  assert.doesNotMatch(openingTag, /overflow-x-auto/u, 'wrapping is preferred over a scroller');
});

test('keyboard focus on an answer is visible', () => {
  // The radio itself is `sr-only`, so the focus ring was drawn around a 1x1 px
  // box: nothing on screen showed which answer had focus.
  const label = client.slice(client.indexOf('flex min-h-12 w-full cursor-pointer'));
  assert.match(label.slice(0, 400), /has-\[:focus-visible\]:outline-\[3px\]/u);
  assert.match(label.slice(0, 400), /has-\[:focus-visible\]:outline-\[var\(--color-focus\)\]/u);
});

test('nothing on the primary fill is painted with a hard-coded white', () => {
  // `--color-primary` is a light green in the dark theme, where white text on it
  // measures 2.33:1. The token flips with the theme; the literal does not.
  assert.doesNotMatch(client, /bg-\[var\(--color-primary\)\][^'`]*text-white/u);
  assert.match(client, /bg-\[var\(--color-primary\)\][^'`]*text-\[var\(--color-primary-foreground\)\]/u);
  assert.match(styles, /--color-primary-foreground:/u);
  // Both themes must define it, or the fix only works in one of them.
  const darkBlock = styles.slice(styles.indexOf('.dark {'));
  assert.match(darkBlock, /--color-primary-foreground:/u);
});

test('the expired badge uses the warning token rather than raw amber', () => {
  // Amber on the soft amber surface measures 1.93:1 against a 3:1 threshold for
  // a graphic that carries meaning.
  assert.doesNotMatch(
    client,
    /bg-\[var\(--color-accent-amber-soft\)\] text-\[var\(--color-accent-amber\)\]/u,
  );
  assert.match(client, /bg-\[var\(--color-accent-amber-soft\)\] text-\[var\(--color-warning\)\]/u);
});

test('the page keeps one stable heading across all four states', () => {
  // The only h1 used to be the current question, so the page renamed itself on
  // every click and the course being certified was never a heading at all.
  const headings = client.match(/<h1[^>]*>/gu) ?? [];
  assert.equal(headings.length, 4, 'loading, error, result and question views each own one h1');
  assert.equal(
    client.match(/<h1 className="sr-only">\{title\}<\/h1>/gu)?.length,
    3,
    'the three non-result views name the course',
  );
  assert.doesNotMatch(client, /<h1[^>]*>\{currentQuestion\.text\}/u);
  assert.match(client, /<h2 className="font-display text-xl leading-tight font-bold">\{currentQuestion\.text\}<\/h2>/u);
});

test('leaving mid-attempt with answers is warned about', () => {
  // The guard used to read a ref, and a ref write never re-runs an effect, so it
  // covered nothing in practice. It now also covers the ordinary case: an
  // attempt in progress that already has answers.
  assert.match(client, /const \[localBackupFailed, setLocalBackupFailed\] = useState\(false\)/u);
  assert.match(client, /attempt\?\.status === 'started' && answers\.length > 0/u);
  assert.match(
    client,
    /\}, \[answers\.length, attempt\?\.status, localBackupFailed, submissionLocked\]\);/u,
  );
});

test('answer letters come from a list, not from character arithmetic', () => {
  // `String.fromCharCode(64 + position)` silently produced bracket characters
  // past the fourth option and hid the fact that exactly four are allowed.
  assert.doesNotMatch(client, /String\.fromCharCode\(64 \+/u);
  assert.match(client, /const OPTION_LABELS = \['A', 'B', 'C', 'D'\] as const;/u);
});
