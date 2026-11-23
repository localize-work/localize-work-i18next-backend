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
 * per page load, and again after USAGE_REPORT_AGAIN_MS if it is still looked
 * up (a long-running server or tab). Like saveMissing, nothing here ever
 * throws into the app.
 */
import type { ResolvedOptions } from './options.js';
import { retryDelayMs } from './retry.js';
import { usedUrl } from './url.js';

const PREFIX = '[@localize-work/i18next-backend]';
/**
 * Server contract: 1–1000 names per request, each at most 2,062 bytes of
 * UTF-8: the longest key path the API stores (2,048 bytes, from an import)
 * plus the longest plural suffix (`_ordinal_other`).
 */
export const USAGE_MAX_NAMES_PER_REQUEST = 1_000;
export const USAGE_MAX_NAME_BYTES = 2_048 + '_ordinal_other'.length;
/** Fastify's default body limit. */
const USAGE_MAX_BODY_BYTES = 1024 * 1024;
/**
 * Browsers refuse keepalive requests once their bodies together pass 64 KiB
 * per page. In a browser, batches are cut to this size, so each can go out
 * with keepalive.
 */
const KEEPALIVE_BUDGET_BYTES = 60 * 1024;
export const USAGE_MAX_ATTEMPTS = 3;
/** Memory cap: names remembered per page before new ones are ignored. */
export const USAGE_MAX_TRACKED_NAMES = 50_000;
/**
 * A name looked up again this long after it was reported is reported again,
 * so a server or tab that runs for weeks keeps its keys' last use current.
 * The API refreshes a key's timestamp at most hourly anyway.
 */
export const USAGE_REPORT_AGAIN_MS = 6 * 60 * 60 * 1000;
/** Wait after a 429 whose Retry-After the response did not expose. */
const USAGE_RATE_LIMIT_FALLBACK_MS = 60_000;
/** Shortest wait after a 429, whatever its Retry-After says ("0", a past date). */
const USAGE_RATE_LIMIT_MIN_MS = 1_000;
/**
 * A request still unanswered after this long is abandoned and counted as a
 * failed attempt, so a connection a proxy holds open cannot stall reporting.
 */
export const USAGE_REQUEST_TIMEOUT_MS = 30_000;
/** Before a Node process exits: how many rate-limit waits, and the longest one. */
const EXIT_MAX_WAITS = 2;
const EXIT_MAX_WAIT_MS = 65_000;
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

/**
 * UTF-8 length of a string, counted by hand: React Native (Hermes) has no
 * TextEncoder in older releases, and tracking must work there.
 * JSON.stringify escapes lone surrogates, so every surrogate here is paired.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function jsonBytes(value: string): number {
  return utf8Length(JSON.stringify(value));
}

/**
 * Bytes of keepalive request bodies in flight on this page, across every
 * tracker: the browser's 64 KiB limit is per page, not per tracker.
 */
let keepaliveInFlight = 0;

