import type { i18n } from 'i18next';
import { hasMarker, markerAt, type MarkedKey, type MarkerRegistry } from './markers.js';

/**
 * The part of in-context editing that lives on the page: a small toolbar, a
 * highlight that follows the pointer over translated text, and the click that
 * opens the string in the editor.
 *
 * The editor opens in its own window rather than an embedded frame: it signs
 * people in with a cookie that browsers do not send to a frame on another
 * site. The two windows talk with postMessage, each checking the other's
 * origin: this page sends "open this key", the editor sends back the text
 * that was saved so the page can show it without a reload.
 */

export const MESSAGE_SOURCE = 'localize-work';
export const EDITOR_WINDOW_NAME = 'localize-work-in-context';
const HOST_ATTRIBUTE = 'data-localize-work-in-context';
/** Attributes that commonly hold translated text. */
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'] as const;
/** How far up from the pointer target to look for marked text. */
const MAX_ANCESTORS = 3;
/** Text nodes inspected under one control before giving up. */
const MAX_TEXT_NODES = 50;
/** Elements whose whole area stands for their label. */
const CONTROL_SELECTOR = 'button, a, label, summary, option, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';

export interface OverlayContext {
  i18next: i18n;
  registry: MarkerRegistry;
  projectSlug: string;
  /** The editor's origin, e.g. https://app.localize.work */
  editorUrl: string;
  /** Called when the person chooses Exit in the toolbar. */
  onExit: () => void;
}

export interface OverlayHandle {
  stop(): void;
}

/** Text the editor reports as saved. */
export interface SavedValue {
  locale: string;
  /** '' for a plain key, else the plural form (one, few, many, other, …) */
  pluralForm: string;
  value: string;
}

interface Hit {
  key: MarkedKey;
  element: Element;
}

interface CaretPoint {
  node: Node;
  offset: number;
}

function caretAt(x: number, y: number): CaretPoint | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** The marked key under the pointer, if any. */
export function findHit(
  target: EventTarget | null,
  x: number,
  y: number,
  registry: MarkerRegistry,
): Hit | null {
  if (!(target instanceof Element)) return null;

  // The text under the pointer names its key most precisely: one element can
  // hold several translated strings.
  const caret = caretAt(x, y);
  if (caret && caret.node.nodeType === Node.TEXT_NODE && target.contains(caret.node)) {
    const marker = markerAt(caret.node.nodeValue ?? '', caret.offset);
    const key = marker ? registry.key(marker.id) : null;
    if (key && caret.node.parentElement) return { key, element: caret.node.parentElement };
  }

  // Otherwise look at the element itself and a few of its ancestors, but only
  // at text that belongs to each directly. Searching a whole subtree would
  // turn a click on empty space in a container into a click on some string
  // far away inside it.
  let element: Element | null = target;
  for (let level = 0; element && level <= MAX_ANCESTORS; level++, element = element.parentElement) {
    for (const attribute of TEXT_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value && hasMarker(value)) {
        const key = registry.key(markerAt(value, 0)!.id);
        if (key) return { key, element };
      }
    }
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const marker = markerAt(node.nodeValue ?? '', 0);
      const key = marker ? registry.key(marker.id) : null;
      if (key) return { key, element };
    }
    // A control is one target: a click on its padding or icon means its label.
    if (element.matches(CONTROL_SELECTOR)) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let seen = 0; seen < MAX_TEXT_NODES; seen++) {
        const node = walker.nextNode();
        if (!node) break;
        const marker = markerAt(node.nodeValue ?? '', 0);
        const key = marker ? registry.key(marker.id) : null;
        if (key) return { key, element: node.parentElement ?? element };
      }
      return null;
    }
  }
  return null;
}

/** The i18next resource name of a saved value: the key, plus its plural suffix. */
export function resourceKey(key: string, pluralForm: string): string {
  return pluralForm ? `${key}_${pluralForm}` : key;
}

/** Put saved text into i18next and ask bound views to render again. */
export function applySavedValues(
  instance: i18n,
  namespace: string,
  key: string,
  values: readonly SavedValue[],
): void {
  let applied = false;
  for (const saved of values) {
    // Cleared text is not shown as empty: the published text stays visible.
    if (typeof saved.value !== 'string' || saved.value === '') continue;
    instance.addResource(saved.locale, namespace, resourceKey(key, saved.pluralForm), saved.value);
    applied = true;
  }
  if (!applied) return;
  // react-i18next and most other bindings render again on this event.
  instance.emit('languageChanged', instance.language);
}

function isSavedValue(value: unknown): value is SavedValue {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.locale === 'string' &&
    typeof item.pluralForm === 'string' &&
    typeof item.value === 'string'
  );
}

