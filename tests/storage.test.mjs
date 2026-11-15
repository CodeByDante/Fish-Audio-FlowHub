import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPersistentStorage} from '../src/js/persistent-storage.js';
import {createCloudEngine} from '../src/js/cloud-engine.js';
import {QUERIES,SCHEMA_PROBE_SQL} from '../src/js/cloud-core.js';

function fakeKV(){
  const records=new Map();
  return {records,async get(key){return structuredClone(records.get(key));},async setMany(entries){for(const [key,value]of entries)records.set(key,structuredClone(value));},async removeMany(keys){for(const key of keys)records.delete(key);},async putIfAbsent(key,value){if(!records.has(key))records.set(key,structuredClone(value));return structuredClone(records.get(key));}};
}
const key='voice_vault_management_connection';
const identity={projectRef:'ktcjeltckzdeetucfplw',libraryId:'b2e96ef0-0b4a-498c-8a28-4949574ae190'};
const token='test_only_12345678901234567890';
const connection={token,...identity};
const adapter=kv=>createPersistentStorage({namespace:'test-session',kv,cryptoImpl:webcrypto});

test('remembered PAT is encrypted at rest with a nonextractable persisted CryptoKey',async()=>{
  const kv=fakeKV();const first=adapter(kv);
  await first.set({[key]:connection});
  const encrypted=kv.records.get('test-session/'+key);
  assert.deepEqual(Object.keys(encrypted).sort(),['ciphertext','iv','version']);
  assert.equal(encrypted.token,undefined);
  assert.ok(encrypted.ciphertext instanceof ArrayBuffer);
  assert.ok(!Buffer.from(encrypted.ciphertext).includes(Buffer.from(token)));
  const cryptoKey=kv.records.get('test-session/__aes_key');
  assert.equal(cryptoKey.extractable,false);
  await assert.rejects(()=>webcrypto.subtle.exportKey('raw',cryptoKey));
  const reopened=adapter(kv);
  assert.deepEqual((await reopened.get(key))[key],connection,'reopening decrypts the remembered session');
  await reopened.remove(key);
  assert.equal((await adapter(kv).get(key))[key],undefined,'logout removes the saved connection');
});
test('concurrent pages agree on one encrypted-storage key and tampering is rejected',async()=>{
  const kv=fakeKV();const a=adapter(kv);const b=adapter(kv);
  await Promise.all([a.set({a:{token}}),b.set({b:{token}})]);
  assert.equal((await a.get('b')).b.token,token);
  assert.equal((await b.get('a')).a.token,token);
  const corrupted=kv.records.get('test-session/a');
  new Uint8Array(corrupted.ciphertext)[0]^=1;
  kv.records.set('test-session/a',corrupted);
  await assert.rejects(()=>a.get('a'),error=>error.code==='STORAGE'&&!error.message.includes(token));
});
test('reopening restores identity without HTTP and reuses unexpired encrypted cover cache',async()=>{
  const kv=fakeKV();const path=`${identity.libraryId}/${'a'.repeat(64)}.png`;
  let management=0;let signing=0;
  const snapshot={libraryId:identity.libraryId,revision:1,settings:{},folders:[{id:'all',name:'Todas'},{id:'f_favorites',name:'Favoritas'},{id:'f_sueltas',name:'Voces Sueltas'}],voices:[{id:'v_1',title:'Voz',url:'https://fish.audio/m/abcdefgh/',audioUrl:'',coverImage:'',coverStoragePath:path,folderId:'f_sueltas'}]};
  const response=body=>({ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(body),json:async()=>body});
  const fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.startsWith('https://api.supabase.com/')){
      management++;
      if(body.query===SCHEMA_PROBE_SQL)return response([{schema_state:{state:'compatible'}}]);
      assert.equal(body.query,QUERIES.load);return response([{snapshot}]);
    }
    signing++;assert.equal(body.action,'sign');
    return response({success:true,images:[{path,url:`https://${identity.projectRef}.supabase.co/storage/v1/object/sign/voice-vault-images/${path}?token=SIGNED_TEMPORARY`,expiresAt:Date.now()+3600000}],rateLimit:null});
  };
  const engine=()=>createCloudEngine({storage:adapter(kv),fetchImpl,assetUrl:path=>'https://example.test/'+path});
  const send=(engine,action,payload={})=>engine.request({...identity,...payload,action});
  const first=engine();const initial=await send(first,'connect_cloud',{token});
  assert.equal(initial.success,true);assert.equal(management,2);assert.equal(signing,1);
  const physicalCover=kv.records.get('test-session/voice_vault_signed_covers');
  assert.ok(physicalCover.ciphertext instanceof ArrayBuffer);
  assert.ok(!Buffer.from(physicalCover.ciphertext).includes(Buffer.from('SIGNED_TEMPORARY')));
  const reopened=engine();
  const before=management;
  const restored=await reopened.request({action:'restore_cloud'});
  assert.equal(restored.data.connected,true);assert.equal(restored.data.libraryId,identity.libraryId);
  assert.equal(management,before,'restoring identity reads only IndexedDB');
  assert.doesNotMatch(JSON.stringify(restored),/test_only_/);
  const loaded=await send(reopened,'load_cloud');
  assert.equal(loaded.success,true);assert.match(loaded.data.snapshot.voices[0].coverImage,/SIGNED_TEMPORARY/);
  assert.equal(management,3,'reopening performs one data load, without another schema probe');
  assert.equal(signing,1,'valid signed images do not incur another signing query');
  await send(reopened,'disconnect_cloud');
  assert.equal((await engine().request({action:'restore_cloud'})).data.connected,false);
  assert.equal(kv.records.has('test-session/'+key),false);
  assert.equal(kv.records.has('test-session/voice_vault_signed_covers'),false);
});
test('expired private URLs are renewed and switching libraries removes the former cache',async()=>{
  const kv=fakeKV();const store=adapter(kv);
  const otherLibrary='00000000-0000-0000-0000-000000000001';
  const path=library=>`${library}/${'b'.repeat(64)}.png`;
  const image=(library,expiresAt)=>({path:path(library),url:`https://${identity.projectRef}.supabase.co/storage/v1/object/sign/voice-vault-images/${path(library)}?token=TEMPORARY`,expiresAt});
  await store.set({[key]:connection,voice_vault_signed_covers:{[identity.projectRef+'/'+path(identity.libraryId)]:image(identity.libraryId,Date.now()-1000)}});
  let signs=0;
  const response=body=>({ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(body),json:async()=>body});
  const engine=createCloudEngine({storage:store,assetUrl:path=>'https://example.test/'+path,fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.startsWith('https://api.supabase.com/')){
      if(body.query===SCHEMA_PROBE_SQL)return response([{schema_state:{state:'compatible'}}]);
      const selected=body.parameters[0];
      return response([{snapshot:{libraryId:selected,revision:1,settings:{},folders:[{id:'f_sueltas',name:'Voces Sueltas'}],voices:[{id:'v',title:'Voz',url:'https://fish.audio/m/abcdefgh/',audioUrl:'',coverImage:'',coverStoragePath:path(selected),folderId:'f_sueltas'}]}}]);
    }
    signs++;return response({success:true,images:body.paths.map(value=>image(value.split('/')[0],Date.now()+3600000)),rateLimit:null});
  }});
  assert.equal((await engine.request({action:'load_cloud',...identity})).success,true);
  assert.equal(signs,1,'expired remembered signatures must be renewed');
  assert.equal((await engine.request({action:'connect_cloud',...identity,libraryId:otherLibrary,token})).success,true);
  const cache=(await store.get('voice_vault_signed_covers')).voice_vault_signed_covers;
  assert.deepEqual(Object.keys(cache),[identity.projectRef+'/'+path(otherLibrary)]);
  assert.equal(signs,2);
});
const SNAPSHOT_KEY='voice_vault_library_snapshot';
const localSnapshot=(revision=1,notes='')=>({libraryId:identity.libraryId,revision,settings:{},folders:[{id:'all',name:'Todas'},{id:'f_favorites',name:'Favoritas'},{id:'f_sueltas',name:'Voces Sueltas'}],voices:[{id:'v_1',title:'Voz privada',url:'https://fish.audio/m/abcdefgh/',audioUrl:'',coverImage:'',folderId:'f_sueltas',notes}]});
const envelope=snapshot=>({schemaVersion:1,...identity,revision:snapshot.revision,snapshot,updatedAt:Date.now()});
const reply=(body,status=200)=>({ok:status<400,status,headers:new Headers(),text:async()=>JSON.stringify(body),json:async()=>body});
const testEngine=(store,fetchImpl)=>createCloudEngine({storage:store,fetchImpl,assetUrl:path=>'https://example.test/'+path});
const command=(engine,action,payload={})=>engine.request({...identity,...payload,action});

