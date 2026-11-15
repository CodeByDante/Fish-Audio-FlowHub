import { createCloudEngine } from './cloud-engine.js';
import { createPersistentStorage } from './persistent-storage.js';

/** Remember this browser session using encrypted IndexedDB until explicit logout. */
export function createWebTransport({fetchImpl=(...args)=>globalThis.fetch(...args),assetUrl=path=>new URL('../../'+path,import.meta.url).href,openTab=()=>globalThis.window?.open(assetUrl('index.html'),'_blank','noopener,noreferrer'),storage=createPersistentStorage({namespace:'web-session-v1'})}={}) {
  const managementRequest=(config,operation,data,expectedVersion,{signal})=>{
    const payload={operation,libraryId:config.libraryId};
    if(operation==='save'){payload.data=data;payload.expectedVersion=expectedVersion;}
    // The relay owns bootstrap SQL. A webpage can request only fixed operations.
    return fetchImpl(`https://${config.projectRef}.supabase.co/functions/v1/voice-vault-api`,{
      method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},
      body:JSON.stringify(payload),credentials:'omit',redirect:'error',signal
    });
  };
  const engine=createCloudEngine({storage,fetchImpl,assetUrl,openTab,managementRequest,fishCredentials:'omit'});
  return (action,payload={})=>engine.request({...payload,action});
}
const sessionRequest=createWebTransport();
export const webRequest=(action,payload={})=>sessionRequest(action,payload);