const TOOLBAR_CSS = `
  :host { all: initial; }
  .bar {
    position: fixed; z-index: 2147483647; left: 50%; bottom: 16px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px;
    font: 500 13px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #f5f5f4;
    background: #1c1917; border-radius: 999px; box-shadow: 0 6px 24px rgba(0,0,0,.28);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #d97757; }
  .bar[data-mode="browse"] .dot { background: #78716c; }
  button {
    all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px;
    font: inherit; color: inherit; background: #44403c;
  }
  button:hover { background: #57534e; }
  button:focus-visible { outline: 2px solid #d97757; outline-offset: 2px; }
  .box {
    position: fixed; z-index: 2147483646; pointer-events: none; display: none;
    border: 2px solid #d97757; border-radius: 4px; background: rgba(217,119,87,.08);
  }
  .label {
    position: absolute; left: -2px; bottom: 100%; margin-bottom: 2px; padding: 2px 6px;
    max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff;
    background: #d97757; border-radius: 3px;
  }
`;

export function startOverlay(context: OverlayContext): OverlayHandle {
  const { i18next, registry, projectSlug, editorUrl } = context;
  let editing = true;
  let editor: Window | null = null;
  let editorReady = false;
  let frame = 0;

  const host = document.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, '');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = TOOLBAR_CSS;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Translation editing');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const status = document.createElement('span');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = 'Exit';
  exit.title = 'Turn translation editing off';
  const box = document.createElement('div');
  box.className = 'box';
  const label = document.createElement('span');
  label.className = 'label';
  box.append(label);
  bar.append(dot, status, toggle, exit);
  root.append(style, bar, box);

  function renderMode(): void {
    bar.dataset.mode = editing ? 'edit' : 'browse';
    status.textContent = editing ? 'Click any text to translate it' : 'Editing paused';
    toggle.textContent = editing ? 'Pause' : 'Resume';
    toggle.title = editing
      ? 'Use the page normally for a moment'
      : 'Click text to translate it again';
    if (!editing) box.style.display = 'none';
  }

  function ownEvent(event: Event): boolean {
    return event.composedPath().includes(host);
  }

  function highlight(hit: Hit | null): void {
    if (!hit) {
      box.style.display = 'none';
      return;
    }
    const rect = hit.element.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${rect.left - 3}px`;
    box.style.top = `${rect.top - 3}px`;
    box.style.width = `${rect.width + 6}px`;
    box.style.height = `${rect.height + 6}px`;
    label.textContent = `${hit.key.namespace}:${hit.key.key}`;
  }

  function onMove(event: MouseEvent): void {
    if (!editing || ownEvent(event)) return;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      highlight(findHit(event.target, event.clientX, event.clientY, registry));
    });
  }

  function openEditor(key: MarkedKey): void {
    const locale = i18next.resolvedLanguage ?? i18next.language;
    const request = { project: projectSlug, namespace: key.namespace, key: key.key, locale };
    if (editor && !editor.closed && editorReady) {
      // The editor is open: switch it to this key without reloading it.
      editor.postMessage({ source: MESSAGE_SOURCE, type: 'open', ...request }, editorUrl);
      editor.focus();
      return;
    }
    const url = new URL('/in-context', editorUrl);
    url.searchParams.set('project', request.project);
    url.searchParams.set('ns', request.namespace);
    url.searchParams.set('key', request.key);
    url.searchParams.set('locale', request.locale);
    url.searchParams.set('origin', window.location.origin);
    editorReady = false;
    editor = window.open(url.toString(), EDITOR_WINDOW_NAME, 'popup=yes,width=480,height=780');
    if (!editor) {
      status.textContent = 'Allow pop-ups for this site to open the editor';
    }
  }

  function onClick(event: MouseEvent): void {
    if (!editing || ownEvent(event)) return;
    const hit = findHit(event.target, event.clientX, event.clientY, registry);
    if (!hit) return;
    // The click edits the text instead of following the link or pressing the button.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openEditor(hit.key);
  }

  function onMessage(event: MessageEvent): void {
    // Only the editor may change what this page shows.
    if (event.origin !== editorUrl) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || data.source !== MESSAGE_SOURCE) return;
    if (data.type === 'ready') {
      if (event.source && event.source === editor) editorReady = true;
      return;
    }
    if (data.type !== 'translations') return;
    if (data.project !== projectSlug) return;
    if (typeof data.namespace !== 'string' || typeof data.key !== 'string') return;
    if (!Array.isArray(data.values)) return;
    applySavedValues(i18next, data.namespace, data.key, data.values.filter(isSavedValue));
  }

  function onScroll(): void {
    box.style.display = 'none';
  }

  toggle.addEventListener('click', () => {
    editing = !editing;
    renderMode();
  });
  exit.addEventListener('click', () => context.onExit());

  renderMode();
  const mount = () => document.body.append(host);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  // Capture phase: decide before the page's own handlers see the click.
  document.addEventListener('click', onClick, true);
  document.addEventListener('mousemove', onMove, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('message', onMessage);

  return {
    stop() {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('DOMContentLoaded', mount);
      host.remove();
    },
  };
}
