import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../supabase/functions/voice-vault-storage/index.ts', import.meta.url), 'utf8');
const { createHandler, validateImage, validatePaths, quotaFromHeaders, MAX_IMAGE_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const LIBRARY = 'b2e96ef0-0b4a-498c-8a28-4949574ae190';
const PROJECT = 'ktcjeltckzdeetucfplw';
const ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
const ENV = { SUPABASE_URL: 'https://' + PROJECT + '.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-role-never-return-this' };
const PAT = 'test-management-pat-not-real-123456789';
const NOW = 1794780000000;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const HASH = 'a'.repeat(64);
const path = LIBRARY + '/' + HASH + '.png';
const request = (data, extra = {}) => new Request('https://' + PROJECT + '.supabase.co/functions/v1/voice-vault-storage', { method: 'POST', headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json', Origin: ORIGIN, ...extra.headers }, body: JSON.stringify(data), ...extra, ...(extra.headers ? { headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json', Origin: ORIGIN, ...extra.headers } } : {}) });
const quotaHeaders = () => ({ 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '118', 'X-RateLimit-Reset': '37' });
const managementOkay = () => Response.json([{ allowed: true }], { headers: quotaHeaders() });
const bucketOkay = () => Response.json({ public: false, file_size_limit: MAX_IMAGE_BYTES, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'] });

test('missing PAT, arbitrary website origins and oversized body use no upstream credentials', async () => {
  let calls = 0;
  const handle = createHandler({ env: ENV, fetcher: async () => { calls++; throw new Error('Must not fetch'); } });
  const missing = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path] }, { headers: { Authorization: '' } }));
  assert.equal(missing.status, 401);
  const website = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path] }, { headers: { Origin: 'https://evil.example' } }));
  assert.equal(website.status, 403);
  assert.equal(website.headers.get('Access-Control-Allow-Origin'), null);
  const large = await handle(request({ action: 'upload', libraryId: LIBRARY, dataUrl: png }, { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }));
  assert.equal(large.status, 413);
  assert.equal(calls, 0);
});

test('only raster magic bytes and bounded decoded images are accepted', () => {
  assert.equal(validateImage(png).extension, 'png');
  assert.throws(() => validateImage('data:image/svg+xml;base64,' + btoa('<svg/>')));
  assert.throws(() => validateImage('data:image/png;base64,' + btoa('<script>not an image</script>')));
  assert.throws(() => validateImage('data:image/jpeg;base64,' + png.split(',')[1]));
  assert.throws(() => validateImage('data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')));
  assert.throws(() => validateImage('data:image/png;base64,not-canonical==='));
});

test('cross-library paths, traversal, remote URLs, GIF and overlarge sign batches are rejected locally', () => {
  assert.deepEqual(validatePaths([path, path], LIBRARY), [path]);
  for (const bad of [
    '../' + path,
    LIBRARY + '/../../secret.png',
    LIBRARY + '/' + HASH + '.svg',
    LIBRARY + '/' + HASH + '.gif',
    'https://evil.example/a.png',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/' + HASH + '.png',
  ]) assert.throws(() => validatePaths([bad], LIBRARY));
  assert.throws(() => validatePaths(Array(501).fill(path), LIBRARY));
});

test('valid-size data URLs are decoded without recursive regex backtracking', () => {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  bytes[0] = 255; bytes[1] = 216; bytes[2] = 255;
  bytes[bytes.length - 2] = 255; bytes[bytes.length - 1] = 217;
  assert.equal(validateImage('data:image/jpeg;base64,' + bytes.toString('base64')).bytes.byteLength, MAX_IMAGE_BYTES);
});

test('sign access verification uses exactly one fixed read-only parameterized library query', async () => {
  const calls = [];
  const handle = createHandler({ env: ENV, now: () => NOW, fetcher: async (url, init) => {
    calls.push({ url, init });
    return Response.json([{ allowed: false }], { headers: quotaHeaders() });
  } });
  const response = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path], query: 'DELETE FROM public.voices', projectRef: 'attacker' }));
  assert.equal(response.status, 404);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.supabase.com/v1/projects/' + PROJECT + '/database/query');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + PAT);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.read_only, true);
  assert.deepEqual(body.parameters, [LIBRARY]);
  assert.match(body.query, /^SELECT EXISTS .*public\.libraries/);
  assert.equal(body.query.includes('DELETE'), false);
  const payload = await response.json();
  assert.equal(payload.rateLimit.remaining, 118);
  assert.equal(payload.rateLimit.source, 'server');
});

