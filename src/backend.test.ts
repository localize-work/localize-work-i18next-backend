import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import i18next, { type InitOptions, type ReadCallback, type Services } from 'i18next';
import { LocalizeBackend } from './backend.js';
import type { LocalizeBackendOptions } from './options.js';

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeBackend(options: LocalizeBackendOptions): LocalizeBackend {
  const backend = new LocalizeBackend();
  backend.init({} as Services, options, {} as InitOptions);
  return backend;
}

const baseOptions = {
  projectSlug: 'doc-in-pocket',
  cdnBaseUrl: 'https://cdn.localize.work',
} satisfies LocalizeBackendOptions;

function readAsync(
  backend: LocalizeBackend,
  language: string,
  namespace: string,
): Promise<{ err: Parameters<ReadCallback>[0]; data: Parameters<ReadCallback>[1] }> {
  return new Promise((resolve) => {
    backend.read(language, namespace, (err, data) => resolve({ err, data }));
  });
}

async function settleMicrotasksAndTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// --- read() ---------------------------------------------------------------

test('read fetches the CDN URL and returns parsed JSON', async () => {
  const resources = { greeting: 'Tere', nested: { deep: 'value' }, item_one: '{{count}} asi' };
  const calls = mockFetch((url) =>
    url.endsWith('/latest.json') ? json({ version: 'v7' }) : json(resources),
  );
  const backend = makeBackend(baseOptions);
  const { err, data } = await readAsync(backend, 'et', 'common');
  assert.equal(err, null);
  assert.deepEqual(data, resources);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://cdn.localize.work/doc-in-pocket/latest.json');
  assert.equal(calls[1]!.url, 'https://cdn.localize.work/doc-in-pocket/v7/et/common.json');
});

test('read respects version pinning', async () => {
  const calls = mockFetch(() => json({}));
  const backend = makeBackend({ ...baseOptions, version: 'v3' });
  await readAsync(backend, 'en', 'app');
  assert.equal(calls[0]!.url, 'https://cdn.localize.work/doc-in-pocket/v3/en/app.json');
});

test('read passes fetchOptions through to fetch', async () => {
  const calls = mockFetch((url) =>
    url.endsWith('/latest.json') ? json({ version: 'v1' }) : json({}),
  );
  const backend = makeBackend({ ...baseOptions, fetchOptions: { headers: { 'x-test': '1' } } });
  await readAsync(backend, 'et', 'common');
  assert.deepEqual(calls[0]!.init?.headers, { 'x-test': '1' });
  assert.deepEqual(calls[1]!.init?.headers, { 'x-test': '1' });
});

test('one initialized backend pins one latest release across namespace reads', async () => {
  let pointerReads = 0;
  const calls = mockFetch((url) => {
    if (url.endsWith('/latest.json')) {
      pointerReads++;
      return json({ version: pointerReads === 1 ? 'v8' : 'v9' });
    }
    return json({});
  });
  const backend = makeBackend(baseOptions);

  await Promise.all([
    readAsync(backend, 'en', 'common'),
    readAsync(backend, 'et', 'common'),
    readAsync(backend, 'en', 'admin'),
  ]);

  assert.equal(pointerReads, 1);
  assert.deepEqual(
    calls.slice(1).map((call) => call.url),
    [
      'https://cdn.localize.work/doc-in-pocket/v8/en/common.json',
      'https://cdn.localize.work/doc-in-pocket/v8/et/common.json',
      'https://cdn.localize.work/doc-in-pocket/v8/en/admin.json',
    ],
  );
});

test('latest pointer rejects malformed versions before requesting an artifact', async () => {
  const calls = mockFetch(() => json({ version: '../../../victim' }));
  const backend = makeBackend(baseOptions);
  const { err, data } = await readAsync(backend, 'et', 'common');
  assert.ok(err instanceof Error && err.message.includes('invalid latest release pointer'));
  assert.equal(data, false);
  assert.equal(calls.length, 1);
});

test('read uses a string loadPath override with {{lng}}/{{ns}} placeholders', async () => {
  const calls = mockFetch(() => json({}));
  const backend = makeBackend({
    projectSlug: 'doc-in-pocket',
    loadPath: 'https://example.test/i18n/{{lng}}/{{ns}}.json',
  });
  await readAsync(backend, 'en-FI', 'common');
  assert.equal(calls[0]!.url, 'https://example.test/i18n/en-FI/common.json');
});

