import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test, { afterEach, type TestContext } from 'node:test';
import i18next, { type i18n, type InitOptions, type Services } from 'i18next';
import { JSDOM } from 'jsdom';
import { LocalizeBackend } from './backend.js';
import type { LocalizeBackendOptions, TrackUsageOptions } from './options.js';
import {
  resetUsageTracking,
  USAGE_REQUEST_TIMEOUT_MS,
  UsageTracker,
  utf8Length,
} from './usage.js';

const CDN = 'https://cdn.localize.work';
const API = 'https://api.localize.work';

const RESOURCES: Record<string, Record<string, Record<string, unknown>>> = {
  en: {
    common: {
      items_one: '{{count}} item',
      items_other: '{{count}} items',
      a: { b: 'A and B' },
      onlyEn: 'Only in English',
    },
    admin: { title: 'Admin' },
  },
  et: {
    common: { items_one: '{{count}} asi', items_other: '{{count}} asja', a: { b: 'A ja B' } },
    admin: { title: 'Haldus' },
  },
};

const devOptions = {
  projectSlug: 'doc-in-pocket',
  cdnBaseUrl: CDN,
  version: 'v1',
  apiBaseUrl: API,
  apiKey: 'pk_test_123',
} satisfies LocalizeBackendOptions;

interface UsageCall {
  url: string;
  names: string[];
  init: RequestInit;
}

const realFetch = globalThis.fetch;
const savedGlobals = new Map<string, unknown>();

afterEach(() => {
  resetUsageTracking();
  globalThis.fetch = realFetch;
  for (const [name, value] of savedGlobals) {
    (globalThis as Record<string, unknown>)[name] = value;
  }
  savedGlobals.clear();
});

/** Serve the CDN files; answer usage POSTs with `usage` and record them. */
function mockFetch(usage: (call: UsageCall) => Response = () => ok()): UsageCall[] {
  const calls: UsageCall[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(CDN)) {
      const [language, file] = url.split('/').slice(-2) as [string, string];
      const data = RESOURCES[language]?.[file.replace(/\.json$/, '')];
      return data ? json(data) : new Response('not found', { status: 404 });
    }
    const call = { url, names: JSON.parse(String(init?.body)) as string[], init: init ?? {} };
    calls.push(call);
    return usage(call);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function ok(): Response {
  return json({ recorded: 1, unknown: 0 });
}

async function makeI18n(trackUsage: boolean | TrackUsageOptions = true): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.use(LocalizeBackend).init({
    lng: 'et',
    fallbackLng: 'en',
    ns: ['common', 'admin'],
    defaultNS: 'common',
    backend: { ...devOptions, trackUsage },
  });
  return instance;
}

interface Store {
  getResource: (...args: unknown[]) => unknown;
  data: Record<string, Record<string, Record<string, unknown>>>;
}

/** i18next's typings leave getResource off ResourceStore. */
function storeOf(instance: i18n): Store {
  return instance.services.resourceStore as unknown as Store;
}

/** Fake timers from here on; real ones still settle promises. */
function useFakeTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await settle();
}

function silenceWarnings(t: TestContext): unknown[][] {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  return warnings;
}

/** Make a jsdom page at `url` the browser these calls run in. */
function useBrowser(url: string): JSDOM {
  const dom = new JSDOM('<!doctype html><body></body>', { url });
  for (const name of ['window', 'document']) {
    if (!savedGlobals.has(name)) savedGlobals.set(name, (globalThis as Record<string, unknown>)[name]);
  }
  (globalThis as Record<string, unknown>).window = dom.window;
  (globalThis as Record<string, unknown>).document = dom.window.document;
  return dom;
}

// --- recording --------------------------------------------------------------

