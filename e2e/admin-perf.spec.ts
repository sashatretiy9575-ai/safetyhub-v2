/**
 * Local performance harness for the admin workspace. Opt-in only:
 *
 *   E2E_ADMIN_PERF=1            registers the single measuring test (nothing is registered otherwise,
 *                               so the release runner never sees a skipped test)
 *   E2E_PERF_LABEL=before       part of the output file name (default "run")
 *   E2E_PERF_PROFILE=local|slow no throttling (default) | 120 ms latency, 10/5 Mbit/s, CPU x4
 *   E2E_PERF_RUNS=5             runs per scenario
 *   E2E_PERF_SCENARIOS=A,B,C    subset of scenario groups
 *
 * Output: artifacts/admin-fix-2026-09/perf-<label>-<timestamp>.json (rewritten after every run, so
 * a killed process still leaves the completed runs). Compare two files with
 * scripts/dev/summarize-admin-perf.mjs.
 *
 * The harness never saves settings, never uploads or removes images. The only data it changes is
 * course access in scenario B, which it restores and then verifies through the API.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type CDPSession,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

// ---------------------------------------------------------------------------------------------
// Types shared by the Node side and the in-page kit (types are erased, so the page never sees them)
// ---------------------------------------------------------------------------------------------

type WatchMarkKind =
  | 'trigger'
  | 'dialogVisible'
  | 'dialogHidden'
  | 'contactsReady'
  | 'courseAccessReady'
  | 'photoReady'
  | 'resourceEnd'
  | 'statusSaved'
  | 'newCanvas'
  | 'canvasVisible'
  | 'previewHidden'
  | 'selectorVisible'
  | 'transformSettled';

type WatchMark = {
  name: string;
  kind: WatchMarkKind;
  /** Looked at only once the whole user action is over (several clicks in a row). */
  gated?: boolean;
  /** `selectorVisible`: the element that has to become visible. */
  selector?: string;
  /** `resourceEnd`: substring of the resource URL whose response end is reported. */
  urlPart?: string;
  /** `resourceEnd`: stop waiting one second after this other mark has settled. */
  settleWith?: string;
  /** `newCanvas`: canvases count as kept when none was replaced this long after `canvasVisible`. */
  settleMs?: number;
};

type WatchSpec = { triggers: string[]; timeoutMs: number; marks: WatchMark[] };

type WatchResult = {
  /** Page clock (performance.now) of the user action the marks are measured from. */
  t0: number | null;
  t0Source: 'event' | 'armed' | 'none';
  marks: Record<string, number | null>;
  notes: Record<string, string>;
  flags: Record<string, boolean>;
};

type QuietResult = {
  quiet: boolean;
  waitedMs: number;
  canvasCount: number;
  freshCanvasCount: number;
  message: string;
  lastMutationAt: number | null;
  unavailableSeenAt: number | null;
  now: number;
};

type EditorState = {
  firstCanvasAt: number | null;
  hydratedAt: number | null;
  message: string;
  knownError: boolean;
  spinner: boolean;
  canvasCount: number;
};

type NavigationTiming = {
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  fcpMs: number | null;
};

type PerfKit = {
  take(): { longTasks: number[]; events: number[] };
  arm(spec: WatchSpec): number;
  /** The user action is over: gated marks may be evaluated from now on. */
  release(id: number): void;
  result(id: number): Promise<WatchResult>;
  tagCanvases(): number;
  quiet(quietMs: number, timeoutMs: number): Promise<QuietResult>;
  editorState(): EditorState;
  navigation(): NavigationTiming;
  insertTransform(): string | null;
};

type PerfWindow = {
  __perf?: { longTasks: number[]; events: number[] };
  __perfKit?: PerfKit;
};

type RequestClass =
  | 'api'
  | 'avatar'
  | 'storage'
  | 'certAssets'
  | 'metadata'
  | 'photo'
  | 'chunk'
  | 'other';

type Tally = { count: number; bytes: number };

type RequestSummary = Record<RequestClass, Tally> & {
  total: Tally;
  /** Every same-origin /api/ request, including the ones counted as avatar, metadata or photo. */
  apiAll: Tally;
  errorResponses: number;
  status429: number;
  aborted: number;
};

type LedgerEntry = {
  requestClass: RequestClass;
  method: string;
  path: string;
  status: number | null;
  bytes: number;
  retryAfter: number | null;
};

type LedgerSnapshot = {
  summary: RequestSummary;
  errors: { status: number; method: string; path: string }[];
  aborted: { requestClass: RequestClass; method: string; path: string; error: string }[];
  maxRetryAfter: number;
};

type Profile = {
  name: 'local' | 'slow';
  latencyMs: number;
  downloadBytesPerSecond: number;
  uploadBytesPerSecond: number;
  cpuThrottlingRate: number;
};

type Harness = { context: BrowserContext; page: Page; cdp: CDPSession; ledger: RequestLedger };

type RunRecord = Record<string, unknown>;

type Stats = { n: number; min: number; p50: number; p90: number; max: number; mean: number };

type EmployeeTarget = {
  index: number;
  label: string;
  hasPhoto: boolean;
  scanned: number;
  pinnedByQuery: boolean;
};

type DocumentSelection = { course: string };

// ---------------------------------------------------------------------------------------------
// In-page kit. Serialized into every document by addInitScript: it must stay self-contained and
// may only touch browser globals.
// ---------------------------------------------------------------------------------------------

