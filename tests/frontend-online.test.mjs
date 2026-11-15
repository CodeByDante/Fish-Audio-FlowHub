import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { CloudClient, CloudError, safeAssetUrl, prepareCover, cloneSnapshot, isExtensionContext, runtimeRequest } from '../src/js/cloud-client.js';
import { StorageManager } from '../src/js/storage.js';

const fixture = (revision = 1, title = 'Prueba') => ({
  revision, projectRef: 'abcdefghijklmnopqrst', libraryId: 'test-library',
  snapshot: { revision, libraryId: 'test-library', folders: [{ id: 'all', name: 'Todas' }], voices: [{ id: 'v_test', title, url: 'https://fish.audio/m/00000000000000000000000000000001' }], settings: { showSidebarFolders: true } }
});
const snapshot = title => ({ folders: [{ id: 'all', name: 'Todas' }], voices: [{ id: 'v_test', title, url: 'https://fish.audio/m/00000000000000000000000000000001' }], settings: { showSidebarFolders: true } });

// Exercise the actual App methods with small fakes, without a browser login,
// DOM emulation library, uploaded user data or any production test unlock.
async function appHarness(overrides = {}) {
  const source = (await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/document\.addEventListener\('DOMContentLoaded',[\s\S]*$/, '');
  return runInNewContext(source + '\nApp;', { CloudClient, StorageManager, safeAssetUrl, prepareCover, cloneSnapshot, isExtensionContext, ...overrides });
}

test('only an owned extension page selects Chrome runtime; a website with chrome globals uses web', () => {
  const chrome = { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', sendMessage() {} } };
  assert.equal(isExtensionContext({ location: { protocol: 'chrome-extension:' }, chrome }), true);
  assert.equal(isExtensionContext({ location: { protocol: 'https:' }, chrome }), false);
  assert.equal(isExtensionContext({ location: { protocol: 'chrome-extension:' }, chrome: { runtime: { sendMessage() {} } } }), false);
  assert.equal(isExtensionContext({ location: { protocol: 'https:' } }), false);
});

test('extension transport unwraps the same data and quota errors as web protocol', async () => {
  const oldLocation = globalThis.location;
  const oldChrome = globalThis.chrome;
  const sent = [];
  globalThis.location = { protocol: 'chrome-extension:' };
  globalThis.chrome = { runtime: { id: 'test-extension', sendMessage(message, callback) {
    sent.push(message);
    if (message.action === 'cloud_status') callback({ success: true, data: { connected: false } });
    else callback({ success: false, code: 'RATE_LIMIT', error: 'Espera al contador', rateLimit: { remaining: 0, limit: 120 } });
  } } };
  try {
    assert.deepEqual(await runtimeRequest('cloud_status', { projectRef: 'abcdefghijklmnopqrst', libraryId: 'test-library' }), { connected: false });
    await assert.rejects(runtimeRequest('save_cloud', {}), error => error.code === 'RATE_LIMIT' && error.rateLimit.remaining === 0);
    assert.equal(sent[0].action, 'cloud_status');
    assert.equal(sent[0].libraryId, 'test-library');
  } finally {
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    if (oldChrome === undefined) delete globalThis.chrome; else globalThis.chrome = oldChrome;
  }
});

test('web transport without IndexedDB rejects persistent storage without invoking Chrome or HTTP', async () => {
  const previous = { location: globalThis.location, chrome: globalThis.chrome, fetch: globalThis.fetch };
  let calls = 0;
  globalThis.location = { protocol: 'https:' };
  globalThis.chrome = { runtime: { id: 'unrelated-extension', sendMessage() { throw new Error('Website must not call extension API'); } } };
  globalThis.fetch = async () => { calls++; throw new Error('Status must not use HTTP'); };
  try {
    await assert.rejects(runtimeRequest('cloud_status', { projectRef: 'abcdefghijklmnopqrst', libraryId: '00000000-0000-0000-0000-000000000001' }), { code: 'STORAGE' });
    assert.equal(calls, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('Fish metadata uses the shared transport and works without Chrome globals', async () => {
  const App = await appHarness();
  const app = Object.create(App.prototype);
  app.metadataRequests = new Map();
  const calls = [];
  app.cloud = {
    identity: () => ({ projectRef: 'abcdefghijklmnopqrst', libraryId: 'test-library' }),
    request: async (action, payload) => {
      calls.push({ action, payload });
      return { title: 'Voz de prueba', samples: [{ audio: 'https://public-platform.r2.fish.audio/sample.mp3' }], cover_image: 'cover.png' };
    }
  };
  const result = await app.fetchFishAudioInfo('0123456789abcdef0123456789abcdef');
  assert.equal(result.title, 'Voz de prueba');
  assert.equal(result.sampleAudio, 'https://public-platform.r2.fish.audio/sample.mp3');
  assert.equal(calls[0].action, 'resolve_fish_audio');
  assert.equal(calls[0].payload.libraryId, 'test-library');
  assert.equal(app.metadataRequests.size, 0);
});

test('queued saves capture immutable copies and advance revisions serially', async () => {
  const calls = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const client = new CloudClient(async (action, payload) => {
    if (action === 'connect_cloud') return fixture(3);
    calls.push(structuredClone(payload));
    if (calls.length === 1) await gate;
    return fixture(payload.expectedVersion + 1, payload.data.voices[0].title);
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  const source = snapshot('Primero');
  const first = client.save(source);
  source.voices[0].title = 'Segundo'; source.settings.showSidebarFolders = false;
  const second = client.save(source);
  source.voices[0].title = 'Mutación posterior';
  assert.equal(client.pending, 2);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls.map(call => call.expectedVersion), [3, 4]);
  assert.deepEqual(calls.map(call => call.data.voices[0].title), ['Primero', 'Segundo']);
  assert.deepEqual(calls.map(call => call.data.settings.showSidebarFolders), [true, false]);
  assert.equal(client.revision, 5); assert.equal(client.pending, 0); assert.equal(client.unsaved, false);
});

test('startup restore adopts remembered advanced IDs before loading, without returning a token', async () => {
  const remembered = { projectRef: 'zyxwvutsrqponmlkjihg', libraryId: 'remembered-library' };
  const calls = [];
  const client = new CloudClient(async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'restore_cloud') return { connected: true, ...remembered };
    return { ...fixture(7), ...remembered, snapshot: { ...fixture(7).snapshot, libraryId: remembered.libraryId } };
  });
  client.projectRef = 'abcdefghijklmnopqrst'; client.libraryId = 'default-library';
  const restored = await client.restore();
  assert.equal(restored.token, undefined);
  assert.equal(client.connected, false);
  assert.deepEqual(client.identity(), remembered);
  await client.load();
  assert.equal(client.connected, true);
  assert.equal(client.revision, 7);
  assert.equal(calls[0].action, 'restore_cloud');
  assert.equal(calls[0].payload, undefined);
  assert.deepEqual(calls[1].payload, remembered);
  await assert.rejects(client.restore(), { code: 'PENDING' });
});

test('logout invalidates a delayed remembered-session restoration', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new CloudClient(async action => {
    if (action === 'restore_cloud') { await gate; return { connected: true, projectRef: 'abcdefghijklmnopqrst', libraryId: 'old-library' }; }
    return {};
  });
  const restore = client.restore();
  await client.disconnect(); release();
  await assert.rejects(restore, { code: 'NOT_CONNECTED' });
  assert.equal(client.projectRef, null);
  assert.equal(client.libraryId, null);
});

test('remembered-session restoration cannot replace pending local edits', async () => {
  let requests = 0;
  const client = new CloudClient(async () => { requests++; return { connected: false }; });
  client.unsaved = true;
  await assert.rejects(client.restore(), { code: 'PENDING' });
  assert.equal(requests, 0);
});

test('conflict retains latest local snapshot and prevents blind overwrite or refresh', async () => {
  let saves = 0;
  const client = new CloudClient(async action => {
    if (action === 'connect_cloud') return fixture(2);
    if (action === 'save_cloud') { saves++; throw new CloudError('Conflicto de revisión', 'CONFLICT'); }
    return fixture(8);
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  await assert.rejects(client.save(snapshot('Cambio local')), { code: 'CONFLICT' });
  await assert.rejects(client.save(snapshot('Cambio local más reciente')), { code: 'CONFLICT' });
  await assert.rejects(client.load(), { code: 'PENDING' });
  await assert.rejects(client.retry(), { code: 'CONFLICT' });
  assert.equal(saves, 1); assert.equal(client.lastSnapshot.voices[0].title, 'Cambio local más reciente');
  assert.equal(client.unsaved, true); assert.equal(client.revision, 2);
  await client.load({ discardPending: true });
  assert.equal(client.revision, 8); assert.equal(client.unsaved, false);
});

test('background refresh cannot adopt a remote revision after a new local edit starts', async () => {
  let releaseLoad; let releaseSave;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const client = new CloudClient(async action => {
    if (action === 'connect_cloud') return fixture(1);
    if (action === 'load_cloud') { await loadGate; return fixture(12); }
    await saveGate; return fixture(2);
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  const load = client.load();
  const save = client.save(snapshot('Cambio mientras consulta'));
  releaseLoad(); await assert.rejects(load, { code: 'PENDING' });
  assert.equal(client.revision, 1);
  releaseSave(); await save;
  assert.equal(client.revision, 2);
});

test('logout invalidates slow loads so no library can reappear after logout', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new CloudClient(async action => {
    if (action === 'connect_cloud') return fixture(1);
    if (action === 'load_cloud') { await gate; return fixture(99); }
    return {};
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  const load = client.load(); await client.disconnect(); release();
  await assert.rejects(load, { code: 'NOT_CONNECTED' });
  assert.equal(client.connected, false); assert.equal(client.revision, 0);
});

test('confirmed reload cannot erase an edit made while the reload is in flight', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new CloudClient(async action => {
    if (action === 'connect_cloud') return fixture(1);
    if (action === 'load_cloud') { await gate; return fixture(10); }
    throw new CloudError('Cambio concurrente', 'CONFLICT');
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  const reload = client.load({ discardPending: true });
  await assert.rejects(client.save(snapshot('Nueva edición después de confirmar')), { code: 'CONFLICT' });
  release();
  await assert.rejects(reload, { code: 'PENDING' });
  assert.equal(client.unsaved, true);
  assert.equal(client.lastSnapshot.voices[0].title, 'Nueva edición después de confirmar');
  assert.equal(client.revision, 1);
});

test('quota updates from successes and rate-limit errors without another HTTP request', async () => {
  const limit = { limit: 120, remaining: 119, used: 1, resetAt: Date.now() + 60000, source: 'server', requestsThisSession: 1 };
  let calls = 0;
  const client = new CloudClient(async action => {
    calls++;
    if (action === 'connect_cloud') return { ...fixture(1), rateLimit: limit };
    const error = new CloudError('Límite', 'RATE_LIMIT');
    error.rateLimit = { ...limit, remaining: 0, used: 120, requestsThisSession: 2 };
    throw error;
  });
  const observed = [];
  client.onQuota = quota => observed.push(quota.remaining);
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  await assert.rejects(client.save(snapshot('Sin perder')), { code: 'RATE_LIMIT' });
  assert.deepEqual(observed, [119, 0]);
  assert.equal(calls, 2);
  assert.equal(client.unsaved, true);
  assert.equal(client.lastSnapshot.voices[0].title, 'Sin perder');
});

test('another tab changing the worker session cannot adopt a different library or revision', async () => {
  const messages = [];
  const client = new CloudClient(async (action, payload) => {
    messages.push({ action, payload });
    if (action === 'connect_cloud') return fixture(3);
    return { ...fixture(99), libraryId: 'other-library', snapshot: { ...fixture(99).snapshot, libraryId: 'other-library' } };
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  await assert.rejects(client.load(), { code: 'CONFIG_CHANGED' });
  assert.equal(client.revision, 3);
  assert.equal(client.libraryId, 'test-library');
  await assert.rejects(client.save(snapshot('No enviar a otra biblioteca')), { code: 'CONFIG_CHANGED' });
  assert.equal(client.unsaved, true);
  assert.equal(client.lastSnapshot.voices[0].title, 'No enviar a otra biblioteca');
  for (const message of messages.filter(value => value.action !== 'connect_cloud')) {
    assert.equal(message.payload.projectRef, 'abcdefghijklmnopqrst');
    assert.equal(message.payload.libraryId, 'test-library');
  }
});

test('status and logout carry the loaded identity; stale logout clears only this client', async () => {
  const messages = [];
  const client = new CloudClient(async (action, payload) => {
    messages.push({ action, payload });
    if (action === 'connect_cloud') return fixture(1);
    if (action === 'disconnect_cloud') throw new CloudError('Otra ventana cambió de biblioteca', 'CONFIG_CHANGED');
    return { connected: true, projectRef: 'abcdefghijklmnopqrst', libraryId: 'test-library' };
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  await client.status();
  await client.disconnect();
  for (const message of messages.slice(1)) assert.deepEqual(message.payload, { projectRef: 'abcdefghijklmnopqrst', libraryId: 'test-library' });
  assert.equal(client.connected, false);
  assert.equal(client.libraryId, null);
});

test('URL validation rejects executable schemes, credentials, private hosts and SVG data', () => {
  for (const value of ['javascript:alert(1)', 'http://fish.audio/m/id', 'https://name:secret@fish.audio/m/id', 'https://127.0.0.1/test', 'https://10.1.1.1/test', 'https://192.168.1.4/test', 'https://172.16.0.2/test', 'https://localhost/test', 'https://fish.audio:8080/test', 'data:image/svg+xml;base64,PHN2Zy8+']) assert.equal(safeAssetUrl(value, 'image'), '', value);
  assert.equal(safeAssetUrl('https://fish.audio/es/m/example'), 'https://fish.audio/es/m/example');
  assert.equal(safeAssetUrl('data:image/png;base64,aGVsbG8=', 'image'), 'data:image/png;base64,aGVsbG8=');
  assert.equal(safeAssetUrl('data:audio/mpeg;base64,aGVsbG8=', 'audio'), 'data:audio/mpeg;base64,aGVsbG8=');
  assert.equal(safeAssetUrl('data:image/png;base64,aGVsbG8=', 'link'), '');
});

test('UI memory does not alias edits and clears completely between sessions', () => {
  const voices = [{ id: 'test', title: 'Prueba' }];
  StorageManager.saveVoices(voices); voices[0].title = 'Editado fuera';
  assert.equal(StorageManager.getVoices()[0].title, 'Prueba');
  const loaded = StorageManager.getVoices(); loaded[0].title = 'Otro cambio';
  assert.equal(StorageManager.getVoices()[0].title, 'Prueba');
  StorageManager.clear(); assert.equal(StorageManager.getVoices(), null); assert.equal(StorageManager.getFolders(), null);
});

test('JSON import aborts if a remote refresh advances revision during file reading', async () => {
  let reader;
  const alerts = [];
  class FakeReader { constructor() { reader = this; } readAsText() {} }
  const App = await appHarness({ FileReader: FakeReader, alert: value => alerts.push(value) });
  const app = Object.create(App.prototype);
  app.cloud = { connected: true, generation: 0, changeSerial: 0, revision: 3 };
  app.settings = {};
  let applied = 0;
  app.applyCloudSnapshot = () => { applied++; };
  app.importData({ size: 100 });
  app.cloud.revision = 4;
  await reader.onload({ target: { result: JSON.stringify(snapshot('Respaldo antiguo')) } });
  assert.equal(applied, 0);
  assert.match(alerts[0], /biblioteca cambi[oó]/);
});

test('switching the displayed library unlinks the optional previous disk backup', async () => {
  const App = await appHarness();
  const app = Object.create(App.prototype);
  app.displayedIdentity = 'abcdefghijklmnopqrst/old-library';
  app.fileHandle = { oldBackup: true };
  app.linkDiskFileBtn = { style: { background: 'green', borderColor: 'green' }, title: '' };
  app.selectedVoiceIds = new Set(); app.activeFolderId = 'all';
  for (const name of ['stopAllAudio', 'applySettings', 'renderFolders', 'render']) app[name] = () => {};
  app.applyCloudSnapshot(fixture(4));
  assert.equal(app.fileHandle, null);
  assert.equal(app.linkDiskFileBtn.style.background, '');
  assert.equal(app.displayedIdentity, 'abcdefghijklmnopqrst/test-library');
  StorageManager.clear();
});

test('new cover upload returns stable storage metadata and never a base64 DB value', async () => {
  const quota = { limit: 120, remaining: 118, used: 2, source: 'server', resetAt: Date.now() + 60000 };
  const calls = [];
  const client = new CloudClient(async (action, payload) => {
    if (action === 'connect_cloud') return fixture(1);
    calls.push({ action, payload });
    return { path: 'test-library/coverhash.png', url: 'https://example.supabase.co/storage/v1/object/sign/voice-vault-images/test-library/coverhash.png?token=fake', expiresAt: Date.now() + 3600000, rateLimit: quota };
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  const original = { coverImage: 'https://example.com/old.png', coverStoragePath: 'test-library/old.png' };
  const cover = await prepareCover('data:image/png;base64,aGVsbG8=', true, original, value => client.uploadCover(value));
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'upload_cover');
  assert.deepEqual(calls[0].payload, { projectRef: 'abcdefghijklmnopqrst', libraryId: 'test-library', dataUrl: 'data:image/png;base64,aGVsbG8=' });
  assert.equal(cover.coverStoragePath, 'test-library/coverhash.png');
  assert.match(cover.coverImage, /^https:/); assert.doesNotMatch(cover.coverImage, /^data:/);
  assert.equal(client.rateLimit.remaining, 118);
  assert.equal(original.coverStoragePath, 'test-library/old.png');
});

test('unchanged cover keeps original ref without uploading; removal clears ref explicitly', async () => {
  const previous = { coverImage: 'https://example.com/signed.png', coverStoragePath: 'test-library/cover.png', coverExpiresAt: 123456789 };
  const neverUpload = () => { throw new Error('Unexpected upload'); };
  const unchanged = await prepareCover('data:image/png;base64,Y3JvcA==', false, previous, neverUpload);
  assert.deepEqual(unchanged, previous);
  assert.deepEqual(await prepareCover('', true, previous, neverUpload), { coverImage: '', coverStoragePath: '', coverExpiresAt: null });
  assert.deepEqual(await prepareCover('https://example.com/new.png', true, previous, neverUpload), { coverImage: 'https://example.com/new.png', coverStoragePath: '', coverExpiresAt: null });
});

test('failed cover upload propagates quota and leaves previous cover untouched', async () => {
  const previous = { coverImage: 'https://example.com/old.png', coverStoragePath: 'old/path.png' };
  const client = new CloudClient(async action => {
    if (action === 'connect_cloud') return fixture(1);
    const error = new CloudError('Cuota agotada', 'RATE_LIMIT');
    error.rateLimit = { limit: 120, remaining: 0, used: 120, source: 'server' };
    throw error;
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  await assert.rejects(prepareCover('data:image/png;base64,aGVsbG8=', true, previous, image => client.uploadCover(image)), { code: 'RATE_LIMIT' });
  assert.equal(previous.coverStoragePath, 'old/path.png');
  assert.equal(client.rateLimit.remaining, 0);
  assert.equal(client.unsaved, false);
  await assert.rejects(client.uploadCover('data:image/svg+xml;base64,PHN2Zy8+'), { code: 'VALIDATION' });
});

test('logout invalidates an in-flight upload before any cover can enter the library', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new CloudClient(async action => {
    if (action === 'connect_cloud') return fixture(1);
    if (action === 'disconnect_cloud') return {};
    await gate;
    return { path: 'test-library/new.png', url: 'https://example.com/signed.png', expiresAt: Date.now() + 3600000 };
  });
  await client.connect('FAKE_TEST_TOKEN', 'abcdefghijklmnopqrst', 'test-library');
  const upload = client.uploadCover('data:image/png;base64,aGVsbG8=');
  await client.disconnect(); release();
  await assert.rejects(upload, { code: 'NOT_CONNECTED' });
  assert.equal(client.connected, false);
});

test('original vault affordances remain and no local-server or bundled voice fallback exists', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');
  for (const id of ['folderTabsWrapper', 'sidebarFolderList', 'addModal', 'cropCanvas', 'toggleMultiSelectMode', 'batchActionBar', 'toggleQuickFolderBadge', 'importDataBtn', 'exportDataBtn', 'modalNotesInput']) assert.match(html, new RegExp(`id="${id}"`));
  for (const method of ['parseVoiceVersion', 'createGroupCard', 'toggleFavorite', 'changeVoiceFolder', 'applyBatchMove', 'loadAndCropSquare']) assert.match(app, new RegExp(method + '\\('));
  assert.doesNotMatch(app, /https?:\/\/(?:localhost|127\.0\.0\.1)/);
  assert.doesNotMatch(app, /fetch\([^\n]*voices\.json/);
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com|onerror=/);
  assert.doesNotMatch(app, /onerror=|preload = 'auto'/);
});

async function playbackHarness(audioUrl = 'https://samples.example.com/original.mp3') {
  const controls = new Map();
  const item = { querySelector(selector) {
    if (['.card-checkbox', '.quick-folder-select'].includes(selector)) return null;
    if (!controls.has(selector)) controls.set(selector, { textContent: '', style: {}, addEventListener() {} });
    return controls.get(selector);
  } };
  const counters = { fish: 0, cloud: 0, storage: 0, disk: 0 };
  const failing = new Set();
  class FakeAudio {
    constructor() { this.src = ''; this.paused = true; this.currentTime = 0; }
    async play() { if (failing.has(this.src)) throw new Error('Expired sample'); this.paused = false; }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  }
  const memory = { saveVoices() { counters.storage++; }, saveFolders() {}, saveSettings() {}, clear() {}, getSettings() { return {}; } };
  const App = await appHarness({ Audio: FakeAudio, document: { querySelector: () => item }, CSS: { escape: String }, StorageManager: memory });
  const app = Object.create(App.prototype);
  app.voices = [{ id: 'voice-test', title: 'Prueba', url: 'https://fish.audio/m/00000000000000000000000000000001', audioUrl }];
  app.folders = [{ id: 'all', name: 'Todas' }]; app.settings = {}; app.selectedVoiceIds = new Set(); app.activeFolderId = 'all';
  app.audioPlayers = new Map(); app.playbackSources = new Map(); app.currentPlayingId = null;
  app.cloud = { generation: 0, pending: 0, unsaved: false, save() { counters.cloud++; }, async disconnect() { this.generation++; } };
  app.startSmoothProgressLoop = () => {}; app.stopSmoothProgressLoop = () => {};
  app.fetchFishAudioInfo = async () => { counters.fish++; return { sampleAudio: 'https://samples.example.com/fresh-' + counters.fish + '.mp3' }; };
  app.autoSyncDiskFile = () => { counters.disk++; counters.cloud++; };
  for (const method of ['applySettings', 'renderFolders', 'setCloudNotice', 'setCloudStatus', 'showCloudLogin']) app[method] = () => {};
  app.render = () => { for (const voice of app.voices) app.bindCardControls(item, voice); };
  app.render();
  return { app, counters, failing, controls };
}

test('playing a valid Fish sample makes zero Supabase, storage or disk writes', async () => {
  const { app, counters } = await playbackHarness();
  const before = JSON.stringify(app.voices);
  await app.playAudio('voice-test');
  assert.equal(app.currentPlayingId, 'voice-test');
  assert.deepEqual(counters, { fish: 0, cloud: 0, storage: 0, disk: 0 });
  assert.equal(JSON.stringify(app.voices), before);
});

test('renewing an expired sample stays transient and reuses its cache after a snapshot render', async () => {
  const { app, counters, failing } = await playbackHarness();
  const canonical = JSON.parse(JSON.stringify(app.voices));
  failing.add(canonical[0].audioUrl);
  await app.playAudio('voice-test');
  assert.equal(counters.fish, 1);
  assert.equal(app.audioPlayers.get('voice-test').src, 'https://samples.example.com/fresh-1.mp3');
  assert.equal(JSON.stringify(app.voices), JSON.stringify(canonical));
  assert.equal(counters.cloud, 0); assert.equal(counters.storage, 0); assert.equal(counters.disk, 0);
  const result = { projectRef: 'abcdefghijklmnopqrst', libraryId: 'library-one', snapshot: { folders: app.folders, voices: canonical, settings: {} } };
  app.applyCloudSnapshot(result);
  assert.equal(app.audioPlayers.get('voice-test').src, 'https://samples.example.com/fresh-1.mp3');
  const writesBeforePlay = counters.storage;
  await app.playAudio('voice-test');
  assert.equal(counters.fish, 1); assert.equal(counters.storage, writesBeforePlay);
  assert.equal(counters.cloud, 0); assert.equal(counters.disk, 0);
  // A failed cached link forces exactly one fresh Fish request, still no save.
  failing.add('https://samples.example.com/fresh-1.mp3');
  app.pauseAudio('voice-test');
  await app.playAudio('voice-test');
  assert.equal(counters.fish, 2);
  assert.equal(app.audioPlayers.get('voice-test').src, 'https://samples.example.com/fresh-2.mp3');
  assert.equal(counters.cloud, 0); assert.equal(counters.storage, writesBeforePlay); assert.equal(counters.disk, 0);
});

test('playback cache invalidates canonical source changes and clears on library switch and logout', async () => {
  const { app, counters } = await playbackHarness('');
  await app.playAudio('voice-test');
  assert.equal(app.playbackSources.size, 1);
  app.voices[0].audioUrl = 'https://samples.example.com/edited.mp3';
  app.render();
  assert.equal(app.audioPlayers.get('voice-test').src, 'https://samples.example.com/edited.mp3');
  assert.equal(app.getPlaybackSource(app.voices[0]), 'https://samples.example.com/edited.mp3');
  app.prunePlaybackSources(); assert.equal(app.playbackSources.size, 0);
  app.rememberPlaybackSource(app.voices[0], 'https://samples.example.com/cached.mp3');
  app.displayedIdentity = 'abcdefghijklmnopqrst/old-library';
  app.applyCloudSnapshot({ projectRef: 'abcdefghijklmnopqrst', libraryId: 'new-library', snapshot: { folders: app.folders, voices: app.voices, settings: {} } });
  assert.equal(app.playbackSources.size, 0);
  app.rememberPlaybackSource(app.voices[0], 'https://samples.example.com/cached-again.mp3');
  await app.disconnectCloud();
  assert.equal(app.playbackSources.size, 0); assert.equal(app.voices.length, 0);
  assert.equal(counters.cloud, 0); assert.equal(counters.disk, 0);
});

test('logout discards a delayed Fish response without repopulating playback cache or writing data', async () => {
  const { app, counters } = await playbackHarness('');
  let release;
  app.fetchFishAudioInfo = async () => new Promise(resolve => { release = resolve; });
  const playback = app.playAudio('voice-test');
  await app.disconnectCloud();
  release({ sampleAudio: 'https://samples.example.com/late.mp3' });
  await playback;
  assert.equal(app.playbackSources.size, 0); assert.equal(app.voices.length, 0); assert.equal(app.audioPlayers.size, 0);
  assert.equal(counters.cloud, 0); assert.equal(counters.storage, 0); assert.equal(counters.disk, 0);
});
