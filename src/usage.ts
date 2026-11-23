/**
 * Key-usage tracking (the `trackUsage` option): records which keys the app
 * looks up and reports them to the API, so the editor can show keys nothing
 * uses any more.
 *
 *   POST {apiBaseUrl}/public/projects/{projectSlug}/used/{namespace}
 *   ["welcome", "items_one", "nav.home"]
 *
 * Keys are recorded by wrapping i18next's `resourceStore.getResource`, which
 * every `t()` lookup goes through, and are sent exactly as i18next asks for
 * them (`items_one`, `nav.home`). Each (namespace, key) is sent at most once
 * per page load. Like saveMissing, nothing here ever throws into the app.
 */
import type { ResolvedOptions } from './options.js';
import { retryDelayMs } from './retry.js';
import { usedUrl } from './url.js';

const PREFIX = '[@localize-work/i18next-backend]';
/** Server contract: 1–1000 names per request, each 1–512 characters. */
export const USAGE_MAX_NAMES_PER_REQUEST = 1_000;
export const USAGE_MAX_NAME_LENGTH = 512;
/** Fastify's default body limit. */
const USAGE_MAX_BODY_BYTES = 1024 * 1024;
/** Browsers refuse keepalive requests once their bodies together pass 64 KiB. */
const KEEPALIVE_BUDGET_BYTES = 60 * 1024;
export const USAGE_MAX_ATTEMPTS = 3;
/** Memory cap: names remembered per page before new ones are ignored. */
export const USAGE_MAX_TRACKED_NAMES = 50_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const STORE_HOOK = Symbol.for('@localize-work/i18next-backend/usage');

type FlushMode = 'timer' | 'pagehide' | 'exit';

interface Batch {
  namespace: string;
  names: string[];
  /** Encoded size of the JSON body. */
  bytes: number;
  /** Failed (5xx / network) attempts so far. */
  attempts: number;
  /** A timer flush sends only batches whose round has come. */
  round: number;
}

interface TrackerConfig {
  apiBaseUrl: string;
  apiKey: string;
  projectSlug: string;
  flushIntervalMs: number;
}

interface StoreHook {
  /** Trackers fed by this store, with how many backends attached each. */
  trackers: Map<UsageTracker, number>;
}

type GetResource = (...args: unknown[]) => unknown;

interface HookableStore {
  getResource: GetResource;
  [STORE_HOOK]?: StoreHook;
}

const encoder = new TextEncoder();

function jsonBytes(value: string): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** Split by the server's per-request name count and the encoded body limit. */
function chunkNames(names: string[]): { names: string[]; bytes: number }[] {
  const chunks: { names: string[]; bytes: number }[] = [];
  let current: string[] = [];
  let currentBytes = 2; // []
  for (const name of names) {
    const added = jsonBytes(name) + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0 &&
      (current.length >= USAGE_MAX_NAMES_PER_REQUEST || currentBytes + added > USAGE_MAX_BODY_BYTES)
    ) {
      chunks.push({ names: current, bytes: currentBytes });
      current = [];
      currentBytes = 2;
    }
    currentBytes += jsonBytes(name) + (current.length > 0 ? 1 : 0);
    current.push(name);
  }
  if (current.length > 0) chunks.push({ names: current, bytes: currentBytes });
  return chunks;
}

function unref(timer: unknown): void {
  (timer as { unref?: () => void } | undefined)?.unref?.();
}

/**
 * Collects looked-up keys for one project and API key, and sends them in the
 * background: every `flushIntervalMs`, when the page is hidden or closed, and
 * (outside a browser) before the process exits.
 */
export class UsageTracker {
  /** Every name recorded this page, per namespace — the dedup set. */
  private seen = new Map<string, Set<string>>();
  private seenCount = 0;
  /** Names recorded since the last flush, per namespace. */
  private pending = new Map<string, string[]>();
  /** Chunks ready to send, including ones waiting for a retry. */
  private batches: Batch[] = [];
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** No flush before this time (epoch ms) — set from a 429's Retry-After. */
  private blockedUntil = 0;
  private round = 0;
  private warnedCap = false;
  private warnedLongName = false;
  private removeExitListeners: (() => void) | undefined;

  constructor(private readonly config: TrackerConfig) {
    this.removeExitListeners = listenForExit((mode) => void this.flush(mode));
  }

  /** False after the API rejected the key: tracking is over for this page. */
  get active(): boolean {
    return !this.stopped;
  }