test('management 429 retains quota and returns no upstream error or secret content', async () => {
  const handle = createHandler({ env: ENV, now: () => NOW, fetcher: async () => new Response(PAT + ENV.SUPABASE_SERVICE_ROLE_KEY, { status: 429, headers: { ...quotaHeaders(), 'Retry-After': '70' } }) });
  const response = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path] }));
  const payload = await response.json();
  assert.equal(response.status, 429);
  assert.equal(payload.code, 'RATE_LIMIT');
  assert.equal(payload.rateLimit.remaining, 0);
  assert.equal(payload.rateLimit.resetAt, NOW + 70000);
  assert.equal(JSON.stringify(payload).includes(PAT), false);
  assert.equal(JSON.stringify(payload).includes(ENV.SUPABASE_SERVICE_ROLE_KEY), false);
});

test('a PAT denied by the Management write gate cannot upload using the service role', async () => {
  const calls = [];
  const handle = createHandler({ env: ENV, now: () => NOW, fetcher: async (url, init) => {
    calls.push(url);
    assert.equal(url.startsWith('https://api.supabase.com/'), true);
    assert.equal(JSON.parse(init.body).read_only, false);
    return new Response('write scope required: ' + PAT, { status: 403, headers: quotaHeaders() });
  } });
  const response = await handle(request({ action: 'upload', libraryId: LIBRARY, dataUrl: png }));
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.code, 'AUTH');
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(payload).includes(PAT), false);
});

test('upload creates private bucket, stores only bytes at hash path, and returns a temporary signed URL', async () => {
  const calls = [];
  let uploadedPath;
  const handle = createHandler({ env: ENV, now: () => NOW, cryptoProvider: webcrypto, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.supabase.com/')) {
      const authorization = JSON.parse(init.body);
      assert.equal(authorization.read_only, false, 'upload requires the Management write permission gate');
      assert.match(authorization.query, /^SELECT EXISTS /);
      assert.deepEqual(authorization.parameters, [LIBRARY]);
      return managementOkay();
    }
    assert.equal(init.headers.Authorization, 'Bearer ' + ENV.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(init.headers.apikey, ENV.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(url.startsWith(ENV.SUPABASE_URL + '/storage/v1/'), true);
    if (url.endsWith('/bucket/voice-vault-images')) return new Response('', { status: 404 });
    if (url.endsWith('/bucket')) {
      assert.equal(JSON.parse(init.body).public, false);
      assert.equal(JSON.parse(init.body).file_size_limit, MAX_IMAGE_BYTES);
      return Response.json({ name: 'voice-vault-images' });
    }
    if (url.includes('/object/sign/')) return Response.json({ signedURL: '/object/sign/voice-vault-images/' + uploadedPath + '?token=temporary-read-grant' });
    uploadedPath = url.split('/object/voice-vault-images/')[1];
    assert.match(uploadedPath, new RegExp('^' + LIBRARY + '/[a-f0-9]{64}\\.png$'));
    assert.equal(init.headers['x-upsert'], 'true');
    assert.equal(init.body instanceof Uint8Array, true);
    return Response.json({ Key: 'voice-vault-images/' + uploadedPath });
  } });
  const response = await handle(request({ action: 'upload', libraryId: LIBRARY, dataUrl: png }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.path, uploadedPath);
  assert.equal(payload.url, ENV.SUPABASE_URL + '/storage/v1/object/sign/voice-vault-images/' + uploadedPath + '?token=temporary-read-grant');
  assert.equal(payload.expiresAt, NOW + 3600000);
  assert.equal(payload.rateLimit.remaining, 118);
  assert.equal(calls.filter(call => call.url.startsWith('https://api.supabase.com/')).length, 1);
  assert.equal(JSON.stringify(payload).includes(ENV.SUPABASE_SERVICE_ROLE_KEY), false);
  assert.equal(JSON.stringify(payload).includes(PAT), false);
});

test('signing never downloads remote images and signs only same-library allowed paths', async () => {
  const urls = [];
  const handle = createHandler({ env: ENV, now: () => NOW, fetcher: async (url, init) => {
    urls.push(url);
    if (url.startsWith('https://api.supabase.com/')) return managementOkay();
    if (url.endsWith('/bucket/voice-vault-images')) return bucketOkay();
    assert.equal(url, ENV.SUPABASE_URL + '/storage/v1/object/sign/voice-vault-images');
    assert.deepEqual(JSON.parse(init.body), { expiresIn: 3600, paths: [path] });
    return Response.json([{ path, signedURL: '/object/sign/voice-vault-images/' + path + '?token=signed-read' }, { path: 'other/path.png', signedURL: 'https://evil.example/stolen' }]);
  } });
  const response = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path] }));
  const payload = await response.json();
  assert.equal(payload.images.length, 1);
  assert.equal(payload.images[0].path, path);
  assert.equal(payload.images[0].expiresAt, NOW + 3600000);
  assert.equal(urls.some(url => url.startsWith('https://evil.example')), false);
});

