import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstance, type i18n } from 'i18next';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  encodeMarker,
  findMarkers,
  hasMarker,
  markerAt,
  MarkerRegistry,
  stripMarkers,
} from './markers.js';
import { applySavedValues, findHit, MESSAGE_SOURCE, resourceKey, startOverlay } from './overlay.js';
import { exitInContext, keyOf, LocalizeInContext, SESSION_FLAG } from './plugin.js';

const resources = {
  en: {
    common: {
      title: 'Welcome',
      greeting: 'Hello {{name}}',
      items_one: '{{count}} item',
      items_other: '{{count}} items',
      friend_male: 'A boyfriend',
      season_one: 'Season one',
      stage_one: 'Stage one',
      nested: 'See $t(title)',
      nav: { home: 'Home' },
    },
    billing: { title: 'Billing' },
  },
  et: { common: { title: 'Tere tulemast' } },
};

async function instance(options: Record<string, unknown> = {}): Promise<i18n> {
  const i18next = createInstance();
  await i18next.use(LocalizeInContext).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['common', 'billing'],
    defaultNS: 'common',
    resources,
    backend: { projectSlug: 'shop' },
    ...options,
  });
  return i18next;
}

/** The (namespace, key) pairs marked in a text, by replaying the registry order. */
function ids(text: string): number[] {
  return findMarkers(text).map((marker) => marker.id);
}

// ---------------------------------------------------------------- markers

test('a marker round-trips its number and draws as nothing', () => {
  for (const id of [0, 1, 3, 4, 5, 255, 256, 1_000_000]) {
    const marker = encodeMarker(id);
    assert.deepEqual(findMarkers(`text${marker}`), [{ id, index: 4 }]);
    assert.match(marker, /^[⁠-⁤]+$/);
  }
  assert.throws(() => encodeMarker(-1), RangeError);
  assert.throws(() => encodeMarker(1.5), RangeError);
});

test('markers are found by position and removed without touching the text', () => {
  const text = `Hello${encodeMarker(7)} world${encodeMarker(9)}!`;
  assert.equal(stripMarkers(text), 'Hello world!');
  assert.equal(hasMarker(text), true);
  assert.equal(hasMarker('Hello world!'), false);
  assert.equal(markerAt(text, 2)!.id, 7);
  // Past the first marker, the text belongs to the next one.
  assert.equal(markerAt(text, 12)!.id, 9);
  // After the last marker there is no later one; the last is the best guess.
  assert.equal(markerAt(text, text.length)!.id, 9);
  assert.equal(markerAt('plain', 0), null);
  // A lone frame character, as other software may insert, is not a marker.
  assert.deepEqual(findMarkers('a⁠b'), []);
});

test('the registry gives each key one number', () => {
  const registry = new MarkerRegistry();
  assert.equal(registry.id('common', 'title'), 0);
  assert.equal(registry.id('billing', 'title'), 1);
  assert.equal(registry.id('common', 'title'), 0);
  assert.deepEqual(registry.key(1), { namespace: 'billing', key: 'title' });
  assert.equal(registry.key(99), null);
});

// ----------------------------------------------------------------- plugin

test('without a browser the plugin stays off unless it is forced on', async () => {
  const off = await instance();
  assert.equal(off.t('title'), 'Welcome');
  const refused = await instance({ localizeInContext: { enabled: false } });
  assert.equal(refused.t('title'), 'Welcome');
});

