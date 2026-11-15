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
