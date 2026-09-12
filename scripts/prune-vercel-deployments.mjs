/**
 * Deletes old Vercel deployments of this project, which Vercel otherwise keeps
 * forever. The three newest successful production deployments stay, and so does
 * whatever the production domains serve right now (after an instant rollback
 * that can be an older one). Everything older goes: superseded releases, failed
 * and canceled builds, previews.
 *
 * A build that has not finished is never touched. A failed or preview deployment
 * newer than the last successful release also waits for the next one: until
 * then it holds the only build log of the release that did not go out.
 *
 * Runs from .github/workflows/prune-vercel-deployments.yml after every successful
 * deployment. Environment: VERCEL_TOKEN, VERCEL_PROJECT, VERCEL_TEAM_SLUG.
 * Flags: --keep=N (default 3), --dry-run (print the plan, delete nothing).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.vercel.com';
export const DEFAULT_KEEP = 3;
// Deleting a deployment in one of these states would cancel a release in flight.
const UNFINISHED_STATES = new Set(['BLOCKED', 'BUILDING', 'INITIALIZING', 'QUEUED']);
const MAX_PAGES = 50;
const RATE_LIMIT_RETRIES = 3;

export class PruneError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PruneError';
    this.code = code;
  }
}

export function parseArguments(argv) {
  const options = { keep: DEFAULT_KEEP, dryRun: false };
  for (const argument of argv) {
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument.startsWith('--keep=')) {
      options.keep = Number(argument.slice('--keep='.length));
      if (!Number.isInteger(options.keep) || options.keep < 1 || options.keep > 20) {
        throw new PruneError('PRUNE_KEEP_INVALID', argument);
      }
    } else {
      throw new PruneError('PRUNE_ARGUMENT_UNKNOWN', argument);
    }
  }
  return options;
}

const newestFirst = (left, right) => right.created - left.created;

/**
 * Decides what to delete; pure, so the rules are tested without the API.
 * Deployments are `{ uid, url, state, target, created }`; `liveIds` are the
 * deployments the production domains serve.
 */
export function planDeploymentPrune(deployments, { keep = DEFAULT_KEEP, liveIds = [] } = {}) {
  const successful = deployments
    .filter((deployment) => deployment.target === 'production' && deployment.state === 'READY')
    .sort(newestFirst);
  const kept = new Map(
    successful.slice(0, keep).map((deployment) => [deployment.uid, 'newest successful']),
  );
  for (const uid of liveIds) {
    if (!kept.has(uid)) kept.set(uid, 'serves the production domain');
  }

  const waiting = [];
  const remove = [];
  for (const deployment of deployments) {
    if (kept.has(deployment.uid)) continue;
    const newerThanLastRelease =
      successful.length === 0 || deployment.created > successful[0].created;
    if (UNFINISHED_STATES.has(deployment.state) || newerThanLastRelease) waiting.push(deployment);
    else remove.push(deployment);
  }

  return {
    keep: [...kept].map(([uid, reason]) => ({ uid, reason })),
    waiting: waiting.sort(newestFirst),
    remove: remove.sort(newestFirst),
  };
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response) {
  const seconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 60) * 1000;
  const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  if (Number.isFinite(resetAt) && resetAt > Date.now()) {
    return Math.min(resetAt - Date.now(), 60_000);
  }
  return 5_000;
}

function createClient({ token, team, fetchImpl, sleep }) {
  async function send(method, pathname, query = {}) {
    const url = `${API_ORIGIN}${pathname}?${new URLSearchParams({ ...query, slug: team })}`;
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(retryDelay(response));
        continue;
      }
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    }
  }
  return {
    get: (pathname, query) => send('GET', pathname, query),
    remove: (pathname) => send('DELETE', pathname),
  };
}

// The API's own error code, never the request: the token travels in a header.
function failure(code, result) {
  return new PruneError(code, `HTTP ${result.status} ${result.body?.error?.code ?? ''}`.trim());
}

