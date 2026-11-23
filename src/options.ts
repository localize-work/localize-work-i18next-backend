/**
 * Backend options: typed for consumers, validated at init so misconfiguration
 * fails loudly at startup instead of as silent 404s at runtime.
 */

export type LoadPath = string | ((language: string, namespace: string) => string);

export interface FailedLoadInfo {
  url: string;
  language: string;
  namespace: string;
  /** HTTP status when a response was received; absent on network errors. */
  status?: number;
  /** The thrown value on network/parse failures; absent on plain HTTP errors. */
  error?: unknown;
}

interface CommonOptions {
  /** Project slug as it appears in CDN paths and API routes. */
  projectSlug: string;
  /** Release to load: an immutable version like `'v3'`, or `'latest'` (default). */
  version?: string;
  /**
   * API origin for saveMissing, e.g. `https://api.localize.work`. Missing keys
   * are only reported when BOTH `apiBaseUrl` and `apiKey` are set.
   */
  apiBaseUrl?: string;
  /** Public (read/saveMissing) API key. Dev-only — never ship it enabled to prod. */
  apiKey?: string;
  /**
   * When true, a 404 for a namespace file is reported as a load error. By
   * default a 404 resolves to an empty resource: variant locales (en-FI over
   * en) publish sparse files, so an absent namespace is a normal condition.
   */
  strict?: boolean;
  /** Extra fetch options merged into every CDN request (headers, cache, …). */
  fetchOptions?: RequestInit;
  /** Observability hook — called on every failed CDN load, including sparse 404s. */
  onFailedLoad?: (info: FailedLoadInfo) => void;
  /**
   * Report which keys the app looks up, so the editor can show unused keys.
   * Dev/staging only. Needs `apiBaseUrl` and `apiKey`.
   *
   * `true` uses the defaults; an object adjusts them. In a browser, keys are
   * only reported on the hosts in `allowedHosts` (by default `localhost`,
   * `127.0.0.1` and `[::1]`); where there is no web address at all (server
   * rendering, React Native) they are reported whenever this is on. Each key
   * is sent at most once per page load.
   *
   * @see https://localize.work/docs/sdk/usage-tracking/
   */
  trackUsage?: boolean | TrackUsageOptions;
}

/** Settings for `trackUsage`. */
export interface TrackUsageOptions {
  /**
   * Hostnames (`window.location.hostname`, e.g. `'staging.example.com'`)
   * where a browser reports key usage. Exact matches only, no port. An IPv6
   * address is written in brackets, as the browser reports it: `'[::1]'`.
   * A blob: worker or about:srcdoc frame is checked by the hostname of the
   * page that made it; a page with an opaque origin by its protocol, so add
   * `'file:'` to report from Electron `file:` pages. Has no effect where
   * there is no web address: outside a browser and in React Native.
   * @default ['localhost', '127.0.0.1', '[::1]']
   */
  allowedHosts?: string[];
  /**
   * How long to collect keys before sending them, in milliseconds (1000 to
   * 3600000, one hour). Keys are also sent when the page is hidden or closed.
   * @default 30000
   */
  flushIntervalMs?: number;
}

export interface CdnBackendOptions extends CommonOptions {
  /** CDN origin, e.g. `https://cdn.localize.work`. */
  cdnBaseUrl: string;
  /**
   * Escape hatch overriding the whole CDN URL: a template with `{{lng}}` and
   * `{{ns}}` placeholders, or a function `(language, namespace) => url`.
   */
  loadPath?: LoadPath;
}

export interface LoadPathBackendOptions extends CommonOptions {
  cdnBaseUrl?: string;
  loadPath: LoadPath;
}

export type LocalizeBackendOptions = CdnBackendOptions | LoadPathBackendOptions;

/** Internal normalized shape after validation. */
export interface ResolvedOptions extends CommonOptions {
  version: string;
  strict: boolean;
  cdnBaseUrl?: string;
  loadPath?: LoadPath;
  saveMissingEnabled: boolean;
  /** Set only when usage tracking is on; apiBaseUrl and apiKey are then set too. */
  trackUsage?: ResolvedTrackUsage;
}

export interface ResolvedTrackUsage {
  allowedHosts: string[];
  flushIntervalMs: number;
}

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
export const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const MIN_FLUSH_INTERVAL_MS = 1_000;
/**
 * Longest collection time. The API counts a key as unused only when its stamp
 * is older than the period asked for plus 8 hours, an allowance that covers
 * the 6-hour re-send, its hourly stamp refresh and one hour of collection.
 */