test('remembered startup restores the encrypted library and revision with zero HTTP',async()=>{
  const kv=fakeKV();const store=adapter(kv);const snapshot=localSnapshot(7,'Contenido privado recordado');
  await store.set({[key]:connection,[SNAPSHOT_KEY]:envelope(snapshot)});
  const physical=kv.records.get('test-session/'+SNAPSHOT_KEY);
  assert.ok(!Buffer.from(physical.ciphertext).includes(Buffer.from(snapshot.voices[0].notes)));
  let calls=0;const engine=testEngine(adapter(kv),async()=>{calls++;throw Error('Startup must remain local');});
  const result=await engine.request({action:'restore_cloud'});
  assert.equal(result.success,true);assert.equal(result.data.connected,true);assert.equal(result.data.cacheAvailable,true);
  assert.equal(result.data.revision,7);assert.equal(result.data.snapshot.voices[0].notes,snapshot.voices[0].notes);
  assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(result),/test_only_/);
  await command(engine,'cloud_status');assert.equal(calls,0);
});
test('a remembered session without a matching valid cache returns no editable empty snapshot',async()=>{
  const kv=fakeKV();const store=adapter(kv);
  const wrong=envelope(localSnapshot());wrong.libraryId='00000000-0000-0000-0000-000000000001';
  await store.set({[key]:connection,[SNAPSHOT_KEY]:wrong});
  const engine=testEngine(store,async()=>{throw Error('No automatic remote fallback');});
  const result=await engine.request({action:'restore_cloud'});
  assert.equal(result.data.connected,true);assert.equal(result.data.cacheAvailable,false);
  assert.equal(result.data.snapshot,undefined);assert.equal(result.data.revision,undefined);
});
test('expired covers are blanked locally and damaged cover cache does not discard library data',async()=>{
  const kv=fakeKV();const base=adapter(kv);const snapshot=localSnapshot(3);
  snapshot.voices[0].coverStoragePath=`${identity.libraryId}/${'c'.repeat(64)}.png`;
  snapshot.voices[0].coverImage=`https://${identity.projectRef}.supabase.co/storage/v1/object/sign/voice-vault-images/${snapshot.voices[0].coverStoragePath}?token=EXPIRED`;
  snapshot.voices[0].coverExpiresAt=Date.now()-1000;
  await base.set({[key]:connection,[SNAPSHOT_KEY]:envelope(snapshot)});
  const brokenCovers={...base,async get(name){if(name==='voice_vault_signed_covers')throw Error('Damaged cached cover record');return base.get(name);}};
  let calls=0;const engine=testEngine(brokenCovers,async()=>{calls++;throw Error('No automatic signing');});
  const result=await engine.request({action:'restore_cloud'});
  assert.equal(result.data.cacheAvailable,true);assert.equal(result.data.snapshot.voices[0].coverImage,'');
  assert.equal(result.data.snapshot.voices[0].coverStoragePath,snapshot.voices[0].coverStoragePath);
  assert.ok(result.data.cacheWarning);assert.equal(calls,0);
});
test('successful mutations refresh the encrypted snapshot and stale conflicts preserve it',async()=>{
  const kv=fakeKV();const store=adapter(kv);await store.set({[key]:connection,[SNAPSHOT_KEY]:envelope(localSnapshot())});
  let calls=0;const engine=testEngine(store,async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);assert.equal(body.query,QUERIES.save);
    if(calls===1)return reply([{snapshot:localSnapshot(2,'Guardado desde la aplicación')}]);
    return reply({code:'40001',message:'VAULT_REVISION_CONFLICT'},400);
  });
  const changed=localSnapshot(1,'Guardado desde la aplicación');
  assert.equal((await command(engine,'save_cloud',{data:changed,expectedVersion:1})).data.revision,2);
  assert.equal((await command(engine,'save_cloud',{data:changed,expectedVersion:1})).code,'CONFLICT');
  const reopened=testEngine(adapter(kv),async()=>{throw Error('Restore must not query');});
  const result=await reopened.request({action:'restore_cloud'});
  assert.equal(result.data.revision,2);assert.equal(result.data.snapshot.voices[0].notes,changed.voices[0].notes);assert.equal(calls,2);
});
test('a delayed older load cannot replace a newer mutation in the local snapshot',async()=>{
  const kv=fakeKV();const store=adapter(kv);await store.set({[key]:connection,[SNAPSHOT_KEY]:envelope(localSnapshot())});
  let release;let started;const entered=new Promise(resolve=>{started=resolve;});
  const old=testEngine(adapter(kv),async()=>{started();return new Promise(resolve=>{release=()=>resolve(reply([{snapshot:localSnapshot(1,'Anterior')} ]));});});
  const loading=command(old,'load_cloud');await entered;
  const newer=testEngine(adapter(kv),async()=>reply([{snapshot:localSnapshot(2,'Más reciente')} ]));
  assert.equal((await command(newer,'save_cloud',{data:localSnapshot(1,'Más reciente'),expectedVersion:1})).success,true);
  release();await loading;
  const restored=await testEngine(adapter(kv),async()=>{throw Error('No query');}).request({action:'restore_cloud'});
  assert.equal(restored.data.revision,2);assert.equal(restored.data.snapshot.voices[0].notes,'Más reciente');
});
test('logout during a pending remote load cannot recreate a remembered snapshot',async()=>{
  const kv=fakeKV();const store=adapter(kv);await store.set({[key]:connection,[SNAPSHOT_KEY]:envelope(localSnapshot())});
  let release;let started;const entered=new Promise(resolve=>{started=resolve;});
  const old=testEngine(adapter(kv),async()=>{started();return new Promise(resolve=>{release=()=>resolve(reply([{snapshot:localSnapshot()}]));});});
  const pending=command(old,'load_cloud');await entered;
  const logout=testEngine(adapter(kv),async()=>{throw Error('Logout must be local');});
  await command(logout,'disconnect_cloud');release();const stale=await pending;assert.equal(stale.code,'NOT_CONNECTED');assert.equal(stale.data,undefined);
  assert.equal((await testEngine(adapter(kv),async()=>{}).request({action:'restore_cloud'})).data.connected,false);
  assert.equal(kv.records.has('test-session/'+SNAPSHOT_KEY),false);
});
test('logout during a local restore returns disconnected rather than an old private snapshot',async()=>{
  const kv=fakeKV();const base=adapter(kv);await base.set({[key]:connection,[SNAPSHOT_KEY]:envelope(localSnapshot())});
  let release;let entered;const waiting=new Promise(resolve=>{entered=resolve;});let paused=false;
  const gated={...base,async get(name){const result=await base.get(name);if(name===SNAPSHOT_KEY&&!paused){paused=true;entered();await new Promise(resolve=>{release=resolve;});}return result;}};
  const restoring=testEngine(gated,async()=>{throw Error('Restore must remain local');}).request({action:'restore_cloud'});
  await waiting;await command(testEngine(adapter(kv),async()=>{}),'disconnect_cloud');release();
  const result=await restoring;
  assert.equal(result.data.connected,false);assert.equal(result.data.snapshot,undefined);
});
test('an online save remains successful if its local snapshot cache cannot be written',async()=>{
  const kv=fakeKV();const base=adapter(kv);await base.set({[key]:connection,[SNAPSHOT_KEY]:envelope(localSnapshot())});
  const fullDisk={...base,async set(values){if(Object.hasOwn(values,SNAPSHOT_KEY))throw Error('Local cache unavailable');return base.set(values);}};
  const engine=testEngine(fullDisk,async()=>reply([{snapshot:localSnapshot(2,'Guardado online')} ]));
  const result=await command(engine,'save_cloud',{data:localSnapshot(1,'Guardado online'),expectedVersion:1});
  assert.equal(result.success,true);assert.equal(result.data.revision,2);assert.ok(result.data.cacheWarning);
  const restored=await engine.request({action:'restore_cloud'});
  assert.equal(restored.data.connected,true);assert.equal(restored.data.cacheAvailable,false);
});

test('switching the remembered library during a manual load rejects the old response',async()=>{
  const kv=fakeKV();const store=adapter(kv);await store.set({[key]:connection,[SNAPSHOT_KEY]:envelope(localSnapshot())});
  let release;let entered;const waiting=new Promise(resolve=>{entered=resolve;});
  const engine=testEngine(adapter(kv),async()=>{entered();return new Promise(resolve=>{release=()=>resolve(reply([{snapshot:localSnapshot(1,'Old library')} ]));});});
  const pending=command(engine,'load_cloud');await waiting;
  const otherLibrary='00000000-0000-0000-0000-000000000001';
  const switched={...identity,libraryId:otherLibrary};
  const snapshot={...localSnapshot(2,'Current library'),libraryId:otherLibrary};
  await store.set({[key]:{token,...switched},[SNAPSHOT_KEY]:{...envelope(snapshot),...switched}});
  release();const result=await pending;
  assert.equal(result.code,'CONFIG_CHANGED');assert.equal(result.data,undefined);
  const cached=(await store.get(SNAPSHOT_KEY))[SNAPSHOT_KEY];
  assert.equal(cached.libraryId,otherLibrary);assert.equal(cached.snapshot.voices[0].notes,'Current library');
});