async function liveDeploymentIds(client, project) {
  const ids = new Set();
  if (project.targets?.production?.id) ids.add(project.targets.production.id);
  const domains = await client.get(`/v9/projects/${encodeURIComponent(project.id)}/domains`);
  if (!domains.ok) throw failure('PRUNE_DOMAINS_UNAVAILABLE', domains);
  for (const domain of domains.body?.domains ?? []) {
    const alias = await client.get(`/v4/aliases/${encodeURIComponent(domain.name)}`, {
      projectId: project.id,
    });
    if (alias.status === 404) continue;
    if (!alias.ok) throw failure('PRUNE_ALIAS_UNAVAILABLE', alias);
    if (alias.body?.deploymentId) ids.add(alias.body.deploymentId);
  }
  // Without knowing what the site serves nothing is safe to delete.
  if (ids.size === 0) throw new PruneError('PRUNE_LIVE_DEPLOYMENT_UNKNOWN');
  return [...ids];
}

async function listDeployments(client, projectId) {
  const deployments = new Map();
  let until = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = { projectId, limit: '100' };
    if (until) query.until = String(until);
    const result = await client.get('/v7/deployments', query);
    if (!result.ok) throw failure('PRUNE_LIST_UNAVAILABLE', result);
    for (const item of result.body?.deployments ?? []) {
      const deployment = {
        uid: item.uid,
        url: item.url,
        state: item.state ?? item.readyState,
        target: item.target ?? null,
        created: item.created ?? item.createdAt,
      };
      if (typeof deployment.uid !== 'string' || !Number.isFinite(deployment.created)) {
        throw new PruneError('PRUNE_LIST_SHAPE_UNEXPECTED');
      }
      if (deployment.state !== 'DELETED') deployments.set(deployment.uid, deployment);
    }
    until = result.body?.pagination?.next ?? null;
    if (!until) return [...deployments.values()];
  }
  throw new PruneError('PRUNE_LIST_TOO_LONG');
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, fetchImpl = globalThis.fetch, log = console.log, sleep = wait } = {},
) {
  const { keep, dryRun } = parseArguments(argv);
  const token = env.VERCEL_TOKEN?.trim();
  if (!token) throw new PruneError('PRUNE_TOKEN_MISSING');
  const projectName = env.VERCEL_PROJECT?.trim();
  const team = env.VERCEL_TEAM_SLUG?.trim();
  if (!projectName || !team) throw new PruneError('PRUNE_PROJECT_MISSING');

  const client = createClient({ token, team, fetchImpl, sleep });
  const project = await client.get(`/v9/projects/${encodeURIComponent(projectName)}`);
  if (!project.ok || typeof project.body?.id !== 'string') {
    throw failure('PRUNE_PROJECT_UNAVAILABLE', project);
  }
  const liveIds = await liveDeploymentIds(client, project.body);
  const deployments = await listDeployments(client, project.body.id);
  const plan = planDeploymentPrune(deployments, { keep, liveIds });

  const urls = new Map(deployments.map((deployment) => [deployment.uid, deployment.url]));
  for (const { uid, reason } of plan.keep) log(`keep    ${urls.get(uid) ?? uid} (${reason})`);
  for (const deployment of plan.waiting) log(`wait    ${deployment.url} (${deployment.state})`);

  const planned = plan.remove.map((deployment) => deployment.uid);
  if (dryRun) {
    for (const deployment of plan.remove) {
      log(`delete  ${deployment.url} (${deployment.state}, dry run)`);
    }
    log(`Dry run: ${planned.length} of ${deployments.length} deployments would be deleted.`);
    return { dryRun: true, planned, deleted: [], failed: [] };
  }

  const deleted = [];
  const failed = [];
  for (const deployment of plan.remove) {
    const result = await client.remove(`/v13/deployments/${encodeURIComponent(deployment.uid)}`);
    // 404: already gone, for example removed by hand in the dashboard meanwhile.
    if (result.ok || result.status === 404) {
      deleted.push(deployment.uid);
      log(`deleted ${deployment.url} (${deployment.state})`);
    } else {
      failed.push(deployment.uid);
      log(`failed  ${deployment.url} (HTTP ${result.status} ${result.body?.error?.code ?? ''})`);
    }
  }
  log(
    `${deleted.length} deleted, ${failed.length} failed, ${plan.keep.length} kept, ${plan.waiting.length} waiting.`,
  );
  if (failed.length > 0) throw new PruneError('PRUNE_DELETE_FAILED', String(failed.length));
  return { dryRun: false, planned, deleted, failed };
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof PruneError ? error.message : `PRUNE_FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