test('reports keys exactly as i18next looks them up, one POST per namespace', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  useFakeTimers(t);

  assert.equal(instance.t('items', { count: 2 }), '2 asja');
  assert.equal(instance.t('items', { count: 1 }), '1 asi');
  assert.equal(instance.t('a.b'), 'A ja B');
  assert.equal(instance.t('onlyEn'), 'Only in English', 'falls back to en');
  assert.equal(instance.t('admin:title'), 'Haldus');
  await settle();
  assert.equal(calls.length, 0, 'nothing is sent before the interval');

  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => [call.url, call.names]),
    [
      [`${API}/public/projects/doc-in-pocket/used/common`, ['items_other', 'items_one', 'a.b', 'onlyEn']],
      [`${API}/public/projects/doc-in-pocket/used/admin`, ['title']],
    ],
  );
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(calls[0]!.init.headers, {
    Authorization: 'Bearer pk_test_123',
    'Content-Type': 'application/json',
  });
  assert.equal(calls[0]!.init.keepalive, undefined);
});

test('the wrapped getResource returns what the original returns', async () => {
  mockFetch();
  const plain = await makeI18n(false);
  const tracked = await makeI18n();
  const store = storeOf(tracked);
  assert.notEqual(store.getResource, storeOf(plain).getResource);
  for (const args of [
    ['et', 'common', 'a.b'],
    ['et', 'common', 'a'],
    ['et', 'common'],
    ['en', 'admin', 'missing'],
  ] as const) {
    assert.deepEqual(
      store.getResource(...args),
      storeOf(plain).getResource(...args),
    );
  }
  assert.equal(store.getResource('et', 'common', 'a'), store.data.et!.common!.a, 'same object');
});

test('each key is sent once per page, and nothing is sent when nothing is new', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  useFakeTimers(t);

  for (let i = 0; i < 5; i++) instance.t('a.b');
  await advance(t, 30_000);
  instance.t('a.b');
  instance.t('onlyEn');
  await advance(t, 30_000);
  instance.t('a.b');
  await advance(t, 60_000);

  assert.deepEqual(
    calls.map((call) => call.names),
    [['a.b'], ['onlyEn']],
  );
});

test('flushIntervalMs sets how long keys are collected', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n({ flushIntervalMs: 5_000 });
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 4_999);
  assert.equal(calls.length, 0);
  await advance(t, 1);
  assert.equal(calls.length, 1);
});

test('more than 1000 keys in a namespace are split into requests of 1000', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  useFakeTimers(t);
  for (let i = 0; i < 2_001; i++) instance.t(`key.${i}`);
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => call.names.length),
    [1_000, 1_000, 1],
  );
  assert.equal(new Set(calls.flatMap((call) => call.names)).size, 2_001);
});

test('names longer than a maximal plural lookup (526 characters) are skipped with one warning', async (t) => {
  const calls = mockFetch();
  const warnings = silenceWarnings(t);
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('x'.repeat(527));
  instance.t('y'.repeat(600));
  // A 512-character plural key is looked up as `<key>_ordinal_other` at most.
  instance.t(`${'z'.repeat(512)}_ordinal_other`);
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [[`${'z'.repeat(512)}_ordinal_other`]],
  );
  assert.equal(warnings.length, 1);
});

test('a key still looked up six hours after its report is reported again', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 30_000);
  for (let hour = 1; hour < 6; hour++) {
    await advance(t, 60 * 60 * 1000);
    instance.t('a.b');
  }
  await advance(t, 60 * 60 * 1000);
  assert.equal(calls.length, 1, 'not within six hours');
  instance.t('a.b');
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['a.b'], ['a.b']],
  );
});

test('timer flushes never overlap: the next waits for a slow request', async (t) => {
  const pending: ((response: Response) => void)[] = [];
  const calls = mockFetch(
    () => new Promise<Response>((resolve) => pending.push(resolve)) as unknown as Response,
  );
  const instance = await makeI18n({ flushIntervalMs: 1_000 });
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 1_000);
  assert.equal(calls.length, 1);
  instance.t('onlyEn');
  await advance(t, 5_000);
  assert.equal(calls.length, 1, 'no second request while the first is open');
  pending.shift()!(ok());
  await settle();
  await advance(t, 1_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['a.b'], ['onlyEn']],
  );
  pending.shift()!(ok());
  await settle();
});

test('a 429 without a readable Retry-After waits out the 60 s window', async (t) => {
  let rateLimited = true;
  const calls = mockFetch(() => (rateLimited ? json({ error: 'rate_limited' }, 429) : ok()));
  const instance = await makeI18n({ flushIntervalMs: 1_000 });
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 1_000);
  rateLimited = false;
  await advance(t, 59_000);
  assert.equal(calls.length, 1);
  await advance(t, 1_000);
  assert.equal(calls.length, 2);
});

