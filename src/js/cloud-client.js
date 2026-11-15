export const cloneSnapshot = value => JSON.parse(JSON.stringify(value));

export class CloudError extends Error {
  constructor(message, code = 'NETWORK') { super(message); this.name = 'CloudError'; this.code = code; }
}

export function isExtensionContext(environment = globalThis) {
  return environment.location?.protocol === 'chrome-extension:' && Boolean(environment.chrome?.runtime?.id && environment.chrome?.runtime?.sendMessage);
}

function unwrapResponse(response) {
  if (!response?.success) {
    const error = new CloudError(response?.error || 'No se pudo completar la operación online.', response?.code || 'NETWORK');
    error.rateLimit = response?.rateLimit || null;
    throw error;
  }
  return response.data || {};
}

export async function runtimeRequest(action, payload = {}) {
  if (isExtensionContext()) {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...payload }, result => {
        if (chrome.runtime.lastError) reject(new CloudError('No se pudo comunicar con la extensión. Vuelve a abrirla.', 'NETWORK'));
        else resolve(result);
      });
    });
    return unwrapResponse(response);
  }
  let webRequest;
  try { ({ webRequest } = await import('./web-transport.js')); }
  catch { throw new CloudError('No se pudo cargar la conexión web. Recarga la página y vuelve a conectar.', 'NETWORK'); }
  return unwrapResponse(await webRequest(action, payload));
}

