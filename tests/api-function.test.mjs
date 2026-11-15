import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as canonicalCore from '../src/js/cloud-core.js';
const directory = new URL('../supabase/functions/voice-vault-api/', import.meta.url);
let source = await readFile(new URL('index.ts', directory), 'utf8');
source = source.replace("'./cloud-core.js'", JSON.stringify(new URL('cloud-core.js', directory).href)).replace("'./bootstrap-sql.js'", JSON.stringify(new URL('bootstrap-sql.js', directory).href));
const { createApiHandler } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const { BOOTSTRAP_SQL } = await import(new URL('bootstrap-sql.js', directory).href);
const LIBRARY = 'b2e96ef0-0b4a-498c-8a28-4949574ae190';
const PROJECT = 'ktcjeltckzdeetucfplw';
const ENV = { SUPABASE_URL: 'https://' + PROJECT + '.supabase.co' };
const PAT = 'test-management-pat-not-real-123456789';
const NOW = 1794780000000;
const ORIGIN = 'https://codebydante.github.io';
const snapshot = () => ({ libraryId: LIBRARY, revision: 7, folders: [{ id: 'all', name: 'Todas' }, { id: 'f_favorites', name: 'Favoritas' }, { id: 'f_sueltas', name: 'Voces Sueltas' }], voices: [], settings: { showQuickFolderBadge: false, showSidebarFolders: true } });
const request = (data, headers = {}) => new Request(ENV.SUPABASE_URL + '/functions/v1/voice-vault-api', { method: 'POST', headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(data) });
const rateHeaders = { 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '114', 'X-RateLimit-Reset': '29' };
const reply = data => Response.json(data, { headers: rateHeaders });

test('generated server core is an exact copy of canonical protocol code', async () => {
  assert.equal(await readFile(new URL('cloud-core.js', directory), 'utf8'), await readFile(new URL('../src/js/cloud-core.js', import.meta.url), 'utf8'));
});