  record(namespace: string, key: string): void {
    if (this.stopped) return;
    let names = this.seen.get(namespace);
    if (names?.has(key)) return;
    if (this.seenCount >= USAGE_MAX_TRACKED_NAMES) {
      if (!this.warnedCap) {
        this.warnedCap = true;
        console.warn(
          `${PREFIX} trackUsage recorded ${USAGE_MAX_TRACKED_NAMES} keys on this page and ignores any further ones`,
        );
      }
      return;
    }
    if (!names) {
      names = new Set();
      this.seen.set(namespace, names);
    }
    names.add(key);
    this.seenCount++;
    if (key.length > USAGE_MAX_NAME_LENGTH) {
      if (!this.warnedLongName) {
        this.warnedLongName = true;
        console.warn(
          `${PREFIX} trackUsage skips keys longer than ${USAGE_MAX_NAME_LENGTH} characters ` +
            `(first one in namespace "${namespace}")`,
        );
      }
      return;
    }
    let queue = this.pending.get(namespace);
    if (!queue) {
      queue = [];
      this.pending.set(namespace, queue);
    }
    queue.push(key);
    this.schedule();
  }

  /** Send what is queued. Never rejects. */
  async flush(mode: FlushMode = 'timer'): Promise<void> {
    try {
      await this.send(mode);
    } catch (error) {
      // A bug here must not surface in the app; report it and carry on.
      console.warn(`${PREFIX} trackUsage failed sending keys:`, error);
    } finally {
      this.schedule();
    }
  }

  /** Stop for good: drop queued keys, timers and listeners. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.seen.clear();
    this.pending.clear();
    this.batches = [];
    this.removeExitListeners?.();
    this.removeExitListeners = undefined;
  }

  private hasWork(): boolean {
    return this.pending.size > 0 || this.batches.length > 0;
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined || !this.hasWork()) return;
    const delay = Math.min(
      Math.max(this.config.flushIntervalMs, this.blockedUntil - Date.now()),
      MAX_TIMER_DELAY_MS,
    );
    // unref: a Node process must not stay alive just to report usage.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush('timer');
    }, delay);
    unref(this.timer);
  }

  private takePending(): void {
    for (const [namespace, names] of this.pending) {
      for (const chunk of chunkNames(names)) {
        this.batches.push({ namespace, ...chunk, attempts: 0, round: 0 });
      }
    }
    this.pending.clear();
  }

  private async send(mode: FlushMode): Promise<void> {
    if (this.stopped || Date.now() < this.blockedUntil) return;
    this.takePending();
    if (this.batches.length === 0) return;
    const round = ++this.round;

    if (mode !== 'timer') {
      // The page or process is going away: start every request now. Hidden
      // pages may be discarded without another event, so this is the last
      // chance. Bodies within the keepalive budget outlive the page.
      const batches = this.batches.splice(0);
      let keepaliveBudget = mode === 'pagehide' ? KEEPALIVE_BUDGET_BYTES : 0;
      await Promise.all(
        batches.map((batch) => {
          const keepalive = batch.bytes <= keepaliveBudget;
          if (keepalive) keepaliveBudget -= batch.bytes;
          return this.post(batch, round, keepalive);
        }),
      );
      return;
    }

    // One request at a time, so a 401 or 429 stops the rest. Batches stay
    // queued until taken, so a page-exit flush meanwhile can still send them.
    for (;;) {
      if (this.stopped || Date.now() < this.blockedUntil) return;
      const index = this.batches.findIndex((batch) => batch.round <= round);
      if (index === -1) return;
      const [batch] = this.batches.splice(index, 1);
      await this.post(batch!, round, false);
    }
  }

  private async post(batch: Batch, round: number, keepalive: boolean): Promise<void> {
    const url = usedUrl(this.config.apiBaseUrl, this.config.projectSlug, batch.namespace);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch.names),
        ...(keepalive ? { keepalive: true } : {}),
      });
    } catch (error) {
      this.retryLater(batch, round, url, error);
      return;
    }
    if (response.ok || this.stopped) return;

    const { status } = response;
    if (status === 401 || status === 403) {
      console.warn(
        `${PREFIX} trackUsage stopped for this page: the API rejected the key (${status} from POST ${url})`,
      );
      this.stop();
      return;
    }
    if (status === 429) {
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + retryDelayMs(response, 0));
      this.batches.unshift(batch);
      return;
    }
    if (status >= 500) {
      this.retryLater(batch, round, url, status);
      return;
    }
    console.warn(
      `${PREFIX} trackUsage dropped ${batch.names.length} key(s): POST ${url} failed: ${status}`,
    );
  }

  private retryLater(batch: Batch, round: number, url: string, failure: unknown): void {
    if (this.stopped) return;
    batch.attempts++;
    if (batch.attempts >= USAGE_MAX_ATTEMPTS) {
      console.warn(
        `${PREFIX} trackUsage dropped ${batch.names.length} key(s): POST ${url} failed after ${USAGE_MAX_ATTEMPTS} attempts:`,
        failure,
      );
      return;
    }
    batch.round = round + 1;
    this.batches.push(batch);
  }
}

/**
 * Call `onExit` when the page is hidden or left (browser), or before the
 * process exits (Node). Returns a function that removes the listeners.
 */
function listenForExit(onExit: (mode: FlushMode) => void): (() => void) | undefined {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') onExit('pagehide');
    };
    const onPageHide = () => onExit('pagehide');
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }
  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    // The flush timer is unref'd, so a short script (a prerender, a test run)
    // would otherwise exit before the first flush.
    const onBeforeExit = () => onExit('exit');
    process.on('beforeExit', onBeforeExit);
    return () => process.off?.('beforeExit', onBeforeExit);
  }
  return undefined;
}

