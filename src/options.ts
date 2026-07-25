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
}

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
  };
}
