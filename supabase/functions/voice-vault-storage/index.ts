/** Private raster storage bridge. Runtime credentials are never returned or logged.
 * POST {action:'upload',libraryId,dataUrl} or {action:'sign',libraryId,paths:[...]}
 * Authorization is a user-supplied Supabase Management PAT, verified on every
 * valid operation against a fixed parameterized library-existence query.
 * Signing uses Management read-only permission; uploads require its write gate.
 */
export const BUCKET = 'voice-vault-images';
export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_DATA_URL_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EXPIRES_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERIFY_QUERY = 'SELECT EXISTS (SELECT 1 FROM public.libraries WHERE id = $1::uuid AND deleted_at IS NULL) AS allowed';
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

class RequestError extends Error {
  constructor(code, message, status = 400, details = null) { super(message); this.code = code; this.status = status; this.details = details; }
}
const invalid = message => { throw new RequestError('VALIDATION', message); };

function envValue(env, name) { return typeof env === 'function' ? env(name) : env?.[name]; }
function runtimeEnv(name) { return typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined; }

function projectConfig(env) {
  let url;
  try { url = new URL(envValue(env, 'SUPABASE_URL')); } catch { throw new RequestError('CONFIG', 'El servicio de imágenes no está configurado.', 503); }
  const ref = url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1];
  const serviceKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ref || typeof serviceKey !== 'string' || !serviceKey.trim()) throw new RequestError('CONFIG', 'El servicio de imágenes no está configurado.', 503);
  return { url: url.origin, ref, serviceKey };
}

function requestOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  // The standalone Pages app is trusted by exact origin only, never a suffix,
  // wildcard, preview domain or a caller-supplied website allowlist.
  if (origin === 'https://codebydante.github.io') return origin;
  const id = origin.match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1];
  if (!id) throw new RequestError('FORBIDDEN', 'Origen no autorizado.', 403);
  // A fixed unpacked-extension ID can be pinned with this optional runtime env.
  // Without it Chrome extension origins plus the exact Pages origin above may
  // reach PAT validation. Other website origins are always rejected.
  const trusted = String(envValue(env, 'VOICE_VAULT_EXTENSION_IDS') || '').split(',').map(value => value.trim()).filter(Boolean);
  if (trusted.length && !trusted.includes(id)) throw new RequestError('FORBIDDEN', 'Extensión no autorizada.', 403);
  return origin;
}

async function readJsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new RequestError('CONTENT_TYPE', 'Envía un documento JSON.', 415);
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new RequestError('TOO_LARGE', 'La solicitud supera el tamaño permitido.', 413);
  const reader = request.body?.getReader();
  if (!reader) invalid('Falta el contenido de la solicitud.');
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new RequestError('TOO_LARGE', 'La solicitud supera el tamaño permitido.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('El documento JSON no es válido.'); }
}

export function validateImage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL_LENGTH) invalid('La portada supera el tamaño permitido.');
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || !match[2] || match[2].length % 4 !== 0) invalid('Usa una imagen PNG, JPEG o WebP válida.');
  let decoded;
  try { decoded = atob(match[2]); } catch { invalid('La imagen no está codificada correctamente.'); }
  if (decoded.length > MAX_IMAGE_BYTES || decoded.length < 12 || btoa(decoded) !== match[2]) invalid('La imagen no tiene un tamaño o formato válido.');
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  const mime = match[1]; let extension;
  if (mime === 'image/png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value) || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') invalid('El contenido no es un PNG válido.');
    const view = new DataView(bytes.buffer); const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || width > 4096 || height > 4096) invalid('La portada debe medir como máximo 4096 × 4096 píxeles.');
    extension = 'png';
  } else if (mime === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) invalid('El contenido no es un JPEG válido.');
    extension = 'jpg';
  } else {
    if (bytes.length < 20 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP' || !['VP8 ', 'VP8L', 'VP8X'].includes(String.fromCharCode(...bytes.slice(12, 16)))) invalid('El contenido no es un WebP válido.');
    if (new DataView(bytes.buffer).getUint32(4, true) + 8 !== bytes.length) invalid('El archivo WebP está incompleto.');
    extension = 'webp';
  }
  return { bytes, mime, extension };
}

