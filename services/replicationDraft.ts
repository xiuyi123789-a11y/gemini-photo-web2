// Browser-only drafts keep fresh uploads through a local server restart.
// They never submit a model task or contain API credentials.
type DraftImage={file:File;width:number;height:number;angle?:string};
export type ReplicationDraft={version:1;source:DraftImage;references:DraftImage[];savedAt:number};
let database:Promise<IDBDatabase>|undefined;
function open():Promise<IDBDatabase>{
  if(!database)database=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('replication-upload-drafts',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  }).catch(e=>{database=undefined;throw e;});
  return database;
}
export async function saveReplicationDraft(owner:string,draft:ReplicationDraft):Promise<boolean>{
  if(typeof indexedDB==='undefined')return false;
  try{const db=await open();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(draft,owner);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });return true;}catch{return false;}
}
export async function loadReplicationDraft(owner:string):Promise<ReplicationDraft|null>{
  if(typeof indexedDB==='undefined')return null;
  try{const db=await open();return await new Promise((resolve,reject)=>{
    const r=db.transaction('drafts','readonly').objectStore('drafts').get(owner);
    r.onsuccess=()=>{const d=r.result;
      resolve(d?.version===1&&d.source?.file instanceof Blob&&Array.isArray(d.references)&&d.references.every(i=>i.file instanceof Blob)?d:null);};
    r.onerror=()=>reject(r.error);
  });}catch{return null;}
}
export async function clearReplicationDraft(owner:string):Promise<void>{
  if(typeof indexedDB==='undefined')return;
  try{const db=await open();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(owner);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}catch{/* A storage failure must not lock the workbench. */}
}