test('when on, every translated string carries a marker for the key it came from', async () => {
  const i18next = await instance({ localizeInContext: { enabled: true } });
  const title = i18next.t('title');
  assert.notEqual(title, 'Welcome');
  assert.equal(stripMarkers(title), 'Welcome');
  assert.equal(stripMarkers(i18next.t('greeting', { name: 'Mari' })), 'Hello Mari');

  // The same key always gets the same marker; another key or namespace does not.
  assert.deepEqual(ids(i18next.t('title')), ids(title));
  assert.notDeepEqual(ids(i18next.t('title', { ns: 'billing' })), ids(title));
  assert.notDeepEqual(ids(i18next.t('nav.home')), ids(title));

  // Both plural forms belong to the one key "items".
  assert.deepEqual(ids(i18next.t('items', { count: 1 })), ids(i18next.t('items', { count: 5 })));
  // i18next does not post-process a nested $t(): the text carries the one
  // marker of the key that includes it.
  const nested = i18next.t('nested');
  assert.equal(stripMarkers(nested), 'See Welcome');
  assert.equal(ids(nested).length, 1);
  assert.notDeepEqual(ids(nested), ids(title));
  // Each text inside a returned object is marked for its own key.
  const nav = i18next.t('nav', { returnObjects: true }) as { home: string };
  assert.equal(stripMarkers(nav.home), 'Home');
  assert.deepEqual(ids(nav.home), ids(i18next.t('nav.home')));
});

test('a marker names the project key, not the resource i18next happened to read', async () => {
  const i18next = await instance({ localizeInContext: { enabled: true } });
  // An ordinary key whose name ends like a plural form keeps its name, even
  // when the call passes a count.
  assert.deepEqual(ids(i18next.t('season_one', { count: 1 })), ids(i18next.t('season_one')));
  assert.notDeepEqual(ids(i18next.t('season_one')), ids(i18next.t('items', { count: 1 })));
  // A context is part of the key's name.
  const male = i18next.t('friend', { context: 'male' });
  assert.equal(stripMarkers(male), 'A boyfriend');
  assert.deepEqual(ids(male), ids(i18next.t('friend_male')));
  // A context that reads like a plural form is still the context: with a
  // count of 2 the plural suffix would be "_other", so "_one" is not it.
  assert.deepEqual(ids(i18next.t('stage', { context: 'one', count: 2 })), ids(i18next.t('stage_one')));
  // A call that names its language is a different thing to edit.
  assert.notDeepEqual(ids(i18next.t('title', { lng: 'et' })), ids(i18next.t('title')));
  assert.equal(stripMarkers(i18next.t('title', { lng: 'et' })), 'Tere tulemast');
});

test('an existing postProcess setting is kept', async () => {
  const i18next = createInstance();
  await i18next
    .use({ type: 'postProcessor', name: 'shout', process: (value: string) => value.toUpperCase() })
    .use(LocalizeInContext)
    .init({
      lng: 'en',
      resources,
      defaultNS: 'common',
      postProcess: 'shout',
      localizeInContext: { enabled: true, projectSlug: 'shop' },
    } as never);
  const title = i18next.t('title');
  assert.equal(stripMarkers(title), 'WELCOME');
  assert.equal(hasMarker(title), true);
});

test('the plugin stays off, with a warning, when it cannot tell the project', async () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args[0]);
  try {
    const i18next = await instance({ backend: undefined, localizeInContext: { enabled: true } });
    assert.equal(i18next.t('title'), 'Welcome');
    assert.match(String(warnings[0]), /projectSlug/);
    const badUrl = await instance({ localizeInContext: { enabled: true, editorUrl: 'not a url' } });
    assert.equal(badUrl.t('title'), 'Welcome');
  } finally {
    console.warn = original;
  }
});

test('a key that is not found is named in the namespace that was asked for', async () => {
  const seen: unknown[] = [];
  const i18next = createInstance();
  await i18next
    .use({
      type: 'postProcessor',
      name: 'capture',
      process(value: string, key: string | string[], options: never) {
        const target = keyOf(key, options, i18next);
        seen.push(target && { namespace: target.namespace, key: target.key });
        return value;
      },
    })
    .init({
      lng: 'en',
      ns: ['common', 'billing'],
      defaultNS: 'common',
      // i18next tries the fallback namespace last and reports it as "used".
      fallbackNS: 'billing',
      resources,
      postProcess: ['capture'],
      postProcessPassResolved: true,
    });
  i18next.t('newKey');
  i18next.t('billing:other.new');
  i18next.t('title');
  assert.deepEqual(seen, [
    { namespace: 'common', key: 'newKey' },
    { namespace: 'billing', key: 'other.new' },
    { namespace: 'common', key: 'title' },
  ]);
});