export const MAX_FLUSH_INTERVAL_MS = 60 * 60 * 1000;

const PREFIX = '[@localize-work/i18next-backend]';

function fail(message: string): never {
  throw new Error(`${PREFIX} ${message}`);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`\`${name}\` must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function validateOptions(raw: unknown): ResolvedOptions {
  if (raw === null || typeof raw !== 'object') {
    fail(
      'backend options are required — pass them via i18next.init({ backend: { projectSlug, cdnBaseUrl } })',
    );
  }
  const o = raw as Partial<CdnBackendOptions & LoadPathBackendOptions>;

  const projectSlug = requireNonEmptyString(o.projectSlug, 'projectSlug');

  const loadPath = o.loadPath;
  if (loadPath !== undefined && typeof loadPath !== 'string' && typeof loadPath !== 'function') {
    fail('`loadPath` must be a string template or a (language, namespace) => url function');
  }
  let cdnBaseUrl: string | undefined;
  if (loadPath === undefined) {
    cdnBaseUrl = requireNonEmptyString(o.cdnBaseUrl, 'cdnBaseUrl');
  } else if (o.cdnBaseUrl !== undefined) {
    cdnBaseUrl = requireNonEmptyString(o.cdnBaseUrl, 'cdnBaseUrl');
  }

  const version = o.version === undefined ? 'latest' : requireNonEmptyString(o.version, 'version');

  const hasApiBaseUrl = o.apiBaseUrl !== undefined;
  const hasApiKey = o.apiKey !== undefined;
  if (hasApiBaseUrl !== hasApiKey) {
    fail(
      'saveMissing needs BOTH `apiBaseUrl` and `apiKey` — only one was provided. ' +
        'Omit both to disable missing-key reporting.',
    );
  }
  const apiBaseUrl = hasApiBaseUrl
    ? requireNonEmptyString(o.apiBaseUrl, 'apiBaseUrl')
    : undefined;
  const apiKey = hasApiKey ? requireNonEmptyString(o.apiKey, 'apiKey') : undefined;

  const trackUsage = resolveTrackUsage(o.trackUsage, apiBaseUrl !== undefined && apiKey !== undefined);

  if (typeof fetch !== 'function') {
    fail('global fetch is not available — Node 18+ or a browser is required');
  }

  return {
    projectSlug,
    cdnBaseUrl,
    loadPath,
    version,
    apiBaseUrl,
    apiKey,
    strict: o.strict === true,
    fetchOptions: o.fetchOptions,
    onFailedLoad: o.onFailedLoad,
    saveMissingEnabled: apiBaseUrl !== undefined && apiKey !== undefined,
    trackUsage,
  };
}

function resolveTrackUsage(raw: unknown, hasApi: boolean): ResolvedTrackUsage | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw !== true && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    fail(
      `\`trackUsage\` must be true, false or { allowedHosts, flushIntervalMs } (got ${JSON.stringify(raw)})`,
    );
  }
  if (!hasApi) {
    fail(
      'trackUsage needs BOTH `apiBaseUrl` and `apiKey` — set them, or turn trackUsage off.',
    );
  }
  const o: TrackUsageOptions = raw === true ? {} : (raw as TrackUsageOptions);

  let allowedHosts = [...DEFAULT_ALLOWED_HOSTS];
  if (o.allowedHosts !== undefined) {
    if (
      !Array.isArray(o.allowedHosts) ||
      !o.allowedHosts.every((host) => typeof host === 'string' && host.trim() !== '')
    ) {
      fail(
        `\`trackUsage.allowedHosts\` must be an array of hostnames (got ${JSON.stringify(o.allowedHosts)})`,
      );
    }
    allowedHosts = o.allowedHosts.map((host) => host.trim().toLowerCase());
  }

  let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
  if (o.flushIntervalMs !== undefined) {
    if (
      typeof o.flushIntervalMs !== 'number' ||
      !Number.isFinite(o.flushIntervalMs) ||
      o.flushIntervalMs < MIN_FLUSH_INTERVAL_MS ||
      o.flushIntervalMs > MAX_FLUSH_INTERVAL_MS
    ) {
      fail(
        `\`trackUsage.flushIntervalMs\` must be a number of milliseconds from ${MIN_FLUSH_INTERVAL_MS} ` +
          `to ${MAX_FLUSH_INTERVAL_MS} (got ${JSON.stringify(o.flushIntervalMs)})`,
      );
    }
    flushIntervalMs = o.flushIntervalMs;
  }

  return { allowedHosts, flushIntervalMs };
}