test('read uses a function loadPath override', async () => {
  const calls = mockFetch(() => json({}));
  const backend = makeBackend({
    projectSlug: 'doc-in-pocket',
    loadPath: (language, namespace) => `https://example.test/${namespace}.${language}.json`,
  });
  await readAsync(backend, 'ru', 'app');
  assert.equal(calls[0]!.url, 'https://example.test/app.ru.json');
});

test('404 resolves to an empty resource by default (sparse variant locales)', async () => {
  mockFetch((url) =>
    url.endsWith('/latest.json')
      ? json({ version: 'v1' })
      : new Response('not found', { status: 404 }),
  );
  const failed: number[] = [];
  const backend = makeBackend({
    ...baseOptions,
    onFailedLoad: (info) => failed.push(info.status ?? -1),
  });
  const { err, data } = await readAsync(backend, 'en-FI', 'common');
  assert.equal(err, null);
  assert.deepEqual(data, {});
  assert.deepEqual(failed, [404], 'onFailedLoad still fires for observability');
});

test('404 with strict: true errors without retry', async () => {
  mockFetch((url) =>
    url.endsWith('/latest.json')
      ? json({ version: 'v1' })
      : new Response('not found', { status: 404 }),
  );
  const backend = makeBackend({ ...baseOptions, strict: true });
  const { err, data } = await readAsync(backend, 'et', 'common');
  assert.ok(err instanceof Error && err.message.includes('404'));
  assert.equal(data, false, 'retry flag must be false for 404');
});

test('non-404 4xx errors without retry', async () => {
  mockFetch(() => new Response('forbidden', { status: 403, statusText: 'Forbidden' }));
  const backend = makeBackend(baseOptions);
  const { err, data } = await readAsync(backend, 'et', 'common');
  assert.ok(err instanceof Error && err.message.includes('403'));
  assert.equal(data, false, '4xx is a config problem — retrying will not help');
});

test('5xx errors with retry allowed', async () => {
  mockFetch(() => new Response('boom', { status: 503, statusText: 'Service Unavailable' }));
  const backend = makeBackend(baseOptions);
  const { err, data } = await readAsync(backend, 'et', 'common');
  assert.ok(err instanceof Error && err.message.includes('503'));
  assert.equal(data, true, '5xx is transient — i18next may retry');
});

test('network failure errors with retry allowed and reaches onFailedLoad', async () => {
  mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const failed: unknown[] = [];
  const backend = makeBackend({ ...baseOptions, onFailedLoad: (info) => failed.push(info.error) });
  const { err, data } = await readAsync(backend, 'et', 'common');
  assert.ok(err instanceof Error);
  assert.equal(data, true);
  assert.equal(failed.length, 1);
  assert.ok(failed[0] instanceof TypeError);
});

test('malformed JSON errors without retry', async () => {
  mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
  const backend = makeBackend(baseOptions);
  const { err, data } = await readAsync(backend, 'et', 'common');
  assert.ok(err instanceof Error && err.message.includes('JSON'));
  assert.equal(data, false);
});

// --- create() / saveMissing -------------------------------------------------

const devOptions = {
  ...baseOptions,
  apiBaseUrl: 'https://api.localize.work',
  apiKey: 'pk_test_123',
} satisfies LocalizeBackendOptions;

test('create POSTs the contract shape: URL, headers, flat key→fallback body', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const backend = makeBackend(devOptions);
  backend.create(['et'], 'common', 'actions.newKey', 'New key');
  await settleMicrotasksAndTimers();

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://api.localize.work/public/projects/doc-in-pocket/missing/et/common');
  assert.equal(call.init?.method, 'POST');
  assert.deepEqual(call.init?.headers, {
    Authorization: 'Bearer pk_test_123',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(String(call.init?.body)), { 'actions.newKey': 'New key' });
});

