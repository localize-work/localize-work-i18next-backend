import type { i18n, ThirdPartyModule, TOptions } from 'i18next';
import { encodeMarker, MarkerRegistry } from './markers.js';
import { startOverlay, type OverlayHandle } from './overlay.js';

const PREFIX = '[@localize-work/i18next-backend/in-context]';
export const POST_PROCESSOR_NAME = 'localizeInContext';
export const DEFAULT_EDITOR_URL = 'https://app.localize.work';
export const DEFAULT_QUERY_PARAMETER = 'localize';
/**
 * sessionStorage key that remembers the visitor's choice while the tab
 * navigates: '1' after `?localize=edit`, '0' after Exit or `?localize=off`.
 */
export const SESSION_FLAG = 'localize-work:in-context';

export interface LocalizeInContextOptions {
  /** The project's slug. Defaults to `backend.projectSlug`. */
  projectSlug?: string;
  /** Where the editor runs. Defaults to https://app.localize.work. */
  editorUrl?: string;
  /**
   * Whether editing is on. By default it turns on when the page is opened
   * with `?localize=edit` and stays on for that browser tab. Pass `false` to
   * switch the feature off entirely (e.g. in production). Pass `true` to have
   * it on without the parameter; Exit and `?localize=off` still turn it off
   * for the tab, and `?localize=edit` turns it back on.
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

/**
 * What the visitor chose for this tab: the address parameter, else what the
 * tab remembers from an earlier page. null when they chose nothing.
 */
function visitorChoice(queryParameter: string): 'on' | 'off' | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get(queryParameter);
  const fromAddress = value === 'edit' ? 'on' : value === 'off' ? 'off' : null;
  try {
    if (fromAddress === null) {
      const remembered = window.sessionStorage.getItem(SESSION_FLAG);
      return remembered === '1' ? 'on' : remembered === '0' ? 'off' : null;
    }
    window.sessionStorage.setItem(SESSION_FLAG, fromAddress === 'on' ? '1' : '0');
  } catch {
    // Storage can be blocked; the query parameter alone then decides, and
    // the choice lasts for this page instead of the whole tab.
  }
  return fromAddress;
}

function resolveOptions(instance: i18n): ResolvedInContextOptions | null {
  const raw = (instance.options as { localizeInContext?: LocalizeInContextOptions })
    .localizeInContext;
  const options = raw ?? {};
  if (options.enabled === false) return null;
  // Editing happens in a browser. On a server (server rendering, a script)
  // the plugin stays off even with `enabled: true`: markers must not reach
  // emails, API responses or stored text, and a server that creates an
  // i18next instance per request must not have each one kept for the page.
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const queryParameter = options.queryParameter ?? DEFAULT_QUERY_PARAMETER;
  const choice = visitorChoice(queryParameter);
  // `enabled: true` is on unless the visitor left; otherwise on when they asked.
  const enabled = options.enabled === true ? choice !== 'off' : choice === 'on';
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
  /** The text i18next found; undefined when it found none. */
  res?: unknown;
  usedKey?: string;
  exactUsedKey?: string;
  usedNS?: string;
  usedLng?: string;
}

/**
 * The suffixes i18next adds to a key for this count: the plural form of the
 * language (`_other`), and `_zero` for a count of 0. null when this i18next
 * cannot say.
 */
function pluralSuffixes(instance: i18n, language: string, count: number): string[] | null {
  const separator = instance.options.pluralSeparator ?? '_';
  try {
    const resolver = (instance.services as { pluralResolver?: unknown } | undefined)
      ?.pluralResolver as { getSuffix?: (code: string, count: number) => unknown } | undefined;
    const suffix = resolver?.getSuffix?.(language, count);
    if (typeof suffix !== 'string' || suffix === '') return null;
    return count === 0 ? [suffix, `${separator}zero`] : [suffix];
  } catch {
    return null;
  }
}

/**
 * The project key a translated string came from. i18next reports the key it
 * resolved (`usedKey`, e.g. `items`) and the exact resource it read
 * (`exactUsedKey`, e.g. `items_other`). The project stores one key `items`
 * with a text per plural form, so the plural suffix i18next added is dropped.
 * A suffix that is part of the key's own name (`season_one`) is kept, and a
 * context suffix (`friend_male`) is a key of its own.
 */