/** Split by the server's per-request name count and the encoded body limit. */
function chunkNames(names: string[], maxBytes: number): { names: string[]; bytes: number }[] {
  const chunks: { names: string[]; bytes: number }[] = [];
  let current: string[] = [];
  let currentBytes = 2; // []
  for (const name of names) {
    const added = jsonBytes(name) + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0 &&
      (current.length >= USAGE_MAX_NAMES_PER_REQUEST || currentBytes + added > maxBytes)
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
  /** When each name was last recorded, per namespace — the dedup map. */
  private seen = new Map<string, Map<string, number>>();
  private seenCount = 0;
  /** Last sweep of expired names when the memory cap was reached. */
  private lastSweep = 0;
  /** Names recorded since the last flush, per namespace. */
  private pending = new Map<string, string[]>();
  /**
   * Every name queued and not yet delivered or dropped (pending, waiting in a
   * batch, or in flight), per namespace: a name re-recorded while its last
   * report still waits (say, behind repeated 429s) is not queued twice.
   */
  private unsent = new Map<string, Set<string>>();
  private unsentCount = 0;
  /** Chunks ready to send, including ones waiting for a retry. */
  private batches: Batch[] = [];
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** No flush before this time (epoch ms) — set from a 429's Retry-After. */
  private blockedUntil = 0;
  private round = 0;
  /** A timer flush is running; the next one is scheduled when it settles. */
  private flushing = false;
  private exitWaits = 0;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private warnedExitWait = false;
  private warnedCap = false;
  private warnedLongName = false;
  private warnedUnsentCap = false;
  private removeExitListeners: (() => void) | undefined;
  /** Ends a retire() wait early when the tracker is stopped. */
  private retireWake: (() => void) | undefined;
  /** Resource stores this tracker is attached to, counted per backend. */
  attachments = 0;

  constructor(private readonly config: TrackerConfig) {
    this.removeExitListeners = listenForExit((mode) => void this.flush(mode));
  }

  /** False after the API rejected the key: tracking is over for this page. */
  get active(): boolean {
    return !this.stopped;
  }

  record(namespace: string, key: string): void {
    if (this.stopped) return;
    const now = Date.now();
    let names = this.seen.get(namespace);
    const recordedAt = names?.get(key);
    if (recordedAt !== undefined && now - recordedAt < USAGE_REPORT_AGAIN_MS) return;
    if (recordedAt === undefined && this.seenCount >= USAGE_MAX_TRACKED_NAMES) {
      this.sweep(now);
      // The sweep may have dropped this namespace's map.
      names = this.seen.get(namespace);
    }
    if (recordedAt === undefined && this.seenCount >= USAGE_MAX_TRACKED_NAMES) {
      if (!this.warnedCap) {
        this.warnedCap = true;
        console.warn(
          `${PREFIX} trackUsage recorded ${USAGE_MAX_TRACKED_NAMES} keys on this page and ignores any further ones`,
        );
      }
      return;
    }
    // Marks the name as reported for USAGE_REPORT_AGAIN_MS. Done only once it
    // is queued, already waiting, or never sendable: a name turned away by a
    // full queue is recorded again on its next lookup.
    const markSeen = () => {
      if (!names) {
        names = new Map();
        this.seen.set(namespace, names);
      }
      names.set(key, now);
      if (recordedAt === undefined) this.seenCount++;
    };
    // No key name contains NUL (the API stores names as PostgreSQL text).
    if (key.includes('\u0000')) return markSeen();
    // A UTF-16 code unit is at most 3 bytes: count only names that could be long.
    if (key.length * 3 > USAGE_MAX_NAME_BYTES && utf8Length(key) > USAGE_MAX_NAME_BYTES) {
      markSeen();
      if (!this.warnedLongName) {
        this.warnedLongName = true;
        console.warn(
          `${PREFIX} trackUsage skips keys longer than ${USAGE_MAX_NAME_BYTES} bytes ` +
            `(first one in namespace "${namespace}")`,
        );
      }
      return;
    }
    let unsentNames = this.unsent.get(namespace);
    // Still waiting from its last report: that report carries it.
    if (unsentNames?.has(key)) return markSeen();
    if (this.unsentCount >= USAGE_MAX_TRACKED_NAMES) {
      if (!this.warnedUnsentCap) {
        this.warnedUnsentCap = true;
        console.warn(
          `${PREFIX} trackUsage has ${USAGE_MAX_TRACKED_NAMES} keys waiting to be sent and ignores further ones until they are`,
        );
      }
      return;
    }
    markSeen();
    if (!unsentNames) {
      unsentNames = new Set();
      this.unsent.set(namespace, unsentNames);
    }
    unsentNames.add(key);
    this.unsentCount++;
    let queue = this.pending.get(namespace);
    if (!queue) {
      queue = [];
      this.pending.set(namespace, queue);
    }
    queue.push(key);
    this.schedule();
  }

  /**
   * Forget names whose report is old enough to be sent again, at most once a
   * minute, so the memory cap does not end tracking for good.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [namespace, names] of this.seen) {
      for (const [name, recordedAt] of names) {
        if (now - recordedAt >= USAGE_REPORT_AGAIN_MS) {
          names.delete(name);
          this.seenCount--;
        }
      }
      if (names.size === 0) this.seen.delete(namespace);
    }
  }

  /** Send what is queued. Never rejects. */
  async flush(mode: FlushMode = 'timer'): Promise<void> {
    if (mode === 'timer') this.flushing = true;
    try {
      await this.send(mode);
    } catch (error) {
      // A bug here must not surface in the app; report it and carry on.
      console.warn(`${PREFIX} trackUsage failed sending keys:`, error);
    } finally {
      if (mode === 'timer') this.flushing = false;
      if (mode === 'exit') this.waitBeforeExit();
      this.schedule();
    }
  }

  /**
   * Before a Node process exits, keys held back by a 429 would be lost: the
   * flush timer does not keep the process alive. Keep it alive for the
   * Retry-After wait, a bounded number of times, then say what was dropped.
   */
  private waitBeforeExit(): void {
    if (this.stopped || this.exitTimer !== undefined || !this.hasWork()) return;
    const wait = this.blockedUntil - Date.now();
    // Not held back: a retry is due now, and beforeExit fires again for it.
    if (wait <= 0) return;
    const queued =
      this.batches.reduce((sum, batch) => sum + batch.names.length, 0) +
      [...this.pending.values()].reduce((sum, names) => sum + names.length, 0);
    if (this.exitWaits >= EXIT_MAX_WAITS || wait > EXIT_MAX_WAIT_MS) {
      console.warn(
        `${PREFIX} trackUsage dropped ${queued} key(s) unsent as the process exits: the API rate-limited them`,
      );
      this.pending.clear();
      this.batches = [];
      this.unsent.clear();
      this.unsentCount = 0;
      return;
    }
    this.exitWaits++;
    if (!this.warnedExitWait) {
      this.warnedExitWait = true;
      console.warn(
        `${PREFIX} trackUsage is rate limited: waiting ${Math.ceil(wait / 1000)} s to send ${queued} key(s) before the process exits`,
      );
    }
    // Not unref'd: this timer is what keeps the process alive for the wait.
    this.exitTimer = setTimeout(() => {
      this.exitTimer = undefined;
      void this.flush('exit');
    }, wait);
  }

  /** Stop for good: drop queued keys, timers and listeners. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.exitTimer !== undefined) clearTimeout(this.exitTimer);
    this.exitTimer = undefined;
    this.retireWake?.();
    this.retireWake = undefined;
    this.seen.clear();
    this.seenCount = 0;
    this.pending.clear();
    this.batches = [];
    this.unsent.clear();
    this.unsentCount = 0;
    this.removeExitListeners?.();
    this.removeExitListeners = undefined;
  }

  /** The batch was delivered or dropped: its names may be queued again. */
  private settle(batch: Batch): void {
    const names = this.unsent.get(batch.namespace);
    if (!names) return;
    for (const name of batch.names) {
      if (names.delete(name)) this.unsentCount--;
    }
    if (names.size === 0) this.unsent.delete(batch.namespace);
  }

  /**
   * Send what is queued, then stop. A 429 or a failed request is retried like
   * the exit flush: up to EXIT_MAX_WAITS waits of at most EXIT_MAX_WAIT_MS
   * each, then what is left is dropped with a warning.
   */
  async retire(): Promise<void> {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Listeners go now, not when the send settles: a process re-initializing
    // backends quickly would otherwise pile them up meanwhile.
    this.removeExitListeners?.();
    this.removeExitListeners = undefined;
    retiring.add(this);
    try {
      for (let waits = 0; ; waits++) {
        try {
          await this.send('exit');
        } catch (error) {
          console.warn(`${PREFIX} trackUsage failed sending keys:`, error);
        }
        if (this.stopped || !this.hasWork()) break;
        const wait = Math.max(this.blockedUntil - Date.now(), USAGE_RATE_LIMIT_MIN_MS);
        if (waits >= EXIT_MAX_WAITS || wait > EXIT_MAX_WAIT_MS) {
          const queued =
            this.batches.reduce((sum, batch) => sum + batch.names.length, 0) +
            [...this.pending.values()].reduce((sum, names) => sum + names.length, 0);
          console.warn(
            `${PREFIX} trackUsage dropped ${queued} key(s) unsent: the API did not take them before tracking ended`,
          );
          break;
        }
        // Not unref'd: a short script whose instance was collected still
        // delivers its last keys, within the same bound as the exit flush.
        await new Promise<void>((resolve) => {
          this.retireWake = resolve;
          this.exitTimer = setTimeout(resolve, wait);
        });
        this.retireWake = undefined;
        this.exitTimer = undefined;
      }
    } finally {
      retiring.delete(this);
      this.stop();
    }
  }

  private hasWork(): boolean {
    return this.pending.size > 0 || this.batches.length > 0;
  }

  private schedule(): void {
    // While a timer flush runs, the next one is scheduled when it settles, so
    // timer requests never overlap.
    if (this.stopped || this.flushing || this.timer !== undefined || !this.hasWork()) return;
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
    const maxBytes = isBrowserPage() ? KEEPALIVE_BUDGET_BYTES : USAGE_MAX_BODY_BYTES;
    for (const [namespace, names] of this.pending) {
      for (const chunk of chunkNames(names, maxBytes)) {
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
      let keepaliveBudget =
        mode === 'pagehide' ? KEEPALIVE_BUDGET_BYTES - keepaliveInFlight : 0;
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
      // In a browser, a timer request is keepalive when it fits, so a page
      // closed while it is in flight still delivers it: the page-hide flush
      // only sends what is still queued.
      const keepalive =
        isBrowserPage() && batch!.bytes <= KEEPALIVE_BUDGET_BYTES - keepaliveInFlight;
      await this.post(batch!, round, keepalive);
    }
  }

  private async post(batch: Batch, round: number, keepalive: boolean): Promise<void> {
    const url = usedUrl(this.config.apiBaseUrl, this.config.projectSlug, batch.namespace);
    let response: Response;
    if (keepalive) keepaliveInFlight += batch.bytes;
    try {
      response = await fetchWithTimeout(url, {
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
    } finally {
      if (keepalive) keepaliveInFlight = Math.max(0, keepaliveInFlight - batch.bytes);
    }
    // Only the status and headers are read. Cancel the body so a response
    // that never finishes cannot hold a connection (and a Node process) open.
    discardBody(response);
    if (this.stopped) return;
    if (response.ok) {
      this.settle(batch);
      return;
    }

    const { status } = response;
    if (status === 401 || status === 403) {
      console.warn(
        `${PREFIX} trackUsage stopped for this page: the API rejected the key (${status} from POST ${url})`,
      );
      this.stop();
      return;
    }
    if (status === 429) {
      // Without a readable Retry-After (an older API, or a browser hiding it)
      // wait out the API's whole rate-limit window.
      const wait = response.headers.get('retry-after')
        ? Math.max(retryDelayMs(response, 0), USAGE_RATE_LIMIT_MIN_MS)
        : USAGE_RATE_LIMIT_FALLBACK_MS;
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + wait);
      // A later flush retries it, never this one.
      batch.round = round + 1;
      this.batches.unshift(batch);
      return;
    }
    if (status >= 500) {
      this.retryLater(batch, round, url, status);
      return;
    }
    this.settle(batch);
    console.warn(
      `${PREFIX} trackUsage dropped ${batch.names.length} key(s): POST ${url} failed: ${status}`,
    );
  }

  private retryLater(batch: Batch, round: number, url: string, failure: unknown): void {
    if (this.stopped) return;
    batch.attempts++;
    if (batch.attempts >= USAGE_MAX_ATTEMPTS) {
      this.settle(batch);
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
 * fetch that gives up after USAGE_REQUEST_TIMEOUT_MS. The race also covers a
 * fetch that ignores the abort signal, so the flush loop always moves on.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`no answer within ${USAGE_REQUEST_TIMEOUT_MS} ms`));
    }, USAGE_REQUEST_TIMEOUT_MS);
    unref(timer);
  });
  try {
    return await Promise.race([
      fetch(url, controller ? { ...init, signal: controller.signal } : init),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function discardBody(response: Response): void {
  try {
    const cancelled = response.body?.cancel();
    if (cancelled) cancelled.catch(() => {});
  } catch {
    // A body already used or locked needs nothing.
  }
}

/** A browser page (a window with a document), where keepalive requests apply. */
function isBrowserPage(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Call `onExit` when the page is hidden or left (browser), or before the
 * process exits (Node). Returns a function that removes the listeners.
 */
function listenForExit(onExit: (mode: FlushMode) => void): (() => void) | undefined {
  if (isBrowserPage()) {
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
/** Trackers sending their last queue after leaving the registry. */
const retiring = new Set<UsageTracker>();

function trackerId(config: TrackerConfig): string {
  return JSON.stringify([
    config.apiBaseUrl,
    config.projectSlug,
    config.apiKey,
    config.flushIntervalMs,
  ]);
}

function trackerFor(config: TrackerConfig): UsageTracker {
  const id = trackerId(config);
  let tracker = trackers.get(id);
  if (!tracker) {
    tracker = new UsageTracker(config);
    trackers.set(id, tracker);
  }
  return tracker;
}

/**
 * A tracker no store feeds any more (its backends were re-initialized with
 * other settings): send what it has queued once, then drop it, its timers
 * and its listeners, so a long-running process does not collect them.
 */
function retireTracker(tracker: UsageTracker, config: TrackerConfig): void {
  const id = trackerId(config);
  if (trackers.get(id) === tracker) trackers.delete(id);
  void tracker.retire();
}

/** Stops and forgets every tracker. For tests. */
export function resetUsageTracking(): void {
  for (const tracker of trackers.values()) tracker.stop();
  for (const tracker of retiring) tracker.stop();
  trackers.clear();
  keepaliveInFlight = 0;
}

/**
 * What allowedHosts is checked against for the page or worker this runs in:
 *
 * - its hostname;
 * - for a page or worker without a host of its own (a blob: worker, an
 *   about:srcdoc or about:blank frame), the hostname of the origin it
 *   inherits from the page that made it;
 * - for an opaque origin (file: pages, data: workers, sandboxed frames), its
 *   protocol, such as `'file:'`, which no default allows;
 * - undefined where there is no web address at all: outside a browser, and
 *   in runtimes with a `window` but no `location.protocol`, such as React
 *   Native. allowedHosts does not apply there.
 */
function pageHost(): string | undefined {
  const scope =
    typeof window !== 'undefined'
      ? window
      : typeof self !== 'undefined' &&
          typeof (self as { importScripts?: unknown }).importScripts === 'function'
        ? self
        : undefined;
  if (!scope) return undefined;
  const location = (scope as { location?: unknown }).location;
  if (location === null || typeof location !== 'object') return undefined;
  const { hostname, origin, protocol } = location as {
    hostname?: unknown;
    origin?: unknown;
    protocol?: unknown;
  };
  if (typeof hostname === 'string' && hostname !== '') return hostname;
  // The scope's own origin comes first: an about:srcdoc or about:blank frame
  // has location.origin 'null' while self.origin is the inherited origin. A
  // blob: worker has the inherited origin on both.
  for (const candidate of [(scope as { origin?: unknown }).origin, origin]) {
    if (typeof candidate !== 'string' || candidate === 'null') continue;
    try {
      const inherited = new URL(candidate).hostname;
      if (inherited !== '') return inherited;
    } catch {
      // Not a URL: try the next, then the protocol.
    }
  }
  return typeof protocol === 'string' && protocol !== '' ? protocol : undefined;
}

/**
 * Wrap a resource store's getResource once, however many backends attach to
 * it. Returns a function that detaches `tracker` again.
 */
function attachToStore(
  store: HookableStore,
  tracker: UsageTracker,
  config: TrackerConfig,
): () => void {
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
  tracker.attachments++;
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    const count = trackersOnStore.get(tracker) ?? 0;
    if (count <= 1) trackersOnStore.delete(tracker);
    else trackersOnStore.set(tracker, count - 1);
    tracker.attachments--;
    if (tracker.attachments <= 0) retireTracker(tracker, config);
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
  const host = pageHost();
  if (host !== undefined && !settings.allowedHosts.includes(host.toLowerCase())) {
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
  const config: TrackerConfig = {
    apiBaseUrl: options.apiBaseUrl,
    apiKey: options.apiKey,
    projectSlug: options.projectSlug,
    flushIntervalMs: settings.flushIntervalMs,
  };
  const tracker = trackerFor(config);
  if (!tracker.active) return undefined;
  return attachToStore(resourceStore as HookableStore, tracker, config);
}