test('before a Node process exits, rate-limited keys wait for Retry-After, within a bound', async (t) => {
  let answer = 0;
  const calls = mockFetch(() => {
    answer++;
    return answer === 2 ? json({ error: 'rate_limited' }, 429, { 'Retry-After': '5' }) : ok();
  });
  const warnings = silenceWarnings(t);
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  instance.t('admin:title');
  process.emit('beforeExit', 0);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1, 'says it is waiting');
  await advance(t, 5_000);
  assert.deepEqual(
    calls.map((call) => call.url.split('/').pop()),
    ['common', 'admin', 'admin'],
  );
});

test('before a Node process exits, keys rate-limited for too long are dropped with a warning', async (t) => {
  const calls = mockFetch(() => json({ error: 'rate_limited' }, 429, { 'Retry-After': '600' }));
  const warnings = silenceWarnings(t);
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  process.emit('beforeExit', 0);
  await settle();
  assert.equal(calls.length, 1);
  assert.match(String(warnings[0]?.[0]), /dropped 1 key\(s\) unsent/);
  process.emit('beforeExit', 0);
  await advance(t, 700_000);
  assert.equal(calls.length, 1);
});

test('importing the backend needs no TextEncoder while tracking is off', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "delete globalThis.TextEncoder; const m = await import('./src/index.ts'); if (typeof m.LocalizeBackend !== 'function') process.exit(2);",
    ],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('stops recording new keys after 50,000 with one warning', async (t) => {
  const calls = mockFetch();
  const warnings = silenceWarnings(t);
  const instance = await makeI18n();
  useFakeTimers(t);
  const store = storeOf(instance);
  for (let i = 0; i < 50_010; i++) store.getResource('et', 'common', `k${i}`);
  await advance(t, 30_000);
  assert.equal(calls.reduce((sum, call) => sum + call.names.length, 0), 50_000);
  assert.equal(warnings.length, 1);
});

test('lookups without a string key or namespace are not recorded', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  useFakeTimers(t);
  const store = storeOf(instance);
  store.getResource('et', 'common');
  store.getResource('et', 'common', '');
  store.getResource('et', 'common', ['a', 'b']);
  store.getResource('et.common.a');
  store.getResource('et', undefined, 'a');
  await advance(t, 60_000);
  assert.equal(calls.length, 0);
});

test('a failing tracker never breaks a translation', async (t) => {
  mockFetch();
  const instance = await makeI18n();
  t.mock.method(UsageTracker.prototype, 'record', () => {
    throw new Error('boom');
  });
  assert.equal(instance.t('a.b'), 'A ja B');
  assert.equal(instance.t('items', { count: 2 }), '2 asja');
});

// --- one hook per store -------------------------------------------------------

test('initializing twice, or two backends on one store, wraps getResource once', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  const store = storeOf(instance);
  const wrapped = store.getResource;

  const backend = instance.services.backendConnector.backend as LocalizeBackend;
  backend.init(instance.services, { ...devOptions, trackUsage: true }, {} as InitOptions);
  const second = new LocalizeBackend();
  second.init(instance.services, { ...devOptions, trackUsage: true }, {} as InitOptions);
  assert.equal(store.getResource, wrapped, 'the existing wrapper is reused');

  const record = t.mock.method(UsageTracker.prototype, 'record');
  useFakeTimers(t);
  instance.t('a.b');
  assert.equal(record.mock.callCount(), 1, 'one tracker per project, once per lookup');
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['a.b']],
  );
});

test('re-initializing with trackUsage off stops recording', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  const backend = instance.services.backendConnector.backend as LocalizeBackend;
  backend.init(instance.services, devOptions, {} as InitOptions);
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 60_000);
  assert.equal(calls.length, 0);
});

// --- disabled / validation ----------------------------------------------------