// ---------------------------------------------------------------- overlay

interface Page {
  dom: JSDOM;
  popup: JSDOM;
  opened: string[];
  posted: unknown[];
  i18next: i18n;
  registry: MarkerRegistry;
  exits: number;
  stop: () => void;
}

const GLOBALS = [
  'window',
  'document',
  'Node',
  'NodeFilter',
  'Element',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

/** A page with one marked heading and button, and the overlay running on it. */
async function page(language = 'et'): Promise<Page> {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://shop.example/cart',
    pretendToBeVisual: true,
  });
  const popup = new JSDOM('', { url: 'https://app.localize.work/in-context' });
  const saved = new Map<string, unknown>();
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name];
  }

  const i18next = createInstance();
  await i18next.init({ lng: language, fallbackLng: 'en', defaultNS: 'common', resources });
  const registry = new MarkerRegistry();
  const mark = (namespace: string, key: string) => encodeMarker(registry.id(namespace, key));
  dom.window.document.body.innerHTML = `
    <h1 id="title">Tere tulemast${mark('common', 'title')}</h1>
    <button id="pay"><span id="inner">Billing${mark('billing', 'title')}</span></button>
    <input id="search" placeholder="Search${mark('common', 'search')}">
    <p id="other-language">Tere${encodeMarker(registry.id('common', 'title', 'et'))}</p>
    <p id="plain">No translation here</p>
    <div id="card"><section><h2>Cart${mark('common', 'cart')}</h2></section></div>`;

  const state: Page = {
    dom,
    popup,
    opened: [],
    posted: [],
    i18next,
    registry,
    exits: 0,
    stop: () => {},
  };
  dom.window.open = ((url: string) => {
    state.opened.push(url);
    return popup.window;
  }) as never;
  popup.window.postMessage = ((message: unknown, origin: string) => {
    state.posted.push([message, origin]);
  }) as never;
  popup.window.focus = () => {};

  const overlay = startOverlay({
    i18next,
    registry,
    projectSlug: 'shop',
    editorUrl: 'https://app.localize.work',
    onExit: () => {
      state.exits += 1;
    },
  });
  let stopped = false;
  state.stop = () => {
    if (stopped) return;
    stopped = true;
    overlay.stop();
    for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
  };
  return state;
}

function click(state: Page, id: string): Event {
  const event = new state.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  state.dom.window.document.getElementById(id)!.dispatchEvent(event);
  return event;
}

function message(state: Page, origin: string, data: unknown, fromPopup = true): void {
  state.dom.window.dispatchEvent(
    new state.dom.window.MessageEvent('message', {
      origin,
      data,
      source: fromPopup ? (state.popup.window as never) : null,
    }),
  );
}

test('clicking translated text opens its key in the editor instead of acting on the page', async () => {
  const state = await page();
  try {
    let pressed = 0;
    state.dom.window.document.getElementById('pay')!.addEventListener('click', () => {
      pressed += 1;
    });
    const event = click(state, 'title');
    assert.equal(event.defaultPrevented, true);
    const url = new URL(state.opened[0]!);
    assert.equal(url.origin + url.pathname, 'https://app.localize.work/in-context');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      project: 'shop',
      ns: 'common',
      key: 'title',
      locale: 'et',
      origin: 'https://shop.example',
    });

    // A click inside a button edits its text; the button is not pressed.
    click(state, 'inner');
    assert.equal(pressed, 0);
    assert.equal(new URL(state.opened[1]!).searchParams.get('ns'), 'billing');
    // So does a click on the button's own padding.
    click(state, 'pay');
    assert.equal(new URL(state.opened.pop()!).searchParams.get('ns'), 'billing');
    assert.equal(pressed, 0);
    // Empty space in a container is not a click on the text inside it.
    assert.equal(click(state, 'card').defaultPrevented, false);
    // Text in an attribute is found too.
    click(state, 'search');
    assert.equal(new URL(state.opened[2]!).searchParams.get('key'), 'search');
    // Text that is not a translation behaves normally.
    assert.equal(click(state, 'plain').defaultPrevented, false);
    assert.equal(state.opened.length, 3);
  } finally {
    state.stop();
  }
});

