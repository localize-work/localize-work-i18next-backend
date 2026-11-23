import type { BackendModule, InitOptions, ReadCallback, Services } from 'i18next';
import type { LocalizeBackendOptions, ResolvedOptions } from './options.js';
import { validateOptions } from './options.js';
import { retryDelayMs } from './retry.js';
import { cdnUrl, latestManifestUrl, missingUrl } from './url.js';
import { startUsageTracking } from './usage.js';

const PREFIX = '[@localize-work/i18next-backend]';
const SAVE_MISSING_MAX_ENTRIES = 1_000;
const SAVE_MISSING_MAX_KEY_LENGTH = 512;
const SAVE_MISSING_MAX_VALUE_LENGTH = 10_000;
const SAVE_MISSING_MAX_BODY_BYTES = 1024 * 1024;
const SAVE_MISSING_MAX_ATTEMPTS = 3;

interface MissingChunkResult {
  chunks: Record<string, string>[];
  skipped: number;
}

/** Split by both schema count and Fastify's encoded body limit. */
function chunkMissingBody(body: Record<string, string>): MissingChunkResult {
  const encoder = new TextEncoder();
  const chunks: Record<string, string>[] = [];
  let current: Record<string, string> = {};
  let currentEntries = 0;
  let currentBytes = 2; // {}
  let skipped = 0;

  for (const [key, value] of Object.entries(body)) {
    if (
      key.length === 0 ||
      key.length > SAVE_MISSING_MAX_KEY_LENGTH ||
      value.length > SAVE_MISSING_MAX_VALUE_LENGTH
    ) {
      skipped++;
      continue;
    }
    const entryBytes =
      encoder.encode(JSON.stringify(key)).byteLength +
      1 +
      encoder.encode(JSON.stringify(value)).byteLength;
    const addedBytes = entryBytes + (currentEntries > 0 ? 1 : 0);
    if (
      currentEntries > 0 &&
      (currentEntries >= SAVE_MISSING_MAX_ENTRIES ||
        currentBytes + addedBytes > SAVE_MISSING_MAX_BODY_BYTES)
    ) {
      chunks.push(current);
      current = {};
      currentEntries = 0;
      currentBytes = 2;
    }
    current[key] = value;
    currentEntries++;
    currentBytes += entryBytes + (currentEntries > 1 ? 1 : 0);
  }
  if (currentEntries > 0) chunks.push(current);
  return { chunks, skipped };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

class LatestResolutionError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly retry: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Unhooks the usage tracking of each i18next instance, keyed by its
 * `services` object: i18next keeps that object across init() calls, while
 * the resource store and (for a registered class) the backend are new each
 * time.
 */
const usageByInstance = new WeakMap<object, () => void>();

/**
 * Detaches the usage tracking of an i18next instance that was discarded
 * without another init() (one instance per request on a server), so a
 * tracker with that instance's settings is retired instead of living, with
 * its exit listener, as long as the process. Keyed (and unregistered) by the
 * same `services` object; the held detach function does not reference it.
 */
const usageCleanup =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<() => void>((detach) => detach())
    : undefined;

/**
 * i18next backend plugin for localize.work.
 *
 * read(): resolves the atomic latest pointer once (unless version-pinned), then
 * fetches published i18next JSON from the immutable release path.
 * Retry classification (second callback argument is i18next's retry flag):
 *   - 2xx            → callback(null, data)
 *   - 404            → callback(null, {}) — sparse variant locales make an
 *                      absent namespace file a NORMAL condition; opt into
 *                      callback(err, false) with `strict: true`
 *   - other 4xx      → callback(err, false)  (config problem; retrying won't help)
 *   - 5xx / network  → callback(err, true)   (transient; let i18next retry)
 *
 * create(): batches missing keys per (locale, namespace) within a microtask
 * and POSTs them to the API. Active only when apiBaseUrl+apiKey are set;
 * failures are warned about, never thrown — saveMissing must never break the
 * host app.
 *
 * init() with `trackUsage`: hooks i18next's resource store so every key the
 * app looks up is reported to the API in the background (see usage.ts).
 */
export class LocalizeBackend implements BackendModule<LocalizeBackendOptions> {
  static type = 'backend' as const;
  type = 'backend' as const;

  private options: ResolvedOptions | undefined;
  /** Pending missing keys, keyed by `${language}\u0000${namespace}`. */
  private pendingMissing = new Map<string, Record<string, string>>();
  private flushScheduled = false;
  /** One initialized backend uses one release across every locale/namespace read. */
  private latestVersion: Promise<string> | undefined;

  constructor(services?: Services, options?: LocalizeBackendOptions, i18nextOptions?: InitOptions) {
    // i18next constructs plugin classes with no arguments and calls init()
    // itself; the constructor arguments only serve manual instantiation.
    if (services !== undefined || options !== undefined) {
      this.init(services as Services, options as LocalizeBackendOptions, i18nextOptions ?? {});
    }
  }

  init(services: Services, backendOptions: LocalizeBackendOptions, _i18nextOptions: InitOptions): void {
    this.options = validateOptions(backendOptions);
    this.latestVersion = undefined;
    // A second init() of the same i18next instance replaces the first one's
    // settings, usage tracking included, even though i18next then hands over
    // a new resource store and usually a new backend object; another
    // instance sharing this backend object keeps its own. Attach the new
    // settings before detaching the old ones, so unchanged settings keep
    // their tracker (and what it already reported) instead of retiring it.
    const store: unknown = services?.resourceStore;
    const instanceKey = typeof services === 'object' && services !== null ? services : undefined;
    const previous = instanceKey ? usageByInstance.get(instanceKey) : undefined;
    const detach = this.options.trackUsage
      ? startUsageTracking(store, this.options)
      : undefined;
    if (instanceKey) {
      usageCleanup?.unregister(instanceKey);
      if (detach) {
        usageByInstance.set(instanceKey, detach);
        usageCleanup?.register(instanceKey, detach, instanceKey);
      } else usageByInstance.delete(instanceKey);
    }
    previous?.();
  }

  read(language: string, namespace: string, callback: ReadCallback): void {
    const options = this.requireOptions();
    if (!options.loadPath && options.version === 'latest') {
      void this.loadLatest(options, language, namespace, callback);
      return;
    }
    const url = this.urlFor(options, language, namespace);
    void this.load(options, url, language, namespace, callback);
  }

  create(languages: readonly string[], namespace: string, key: string, fallbackValue: string): void {
    const options = this.options;
    if (!options?.saveMissingEnabled) return; // silent no-op without apiBaseUrl+apiKey
    for (const language of languages) {
      const bucketKey = `${language}\u0000${namespace}`;
      let bucket = this.pendingMissing.get(bucketKey);
      if (!bucket) {
        bucket = {};
        this.pendingMissing.set(bucketKey, bucket);
      }
      bucket[key] = fallbackValue ?? '';
    }
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        void this.flushMissing(options);
      });
    }
  }

  private requireOptions(): ResolvedOptions {
    if (!this.options) {
      throw new Error(`${PREFIX} used before init() — register the plugin via i18next.use()`);
    }
    return this.options;
  }

  private urlFor(options: ResolvedOptions, language: string, namespace: string): string {
    const { loadPath } = options;
    if (typeof loadPath === 'function') return loadPath(language, namespace);
    if (typeof loadPath === 'string') {
      return loadPath
        .replace(/\{\{\s*lng\s*\}\}/g, encodeURIComponent(language))
        .replace(/\{\{\s*ns\s*\}\}/g, encodeURIComponent(namespace));
    }
    // validateOptions guarantees cdnBaseUrl when loadPath is absent.
    return cdnUrl(
      { cdnBaseUrl: options.cdnBaseUrl!, projectSlug: options.projectSlug, version: options.version },
      language,
      namespace,
    );
  }

  private async load(
    options: ResolvedOptions,
    url: string,
    language: string,
    namespace: string,
    callback: ReadCallback,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url, options.fetchOptions);
    } catch (error) {
      options.onFailedLoad?.({ url, language, namespace, error });
      callback(new Error(`${PREFIX} failed fetching ${url}: ${String(error)}`), true);
      return;
    }

    if (response.status === 404) {
      options.onFailedLoad?.({ url, language, namespace, status: 404 });
      if (options.strict) {
        callback(new Error(`${PREFIX} ${url} returned 404 (strict mode)`), false);
      } else {
        // Sparse variant locales: a missing namespace file means "no
        // overrides here" — resolve to an empty resource and let the
        // configured fallbackLng chain supply the values.
        callback(null, {});
      }
      return;
    }

    if (!response.ok) {
      options.onFailedLoad?.({ url, language, namespace, status: response.status });
      const retry = response.status >= 500;
      callback(
        new Error(`${PREFIX} failed loading ${url}: ${response.status} ${response.statusText}`),
        retry,
      );
      return;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      options.onFailedLoad?.({ url, language, namespace, status: response.status, error });
      callback(new Error(`${PREFIX} failed parsing ${url} as JSON: ${String(error)}`), false);
      return;
    }
    callback(null, data as Record<string, unknown>);
  }

  /**
   * Resolve one atomic pointer before loading an immutable release artifact.
   * A publication therefore cannot mix namespace files from two releases.
   */
  private async loadLatest(
    options: ResolvedOptions,
    language: string,
    namespace: string,
    callback: ReadCallback,
  ): Promise<void> {
    const pointerUrl = latestManifestUrl({
      cdnBaseUrl: options.cdnBaseUrl!,
      projectSlug: options.projectSlug,
    });
    const resolution = (this.latestVersion ??= this.resolveLatestVersion(options, pointerUrl));
    let version: string;
    try {
      version = await resolution;
    } catch (error) {
      // A transient failure may be retried by i18next; do not poison this
      // backend instance's pointer cache permanently.
      if (this.latestVersion === resolution) this.latestVersion = undefined;
      const failure =
        error instanceof LatestResolutionError
          ? error
          : new LatestResolutionError(
              `${PREFIX} failed resolving latest release at ${pointerUrl}: ${String(error)}`,
              pointerUrl,
              true,
              undefined,
              { cause: error },
            );
      options.onFailedLoad?.({
        url: failure.url,
        language,
        namespace,
        status: failure.status,
        error: failure.cause,
      });
      callback(failure, failure.retry);
      return;
    }

    const url = cdnUrl(
      { cdnBaseUrl: options.cdnBaseUrl!, projectSlug: options.projectSlug, version },
      language,
      namespace,
    );
    await this.load(options, url, language, namespace, callback);
  }

  private async resolveLatestVersion(
    options: ResolvedOptions,
    pointerUrl: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(pointerUrl, options.fetchOptions);
    } catch (error) {
      throw new LatestResolutionError(
        `${PREFIX} failed fetching ${pointerUrl}: ${String(error)}`,
        pointerUrl,
        true,
        undefined,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new LatestResolutionError(
        `${PREFIX} failed resolving latest release at ${pointerUrl}: ${response.status} ${response.statusText}`,
        pointerUrl,
        response.status >= 500,
        response.status,
      );
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new LatestResolutionError(
        `${PREFIX} failed parsing ${pointerUrl} as JSON: ${String(error)}`,
        pointerUrl,
        false,
        response.status,
        { cause: error },
      );
    }
    const version =
      value && typeof value === 'object' && 'version' in value
        ? (value as { version?: unknown }).version
        : undefined;
    if (typeof version !== 'string' || !/^v[1-9]\d*$/.test(version)) {
      throw new LatestResolutionError(
        `${PREFIX} invalid latest release pointer at ${pointerUrl}`,
        pointerUrl,
        false,
        response.status,
      );
    }
    return version;
  }

  private async flushMissing(options: ResolvedOptions): Promise<void> {
    const batches = [...this.pendingMissing.entries()];
    this.pendingMissing.clear();
    await Promise.all(
      batches.map(async ([bucketKey, body]) => {
        const separator = bucketKey.indexOf('\u0000');
        const language = bucketKey.slice(0, separator);
        const namespace = bucketKey.slice(separator + 1);
        const url = missingUrl(options.apiBaseUrl!, options.projectSlug, language, namespace);
        const { chunks, skipped } = chunkMissingBody(body);
        if (skipped > 0) {
          console.warn(
            `${PREFIX} saveMissing skipped ${skipped} key(s) outside the server's key/value limits`,
          );
        }
        for (const chunk of chunks) {
          await this.postMissingChunk(options, url, chunk);
        }
      }),
    );
  }

  private async postMissingChunk(
    options: ResolvedOptions,
    url: string,
    body: Record<string, string>,
  ): Promise<void> {
    let lastResponse: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < SAVE_MISSING_MAX_ATTEMPTS; attempt++) {
      try {
        lastResponse = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey!}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (lastResponse.ok) return;
        if (lastResponse.status !== 429 && lastResponse.status < 500) {
          console.warn(`${PREFIX} saveMissing POST ${url} failed: ${lastResponse.status}`);
          return;
        }
      } catch (error) {
        lastError = error;
        lastResponse = undefined;
      }
      if (attempt + 1 < SAVE_MISSING_MAX_ATTEMPTS) {
        await wait(retryDelayMs(lastResponse, attempt));
      }
    }
    if (lastResponse) {
      console.warn(
        `${PREFIX} saveMissing POST ${url} failed after ${SAVE_MISSING_MAX_ATTEMPTS} attempts: ${lastResponse.status}`,
      );
    } else {
      console.warn(
        `${PREFIX} saveMissing POST ${url} failed after ${SAVE_MISSING_MAX_ATTEMPTS} attempts:`,
        lastError,
      );
    }
  }
}