export function validatePaths(paths, libraryId) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 500) invalid('Solicita entre 1 y 500 imágenes.');
  const pattern = new RegExp('^' + libraryId + '/[a-f0-9]{64}\\.(?:png|jpe?g|webp)$');
  if (paths.some(path => typeof path !== 'string' || !pattern.test(path))) invalid('Una imagen no pertenece a esta biblioteca o su ruta no es válida.');
  return [...new Set(paths)];
}

function numberHeader(headers, name) {
  const value = headers.get(name);
  if (value == null || value.trim() === '') return null;
  const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null;
}
export function quotaFromHeaders(headers, status, now) {
  const limitHeader = numberHeader(headers, 'X-RateLimit-Limit');
  const remainingHeader = numberHeader(headers, 'X-RateLimit-Remaining');
  const reset = numberHeader(headers, 'X-RateLimit-Reset');
  const server = Number.isSafeInteger(limitHeader) && limitHeader > 0 && Number.isSafeInteger(remainingHeader) && remainingHeader <= limitHeader && reset != null;
  const limit = server ? limitHeader : 120;
  const remaining = status === 429 ? 0 : server ? remainingHeader : 119;
  let resetAt = now + (server ? reset * 1000 : 60_000);
  if (status === 429) {
    const raw = headers.get('Retry-After');
    const seconds = raw == null ? NaN : Number(raw);
    const retry = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(raw);
    if (Number.isFinite(retry)) resetAt = Math.max(resetAt, retry);
  }
  return { limit, remaining, used: limit - remaining, resetAt, observedAt: now, source: server ? 'server' : 'estimate' };
}

async function timedFetch(fetcher, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try { return await fetcher(url, { ...options, signal: controller.signal, redirect: 'manual' }); }
  finally { clearTimeout(timeout); }
}

async function storageFailure(response, stage, message) {
  let payload = null;
  try { payload = await response.json(); } catch { /* Never forward raw provider text. */ }
  const rawCode = typeof payload?.code === 'string' ? payload.code : typeof payload?.error === 'string' ? payload.error : '';
  const normalized = rawCode.toLowerCase().replace(/[ _-]/g, '');
  const codes = {
    nosuchbucket: 'NoSuchBucket', bucketnotfound: 'NoSuchBucket', notfound: 'not_found',
    nosuchkey: 'NoSuchKey', accessdenied: 'AccessDenied', unauthorized: 'Unauthorized',
    invalidjwt: 'InvalidJWT', invalidtoken: 'InvalidToken', invalidsignature: 'InvalidSignature',
    internalerror: 'InternalError', invalidrequest: 'InvalidRequest', databaseerror: 'DatabaseError',
    keyalreadyexists: 'KeyAlreadyExists', resourcealreadyexists: 'ResourceAlreadyExists',
    entitytoolarge: 'EntityTooLarge', invalidmimetype: 'InvalidMimeType', storagequotaexceeded: 'StorageQuotaExceeded',
  };
  const storageCode = codes[normalized] || 'UNKNOWN';
  // Legacy Storage deployments use HTTP400 around a structured404 envelope.
  // Do not mistake an arbitrary400/authorization failure for a missing bucket.
  const missingBucket = stage === 'bucket_get' && (response.status === 404 || (response.status === 400 && String(payload?.statusCode) === '404' && ['NoSuchBucket', 'not_found'].includes(storageCode)));
  return { missingBucket, error: new RequestError('STORAGE', message, 502, { stage, upstreamStatus: response.status, storageCode }) };
}

