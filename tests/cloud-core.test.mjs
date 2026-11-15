import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Import as a data module so the buildless extension needs no package.json.
const source = await readFile(new URL('../src/js/cloud-core.js', import.meta.url), 'utf8');
const core = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const libraryId = 'b2e96ef0-0b4a-498c-8a28-4949574ae190';
const fixture = () => ({ folders:[{id:'all',name:'Todas'},{id:'f_favorites',name:'Favoritas'},{id:'f_sueltas',name:'Voces Sueltas'},{id:'custom',name:'Voces'}], voices:[{id:'v_1',title:'Voz',url:'https://fish.audio/m/abcdefgh/',audioUrl:'',coverImage:'',folderId:'custom',isFavorite:true,extra:{keep:true}}], settings:{showSidebarFolders:true} });
test('SQL stays fixed and malicious text is only a parameter', () => {
  const data=fixture(); data.voices[0].title="quote'; DELETE FROM public.voices; --";
  const body=core.queryBody('save',libraryId,data,3);
  assert.equal(body.query,core.QUERIES.save);
  assert.equal(body.parameters[1],3);
  assert.match(body.parameters[2],/DELETE/);
  assert.doesNotMatch(body.query,/DELETE/);
  assert.equal(JSON.parse(body.parameters[2]).voices[0].extra.keep,true);
});
test('malformed snapshot and invalid references cannot erase remote rows', () => {
  assert.throws(()=>core.validateSnapshot({voices:[]}));
  for(const folder of ['missing','all','f_favorites']) { const data=fixture();data.voices[0].folderId=folder;assert.throws(()=>core.validateSnapshot(data)); }
  const data=fixture();data.voices.push({...data.voices[0]});assert.throws(()=>core.validateSnapshot(data));
});
test('rejects executable links and unversioned saves', () => {
  const data=fixture();data.voices[0].url='javascript:alert(1)';assert.throws(()=>core.validateSnapshot(data));
  assert.throws(()=>core.queryBody('save',libraryId,fixture(),undefined));
});
test('returned snapshot is validated and revision normalized', () => {
  const result=core.decodeSnapshot([{snapshot:{...fixture(),revision:'7',libraryId}}]);
  assert.equal(result.revision,7);assert.equal(result.snapshot.voices[0].extra.keep,true);
});
test('errors never expose arbitrary server or Authorization details', () => {
  const result=core.safeError(new Error('Authorization Bearer SECRET query payload'));
  assert.doesNotMatch(JSON.stringify(result),/SECRET|Authorization|payload/);
  assert.equal(core.safeError(new core.CloudError('CONFLICT','Recarga')).code,'CONFLICT');
});
test('connection only accepts identifiers and a bounded token', () => {
  assert.throws(()=>core.validateConnection({token:'short',projectRef:'bad',libraryId}));
  const value=core.validateConnection({token:'test_only_12345678901234567890',projectRef:'ktcjeltckzdeetucfplw',libraryId});
  assert.equal(value.libraryId,libraryId);
});
test('background rejects external senders, keeps PAT in session only and sanitizes conflicts', async () => {
  const saved = {};
  let listener;
  const extensionId = 'vault-test-extension';
  const origin = `chrome-extension://${extensionId}/`;
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  let nextConflict = false;
  let nextRateLimit = false;
  let fetchCalls = 0;
  const accesses = [];
  globalThis.chrome = {
    runtime: { id: extensionId, getURL: path => origin + path, onMessage: { addListener(fn) { listener = fn; } } },
    action: { onClicked: { addListener() {} } },
    tabs: { create: async () => ({}) },
    storage: { session: {
      setAccessLevel: async value => accesses.push(value.accessLevel),
      get: async key => ({ [key]: saved[key] }),
      set: async values => Object.assign(saved, values),
      remove: async key => { delete saved[key]; }
    } }
  };
  globalThis.fetch = async (_url, options) => {
    fetchCalls += 1;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.match(options.headers.Authorization, /^Bearer test_only_/);
    assert.doesNotMatch(options.body, /test_only_/);
    const headers = new Headers({ 'X-RateLimit-Limit':'120', 'X-RateLimit-Remaining':nextRateLimit ? '0' : String(120-fetchCalls), 'X-RateLimit-Reset':'30', 'Retry-After':'35' });
    if (nextRateLimit) return {ok:false,status:429,headers,text:async()=> 'internal rate limit'};
    const snapshot=fixture();
    snapshot.voices=Array.from({length:118},(_,index)=>({...snapshot.voices[0],id:`v_${index}`}));
    return nextConflict
      ? { ok: false, status: 400, headers, text: async () => 'VAULT_REVISION_CONFLICT secret internal detail' }
      : { ok: true, status: 201, headers, text: async () => JSON.stringify([{ snapshot: { ...snapshot, revision: 1, libraryId } }]) };
  };
  try {
    const background = (await readFile(new URL('../src/js/background.js', import.meta.url), 'utf8'))
      .replace("'./cloud-core.js'", JSON.stringify('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
    await import('data:text/javascript;base64,' + Buffer.from(background).toString('base64'));
    const send = (request, sender = { id: extensionId, url: origin + 'index.html' }) => new Promise(resolve => listener({projectRef:'ktcjeltckzdeetucfplw',libraryId,...request}, sender, resolve));
    const forbidden = await send({action:'cloud_status'}, {id:'another-extension', url:'https://evil.example/'});
    assert.equal(forbidden.code, 'FORBIDDEN');
    const token = 'test_only_12345678901234567890';
    const connected = await send({ action:'connect_cloud', token, projectRef:'ktcjeltckzdeetucfplw', libraryId });
    assert.equal(connected.success, true);
    assert.equal(connected.data.snapshot.voices.length,118);
    assert.equal(fetchCalls,1,'118 returned records consume one request');
    assert.equal(connected.data.rateLimit.requestsThisSession,1);
    assert.equal(connected.data.rateLimit.source,'server');
    assert.doesNotMatch(JSON.stringify(connected), /test_only_/);
    const status = await send({action:'cloud_status'});
    assert.equal(status.data.connected, true);
    assert.equal(fetchCalls,1,'reading status/clock must not call Management API');
    assert.doesNotMatch(JSON.stringify(status), /test_only_/);
    nextConflict = true;
    const conflict = await send({action:'save_cloud', data:fixture(), expectedVersion:1});
    assert.equal(conflict.code, 'CONFLICT');
    assert.doesNotMatch(JSON.stringify(conflict), /secret internal detail|test_only_/);
    nextConflict=false;
    nextRateLimit=true;
    const throttled=await send({action:'load_cloud'});
    assert.equal(throttled.code,'RATE_LIMIT');
    assert.equal(throttled.rateLimit.remaining,0);
    assert.equal(throttled.rateLimit.requestsThisSession,3);
    const guarded=await send({action:'load_cloud'});
    assert.equal(guarded.code,'RATE_LIMIT');
    assert.equal(fetchCalls,3,'429 guard must not issue another HTTP request before reset');
    await send({action:'disconnect_cloud'});
    assert.equal((await send({action:'cloud_status'})).data.connected, false);
    assert.ok(accesses.every(value => value === 'TRUSTED_CONTEXTS'));
  } finally { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; }
});

test('server reset header is seconds remaining and server quota is authoritative', () => {
  const now=1700000000000;
  const started=core.beginRateLimitRequest(null,now);
  assert.equal(started.requestsThisSession,1);
  const observed=core.observeRateLimit(started,new Headers({'X-RateLimit-Limit':'120','X-RateLimit-Remaining':'37','X-RateLimit-Reset':'12'}),200,now);
  const view=core.rateLimitView(observed,now);
  assert.equal(view.resetAt,now+12000);
  assert.equal(view.used,83);
  assert.equal(view.source,'server');
  assert.equal(view.requestsThisSession,1,'external requests affect quota but not extension session count');
  assert.equal(view._attempts,undefined);
});
test('missing headers use a labeled local rolling-minute estimate', () => {
  const now=1700000000000;
  const first=core.beginRateLimitRequest(null,now);
  const second=core.beginRateLimitRequest(first,now+1000);
  const observed=core.observeRateLimit(second,new Headers(),200,now+1000);
  assert.equal(core.rateLimitView(observed,now+1000).source,'estimate');
  assert.equal(core.rateLimitView(observed,now+1000).used,2);
  assert.equal(core.rateLimitView(observed,now+61001).remaining,120);
  assert.equal(core.rateLimitView(observed,now+61001).requestsThisSession,2);
});
test('429 honors Retry-After and guard does not increment counter', () => {
  const now=1700000000000;
  const record=core.observeRateLimit(core.beginRateLimitRequest(null,now),new Headers({'X-RateLimit-Limit':'120','X-RateLimit-Remaining':'0','X-RateLimit-Reset':'10','Retry-After':'25'}),429,now);
  assert.equal(record.resetAt,now+25000);
  assert.throws(()=>core.beginRateLimitRequest(record,now+1000),error=>error.code==='RATE_LIMIT'&&error.rateLimit.requestsThisSession===1);
  assert.equal(core.beginRateLimitRequest(record,now+61000).requestsThisSession,2);
});
const coverPath = `${libraryId}/${'a'.repeat(64)}.png`;
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nc0kAAAAASUVORK5CYII=';
test('stable covers preserve path while removing signed URLs and expiry from save parameters', () => {
  const data=fixture();data.voices[0].coverStoragePath=coverPath;data.voices[0].coverImage='https://example.test/temporary?token=SIGNED';data.voices[0].coverExpiresAt=Date.now()+60000;
  const body=core.queryBody('save',libraryId,data,1);
  const voice=JSON.parse(body.parameters[2]).voices[0];
  assert.equal(voice.coverStoragePath,coverPath);
  assert.equal(voice.coverImage,'');
  assert.equal(voice.coverExpiresAt,undefined);
  assert.doesNotMatch(body.parameters[2],/SIGNED/);
  assert.equal(data.voices[0].coverExpiresAt>0,true,'source UI model must not be mutated');
  data.voices[0].coverStoragePath=`00000000-0000-0000-0000-000000000000/${'a'.repeat(64)}.png`;
  assert.throws(()=>core.queryBody('save',libraryId,data,1));
});
test('cover paths reject traversal and upload validator rejects non-raster or oversized files', () => {
  assert.equal(core.validateCoverPath(coverPath,libraryId),coverPath);
  assert.throws(()=>core.validateCoverPath(`${libraryId}/../secret.png`,libraryId));
  assert.throws(()=>core.validateCoverPath(`${libraryId}/${'a'.repeat(64)}.svg`,libraryId));
  assert.equal(core.validateCoverDataUrl(pngDataUrl),pngDataUrl);
  assert.throws(()=>core.validateCoverDataUrl('data:image/svg+xml;base64,PHN2Zz4='));
  assert.throws(()=>core.validateCoverDataUrl('data:image/png;base64,AAAA'));
  assert.throws(()=>core.validateCoverDataUrl('data:image/png;base64,'+'A'.repeat(700000)));
});
test('Edge quota observation retains the extension request count', () => {
  const record=core.beginRateLimitRequest(null,1000);
  const result=core.adoptRemoteRateLimit(record,{limit:120,remaining:88,resetAt:61000,observedAt:1000,source:'server',requestsThisSession:900},1000);
  assert.equal(result.requestsThisSession,1);
  assert.equal(result.remaining,88);
  assert.equal(result.source,'server');
});
test('background batches private cover signing, caches URLs and uploads without exposing server keys', async () => {
  const saved={}; let listener; let managementCalls=0; let edgeCalls=0; let savedPayload;
  const extensionId='vault-cover-test';const origin=`chrome-extension://${extensionId}/`;
  const previousChrome=globalThis.chrome;const previousFetch=globalThis.fetch;
  const secondPath=`${libraryId}/${'b'.repeat(64)}.png`;
  const signed=path=>({path,url:`https://ktcjeltckzdeetucfplw.supabase.co/storage/v1/object/sign/voice-vault-images/${path}?token=TEMPORARY_SIGNATURE`,expiresAt:Date.now()+3600000});
  const response=(payload,headers=new Headers())=>({ok:true,status:200,headers,json:async()=>payload,text:async()=>JSON.stringify(payload)});
  globalThis.chrome={runtime:{id:extensionId,getURL:path=>origin+path,onMessage:{addListener(fn){listener=fn;}}},action:{onClicked:{addListener(){}}},tabs:{create:async()=>({})},storage:{session:{setAccessLevel:async()=>{},get:async key=>({[key]:saved[key]}),set:async values=>Object.assign(saved,values),remove:async key=>{delete saved[key];}}}};
  globalThis.fetch=async(url,options)=>{
    assert.match(options.headers.Authorization,/^Bearer test_only_/);
    assert.equal(options.credentials,'omit');
    if(url.startsWith('https://api.supabase.com/')){
      managementCalls++;
      const request=JSON.parse(options.body);
      if(request.parameters.length===3){savedPayload=JSON.parse(request.parameters[2]);assert.doesNotMatch(options.body,/TEMPORARY_SIGNATURE/);}
      const snapshot=fixture();snapshot.libraryId=libraryId;snapshot.revision=managementCalls;
      snapshot.voices[0].coverStoragePath=savedPayload ? secondPath : coverPath;snapshot.voices[0].coverImage='';
      return response([{snapshot}],new Headers({'X-RateLimit-Limit':'120','X-RateLimit-Remaining':String(120-managementCalls-edgeCalls),'X-RateLimit-Reset':'30'}));
    }
    assert.equal(url,'https://ktcjeltckzdeetucfplw.supabase.co/functions/v1/voice-vault-storage');
    edgeCalls++;const request=JSON.parse(options.body);
    assert.equal(request.libraryId,libraryId);assert.equal(request.token,undefined);
    const rateLimit={limit:120,remaining:120-managementCalls-edgeCalls,resetAt:Date.now()+30000,observedAt:Date.now(),source:'server'};
    return response(request.action==='sign'?{success:true,images:request.paths.map(signed),rateLimit}:{success:true,...signed(secondPath),rateLimit});
  };
  try {
    const background=(await readFile(new URL('../src/js/background.js',import.meta.url),'utf8')).replace("'./cloud-core.js'",JSON.stringify('data:text/javascript;base64,'+Buffer.from(source).toString('base64')))+'\n// Cover integration test isolation';
    await import('data:text/javascript;base64,'+Buffer.from(background).toString('base64'));
    const send=request=>new Promise(resolve=>listener({projectRef:'ktcjeltckzdeetucfplw',libraryId,...request},{id:extensionId,url:origin+'index.html'},resolve));
    const connected=await send({action:'connect_cloud',token:'test_only_12345678901234567890',projectRef:'ktcjeltckzdeetucfplw',libraryId});
    assert.equal(connected.success,true);
    assert.match(connected.data.snapshot.voices[0].coverImage,/TEMPORARY_SIGNATURE/);
    assert.equal(managementCalls,1);assert.equal(edgeCalls,1,'all private covers signed in one batch');
    assert.equal(connected.data.rateLimit.requestsThisSession,2);
    await send({action:'load_cloud'});
    assert.equal(managementCalls,2);assert.equal(edgeCalls,1,'valid cached signatures do not consume another Edge query');
    const upload=await send({action:'upload_cover',dataUrl:pngDataUrl});
    assert.equal(upload.success,true);assert.equal(upload.data.path,secondPath);assert.equal(edgeCalls,2);
    const data=fixture();data.voices[0]={...data.voices[0],coverImage:upload.data.url,coverStoragePath:upload.data.path,coverExpiresAt:upload.data.expiresAt};
    const result=await send({action:'save_cloud',data,expectedVersion:2});
    assert.equal(result.success,true);assert.equal(savedPayload.voices[0].coverImage,'');assert.equal(savedPayload.voices[0].coverExpiresAt,undefined);
    assert.equal(edgeCalls,2,'uploaded image signature is reused on save');
    const invalid=await send({action:'upload_cover',dataUrl:'data:image/svg+xml;base64,PHN2Zz4='});
    assert.equal(invalid.success,false);assert.equal(edgeCalls,2,'invalid uploads cost no validation query');
    assert.doesNotMatch(JSON.stringify(result),/test_only_|service_role/);
  } finally {globalThis.chrome=previousChrome;globalThis.fetch=previousFetch;}
});
test('connection identities reject stale or omitted library expectations', () => {
  const a={projectRef:'ktcjeltckzdeetucfplw',libraryId};
  const b={...a,libraryId:'00000000-0000-0000-0000-000000000001'};
  assert.doesNotThrow(()=>core.assertConnectionIdentity(a,a));
  assert.throws(()=>core.assertConnectionIdentity(b,a),error=>error.code==='CONFIG_CHANGED');
  assert.throws(()=>core.assertConnectionIdentity(a,{}),error=>error.code==='CONFIG_CHANGED');
  const data=fixture();data.libraryId=b.libraryId;
  assert.throws(()=>core.queryBody('save',libraryId,data,1),error=>error.code==='CONFIG_CHANGED');
});
test('a stale tab cannot read, overwrite, disconnect or upload into another tab library', async () => {
  const saved={};let listener;let calls=0;
  const extensionId='vault-identity-test';const origin=`chrome-extension://${extensionId}/`;
  const previousChrome=globalThis.chrome;const previousFetch=globalThis.fetch;
  const identityA={projectRef:'ktcjeltckzdeetucfplw',libraryId};
  const identityB={...identityA,libraryId:'00000000-0000-0000-0000-000000000001'};
  globalThis.chrome={runtime:{id:extensionId,getURL:path=>origin+path,onMessage:{addListener(fn){listener=fn;}}},action:{onClicked:{addListener(){}}},tabs:{create:async()=>({})},storage:{session:{setAccessLevel:async()=>{},get:async key=>({[key]:saved[key]}),set:async values=>Object.assign(saved,values),remove:async key=>{delete saved[key];}}}};
  globalThis.fetch=async(_url,options)=>{
    calls++;
    const body=JSON.parse(options.body);
    const snapshot={...fixture(),libraryId:body.parameters[0],revision:1};
    return {ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify([{snapshot}])};
  };
  try {
    const background=(await readFile(new URL('../src/js/background.js',import.meta.url),'utf8')).replace("'./cloud-core.js'",JSON.stringify('data:text/javascript;base64,'+Buffer.from(source).toString('base64')))+'\n// Session identity test isolation';
    await import('data:text/javascript;base64,'+Buffer.from(background).toString('base64'));
    const send=(request,identity=identityA)=>new Promise(resolve=>listener({...identity,...request},{id:extensionId,url:origin+'index.html'},resolve));
    const token='test_only_12345678901234567890';
    assert.equal((await send({action:'connect_cloud',token})).success,true);
    assert.equal((await send({action:'connect_cloud',token},identityB)).success,true);
    assert.equal(calls,2);
    const staleRequests=[{action:'load_cloud'},{action:'save_cloud',data:fixture(),expectedVersion:1},{action:'upload_cover',dataUrl:pngDataUrl},{action:'cloud_status'},{action:'disconnect_cloud'},{action:'resolve_fish_audio',modelId:'abcdefgh'}];
    for(const request of staleRequests){
      const result=await send(request);
      assert.equal(result.code,'CONFIG_CHANGED',request.action);
      assert.equal(calls,2,`${request.action} must fail before HTTP or quota use`);
    }
    const status=await send({action:'cloud_status'},identityB);
    assert.equal(status.data.connected,true,'old tab must not disconnect the new global connection');
    assert.equal(status.data.libraryId,identityB.libraryId);
    assert.equal(status.data.rateLimit.requestsThisSession,2);
    assert.equal((await send({action:'save_cloud',data:fixture(),expectedVersion:1},identityB)).success,true);
    assert.equal(calls,3,'the new tab may save to its own library');
  } finally {globalThis.chrome=previousChrome;globalThis.fetch=previousFetch;}
});

test('administrator export uses write-authorized query role without broadening RPC grants', () => {
  const body=core.queryBody('load',libraryId);
  assert.equal(body.query,core.QUERIES.load);
  assert.equal(body.read_only,false);
  assert.deepEqual(body.parameters,[libraryId]);
});