test('the editor opens the language the app is set to, not the one a text fell back to', async () => {
  // No en-GB resources: every text falls back to en.
  const state = await page('en-GB');
  try {
    assert.equal(state.i18next.resolvedLanguage, 'en');
    click(state, 'title');
    assert.equal(new URL(state.opened[0]!).searchParams.get('locale'), 'en-GB');
    // A text rendered with an explicit language opens that language.
    click(state, 'other-language');
    assert.equal(new URL(state.opened[1]!).searchParams.get('locale'), 'et');
  } finally {
    state.stop();
  }
});

test('once the editor is open, further clicks switch it to the new key without reloading', async () => {
  const state = await page();
  try {
    click(state, 'title');
    // A page that is not the editor cannot claim to be ready.
    message(state, 'https://evil.example', { source: MESSAGE_SOURCE, type: 'ready' });
    click(state, 'inner');
    assert.equal(state.opened.length, 2);

    message(state, 'https://app.localize.work', { source: MESSAGE_SOURCE, type: 'ready' });
    click(state, 'title');
    assert.equal(state.opened.length, 2);
    assert.deepEqual(state.posted, [
      [
        { source: MESSAGE_SOURCE, type: 'open', project: 'shop', namespace: 'common', key: 'title', locale: 'et' },
        'https://app.localize.work',
      ],
    ]);
  } finally {
    state.stop();
  }
});

test('text saved in the editor shows on the page; other senders are ignored', async () => {
  const state = await page();
  try {
    let renders = 0;
    state.i18next.on('languageChanged', () => {
      renders += 1;
    });
    const saved = {
      source: MESSAGE_SOURCE,
      type: 'translations',
      project: 'shop',
      namespace: 'common',
      key: 'items',
      values: [
        { locale: 'et', pluralForm: 'one', value: '{{count}} asi' },
        { locale: 'et', pluralForm: 'other', value: '{{count}} asja' },
        { locale: 'et', pluralForm: 'few', value: '' },
        { locale: 'et', pluralForm: 'many' },
      ],
    };
    // Wrong origin, wrong project and a foreign message shape change nothing.
    message(state, 'https://evil.example', saved);
    message(state, 'https://app.localize.work', { ...saved, project: 'other' });
    message(state, 'https://app.localize.work', { ...saved, source: 'someone-else' });
    message(state, 'https://app.localize.work', 'not an object');
    assert.equal(state.i18next.t('items', { count: 3 }), '3 items');
    assert.equal(renders, 0);

    message(state, 'https://app.localize.work', saved);
    assert.equal(state.i18next.t('items', { count: 1 }), '1 asi');
    assert.equal(state.i18next.t('items', { count: 3 }), '3 asja');
    assert.equal(renders, 1);
    // An empty value does not blank the text that is showing.
    assert.equal(state.i18next.exists('items_few', { lng: 'et', fallbackLng: [] }), false);
  } finally {
    state.stop();
  }
});

test('pausing lets the page work normally, and Exit hands control back', async () => {
  const state = await page();
  try {
    const host = state.dom.window.document.querySelector('[data-localize-work-in-context]')!;
    const [toggle, exit] = [...host.shadowRoot!.querySelectorAll('button')];
    assert.equal(toggle!.textContent, 'Pause');
    toggle!.click();
    assert.equal(toggle!.textContent, 'Resume');
    assert.equal(click(state, 'title').defaultPrevented, false);
    assert.equal(state.opened.length, 0);
    toggle!.click();
    assert.equal(click(state, 'title').defaultPrevented, true);

    // The toolbar's own clicks are never treated as clicks on page text.
    exit!.click();
    assert.equal(state.exits, 1);
    assert.equal(state.opened.length, 1);

    const document = state.dom.window.document;
    state.stop();
    assert.equal(document.querySelector('[data-localize-work-in-context]'), null);
    assert.equal(click(state, 'title').defaultPrevented, false);
  } finally {
    state.stop();
  }
});

