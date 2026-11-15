import {CloudError} from './cloud-core.js';

const STORE='records';
const DB_NAME='fish-audio-vault-secure-v1';
const storageError=()=>new CloudError('STORAGE','No se pudo abrir la sesión guardada de este navegador. Comprueba que permita almacenamiento local e inténtalo de nuevo.');

/** IndexedDB stores CryptoKey objects by structured clone, without exporting key bytes. */
export function createIndexedDbKV({indexedDB=globalThis.indexedDB,databaseName=DB_NAME}={}) {
  let opening;
  function open(){
    if(!opening) opening=new Promise((resolve,reject)=>{
      if(!indexedDB){reject(storageError());return;}
      const request=indexedDB.open(databaseName,1);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
      request.onerror=()=>reject(storageError());
      request.onblocked=()=>reject(storageError());
    }).catch(error=>{opening=null;throw error;});
    return opening;
  }
  async function transaction(mode,operation){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,mode);const store=tx.objectStore(STORE);let result;
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(storageError());tx.onabort=()=>reject(storageError());
      try{operation(store,value=>{result=value;});}catch{tx.abort();}
    });
  }
  return {
    get:key=>transaction('readonly',(store,done)=>{const request=store.get(key);request.onsuccess=()=>done(request.result);}),
    setMany:entries=>transaction('readwrite',store=>{for(const [key,value]of entries)store.put(value,key);}),
    removeMany:keys=>transaction('readwrite',store=>{for(const key of keys)store.delete(key);}),
    // The read/write transaction serializes key creation across tabs.
    putIfAbsent:(key,candidate)=>transaction('readwrite',(store,done)=>{
      const request=store.get(key);request.onsuccess=()=>{
        if(request.result!==undefined)done(request.result);
        else{store.put(candidate,key);done(candidate);}
      };
    })
  };
}

/** Persistent encrypted records. Neither the PAT nor signed URLs are stored as plaintext. */
export function createPersistentStorage({namespace='session-v1',kv=createIndexedDbKV(),cryptoImpl=globalThis.crypto}={}) {
  if(!/^[a-z0-9._-]{1,80}$/i.test(namespace))throw new TypeError('Invalid storage namespace');
  const prefix=namespace+'/';const keyId=prefix+'__aes_key';let keyPromise;
  const text=new TextEncoder();const decode=new TextDecoder();
  const usable=key=>key?.type==='secret'&&key.extractable===false&&key.algorithm?.name==='AES-GCM'&&key.usages?.includes('encrypt')&&key.usages?.includes('decrypt');
  async function key(){
    if(!keyPromise)keyPromise=(async()=>{
      if(!cryptoImpl?.subtle||!cryptoImpl?.getRandomValues)throw storageError();
      const existing=await kv.get(keyId);
      if(existing!==undefined){if(!usable(existing))throw storageError();return existing;}
      const candidate=await cryptoImpl.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      const saved=await kv.putIfAbsent(keyId,candidate);
      if(!usable(saved))throw storageError();return saved;
    })().catch(error=>{keyPromise=null;throw error;});
    return keyPromise;
  }
  function recordId(name){if(typeof name!=='string'||!name||name==='__aes_key'||name.length>300)throw storageError();return prefix+name;}
  async function encrypt(name,value){
    const iv=cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext=await cryptoImpl.subtle.encrypt({name:'AES-GCM',iv,additionalData:text.encode(recordId(name))},await key(),text.encode(JSON.stringify(value)));
    return {version:1,iv,ciphertext};
  }
  async function decrypt(name,record){
    if(!record||record.version!==1||!(record.iv instanceof Uint8Array)||record.iv.length!==12||!(record.ciphertext instanceof ArrayBuffer))throw storageError();
    const value=await cryptoImpl.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:text.encode(recordId(name))},await key(),record.ciphertext);
    return JSON.parse(decode.decode(value));
  }
  return Object.freeze({
    async get(name){try{const record=await kv.get(recordId(name));return {[name]:record===undefined?undefined:await decrypt(name,record)};}catch{throw storageError();}},
    async set(values){try{const entries=await Promise.all(Object.entries(values).map(async([name,value])=>[recordId(name),await encrypt(name,value)]));await kv.setMany(entries);}catch{throw storageError();}},
    async remove(names){try{await kv.removeMany((Array.isArray(names)?names:[names]).map(recordId));}catch{throw storageError();}}
  });
}