function installPerfKit(): void {
  const host = window as unknown as PerfWindow;
  if (host.__perfKit || window.top !== window) return;

  const CANVAS = '[data-document-preview] canvas.document-page';
  const FRESH_CANVAS = CANVAS + ':not([data-perf-old])';
  const AVATAR_PART = '/api/admin/attestations/avatar/';
  const KNOWN_PREVIEW_ERRORS =
    /недоступно|не сформирован|не помещается|Выберите компанию|вкладыша: от|не загрузил/iu;

  const perf = { longTasks: [] as number[], events: [] as number[] };
  host.__perf = perf;

  const resources: { name: string; startTime: number; responseEnd: number }[] = [];
  const observers: { observer: PerformanceObserver; sink: (entry: PerformanceEntry) => void }[] =
    [];
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const observe = (
    // `durationThreshold` belongs to Event Timing and is not in TypeScript's DOM library yet.
    options: PerformanceObserverInit & { type: string; durationThreshold?: number },
    sink: (entry: PerformanceEntry) => void,
  ) => {
    if (!supported.includes(options.type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sink(entry);
      });
      observer.observe(options);
      observers.push({ observer, sink });
    } catch {
      // An entry type or option this browser refuses: that signal is simply not collected.
    }
  };
  observe({ type: 'longtask', buffered: true }, (entry) => perf.longTasks.push(entry.duration));
  observe({ type: 'event', durationThreshold: 16, buffered: true }, (entry) =>
    perf.events.push(entry.duration),
  );
  observe({ type: 'resource', buffered: true }, (entry) => {
    if (!entry.name.includes('/api/')) return;
    resources.push({
      name: entry.name,
      startTime: entry.startTime,
      responseEnd: (entry as PerformanceResourceTiming).responseEnd,
    });
  });

  const isShown = (element: Element | null | undefined): boolean => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const openDialog = (): Element | null =>
    [...document.querySelectorAll('dialog[open], [role="dialog"]')]
      .reverse()
      .find((node) => isShown(node)) ?? null;
  const courseBlock = (dialog: Element): Element | null => {
    const heading = [
      ...dialog.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, [role="heading"]'),
    ].find((node) => (node.textContent ?? '').includes('Доступ к курсам'));
    if (!heading) return null;
    return heading.closest('section, fieldset') ?? heading.parentElement?.parentElement ?? null;
  };
  const previewRoot = (): Element | null => document.querySelector('[data-document-preview]');
  const previewInfo = () => {
    const root = previewRoot();
    if (!root) {
      return { message: '', knownError: false, spinner: false, canvasCount: 0, fresh: 0 };
    }
    const message = [...root.querySelectorAll('[role="status"], [role="alert"]')]
      .map((node) => (node.textContent ?? '').trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 200);
    return {
      message,
      knownError: KNOWN_PREVIEW_ERRORS.test(message),
      spinner: Boolean(root.querySelector('[role="status"][aria-label], .animate-spin')),
      canvasCount: document.querySelectorAll(CANVAS).length,
      fresh: document.querySelectorAll(FRESH_CANVAS).length,
    };
  };
  const insertTransform = (): string | null => {
    const insert = document.querySelector('.document-insert');
    return insert ? getComputedStyle(insert).transform : null;
  };

  // The document editor: when its first page appeared, and what happened to the preview since.
  const editor = {
    firstCanvasAt: null as number | null,
    hydratedAt: null as number | null,
    lastMutationAt: null as number | null,
    unavailableSeenAt: null as number | null,
  };
  if (location.pathname.startsWith('/admin/documents/')) {
    const started = performance.now();
    const track = () => {
      const now = performance.now();
      if (editor.hydratedAt === null && document.querySelector('.document-editor[data-hydrated]')) {
        editor.hydratedAt = now;
      }
      if (editor.firstCanvasAt === null && document.querySelector(CANVAS)) {
        editor.firstCanvasAt = now;
      }
      const pending = editor.hydratedAt === null || editor.firstCanvasAt === null;
      if (pending && now - started < 120_000) requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
    new MutationObserver((records) => {
      const root = previewRoot();
      if (!root) return;
      if (records.some((record) => root.contains(record.target))) {
        editor.lastMutationAt = performance.now();
      }
      if ((root.textContent ?? '').includes('Удостоверение недоступно')) {
        editor.unavailableSeenAt = performance.now();
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }

  const watches = new Map<number, Promise<WatchResult>>();
  const released = new Set<number>();
  let nextWatchId = 1;

  const arm = (spec: WatchSpec): number => {
    const id = nextWatchId++;
    const armedAt = performance.now();
    let t0: number | null = spec.triggers.length ? null : armedAt;
    let t0Source: WatchResult['t0Source'] = spec.triggers.length ? 'none' : 'armed';
    const onTrigger = (event: Event) => {
      if (t0 !== null) return;
      t0 = event.timeStamp > 0 ? event.timeStamp : performance.now();
      t0Source = 'event';
      for (const type of spec.triggers) document.removeEventListener(type, onTrigger, true);
    };
    for (const type of spec.triggers) document.addEventListener(type, onTrigger, true);

    const marks: Record<string, number | null> = {};
    const settledAt: Record<string, number> = {};
    const notes: Record<string, string> = {};
    const flags: Record<string, boolean> = {};
    let dialogSeenAt: number | null = null;
    let errorSince: number | null = null;
    const transformInitial = insertTransform();
    let transformLast: string | null = null;
    let transformStableFrames = 0;
    let transformChangedAt = 0;

    const evaluate = (mark: WatchMark, now: number, origin: number): number | null | undefined => {
      const elapsed = now - origin;
      const dialog = openDialog();
      if (dialog && dialogSeenAt === null) dialogSeenAt = now;
      switch (mark.kind) {
        case 'trigger':
          return 0;
        case 'dialogVisible':
          return dialog ? elapsed : undefined;
        case 'dialogHidden':
          return dialog ? undefined : elapsed;
        case 'selectorVisible':
          return mark.selector && isShown(document.querySelector(mark.selector))
            ? elapsed
            : undefined;
        case 'contactsReady': {
          if (!dialog) return undefined;
          const link = [
            ...dialog.querySelectorAll('a[href^="https://wa.me/"], a[href^="tel:"]'),
          ].some((node) => isShown(node));
          const text = dialog.textContent ?? '';
          if (
            link ||
            text.includes('Телефон не указан') ||
            text.includes('Контакты не загрузились')
          ) {
            return elapsed;
          }
          const response = resources.find(
            (entry) =>
              entry.startTime >= armedAt - 50 &&
              entry.responseEnd > 0 &&
              entry.name.includes('/api/admin/attestations/contact/'),
          );
          if (response && now - response.responseEnd > 2_000) {
            notes[mark.name] =
              'contact response arrived, but no phone link and no contact text was rendered';
            return null;
          }
          const loading = Boolean(dialog.querySelector('.animate-pulse'));
          if (!response && !loading && dialogSeenAt !== null && now - dialogSeenAt > 10_000) {
            notes[mark.name] = 'no contact request and no contact UI within 10 s of the card';
            return null;
          }
          return undefined;
        }
        case 'courseAccessReady': {
          if (!dialog) return undefined;
          const block = courseBlock(dialog);
          if (!block) {
            if (dialogSeenAt !== null && now - dialogSeenAt > 10_000) {
              notes[mark.name] = 'no block headed «Доступ к курсам» within 10 s of the card';
              return null;
            }
            return undefined;
          }
          const box = block.querySelector(
            'input[type="checkbox"], [role="checkbox"], [role="switch"]',
          );
          if (isShown(box)) return elapsed;
          if (/курсов нет|не загрузились/iu.test(block.textContent ?? '')) {
            notes[mark.name] = 'empty or failed state';
            return elapsed;
          }
          return undefined;
        }
        case 'photoReady': {
          if (!dialog) return undefined;
          const image = dialog.querySelector<HTMLImageElement>(`img[src*="${AVATAR_PART}"]`);
          const candidate = image ?? dialog.querySelector(`a[href*="${AVATAR_PART}"]`);
          flags.hasPhoto = Boolean(candidate);
          if (image && image.complete && image.naturalWidth > 0) return elapsed;
          if (!candidate && dialogSeenAt !== null && now - dialogSeenAt > 1_500) {
            notes[mark.name] = 'the card has no avatar image';
            return null;
          }
          return undefined;
        }
        case 'resourceEnd': {
          const part = mark.urlPart ?? '';
          const entry = resources.find(
            (candidate) =>
              candidate.startTime >= armedAt - 50 &&
              candidate.responseEnd > 0 &&
              candidate.name.includes(part),
          );
          if (entry) return entry.responseEnd - origin;
          const other = mark.settleWith ? settledAt[mark.settleWith] : undefined;
          if (other !== undefined && now - other > 1_000) return null;
          return undefined;
        }
        case 'statusSaved': {
          if (!dialog) return undefined;
          const block = courseBlock(dialog);
          if (!block) return undefined;
          const alert = [...block.querySelectorAll('[role="alert"]')]
            .map((node) => (node.textContent ?? '').trim())
            .find(Boolean);
          if (alert) {
            notes[mark.name] = 'alert: ' + alert.slice(0, 160);
            return null;
          }
          const status = block.querySelector('[role="status"]') ?? block;
          return (status.textContent ?? '').includes('Сохранено') ? elapsed : undefined;
        }
        case 'canvasVisible':
          return [...document.querySelectorAll(CANVAS)].some((node) => isShown(node))
            ? elapsed
            : undefined;
        case 'previewHidden':
          return isShown(previewRoot()) ? undefined : elapsed;
        case 'newCanvas': {
          if (document.querySelector(FRESH_CANVAS)) return elapsed;
          const visibleAt = marks.canvasVisible;
          if (
            mark.settleMs !== undefined &&
            typeof visibleAt === 'number' &&
            elapsed - visibleAt > mark.settleMs
          ) {
            notes[mark.name] = 'existing canvases were kept';
            return null;
          }
          const info = previewInfo();
          if (info.knownError && !info.spinner) {
            if (errorSince === null) errorSince = now;
            if (now - errorSince > 1_500) {
              notes[mark.name] = 'preview message: ' + info.message;
              return null;
            }
          } else {
            errorSince = null;
          }
          return undefined;
        }
        case 'transformSettled': {
          const current = insertTransform();
          if (current === null) {
            notes[mark.name] = '.document-insert not found';
            return null;
          }
          if (current === transformInitial) {
            if (elapsed > 3_000) {
              notes[mark.name] = 'transform did not change';
              return null;
            }
            return undefined;
          }
          if (current === transformLast) transformStableFrames += 1;
          else {
            transformLast = current;
            transformStableFrames = 0;
            transformChangedAt = now;
          }
          if (transformStableFrames < 3) return undefined;
          notes.transformBefore = String(transformInitial);
          notes.transformAfter = current;
          return transformChangedAt - origin;
        }
        default:
          return null;
      }
    };

    const promise = new Promise<WatchResult>((resolve) => {
      const finish = () => {
        for (const type of spec.triggers) document.removeEventListener(type, onTrigger, true);
        for (const mark of spec.marks) {
          if (mark.name in marks) continue;
          marks[mark.name] = null;
          if (!notes[mark.name]) notes[mark.name] = t0 === null ? 'trigger not seen' : 'timeout';
        }
        resolve({ t0, t0Source, marks, notes, flags });
      };
      const tick = () => {
        const now = performance.now();
        if (t0 === null) {
          if (now - armedAt > spec.timeoutMs) finish();
          else requestAnimationFrame(tick);
          return;
        }
        for (const mark of spec.marks) {
          if (mark.name in marks) continue;
          if (mark.gated && !released.has(id)) continue;
          const outcome = evaluate(mark, now, t0);
          if (outcome === undefined) continue;
          marks[mark.name] = outcome;
          settledAt[mark.name] = now;
        }
        const done = spec.marks.every((mark) => mark.name in marks);
        if (done || now - t0 > spec.timeoutMs) finish();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    watches.set(id, promise);
    return id;
  };

  host.__perfKit = {
    take() {
      for (const { observer, sink } of observers) {
        for (const entry of observer.takeRecords()) sink(entry);
      }
      const out = { longTasks: perf.longTasks.slice(), events: perf.events.slice() };
      perf.longTasks.length = 0;
      perf.events.length = 0;
      return out;
    },
    arm,
    release(id) {
      released.add(id);
    },
    result(id) {
      return (
        watches.get(id) ??
        Promise.resolve({
          t0: null,
          t0Source: 'none' as const,
          marks: {},
          notes: { watch: 'unknown watch id' },
          flags: {},
        })
      );
    },
    tagCanvases() {
      const canvases = document.querySelectorAll(CANVAS);
      for (const canvas of canvases) canvas.setAttribute('data-perf-old', '1');
      return canvases.length;
    },
    quiet(quietMs, timeoutMs) {
      return new Promise<QuietResult>((resolve) => {
        const started = performance.now();
        const tick = () => {
          const now = performance.now();
          const info = previewInfo();
          const calm =
            !info.spinner && now - Math.max(started, editor.lastMutationAt ?? 0) >= quietMs;
          if (!calm && now - started < timeoutMs) {
            requestAnimationFrame(tick);
            return;
          }
          resolve({
            quiet: calm,
            waitedMs: now - started,
            canvasCount: info.canvasCount,
            freshCanvasCount: info.fresh,
            message: info.message,
            lastMutationAt: editor.lastMutationAt,
            unavailableSeenAt: editor.unavailableSeenAt,
            now,
          });
        };
        requestAnimationFrame(tick);
      });
    },
    editorState() {
      const info = previewInfo();
      return {
        firstCanvasAt: editor.firstCanvasAt,
        hydratedAt: editor.hydratedAt,
        message: info.message,
        knownError: info.knownError,
        spinner: info.spinner,
        canvasCount: info.canvasCount,
      };
    },
    navigation() {
      const entry = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      const positive = (value: number | undefined) => (value && value > 0 ? value : null);
      return {
        ttfbMs: positive(entry?.responseStart),
        domContentLoadedMs: positive(entry?.domContentLoadedEventEnd),
        loadMs: positive(entry?.loadEventEnd),
        fcpMs: positive(paint?.startTime),
      };
    },
    insertTransform,
  };
}

// ---------------------------------------------------------------------------------------------
// Node side: pure helpers
// ---------------------------------------------------------------------------------------------

const REQUEST_CLASSES: readonly RequestClass[] = [
  'api',
  'avatar',
  'storage',
  'certAssets',
  'metadata',
  'photo',
  'chunk',
  'other',
];
const CPU_METRICS = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
] as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const COURSE_ACCESS_PATH = /^\/api\/admin\/users\/([0-9a-f-]{36})\/course-access$/iu;
const CARD_USER_PATH =
  /^\/api\/admin\/(?:attestations\/(?:contact|avatar|history)|users)\/([0-9a-f-]{36})(?:\/|$)/iu;

const PROFILES: Record<Profile['name'], Profile> = {
  local: {
    name: 'local',
    latencyMs: 0,
    downloadBytesPerSecond: -1,
    uploadBytesPerSecond: -1,
    cpuThrottlingRate: 1,
  },
  // 10 Mbit/s down, 5 Mbit/s up.
  slow: {
    name: 'slow',
    latencyMs: 120,
    downloadBytesPerSecond: 1_250_000,
    uploadBytesPerSecond: 625_000,
    cpuThrottlingRate: 4,
  },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const round1 = (value: number) => Math.round(value * 10) / 10;
const roundOrNull = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? round1(value) : null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One line, no identifiers: an error text may quote a selector or a URL. */
function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split(/\r?\n/u, 1)[0] ?? '').replace(UUID, ':id').slice(0, 300);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function gitState(cwd: string): { commit: string | null; dirty: boolean | null } {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      windowsHide: true,
    }).trim();
  try {
    const commit = git(['rev-parse', '--short', 'HEAD']);
    let dirty: boolean | null = null;
    try {
      dirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
    } catch {
      dirty = null;
    }
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** Classes are exclusive, the most specific first; `apiAll` in the summary is the /api/ total. */
function classifyRequest(url: URL, appOrigin: string): RequestClass {
  const pathname = url.pathname;
  if (url.origin !== appOrigin || pathname.includes('/storage/v1/')) return 'storage';
  if (pathname.startsWith('/api/admin/attestations/avatar/')) return 'avatar';
  if (pathname.startsWith('/api/certificates/') && pathname.endsWith('/metadata')) {
    return 'metadata';
  }
  if (pathname.endsWith('/photo') || pathname.includes('/documents/photo/')) return 'photo';
  if (pathname.startsWith('/certificate-assets/')) return 'certAssets';
  if (pathname.startsWith('/_next/static/')) return 'chunk';
  if (pathname.startsWith('/api/')) return 'api';
  return 'other';
}

/** The path only: a query string can carry a name, a company or a signed token. */
function reportPath(url: URL, appOrigin: string): string {
  const pathname = url.pathname.replace(UUID, ':id');
  return url.origin === appOrigin ? pathname : url.host + pathname;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const rank = (sorted.length - 1) * fraction;
  const low = sorted[Math.floor(rank)] ?? 0;
  const high = sorted[Math.ceil(rank)] ?? low;
  return low + (high - low) * (rank - Math.floor(rank));
}

const SUMMARY_SKIPPED_KEYS = new Set(['raw', 'notes', 'error', 'run', 't0Source', 'skipped']);

function flattenNumbers(value: unknown, prefix: string, out: Map<string, number>): void {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.set(prefix, value);
  } else if (typeof value === 'boolean') {
    out.set(prefix, value ? 1 : 0);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => flattenNumbers(item, `${prefix}[${index}]`, out));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SUMMARY_SKIPPED_KEYS.has(key)) continue;
      flattenNumbers(item, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

function summarizeRuns(runs: readonly RunRecord[]): Record<string, Stats> {
  const samples = new Map<string, number[]>();
  for (const run of runs) {
    if (typeof run.error === 'string') continue;
    const flat = new Map<string, number>();
    flattenNumbers(run, '', flat);
    for (const [key, value] of flat) samples.set(key, [...(samples.get(key) ?? []), value]);
  }
  const summary: Record<string, Stats> = {};
  for (const [key, values] of samples) {
    const sorted = [...values].sort((left, right) => left - right);
    summary[key] = {
      n: sorted.length,
      min: round1(sorted[0] ?? 0),
      p50: round1(percentile(sorted, 0.5)),
      p90: round1(percentile(sorted, 0.9)),
      max: round1(sorted.at(-1) ?? 0),
      mean: round1(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    };
  }
  return summary;
}

function marksOf(result: WatchResult, names: readonly string[]): Record<string, number | null> {
  return Object.fromEntries(names.map((name) => [`${name}Ms`, roundOrNull(result.marks[name])]));
}

// ---------------------------------------------------------------------------------------------
// Node side: request accounting
// ---------------------------------------------------------------------------------------------

class RequestLedger {
  private entries: LedgerEntry[] = [];
  private failures: LedgerSnapshot['aborted'] = [];
  private readonly inFlight = new Set<Request>();
  private readonly pending = new Set<Promise<void>>();
  private readonly appOrigin: string;
  private lastActivity = Date.now();

  constructor(page: Page, appOrigin: string) {
    this.appOrigin = appOrigin;
    page.on('request', (request) => {
      if (!this.parse(request)) return;
      this.inFlight.add(request);
      this.lastActivity = Date.now();
    });
    page.on('requestfinished', (request) => {
      const job: Promise<void> = this.finished(request).finally(() => this.pending.delete(job));
      this.pending.add(job);
    });
    page.on('requestfailed', (request) => {
      this.inFlight.delete(request);
      this.lastActivity = Date.now();
      const url = this.parse(request);
      if (!url) return;
      this.failures.push({
        requestClass: classifyRequest(url, this.appOrigin),
        method: request.method(),
        path: reportPath(url, this.appOrigin),
        error: request.failure()?.errorText ?? 'failed',
      });
    });
  }

  private parse(request: Request): URL | null {
    try {
      const url = new URL(request.url());
      return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }

  private async finished(request: Request): Promise<void> {
    const url = this.parse(request);
    try {
      if (!url) return;
      const [response, sizes] = await Promise.all([
        request.response().catch(() => null),
        request.sizes().catch(() => null),
      ]);
      const retryAfter = Number(response?.headers()['retry-after']);
      this.entries.push({
        requestClass: classifyRequest(url, this.appOrigin),
        method: request.method(),
        path: reportPath(url, this.appOrigin),
        status: response ? response.status() : null,
        bytes: sizes
          ? Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize)
          : 0,
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      });
    } finally {
      this.inFlight.delete(request);
      this.lastActivity = Date.now();
    }
  }

  reset(): void {
    this.entries = [];
    this.failures = [];
  }

  /** Waits until nothing has been in flight for `idleMs`, but never longer than `maxMs`. */
  async quiet(idleMs: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await Promise.allSettled([...this.pending]);
      if (this.inFlight.size === 0 && Date.now() - this.lastActivity >= idleMs) return;
      await sleep(50);
    }
  }

  async snapshot(): Promise<LedgerSnapshot> {
    await Promise.allSettled([...this.pending]);
    const tally = (): Tally => ({ count: 0, bytes: 0 });
    const classes = Object.fromEntries(REQUEST_CLASSES.map((name) => [name, tally()])) as Record<
      RequestClass,
      Tally
    >;
    const summary: RequestSummary = {
      ...classes,
      total: tally(),
      apiAll: tally(),
      errorResponses: 0,
      status429: 0,
      aborted: this.failures.length,
    };
    const errors: LedgerSnapshot['errors'] = [];
    let maxRetryAfter = 0;
    for (const entry of this.entries) {
      const targets = [summary.total, summary[entry.requestClass]];
      if (entry.path.startsWith('/api/')) targets.push(summary.apiAll);
      for (const target of targets) {
        target.count += 1;
        target.bytes += entry.bytes;
      }
      if (entry.status !== null && entry.status >= 400) {
        summary.errorResponses += 1;
        if (entry.status === 429) {
          summary.status429 += 1;
          maxRetryAfter = Math.max(maxRetryAfter, entry.retryAfter ?? 60);
        }
        errors.push({ status: entry.status, method: entry.method, path: entry.path });
      }
    }
    return { summary, errors, aborted: [...this.failures], maxRetryAfter };
  }
}

// ---------------------------------------------------------------------------------------------
// Node side: page helpers
// ---------------------------------------------------------------------------------------------

// Every page.evaluate below repeats the window lookup on purpose: a function sent to the page
// cannot close over a Node-side helper.
const armWatch = (page: Page, spec: WatchSpec) =>
  page.evaluate((input) => {
    const kit = (window as unknown as PerfWindow).__perfKit;
    if (!kit) throw new Error('perf kit is not installed in this document');
    return kit.arm(input);
  }, spec);

const watchResult = (page: Page, id: number) =>
  page.evaluate((watchId) => {
    const kit = (window as unknown as PerfWindow).__perfKit;
    if (!kit) throw new Error('perf kit is not installed in this document');
    return kit.result(watchId);
  }, id);

/** Arms the in-page marks, performs the user action, returns the marks measured from that action. */
async function watch(
  page: Page,
  spec: WatchSpec,
  action: () => Promise<unknown>,
): Promise<WatchResult> {
  const id = await armWatch(page, spec);
  await action();
  await page.evaluate((watchId) => {
    (window as unknown as PerfWindow).__perfKit?.release(watchId);
  }, id);
  return watchResult(page, id);
}

const takePerf = (page: Page) =>
  page
    .evaluate(() => {
      const kit = (window as unknown as PerfWindow).__perfKit;
      return kit ? kit.take() : { longTasks: [], events: [] };
    })
    .catch(() => ({ longTasks: [] as number[], events: [] as number[] }));

const tagCanvases = (page: Page) =>
  page.evaluate(() => (window as unknown as PerfWindow).__perfKit?.tagCanvases() ?? 0);

const previewQuiet = (page: Page, quietMs: number, timeoutMs: number) =>
  page.evaluate(
    ([quiet, timeout]) => {
      const kit = (window as unknown as PerfWindow).__perfKit;
      if (!kit) throw new Error('perf kit is not installed in this document');
      return kit.quiet(quiet, timeout);
    },
    [quietMs, timeoutMs] as const,
  );

async function readCpu(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const wanted = new Set<string>(CPU_METRICS);
  return Object.fromEntries(
    metrics.filter((metric) => wanted.has(metric.name)).map((metric) => [metric.name, metric.value]),
  );
}

/** Seconds from CDP become milliseconds; a counter that went backwards means a new renderer. */
function cpuDelta(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(
    CPU_METRICS.map((name) => {
      const start = before[name] ?? 0;
      const end = after[name] ?? 0;
      return [`${name}Ms`, round1((end >= start ? end - start : end) * 1_000)];
    }),
  );
}

async function measureStep<T>(
  harness: Harness,
  body: () => Promise<T>,
): Promise<{ value: T; metrics: RunRecord; snapshot: LedgerSnapshot }> {
  await harness.ledger.quiet(300, 5_000);
  harness.ledger.reset();
  await takePerf(harness.page);
  const before = await readCpu(harness.cdp);
  const value = await body();
  const after = await readCpu(harness.cdp);
  await harness.ledger.quiet(300, 5_000);
  const perf = await takePerf(harness.page);
  const snapshot = await harness.ledger.snapshot();
  const longTasks = perf.longTasks.map(round1);
  const events = perf.events.map(round1);
  return {
    value,
    snapshot,
    metrics: {
      cpu: cpuDelta(before, after),
      longTasks: {
        count: longTasks.length,
        totalMs: round1(longTasks.reduce((sum, item) => sum + item, 0)),
        maxMs: longTasks.length ? Math.max(...longTasks) : 0,
      },
      events: { count: events.length, maxMs: events.length ? Math.max(...events) : 0 },
      requests: snapshot.summary,
      raw: {
        longTasks: longTasks.slice(0, 200),
        events: events.slice(0, 200),
        errorResponses: snapshot.errors.slice(0, 50),
        abortedRequests: snapshot.aborted.slice(0, 50),
      },
    },
  };
}

async function openHarness(
  browser: Browser,
  options: BrowserContextOptions,
  profile: Profile,
  appOrigin: string,
  waitMs: number,
): Promise<Harness & { throttledVia: string }> {
  const context = await browser.newContext(options);
  await context.addInitScript(installPerfKit);
  const page = await context.newPage();
  page.setDefaultTimeout(waitMs);
  page.on('dialog', (dialog) => void dialog.accept().catch(() => undefined));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  let throttledVia = 'none';
  if (profile.name === 'slow') {
    const conditions = {
      latency: profile.latencyMs,
      downloadThroughput: profile.downloadBytesPerSecond,
      uploadThroughput: profile.uploadBytesPerSecond,
    };
    await cdp.send('Network.enable');
    try {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...conditions });
      throttledVia = 'Network.emulateNetworkConditions';
    } catch {
      await cdp.send('Network.emulateNetworkConditionsByRule', {
        offline: false,
        matchedNetworkConditions: [{ urlPattern: '', ...conditions }],
      });
      throttledVia = 'Network.emulateNetworkConditionsByRule';
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottlingRate });
  }
  return { context, page, cdp, ledger: new RequestLedger(page, appOrigin), throttledVia };
}

async function employeeOpenButtons(page: Page): Promise<Locator> {
  const named = page.getByRole('button', { name: /^Открыть сведения/u });
  if (await named.count()) return named;
  // The label may be reworded; the employee cell of a row still holds its one button.
  return page.locator('article[role="row"] > [role="cell"]:nth-child(2) > button');
}

async function gotoEmployees(page: Page, waitMs: number): Promise<void> {
  await page.goto('/admin/employees?pageSize=100', {
    timeout: 120_000,
    waitUntil: 'domcontentloaded',
  });
  // A click before hydration is lost. The marker is waited for only while it exists at all.
  if (await page.locator('[data-attestations-manager]').count()) {
    await page
      .locator('[data-attestations-manager][data-client-ready="true"]')
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible', timeout: waitMs });
  }
  const buttons = await employeeOpenButtons(page);
  await buttons.first().waitFor({ state: 'visible', timeout: waitMs });
}

/** The row's open control by position, so no name ever ends up in a selector or an error text. */
async function targetButton(page: Page, target: EmployeeTarget): Promise<Locator> {
  const buttons = await employeeOpenButtons(page);
  const labels = await buttons.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent ?? ''),
  );
  if (labels[target.index] === target.label) return buttons.nth(target.index);
  const moved = labels.indexOf(target.label);
  return buttons.nth(moved >= 0 ? moved : Math.min(target.index, Math.max(0, labels.length - 1)));
}

