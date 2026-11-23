/**
 * URL construction for the two fixed wire contracts:
 *
 *   CDN pointer:  {cdnBaseUrl}/{projectSlug}/latest.json
 *   CDN read:     {cdnBaseUrl}/{projectSlug}/{version}/{locale}/{namespace}.json
 *   saveMissing:  POST {apiBaseUrl}/public/projects/{projectSlug}/missing/{locale}/{namespace}
 *   key usage:    POST {apiBaseUrl}/public/projects/{projectSlug}/used/{namespace}
 *
 * `version` is an immutable release version (`v3`). Mutable `latest` is first
 * resolved through latestManifestUrl().
 */

export interface CdnUrlOptions {
  cdnBaseUrl: string;
  projectSlug: string;
  /** Immutable release version, e.g. `'v3'`. */
  version: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

const seg = encodeURIComponent;

/** Atomic pointer used to resolve the mutable `latest` alias. */
export function latestManifestUrl(options: Pick<CdnUrlOptions, 'cdnBaseUrl' | 'projectSlug'>): string {
  const base = trimTrailingSlash(options.cdnBaseUrl);
  return `${base}/${seg(options.projectSlug)}/latest.json`;
}

/** Exact CDN URL the backend fetches for a locale+namespace. Exported for debugging/tests. */
export function cdnUrl(options: CdnUrlOptions, language: string, namespace: string): string {
  const base = trimTrailingSlash(options.cdnBaseUrl);
  return `${base}/${seg(options.projectSlug)}/${seg(options.version)}/${seg(language)}/${seg(namespace)}.json`;
}

/** saveMissing endpoint URL for a locale+namespace. */
export function missingUrl(
  apiBaseUrl: string,
  projectSlug: string,
  language: string,
  namespace: string,
): string {
  const base = trimTrailingSlash(apiBaseUrl);
  return `${base}/public/projects/${seg(projectSlug)}/missing/${seg(language)}/${seg(namespace)}`;
}

/** Key-usage endpoint URL for a namespace (see the `trackUsage` option). */
export function usedUrl(apiBaseUrl: string, projectSlug: string, namespace: string): string {
  const base = trimTrailingSlash(apiBaseUrl);
  return `${base}/public/projects/${seg(projectSlug)}/used/${seg(namespace)}`;
}
