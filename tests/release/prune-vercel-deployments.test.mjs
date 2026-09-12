import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  main as pruneDeployments,
  parseArguments,
  planDeploymentPrune,
} from '../../scripts/prune-vercel-deployments.mjs';

const TOKEN = `vercel-test-token-${'t'.repeat(24)}`;
const ENV = {
  VERCEL_TOKEN: TOKEN,
  VERCEL_PROJECT: 'safetyhub-v2',
  VERCEL_TEAM_SLUG: 'relirdghs-projects',
};
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 13, 12);

function deployment(uid, hoursAgo, state = 'READY', target = 'production') {
  return { uid, url: `${uid}.vercel.app`, state, target, created: NOW - hoursAgo * HOUR };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const uids = (entries) => entries.map((entry) => entry.uid);
const quiet = { log: () => {}, sleep: async () => {} };

test('the three newest successful production deployments stay and every older deployment goes', () => {
  const plan = planDeploymentPrune(
    [
      deployment('ready-1', 1),
      deployment('ready-2', 2),
      deployment('failed-old', 2.5, 'ERROR'),
      deployment('ready-3', 3),
      deployment('ready-4', 4),
      deployment('canceled-old', 5, 'CANCELED'),
      deployment('preview-old', 6, 'READY', null),
      deployment('ready-5', 30),
    ],
    { keep: 3, liveIds: ['ready-1'] },
  );
  assert.deepEqual(uids(plan.keep), ['ready-1', 'ready-2', 'ready-3']);
  assert.deepEqual(uids(plan.remove), [
    'failed-old',
    'ready-4',
    'canceled-old',
    'preview-old',
    'ready-5',
  ]);
});

test('the deployment a production domain serves is never deleted, even after a rollback to an older one', () => {
  const plan = planDeploymentPrune(
    [
      deployment('ready-1', 1),
      deployment('ready-2', 2),
      deployment('ready-3', 3),
      deployment('rolled-back-to', 9),
    ],
    { keep: 3, liveIds: ['rolled-back-to'] },
  );
  assert.deepEqual(plan.remove, []);
  assert.equal(
    plan.keep.find((entry) => entry.uid === 'rolled-back-to')?.reason,
    'serves the production domain',
  );
});

test('a running build is never touched, and a newer failed or preview deployment waits for the next successful release', () => {
  const plan = planDeploymentPrune(
    [
      deployment('building', 0.1, 'BUILDING'),
      deployment('failed-new', 0.5, 'ERROR'),
      deployment('preview-new', 0.7, 'READY', null),
      deployment('ready-1', 1),
      deployment('queued-old', 8, 'QUEUED'),
      deployment('failed-old', 9, 'ERROR'),
    ],
    { keep: 3, liveIds: ['ready-1'] },
  );
  assert.deepEqual(uids(plan.waiting), ['building', 'failed-new', 'preview-new', 'queued-old']);
  assert.deepEqual(uids(plan.remove), ['failed-old']);
});

test('nothing is deleted while no successful production deployment is known', () => {
  const plan = planDeploymentPrune(
    [deployment('failed', 1, 'ERROR'), deployment('preview', 2, 'READY', null)],
    { keep: 3, liveIds: ['live'] },
  );
  assert.deepEqual(plan.remove, []);
});

test('the CLI deletes only the planned deployments, waits out a rate limit and never prints the token', async () => {
  const calls = [];
  const lines = [];
  let deleteAttempts = 0;
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({
      method: init.method,
      pathname,
      slug: searchParams.get('slug'),
      authorization: init.headers.authorization,
    });
    if (pathname === '/v9/projects/safetyhub-v2') {
      return json({ id: 'prj_1', targets: { production: { id: 'ready-1' } } });
    }
    if (pathname === '/v9/projects/prj_1/domains') {
      return json({ domains: [{ name: 'safetyhub.kz' }, { name: 'www.safetyhub.kz' }] });
    }
    if (pathname === '/v4/aliases/safetyhub.kz') return json({ deploymentId: 'ready-1' });
    if (pathname === '/v4/aliases/www.safetyhub.kz') {
      return json({ error: { code: 'not_found' } }, 404);
    }
    if (pathname === '/v7/deployments') {
      if (!searchParams.get('until')) {
        return json({
          deployments: [
            deployment('ready-1', 1),
            deployment('ready-2', 2),
            deployment('ready-3', 3),
          ],
          pagination: { next: NOW - 3 * HOUR },
        });
      }
      return json({
        deployments: [
          deployment('ready-3', 3),
          deployment('ready-4', 4),
          deployment('failed-old', 5, 'ERROR'),
        ],
        pagination: { next: null },
      });
    }
    if (init.method === 'DELETE') {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        return json({ error: { code: 'rate_limited' } }, 429, { 'retry-after': '1' });
      }
      return json({ uid: pathname.split('/').at(-1), state: 'DELETED' });
    }
    return json({ error: { code: 'unexpected' } }, 500);
  };

  const result = await pruneDeployments([], {
    env: ENV,
    fetchImpl,
    log: (line) => lines.push(line),
    sleep: async () => {},
  });

  assert.deepEqual(result.deleted, ['ready-4', 'failed-old']);
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => call.pathname),
    ['/v13/deployments/ready-4', '/v13/deployments/ready-4', '/v13/deployments/failed-old'],
  );
  assert.ok(calls.every((call) => call.slug === 'relirdghs-projects'));
  assert.ok(calls.every((call) => call.authorization === `Bearer ${TOKEN}`));
  assert.equal(lines.join(' ').includes(TOKEN), false);
});

