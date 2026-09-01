import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import fontkit from '@pdf-lib/fontkit';
import {
  hasExactCanonicalSearch,
  hasExactCanonicalUuidPath,
} from '../../lib/security/canonical-search.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('immutable asset queries must match the complete canonical raw query', () => {
  const base = 'https://safetyhub.kz/certificate-assets/font';
  assert.equal(
    hasExactCanonicalSearch(`${base}?locale=zh&v=Sans2.004`, '?locale=zh&v=Sans2.004'),
    true,
  );
  assert.equal(
    hasExactCanonicalSearch(`${base}?v=Sans2.004&locale=zh`, '?locale=zh&v=Sans2.004'),
    false,
  );
  assert.equal(
    hasExactCanonicalSearch(`${base}?locale=zh&v=Sans2.004&x=1`, '?locale=zh&v=Sans2.004'),
    false,
  );
  assert.equal(
    hasExactCanonicalSearch(`${base}?locale=zh&locale=zh&v=Sans2.004`, '?locale=zh&v=Sans2.004'),
    false,
  );
  assert.equal(
    hasExactCanonicalSearch(`${base}?locale=%7A%68&v=Sans2.004`, '?locale=zh&v=Sans2.004'),
    false,
  );
  assert.equal(hasExactCanonicalSearch(base, '?locale=zh&v=Sans2.004'), false);
  assert.equal(hasExactCanonicalSearch('https://safetyhub.kz/api/content-assets/id', ''), true);
  assert.equal(
    hasExactCanonicalSearch('https://safetyhub.kz/api/content-assets/id?x=1', ''),
    false,
  );
  assert.throws(() => hasExactCanonicalSearch(base, 'locale=zh'), /CANONICAL_SEARCH_INVALID/);
});

test('immutable UUID paths reject textual and encoded aliases before lookup', () => {
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const base = 'https://safetyhub.kz/api/content-assets';
  assert.equal(hasExactCanonicalUuidPath(`${base}/${uuid}`, '/api/content-assets', uuid), true);
  assert.equal(
    hasExactCanonicalUuidPath(
      `${base}/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE`,
      '/api/content-assets',
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    ),
    false,
  );
  assert.equal(
    hasExactCanonicalUuidPath(
      `${base}/aaaaaaaa-BBBB-4ccc-8ddd-eeeeeeeeeeee`,
      '/api/content-assets',
      'aaaaaaaa-BBBB-4ccc-8ddd-eeeeeeeeeeee',
    ),
    false,
  );
  assert.equal(
    hasExactCanonicalUuidPath(
      `${base}/%61aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      '/api/content-assets',
      uuid,
    ),
    false,
  );
  assert.equal(
    hasExactCanonicalUuidPath(
      `${base}/aaaaaaaa%2Dbbbb-4ccc-8ddd-eeeeeeeeeeee`,
      '/api/content-assets',
      uuid,
    ),
    false,
  );
  assert.equal(hasExactCanonicalUuidPath(`${base}/${uuid}/`, '/api/content-assets', uuid), false);
  assert.throws(
    () => hasExactCanonicalUuidPath(`${base}/${uuid}`, 'api/content-assets', uuid),
    /CANONICAL_PATH_PREFIX_INVALID/,
  );
});

test('font route serves only deployment-bundled pinned fonts and content assets reject query aliases', async () => {
  const [fontRoute, contentRoute, nextConfig] = await Promise.all([
    read('app/certificate-assets/font/route.ts'),
    read('app/api/content-assets/[assetId]/route.ts'),
    read('next.config.ts'),
  ]);

  assert.match(fontRoute, /NotoSansCJKsc-Regular-Sans2\.004\.otf/);
  assert.match(fontRoute, /CJK_FONT_BYTES = 16_437_364/);
  assert.match(fontRoute, /2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b/);
  assert.match(fontRoute, /fs\.readFile\(descriptor\.path\)/);
  assert.match(fontRoute, /hasExactCanonicalSearch\(request\.url, candidate\)/);
  assert.doesNotMatch(fontRoute, /fetch\(|raw\.githubusercontent|upstream/);
  assert.match(
    nextConfig,
    /'\/certificate-assets\/font':[\s\S]*NotoSansCJKsc-Regular-Sans2\.004\.otf/,
  );
  assert.ok(
    contentRoute.indexOf("hasExactCanonicalSearch(request.url, '')") <
      contentRoute.indexOf('await context.params'),
    'noncanonical content-asset requests must be rejected before database or Storage work',
  );
  assert.ok(
    contentRoute.indexOf("hasExactCanonicalUuidPath(request.url, '/api/content-assets', assetId)") <
      contentRoute.indexOf('createAdminClient()'),
    'UUID path aliases must be rejected before database or Storage work',
  );
});

test('deployment-bundled Simplified Chinese certificate font is hash-pinned and covers representative identity text', async () => {
  const bytes = await readFile(
    new URL('../../lib/pdf/assets/NotoSansCJKsc-Regular-Sans2.004.otf', import.meta.url),
  );
  assert.equal(bytes.byteLength, 16_437_364);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  );
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'OTTO');

  const font = fontkit.create(bytes);
  for (const character of '安全培训证书张伟哈萨克斯坦有限公司SafetyHub2026') {
    assert.notEqual(font.glyphForCodePoint(character.codePointAt(0)).id, 0, `missing ${character}`);
  }
});