test('create coalesces same-tick keys per (locale, namespace) into one POST each', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const backend = makeBackend(devOptions);
  backend.create(['et'], 'common', 'a.one', 'One');
  backend.create(['et'], 'common', 'a.two', 'Two');
  backend.create(['et'], 'other', 'b.three', 'Three');
  backend.create(['et', 'ru'], 'common', 'a.four', 'Four');
  await settleMicrotasksAndTimers();

  assert.equal(calls.length, 3, 'one POST per (locale, namespace) pair');
  const byUrl = new Map(calls.map((c) => [c.url, JSON.parse(String(c.init?.body))]));
  assert.deepEqual(
    byUrl.get('https://api.localize.work/public/projects/doc-in-pocket/missing/et/common'),
    { 'a.one': 'One', 'a.two': 'Two', 'a.four': 'Four' },
  );
  assert.deepEqual(
    byUrl.get('https://api.localize.work/public/projects/doc-in-pocket/missing/et/other'),
    { 'b.three': 'Three' },
  );
  assert.deepEqual(
    byUrl.get('https://api.localize.work/public/projects/doc-in-pocket/missing/ru/common'),
    { 'a.four': 'Four' },
  );
});

test('create chunks more than 1000 same-tick keys to match the server contract', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const backend = makeBackend(devOptions);
  for (let i = 0; i < 1001; i++) {
    backend.create(['et'], 'common', `key.${i}`, `Value ${i}`);
  }
  await settleMicrotasksAndTimers();

  assert.equal(calls.length, 2);
  assert.equal(Object.keys(JSON.parse(String(calls[0]!.init?.body))).length, 1000);
  assert.equal(Object.keys(JSON.parse(String(calls[1]!.init?.body))).length, 1);
});

test('create chunks by encoded body bytes as well as entry count', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const backend = makeBackend(devOptions);
  for (let i = 0; i < 120; i++) {
    backend.create(['et'], 'common', `large.${i}`, 'x'.repeat(10_000));
  }
  await settleMicrotasksAndTimers();

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(
      new TextEncoder().encode(String(call.init?.body)).byteLength <= 1024 * 1024,
      'every encoded POST body stays within Fastify bodyLimit',
    );
  }
});

test('create counts multi-byte text by its UTF-8 size when chunking', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const backend = makeBackend(devOptions);
  // 5,000 characters but 15,000 bytes each: 80 of them pass 1 MiB only in bytes.
  for (let i = 0; i < 80; i++) {
    backend.create(['et'], 'common', `euro.${i}`, '€'.repeat(5_000));
  }
  await settleMicrotasksAndTimers();

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(new TextEncoder().encode(String(call.init?.body)).byteLength <= 1024 * 1024);
  }
});

test('create works without TextEncoder (older React Native)', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        'delete globalThis.TextEncoder;',
        'const bodies = [];',
        'const warnings = [];',
        'console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };',
        // A plain object: Node's own Response needs TextEncoder.
        'globalThis.fetch = async (_url, init) => { bodies.push(init.body); return { ok: true, status: 204, headers: { get: () => null }, body: null }; };',
        "const { LocalizeBackend } = await import('./src/index.ts');",
        'const backend = new LocalizeBackend();',
        "backend.init({}, { projectSlug: 'p', cdnBaseUrl: 'https://cdn.example', apiBaseUrl: 'https://api.example', apiKey: 'pk' }, {});",
        "backend.create(['et'], 'common', 'a.b', 'A');",
        // Once every send and retry has settled: one POST, accepted, no warning.
        'process.once("beforeExit", () => {',
        '  if (bodies.length !== 1 || bodies[0] !== JSON.stringify({ "a.b": "A" }) || warnings.length > 0) {',
        '    console.error(JSON.stringify({ bodies, warnings })); process.exitCode = 2;',
        '  }',
        '});',
      ].join(' '),
    ],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('create retries a rate-limited chunk using Retry-After', async () => {
  let attempts = 0;
  const calls = mockFetch(() => {
    attempts++;
    return attempts === 1
      ? new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
      : new Response(null, { status: 204 });
  });
  const backend = makeBackend(devOptions);
  backend.create(['et'], 'common', 'retry.me', 'Retry me');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.length, 2);
});

test('create skips values outside the public endpoint schema without rejecting valid keys', async (t) => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  const backend = makeBackend(devOptions);
  backend.create(['et'], 'common', 'valid', 'Value');
  backend.create(['et'], 'common', 'too-long', 'x'.repeat(10_001));
  await settleMicrotasksAndTimers();

  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { valid: 'Value' });
  assert.equal(warnings.length, 1);
});

test('create is a silent no-op without apiBaseUrl+apiKey', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  const backend = makeBackend(baseOptions);
  backend.create(['et'], 'common', 'some.key', 'Value');
  await settleMicrotasksAndTimers();
  assert.equal(calls.length, 0);
});

