import assert from 'node:assert/strict';
import test from 'node:test';
import { cdnUrl, latestManifestUrl, missingUrl, usedUrl } from './url.js';

test('latestManifestUrl addresses the atomic release pointer', () => {
  assert.equal(
    latestManifestUrl({
      cdnBaseUrl: 'https://cdn.localize.work/',
      projectSlug: 'doc in pocket',
    }),
    'https://cdn.localize.work/doc%20in%20pocket/latest.json',
  );
});

test('cdnUrl pins an immutable release version', () => {
  assert.equal(
    cdnUrl(
      { cdnBaseUrl: 'https://cdn.localize.work', projectSlug: 'doc-in-pocket', version: 'v12' },
      'en-FI',
      'app',
    ),
    'https://cdn.localize.work/doc-in-pocket/v12/en-FI/app.json',
  );
});

test('cdnUrl trims trailing slashes and URI-encodes segments', () => {
  assert.equal(
    cdnUrl(
      { cdnBaseUrl: 'https://cdn.localize.work//', projectSlug: 'a b', version: 'v3' },
      'et',
      'name/space',
    ),
    'https://cdn.localize.work/a%20b/v3/et/name%2Fspace.json',
  );
});

test('missingUrl matches the saveMissing endpoint contract', () => {
  assert.equal(
    missingUrl('https://api.localize.work/', 'doc-in-pocket', 'et', 'common'),
    'https://api.localize.work/public/projects/doc-in-pocket/missing/et/common',
  );
});

test('usedUrl matches the key-usage endpoint contract', () => {
  assert.equal(
    usedUrl('https://api.localize.work/', 'doc-in-pocket', 'common'),
    'https://api.localize.work/public/projects/doc-in-pocket/used/common',
  );
  assert.equal(
    usedUrl('https://api.localize.work', 'a b', 'name/space'),
    'https://api.localize.work/public/projects/a%20b/used/name%2Fspace',
  );
});