test('without trackUsage nothing is wrapped or sent', async (t) => {
  const calls = mockFetch();
  const instance = i18next.createInstance();
  await instance.use(LocalizeBackend).init({ lng: 'et', fallbackLng: 'en', backend: devOptions });
  const store = storeOf(instance);
  assert.equal(store.getResource, Object.getPrototypeOf(store).getResource);
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 60_000);
  assert.equal(calls.length, 0);
});

function initBackend(options: unknown): void {
  new LocalizeBackend().init({} as Services, options as LocalizeBackendOptions, {} as InitOptions);
}

test('trackUsage without apiBaseUrl and apiKey is an init error', () => {
  const { apiBaseUrl: _apiBaseUrl, apiKey: _apiKey, ...withoutApi } = devOptions;
  assert.throws(
    () => initBackend({ ...withoutApi, trackUsage: true }),
    /trackUsage needs BOTH `apiBaseUrl` and `apiKey`/,
  );
  assert.throws(
    () => initBackend({ ...withoutApi, trackUsage: { allowedHosts: ['localhost'] } }),
    /trackUsage needs BOTH/,
  );
  assert.throws(() => initBackend({ ...withoutApi, apiKey: 'pk', trackUsage: true }), /BOTH/);
  initBackend({ ...withoutApi, trackUsage: false });
});

test('invalid trackUsage settings are init errors', () => {
  assert.throws(() => initBackend({ ...devOptions, trackUsage: 'yes' }), /`trackUsage` must be/);
  assert.throws(
    () => initBackend({ ...devOptions, trackUsage: { flushIntervalMs: 999 } }),
    /`trackUsage.flushIntervalMs` must be/,
  );
  assert.throws(
    () => initBackend({ ...devOptions, trackUsage: { flushIntervalMs: Number.NaN } }),
    /`trackUsage.flushIntervalMs` must be/,
  );
  assert.throws(
    () => initBackend({ ...devOptions, trackUsage: { allowedHosts: 'localhost' } }),
    /`trackUsage.allowedHosts` must be/,
  );
  assert.throws(
    () => initBackend({ ...devOptions, trackUsage: { allowedHosts: [''] } }),
    /`trackUsage.allowedHosts` must be/,
  );
});

test('trackUsage without a resource store warns instead of throwing', (t) => {
  const warnings = silenceWarnings(t);
  initBackend({ ...devOptions, trackUsage: true });
  assert.equal(warnings.length, 1);
});

// --- browsers -----------------------------------------------------------------

test('in a browser, only the allowed hosts report; by default the loopback ones', async (t) => {
  const calls = mockFetch();
  const cases: [string, boolean | TrackUsageOptions, boolean][] = [
    ['http://localhost:5173/', true, true],
    ['http://127.0.0.1:8080/', true, true],
    ['http://[::1]:3000/', true, true],
    ['https://shop.example/', true, false],
    ['https://staging.shop.example/', { allowedHosts: ['Staging.Shop.Example'] }, true],
    ['http://localhost/', { allowedHosts: ['staging.shop.example'] }, false],
  ];
  useFakeTimers(t);
  for (const [url, trackUsage, reports] of cases) {
    useBrowser(url);
    resetUsageTracking();
    calls.length = 0;
    t.mock.timers.reset();
    const instance = await makeI18n(trackUsage);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    instance.t('a.b');
    await advance(t, 30_000);
    assert.equal(calls.length, reports ? 1 : 0, `${url} with ${JSON.stringify(trackUsage)}`);
  }
});

test('hiding the page sends queued keys at once with keepalive', async (t) => {
  const calls = mockFetch();
  const dom = useBrowser('http://localhost:5173/');
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  instance.t('admin:title');

  Object.defineProperty(dom.window.document, 'visibilityState', {
    value: 'hidden',
    configurable: true,
  });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await settle();
  assert.deepEqual(
    calls.map((call) => [call.names, call.init.keepalive]),
    [
      [['a.b'], true],
      [['title'], true],
    ],
  );

  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await advance(t, 60_000);
  assert.equal(calls.length, 2, 'nothing left to send');
});

