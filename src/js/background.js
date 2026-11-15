import { CloudError, validateConnection, assertConnectionIdentity, queryBody, decodeSnapshot, safeError, rateLimitView, beginRateLimitRequest, observeRateLimit, validateCoverPath, coverStoragePath, validateCoverDataUrl, validateSignedCover, adoptRemoteRateLimit } from './cloud-core.js';

const SESSION_KEY = 'voice_vault_management_connection';
const ACTIONS = new Set(['connect_cloud', 'load_cloud', 'save_cloud', 'cloud_status', 'disconnect_cloud', 'resolve_fish_audio', 'upload_cover', 'open_tab']);
let mutationQueue = Promise.resolve();
let managementQueue = Promise.resolve();
const signedCoverCache = new Map();
const quotaKey = projectRef => `voice_vault_rate_database_query_${projectRef}`;
async function sessionStorage() {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return chrome.storage.session;
}
async function connection(expected) {
  const storage = await sessionStorage();
  const saved = (await storage.get(SESSION_KEY))[SESSION_KEY];
  if (!saved) throw new CloudError('NOT_CONNECTED', 'Conecta la biblioteca online para continuar.');
  const config = validateConnection(saved);
  assertConnectionIdentity(config, expected);
  return config;
}
async function managementQuery(config, operation, data, revision) {
  // Serialize calls so two tabs cannot race the shared session counter.
  const execute = () => performManagementQuery(config, operation, data, revision);
  const pending = managementQueue.then(execute, execute);
  managementQueue = pending.catch(() => {});
  return pending.then(result => hydrateSnapshotCovers(config, result));
}
async function performManagementQuery(config, operation, data, revision) {
  const storage = await sessionStorage();
  const key = quotaKey(config.projectRef);
  let record = (await storage.get(key))[key] || null;
  const controller = new AbortController();
  let timeout;
  try {
    // Validate before counting: rejected local payloads use zero HTTP requests.
    const body = JSON.stringify(queryBody(operation, config.libraryId, data, revision));
    record = beginRateLimitRequest(record);
    await storage.set({ [key]: record });
    timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(`https://api.supabase.com/v1/projects/${config.projectRef}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body, credentials: 'omit', redirect: 'error', signal: controller.signal
    });
    record = observeRateLimit(record, response.headers, response.status);
    await storage.set({ [key]: record });
    const rateLimit = rateLimitView(record);
    if (response.status === 429) {
      throw new CloudError('RATE_LIMIT', 'Supabase alcanzó el límite de consultas. Espera al reinicio del contador; los cambios pendientes se conservan.', rateLimit);
    }
    const text = await response.text();
    if (!response.ok) {
      // Inspect only the SQLSTATE marker, never forward a database error/body.
      if (/40001|VAULT_REVISION_CONFLICT/.test(text)) throw new CloudError('CONFLICT', 'La biblioteca cambió en otro dispositivo. Recarga antes de guardar.', rateLimit);
      if (response.status === 401 || response.status === 403) throw new CloudError('AUTH', 'No se pudo autorizar el acceso. Revisa el token y sus permisos.', rateLimit);
      throw new CloudError('NETWORK', 'No se pudo completar la consulta online. Los cambios locales se conservan.', rateLimit);
    }
    const decoded = decodeSnapshot(JSON.parse(text));
    if (typeof decoded.snapshot.libraryId !== 'string' || decoded.snapshot.libraryId.toLowerCase() !== config.libraryId.toLowerCase()) throw new CloudError('CONFIG_CHANGED', 'La respuesta pertenece a otra biblioteca. Vuelve a conectar antes de continuar.', rateLimit);
    return { ...decoded, projectRef: config.projectRef, libraryId: config.libraryId, rateLimit };
  } catch (error) {
    const safe = error instanceof CloudError ? error : new CloudError('NETWORK', 'No se pudo completar la consulta online. Los cambios locales se conservan.');
    if (!safe.rateLimit) safe.rateLimit = rateLimitView(record);
    throw safe;
  } finally { if (timeout) clearTimeout(timeout); }
}
async function storageQuery(config, body) {
  const execute = () => performStorageQuery(config, body);
  const pending = managementQueue.then(execute, execute);
  managementQueue = pending.catch(() => {});
  return pending;
}
async function performStorageQuery(config, body) {
  if (body.action === 'upload') validateCoverDataUrl(body.dataUrl);
  else if (body.action === 'sign' && Array.isArray(body.paths) && body.paths.length <= 500) body.paths.forEach(path => validateCoverPath(path, config.libraryId));
  else throw new CloudError('VALIDATION', 'Solicitud de portada no válida.');
  const storage = await sessionStorage();
  const key = quotaKey(config.projectRef);
  const previous = (await storage.get(key))[key] || null;
  let record = previous;
  const controller = new AbortController();
  let timeout;
  try {
    // The Edge function validates the PAT with exactly one Management query.
    record = beginRateLimitRequest(record);
    await storage.set({ [key]: record });
    timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(`https://${config.projectRef}.supabase.co/functions/v1/voice-vault-storage`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, libraryId: config.libraryId }), credentials: 'omit', redirect: 'error', signal: controller.signal
    });
    const result = await response.json();
    if (result.rateLimit) record = adoptRemoteRateLimit(record, result.rateLimit);
    else if (!response.ok && result.rateLimit === null && response.status !== 429) record = previous;
    else record = observeRateLimit(record, response.headers, response.status);
    if (record) await storage.set({ [key]: record }); else await storage.remove(key);
    const rateLimit = rateLimitView(record);
    if (response.status === 429 || result.code === 'RATE_LIMIT') throw new CloudError('RATE_LIMIT', 'Espera al reinicio del contador para continuar. La portada pendiente se conserva.', rateLimit);
    if (!response.ok || result.success === false) {
      const code = response.status === 401 || response.status === 403 ? 'AUTH' : result.code === 'VALIDATION' ? 'VALIDATION' : 'NETWORK';
      throw new CloudError(code, 'No se pudo guardar o firmar la portada online. La imagen pendiente se conserva.', rateLimit);
    }
    if (body.action === 'upload') {
      const image = validateSignedCover(result, config);
      signedCoverCache.set(`${config.projectRef}/${image.path}`, image);
      return { ...image, rateLimit };
    }
    const requested = new Set(body.paths);
    if (!Array.isArray(result.images)) throw new CloudError('NETWORK', 'No se pudieron firmar las portadas.');
    const images = result.images.map(image => validateSignedCover(image, config));
    if (images.some(image => !requested.has(image.path))) throw new CloudError('NETWORK', 'La respuesta de portadas no coincide con la biblioteca.');
    for (const image of images) signedCoverCache.set(`${config.projectRef}/${image.path}`, image);
    return { images, rateLimit };
  } catch (error) {
    const safe = error instanceof CloudError ? error : new CloudError('NETWORK', 'No se pudo guardar o firmar la portada online. La imagen pendiente se conserva.');
    if (!safe.rateLimit) safe.rateLimit = rateLimitView(record);
    throw safe;
  } finally { if (timeout) clearTimeout(timeout); }
}
async function hydrateSnapshotCovers(config, result) {
  const paths = [...new Set(result.snapshot.voices.map(voice => coverStoragePath(voice, config.libraryId)).filter(Boolean))];
  if (!paths.length) return result;
  const missing = paths.filter(path => {
    const image = signedCoverCache.get(`${config.projectRef}/${path}`);
    return !image || image.expiresAt <= Date.now() + 60000;
  });
  let warning;
  try {
    for (let offset = 0; offset < missing.length; offset += 500) {
      const signed = await storageQuery(config, { action:'sign', paths:missing.slice(offset, offset + 500) });
      result.rateLimit = signed.rateLimit;
    }
  } catch (error) {
    if (error.rateLimit) result.rateLimit = error.rateLimit;
    warning = 'Algunas portadas no pudieron cargarse. Sus referencias online se conservan; vuelve a cargar cuando haya conexión y consultas disponibles.';
  }
  const voices = result.snapshot.voices.map(voice => {
    const path = coverStoragePath(voice, config.libraryId);
    if (!path) return voice;
    const image = signedCoverCache.get(`${config.projectRef}/${path}`);
    return { ...voice, coverStoragePath:path, coverImage:image && image.expiresAt > Date.now() ? image.url : '', coverExpiresAt:image?.expiresAt ?? null };
  });
  return { ...result, snapshot:{ ...result.snapshot, voices }, ...(warning ? {coverWarning:warning} : {}) };
}