export function keyOf(
  requestedKey: string | string[],
  options: TOptions & { i18nResolved?: ResolvedTranslation },
  instance: i18n,
): { namespace: string; key: string; language?: string } | null {
  const resolved = options.i18nResolved;
  const asked = Array.isArray(requestedKey) ? requestedKey[0] : requestedKey;
  if (typeof asked !== 'string' || asked === '') return null;

  const nsSeparator = instance.options.nsSeparator ?? ':';
  // i18next names the last key and namespace it tried even when it found
  // nothing, and that namespace can be a fallback one. Trust them only for a
  // text that was found.
  const found = resolved !== undefined && resolved.res !== undefined;
  let namespace = found ? resolved.usedNS : undefined;
  let key = found ? (resolved.exactUsedKey ?? resolved.usedKey) : undefined;

  if (key === undefined) {
    // Nothing was found (the fallback text is showing): name the key asked for.
    key = asked;
    if (typeof nsSeparator === 'string' && key.includes(nsSeparator)) {
      const at = key.indexOf(nsSeparator);
      namespace = key.slice(0, at);
      key = key.slice(at + nsSeparator.length);
    }
  } else if (
    typeof options.count === 'number' &&
    !options.ordinal &&
    resolved?.exactUsedKey !== undefined &&
    resolved.exactUsedKey !== resolved.usedKey
  ) {
    // i18next read a suffixed resource for a shorter key. The suffix is the
    // plural form only when it is the one i18next adds for this count; with a
    // context it can be the context instead (`stage_one` for context "one").
    const language = resolved.usedLng ?? instance.resolvedLanguage ?? instance.language;
    const suffixes = pluralSuffixes(instance, language, options.count);
    if (suffixes === null) {
      key = key.replace(PLURAL_SUFFIX, '');
    } else {
      const suffix = suffixes.find((candidate) => key!.endsWith(candidate));
      if (suffix !== undefined) key = key.slice(0, -suffix.length);
    }
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
  if (key === '') return null;
  // A call that names its language (`t(key, { lng })`) shows that language,
  // whatever the app's own language is.
  const language = typeof options.lng === 'string' && options.lng !== '' ? options.lng : undefined;
  return language ? { namespace, key, language } : { namespace, key };
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
 * State for the whole page. i18next keeps post-processors by name for every
 * instance at once, and markers stay in the page's text after the instance
 * that wrote them is replaced. So there is one registry, whose numbers stay
 * valid whichever instance wrote them, and one project: a marker carries no
 * project, and the toolbar opens strings in a single one.
 */
const pageRegistry = new MarkerRegistry();
let pageProject: string | null = null;
/** The i18next instance behind each options object a translator hands over. */
const instances = new WeakMap<object, i18n>();
/** Every instance that turned editing on; saved text is shown in each. */
const pageInstances = new Set<i18n>();

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
    if (pageProject !== null && pageProject !== options.projectSlug) {
      // A second project's strings would open under the first one's name.
      console.warn(
        `${PREFIX} editing is already on for project "${pageProject}"; ` +
          `it stays off for "${options.projectSlug}" (one project per page)`,
      );
      return;
    }
    pageProject = options.projectSlug;
    instances.set(instance.options, instance);
    pageInstances.add(instance);

    const registry = pageRegistry;
    instance.use({
      type: 'postProcessor',
      name: POST_PROCESSOR_NAME,
      process(
        value: unknown,
        key: string | string[],
        translateOptions: TOptions,
        translator?: { options?: object },
      ) {
        if (typeof value !== 'string' || value === '') return value as string;
        // The processor serves every instance that turned editing on; read
        // the settings of the one that is translating.
        const owner = (translator?.options && instances.get(translator.options)) || instance;
        const target = keyOf(key, translateOptions, owner);
        if (!target) return value;
        // Without a language of its own, the call shows the language of the
        // instance that drew it. Several instances on a page can differ, so
        // the marker says which: a click then opens the language it shows.
        const language =
          target.language ??
          (typeof owner.language === 'string' && owner.language !== '' ? owner.language : undefined);
        return value + encodeMarker(registry.id(target.namespace, target.key, language));
      },
    });
    addPostProcess(instance);

    overlay?.stop();
    overlay = startOverlay({
      i18next: instance,
      registry,
      projectSlug: options.projectSlug,
      editorUrl: options.editorUrl,
      onExit: () => exitInContext(options.queryParameter),
      instances: () => pageInstances,
    });
  },
};

/** Turn editing off for this tab and reload the page without markers. */
export function exitInContext(queryParameter = DEFAULT_QUERY_PARAMETER): void {
  const url = new URL(window.location.href);
  try {
    // Remembered as a choice, so that `enabled: true` does not turn editing
    // straight back on when the page reloads.
    window.sessionStorage.setItem(SESSION_FLAG, '0');
    url.searchParams.delete(queryParameter);
  } catch {
    // Storage is blocked: the address has to carry the choice.
    url.searchParams.set(queryParameter, 'off');
  }
  window.location.replace(url.toString());
}
