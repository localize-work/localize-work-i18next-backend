# @localize-work/i18next-backend

i18next backend plugin for [localize.work](https://localize.work). Loads published
translation JSON straight from the CDN (no server in the request path) and — in
development only — reports missing keys back to the localize.work API via
i18next's `saveMissing`.

Works in browsers and Node 18+ (uses global `fetch`, no HTTP dependency).

## Install

```sh
pnpm add i18next @localize-work/i18next-backend
# react apps: pnpm add react-i18next
```

## Usage

```ts
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LocalizeBackend from '@localize-work/i18next-backend';

await i18next
  .use(LocalizeBackend)
  .use(initReactI18next)
  .init({
    lng: 'et',
    fallbackLng: 'en',
    ns: ['common', 'app'],
    defaultNS: 'common',
    backend: {
      projectSlug: 'your-project',
      cdnBaseUrl: 'https://cdn.localize.work',
    },
  });
```

`your-project` is a placeholder — substitute your own project's slug, shown in the
editor. There is no public demo project, so the URLs in this README return 404 as
written.

For the default `latest`, the backend first fetches one atomic pointer:

```
{cdnBaseUrl}/{projectSlug}/latest.json
```

It then fetches the selected immutable release file:

```
{cdnBaseUrl}/{projectSlug}/{version}/{locale}/{namespace}.json
```

Published files are plain i18next-format JSON — nested keys, `key_one` /
`key_other` plural suffixes — so everything else about your i18next setup stays
standard.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `projectSlug` | `string` | required | Project slug as it appears in CDN paths and API routes. |
| `cdnBaseUrl` | `string` | required* | CDN origin, e.g. `https://cdn.localize.work`. *Not needed when `loadPath` is set. |
| `version` | `string` | `'latest'` | Release to load — see "Version pinning". |
| `apiBaseUrl` | `string` | — | API origin for `saveMissing`. Only used together with `apiKey`. |
| `apiKey` | `string` | — | Public API key for `saveMissing`. Dev-only. |
| `strict` | `boolean` | `false` | Treat a 404 namespace file as a load error instead of an empty resource — see "Variant locales". |
| `fetchOptions` | `RequestInit` | — | Merged into every CDN request (custom headers, `cache`, credentials…). |
| `loadPath` | `string \| (lng, ns) => string` | — | Escape hatch replacing the whole CDN URL. String form supports `{{lng}}` and `{{ns}}` placeholders. |
| `onFailedLoad` | `(info: FailedLoadInfo) => void` | — | Observability hook; fires on every failed CDN load **including sparse 404s** (`info.status === 404`). Never changes load behavior. |

## Version pinning

`version: 'latest'` (the default) follows the atomic pointer that moves on every
publish. One initialized backend resolves that pointer once, ensuring all its
locale and namespace reads use the same release; reinitialize i18next to pick
up a newer release. Pin an immutable
release version to freeze translations to a deploy:

```ts
backend: {
  projectSlug: 'your-project',
  cdnBaseUrl: 'https://cdn.localize.work',
  version: 'v12', // exact release, never changes
}
```

Rollback on the localize.work side moves the `latest` pointer — pinned apps are
unaffected either way.

For debugging, the exact URL the backend fetches is exported:

```ts
import { cdnUrl } from '@localize-work/i18next-backend';
cdnUrl({ cdnBaseUrl, projectSlug, version: 'v12' }, 'et', 'common');
// https://cdn.localize.work/your-project/v12/et/common.json
```

## saveMissing (development only)

When a component uses a key that doesn't exist yet, i18next can report it so it
appears in the localize.work editor as a new key. Enable it in dev builds only:

```ts
await i18next.use(LocalizeBackend).init({
  // ...
  saveMissing: import.meta.env.DEV, // or process.env.NODE_ENV === 'development'
  backend: {
    projectSlug: 'your-project',
    cdnBaseUrl: 'https://cdn.localize.work',
    apiBaseUrl: 'https://api.localize.work',
    apiKey: import.meta.env.VITE_LOCALIZE_PUBLIC_KEY, // public (read/saveMissing) key
  },
});
```

Missing keys encountered in the same tick are coalesced per (locale, namespace).
Large groups are split automatically to stay within the API's 1,000-entry,
10,000-character-value, and 1 MiB request limits:

```
POST {apiBaseUrl}/public/projects/{projectSlug}/missing/{locale}/{namespace}
Authorization: Bearer {apiKey}
Content-Type: application/json

{ "flat.key.name": "fallback value shown in code", ... }
```

Notes:

- Without **both** `apiBaseUrl` and `apiKey`, `create()` is a silent no-op
  (passing only one of them is an init error — that's always a misconfiguration).
- POST failures log a `console.warn` and are otherwise swallowed: saveMissing
  must never break the host app.
- Rate limits and transient server/network failures are retried up to three
  times. `Retry-After` is honored when the API supplies it.
- Keys or fallback values outside the public endpoint's schema are skipped with
  a warning so one invalid entry cannot reject the rest of the batch.
- The key is the *public* project API key. It can read and report missing keys,
  nothing else — but still avoid shipping saveMissing enabled to production, or
  end users' render paths will generate writes.

## Variant locales (sparse overrides) and 404 behavior

Regional variants like `en-FI` are published as **sparse** files containing only
the keys that differ from the base language. A variant may have *no* overrides
for a given namespace, in which case that file simply doesn't exist on the CDN —
so for this backend **a 404 is a normal condition, not an error**: it resolves
to an empty resource (`callback(null, {})`) and i18next's fallback chain
supplies every value from the base locale.

Configure `fallbackLng` so each variant falls back to its base:

```ts
await i18next.use(LocalizeBackend).init({
  supportedLngs: ['en', 'en-FI', 'et', 'et-ES', 'ru'],
  fallbackLng: {
    'en-FI': ['en'],
    'et-ES': ['et'],
    default: ['en'],
  },
  // ...
});
```

With `lng: 'en-FI'`, i18next loads both `en-FI/common.json` (sparse, possibly
404 → empty) and `en/common.json`, and resolves each key override-first.

If you don't use variant locales and would rather have a missing file fail
loudly, set `strict: true`: a 404 then calls back with an error and no retry.
Either way, `onFailedLoad` fires with `status: 404` so you can log it.

Full retry classification (the backend tells i18next whether a retry could
help): 2xx → data; 404 → empty resource (or error+no-retry in strict mode);
other 4xx → error, no retry; 5xx and network errors → error, retry allowed.

## Escape hatch: custom loadPath

Self-hosting the published files somewhere else? Override the URL entirely —
`projectSlug` is still required (it identifies the project for saveMissing):

```ts
backend: {
  projectSlug: 'your-project',
  loadPath: 'https://static.example.com/i18n/{{lng}}/{{ns}}.json',
  // or: loadPath: (lng, ns) => `https://static.example.com/i18n/${lng}/${ns}.json`,
}
```

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## License

MIT — see [LICENSE](LICENSE).
