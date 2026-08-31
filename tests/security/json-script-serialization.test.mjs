import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeJsonForScript } from '../../lib/security/json-script.ts';

test('JSON-LD serialization cannot terminate its script element', () => {
  const value = {
    headline: '</script><script>globalThis.__jsonLdXss = true</script>',
    description: 'A&B > C\u2028D\u2029E',
  };
  const serialized = serializeJsonForScript(value);

  assert.doesNotMatch(serialized, /<|>|&|\u2028|\u2029/u);
  assert.match(serialized, /\\u003c\/script\\u003e/u);
  assert.deepEqual(JSON.parse(serialized), value);
});

test('JSON-LD serialization preserves ordinary structured data', () => {
  const value = [{ '@context': 'https://schema.org', score: 5, valid: true, missing: null }];
  assert.deepEqual(JSON.parse(serializeJsonForScript(value)), value);
});
