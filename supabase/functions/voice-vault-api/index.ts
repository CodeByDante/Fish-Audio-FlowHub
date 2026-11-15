/** Browser-safe fixed-operation relay. Generated siblings are copied from the
 * canonical cloud core / bootstrap SQL before deployment; never accept SQL from
 * a browser. The caller's Management PAT is used only for the fixed Supabase
 * Management project endpoint and is never persisted, returned or logged.
 */
import * as sharedCore from './cloud-core.js';
import { BOOTSTRAP_SQL as bundledBootstrapSql } from './bootstrap-sql.js';

const MAX_REQUEST_BYTES = 26 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 26 * 1024 * 1024;
const OPERATIONS = new Set(['probe', 'bootstrap', 'seed', 'load', 'save']);
const RATE_HEADERS = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];
const EXPOSE_HEADERS = [...RATE_HEADERS, 'Retry-After', 'X-Vault-Management-Requests'].join(', ');

class ApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const envGet = (env, name) => typeof env === 'function' ? env(name) : env?.[name];
const runtimeEnv = name => typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined;

function projectRef(env) {
  let url;
  try { url = new URL(envGet(env, 'SUPABASE_URL')); } catch { throw new ApiError('CONFIG', 'El servicio online no está configurado.', 503); }
  const ref = url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ref) throw new ApiError('CONFIG', 'El servicio online no está configurado.', 503);
  return ref;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || origin === 'https://codebydante.github.io') return origin;
  const id = origin.match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1];
  if (!id) throw new ApiError('FORBIDDEN', 'Origen no autorizado.', 403);
  const pins = String(envGet(env, 'VOICE_VAULT_EXTENSION_IDS') || '').split(',').map(id => id.trim()).filter(Boolean);
  if (pins.length && !pins.includes(id)) throw new ApiError('FORBIDDEN', 'Extensión no autorizada.', 403);
  return origin;
}