function courseAccessBlock(dialog: Locator): Locator {
  return dialog
    .locator('section, fieldset')
    .filter({ has: dialog.page().getByRole('heading', { name: /Доступ к курсам/u }) })
    .last();
}

async function closeCard(page: Page): Promise<number | null> {
  const close = page
    .getByRole('dialog')
    .getByRole('button', { name: /^Закрыть$/u })
    .first();
  const result = await watch(
    page,
    {
      triggers: ['click', 'keydown'],
      timeoutMs: 10_000,
      marks: [{ name: 'dialogHidden', kind: 'dialogHidden' }],
    },
    async () => {
      if (await close.count()) await close.click({ timeout: 5_000 });
      else await page.keyboard.press('Escape');
    },
  );
  return roundOrNull(result.marks.dialogHidden);
}

async function discoverEmployee(page: Page, waitMs: number): Promise<EmployeeTarget> {
  // closeCard measures through the in-page kit, so the fixture page needs it as well.
  await page.addInitScript(installPerfKit);
  await gotoEmployees(page, waitMs);
  const buttons = await employeeOpenButtons(page);
  const labels = await buttons.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent ?? ''),
  );
  const seen = new Set<string>();
  let people = labels.flatMap((label, index) => {
    if (seen.has(label)) return [];
    seen.add(label);
    return [{ label, index }];
  });
  if (!people.length) throw new Error('no employee rows on /admin/employees?pageSize=100');
  const query = process.env.E2E_PERF_EMPLOYEE_QUERY?.trim().toLocaleLowerCase('ru-RU');
  const pinned = query
    ? people.filter((person) => person.label.toLocaleLowerCase('ru-RU').includes(query))
    : [];
  if (pinned.length) people = pinned.slice(0, 1);
  const limit = positiveInteger(process.env.E2E_PERF_PHOTO_SCAN_LIMIT, 100);
  let scanned = 0;
  for (const person of people.slice(0, limit)) {
    scanned += 1;
    const cardRequest = page
      .waitForRequest((request) => CARD_USER_PATH.test(new URL(request.url()).pathname), {
        timeout: 3_000,
      })
      .catch(() => null);
    await buttons.nth(person.index).click({ timeout: waitMs });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: waitMs });
    const request = await cardRequest;
    const userId = request ? CARD_USER_PATH.exec(new URL(request.url()).pathname)?.[1] : undefined;
    let hasPhoto =
      (await dialog
        .locator(
          'img[src*="/api/admin/attestations/avatar/"], a[href*="/api/admin/attestations/avatar/"]',
        )
        .count()) > 0;
    if (!hasPhoto && userId) {
      const probe = await page.request
        .get(`/api/admin/attestations/avatar/${userId}`, { maxRedirects: 0 })
        .catch(() => null);
      hasPhoto = Boolean(probe && probe.status() < 400);
    }
    await closeCard(page);
    await dialog.waitFor({ state: 'hidden', timeout: waitMs });
    if (hasPhoto || pinned.length) {
      return { ...person, hasPhoto, scanned, pinnedByQuery: pinned.length > 0 };
    }
  }
  const first = people[0]!;
  return { ...first, hasPhoto: false, scanned, pinnedByQuery: false };
}

