import assert from 'node:assert/strict';
import test from 'node:test';
import { documentTextWidth, wrapDocumentText } from '../../lib/pdf/protocol-renderer.ts';

/** A font whose widths are a plain sum of per-character advances, scaled like pdf-lib scales them. */
function fakeFont() {
  const font = {
    calls: 0,
    widthOfTextAtSize(text, size) {
      font.calls += 1;
      let total = 0;
      for (const character of text) {
        const code = character.codePointAt(0);
        total += character === ' ' ? 250 : code > 0x3000 ? 1000 : 430 + (code % 7) * 35;
      }
      return total * (size / 1000);
    },
  };
  return font;
}

/** The wrapper as it was: every appended letter measured the whole growing line. */
function referenceWrap(font, text, size, width) {
  const lines = [];
  let line = '';
  for (const word of text.replace(/\s+/gu, ' ').trim().split(' ')) {
    if (line && font.widthOfTextAtSize(line + ' ' + word, size) > width) {
      lines.push(line);
      line = '';
    }
    for (const character of (line ? ' ' : '') + word) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const SAMPLES = [
  'Проверка знаний проведена в соответствии с утверждённой программой на тему: «Арматурщик».',
  'Товарищество с ограниченной ответственностью «Work Safety (Уорк Сэйфти)»',
  'Константинопольский-Задунайский Александр-Владислав Максимилианович',
  'Жауапкершілігішектеулісеріктестігіөтеұзынатауыбарұйымбөлінбейтінсөз',
  '安全生产培训考核合格证明书持有人姓名测试用超长文本不含空格',
  'Инженер по ОТ',
  'A',
  '',
];

test('the faster wrapper breaks lines exactly where the letter-by-letter one did', () => {
  for (const text of SAMPLES) {
    for (const size of [12, 11.25, 9.5, 8]) {
      for (const width of [40, 96, 150, 240, 499]) {
        const expected = referenceWrap(fakeFont(), text, size, width);
        const actual = wrapDocumentText(fakeFont(), text, size, width);
        assert.deepEqual(actual, expected, `${JSON.stringify(text)} at ${size} pt in ${width} pt`);
        assert.equal(actual.join('').replaceAll(' ', ''), text.replace(/\s+/gu, ''), 'no character is lost');
      }
    }
  }
});

test('a line is shaped once per string, not once per letter and size', () => {
  const text = SAMPLES[0];
  const slow = fakeFont();
  referenceWrap(slow, text, 12, 499);
  const fast = fakeFont();
  for (const size of [12, 11.75, 11.5, 11.25, 11]) wrapDocumentText(fast, text, size, 499);
  // Five sizes of the same text cost less than one size used to.
  assert.ok(fast.calls < slow.calls, `${fast.calls} measurements against ${slow.calls}`);
  assert.ok(slow.calls > text.length, 'the reference really measured per letter');
});

test('a cached width is the font’s own answer, and a font that scales differently is asked directly', () => {
  const font = fakeFont();
  for (const size of [8, 11.25, 12, 19.5]) {
    assert.equal(documentTextWidth(font, 'Протокол № 20.09', size), font.widthOfTextAtSize('Протокол № 20.09', size));
  }
  // Not proportional to the size: the cache must refuse this font.
  const odd = { widthOfTextAtSize: (text, size) => text.length * size + 3 };
  assert.equal(documentTextWidth(odd, 'abc', 10), 33);
  assert.equal(documentTextWidth(odd, 'abc', 20), 63);
});