test('legacy HTTP400 bucket-not-found envelope creates a private bucket for authorized uploads', async () => {
  for (const error of ['not_found', 'Bucket not found', 'NoSuchBucket']) {
    let created = 0;
    let uploadedPath;
    const handle = createHandler({ env: ENV, now: () => NOW, fetcher: async (url, init) => {
      if (url.startsWith('https://api.supabase.com/')) return managementOkay();
      if (url.endsWith('/bucket/voice-vault-images')) return Response.json({ statusCode: '404', error, message: 'Bucket not found' }, { status: 400 });
      if (url.endsWith('/bucket')) {
        created++;
        assert.equal(JSON.parse(init.body).public, false);
        return Response.json({ name: 'voice-vault-images' });
      }
      if (url.includes('/object/sign/')) return Response.json({ signedURL: '/object/sign/voice-vault-images/' + uploadedPath + '?token=signed-read' });
      uploadedPath = url.split('/object/voice-vault-images/')[1];
      return Response.json({ Key: uploadedPath });
    } });
    const response = await handle(request({ action: 'upload', libraryId: LIBRARY, dataUrl: png }));
    assert.equal(response.status, 200, error);
    assert.equal(created, 1, error);
    assert.equal((await response.json()).path, uploadedPath);
  }
});

test('read-only signing never creates missing buckets or reconfigures public buckets', async () => {
  for (const bucketResponse of [
    () => Response.json({ statusCode: '404', error: 'not_found' }, { status: 400 }),
    () => Response.json({ public: true }),
  ]) {
    const storageCalls = [];
    const handle = createHandler({ env: ENV, now: () => NOW, fetcher: async (url, init) => {
      if (url.startsWith('https://api.supabase.com/')) {
        assert.equal(JSON.parse(init.body).read_only, true);
        return managementOkay();
      }
      storageCalls.push({ url, method: init.method || 'GET' });
      return bucketResponse();
    } });
    const response = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path] }));
    assert.equal(response.status, 502);
    assert.equal(storageCalls.length, 1);
    assert.equal(storageCalls[0].method, 'GET');
  }
});

test('arbitrary HTTP400 and RLS/auth errors never create a bucket or expose raw errors', async () => {
  for (const payload of [
    { statusCode: '400', error: 'not_found' },
    { statusCode: '404', error: 'AccessDenied' },
    { statusCode: '404', error: ENV.SUPABASE_SERVICE_ROLE_KEY },
    { statusCode: '401', error: 'InvalidJWT', message: PAT },
  ]) {
    let storageCalls = 0;
    const handle = createHandler({ env: ENV, now: () => NOW, fetcher: async url => {
      if (url.startsWith('https://api.supabase.com/')) return managementOkay();
      storageCalls++;
      return Response.json(payload, { status: 400 });
    } });
    const response = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path] }));
    assert.equal(response.status, 502);
    assert.equal(storageCalls, 1);
    const result = await response.json();
    assert.deepEqual(Object.keys(result.details).sort(), ['stage', 'storageCode', 'upstreamStatus']);
    assert.equal(result.details.stage, 'bucket_get');
    assert.equal(result.details.upstreamStatus, 400);
    assert.equal(JSON.stringify(result).includes(ENV.SUPABASE_SERVICE_ROLE_KEY), false);
    assert.equal(JSON.stringify(result).includes(PAT), false);
  }
});

test('CORS supports extension origins, optional pinning and originless background calls', async () => {
  const handle = createHandler({ env: { ...ENV, VOICE_VAULT_EXTENSION_IDS: 'b'.repeat(32) } });
  const forbidden = await handle(request({ action: 'sign', libraryId: LIBRARY, paths: [path] }));
  assert.equal(forbidden.status, 403);
  const preflight = await handle(new Request('https://example.com/', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://' + 'b'.repeat(32) } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://' + 'b'.repeat(32));
  const absent = await handle(new Request('https://example.com/', { method: 'GET' }));
  assert.equal(absent.status, 405);
});

test('CORS allows only the exact standalone GitHub Pages origin, never lookalikes or subdomains', async () => {
  const handle = createHandler({ env: ENV });
  const preflight = await handle(new Request('https://example.com/', { method: 'OPTIONS', headers: { Origin: 'https://codebydante.github.io' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://codebydante.github.io');
  for (const origin of ['https://codebydante.github.io.evil.example', 'http://codebydante.github.io', 'https://other.github.io', 'https://preview.codebydante.github.io', 'null']) {
    const response = await handle(new Request('https://example.com/', { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null, origin);
  }
});

test('Management reset header is seconds remaining, with estimates only when headers are missing', () => {
  const rate = quotaFromHeaders(new Headers(quotaHeaders()), 200, NOW);
  assert.equal(rate.resetAt, NOW + 37000);
  assert.equal(rate.used, 2);
  const missing = quotaFromHeaders(new Headers(), 200, NOW);
  assert.equal(missing.source, 'estimate');
  assert.equal(missing.remaining, 119);
});