test('create swallows POST failures with a warning, never throws', async (t) => {
  const calls = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  const backend = makeBackend(devOptions);
  backend.create(['et'], 'common', 'k', 'v');
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(calls.length, 3);
  assert.equal(warnings.length, 1);
});

// --- option validation ------------------------------------------------------

test('init rejects missing options object', () => {
  assert.throws(() => makeBackend(undefined as unknown as LocalizeBackendOptions), /backend options are required/);
});

test('init rejects a missing projectSlug', () => {
  assert.throws(
    () => makeBackend({ cdnBaseUrl: 'https://cdn.localize.work' } as LocalizeBackendOptions),
    /`projectSlug` must be a non-empty string/,
  );
});

test('init rejects a missing cdnBaseUrl when no loadPath is given', () => {
  assert.throws(
    () => makeBackend({ projectSlug: 'p' } as LocalizeBackendOptions),
    /`cdnBaseUrl` must be a non-empty string/,
  );
});

test('init accepts loadPath without cdnBaseUrl', () => {
  makeBackend({ projectSlug: 'p', loadPath: 'https://example.test/{{lng}}/{{ns}}.json' });
});

test('init rejects apiKey without apiBaseUrl (and vice versa)', () => {
  assert.throws(
    () => makeBackend({ ...baseOptions, apiKey: 'pk_x' }),
    /BOTH `apiBaseUrl` and `apiKey`/,
  );
  assert.throws(
    () => makeBackend({ ...baseOptions, apiBaseUrl: 'https://api.localize.work' }),
    /BOTH `apiBaseUrl` and `apiKey`/,
  );
});

test('init rejects an empty version', () => {
  assert.throws(() => makeBackend({ ...baseOptions, version: ' ' }), /`version` must be a non-empty string/);
});

// --- plugin shape -----------------------------------------------------------

test('exposes the i18next backend module type statically and per instance', () => {
  assert.equal(LocalizeBackend.type, 'backend');
  assert.equal(new LocalizeBackend().type, 'backend');
});

test('declares the callback convention, so i18next neither guesses it nor warns', async () => {
  assert.equal(LocalizeBackend.callbackApi, true);

  const posts: { url: string; body: unknown }[] = [];
  mockFetch((url, init) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ created: 1 });
    }
    return json({ hello: 'Hello' });
  });
  const messages: string[] = [];
  const record = (args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  const instance = i18next.createInstance();
  await instance
    .use({ type: 'logger', log: record, warn: record, error: record })
    .use(LocalizeBackend)
    .init({
      debug: true,
      lng: 'en',
      fallbackLng: 'en',
      ns: ['common'],
      defaultNS: 'common',
      saveMissing: true,
      backend: {
        ...baseOptions,
        version: 'v1',
        apiBaseUrl: 'https://api.localize.work',
        apiKey: 'lw_pub_test',
      },
    });

  assert.equal(instance.t('hello'), 'Hello');
  assert.equal(instance.t('brand.new', 'Brand new'), 'Brand new');
  await settleMicrotasksAndTimers();
  await settleMicrotasksAndTimers();

  assert.deepEqual(
    messages.filter((message) => /callbackApi|DEPRECATED/.test(message)),
    [],
  );
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.url, /\/en\/common/);
  assert.deepEqual(posts[0]!.body, { 'brand.new': 'Brand new' });
});

test('create calls the i18next completion callback once, with or without saveMissing configured', async () => {
  mockFetch(() => json({ hello: 'Hello' }));
  for (const backend of [
    { ...baseOptions, version: 'v1' },
    { ...baseOptions, version: 'v1', apiBaseUrl: 'https://api.localize.work', apiKey: 'lw_pub_test' },
  ]) {
    const instance = i18next.createInstance();
    await instance.use(LocalizeBackend).init({ lng: 'en', ns: ['common'], defaultNS: 'common', backend });
    const calls: unknown[][] = [];
    instance.services.backendConnector.saveMissing(['en'], 'common', 'k', 'v', false, {}, (...args: unknown[]) => {
      calls.push(args);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], null);
  }
});

test('create tolerates the options object older i18next passes in the callback position', () => {
  const backend = makeBackend({ ...baseOptions, version: 'v1' });
  assert.doesNotThrow(() =>
    backend.create(['en'], 'common', 'k', 'v', { isUpdate: false } as unknown as (err: unknown) => void),
  );
});