test('keepalive is used only within the 64 KiB browsers allow', async () => {
  const calls = mockFetch();
  const dom = useBrowser('http://localhost:5173/');
  const instance = await makeI18n();
  const store = storeOf(instance);
  // About 32 KB of JSON per namespace: the first fits the budget, the second not.
  for (let i = 0; i < 1_000; i++) {
    store.getResource('et', 'common', `${'k'.repeat(25)}${i}`);
    store.getResource('et', 'admin', `${'k'.repeat(25)}${i}`);
  }
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await settle();
  assert.deepEqual(
    calls.map((call) => [call.url.split('/').pop(), call.names.length, call.init.keepalive]),
    [
      ['common', 1_000, true],
      ['admin', 1_000, undefined],
    ],
  );
});

// --- failures -----------------------------------------------------------------

test('401 warns once and stops tracking for the page', async (t) => {
  const calls = mockFetch(() => json({ error: 'unauthorized' }, 401));
  const warnings = silenceWarnings(t);
  const instance = await makeI18n();
  const another = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  instance.t('admin:title');
  await advance(t, 30_000);
  assert.equal(calls.length, 1, 'the second namespace is not tried');
  instance.t('onlyEn');
  await advance(t, 120_000);
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);

  another.t('items', { count: 1 });
  await advance(t, 60_000);
  assert.equal(calls.length, 1, 'the same key stays stopped for the page');
});

test('429 waits for Retry-After before sending again', async (t) => {
  let rateLimited = true;
  const calls = mockFetch(() =>
    rateLimited ? json({ error: 'rate_limited' }, 429, { 'Retry-After': '120' }) : ok(),
  );
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  instance.t('admin:title');
  await advance(t, 30_000);
  assert.equal(calls.length, 1);
  rateLimited = false;

  instance.t('onlyEn');
  await advance(t, 119_999);
  assert.equal(calls.length, 1, 'still inside Retry-After');
  await advance(t, 1);
  assert.deepEqual(
    calls.slice(1).map((call) => call.names),
    [['a.b'], ['title'], ['onlyEn']],
  );
});

test('5xx and network failures are retried on later flushes, then dropped after 3 attempts', async (t) => {
  let attempt = 0;
  const calls = mockFetch(() => {
    attempt++;
    if (attempt === 2) throw new TypeError('fetch failed');
    return json({ error: 'boom' }, 503);
  });
  const warnings = silenceWarnings(t);
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 30_000);
  assert.equal(calls.length, 1, 'one attempt per flush');
  await advance(t, 30_000);
  assert.equal(calls.length, 2);
  await advance(t, 30_000);
  assert.equal(calls.length, 3);
  await advance(t, 120_000);
  assert.equal(calls.length, 3);
  assert.equal(warnings.length, 1);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['a.b'], ['a.b'], ['a.b']],
  );
});

test('other 4xx responses drop the batch with one warning', async (t) => {
  const calls = mockFetch((call) =>
    call.url.endsWith('/common') ? json({ error: 'invalid_namespace' }, 400) : ok(),
  );
  const warnings = silenceWarnings(t);
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  instance.t('admin:title');
  await advance(t, 30_000);
  await advance(t, 120_000);
  assert.deepEqual(
    calls.map((call) => call.url.split('/').pop()),
    ['common', 'admin'],
  );
  assert.equal(warnings.length, 1);
});

// --- round 2 ------------------------------------------------------------------

test('a Retry-After of 0 still waits: the batch goes to a later flush', async (t) => {
  let rateLimited = 3;
  const calls = mockFetch(() =>
    rateLimited-- > 0 ? json({ error: 'rate_limited' }, 429, { 'Retry-After': '0' }) : ok(),
  );
  const instance = await makeI18n({ flushIntervalMs: 1_000 });
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 1_000);
  assert.equal(calls.length, 1, 'one request per flush, not a resend loop');
  await advance(t, 999);
  assert.equal(calls.length, 1);
  await advance(t, 1);
  assert.equal(calls.length, 2);
});

test('a key recorded right after a capacity sweep is queued once', async (t) => {
  const calls = mockFetch();
  silenceWarnings(t);
  const instance = await makeI18n();
  useFakeTimers(t);
  const store = storeOf(instance);
  for (let i = 0; i < 50_000; i++) store.getResource('et', 'common', `k${i}`);
  await advance(t, 30_000);
  calls.length = 0;
  await advance(t, 6 * 60 * 60 * 1000);
  store.getResource('et', 'common', 'new');
  store.getResource('et', 'common', 'new');
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['new']],
  );
});