test('a dry run prints the plan and deletes nothing', async () => {
  const methods = [];
  const fetchImpl = async (url, init) => {
    methods.push(init.method);
    const { pathname } = new URL(url);
    if (pathname === '/v9/projects/safetyhub-v2') {
      return json({ id: 'prj_1', targets: { production: { id: 'ready-1' } } });
    }
    if (pathname === '/v9/projects/prj_1/domains') return json({ domains: [] });
    return json({
      deployments: [
        deployment('ready-1', 1),
        deployment('ready-2', 2),
        deployment('ready-3', 3),
        deployment('ready-4', 4),
      ],
      pagination: { next: null },
    });
  };
  const result = await pruneDeployments(['--dry-run'], { env: ENV, fetchImpl, ...quiet });
  assert.deepEqual(result.planned, ['ready-4']);
  assert.equal(methods.includes('DELETE'), false);
});

test('without a token or a known live deployment the CLI stops before deleting anything', async () => {
  await assert.rejects(
    pruneDeployments([], {
      env: {},
      fetchImpl: async () => {
        throw new Error('no request expected');
      },
      ...quiet,
    }),
    /PRUNE_TOKEN_MISSING/u,
  );

  const methods = [];
  const fetchImpl = async (url, init) => {
    methods.push(init.method);
    const { pathname } = new URL(url);
    if (pathname === '/v9/projects/safetyhub-v2') return json({ id: 'prj_1', targets: {} });
    if (pathname === '/v9/projects/prj_1/domains') return json({ domains: [] });
    return json({ deployments: [deployment('ready-1', 1)], pagination: { next: null } });
  };
  await assert.rejects(
    pruneDeployments([], { env: ENV, fetchImpl, ...quiet }),
    /PRUNE_LIVE_DEPLOYMENT_UNKNOWN/u,
  );
  assert.equal(methods.includes('DELETE'), false);

  assert.throws(() => parseArguments(['--keep=0']), /PRUNE_KEEP_INVALID/u);
  assert.throws(() => parseArguments(['--force']), /PRUNE_ARGUMENT_UNKNOWN/u);
});

test('the workflow prunes after every successful deployment and on demand, from main, with the token secret', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/prune-vercel-deployments.yml', import.meta.url),
    'utf8',
  );
  assert.ok(workflow.includes('  deployment_status:'));
  assert.ok(workflow.includes('  workflow_dispatch:'));
  assert.ok(workflow.includes("- cron: '17 * * * *'"));
  assert.ok(workflow.includes("github.event_name != 'deployment_status'"));
  assert.ok(workflow.includes("github.event.deployment_status.state == 'success'"));
  assert.ok(workflow.includes('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN || secrets.NAME }}'));
  assert.ok(workflow.includes('ref: main'));
  assert.ok(workflow.includes('contents: read'));
  assert.ok(workflow.includes('node scripts/prune-vercel-deployments.mjs --keep=3'));
  assert.equal(workflow.includes('pull_request'), false);
});
