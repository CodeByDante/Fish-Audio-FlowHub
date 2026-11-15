import { createCloudEngine, CLOUD_ACTIONS } from './cloud-engine.js';
import { createPersistentStorage } from './persistent-storage.js';

const trustedStorage = createPersistentStorage({namespace:'extension-session-v1'});
const openTab = () => chrome.tabs.create({url:chrome.runtime.getURL('index.html')});
const engine = createCloudEngine({storage:trustedStorage,assetUrl:path=>chrome.runtime.getURL(path),openTab});
chrome.action.onClicked.addListener(openTab);
chrome.runtime.onMessage.addListener((request,sender,sendResponse)=>{
  const origin=chrome.runtime.getURL('');
  if(sender.id!==chrome.runtime.id || typeof sender.url!=='string' || !sender.url.startsWith(origin) || !CLOUD_ACTIONS.includes(request?.action)) {
    sendResponse({success:false,code:'FORBIDDEN',error:'Solicitud no autorizada.'});return false;
  }
  engine.request(request).then(sendResponse);
  return true;
});
