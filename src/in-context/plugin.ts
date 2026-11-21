import type { i18n, ThirdPartyModule, TOptions } from 'i18next';
import { encodeMarker, MarkerRegistry } from './markers.js';
import { startOverlay, type OverlayHandle } from './overlay.js';

const PREFIX = '[@localize-work/i18next-backend/in-context]';
export const POST_PROCESSOR_NAME = 'localizeInContext';
export const DEFAULT_EDITOR_URL = 'https://app.localize.work';
export const DEFAULT_QUERY_PARAMETER = 'localize';
/** sessionStorage key that keeps editing on while the tab navigates. */
export const SESSION_FLAG = 'localize-work:in-context';

export interface LocalizeInContextOptions {
  /** The project's slug. Defaults to `backend.projectSlug`. */
  projectSlug?: string;
  /** Where the editor runs. Defaults to https://app.localize.work. */
  editorUrl?: string;
  /**
   * Whether editing is on. By default it turns on when the page is opened
   * with `?localize=edit` and stays on for that browser tab. Pass `false` to
   * switch the feature off entirely (e.g. in production), or `true` to force it.
   */
  enabled?: boolean;
  /** The query parameter that turns editing on. Defaults to `localize`. */
  queryParameter?: string;
}

interface ResolvedInContextOptions {
  projectSlug: string;
  editorUrl: string;
  queryParameter: string;
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Whether editing is on for this page load, from the URL or the tab's memory. */
function enabledByVisitor(queryParameter: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const value = new URLSearchParams(window.location.search).get(queryParameter);
    if (value === 'edit') {
      window.sessionStorage.setItem(SESSION_FLAG, '1');
      return true;
    }
    if (value === 'off') {
      window.sessionStorage.removeItem(SESSION_FLAG);
      return false;
    }
    return window.sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    // Storage can be blocked; the query parameter alone then decides.
    return false;
  }
}

function resolveOptions(instance: i18n): ResolvedInContextOptions | null {
  const raw = (instance.options as { localizeInContext?: LocalizeInContextOptions })
    .localizeInContext;
  const options = raw ?? {};
  if (options.enabled === false) return null;
  const queryParameter = options.queryParameter ?? DEFAULT_QUERY_PARAMETER;
  const enabled = options.enabled ?? enabledByVisitor(queryParameter);
  if (!enabled) return null;

  const backend = instance.options.backend as { projectSlug?: unknown } | undefined;
  const projectSlug = options.projectSlug ?? backend?.projectSlug;
  if (typeof projectSlug !== 'string' || projectSlug.trim() === '') {
    console.warn(
      `${PREFIX} editing is off: set localizeInContext.projectSlug (or backend.projectSlug)`,
    );
    return null;
  }
  let editorUrl: URL;
  try {
    editorUrl = new URL(options.editorUrl ?? DEFAULT_EDITOR_URL);
  } catch {
    console.warn(`${PREFIX} editing is off: localizeInContext.editorUrl is not a valid URL`);
    return null;
  }
  return { projectSlug, editorUrl: editorUrl.origin, queryParameter };
}

interface ResolvedTranslation {
  usedKey?: string;
  exactUsedKey?: string;
  usedNS?: string;
}

/**
 * The project key a translated string came from. i18next reports the exact
 * resource it used, e.g. `items_other`; the project stores one key `items`
 * with a text per plural form, so a plural suffix is dropped when the call
 * passed a count. A context suffix (`friend_male`) is a key of its own.
 */
export function keyOf(
  requestedKey: string | string[],
  options: TOptions & { i18nResolved?: ResolvedTranslation },
  instance: i18n,
): { namespace: string; key: string } | null {
  const resolved = options.i18nResolved;
  const asked = Array.isArray(requestedKey) ? requestedKey[0] : requestedKey;
  if (typeof asked !== 'string' || asked === '') return null;

  const nsSeparator = instance.options.nsSeparator ?? ':';
  let namespace = resolved?.usedNS;
  let key = resolved?.exactUsedKey ?? resolved?.usedKey;

  if (key === undefined) {
    // Nothing was found (the fallback text is showing): name the key asked for.
    key = asked;
    if (typeof nsSeparator === 'string' && key.includes(nsSeparator)) {
      const at = key.indexOf(nsSeparator);
      namespace = key.slice(0, at);
      key = key.slice(at + nsSeparator.length);
    }
  } else if (typeof options.count === 'number') {
    key = key.replace(PLURAL_SUFFIX, '');
  }

  if (namespace === undefined) {
    const requested = options.ns;
    const fallback = instance.options.defaultNS;
    const first = (value: unknown): string | undefined => {
      const item: unknown = Array.isArray(value) ? value[0] : value;
      return typeof item === 'string' && item !== '' ? item : undefined;
    };
    namespace = first(requested) ?? first(fallback) ?? 'translation';
  }
  return key === '' ? null : { namespace, key };
}

function addPostProcess(instance: i18n): void {
  const options = instance.options as { postProcess?: string | string[] | false };
  const current = options.postProcess;
  const list = Array.isArray(current) ? current : current ? [current] : [];
  if (!list.includes(POST_PROCESSOR_NAME)) options.postProcess = [...list, POST_PROCESSOR_NAME];
  // Ask i18next to tell the post-processor which resource it resolved.
  (instance.options as { postProcessPassResolved?: boolean }).postProcessPassResolved = true;
}

let overlay: OverlayHandle | null = null;

/**
 * i18next plugin for editing translations in place.
 *
 * ```ts
 * import { LocalizeInContext } from '@localize-work/i18next-backend/in-context';
 * i18next.use(LocalizeBackend).use(LocalizeInContext).init({ … });
 * ```
 *
 * It does nothing until the page is opened with `?localize=edit`. Then every
 * translated string carries an invisible marker, and clicking a string opens
 * it in the localize.work editor. Text saved there shows on the page at once.
 */
export const LocalizeInContext: ThirdPartyModule = {
  type: '3rdParty',
  init(instance: i18n): void {
    const options = resolveOptions(instance);
    if (!options) return;

    const registry = new MarkerRegistry();
    instance.use({
      type: 'postProcessor',
      name: POST_PROCESSOR_NAME,
      process(value: unknown, key: string | string[], translateOptions: TOptions) {
        if (typeof value !== 'string' || value === '') return value as string;
        const target = keyOf(key, translateOptions, instance);
        if (!target) return value;
        return value + encodeMarker(registry.id(target.namespace, target.key));
      },
    });
    addPostProcess(instance);

    if (typeof document === 'undefined') return;
    overlay?.stop();
    overlay = startOverlay({
      i18next: instance,
      registry,
      projectSlug: options.projectSlug,
      editorUrl: options.editorUrl,
      onExit: () => exitInContext(options.queryParameter),
    });
  },
};

/** Turn editing off for this tab and reload the page without markers. */
export function exitInContext(queryParameter = DEFAULT_QUERY_PARAMETER): void {
  try {
    window.sessionStorage.removeItem(SESSION_FLAG);
  } catch {
    // Nothing to clear when storage is blocked.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(queryParameter);
  window.location.replace(url.toString());
}