/** The course page of «Документы»: E2E_PERF_COURSE, or БиОТ, which prints two categories. */
async function discoverDocumentSelection(page: Page): Promise<DocumentSelection | null> {
  const course = process.env.E2E_PERF_COURSE?.trim() || 'biot';
  const response = await page.request.get('/admin/documents/' + encodeURIComponent(course));
  return response.ok() ? { course } : null;
}

async function radioInGroup(group: Locator, pattern: RegExp, fallbackIndex: number) {
  const byName = group.getByRole('radio', { name: pattern });
  if (await byName.count()) return byName.first();
  const byIndex = group.getByRole('radio').nth(fallbackIndex);
  return (await byIndex.count()) ? byIndex : null;
}

async function documentKindRadio(page: Page, kind: 'certificate' | 'protocol') {
  const group = page.getByRole('radiogroup', { name: /^Документ$/u }).first();
  return kind === 'certificate'
    ? radioInGroup(group, /Корочка/u, 1)
    : radioInGroup(group, /Протокол/u, 0);
}

async function programmeField(page: Page): Promise<Locator | null> {
  const field = page
    .locator('.document-editor')
    .filter({ visible: true })
    .first()
    .getByRole('textbox', { name: 'Название программы' })
    .filter({ visible: true });
  return (await field.count()) ? field.first() : null;
}