test('names containing NUL are not reported', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  useFakeTimers(t);
  const store = storeOf(instance);
  store.getResource('et', 'common', 'bad\u0000key');
  store.getResource('et', 'common', 'good');
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['good']],
  );
});

test('in a browser, a timer request is keepalive, so closing the page mid-request keeps it', async (t) => {
  const pending: ((response: Response) => void)[] = [];
  const calls = mockFetch(
    () => new Promise<Response>((resolve) => pending.push(resolve)) as unknown as Response,
  );
  const dom = useBrowser('http://localhost:5173/');
  const instance = await makeI18n();
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 30_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.keepalive, true);

  // The page goes away while that request is open; a key queued since then
  // is sent with the keepalive budget left over.
  instance.t('onlyEn');
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await settle();
  assert.deepEqual(
    calls.map((call) => [call.names, call.init.keepalive]),
    [
      [['a.b'], true],
      [['onlyEn'], true],
    ],
  );
  for (const resolve of pending) resolve(ok());
  await settle();
});

test('re-initializing with new settings retires the old tracker after sending its queue', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  const backend = instance.services.backendConnector.backend as LocalizeBackend;
  const listenersBefore = process.listenerCount('beforeExit');
  useFakeTimers(t);
  instance.t('a.b');
  for (let i = 0; i < 12; i++) {
    backend.init(
      instance.services,
      { ...devOptions, apiKey: `pk_test_${i}`, trackUsage: true },
      {} as InitOptions,
    );
  }
  await settle();
  assert.ok(
    process.listenerCount('beforeExit') <= listenersBefore,
    'retired trackers remove their listeners',
  );
  assert.deepEqual(
    calls.map((call) => [call.names, (call.init.headers as Record<string, string>).Authorization]),
    [[['a.b'], 'Bearer pk_test_123']],
    'the queue of the retired tracker is sent once, with its own key',
  );

  // Unchanged settings keep the tracker: a key it reported is not sent again.
  instance.t('onlyEn');
  await advance(t, 30_000);
  backend.init(instance.services, { ...devOptions, apiKey: 'pk_test_11', trackUsage: true }, {} as InitOptions);
  instance.t('onlyEn');
  await advance(t, 30_000);
  assert.deepEqual(
    calls.slice(1).map((call) => call.names),
    [['onlyEn']],
  );
});

test('one backend object serving two i18next instances reports both', async (t) => {
  const calls = mockFetch();
  const shared = new LocalizeBackend();
  const make = async () => {
    const instance = i18next.createInstance();
    await instance.use(shared).init({
      lng: 'et',
      fallbackLng: 'en',
      ns: ['common', 'admin'],
      defaultNS: 'common',
      backend: { ...devOptions, trackUsage: true },
    });
    return instance;
  };
  const first = await make();
  const second = await make();
  useFakeTimers(t);
  first.t('a.b');
  second.t('admin:title');
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => [call.url.split('/').pop(), call.names]).sort(),
    [
      ['admin', ['title']],
      ['common', ['a.b']],
    ],
  );
});

test('trackers of two projects on one page share the keepalive budget', async () => {
  const calls = mockFetch();
  const dom = useBrowser('http://localhost:5173/');
  const one = await makeI18n();
  const other = i18next.createInstance();
  await other.use(LocalizeBackend).init({
    lng: 'et',
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    backend: { ...devOptions, projectSlug: 'other-project', trackUsage: true },
  });
  // About 45 KB of JSON per project: the second no longer fits the 60 KiB.
  for (let i = 0; i < 1_000; i++) {
    storeOf(one).getResource('et', 'common', `${'k'.repeat(40)}${i}`);
    storeOf(other).getResource('et', 'common', `${'k'.repeat(40)}${i}`);
  }
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await settle();
  assert.deepEqual(
    calls.map((call) => [call.url.split('/').at(-3), call.init.keepalive]),
    [
      ['doc-in-pocket', true],
      ['other-project', undefined],
    ],
  );
});