async function boundedBody(body, maximum) {
  const reader = body?.getReader();
  if (!reader) return '';
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel(); throw new ApiError('TOO_LARGE', 'El documento supera el tamaño permitido.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function requestData(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new ApiError('CONTENT_TYPE', 'Envía un documento JSON.', 415);
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new ApiError('TOO_LARGE', 'El documento supera el tamaño permitido.', 413);
  try { return JSON.parse(await boundedBody(request.body, MAX_REQUEST_BYTES)); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('VALIDATION', 'El documento JSON no es válido.'); }
}

function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function jsonObject(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Return only known row envelopes; malformed successful upstream data is an error. */
function validatedRows(operation, payload, config, core) {
  if (!Array.isArray(payload)) throw new ApiError('NETWORK', 'La respuesta online no tiene un formato válido.', 502);
  if (operation === 'bootstrap') return [];
  if (operation === 'load' || operation === 'save') {
    let decoded;
    try { decoded = core.decodeSnapshot(payload); }
    catch { throw new ApiError('NETWORK', 'La biblioteca recibida no tiene un formato válido.', 502); }
    const snapshot = decoded.snapshot;
    if (typeof snapshot.libraryId !== 'string' || snapshot.libraryId.toLowerCase() !== config.libraryId) throw new ApiError('CONFIG_CHANGED', 'La respuesta pertenece a otra biblioteca.', 409);
    return [{ snapshot }];
  }
  if (operation === 'probe') {
    const state = jsonObject(payload[0]?.schema_state);
    if (!state || !['empty', 'compatible', 'incompatible'].includes(state.state)) throw new ApiError('NETWORK', 'No se pudo comprobar la configuración del proyecto.', 502);
    const clean = { state: state.state };
    for (const key of ['tablesPresent', 'invalidColumns', 'invalidFunctions', 'invalidTriggers', 'primaryKeys', 'isolatedFolderForeignKeys']) {
      if (state[key] !== undefined) {
        if (!count(state[key])) throw new ApiError('NETWORK', 'La comprobación del proyecto no es válida.', 502);
        clean[key] = state[key];
      }
    }
    return [{ schema_state: clean }];
  }
  const seed = jsonObject(payload[0]?.seed_result);
  if (!seed || typeof seed.createdLibrary !== 'boolean' || typeof seed.libraryAvailable !== 'boolean' || !count(seed.createdFolders) || seed.createdFolders > 3) throw new ApiError('NETWORK', 'No se pudo comprobar la biblioteca creada.', 502);
  return [{ seed_result: { createdLibrary: seed.createdLibrary, createdFolders: seed.createdFolders, libraryAvailable: seed.libraryAvailable } }];
}

function upstreamFailure(status, text) {
  if (status === 429) return new ApiError('RATE_LIMIT', 'Se alcanzó el límite de consultas. Espera al reinicio del contador.', 429);
  if (status === 401 || status === 403) return new ApiError('AUTH', 'No se pudo autorizar el acceso. Revisa el token y sus permisos.', status);
  if (/VAULT_REVISION_CONFLICT|\b40001\b/.test(text)) return new ApiError('CONFLICT', 'La biblioteca cambió en otro dispositivo. Recarga antes de guardar.', 409);
  if (/VAULT_SCHEMA_INCOMPATIBLE/.test(text)) return new ApiError('SCHEMA_INCOMPATIBLE', 'El proyecto contiene tablas o funciones incompatibles. No se cambió ni eliminó ningún dato.', 409);
  if (/Library unavailable|VAULT_LIBRARY_MISSING/.test(text)) return new ApiError('LIBRARY_MISSING', 'La biblioteca solicitada no está disponible.', 404);
  return new ApiError('NETWORK', 'No se pudo completar la operación online.', 502);
}

export function createApiHandler({ env = runtimeEnv, fetcher = fetch, now = () => Date.now(), core = sharedCore, bootstrapSql = bundledBootstrapSql } = {}) {
  return async request => {
    let origin = null; let rateLimit = null; let managementRequests = 0;
    const actualHeaders = {};
    const headers = () => ({
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
      'Access-Control-Expose-Headers': EXPOSE_HEADERS, 'X-Vault-Management-Requests': String(managementRequests), ...actualHeaders,
    });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: headers() });
    try {
      origin = allowedOrigin(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers() });
      if (request.method !== 'POST') throw new ApiError('METHOD', 'Operación no admitida.', 405);
      const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]{20,4096})$/i)?.[1];
      if (!token) throw new ApiError('AUTH', 'Falta un token de administración válido.', 401);
      const data = await requestData(request);
      if (!data || typeof data !== 'object' || Array.isArray(data) || !OPERATIONS.has(data.operation)) throw new ApiError('VALIDATION', 'La operación no es válida.');
      const config = core.validateConnection({ token, projectRef: projectRef(env), libraryId: data.libraryId });
      // Browser data/query/sql/read_only fields cannot replace the server bundle.
      const body = core.queryBody(data.operation, config.libraryId, data.operation === 'bootstrap' ? bootstrapSql : data.data, data.expectedVersion);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let upstream; let text;
      try {
        managementRequests = 1;
        upstream = await fetcher('https://api.supabase.com/v1/projects/' + config.projectRef + '/database/query', {
          method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body), redirect: 'manual', signal: controller.signal,
        });
        const observedAt = now();
        const record = core.observeRateLimit(core.beginRateLimitRequest(null, observedAt), upstream.headers, upstream.status, observedAt);
        rateLimit = core.rateLimitView(record, observedAt);
        for (const name of RATE_HEADERS) {
          const value = upstream.headers.get(name);
          if (value != null && /^\d+(?:\.\d+)?$/.test(value.trim())) actualHeaders[name] = value.trim();
        }
        const retry = upstream.headers.get('Retry-After');
        if (retry && retry.length <= 128 && (/^\d+(?:\.\d+)?$/.test(retry.trim()) || Number.isFinite(Date.parse(retry)))) actualHeaders['Retry-After'] = retry;
        text = await boundedBody(upstream.body, MAX_RESPONSE_BYTES);
      } finally { clearTimeout(timeout); }
      if (!upstream.ok) throw upstreamFailure(upstream.status, text);
      let payload;
      try { payload = JSON.parse(text); } catch { throw new ApiError('NETWORK', 'La respuesta online no es válida.', 502); }
      return json(validatedRows(data.operation, payload, config, core));
    } catch (error) {
      const known = error instanceof ApiError;
      const validation = error instanceof core.CloudError && ['VALIDATION', 'CONFIG_CHANGED'].includes(error.code);
      const code = known || validation ? error.code : 'NETWORK';
      const message = known || validation ? error.message : 'No se pudo completar la operación online.';
      const status = known ? error.status : validation ? error.code === 'CONFIG_CHANGED' ? 409 : 400 : 502;
      return json({ success: false, code, error: message, rateLimit }, status);
    }
  };
}

export default createApiHandler;
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(createApiHandler());
