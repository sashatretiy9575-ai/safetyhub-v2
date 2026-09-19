import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listHref,
  listQuery,
  listStorageKey,
  parseListQuery,
  readListFilters,
} from '../../lib/admin/list-return.ts';

test('list filters survive a repeated parameter, stray spaces and an unknown status', () => {
  assert.deepEqual(readListFilters({}), { q: '', status: '' });
  assert.deepEqual(readListFilters({ q: ['  сварка ', 'другое'], status: ['draft', 'published'] }), {
    q: 'сварка',
    status: 'draft',
  });
  assert.deepEqual(readListFilters({ q: 'x'.repeat(250), status: 'archived' }), {
    q: 'x'.repeat(100),
    status: '',
  });
});

test('the canonical query leaves empty filters out and round-trips', () => {
  assert.equal(listQuery({ q: '', status: '' }), '');
  assert.equal(listQuery({ q: 'Промышленная безопасность', status: 'published' }), 'q=%D0%9F%D1%80%D0%BE%D0%BC%D1%8B%D1%88%D0%BB%D0%B5%D0%BD%D0%BD%D0%B0%D1%8F+%D0%B1%D0%B5%D0%B7%D0%BE%D0%BF%D0%B0%D1%81%D0%BD%D0%BE%D1%81%D1%82%D1%8C&status=published');
  const query = listQuery({ q: 'a&b=c', status: 'draft' });
  assert.deepEqual(readListFilters(Object.fromEntries(new URLSearchParams(query))), {
    q: 'a&b=c',
    status: 'draft',
  });
  assert.equal(listHref('/admin/courses', ''), '/admin/courses');
  assert.equal(listHref('/admin/articles', 'status=draft'), '/admin/articles?status=draft');
});

test('a stored query is parsed again: nothing but the two filters comes back', () => {
  assert.equal(parseListQuery(null), '');
  assert.equal(parseListQuery(''), '');
  assert.equal(parseListQuery('?q=%D0%BA%D1%83%D1%80%D1%81&status=published'), 'q=%D0%BA%D1%83%D1%80%D1%81&status=published');
  assert.equal(parseListQuery('status=deleted&next=https://evil.example&q='), '');
  assert.equal(parseListQuery('q=1&q=2&cursor=abc&status=draft'), 'q=1&status=draft');
  assert.equal(parseListQuery('//evil.example/?q=x'), '');
});

test('each list remembers its own query', () => {
  assert.notEqual(listStorageKey('/admin/courses'), listStorageKey('/admin/articles'));
  assert.match(listStorageKey('/admin/courses'), /^safetyhub:/u);
});