test('findHit prefers the key of the text under the pointer', async () => {
  const state = await page();
  try {
    const document = state.dom.window.document;
    const paragraph = document.createElement('p');
    paragraph.textContent = `One${encodeMarker(state.registry.id('a', 'one'))} two${encodeMarker(state.registry.id('a', 'two'))}`;
    document.body.append(paragraph);
    const text = paragraph.firstChild!;
    (document as unknown as Record<string, unknown>).caretPositionFromPoint = () => ({
      offsetNode: text,
      offset: text.nodeValue!.indexOf('two'),
    });
    assert.deepEqual(findHit(paragraph, 10, 10, state.registry)?.key, { namespace: 'a', key: 'two' });
    (document as unknown as Record<string, unknown>).caretPositionFromPoint = () => null;
    // Without a caret position, the first marked text in the element.
    assert.deepEqual(findHit(paragraph, 10, 10, state.registry)?.key, { namespace: 'a', key: 'one' });
    assert.equal(findHit(null, 0, 0, state.registry), null);
  } finally {
    state.stop();
  }
});

test('saved values are stored under i18next resource names', async () => {
  assert.equal(resourceKey('items', 'other'), 'items_other');
  assert.equal(resourceKey('nav.home', ''), 'nav.home');
  const i18next = await instance();
  applySavedValues(i18next, 'common', 'nav.home', [{ locale: 'en', pluralForm: '', value: 'Start' }]);
  assert.equal(i18next.t('nav.home'), 'Start');
});

test('opening the page with ?localize=edit turns editing on for the tab', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://shop.example/?localize=edit',
    // Exit reloads the page, which jsdom reports as not implemented.
    virtualConsole: new VirtualConsole(),
  });
  const saved = new Map<string, unknown>();
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name];
  }
  try {
    const i18next = await instance();
    assert.equal(hasMarker(i18next.t('title')), true);
    assert.equal(dom.window.sessionStorage.getItem(SESSION_FLAG), '1');
    assert.ok(dom.window.document.querySelector('[data-localize-work-in-context]'));
    // A later page in the same tab stays in editing mode without the parameter.
    dom.reconfigure({ url: 'https://shop.example/cart' });
    assert.equal(hasMarker((await instance()).t('title')), true);
    // ?localize=off ends it.
    dom.reconfigure({ url: 'https://shop.example/cart?localize=off' });
    assert.equal(hasMarker((await instance()).t('title')), false);
    assert.equal(dom.window.sessionStorage.getItem(SESSION_FLAG), '0');
    dom.reconfigure({ url: 'https://shop.example/cart' });
    assert.equal(hasMarker((await instance()).t('title')), false);

    // `enabled: true` is on without the parameter, but Exit must still end
    // it: the choice is remembered, so the reload does not turn it back on.
    dom.window.sessionStorage.clear();
    const forced = { localizeInContext: { enabled: true } };
    assert.equal(hasMarker((await instance(forced)).t('title')), true);
    exitInContext();
    assert.equal(dom.window.sessionStorage.getItem(SESSION_FLAG), '0');
    assert.equal(hasMarker((await instance(forced)).t('title')), false);
    dom.reconfigure({ url: 'https://shop.example/cart?localize=edit' });
    assert.equal(hasMarker((await instance(forced)).t('title')), true);
    dom.reconfigure({ url: 'https://shop.example/cart?localize=off' });
    assert.equal(hasMarker((await instance(forced)).t('title')), false);

    // With storage blocked, the parameter still turns editing on for the page.
    Object.defineProperty(dom.window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage is blocked');
      },
    });
    dom.reconfigure({ url: 'https://shop.example/cart?localize=edit' });
    assert.equal(hasMarker((await instance()).t('title')), true);
    dom.reconfigure({ url: 'https://shop.example/cart' });
    assert.equal(hasMarker((await instance()).t('title')), false);
  } finally {
    for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
  }
});