test('in a browser, batches are cut to fit keepalive', async () => {
  const calls = mockFetch();
  const dom = useBrowser('http://localhost:5173/');
  const instance = await makeI18n();
  // 1,000 names of about 75 bytes: 75 KB, more than one keepalive request takes.
  for (let i = 0; i < 1_000; i++) {
    storeOf(instance).getResource('et', 'common', `${'k'.repeat(70)}${i}`);
  }
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init.keepalive, true, 'the first batch fills the keepalive budget');
  assert.ok(String(calls[0]!.init.body).length <= 60 * 1024);
  assert.equal(calls[0]!.names.length + calls[1]!.names.length, 1_000);
});

test('a retired tracker drops its exit listener before its last send settles', async () => {
  const pending: ((response: Response) => void)[] = [];
  mockFetch(() => new Promise<Response>((resolve) => pending.push(resolve)) as unknown as Response);
  const instance = await makeI18n();
  const backend = instance.services.backendConnector.backend as LocalizeBackend;
  const listenersBefore = process.listenerCount('beforeExit');
  for (let i = 0; i < 12; i++) {
    instance.t(`key${i}`);
    backend.init(
      instance.services,
      { ...devOptions, apiKey: `pk_test_${i}`, trackUsage: true },
      {} as InitOptions,
    );
  }
  await settle();
  assert.ok(pending.length > 0, 'the retired trackers are still sending');
  assert.ok(process.listenerCount('beforeExit') <= listenersBefore);
  for (const resolve of pending) resolve(ok());
  await settle();
});

test('without a web address (React Native, file: pages) keys are reported when enabled', async (t) => {
  const calls = mockFetch();
  if (!savedGlobals.has('window')) {
    savedGlobals.set('window', (globalThis as Record<string, unknown>).window);
  }
  for (const scope of [{}, { location: { hostname: '' } }]) {
    (globalThis as Record<string, unknown>).window = scope;
    resetUsageTracking();
    calls.length = 0;
    t.mock.timers.reset();
    const instance = await makeI18n();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    instance.t('a.b');
    await advance(t, 30_000);
    assert.equal(calls.length, 1, JSON.stringify(scope));
  }
});

test('pages without a host of their own are checked by the origin they inherit, or their protocol', async (t) => {
  const calls = mockFetch();
  const cases: [string, Record<string, unknown>, boolean | TrackUsageOptions, boolean][] = [
    // A blob: worker or srcdoc frame made by a production page is that page.
    [
      'blob worker of a production page',
      { hostname: '', origin: 'https://app.shop.example', protocol: 'blob:' },
      true,
      false,
    ],
    [
      'blob worker of an allowed staging page',
      { hostname: '', origin: 'https://staging.shop.example', protocol: 'blob:' },
      { allowedHosts: ['staging.shop.example'] },
      true,
    ],
    // A srcdoc or about:blank frame: location.origin is 'null', the frame's
    // own origin (window.origin) is inherited.
    [
      'srcdoc frame of a localhost page',
      { hostname: '', origin: 'null', protocol: 'about:', scopeOrigin: 'http://localhost:5173' },
      true,
      true,
    ],
    [
      'srcdoc frame of a production page',
      { hostname: '', origin: 'null', protocol: 'about:', scopeOrigin: 'https://app.shop.example' },
      true,
      false,
    ],
    [
      'sandboxed frame',
      { hostname: '', origin: 'null', protocol: 'about:', scopeOrigin: 'null' },
      true,
      false,
    ],
    // Opaque origins report only when their protocol is allowed.
    ['file: page', { hostname: '', origin: 'file://', protocol: 'file:' }, true, false],
    [
      'file: page allowed',
      { hostname: '', origin: 'file://', protocol: 'file:' },
      { allowedHosts: ['file:'] },
      true,
    ],
    ['data: worker', { hostname: '', origin: 'null', protocol: 'data:' }, true, false],
  ];
  if (!savedGlobals.has('window')) {
    savedGlobals.set('window', (globalThis as Record<string, unknown>).window);
  }
  for (const [label, { scopeOrigin, ...location }, trackUsage, reports] of cases) {
    (globalThis as Record<string, unknown>).window =
      scopeOrigin === undefined ? { location } : { location, origin: scopeOrigin };
    resetUsageTracking();
    calls.length = 0;
    t.mock.timers.reset();
    const instance = await makeI18n(trackUsage);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    instance.t('a.b');
    await advance(t, 30_000);
    assert.equal(calls.length, reports ? 1 : 0, label);
  }
});