export class CloudClient {
  constructor(request = runtimeRequest) {
    this.rateLimit = null; this.onQuota = null;
    this.request = async (...args) => {
      try { const result = await request(...args); this.observeQuota(result?.rateLimit); return result; }
      catch (error) { this.observeQuota(error?.rateLimit); throw error; }
    };
    this.projectRef = null; this.libraryId = null;
    this.revision = 0; this.pending = 0; this.unsaved = false;
    this.blocked = null; this.lastSnapshot = null; this.queue = Promise.resolve(); this.generation = 0; this.changeSerial = 0; this.connected = false;
  }
  observeQuota(quota) {
    if (!quota || !Number.isFinite(quota.limit) || !Number.isFinite(quota.remaining)) return;
    this.rateLimit = { ...quota };
    this.onQuota?.(this.rateLimit);
  }
  async connect(token, projectRef, libraryId) {
    const generation = this.generation;
    if (this.pending || this.unsaved) throw new CloudError('Exporta o resuelve los cambios pendientes antes de conectar otra sesión.', 'PENDING');
    const result = await this.request('connect_cloud', { token, projectRef, libraryId });
    if (generation !== this.generation) throw new CloudError('Sesión cerrada.', 'NOT_CONNECTED');
    this.accept(result, { projectRef, libraryId }); return result;
  }
  identity() { return { projectRef: this.projectRef, libraryId: this.libraryId }; }
  accept(result, expected = this.identity()) {
    const responseLibrary = result.libraryId || result.snapshot?.libraryId;
    if (!expected.projectRef || !expected.libraryId || result.projectRef !== expected.projectRef || responseLibrary !== expected.libraryId) throw new CloudError('La sesión pertenece a otro proyecto o biblioteca. Reconecta esta ventana.', 'CONFIG_CHANGED');
    const revision = result.revision ?? result.snapshot?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1 || !result.snapshot || !Array.isArray(result.snapshot.voices) || !Array.isArray(result.snapshot.folders)) throw new CloudError('La biblioteca online devolvió datos no válidos.', 'VALIDATION');
    this.revision = revision; this.projectRef = result.projectRef; this.libraryId = result.libraryId || result.snapshot.libraryId; this.connected = true; return result;
  }
  async load({ discardPending = false } = {}) {
    if ((this.pending || this.unsaved) && !discardPending) throw new CloudError('Hay cambios locales pendientes de guardar.', 'PENDING');
    if (this.pending) throw new CloudError('Espera a que termine el guardado actual.', 'PENDING');
    const generation = this.generation;
    const changeSerial = this.changeSerial;
    const result = await this.request('load_cloud', this.identity());
    if (generation !== this.generation) throw new CloudError('Sesión cerrada.', 'NOT_CONNECTED');
    if (changeSerial !== this.changeSerial || this.pending || (this.unsaved && !discardPending)) throw new CloudError('Hay cambios locales pendientes de guardar.', 'PENDING');
    this.accept(result);
    if (discardPending) { this.unsaved = false; this.blocked = null; this.lastSnapshot = null; }
    return result;
  }
  save(data) {
    if (this.connected && this.revision < 1) return Promise.reject(new CloudError('Pulsa Actualizar antes de editar esta biblioteca: aún no hay una copia local válida.', 'CACHE_MISSING'));
    // Capture at invocation, before queued asynchronous work or UI mutation.
    const snapshot = cloneSnapshot(data);
    this.lastSnapshot = snapshot; this.unsaved = true; this.pending += 1; this.changeSerial += 1;
    const generation = this.generation;
    const persist = async () => {
      if (generation !== this.generation) throw new CloudError('Sesión cerrada.', 'NOT_CONNECTED');
      if (!this.connected) throw new CloudError('Conecta tu biblioteca antes de guardar.', 'NOT_CONNECTED');
      if (this.blocked) throw this.blocked;
      try {
        const result = await this.request('save_cloud', { ...this.identity(), data: snapshot, expectedVersion: this.revision });
        if (generation !== this.generation) throw new CloudError('Sesión cerrada.', 'NOT_CONNECTED');
        this.accept(result);
        if (this.lastSnapshot === snapshot) this.unsaved = false;
        return result;
      } catch (error) { this.blocked = error; throw error; }
    };
    const promise = this.queue.then(persist);
    this.queue = promise.catch(() => {});
    return promise.finally(() => { this.pending -= 1; });
  }
  retry() {
    if (this.blocked?.code === 'CONFLICT') return Promise.reject(this.blocked);
    if (!this.lastSnapshot) return Promise.resolve(null);
    this.blocked = null; return this.save(this.lastSnapshot);
  }
  async uploadCover(dataUrl) {
    if (!this.connected) throw new CloudError('Conecta la biblioteca antes de subir una portada.', 'NOT_CONNECTED');
    if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 710000) throw new CloudError('La portada debe ser PNG, JPEG o WebP y pesar menos de 512 KB.', 'VALIDATION');
    const generation = this.generation;
    const result = await this.request('upload_cover', { ...this.identity(), dataUrl });
    if (generation !== this.generation) throw new CloudError('Sesión cerrada.', 'NOT_CONNECTED');
    if (typeof result.path !== 'string' || !result.path || result.path.includes('..') || !safeAssetUrl(result.url, 'image')) throw new CloudError('La subida no devolvió una portada válida.', 'VALIDATION');
    return result;
  }
  async restore() {
    if (this.connected || this.pending || this.unsaved || this.revision !== 0) throw new CloudError('La sesión solo puede recuperarse antes de cargar o editar una biblioteca.', 'PENDING');
    const generation = this.generation;
    const result = await this.request('restore_cloud');
    if (generation !== this.generation) throw new CloudError('Sesión cerrada.', 'NOT_CONNECTED');
    if (this.connected || this.pending || this.unsaved || this.revision !== 0) throw new CloudError('La biblioteca cambió mientras se recuperaba la sesión.', 'PENDING');
    if (result.connected) {
      if (typeof result.projectRef !== 'string' || !result.projectRef || typeof result.libraryId !== 'string' || !result.libraryId) throw new CloudError('No se pudo recuperar la configuración de la sesión.', 'VALIDATION');
      const expected = { projectRef: result.projectRef, libraryId: result.libraryId };
      if (result.cacheAvailable) this.accept(result, expected);
      else { this.projectRef = result.projectRef; this.libraryId = result.libraryId; this.connected = true; }
    }
    return result;
  }
  status() { return this.request('cloud_status', this.identity()); }
  async disconnect() {
    this.generation += 1; await this.queue;
    try { await this.request('disconnect_cloud', this.identity()); }
    catch (error) { if (!['CONFIG_CHANGED', 'NOT_CONNECTED'].includes(error.code)) throw error; }
    this.connected = false; this.revision = 0; this.unsaved = false; this.blocked = null; this.lastSnapshot = null; this.projectRef = null; this.libraryId = null;
  }
}

export async function prepareCover(image, changed, previous, upload) {
  if (!changed && previous) return { coverImage: previous.coverImage || '', coverStoragePath: previous.coverStoragePath || '', coverExpiresAt: previous.coverExpiresAt || null };
  if (!image) return { coverImage: '', coverStoragePath: '', coverExpiresAt: null };
  if (image.startsWith('data:')) {
    const result = await upload(image);
    return { coverImage: result.url, coverStoragePath: result.path, coverExpiresAt: result.expiresAt };
  }
  const coverImage = safeAssetUrl(image, 'image');
  if (!coverImage) throw new CloudError('La portada no es válida.', 'VALIDATION');
  return { coverImage, coverStoragePath: '', coverExpiresAt: null };
}

export function safeAssetUrl(value, kind = 'link') {
  if (typeof value !== 'string' || !value) return '';
  if (kind === 'image' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  if (kind === 'audio' && /^data:audio\/(?:mpeg|mp3|wav|ogg|webm);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    if (['localhost', '0.0.0.0', '::1', '[::1]'].includes(url.hostname) || /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) return '';
    return url.href;
  } catch { return ''; }
}