// ---------------------------------------------------------------------------------------------
// The test. Nothing below is registered unless the harness is asked for.
// ---------------------------------------------------------------------------------------------

if (process.env.E2E_ADMIN_PERF === '1') {
  const adminStorageState = process.env.E2E_ADMIN_STORAGE_STATE;
  if (!adminStorageState) throw new Error('Admin storage state required');
  const profileName = process.env.E2E_PERF_PROFILE ?? 'local';
  if (profileName !== 'local' && profileName !== 'slow') {
    throw new Error('E2E_PERF_PROFILE must be "local" or "slow"');
  }
  const profile = PROFILES[profileName];
  const label = (process.env.E2E_PERF_LABEL ?? 'run').replace(/[^a-z0-9_-]+/giu, '_') || 'run';
  const runs = positiveInteger(process.env.E2E_PERF_RUNS, 5);
  const waitMs = positiveInteger(process.env.E2E_PERF_WAIT_MS, 30_000);
  const quietMs = positiveInteger(
    process.env.E2E_PERF_QUIET_MS,
    profile.name === 'slow' ? 2_500 : 1_000,
  );
  const recreateWindowMs = positiveInteger(
    process.env.E2E_PERF_RECREATE_WINDOW_MS,
    profile.name === 'slow' ? 12_000 : 5_000,
  );
  const groups = new Set(
    (process.env.E2E_PERF_SCENARIOS ?? 'A,B,C')
      .split(',')
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean),
  );

  test.use({ storageState: adminStorageState, video: 'off', trace: 'off' });
  if (process.env.E2E_PERF_CHANNEL) test.use({ channel: process.env.E2E_PERF_CHANNEL });

  test('admin performance harness writes its measurements', async ({ page, browser }, testInfo) => {
    test.setTimeout(positiveInteger(process.env.E2E_PERF_TIMEOUT_MS, 90 * 60_000));
    // `config.rootDir` is the test directory (e2e/), not the repository: the first run
    // wrote its report under e2e/artifacts. The runner always starts from the repository root.
    const rootDir = process.cwd();
    const outputDir = path.join(rootDir, 'artifacts', 'admin-fix-2026-09');
    mkdirSync(outputDir, { recursive: true });
    const startedAt = new Date();
    const outputPath = path.join(
      outputDir,
      `perf-${label}-${startedAt.toISOString().replace(/[:.]/gu, '-')}.json`,
    );
    const use = testInfo.project.use;
    const baseURL = String(use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100');
    const appOrigin = new URL(baseURL).origin;
    const desktop = use.viewport ?? { width: 1280, height: 720 };
    const contextOptions: BrowserContextOptions = {
      storageState: adminStorageState,
      baseURL,
      locale: use.locale ?? 'ru-RU',
      timezoneId: use.timezoneId ?? 'Asia/Almaty',
      viewport: desktop,
      userAgent: use.userAgent,
      deviceScaleFactor: use.deviceScaleFactor ?? 1,
      ignoreHTTPSErrors: Boolean(use.ignoreHTTPSErrors),
    };

    const scenarioRuns: Record<string, RunRecord[]> = {};
    const record = (scenario: string, entry: RunRecord) => {
      (scenarioRuns[scenario] ??= []).push(entry);
    };
    const report: RunRecord = {
      schemaVersion: 1,
      label,
      ...gitState(rootDir),
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      baseURL,
      runs,
      scenarioGroups: [...groups],
      profile: { ...profile, throttledVia: 'none' },
      settings: { waitMs, quietMs, recreateWindowMs, desktopViewport: desktop },
      environment: {
        node: process.version,
        platform: process.platform,
        playwright: testInfo.config.version,
        browser: browser.browserType().name() + ' ' + browser.version(),
      },
      notes: [
        'Marks are milliseconds from the user action (the click/input event timestamp) to the first animation frame in which the condition held, on the page clock.',
        'Request classes are exclusive, most specific first; requests.apiAll is every same-origin /api/ request. bytes = response headers + encoded body; a disk-cache hit reports 0.',
        'cpu.* are CDP Performance.getMetrics deltas over the step, in milliseconds. CPU throttling slows the main thread only; the pdf.js worker is not throttled.',
        'A null mark with a note means the harness stopped waiting on purpose; see notes of that run.',
      ],
      discovery: {},
      scenarios: {},
    };
    const persist = () => {
      report.finishedAt = new Date().toISOString();
      report.scenarios = Object.fromEntries(
        Object.entries(scenarioRuns).map(([name, entries]) => [
          name,
          {
            errors: entries.filter((entry) => typeof entry.error === 'string').length,
            summary: summarizeRuns(entries),
            runs: entries,
          },
        ]),
      );
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    };

    const withHarness = async <T>(body: (harness: Harness) => Promise<T>): Promise<T> => {
      const harness = await openHarness(browser, contextOptions, profile, appOrigin, waitMs);
      (report.profile as RunRecord).throttledVia = harness.throttledVia;
      try {
        return await body(harness);
      } finally {
        await harness.context.close().catch(() => undefined);
      }
    };

    // -- discovery (unthrottled, on the fixture page; not measured) --------------------------------
    const discovery: RunRecord = {};
    report.discovery = discovery;
    let employee: EmployeeTarget | null = null;
    let selection: DocumentSelection | null = null;
    if (groups.has('A') || groups.has('B')) {
      try {
        employee = await discoverEmployee(page, waitMs);
        discovery.employee = {
          rowIndex: employee.index,
          hasPhoto: employee.hasPhoto,
          scanned: employee.scanned,
          pinnedByQuery: employee.pinnedByQuery,
        };
      } catch (error) {
        discovery.employee = { error: errorMessage(error) };
      }
    }
    if (groups.has('C')) {
      try {
        selection = await discoverDocumentSelection(page);
        discovery.documents = selection
          ? { course: selection.course }
          : { error: 'the course page of «Документы» did not open' };
      } catch (error) {
        discovery.documents = { error: errorMessage(error) };
      }
    }
    // The fixture page goes idle, so its polling never competes with a measured page.
    await page.goto('about:blank').catch(() => undefined);
    persist();

    // -- A: employee card ------------------------------------------------------------------------
    const cardMarks: WatchMark[] = [
      { name: 'dialogVisible', kind: 'dialogVisible' },
      { name: 'contactsReady', kind: 'contactsReady' },
      {
        name: 'contactResponse',
        kind: 'resourceEnd',
        urlPart: '/api/admin/attestations/contact/',
        settleWith: 'contactsReady',
      },
      { name: 'courseAccessReady', kind: 'courseAccessReady' },
      { name: 'photoReady', kind: 'photoReady' },
      {
        name: 'photoResponse',
        kind: 'resourceEnd',
        urlPart: '/api/admin/attestations/avatar/',
        settleWith: 'photoReady',
      },
    ];
    const openCard = async (harness: Harness, target: EmployeeTarget): Promise<RunRecord> => {
      const button = await targetButton(harness.page, target);
      const { value, metrics } = await measureStep(harness, () =>
        watch(harness.page, { triggers: ['click'], timeoutMs: waitMs, marks: cardMarks }, () =>
          button.click({ timeout: waitMs }),
        ),
      );
      return {
        marks: marksOf(
          value,
          cardMarks.map((mark) => mark.name),
        ),
        hasPhoto: value.flags.hasPhoto ?? false,
        t0Source: value.t0Source,
        ...metrics,
        notes: value.notes,
      };
    };

    const runEmployeeCard = async (run: number) => {
      if (!employee) {
        const error = 'employee discovery failed';
        for (const name of ['A0_employeesPageLoad', 'A1_cardFirstOpen', 'A2_cardRepeatOpen']) {
          record(name, { run, error });
        }
        return;
      }
      const target = employee;
      await withHarness(async (harness) => {
        let stage = 'A0_employeesPageLoad';
        try {
          const wallStart = Date.now();
          const before = await readCpu(harness.cdp);
          await gotoEmployees(harness.page, waitMs);
          const readyWallMs = Date.now() - wallStart;
          const after = await readCpu(harness.cdp);
          await harness.ledger.quiet(500, 8_000);
          const navigation = await harness.page.evaluate(() =>
            (window as unknown as PerfWindow).__perfKit?.navigation(),
          );
          const perf = await takePerf(harness.page);
          const snapshot = await harness.ledger.snapshot();
          record(stage, {
            run,
            marks: {
              readyWallMs,
              ttfbMs: roundOrNull(navigation?.ttfbMs),
              domContentLoadedMs: roundOrNull(navigation?.domContentLoadedMs),
              loadMs: roundOrNull(navigation?.loadMs),
              fcpMs: roundOrNull(navigation?.fcpMs),
            },
            cpu: cpuDelta(before, after),
            longTasks: {
              count: perf.longTasks.length,
              totalMs: round1(perf.longTasks.reduce((sum, item) => sum + item, 0)),
            },
            requests: snapshot.summary,
            raw: { errorResponses: snapshot.errors.slice(0, 50) },
          });

          stage = 'A1_cardFirstOpen';
          record(stage, { run, ...(await openCard(harness, target)) });

          stage = 'A2_cardRepeatOpen';
          const closeMs = await closeCard(harness.page);
          await harness.page.getByRole('dialog').waitFor({ state: 'hidden', timeout: waitMs });
          record(stage, { run, closeMs, ...(await openCard(harness, target)) });
        } catch (error) {
          const message = errorMessage(error);
          const order = ['A0_employeesPageLoad', 'A1_cardFirstOpen', 'A2_cardRepeatOpen'];
          for (const name of order.slice(order.indexOf(stage))) {
            record(name, { run, error: name === stage ? message : `${stage} failed: ${message}` });
          }
        }
      });
    };

    // -- B: course access, several ticks in a row ---------------------------------------------------
    const runCourseAccess = async (run: number) => {
      const scenario = 'B_courseAccessBulk';
      if (!employee) {
        record(scenario, { run, error: 'employee discovery failed' });
        return;
      }
      const target = employee;
      await withHarness(async (harness) => {
        const { page: card } = harness;
        let accessPath: string | null = null;
        let originalGranted: string[] | null = null;
        let mutated = false;
        const readGranted = async (): Promise<string[] | null> => {
          if (!accessPath) return null;
          const response = await card.request.get(accessPath).catch(() => null);
          if (!response?.ok()) return null;
          const body = (await response.json()) as { courses?: { id: string; granted: boolean }[] };
          return (body.courses ?? [])
            .filter((course) => course.granted)
            .map((course) => course.id)
            .sort();
        };
        try {
          await gotoEmployees(card, waitMs);
          const accessRequest = card
            .waitForRequest((request) => COURSE_ACCESS_PATH.test(new URL(request.url()).pathname), {
              timeout: waitMs,
            })
            .catch(() => null);
          const button = await targetButton(card, target);
          const opened = await watch(
            card,
            {
              triggers: ['click'],
              timeoutMs: waitMs,
              marks: [{ name: 'courseAccessReady', kind: 'courseAccessReady' }],
            },
            () => button.click({ timeout: waitMs }),
          );
          if (opened.marks.courseAccessReady === null) {
            record(scenario, {
              run,
              skipped: 'the course access block did not become ready',
              notes: opened.notes,
            });
            return;
          }
          const block = courseAccessBlock(card.getByRole('dialog'));
          const boxes = block.getByRole('checkbox');
          const states = await boxes.evaluateAll((nodes) =>
            nodes.map((node) => ({
              checked:
                node instanceof HTMLInputElement
                  ? node.checked
                  : node.getAttribute('aria-checked') === 'true',
              disabled: node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true',
            })),
          );
          if (!states.length) {
            record(scenario, { run, checkboxCount: 0, skipped: 'no course checkboxes' });
            return;
          }
          if (states.every((state) => state.disabled)) {
            record(scenario, {
              run,
              checkboxCount: states.length,
              readOnly: true,
              skipped: 'the control is read-only',
            });
            return;
          }
          const accessUrl = (await accessRequest)?.url();
          accessPath = accessUrl ? new URL(accessUrl).pathname : null;
          originalGranted = await readGranted();

          const usable = states.flatMap((state, index) => (state.disabled ? [] : [index]));
          const unticked = usable.filter((index) => !states[index]?.checked);
          // Granting is the case under test; a learner who already has everything is measured
          // through the same control by taking up to five courses away and giving them back.
          const direction = unticked.length ? 'grant' : 'revoke';
          const chosen = (unticked.length ? unticked : usable).slice(0, 5);

          let putCount = 0;
          const putStatuses: number[] = [];
          card.on('request', (request) => {
            if (request.method() !== 'PUT') return;
            if (COURSE_ACCESS_PATH.test(new URL(request.url()).pathname)) putCount += 1;
          });
          card.on('response', (response) => {
            if (response.request().method() !== 'PUT') return;
            if (COURSE_ACCESS_PATH.test(new URL(response.url()).pathname)) {
              putStatuses.push(response.status());
            }
          });

          const phase = async (desired: (index: number) => boolean): Promise<RunRecord> => {
            // «Сохранено» of the previous save stays on screen for a moment; it must not end this one.
            const status = block.getByRole('status').first();
            for (let waited = 0; waited < 5_000; waited += 100) {
              const text = (await status.textContent().catch(() => '')) ?? '';
              if (!text.includes('Сохранено')) break;
              await sleep(100);
            }
            const pendingBoxes: number[] = [];
            for (const index of chosen) {
              if ((await boxes.nth(index).isChecked()) !== desired(index)) pendingBoxes.push(index);
            }
            if (!pendingBoxes.length) return { clicked: 0, notes: { phase: 'nothing to change' } };
            mutated = true;
            const putsBefore = putCount;
            const { value, metrics } = await measureStep(harness, () =>
              watch(
                card,
                {
                  triggers: ['click'],
                  timeoutMs: waitMs,
                  // Gated: a control that saves every tick on its own shows «Сохранено» after
                  // the first one, and the time asked for is the one after the last.
                  marks: [{ name: 'saved', kind: 'statusSaved', gated: true }],
                },
                async () => {
                  for (const index of pendingBoxes) {
                    await boxes.nth(index).click({ timeout: waitMs });
                  }
                },
              ),
            );
            return {
              clicked: pendingBoxes.length,
              putCount: putCount - putsBefore,
              marks: { firstClickToSavedMs: roundOrNull(value.marks.saved) },
              t0Source: value.t0Source,
              ...metrics,
              notes: value.notes,
            };
          };

          const apply = await phase((index) => !states[index]?.checked);
          const restore = await phase((index) => Boolean(states[index]?.checked));
          record(scenario, {
            run,
            checkboxCount: states.length,
            direction,
            chosen: chosen.length,
            apply,
            restore,
            raw: { putStatuses },
          });
        } catch (error) {
          record(scenario, { run, error: errorMessage(error) });
        } finally {
          // Whatever happened above, the learner ends with exactly the access they started with.
          let restoredVia = 'not-needed';
          if (mutated) {
            restoredVia = 'unverified';
            if (accessPath && originalGranted) {
              // The control saves a moment after the last tick; the check waits that out.
              await sleep(1_500);
              await harness.ledger.quiet(300, 5_000);
              restoredVia = 'ui';
              const current = await readGranted();
              if (JSON.stringify(current) !== JSON.stringify(originalGranted)) {
                const repaired = await card.request
                  .put(accessPath, {
                    headers: { origin: appOrigin },
                    data: { courseIds: originalGranted },
                  })
                  .catch(() => null);
                restoredVia = repaired?.ok() ? 'api' : 'FAILED';
              }
            }
          }
          const entry = scenarioRuns[scenario]?.at(-1);
          if (entry && entry.run === run) entry.restoredVia = restoredVia;
        }
      });
    };

    // -- C: the documents of a course --------------------------------------------------------------
    const runDocumentEditor = async (run: number) => {
      const names = [
        'C1_editorColdOpen',
        'C2_documentKindSwitch',
        'C3_programmeEdit',
        'C4_mobileHalfSwitch',
      ] as const;
      if (!selection) {
        for (const name of names) record(name, { run, error: 'document discovery failed' });
        return 0;
      }
      const chosen = selection;
      return withHarness(async (harness) => {
        const { page: editorPage } = harness;
        let cooldownSeconds = 0;
        const quiet = () => previewQuiet(editorPage, quietMs, 30_000);
        const guarded = async (name: string, body: () => Promise<RunRecord>) => {
          try {
            record(name, { run, ...(await body()) });
          } catch (error) {
            record(name, { run, error: errorMessage(error) });
          }
        };
        /** One user action that must end in a redrawn preview. */
        const redraw = async (
          triggers: string[],
          action: () => Promise<unknown>,
        ): Promise<RunRecord> => {
          await quiet();
          const taggedBefore = await tagCanvases(editorPage);
          const { value, metrics, snapshot } = await measureStep(harness, () =>
            watch(
              editorPage,
              { triggers, timeoutMs: waitMs, marks: [{ name: 'newCanvas', kind: 'newCanvas' }] },
              action,
            ),
          );
          cooldownSeconds = Math.max(cooldownSeconds, snapshot.maxRetryAfter);
          return {
            taggedBefore,
            marks: marksOf(value, ['newCanvas']),
            t0Source: value.t0Source,
            ...metrics,
            notes: value.notes,
          };
        };
        const showKind = async (kind: 'certificate' | 'protocol') => {
          const radio = await documentKindRadio(editorPage, kind);
          if (!radio) throw new Error(`«Вид документа»: no radio for ${kind}`);
          if ((await radio.getAttribute('aria-checked')) === 'true') return;
          await redraw(['click'], () => radio.click({ timeout: waitMs }));
        };

        // C1 — cold open of the course page.
        let editorReady = false;
        await guarded(names[0], async () => {
          const before = await readCpu(harness.cdp);
          const wallStart = Date.now();
          await editorPage.goto('/admin/documents/' + encodeURIComponent(chosen.course), {
            timeout: 120_000,
            waitUntil: 'commit',
          });
          let state: EditorState | undefined;
          let errorPolls = 0;
          while (Date.now() - wallStart < waitMs) {
            state = await editorPage
              .evaluate(() => (window as unknown as PerfWindow).__perfKit?.editorState())
              .catch(() => undefined);
            if (state?.firstCanvasAt != null) break;
            // A message may stand next to a page that pdf.js is still drawing (no spinner covers
            // that part), so only a message that outlives six seconds ends the wait early.
            errorPolls = state?.knownError && !state.spinner ? errorPolls + 1 : 0;
            if (errorPolls >= 60) break;
            await sleep(100);
          }
          const wallMs = Date.now() - wallStart;
          const after = await readCpu(harness.cdp);
          editorReady = Boolean(state && (state.firstCanvasAt !== null || state.hydratedAt !== null));
          await harness.ledger.quiet(500, 8_000);
          const navigation = await editorPage.evaluate(() =>
            (window as unknown as PerfWindow).__perfKit?.navigation(),
          );
          const perf = await takePerf(editorPage);
          const snapshot = await harness.ledger.snapshot();
          cooldownSeconds = Math.max(cooldownSeconds, snapshot.maxRetryAfter);
          return {
            marks: {
              firstCanvasMs: roundOrNull(state?.firstCanvasAt),
              hydratedMs: roundOrNull(state?.hydratedAt),
              firstCanvasWallMs: state?.firstCanvasAt != null ? wallMs : null,
              ttfbMs: roundOrNull(navigation?.ttfbMs),
              domContentLoadedMs: roundOrNull(navigation?.domContentLoadedMs),
              loadMs: roundOrNull(navigation?.loadMs),
              fcpMs: roundOrNull(navigation?.fcpMs),
            },
            cpu: cpuDelta(before, after),
            longTasks: {
              count: perf.longTasks.length,
              totalMs: round1(perf.longTasks.reduce((sum, item) => sum + item, 0)),
              maxMs: perf.longTasks.length ? round1(Math.max(...perf.longTasks)) : 0,
            },
            requests: snapshot.summary,
            raw: {
              longTasks: perf.longTasks.map(round1).slice(0, 200),
              errorResponses: snapshot.errors.slice(0, 50),
            },
            notes:
              state?.firstCanvasAt != null
                ? {}
                : { firstCanvas: 'no canvas; preview says: ' + (state?.message ?? 'nothing') },
          };
        });
        if (!editorReady) {
          for (const name of names.slice(1)) record(name, { run, error: 'the editor did not load' });
          return 0;
        }
        await editorPage
          .locator('.document-editor[data-hydrated]')
          .first()
          .waitFor({ state: 'visible', timeout: waitMs })
          .catch(() => undefined);

        // C2 — Протокол → Корочка → Протокол → Корочка.
        await guarded(names[1], async () => {
          const switches: RunRecord[] = [];
          for (const kind of ['certificate', 'protocol', 'certificate'] as const) {
            try {
              const radio = await documentKindRadio(editorPage, kind);
              if (!radio) throw new Error(`«Вид документа»: no radio for ${kind}`);
              switches.push({
                to: kind,
                ...(await redraw(['click'], () => radio.click({ timeout: waitMs }))),
              });
            } catch (error) {
              switches.push({ to: kind, error: errorMessage(error) });
            }
          }
          return { switches };
        });

        // C3 — one character in the programme's name, then back.
        await guarded(names[2], async () => {
          await showKind('protocol');
          const field = await programmeField(editorPage);
          if (!field) return { skipped: 'no programme field' };
          const original = await field.inputValue();
          const limit = Number(await field.getAttribute('maxlength')) || 240;
          const changed =
            original.length >= limit
              ? original.slice(0, -1) + (original.endsWith('7') ? '8' : '7')
              : original + '7';
          const edit = await redraw(['input'], () => field.fill(changed, { timeout: waitMs }));
          const restore = await redraw(['input'], () => field.fill(original, { timeout: waitMs }));
          return { tab: 'protocol', edit, restore };
        });

        let onPhone = false;
        // C4 — a phone: the other half of the booklet and back.
        await guarded(names[3], async () => {
          await showKind('certificate');
          if (!onPhone) await editorPage.setViewportSize({ width: 390, height: 844 });
          onPhone = true;
          await editorPage.locator('[data-document-preview]').first().scrollIntoViewIfNeeded();
          await quiet();
          const halves = editorPage.getByRole('radiogroup', { name: /Сторона|Половина/u }).first();
          if (!(await halves.count())) return { skipped: 'no half radiogroup' };
          const switches: RunRecord[] = [];
          for (const index of [1, 0]) {
            try {
              const taggedBefore = await tagCanvases(editorPage);
              const { value, metrics } = await measureStep(harness, () =>
                watch(
                  editorPage,
                  {
                    triggers: ['click'],
                    timeoutMs: 10_000,
                    marks: [{ name: 'transformSettled', kind: 'transformSettled' }],
                  },
                  () => halves.getByRole('radio').nth(index).click({ timeout: waitMs }),
                ),
              );
              await sleep(Math.min(1_500, quietMs));
              const settled = await previewQuiet(editorPage, 0, 1_000);
              switches.push({
                to: index === 1 ? 'right' : 'left',
                marks: marksOf(value, ['transformSettled']),
                recreated: taggedBefore > 0 ? settled.freshCanvasCount > 0 : null,
                transformBefore: value.notes.transformBefore ?? null,
                transformAfter:
                  value.notes.transformAfter ??
                  (await editorPage.evaluate(
                    () => (window as unknown as PerfWindow).__perfKit?.insertTransform() ?? null,
                  )),
                t0Source: value.t0Source,
                ...metrics,
                notes: value.notes,
              });
            } catch (error) {
              switches.push({ to: index === 1 ? 'right' : 'left', error: errorMessage(error) });
            }
          }
          return { viewport: '390x844', switches };
        });

        return cooldownSeconds;
      });
    };

    // -- the runs ----------------------------------------------------------------------------------
    const cooldowns: number[] = [];
    try {
      for (let run = 1; run <= runs; run += 1) {
        if (groups.has('A')) {
          await runEmployeeCard(run).catch((error) =>
            record('A1_cardFirstOpen', { run, error: errorMessage(error) }),
          );
          persist();
        }
        if (groups.has('B')) {
          await runCourseAccess(run).catch((error) =>
            record('B_courseAccessBulk', { run, error: errorMessage(error) }),
          );
          persist();
        }
        if (groups.has('C')) {
          const retryAfter = await runDocumentEditor(run).catch((error) => {
            record('C1_editorColdOpen', { run, error: errorMessage(error) });
            return 0;
          });
          persist();
          // A 429 is a finding of this run; it must not also decide the numbers of the next one.
          if (retryAfter > 0 && run < runs) {
            const cooldownMs = (Math.min(retryAfter, 65) + 1) * 1_000;
            cooldowns.push(cooldownMs);
            await sleep(cooldownMs);
          }
        }
      }
    } finally {
      report.cooldownsAfter429Ms = cooldowns;
      persist();
    }

    const failures = Object.values(scenarioRuns)
      .flat()
      .filter((entry) => typeof entry.error === 'string').length;
    testInfo.annotations.push({ type: 'admin-perf-output', description: outputPath });
    console.log(`[admin-perf] ${outputPath} (${failures} failed scenario run(s))`);
    expect(existsSync(outputPath), 'the measurement file must exist').toBe(true);
  });
}