test('the unused response body is cancelled, so an unfinished one holds nothing open', async (t) => {
  const cancelled: number[] = [];
  const unfinished = (status: number) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([123]));
        },
        cancel() {
          cancelled.push(status);
        },
      }),
      { status },
    );
  let status = 200;
  mockFetch(() => unfinished(status));
  const instance = await makeI18n({ flushIntervalMs: 1_000 });
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 1_000);
  status = 500;
  instance.t('nav.home');
  await advance(t, 1_000);
  assert.deepEqual(cancelled, [200, 500]);
});

test('a request left unanswered is abandoned and retried, so reporting goes on', async (t) => {
  let hang = true;
  const calls = mockFetch((call) =>
    hang
      ? (new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }) as unknown as Response)
      : ok(),
  );
  const instance = await makeI18n({ flushIntervalMs: 1_000 });
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 1_000);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.init.signal, 'the request can be aborted');
  hang = false;
  await advance(t, USAGE_REQUEST_TIMEOUT_MS);
  await advance(t, 1_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['a.b'], ['a.b']],
  );
});

test('a request whose fetch ignores the abort signal still times out', async (t) => {
  let hang = true;
  const calls = mockFetch(() =>
    hang ? (new Promise<Response>(() => {}) as unknown as Response) : ok(),
  );
  const instance = await makeI18n({ flushIntervalMs: 1_000 });
  useFakeTimers(t);
  instance.t('a.b');
  await advance(t, 1_000);
  hang = false;
  await advance(t, USAGE_REQUEST_TIMEOUT_MS);
  instance.t('onlyEn');
  await advance(t, 1_000);
  assert.deepEqual(
    calls.map((call) => call.names),
    [['a.b'], ['a.b'], ['onlyEn']],
  );
});

test('re-initializing an i18next instance retires the tracker of its previous settings', async (t) => {
  const calls = mockFetch();
  const instance = await makeI18n();
  const listenersBefore = process.listenerCount('beforeExit');
  instance.t('a.b');
  // i18next builds a new resource store and a new backend on init().
  await instance.init({
    lng: 'et',
    fallbackLng: 'en',
    ns: ['common', 'admin'],
    defaultNS: 'common',
    backend: { ...devOptions, apiKey: 'pk_rotated', trackUsage: true },
  });
  await settle();
  assert.equal(process.listenerCount('beforeExit'), listenersBefore, 'no tracker is left behind');
  useFakeTimers(t);
  instance.t('onlyEn');
  await advance(t, 30_000);
  assert.deepEqual(
    calls.map((call) => [call.names, (call.init.headers as Record<string, string>).Authorization]),
    [
      [['a.b'], 'Bearer pk_test_123'],
      [['onlyEn'], 'Bearer pk_rotated'],
    ],
  );
});

test('UTF-8 sizes are counted without TextEncoder', () => {
  const lone = JSON.stringify(`lone ${String.fromCharCode(0xd800)}`);
  for (const text of ['', 'abc', 'õun', '€', '日本語', '😀 emoji', lone]) {
    assert.equal(utf8Length(text), Buffer.byteLength(text, 'utf8'), text);
  }
});

test('without TextEncoder (older React Native) keys are still sent', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        'delete globalThis.TextEncoder;',
        'globalThis.window = {};',
        'let sent = 0;',
        'globalThis.fetch = async () => { sent++; return new Response("{}", { status: 200 }); };',
        "const { UsageTracker } = await import('./src/usage.ts');",
        "const tracker = new UsageTracker({ apiBaseUrl: 'https://api.example', apiKey: 'pk', projectSlug: 'p', flushIntervalMs: 1000 });",
        "tracker.record('common', 'a.b');",
        'await tracker.flush();',
        'tracker.stop();',
        'if (sent !== 1) process.exit(2);',
      ].join(' '),
    ],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