/** One tracker per project and key, shared by every i18next instance on the page. */
const trackers = new Map<string, UsageTracker>();

function trackerFor(config: TrackerConfig): UsageTracker {
  const id = JSON.stringify([
    config.apiBaseUrl,
    config.projectSlug,
    config.apiKey,
    config.flushIntervalMs,
  ]);
  let tracker = trackers.get(id);
  if (!tracker) {
    tracker = new UsageTracker(config);
    trackers.set(id, tracker);
  }
  return tracker;
}

/** Stops and forgets every tracker. For tests. */
export function resetUsageTracking(): void {
  for (const tracker of trackers.values()) tracker.stop();
  trackers.clear();
}

/**
 * The hostname of the page this runs in — a window or a worker — or
 * undefined outside a browser.
 */
function browserHostname(): string | undefined {
  const scope =
    typeof window !== 'undefined'
      ? window
      : typeof self !== 'undefined' &&
          typeof (self as { importScripts?: unknown }).importScripts === 'function'
        ? self
        : undefined;
  if (!scope) return undefined;
  const hostname = (scope as { location?: { hostname?: unknown } }).location?.hostname;
  // A browser page always has a hostname string ('' for file: pages).
  return typeof hostname === 'string' ? hostname : '';
}

/**
 * Wrap a resource store's getResource once, however many backends attach to
 * it. Returns a function that detaches `tracker` again.
 */
function attachToStore(store: HookableStore, tracker: UsageTracker): () => void {
  let hook = store[STORE_HOOK];
  if (!hook) {
    const original = store.getResource;
    const attached = new Map<UsageTracker, number>();
    hook = { trackers: attached };
    const getResource = function (this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args);
      try {
        const namespace = args[1];
        const key = args[2];
        if (typeof namespace === 'string' && namespace !== '' && typeof key === 'string' && key !== '') {
          for (const tracker of attached.keys()) tracker.record(namespace, key);
        }
      } catch {
        // Tracking must never break a translation lookup.
      }
      return result;
    };
    Object.defineProperty(store, STORE_HOOK, { value: hook, configurable: true });
    Object.defineProperty(store, 'getResource', {
      value: getResource,
      configurable: true,
      writable: true,
    });
  }
  const trackersOnStore = hook.trackers;
  trackersOnStore.set(tracker, (trackersOnStore.get(tracker) ?? 0) + 1);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    const count = trackersOnStore.get(tracker) ?? 0;
    if (count <= 1) trackersOnStore.delete(tracker);
    else trackersOnStore.set(tracker, count - 1);
  };
}

/**
 * Start reporting the keys looked up in `resourceStore`, if this page may.
 * Returns a function that stops it for this store, or undefined when nothing
 * was started.
 */
export function startUsageTracking(
  resourceStore: unknown,
  options: ResolvedOptions,
): (() => void) | undefined {
  const settings = options.trackUsage;
  if (!settings || !options.apiBaseUrl || !options.apiKey) return undefined;
  const hostname = browserHostname();
  if (hostname !== undefined && !settings.allowedHosts.includes(hostname.toLowerCase())) {
    return undefined;
  }
  if (
    resourceStore === null ||
    typeof resourceStore !== 'object' ||
    typeof (resourceStore as { getResource?: unknown }).getResource !== 'function'
  ) {
    console.warn(
      `${PREFIX} trackUsage is on, but i18next passed no resource store to the backend — ` +
        'register the backend with i18next.use()',
    );
    return undefined;
  }
  const tracker = trackerFor({
    apiBaseUrl: options.apiBaseUrl,
    apiKey: options.apiKey,
    projectSlug: options.projectSlug,
    flushIntervalMs: settings.flushIntervalMs,
  });
  if (!tracker.active) return undefined;
  return attachToStore(resourceStore as HookableStore, tracker);
}