async function handle(request) {
  if (request.action === 'open_tab') { await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }); return { success: true }; }
  if (request.action === 'cloud_status') {
    const storage = await sessionStorage();
    const value = (await storage.get(SESSION_KEY))[SESSION_KEY];
    assertConnectionIdentity(value || null, request);
    const record = value ? (await storage.get(quotaKey(value.projectRef)))[quotaKey(value.projectRef)] : null;
    return { success: true, data: { connected: Boolean(value), projectRef: value?.projectRef ?? null, libraryId: value?.libraryId ?? null, rateLimit: value ? rateLimitView(record) : null } };
  }
  if (request.action === 'disconnect_cloud') { const storage = await sessionStorage(); const value = (await storage.get(SESSION_KEY))[SESSION_KEY]; assertConnectionIdentity(value || null, request); signedCoverCache.clear(); await storage.remove(SESSION_KEY); return { success: true }; }
  if (request.action === 'connect_cloud') {
    const config = validateConnection(request);
    const data = await managementQuery(config, 'load');
    await (await sessionStorage()).set({ [SESSION_KEY]: config });
    return { success: true, data };
  }
  if (request.action === 'load_cloud') return { success: true, data: await managementQuery(await connection(request), 'load') };
  if (request.action === 'save_cloud') return { success: true, data: await managementQuery(await connection(request), 'save', request.data, request.expectedVersion) };
  if (request.action === 'upload_cover') return { success:true, data:await storageQuery(await connection(request), {action:'upload', dataUrl:request.dataUrl}) };
  if (request.action === 'resolve_fish_audio') {
    await connection(request);
    if (typeof request.modelId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(request.modelId)) throw new CloudError('VALIDATION', 'ID del modelo no válido.');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`https://api.fish.audio/model/${encodeURIComponent(request.modelId)}`, { credentials: 'include', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new CloudError('NETWORK', 'Fish Audio no permitió consultar ese modelo. Puedes completar sus datos manualmente.');
      return { success: true, data: await response.json() };
    } finally { clearTimeout(timeout); }
  }
}
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }));
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const origin = chrome.runtime.getURL('');
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string' || !sender.url.startsWith(origin) || !ACTIONS.has(request?.action)) {
    sendResponse({ success: false, code: 'FORBIDDEN', error: 'Solicitud no autorizada.' }); return false;
  }
  const run = () => handle(request).catch(error => safeError(error));
  if (['save_cloud', 'connect_cloud', 'disconnect_cloud'].includes(request.action)) {
    mutationQueue = mutationQueue.then(run, run); mutationQueue.then(sendResponse);
  } else { run().then(sendResponse); }
  return true;
});
