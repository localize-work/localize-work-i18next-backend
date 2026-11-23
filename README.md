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
| `trackUsage` | `boolean \| { allowedHosts?, flushIntervalMs? }` | off | Report which keys the app looks up, so the editor can show unused keys. Dev/staging only; needs `apiBaseUrl` and `apiKey` — see "Key usage tracking". |

## In-context editing

Translators can edit a string by clicking it in the running app. Add the
in-context plugin next to the backend:

```ts
import LocalizeBackend from '@localize-work/i18next-backend';
import { LocalizeInContext } from '@localize-work/i18next-backend/in-context';

await i18next
  .use(LocalizeBackend)
  .use(LocalizeInContext)
  .use(initReactI18next)
  .init({
    // ...
    backend: { projectSlug: 'your-project', cdnBaseUrl: 'https://cdn.localize.work' },
  });
```

The plugin does nothing until someone opens the app with `?localize=edit` in
the address. From then on, in that browser tab:

- every translated string ends with an invisible marker that names its key;
- a toolbar appears, and hovering text outlines it and shows its key;
- clicking text opens that key in the localize.work editor, in a separate
  window. The person signs in there as usual.
- text saved in the editor appears on the page at once, without a reload. It
  is a preview in that tab only: other visitors see it after it is reviewed
  and published.

**Pause** in the toolbar lets you use the app normally for a moment; **Exit**
(or `?localize=off`) turns editing off.

An app on `localhost` works straight away. For any other address, an admin or
developer of the project adds the site once under **Project settings →
In-context editing** (for example `https://staging.your-app.example`). Until
then the editor window opens and saves, but the page does not show the saved
text.

| Option (`localizeInContext`) | Default | Meaning |
|---|---|---|
| `enabled` | on with `?localize=edit` | `false` switches the feature off entirely, e.g. in production. `true` turns it on without the parameter; Exit and `?localize=off` still turn it off for the tab. |
| `projectSlug` | `backend.projectSlug` | The project to open in the editor. |
| `editorUrl` | `https://app.localize.work` | Where the editor runs. |
| `queryParameter` | `localize` | The address parameter that turns editing on. |

```ts
i18next.init({
  // ...
  localizeInContext: { enabled: import.meta.env.MODE !== 'production' },
});
```

Things to know:

- While editing is on, translated strings contain invisible characters. Code
  that compares a translated string, measures its length or sends it somewhere
  should clean it first with `stripMarkers(text)` from the same module.
- Text in an element's content and in `placeholder`, `title`, `aria-label` and
  `alt` attributes can be clicked. Text drawn another way (a canvas, the
  document title) cannot.
- One project per page. If a page starts editing for a second i18next instance
  that names another project, editing stays off for that instance.
- The plugin works in the browser only; on a server it stays off, even with
  `enabled: true`. With server rendering, the server's HTML therefore has no
  markers, and React reports a hydration mismatch in editing mode.
- The editor opens in its own window because it signs people in with a cookie
  that browsers do not send to an embedded frame on another site. Allow
  pop-ups for your app if the browser blocks it.

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

## Key usage tracking (development and staging only)

The backend can report which keys your app actually looks up, so the
localize.work editor can show when each key was last used and point out keys
nothing uses any more. Turn it on where people click through the whole app —
your dev server, a staging site — not in production:

```ts
await i18next.use(LocalizeBackend).init({
  // ...
  backend: {
    projectSlug: 'your-project',
    cdnBaseUrl: 'https://cdn.localize.work',
    apiBaseUrl: 'https://api.localize.work',
    apiKey: import.meta.env.VITE_LOCALIZE_PUBLIC_KEY, // the same public key as saveMissing
    trackUsage: true,
    // or: trackUsage: { allowedHosts: ['localhost', 'staging.your-app.example'] },
  },
});
```

| `trackUsage` setting | Default | Meaning |
|---|---|---|
| `allowedHosts` | `['localhost', '127.0.0.1', '[::1]']` | In a browser, keys are only reported on these hostnames (exact match, no port; IPv6 in brackets, as `location.hostname` gives it). Add your staging host here. A blob: worker or an about:srcdoc or about:blank frame is checked by the hostname of the page that made it (the frame's own origin); a sandboxed frame with an opaque origin is checked by its protocol. A page with an opaque origin (`file:` pages in Electron, `data:` workers) is checked by its protocol: add `'file:'` to report from `file:` pages. Where there is no web address at all — server rendering, a prerender script, React Native — keys are reported whenever `trackUsage` is on, so turn it on only in development and staging builds there. |
| `flushIntervalMs` | `30000` | How long keys are collected before they are sent (`1000` to `3600000`, one hour). |

How it works:

- Every `t()` lookup is recorded with the key exactly as i18next looks it up —
  `items_other` for a plural, `nav.home` for a nested key — and the server
  maps it to the key in your project. Each key is sent at most once per page
  load, and again if it is still looked up six hours later (a long-running
  server or tab), unless its last report is still waiting to go out. Names
  over 2,062 bytes of UTF-8 (longer than any key the API stores, plus a
  plural suffix) are skipped with one warning.
- A lookup that returns an object (`t('nav', { returnObjects: true })`) also
  records the object's text keys under their dotted names (`nav.home`), even
  with `keySeparator: false`, where i18next does not look them up itself.
- Keys are sent per namespace, at most 1,000 per request, every
  `flushIntervalMs` and when the page is hidden or closed. A request still
  unanswered after 30 seconds is abandoned and retried like a network error. In a browser, each
  request is cut to fit the 64 KiB browsers allow for `keepalive` requests on
  a page, and uses `keepalive` while the page's budget lasts, so a report in
  flight is not lost when the tab closes:

  ```
  POST {apiBaseUrl}/public/projects/{projectSlug}/used/{namespace}
  Authorization: Bearer {apiKey}
  Content-Type: application/json

  ["welcome", "items_one", "nav.home"]
  ```

- Tracking never throws into your app and never changes what `t()` returns.
  If the API rejects the key (401/403), it warns once and stops for the page.
  Rate limits wait for `Retry-After` (at least a second, and 60 seconds when
  it is not readable);
  server and network errors are retried on the next flush, up to three
  attempts. Outside a browser, keys still queued are sent before the process
  exits; if the API rate-limits them, the process waits for `Retry-After` up
  to twice (at most 65 seconds each), then drops them with a warning.
- Setting `trackUsage` without both `apiBaseUrl` and `apiKey` is an init error.
- An instance made with `i18next.cloneInstance()` shares its parent's resource
  store and is tracked; one made with `cloneInstance({ forkResourceStore: true })`
  gets a new store the backend never sees, so its lookups are not reported.
  For server rendering, clone without `forkResourceStore`, or create and
  `init()` an instance per request: once such an instance is garbage
  collected, a tracker only it used sends what it queued (waiting out a rate
  limit at most twice, as at process exit) and is dropped.

More in the docs: https://localize.work/docs/sdk/usage-tracking/

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
