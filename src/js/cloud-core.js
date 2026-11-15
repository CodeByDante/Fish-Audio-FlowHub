/** Pure protocol validation. The administrator token is never part of a snapshot. */
export class CloudError extends Error {
  constructor(code, message, rateLimit = null) { super(message); this.name = 'CloudError'; this.code = code; if (rateLimit) this.rateLimit = rateLimit; }
}
const fail = message => { throw new CloudError('VALIDATION', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const field = (value, maximum, label, required = false) => {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) fail(`${label}: valor no válido.`);
  return value;
};
export function validateConnection(input) {
  if (!object(input)) fail('Falta la configuración de conexión.');
  const token = field(input.token, 4096, 'Token', true).trim();
  if (!/^[A-Za-z0-9_.-]{20,4096}$/.test(token)) fail('El token no tiene un formato válido.');
  if (!/^[a-z0-9]{20}$/.test(input.projectRef || '')) fail('Referencia del proyecto no válida.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.libraryId || '')) fail('Biblioteca no válida.');
  return { token, projectRef: input.projectRef, libraryId: input.libraryId.toLowerCase() };
}
export function assertConnectionIdentity(connection, expected) {
  const valid = expected && /^[a-z0-9]{20}$/.test(expected.projectRef || '')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.libraryId || '');
  if (!valid || (connection && (connection.projectRef !== expected.projectRef || connection.libraryId.toLowerCase() !== expected.libraryId.toLowerCase()))) {
    throw new CloudError('CONFIG_CHANGED', 'La conexión cambió en otra pestaña. Vuelve a conectar esta biblioteca antes de continuar.');
  }
}
export function validateId(value, label = 'ID') {
  field(value, 200, label, true);
  if (value !== value.trim()) fail(`${label}: no debe tener espacios externos.`);
  return value;
}
export function httpsUrl(value, label, max = 4096, optional = false) {
  if (optional && value === '') return '';
  field(value, max, label, true);
  let url;
  try { url = new URL(value); } catch { fail(`${label}: enlace no válido.`); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(`${label}: usa HTTPS sin credenciales.`);
  return value;
}
export function validateSnapshot(data) {
  if (!object(data) || !Array.isArray(data.folders) || !Array.isArray(data.voices) || !object(data.settings)) fail('La copia debe incluir carpetas, voces y ajustes completos.');
  if (data.folders.length > 5000 || data.voices.length > 50000) fail('La biblioteca supera el tamaño permitido.');
  let serialized;
  try { serialized = JSON.stringify(data); } catch { fail('La copia no se puede serializar.'); }
  if (new TextEncoder().encode(serialized).length > 25_000_000) fail('La copia supera los 25 MB permitidos.');
  if (new TextEncoder().encode(JSON.stringify(data.settings)).length > 65536) fail('Los ajustes superan el tamaño permitido.');
  const folders = new Set();
  for (const item of data.folders) {
    if (!object(item)) fail('Carpeta no válida.');
    validateId(item.id, 'ID de carpeta');
    field(item.name, 200, 'Nombre de carpeta', true);
    if (folders.has(item.id)) fail('Hay IDs de carpeta duplicados.');
    folders.add(item.id);
  }
  const ids = new Set();
  for (const item of data.voices) {
    if (!object(item)) fail('Voz no válida.');
    validateId(item.id, 'ID de voz');
    if (ids.has(item.id)) fail('Hay IDs de voz duplicados.');
    ids.add(item.id);
    field(item.title ?? item.name, 500, 'Título', true);
    httpsUrl(item.url, 'Enlace de voz');
    httpsUrl(item.audioUrl ?? item.sampleAudio ?? '', 'Enlace de audio', 16384, true);
    if (item.coverImage !== undefined) field(item.coverImage, 2000000, 'Portada');
    const coverPath = coverStoragePath(item, data.libraryId);
    if (coverPath) validateCoverPath(coverPath, data.libraryId);
    if (item.notes !== undefined) field(item.notes, 50000, 'Notas');
    if (item.isFavorite !== undefined && typeof item.isFavorite !== 'boolean') fail('El estado favorito debe ser booleano.');
    if (item.folderId != null && item.folderId !== '' && item.folderId !== 'f_sueltas') {
      if (['all', 'f_favorites'].includes(item.folderId) || !folders.has(item.folderId)) fail('La voz apunta a una carpeta inexistente o virtual.');
    }
  }
  return data;
}
export function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('Falta una revisión válida. Recarga la biblioteca.');
  return value;
}
export const QUERIES = Object.freeze({
  load: 'SELECT public.vault_export_snapshot($1::uuid) AS snapshot',
  save: 'SELECT public.vault_apply_snapshot($1::uuid, $2::bigint, $3::jsonb) AS snapshot',
  seed: 'WITH locked AS MATERIALIZED (SELECT pg_catalog.pg_advisory_xact_lock(981376142)),\ncreated AS (\n INSERT INTO public.libraries(id,owner_id,name,metadata)\n SELECT $1::uuid,NULL,\'Fish Audio Voice Vault\',\'{"settings":{"showQuickFolderBadge":false,"showSidebarFolders":true},"bootstrapVersion":1}\'::jsonb FROM locked\n ON CONFLICT(id) DO NOTHING RETURNING id),\nseeded AS (\n INSERT INTO public.folders(library_id,id,name,kind,sort_order)\n SELECT c.id,f.id,f.name,f.kind,f.sort_order FROM created c CROSS JOIN\n (VALUES(\'all\',\'Todas\',\'virtual\',0),(\'f_favorites\',\'Favoritas\',\'virtual\',1),(\'f_sueltas\',\'Voces Sueltas\',\'unassigned\',2)) f(id,name,kind,sort_order)\n RETURNING id)\nSELECT jsonb_build_object(\'createdLibrary\',EXISTS(SELECT 1 FROM created),\'createdFolders\',(SELECT count(*) FROM seeded),\n \'libraryAvailable\',EXISTS(SELECT 1 FROM created) OR EXISTS(SELECT 1 FROM public.libraries WHERE id=$1::uuid AND deleted_at IS NULL)) AS seed_result'
});
export function queryBody(action, libraryId, data, expectedVersion) {
  if (!/^[0-9a-f-]{36}$/i.test(libraryId || '')) fail('Biblioteca no válida.');
  // Administrator-only RPCs intentionally run as the PAT's write-authorized
  // postgres role; read_only mode switches roles and cannot execute these RPCs.
  if (action === 'probe') return {query:SCHEMA_PROBE_SQL,read_only:false};
  if (action === 'seed') return {query:QUERIES.seed,parameters:[libraryId],read_only:false};
  if (action === 'bootstrap') {
    if (typeof data !== 'string' || !data.startsWith('-- Voice Vault bundled bootstrap v1.') || data.length > 200000) fail('El paquete de configuración no está disponible.');
    return {query:data,read_only:false};
  }
  if (action === 'load') return { query: QUERIES.load, parameters: [libraryId], read_only: false };
  if (action !== 'save') fail('Operación no admitida.');
  validateSnapshot(data); validateRevision(expectedVersion);
  if (data.libraryId != null && (typeof data.libraryId !== 'string' || data.libraryId.toLowerCase() !== libraryId.toLowerCase())) throw new CloudError('CONFIG_CHANGED', 'La copia pertenece a otra biblioteca. Vuelve a cargar antes de guardar.');
  const payload = snapshotForSave(data, libraryId);
  return { query: QUERIES.save, parameters: [libraryId, expectedVersion, JSON.stringify(payload)], read_only: false };
}
export function decodeSnapshot(response) {
  const snapshot = Array.isArray(response) ? response[0]?.snapshot : response?.snapshot;
  const value = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
  validateSnapshot(value);
  const revision = Number(value.revision);
  validateRevision(revision);
  return { snapshot: { ...value, revision }, revision };
}
export function safeError(error, status = 0) {
  if (error instanceof CloudError) return { success: false, code: error.code, error: error.message, ...(error.rateLimit ? { rateLimit: error.rateLimit } : {}) };
  if (status === 401 || status === 403) return { success: false, code: 'AUTH', error: 'No se pudo autorizar el acceso. Revisa el token y sus permisos.' };
  return { success: false, code: 'NETWORK', error: 'No se pudo completar la consulta online. Los cambios locales se conservan.' };
}


const DEFAULT_RATE_LIMIT = 120;
const WINDOW_MS = 60000;
const finite = value => Number.isFinite(value) && value >= 0;
function recentAttempts(record, now) {
  return (Array.isArray(record?._attempts) ? record._attempts : []).filter(value => finite(value) && value > now - WINDOW_MS && value <= now);
}
/** No network request: this view is safe to send to extension UI contexts. */
export function rateLimitView(record, now = Date.now()) {
  const attempts = recentAttempts(record, now);
  const limit = Number.isSafeInteger(record?.limit) && record.limit > 0 ? record.limit : DEFAULT_RATE_LIMIT;
  const observedAt = finite(record?.observedAt) ? record.observedAt : now;
  const requestsThisSession = Number.isSafeInteger(record?.requestsThisSession) ? record.requestsThisSession : 0;
  if (record && record.resetAt > now && finite(record.remaining)) {
    const remaining = Math.max(0, Math.min(limit, record.remaining));
    return { limit, remaining, used: limit - remaining, resetAt: record.resetAt, observedAt, source: record.source === 'server' ? 'server' : 'estimate', requestsThisSession };
  }
  const remaining = Math.max(0, limit - attempts.length);
  return { limit, remaining, used: limit - remaining, resetAt: attempts.length ? attempts[0] + WINDOW_MS : now + WINDOW_MS, observedAt, source: 'estimate', requestsThisSession };
}
/** Count one outgoing Management HTTP request, never the number of returned rows. */
export function beginRateLimitRequest(previous, now = Date.now()) {
  const view = rateLimitView(previous, now);
  if (previous && previous.resetAt > now && view.remaining === 0) {
    throw new CloudError('RATE_LIMIT', 'Límite de consultas alcanzado. Espera a que termine el contador; los cambios pendientes se conservan.', view);
  }
  const attempts = recentAttempts(previous, now);
  attempts.push(now);
  const activeWindow = previous && previous.resetAt > now;
  return {
    ...view,
    remaining: activeWindow ? Math.max(0, view.remaining - 1) : Math.max(0, view.limit - attempts.length),
    used: activeWindow ? Math.min(view.limit, view.used + 1) : Math.min(view.limit, attempts.length),
    resetAt: activeWindow ? view.resetAt : attempts[0] + WINDOW_MS,
    observedAt: now, source: 'estimate', requestsThisSession: view.requestsThisSession + 1,
    _attempts: attempts
  };
}
function headerNumber(headers, name) {
  const raw = headers?.get?.(name);
  if (raw == null || String(raw).trim() === '') return null;
  const number = Number(raw);
  return finite(number) ? number : null;
}
/** X-RateLimit-Reset is SECONDS REMAINING, not an epoch timestamp. */
export function observeRateLimit(record, headers, status = 200, now = Date.now()) {
  const limit = headerNumber(headers, 'X-RateLimit-Limit');
  const remaining = headerNumber(headers, 'X-RateLimit-Remaining');
  const resetSeconds = headerNumber(headers, 'X-RateLimit-Reset');
  let result = { ...record, source: 'estimate', observedAt: now };
  if (Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(remaining) && remaining <= limit && resetSeconds != null) {
    result = { ...result, limit, remaining, used: limit - remaining, resetAt: now + resetSeconds * 1000, source: 'server' };
  }
  if (status === 429) {
    const retry = headers?.get?.('Retry-After');
    let retryAt = null;
    if (retry != null && String(retry).trim() !== '') {
      const seconds = Number(retry);
      if (finite(seconds)) retryAt = now + seconds * 1000;
      else { const parsed = Date.parse(retry); if (Number.isFinite(parsed) && parsed > now) retryAt = parsed; }
    }
    result.remaining = 0;
    result.used = result.limit;
    result.resetAt = Math.max(result.resetAt > now ? result.resetAt : now + WINDOW_MS, retryAt || 0);
  }
  return result;
}


export const COVER_STORAGE_PREFIX = 'storage://voice-vault-images/';
export function validateCoverPath(path, libraryId = null) {
  if (typeof path !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-f0-9]{64}\.(?:png|jpg|jpeg|webp)$/.test(path)) fail('Ruta de portada no válida.');
  if (libraryId && path.split('/')[0] !== libraryId.toLowerCase()) fail('La portada pertenece a otra biblioteca.');
  return path;
}
export function coverStoragePath(voice, libraryId = null) {
  if (voice.coverStoragePath !== undefined && typeof voice.coverStoragePath !== 'string') fail('Ruta de portada no válida.');
  const explicit = voice.coverStoragePath || '';
  const reference = typeof voice.coverImage === 'string' && voice.coverImage.startsWith(COVER_STORAGE_PREFIX) ? voice.coverImage.slice(COVER_STORAGE_PREFIX.length) : '';
  return explicit || reference ? validateCoverPath(explicit || reference, libraryId) : '';
}
/** Signed URLs/expiry are transient; only stable references are sent for persistence. */
export function snapshotForSave(data, libraryId) {
  return { ...data, voices: data.voices.map(voice => {
    const result = { ...voice };
    delete result.coverExpiresAt;
    const path = coverStoragePath(voice, libraryId);
    if (path) { result.coverStoragePath = path; result.coverImage = ''; }
    return result;
  }) };
}
export function validateCoverDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 699180) fail('La portada debe ser una imagen PNG, JPEG o WebP de hasta 512 KB.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) fail('La portada no tiene un formato válido.');
  let decoded;
  try { decoded = atob(match[2]); } catch { fail('La portada no tiene un formato válido.'); }
  if (!decoded.length || decoded.length > 524288 || btoa(decoded) !== match[2]) fail('La portada no tiene un tamaño o codificación válido.');
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  const starts = sequence => sequence.every((byte,index) => bytes[index] === byte);
  if (match[1] === 'png') {
    if (bytes.length < 24 || !starts([137,80,78,71,13,10,26,10]) || decoded.slice(12,16) !== 'IHDR') fail('El archivo no es una imagen PNG válida.');
    const view = new DataView(bytes.buffer);
    if (view.getUint32(16) < 1 || view.getUint32(20) < 1 || view.getUint32(16) > 4096 || view.getUint32(20) > 4096) fail('La portada supera las dimensiones permitidas.');
  } else if (match[1] === 'jpeg') {
    if (bytes.length < 4 || !starts([255,216,255]) || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('El archivo no es una imagen JPEG válida.');
  } else if (bytes.length < 12 || decoded.slice(0,4) !== 'RIFF' || decoded.slice(8,12) !== 'WEBP') fail('El archivo no es una imagen WebP válida.');
  return dataUrl;
}
export function validateSignedCover(image, config) {
  if (!image || typeof image !== 'object') fail('Respuesta de portada no válida.');
  validateCoverPath(image.path, config.libraryId);
  httpsUrl(image.url, 'Portada firmada', 16384);
  const url = new URL(image.url);
  if (url.hostname !== `${config.projectRef}.supabase.co` || !decodeURIComponent(url.pathname).endsWith(`/storage/v1/object/sign/voice-vault-images/${image.path}`)) fail('La portada firmada pertenece a otro destino.');
  if (!Number.isFinite(image.expiresAt) || image.expiresAt <= Date.now()) fail('El enlace de portada ha caducado.');
  return { path: image.path, url: image.url, expiresAt: image.expiresAt };
}
export function adoptRemoteRateLimit(record, remote, now = Date.now()) {
  if (!remote || !Number.isSafeInteger(remote.limit) || remote.limit < 1 || !Number.isSafeInteger(remote.remaining) || remote.remaining < 0 || remote.remaining > remote.limit || !Number.isFinite(remote.resetAt)) return record;
  return { ...record, limit: remote.limit, remaining: remote.remaining, used: remote.limit - remote.remaining, resetAt: remote.resetAt,
    observedAt: Number.isFinite(remote.observedAt) ? remote.observedAt : now,
    source: remote.source === 'server' ? 'server' : 'estimate' };
}


/** Fixed catalog-only compatibility probe; never queries absent application tables. */
export const SCHEMA_PROBE_SQL = "WITH expected_tables(name) AS (VALUES ('libraries'),('folders'),('voices'),('user_settings')),\nexpected_columns(table_name,column_name,type_name) AS (VALUES\n('libraries','id','uuid'),\n('libraries','owner_id','uuid'),\n('libraries','name','text'),\n('libraries','metadata','jsonb'),\n('libraries','created_at','timestamptz'),\n('libraries','updated_at','timestamptz'),\n('libraries','version','int8'),\n('libraries','deleted_at','timestamptz'),\n('folders','library_id','uuid'),\n('folders','id','text'),\n('folders','name','text'),\n('folders','kind','text'),\n('folders','sort_order','int4'),\n('folders','metadata','jsonb'),\n('folders','created_at','timestamptz'),\n('folders','updated_at','timestamptz'),\n('folders','version','int8'),\n('folders','deleted_at','timestamptz'),\n('voices','library_id','uuid'),\n('voices','id','text'),\n('voices','title','text'),\n('voices','url','text'),\n('voices','audio_url','text'),\n('voices','cover_image','text'),\n('voices','folder_id','text'),\n('voices','notes','text'),\n('voices','is_favorite','bool'),\n('voices','metadata','jsonb'),\n('voices','created_at','timestamptz'),\n('voices','updated_at','timestamptz'),\n('voices','version','int8'),\n('voices','deleted_at','timestamptz'),\n('user_settings','owner_id','uuid'),\n('user_settings','preferences','jsonb'),\n('user_settings','created_at','timestamptz'),\n('user_settings','updated_at','timestamptz'),\n('user_settings','version','int8')),\nexpected_functions(signature,body_hash) AS (VALUES\n('public.vault_touch_record()','ad921f25dea9d9338b2b10a6544503dd'),\n('public.vault_require_active_folder()','4303779afbf8e9771c3ea7cb9bf701a7'),\n('public.vault_archive_folder()','9f4b996d52771b7e3b5f954359c043cf'),\n('public.vault_export_snapshot(uuid)','a1812933bac2ff55ea2d9ddf9519f07a'),\n('public.vault_apply_snapshot(uuid,bigint,jsonb)','e0379a87c46b920b0c179062e6e1f60e')),\nexpected_triggers(table_name,trigger_name,function_signature) AS (VALUES\n ('libraries','libraries_touch','public.vault_touch_record()'),\n ('folders','folders_touch','public.vault_touch_record()'),\n ('folders','folders_archive','public.vault_archive_folder()'),\n ('voices','voices_touch','public.vault_touch_record()'),\n ('voices','voices_folder_check','public.vault_require_active_folder()'),\n ('user_settings','settings_touch','public.vault_touch_record()')),\ntable_state AS (\n SELECT count(c.oid)::integer AS present,\n bool_and(c.relkind='r' AND c.relrowsecurity) AS protected\n FROM expected_tables e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'\n LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.name),\ncolumn_state AS (\n SELECT count(*) FILTER (WHERE a.attname IS NULL OR t.typname<>e.type_name) AS invalid\n FROM expected_columns e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'\n LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name\n LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped\n LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid),\nfunction_state AS (\n SELECT count(p.oid)::integer AS present,\n count(*) FILTER (WHERE p.oid IS NULL OR md5(replace(p.prosrc,'public.','__vault__.'))<>e.body_hash OR p.prosecdef) AS invalid\n FROM expected_functions e LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(e.signature)),\ntrigger_state AS (\n SELECT count(*) FILTER (WHERE t.oid IS NULL OR t.tgfoid<>to_regprocedure(e.function_signature)::oid OR t.tgenabled NOT IN ('O','A')) AS invalid\n FROM expected_triggers e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'\n LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name\n LEFT JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND t.tgname=e.trigger_name AND NOT t.tgisinternal),\nkey_state AS (\n SELECT (SELECT count(*) FROM pg_catalog.pg_constraint k\n  JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace\n  WHERE n.nspname='public' AND k.contype='p' AND k.convalidated\n  AND ((c.relname='libraries' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num)=ARRAY['id'])\n    OR (c.relname IN ('folders','voices') AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num)=ARRAY['library_id','id'])\n    OR (c.relname='user_settings' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num)=ARRAY['owner_id']))) AS primary_keys,\n (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid=to_regclass('public.voices') AND k.confrelid=to_regclass('public.folders') AND k.contype='f' AND k.convalidated\n   AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num)=ARRAY['library_id','folder_id']\n   AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num)=ARRAY['library_id','id']) AS isolated_folder_fk,\n (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid IN(to_regclass('public.folders'),to_regclass('public.voices')) AND k.contype='c' AND k.convalidated AND k.conname IN('folders_valid_id','folders_virtual_ids','voices_valid_id')) AS guards),\nprivilege_state AS (\n SELECT COALESCE(has_function_privilege('anon',to_regprocedure('public.vault_export_snapshot(uuid)'),'EXECUTE'),false)\n OR COALESCE(has_function_privilege('authenticated',to_regprocedure('public.vault_export_snapshot(uuid)'),'EXECUTE'),false)\n OR COALESCE(has_function_privilege('anon',to_regprocedure('public.vault_apply_snapshot(uuid,bigint,jsonb)'),'EXECUTE'),false)\n OR COALESCE(has_function_privilege('authenticated',to_regprocedure('public.vault_apply_snapshot(uuid,bigint,jsonb)'),'EXECUTE'),false) AS exposed)\nSELECT jsonb_build_object('state',CASE\n WHEN ts.present=0 AND fs.present=0 THEN 'empty'\n WHEN ts.present=4 AND ts.protected AND cs.invalid=0 AND fs.invalid=0 AND tr.invalid=0\n  AND ks.primary_keys=4 AND ks.isolated_folder_fk=1 AND ks.guards=3 AND NOT ps.exposed THEN 'compatible'\n ELSE 'incompatible' END,\n 'tablesPresent',ts.present,'invalidColumns',cs.invalid,'invalidFunctions',fs.invalid,\n 'invalidTriggers',tr.invalid,'primaryKeys',ks.primary_keys,'isolatedFolderForeignKeys',ks.isolated_folder_fk)\n AS schema_state FROM table_state ts CROSS JOIN column_state cs CROSS JOIN function_state fs\n CROSS JOIN trigger_state tr CROSS JOIN key_state ks CROSS JOIN privilege_state ps";