function signedImage(value, path, config, expiresAt) {
  if (typeof value !== 'string') throw new RequestError('STORAGE', 'No se pudo generar el enlace de la portada.', 502);
  let url;
  try { url = new URL(value.startsWith('/object/') ? '/storage/v1' + value : value, config.url); }
  catch { throw new RequestError('STORAGE', 'No se pudo generar el enlace de la portada.', 502); }
  if (url.origin !== config.url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/storage/v1/object/sign/' + BUCKET + '/' + path || !url.searchParams.get('token')) throw new RequestError('STORAGE', 'No se pudo generar el enlace de la portada.', 502);
  return { path, url: url.href, expiresAt };
}

export function createHandler({ env = runtimeEnv, fetcher = fetch, now = () => Date.now(), cryptoProvider = globalThis.crypto } = {}) {
  return async request => {
    let origin = null; let rateLimit = null;
    const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    } });
    try {
      origin = requestOrigin(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}), Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Cache-Control': 'no-store',
      } });
      if (request.method !== 'POST') throw new RequestError('METHOD', 'Operación no admitida.', 405);
      const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]{20,4096})$/i)?.[1];
      if (!token) throw new RequestError('AUTH', 'Falta un token de administración válido.', 401);
      const data = await readJsonBody(request);
      if (!data || typeof data !== 'object' || Array.isArray(data) || !UUID.test(data.libraryId || '')) invalid('La biblioteca no es válida.');
      const libraryId = data.libraryId.toLowerCase();
      if (!['upload', 'sign'].includes(data.action)) invalid('La operación no es válida.');
      const image = data.action === 'upload' ? validateImage(data.dataUrl) : null;
      const paths = data.action === 'sign' ? validatePaths(data.paths, libraryId) : null;
      const config = projectConfig(env);
      // This is the only Management API query. Callers cannot supply SQL or a ref.
      const authorization = await timedFetch(fetcher, 'https://api.supabase.com/v1/projects/' + config.ref + '/database/query', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        // SQL is always a fixed SELECT. The Management permission gate must
        // additionally authorize writes before the service role uploads bytes.
        body: JSON.stringify({ query: VERIFY_QUERY, parameters: [libraryId], read_only: data.action === 'sign' }),
      });
      rateLimit = quotaFromHeaders(authorization.headers, authorization.status, now());
      if (authorization.status === 429) throw new RequestError('RATE_LIMIT', 'Se alcanzó el límite de consultas. Espera al reinicio del contador.', 429);
      if (authorization.status === 401 || authorization.status === 403) throw new RequestError('AUTH', 'No se pudo autorizar el acceso a esta biblioteca.', 403);
      if (!authorization.ok) throw new RequestError('AUTH', 'No se pudo verificar el acceso a la biblioteca.', 502);
      let check;
      try { check = await authorization.json(); } catch { throw new RequestError('AUTH', 'No se pudo verificar el acceso a la biblioteca.', 502); }
      if (!Array.isArray(check) || check[0]?.allowed !== true) throw new RequestError('LIBRARY', 'La biblioteca no existe o no está disponible.', 404);
      const storage = async (path, options = {}) => {
        const result = await timedFetch(fetcher, config.url + '/storage/v1' + path, { ...options, headers: {
          Authorization: 'Bearer ' + config.serviceKey, apikey: config.serviceKey, ...options.headers,
        } });
        if (result.status === 429) throw new RequestError('RATE_LIMIT', 'El servicio de imágenes está ocupado. Intenta más tarde.', 429);
        return result;
      };
      // Check private-bucket policy for signing too, not only new uploads.
      {
        const bucket = await storage('/bucket/' + BUCKET);
        const bucketFailure = !bucket.ok ? await storageFailure(bucket, 'bucket_get', 'No se pudo consultar el almacén de imágenes.') : null;
        if (bucketFailure?.missingBucket) {
          // A read-only PAT may sign existing private objects, never create or
          // reconfigure a bucket through this service's elevated credential.
          if (data.action !== 'upload') throw bucketFailure.error;
          const created = await storage('/bucket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_IMAGE_BYTES, allowed_mime_types: MIME_TYPES }) });
          if (!created.ok && created.status !== 409) throw (await storageFailure(created, 'bucket_create', 'No se pudo preparar el almacén privado de imágenes.')).error;
          if (created.status === 409) {
            const secured = await storage('/bucket/' + BUCKET, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: false, file_size_limit: MAX_IMAGE_BYTES, allowed_mime_types: MIME_TYPES }) });
            if (!secured.ok) throw (await storageFailure(secured, 'bucket_secure', 'No se pudo verificar el almacén privado de imágenes.')).error;
          }
        } else {
          if (bucketFailure) throw bucketFailure.error;
          let detail; try { detail = await bucket.json(); } catch { throw new RequestError('STORAGE', 'El almacén de imágenes no respondió correctamente.', 502); }
          if (data.action === 'sign' && detail.public !== false) throw new RequestError('STORAGE', 'El almacén debe ser privado antes de leer las portadas.', 502, { stage: 'bucket_policy', upstreamStatus: bucket.status, storageCode: 'BucketNotPrivate' });
          if (data.action === 'upload' && (detail.public !== false || detail.file_size_limit !== MAX_IMAGE_BYTES || JSON.stringify(detail.allowed_mime_types) !== JSON.stringify(MIME_TYPES))) {
            const secured = await storage('/bucket/' + BUCKET, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: false, file_size_limit: MAX_IMAGE_BYTES, allowed_mime_types: MIME_TYPES }) });
            if (!secured.ok) throw (await storageFailure(secured, 'bucket_secure', 'No se pudo asegurar el almacén privado de imágenes.')).error;
          }
        }
      }
      if (data.action === 'upload') {
        const digest = new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', image.bytes));
        const hash = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const path = libraryId + '/' + hash + '.' + image.extension;
        const uploaded = await storage('/object/' + BUCKET + '/' + path, { method: 'POST', headers: { 'Content-Type': image.mime, 'x-upsert': 'true', 'Cache-Control': 'max-age=3600' }, body: image.bytes });
        if (!uploaded.ok) throw (await storageFailure(uploaded, 'object_upload', 'No se pudo subir la portada. Los datos de la biblioteca no se modificaron.')).error;
        const signed = await storage('/object/sign/' + BUCKET + '/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: EXPIRES_SECONDS }) });
        if (!signed.ok) throw (await storageFailure(signed, 'object_sign', 'La portada se subió, pero no se pudo crear su enlace temporal.')).error;
        let result; try { result = await signed.json(); } catch { throw new RequestError('STORAGE', 'No se pudo leer el enlace temporal de la portada.', 502); }
        return response({ success: true, ...signedImage(result.signedURL || result.signedUrl, path, config, now() + EXPIRES_SECONDS * 1000), rateLimit });
      }
      const signed = await storage('/object/sign/' + BUCKET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: EXPIRES_SECONDS, paths }) });
      if (!signed.ok) throw (await storageFailure(signed, 'objects_sign', 'No se pudieron crear los enlaces temporales de las portadas.')).error;
      let result; try { result = await signed.json(); } catch { throw new RequestError('STORAGE', 'No se pudieron leer los enlaces de las portadas.', 502); }
      if (!Array.isArray(result)) throw new RequestError('STORAGE', 'El almacén no respondió con enlaces válidos.', 502);
      const expiresAt = now() + EXPIRES_SECONDS * 1000;
      const requested = new Set(paths);
      const images = result.filter(item => requested.has(item.path) && !item.error && (item.signedURL || item.signedUrl)).map(item => signedImage(item.signedURL || item.signedUrl, item.path, config, expiresAt));
      return response({ success: true, images, rateLimit });
    } catch (error) {
      const known = error instanceof RequestError;
      return response({ success: false, code: known ? error.code : 'NETWORK', error: known ? error.message : 'No se pudo completar la operación de imágenes.', rateLimit, ...(known && error.details ? { details: error.details } : {}) }, known ? error.status : 502);
    }
  };
}

export default createHandler;
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(createHandler());
