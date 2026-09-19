import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { attestationNeedsIssuance } from '../../lib/admin/attestation-issuance.ts';

test('an improved result remains issuable after education refusal preserves the old certificate', () => {
  const row = {
    courseDeleted: false,
    certificateState: 'issued',
    identityState: 'verified',
    scoreImproved: true,
  };
  assert.equal(attestationNeedsIssuance(row), true);
  assert.equal(row.certificateState, 'issued');
  assert.equal(attestationNeedsIssuance({ ...row, scoreImproved: false }), false);
  assert.equal(attestationNeedsIssuance({ ...row, identityState: 'pending' }), false);
  assert.equal(attestationNeedsIssuance({ ...row, courseDeleted: true }), false);
  assert.equal(attestationNeedsIssuance({ ...row, certificateState: 'not_eligible' }), false);
  for (const certificateState of ['ready', 'revoked']) {
    assert.equal(
      attestationNeedsIssuance({ ...row, certificateState, scoreImproved: false }),
      true,
    );
  }
});

test('improved issuance is reachable with issue capability alone and shared by bulk counts', async () => {
  const panel = await readFile(
    new URL('../../components/admin/attestations-manager-panels.tsx', import.meta.url),
    'utf8',
  );
  const manager = await readFile(
    new URL('../../components/admin/attestations-manager.tsx', import.meta.url),
    'utf8',
  );
  assert.match(panel, /if \(permissions\.canIssue && attestationNeedsIssuance\(row\)\)/);
  assert.match(panel, /Выдать по улучшенному результату/);
  assert.match(manager, /readyToIssue: selectedRows\.filter\(attestationNeedsIssuance\)\.length/);
  assert.match(manager, /readyToIssue: attestationNeedsIssuance\(singleTarget\) \? 1 : 0/);
});
