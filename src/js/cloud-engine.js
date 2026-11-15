import { CloudError, validateConnection, assertConnectionIdentity, queryBody, decodeSnapshot, safeError, rateLimitView, beginRateLimitRequest, observeRateLimit, validateCoverPath, coverStoragePath, validateCoverDataUrl, validateSignedCover, adoptRemoteRateLimit } from './cloud-core.js';

export const CLOUD_ACTIONS = Object.freeze(['connect_cloud', 'load_cloud', 'save_cloud', 'cloud_status', 'restore_cloud', 'disconnect_cloud', 'resolve_fish_audio', 'upload_cover', 'open_tab']);
/** One shared backend for Chrome and the website. Adapters own credential lifetime. */
export function createCloudEngine({storage, fetchImpl = (...args) => globalThis.fetch(...args), assetUrl, openTab = async () => {}, managementRequest = null, fishCredentials = 'include'}) {
  if (!storage?.get || !storage?.set || !storage?.remove || typeof assetUrl !== 'function') throw new TypeError('A storage and packaged asset adapter are required.');
const SESSION_KEY = 'voice_vault_management_connection';
let mutationQueue = Promise.resolve();
let managementQueue = Promise.resolve();
const signedCoverCache = new Map();
const COVER_CACHE_KEY='voice_vault_signed_covers';
const SNAPSHOT_CACHE_KEY='voice_vault_library_snapshot';
let snapshotWriteQueue=Promise.resolve();
function snapshotExclusive(operation){
  const run=()=>globalThis.navigator?.locks?.request
    ? globalThis.navigator.locks.request('voice-vault-library-snapshot',operation)
    : operation();
  const pending=snapshotWriteQueue.then(run,run);
  snapshotWriteQueue=pending.catch(()=>{});
  return pending;
}
const sameIdentity=(a,b)=>Boolean(a&&b&&a.projectRef===b.projectRef&&a.libraryId===b.libraryId);
async function removeSnapshotCache(expected=null){
  return snapshotExclusive(async()=>{const store=await sessionStorage();if(expected&&!sameIdentity((await store.get(SESSION_KEY))[SESSION_KEY],expected))return;await store.remove(SNAPSHOT_CACHE_KEY);});
}
function validatedCachedSnapshot(cache,config){
  if(!cache||cache.schemaVersion!==1||!sameIdentity(cache,config)||!Number.isFinite(cache.updatedAt))return null;
  try{
    const decoded=decodeSnapshot([{snapshot:cache.snapshot}]);
    if(decoded.snapshot.libraryId!==config.libraryId||decoded.revision!==cache.revision)return null;
    return {...decoded,updatedAt:cache.updatedAt};
  }catch{return null;}
}
async function rememberSnapshot(config,result){
  return snapshotExclusive(async()=>{
    const store=await sessionStorage();
    const current=(await store.get(SESSION_KEY))[SESSION_KEY];
    if(!sameIdentity(current,config))return false;
    let previous;
    try{previous=(await store.get(SNAPSHOT_CACHE_KEY))[SNAPSHOT_CACHE_KEY];}catch{await store.remove(SNAPSHOT_CACHE_KEY);}
    const validPrevious=validatedCachedSnapshot(previous,config);
    if(validPrevious&&validPrevious.revision>result.revision)return true;
    const envelope={schemaVersion:1,projectRef:config.projectRef,libraryId:config.libraryId,revision:result.revision,snapshot:structuredClone(result.snapshot),updatedAt:Date.now()};
    if(!validatedCachedSnapshot(envelope,config))throw new CloudError('STORAGE','La copia local de la biblioteca no es válida.');
    await store.set({[SNAPSHOT_CACHE_KEY]:envelope});
    const after=(await store.get(SESSION_KEY))[SESSION_KEY];
    if(!sameIdentity(after,config)){await store.remove(SNAPSHOT_CACHE_KEY);return false;}
    return true;
  });
}
async function cacheRemoteSnapshot(config,result){
  try{await rememberSnapshot(config,result);return result;}
  catch{
    // The remote mutation already succeeded: keep its new revision and report
    // only the local-cache failure, so retrying cannot overwrite newer data.
    try{await removeSnapshotCache(config);}catch{}
    return {...result,cacheWarning:'Los datos están online, pero no se pudo actualizar la copia local. Actualiza manualmente al reabrir la biblioteca.'};
  }
}
async function restoredSnapshot(config){
  const store=await sessionStorage();let saved;
  try{saved=(await store.get(SNAPSHOT_CACHE_KEY))[SNAPSHOT_CACHE_KEY];}
  catch{await removeSnapshotCache(config);return null;}
  const cached=validatedCachedSnapshot(saved,config);
  if(!cached)return null;
  let coverWarning;
  try{await restoreCoverCache();}catch{coverWarning='No se pudo leer la copia local de las portadas. Puedes actualizarlas manualmente.';}
  const snapshot=structuredClone(cached.snapshot);
  snapshot.voices=snapshot.voices.map(voice=>{
    const path=coverStoragePath(voice,config.libraryId);
    if(!path)return voice;
    let image=signedCoverCache.get(`${config.projectRef}/${path}`);
    if(!image||image.expiresAt<=Date.now()+60000){
      try{image=validateSignedCover({path,url:voice.coverImage,expiresAt:voice.coverExpiresAt},config);}catch{image=null;}
    }
    if(image&&image.expiresAt<=Date.now()+60000)image=null;
    return {...voice,coverStoragePath:path,coverImage:image?.url||'',coverExpiresAt:image?.expiresAt||null};
  });
  return {snapshot,revision:cached.revision,cacheUpdatedAt:cached.updatedAt,...(coverWarning?{cacheWarning:coverWarning}:{})};
}

let cacheGeneration=0;
let cacheLoadPromise;
let cacheWriteQueue=Promise.resolve();
async function persistCoverCache(){
  const generation=cacheGeneration;
  const write=async()=>{
    if(generation!==cacheGeneration)return;
    const store=await sessionStorage();
    const current=(await store.get(SESSION_KEY))[SESSION_KEY];
    if(!current){await store.remove(COVER_CACHE_KEY);return;}
    const prefix=`${current.projectRef}/${current.libraryId}/`;
    const existing=(await store.get(COVER_CACHE_KEY))[COVER_CACHE_KEY];
    const candidates=new Map([...(existing&&typeof existing==='object'?Object.entries(existing):[]),...signedCoverCache]);
    const values={};
    for(const [key,value]of candidates){
      if(!key.startsWith(prefix)||value?.expiresAt<=Date.now()+60000)continue;
      try{values[key]=validateSignedCover(value,current);}catch{}
    }
    if(Object.keys(values).length)await store.set({[COVER_CACHE_KEY]:values});
    else await store.remove(COVER_CACHE_KEY);
    // Another page may close or switch the remembered session while encryption
    // runs. Never leave private URLs behind after that session was closed.
    const after=(await store.get(SESSION_KEY))[SESSION_KEY];
    if(!after||after.projectRef!==current.projectRef||after.libraryId!==current.libraryId)await store.remove(COVER_CACHE_KEY);
  };
  cacheWriteQueue=cacheWriteQueue.then(write,write);
  return cacheWriteQueue;
}
async function restoreCoverCache(){
  if(!cacheLoadPromise){
    const generation=cacheGeneration;
    cacheLoadPromise=(async()=>{
      const saved=(await (await sessionStorage()).get(COVER_CACHE_KEY))[COVER_CACHE_KEY];
      if(generation!==cacheGeneration)return;
      if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const [key,value]of Object.entries(saved)){
        try{
          const slash=key.indexOf('/');const projectRef=key.slice(0,slash);const path=key.slice(slash+1);
          if(!/^[a-z0-9]{20}$/.test(projectRef)||path!==value?.path||value.expiresAt<=Date.now()+60000)continue;
          const image=validateSignedCover(value,{projectRef,libraryId:path.split('/')[0]});
          signedCoverCache.set(key,image);
        }catch{}
      }
      await persistCoverCache();
    })().catch(error=>{cacheLoadPromise=null;throw error;});
  }
  return cacheLoadPromise;
}
function resetCoverCache(identity=null){
  cacheGeneration++;
  const keep=identity?`${identity.projectRef}/${identity.libraryId}/`:null;
  for(const key of signedCoverCache.keys())if(!keep||!key.startsWith(keep))signedCoverCache.delete(key);
  cacheLoadPromise=Promise.resolve();
  return persistCoverCache();
}
const quotaKey = projectRef => `voice_vault_rate_database_query_${projectRef}`;
async function sessionStorage() {
  return storage;
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
  return pending.then(async result => {
    if(!result.snapshot)return result;
    const hydrated=await hydrateSnapshotCovers(config,result);
    return cacheRemoteSnapshot(config,hydrated);
  });
}
async function performManagementQuery(config, operation, data, revision) {
  const storage = await sessionStorage();
  const key = quotaKey(config.projectRef);
  let record = (await storage.get(key))[key] || null;
  const previousRecord=record;
  const controller = new AbortController();
  let timeout;
  try {
    // Validate before counting: rejected local payloads use zero HTTP requests.
    const prepared = queryBody(operation, config.libraryId, data, revision);
    const body = JSON.stringify(prepared);
    record = beginRateLimitRequest(record);
    await storage.set({ [key]: record });
    timeout = setTimeout(() => controller.abort(), 30000);
    const response = managementRequest
      ? await managementRequest(config, operation, operation==='save' ? JSON.parse(prepared.parameters[2]) : data, revision, {signal:controller.signal})
      : await fetchImpl(`https://api.supabase.com/v1/projects/${config.projectRef}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body, credentials: 'omit', redirect: 'error', signal: controller.signal
    });
    if (response.headers?.get?.('X-Vault-Management-Requests')==='0') record=previousRecord;
    else record = observeRateLimit(record, response.headers, response.status);
    if(response.status===429 && response.headers?.get?.('X-Vault-Management-Requests')==='0') record=observeRateLimit(record || {limit:120,requestsThisSession:0,_attempts:[]},response.headers,429);
    if(record) await storage.set({ [key]: record }); else await storage.remove(key);
    const rateLimit = rateLimitView(record);
    if (response.status === 429) {
      throw new CloudError('RATE_LIMIT', 'Supabase alcanzó el límite de consultas. Espera al reinicio del contador; los cambios pendientes se conservan.', rateLimit);
    }
    const text = await response.text();
    if (!response.ok) {
      // Inspect only known error tags, never forward a database error/body.
      let errorCode; try { errorCode=JSON.parse(text)?.code; } catch {}
      if (errorCode==='SCHEMA_INCOMPATIBLE' || /VAULT_SCHEMA_INCOMPATIBLE/.test(text)) throw new CloudError('SCHEMA_INCOMPATIBLE', 'El proyecto contiene tablas o funciones incompatibles. No se cambió ni eliminó ningún dato.', rateLimit);
      if (errorCode==='LIBRARY_MISSING' || /Library unavailable/.test(text)) throw new CloudError('LIBRARY_MISSING', 'La biblioteca solicitada no está disponible.', rateLimit);
      if (errorCode==='CONFLICT' || /40001|VAULT_REVISION_CONFLICT/.test(text)) throw new CloudError('CONFLICT', 'La biblioteca cambió en otro dispositivo. Recarga antes de guardar.', rateLimit);
      if (response.status === 401 || response.status === 403) throw new CloudError('AUTH', 'No se pudo autorizar el acceso. Revisa el token y sus permisos.', rateLimit);
      throw new CloudError('NETWORK', 'No se pudo completar la consulta online. Los cambios locales se conservan.', rateLimit);
    }
    const common = {projectRef:config.projectRef,libraryId:config.libraryId,rateLimit};
    if (operation === 'bootstrap') return {...common,bootstrapped:true};
    if (operation === 'probe' || operation === 'seed') {
      const rows = JSON.parse(text);
      const key = operation === 'probe' ? 'schema_state' : 'seed_result';
      const cell = Array.isArray(rows) ? rows[0]?.[key] : rows?.[key];
      const value = typeof cell === 'string' ? JSON.parse(cell) : cell;
      if (!value || typeof value !== 'object' || (operation === 'probe' && !['empty','compatible','incompatible'].includes(value.state))) throw new CloudError('NETWORK', 'No se pudo comprobar la configuración del proyecto.', rateLimit);
      return {...common,[operation === 'probe' ? 'schemaState' : 'seedResult']:value};
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
let bootstrapAssetPromise;
async function bootstrapAsset() {
  if (!bootstrapAssetPromise) bootstrapAssetPromise = (async () => {
    const response = await fetchImpl(assetUrl('src/sql/bootstrap.sql'), {credentials:'omit'});
    if (!response.ok) throw new CloudError('SETUP_ERROR', 'No se encontró el paquete de configuración de esta extensión. Vuelve a instalarla.');
    return response.text();
  })().catch(error => {bootstrapAssetPromise=null;throw error;});
  return bootstrapAssetPromise;
}
async function connectConfiguredLibrary(config) {
  const probe = await managementQuery(config,'probe');
  const setup = {createdSchema:false,createdLibrary:false};
  let seeded=false;
  const seedLibrary=async()=>{
    const seed=await managementQuery(config,'seed');
    seeded=true;
    setup.createdLibrary=Boolean(seed.seedResult.createdLibrary);
    // A concurrent initializer may commit while the seed statement waits for
    // its lock. Its snapshot can still report unavailable: a fresh load decides.
  };
  const unavailable=rateLimit=>new CloudError('LIBRARY_MISSING', 'La biblioteca está archivada o no está disponible; no se restauró automáticamente.', rateLimit);
  if (probe.schemaState.state === 'incompatible') throw new CloudError('SCHEMA_INCOMPATIBLE', 'El proyecto contiene tablas o funciones incompatibles. No se cambió ni eliminó ningún dato.', probe.rateLimit);
  if (probe.schemaState.state === 'empty') {
    await managementQuery(config,'bootstrap',await bootstrapAsset());
    setup.createdSchema=true;
    await seedLibrary();
  }
  let result;
  try {result=await managementQuery(config,'load');}
  catch(error) {
    if (error.code !== 'LIBRARY_MISSING') throw error;
    if (seeded) throw unavailable(error.rateLimit);
    await seedLibrary();
    try {result=await managementQuery(config,'load');}
    catch(reloaded) {
      if (reloaded.code === 'LIBRARY_MISSING') throw unavailable(reloaded.rateLimit);
      throw reloaded;
    }
  }
  return {...result,setup};
}

async function storageQuery(config, body) {
  const execute = () => performStorageQuery(config, body);
  const pending = managementQueue.then(execute, execute);
  managementQueue = pending.catch(() => {});
  return pending;
}
async function performStorageQuery(config, body) {
  await restoreCoverCache();
  const generation=cacheGeneration;
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
    const response = await fetchImpl(`https://${config.projectRef}.supabase.co/functions/v1/voice-vault-storage`, {
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
    if(generation!==cacheGeneration)throw new CloudError('CONFIG_CHANGED','La sesión cambió mientras se cargaba la portada.',rateLimit);
    if (body.action === 'upload') {
      const image = validateSignedCover(result, config);
      signedCoverCache.set(`${config.projectRef}/${image.path}`, image);
      await persistCoverCache();
      return { ...image, rateLimit };
    }
    const requested = new Set(body.paths);
    if (!Array.isArray(result.images)) throw new CloudError('NETWORK', 'No se pudieron firmar las portadas.');
    const images = result.images.map(image => validateSignedCover(image, config));
    if (images.some(image => !requested.has(image.path))) throw new CloudError('NETWORK', 'La respuesta de portadas no coincide con la biblioteca.');
    for (const image of images) signedCoverCache.set(`${config.projectRef}/${image.path}`, image);
    await persistCoverCache();
    return { images, rateLimit };
  } catch (error) {
    const safe = error instanceof CloudError ? error : new CloudError('NETWORK', 'No se pudo guardar o firmar la portada online. La imagen pendiente se conserva.');
    if (!safe.rateLimit) safe.rateLimit = rateLimitView(record);
    throw safe;
  } finally { if (timeout) clearTimeout(timeout); }
}
async function hydrateSnapshotCovers(config, result) {
  await restoreCoverCache();
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
  if (request.action === 'open_tab') { await openTab(); return { success: true }; }
  if (request.action === 'cloud_status'||request.action==='restore_cloud') {
    const storage = await sessionStorage();
    const value = (await storage.get(SESSION_KEY))[SESSION_KEY];
    if(value)validateConnection(value);
    if(request.action!=='restore_cloud')assertConnectionIdentity(value || null, request);
    const record = value ? (await storage.get(quotaKey(value.projectRef)))[quotaKey(value.projectRef)] : null;
    const cached=request.action==='restore_cloud'&&value?await restoredSnapshot(value):null;
    if(request.action==='restore_cloud'){
      const after=(await storage.get(SESSION_KEY))[SESSION_KEY];
      if(!after)return {success:true,data:{connected:false,projectRef:null,libraryId:null,rateLimit:null,cacheAvailable:false}};
      if(!sameIdentity(after,value))throw new CloudError('CONFIG_CHANGED','La sesión cambió en otra ventana. Vuelve a abrir la biblioteca.');
    }
    return { success: true, data: { connected: Boolean(value), projectRef: value?.projectRef ?? null, libraryId: value?.libraryId ?? null, rateLimit: value ? rateLimitView(record) : null, ...(request.action==='restore_cloud'?{cacheAvailable:Boolean(cached),...(cached||{})}:{}) } };
  }
  if (request.action === 'disconnect_cloud') { const storage = await sessionStorage(); const value = (await storage.get(SESSION_KEY))[SESSION_KEY]; assertConnectionIdentity(value || null, request); const cleared=resetCoverCache(); await storage.remove(SESSION_KEY); await Promise.all([cleared,removeSnapshotCache()]); return { success: true }; }
  if (request.action === 'connect_cloud') {
    const config = validateConnection(request);
    const data = await connectConfiguredLibrary(config);
    const storage=await sessionStorage();
    const previous=(await storage.get(SESSION_KEY))[SESSION_KEY];
    if(!sameIdentity(previous,config))await Promise.all([resetCoverCache(config),removeSnapshotCache()]);
    await storage.set({ [SESSION_KEY]: config });
    await persistCoverCache();
    return { success: true, data:await cacheRemoteSnapshot(config,data) };
  }
  if (request.action === 'load_cloud') {
    const data=await managementQuery(await connection(request),'load');
    // A different page may close or switch the remembered session while this
    // explicit refresh is in flight. Never deliver its stale private snapshot.
    await connection(request);
    return {success:true,data};
  }
  if (request.action === 'save_cloud') return { success: true, data: await managementQuery(await connection(request), 'save', request.data, request.expectedVersion) };
  if (request.action === 'upload_cover') return { success:true, data:await storageQuery(await connection(request), {action:'upload', dataUrl:request.dataUrl}) };
  if (request.action === 'resolve_fish_audio') {
    await connection(request);
    if (typeof request.modelId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(request.modelId)) throw new CloudError('VALIDATION', 'ID del modelo no válido.');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(`https://api.fish.audio/model/${encodeURIComponent(request.modelId)}`, { credentials: fishCredentials, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new CloudError('NETWORK', 'Fish Audio no permitió consultar ese modelo. Puedes completar sus datos manualmente.');
      return { success: true, data: await response.json() };
    } finally { clearTimeout(timeout); }
  }
}

  function request(message) {
    if (!message || !CLOUD_ACTIONS.includes(message.action)) return Promise.resolve({success:false,code:'FORBIDDEN',error:'Solicitud no autorizada.'});
    const run = () => handle(message).catch(error => safeError(error));
    if (['save_cloud','connect_cloud','disconnect_cloud'].includes(message.action)) {
      const pending = mutationQueue.then(run,run);
      mutationQueue = pending.catch(() => {});
      return pending;
    }
    return run();
  }
  return Object.freeze({request});
}