test('CORS accepts exact Pages, extension and originless callers, but no arbitrary websites', async () => {
  const handle = createApiHandler({ env: ENV });
  for (const origin of [ORIGIN, 'chrome-extension://' + 'a'.repeat(32)]) {
    const response = await handle(new Request('https://example.com/', { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-RateLimit-Remaining/);
    assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-Vault-Management-Requests/);
    assert.equal(response.headers.get('X-Vault-Management-Requests'), '0');
  }
  for (const origin of ['https://evil.example', ORIGIN + '.evil.example', 'http://codebydante.github.io', 'null']) {
    const response = await handle(new Request('https://example.com/', { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await handle(new Request('https://example.com/'))).status, 405);
});

test('missing PAT, bad library, arbitrary operation and oversized requests perform zero upstream calls', async () => {
  let calls = 0;
  const handle = createApiHandler({ env: ENV, fetcher: async () => { calls++; throw new Error('must not fetch'); } });
  const inputs = [
    request({ operation: 'load', libraryId: LIBRARY }, { Authorization: '' }),
    request({ operation: 'load', libraryId: 'bad' }),
    request({ operation: 'sql', libraryId: LIBRARY, query: 'DROP TABLE public.voices' }),
    request({ operation: 'load', libraryId: LIBRARY }, { 'Content-Length': String(27 * 1024 * 1024) }),
  ];
  for (const input of inputs) {
    const response = await handle(input);
    assert.equal(response.ok, false);
    assert.equal(response.headers.get('X-Vault-Management-Requests'), '0');
    assert.equal((await response.json()).rateLimit, null);
  }
  assert.equal(calls, 0);
});

test('load authenticates with exactly one fixed project query, ignoring caller SQL/ref/token fields', async () => {
  const calls = [];
  const handle = createApiHandler({ env: name => { assert.notEqual(name, 'SUPABASE_SERVICE_ROLE_KEY'); return ENV[name]; }, now: () => NOW, fetcher: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, 'Bearer ' + PAT);
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(JSON.parse(init.body), canonicalCore.queryBody('load', LIBRARY));
    return reply([{ snapshot: snapshot(), secretExtraColumn: 'should not be returned' }]);
  } });
  const response = await handle(request({ operation: 'load', libraryId: LIBRARY, query: 'DROP TABLE public.voices', sql: 'arbitrary', read_only: true, projectRef: 'attacker', token: 'ignored' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ snapshot: snapshot() }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.supabase.com/v1/projects/' + PROJECT + '/database/query');
  assert.equal(response.headers.get('X-RateLimit-Remaining'), '114');
  assert.equal(response.headers.get('X-Vault-Management-Requests'), '1');
});

test('bootstrap always uses the server bundle and never a browser-supplied SQL string', async () => {
  const handle = createApiHandler({ env: ENV, fetcher: async (url, init) => {
    assert.equal(JSON.parse(init.body).query, BOOTSTRAP_SQL);
    assert.equal(JSON.parse(init.body).read_only, false);
    return reply([]);
  } });
  const response = await handle(request({ operation: 'bootstrap', libraryId: LIBRARY, data: '-- Voice Vault bundled bootstrap v1.\nDROP TABLE public.voices;' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test('probe and seed return only their validated native row envelopes', async () => {
  const probe = { state: 'compatible', tablesPresent: 4, invalidColumns: 0, invalidFunctions: 0, invalidTriggers: 0, primaryKeys: 4, isolatedFolderForeignKeys: 1 };
  const seed = { createdLibrary: false, createdFolders: 0, libraryAvailable: true };
  for (const [operation, key, data] of [['probe', 'schema_state', probe], ['seed', 'seed_result', seed]]) {
    const handle = createApiHandler({ env: ENV, fetcher: async (url, init) => {
      assert.deepEqual(JSON.parse(init.body), canonicalCore.queryBody(operation, LIBRARY));
      return reply([{ [key]: { ...data, rawDebugSql: 'not forwarded' }, extra: PAT }]);
    } });
    const response = await handle(request({ operation, libraryId: LIBRARY }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ [key]: data }]);
  }
});

test('save preserves shared validation, revision checks and canonical Storage normalization', async () => {
  const data = snapshot();
  const path = LIBRARY + '/' + 'a'.repeat(64) + '.png';
  data.voices.push({ id: 'v_test', title: 'Test voice', url: 'https://fish.audio/m/' + 'a'.repeat(32), audioUrl: '', coverImage: ENV.SUPABASE_URL + '/storage/v1/object/sign/voice-vault-images/' + path + '?token=transient-read', coverStoragePath: path, coverExpiresAt: NOW + 3600000, folderId: 'f_sueltas' });
  const handle = createApiHandler({ env: ENV, fetcher: async (url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body, canonicalCore.queryBody('save', LIBRARY, data, 7));
    const saved = JSON.parse(body.parameters[2]);
    assert.equal(saved.voices[0].coverImage, '');
    assert.equal(saved.voices[0].coverExpiresAt, undefined);
    return reply([{ snapshot: { ...saved, revision: 8 } }]);
  } });
  const response = await handle(request({ operation: 'save', libraryId: LIBRARY, data, expectedVersion: 7 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].snapshot.revision, 8);
  const invalid = await handle(request({ operation: 'save', libraryId: LIBRARY, data, expectedVersion: 0 }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('X-Vault-Management-Requests'), '0');
});

test('legacy image data allowed by shared core retains validation parity', async () => {
  const data = snapshot();
  data.voices.push({ id: 'v_legacy', title: 'Legacy', url: 'https://fish.audio/m/' + 'a'.repeat(32), audioUrl: '', coverImage: 'data:image/png;base64,legacy', folderId: 'f_sueltas' });
  let calls = 0;
  const handle = createApiHandler({ env: ENV, fetcher: async (url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), canonicalCore.queryBody('save', LIBRARY, data, 7));
    return reply([{ snapshot: { ...data, revision: 8 } }]);
  } });
  assert.equal((await handle(request({ operation: 'save', libraryId: LIBRARY, data, expectedVersion: 7 }))).status, 200);
  assert.equal(calls, 1);
});

test('upstream SQL errors become safe recognizable codes without tokens, raw SQL or provider text', async () => {
  for (const [marker, code, status] of [['VAULT_REVISION_CONFLICT 40001', 'CONFLICT', 409], ['VAULT_SCHEMA_INCOMPATIBLE', 'SCHEMA_INCOMPATIBLE', 409], ['Library unavailable', 'LIBRARY_MISSING', 404], ['provider failure', 'NETWORK', 502]]) {
    const handle = createApiHandler({ env: ENV, fetcher: async () => new Response(marker + ' ' + PAT + ' SELECT * FROM private.table', { status: 400, headers: rateHeaders }) });
    const response = await handle(request({ operation: 'load', libraryId: LIBRARY }));
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(body.rateLimit.remaining, 114);
    assert.equal(JSON.stringify(body).includes(PAT), false);
    assert.equal(JSON.stringify(body).includes('private.table'), false);
    assert.equal(response.headers.get('X-Vault-Management-Requests'), '1');
  }
});

test('429 exposes actual quota headers and a safe rate-limit object', async () => {
  const handle = createApiHandler({ env: ENV, now: () => NOW, fetcher: async () => new Response('secret provider body ' + PAT, { status: 429, headers: { ...rateHeaders, 'X-RateLimit-Remaining': '0', 'Retry-After': '70' } }) });
  const response = await handle(request({ operation: 'load', libraryId: LIBRARY }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '70');
  const body = await response.json();
  assert.equal(body.code, 'RATE_LIMIT');
  assert.equal(body.rateLimit.source, 'server');
  assert.equal(body.rateLimit.remaining, 0);
  assert.equal(body.rateLimit.resetAt, NOW + 70000);
  assert.equal(JSON.stringify(body).includes(PAT), false);
});

test('malformed success and cross-library snapshots never reach the browser as valid data', async () => {
  for (const [payload, expected] of [[[{ snapshot: { ...snapshot(), libraryId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }], 409], [[{ snapshot: { invalid: true, token: PAT } }], 502], [{ unexpected: PAT }, 502]]) {
    const handle = createApiHandler({ env: ENV, fetcher: async () => reply(payload) });
    const response = await handle(request({ operation: 'load', libraryId: LIBRARY }));
    assert.equal(response.status, expected);
    assert.equal(JSON.stringify(await response.json()).includes(PAT), false);
  }
});
