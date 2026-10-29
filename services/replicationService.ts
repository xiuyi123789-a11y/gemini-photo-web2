import { userStorage, getStorageUser } from './browserStorage';
import { getUserId } from './userIdentity';
import { fileToBase64 } from './replicateService';
import {imageDisplayUrl} from './imageDelivery';
import { canonicalJson, materialIdentity, recoveryKey, matchesOperation, ERROR_MESSAGES, isFinalJob, MAX_REFERENCES } from '../shared/replication-contract.js';

export type ReferenceAngle = 'front'|'side'|'back'|'detail'|'other';
export type PreserveKey = 'background'|'composition'|'lighting'|'perspective';
export type ReplicationKind = 'analysis'|'generation';
export type Point = {x:number;y:number};
export type EditMask = {instanceId:string;points:Point[]};
export type BrushStroke = {tool:'paint'|'erase';size:number;points:Point[]};
export type BrushSelection = {version:1;strokes:BrushStroke[]};
export type Asset = {name:string;url:string;width:number;height:number;sha256:string;angle?:ReferenceAngle};
export type Analysis = {data:any;text:string;rawText:string;revision:number;revisionHash:string;confirmedAt:number|null};
export type Quality = {status:string;mechanism?:string;reasons?:string[];instances?:Array<{instanceId:string;meanDifference:number;changedFraction:number}>};
export type ContourHint={image:'source'|'generated';instanceId:string;kind:'foreground'|'background'|'occlusion';x:number;y:number};
export type JobResult = {raw:Asset;composite:Asset|null;compositeMasks?:Record<string,Asset>;quality:Quality;predictionId:string};
export type ReplicationJob = {
  id:string;jobId:string;requestId:string;ownerId:string;kind:ReplicationKind;
  status:string;stage:string;inputFingerprint:string;sourceHash:string;revision:number;
  completed:number;total:number;createdAt:number;updatedAt:number;
  analysis:Analysis|null;approvedAnalysis?:{text:string;revisionHash:string};analysisJobId:string|null;
  source:Asset;references:Asset[];target:string;results:JobResult[];images:string[];
  errorCode:string|null;error:string|null;quality:Quality|null;pendingRaw:Asset|null;
  recoveryErrorCode?:string|null;
  recoveryNeeded?:boolean;
  outputRecoveryAvailable?:boolean;
  origin?:string|null;derivedFrom?:string|null;
  input?:{masks:EditMask[];protectMasks:Point[][];brush?:BrushSelection;selectedInstances:string[];resolution:string;contourHints?:ContourHint[];selectionMode?:'user-brush';selectionOverrideConfirmed?:boolean};
  predictions:Array<{model:string;predictionId:string|null;remoteStatus:string;reconciliationState:string}>;
};
export type Operation = {jobId?:string;requestId:string;kind:ReplicationKind;inputFingerprint:string;ownerId:string;localOnly?:boolean;sourceJobId?:string};
export type RequestReceipt = {ownerId:string;requestId:string;kind:ReplicationKind;inputFingerprint:string;state:'reserved'|'preparing'|'accepted'|'closed';jobId:string|null;revision:number};
export type GenerationInput = {
  inputFingerprint:string;analysisJobId:string;analysisRevisionHash:string;
  selectedInstances:string[];masks:EditMask[];protectMasks:Point[][];
  brush?:BrushSelection;
  maskSpace:{width:number;height:number;sourceHash:string};resolution:string;count:number;
  preserve:PreserveKey[];notes:string;confirmedPredictions:number;
  outputMode?:'model'|'adaptive';
  selectionMode?:'user-brush';selectionOverrideConfirmed?:boolean;
};
export const ownerId = () => getStorageUser() || getUserId();
const previewKey='replication_preview_v1';
export type ReplicationPreview={ownerId:string;source:Asset;references:Asset[];raw:Asset};
// Presentation only: never restore task authority, submission state, masks or
// fee confirmation from this cache. The authenticated GET remains authoritative.
export function readReplicationPreview():ReplicationPreview|null {
  try{
    const raw=userStorage.getItem(previewKey);if(!raw||raw.length>131072)return null;
    const value=JSON.parse(raw);
    const asset=(a:any)=>{
      if(!a||typeof a.url!=='string'||!a.url.startsWith('/api/replication/assets/')||!Number.isFinite(a.width)||!Number.isFinite(a.height)||a.width<=0||a.height<=0)return false;
      const u=new URL(a.url,'http://localhost');return /^\/api\/replication\/assets\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(u.pathname)&&[...u.searchParams].every(([key,v])=>key==='owner'?v===ownerId():key==='v'&&/^[a-f0-9]{64}$/.test(v));
    };
    if(value.ownerId!==ownerId()||!Number.isFinite(value.savedAt)||Date.now()-value.savedAt>86400000||value.savedAt>Date.now()+60000||!asset(value.source)||!asset(value.raw)||!Array.isArray(value.references)||value.references.length>MAX_REFERENCES||!value.references.every(asset))return null;
    return value;
  }catch{return null;}
}
export function clearReplicationPreview(){try{userStorage.removeItem(previewKey);}catch{}}
export function cacheReplicationPreview(jobs:ReplicationJob[]){
  const newest=[...jobs].sort((a,b)=>b.createdAt-a.createdAt||b.updatedAt-a.updatedAt)[0];
  const job=jobs.find(j=>j.kind==='generation'&&isFinalJob(j)&&j.inputFingerprint===newest?.inputFingerprint&&j.results.some(r=>r.raw?.url));
  if(!job){clearReplicationPreview();return;}
  const pick=(a:Asset)=>({name:a.name,url:a.url,width:a.width,height:a.height,sha256:a.sha256,angle:a.angle});
  const value={ownerId:job.ownerId,savedAt:Date.now(),source:pick(job.source),references:job.references.map(pick),raw:pick(job.results[job.results.length-1].raw)};
  try{const text=JSON.stringify(value);if(job.ownerId===ownerId()&&text.length<=131072)userStorage.setItem(previewKey,text);}catch{}
}
export async function digest(value:BufferSource|string):Promise<string> {
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const readOperation=(kind:ReplicationKind):Operation|null=>{
  try {const value=JSON.parse(userStorage.getItem(recoveryKey(kind))||'null');return value?.kind===kind&&value?.ownerId===ownerId()?value:null;}catch{return null;}
};
export const saveOperation=(operation:Operation)=>userStorage.setItem(recoveryKey(operation.kind),JSON.stringify(operation));
export const forgetOperation=(kind:ReplicationKind)=>userStorage.removeItem(recoveryKey(kind));
const saveIfCurrent=(operation:Operation)=>{if(readOperation(operation.kind)?.requestId===operation.requestId)saveOperation(operation);};
const forgetIfCurrent=(operation:Operation)=>{if(readOperation(operation.kind)?.requestId===operation.requestId)forgetOperation(operation.kind);};
const contextMismatch=()=>Object.assign(new Error(ERROR_MESSAGES.OPERATION_CONTEXT_MISMATCH),{code:'OPERATION_CONTEXT_MISMATCH'});
export const assertOperation=(operation:Operation,job:ReplicationJob)=>{if(!matchesOperation(operation,job))throw contextMismatch();};
// Only an authenticated server snapshot can repair browser metadata. A matching
// account, intent and exact request UUID are mandatory; no fuzzy/time matching.
// This does not resolve or discard an unrelated unknown paid intent.
export function operationFromServerJob(job:ReplicationJob,expected?:Operation):Operation {
  if(job.ownerId!==ownerId()||!['analysis','generation'].includes(job.kind)||typeof job.id!=='string'||!job.id||
    typeof job.requestId!=='string'||!job.requestId||typeof job.inputFingerprint!=='string'||!job.inputFingerprint||
    (expected&&(expected.ownerId!==job.ownerId||expected.kind!==job.kind||expected.requestId!==job.requestId)))throw contextMismatch();
  return {kind:job.kind,jobId:job.id,requestId:job.requestId,inputFingerprint:job.inputFingerprint,ownerId:job.ownerId,
    ...(job.origin==='local_recomposition'?{localOnly:true,sourceJobId:job.derivedFrom||undefined}:{})};
}
const reads=new Map<string,Promise<any>>();
async function request(path:string,body?:unknown,localOnly=false):Promise<any> {
  const key=ownerId()+':'+path;
  if(body===undefined&&reads.has(key))return reads.get(key);
  const run=async()=>{
  const token=!localOnly&&/^\/(analysis|generation|connectivity)$|\/(resume|cancel|reconcile)$/.test(path)?validToken():null;
  const requestId=(body as any)?.requestId;
  const response=await fetch('/api/replication'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','x-user-id':getUserId(),...(token?{'x-replicate-token':token}:{}),...(requestId?{'x-replication-request-id':requestId}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(body===undefined?15000:60000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(ERROR_MESSAGES[data.errorCode]||data.error||`请求未完成（HTTP ${response.status}）`),{status:response.status,code:data.errorCode});
  return data;
  };
  if(body!==undefined)return run(); // Paid POSTs are never retried or coalesced.
  const pending=run().finally(()=>{if(reads.get(key)===pending)reads.delete(key);});
  reads.set(key,pending);return pending;
}
function validToken():string|null {
  const value=userStorage.getItem('replicate_api_token')?.trim();
  if(value&&/[^\x20-\x7e]/.test(value))throw Object.assign(new Error(ERROR_MESSAGES.TOKEN_HEADER_INVALID),{code:'TOKEN_HEADER_INVALID'});
  return value||null;
}
export const getReplicationJob=(id:string):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id));
export const findReplicationRequest=(id:string):Promise<ReplicationJob>=>request('/request/'+encodeURIComponent(id));
export const listActiveJobs=(kind:ReplicationKind):Promise<{jobs:ReplicationJob[];requests?:RequestReceipt[]}>=>request('/active?kind='+kind);
export async function getReplicationWorkbench():Promise<{jobs:ReplicationJob[];requests:RequestReceipt[]}>{
  let snapshot:{jobs:ReplicationJob[];requests:RequestReceipt[]};
  try{snapshot=await request('/workbench');}catch(e){if((e as any).status!==404)throw e;
    const lists=await Promise.all([listActiveJobs('analysis'),listActiveJobs('generation')]);
    snapshot={jobs:lists.flatMap(l=>l.jobs),requests:lists.flatMap(l=>l.requests||[])};
  }
  if(!Array.isArray(snapshot?.jobs)||!Array.isArray(snapshot.requests))throw contextMismatch();
  snapshot.jobs.forEach(job=>operationFromServerJob(job));
  if(snapshot.requests.some(receipt=>receipt.ownerId!==ownerId()||!['analysis','generation'].includes(receipt.kind)))throw contextMismatch();
  return snapshot;
}
export function replicationImageUrl(url:string,thumbnail:boolean|'canvas'=false,retry=0):string{
  if(!url.startsWith('/api/replication/assets/'))return url;
  const display=thumbnail?imageDisplayUrl(url,thumbnail==='canvas'?'canvas':'thumb'):url;
  return display+(retry?(display.includes('?')?'&':'?')+'retry='+retry:'');
}
export const resumeReplicationJob=(id:string,localOnly=false):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id)+'/resume',{},localOnly);
export const cancelReplicationJob=(id:string,localOnly=false):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id)+'/cancel',{},localOnly);
export const checkReplicationConnection=():Promise<any>=>request('/connectivity',{});
export const getReplicationCapabilities=():Promise<{enabled:boolean;maxReferences:number;counts:number[];resolutions:string[];submission?:{analysis:boolean;generation:boolean};adaptiveComposition?:{configured:boolean}}>=>request('/capabilities');
export const reviseAnalysis=(job:ReplicationJob,text:string):Promise<ReplicationJob>=>request('/jobs/'+job.id+'/revision',{text,previousHash:job.analysis?.revisionHash});
export const reviewReplication=(id:string,decision:'accept'|'reject',checks?:Record<string,boolean>):Promise<ReplicationJob>=>request('/jobs/'+id+'/review',{decision,checks});
export const recomposeReplication=(id:string,requestId:string,hints:ContourHint[]):Promise<ReplicationJob>=>request('/jobs/'+id+'/recompose',{requestId,hints});
export const reconcileReplication=(id:string,predictionId:string):Promise<ReplicationJob>=>request('/jobs/'+id+'/reconcile',{predictionId});

const assertReceipt=(operation:Operation,receipt:RequestReceipt)=>{
  if(receipt.ownerId!==operation.ownerId||receipt.kind!==operation.kind||receipt.requestId!==operation.requestId||receipt.inputFingerprint!==operation.inputFingerprint)
    throw contextMismatch();
};
export async function lookupOperation(operation:Operation):Promise<{receipt:RequestReceipt|null;job:ReplicationJob|null;closed:boolean}> {
  if(operation.jobId){const job=await getReplicationJob(operation.jobId);assertOperation(operation,job);return {receipt:null,job,closed:false};}
  let receipt:RequestReceipt|null=null;
  try{receipt=await request('/requests/'+encodeURIComponent(operation.requestId));assertReceipt(operation,receipt);}
  catch(e){if((e as any).status!==404)throw e;}
  if(receipt?.state==='closed')return {receipt,job:null,closed:true};
  if(receipt&&receipt.state!=='accepted')return {receipt,job:null,closed:false};
  try{
    const job=receipt?.jobId?await getReplicationJob(receipt.jobId):await findReplicationRequest(operation.requestId);
    assertOperation(operation,job);
    saveIfCurrent({...operation,jobId:job.id});
    return {receipt,job,closed:false};
  }catch(e){if((e as any).status!==404)throw e;return {receipt,job:null,closed:false};}
}
export async function closeOperation(operation:Operation):Promise<{closed:boolean;receipt:RequestReceipt;job:ReplicationJob|null}> {
  const result=await request('/requests/'+encodeURIComponent(operation.requestId)+'/close',
    {requestId:operation.requestId,kind:operation.kind,inputFingerprint:operation.inputFingerprint});
  assertReceipt(operation,result.receipt);if(result.job)assertOperation(operation,result.job);
  if(result.closed)forgetIfCurrent(operation);else if(result.job)saveIfCurrent({...operation,jobId:result.job.id});
  return result;
}

async function submit(kind:ReplicationKind,payload:any):Promise<ReplicationJob> {
  validToken(); // Header failures are known to occur before HTTP; create no orphan marker.
  for(const k of ['analysis','generation'] as const){
    const previous=readOperation(k);
    if(previous){
      let existing:ReplicationJob;
      try{const result=await lookupOperation(previous);if(result.closed){forgetIfCurrent(previous);continue;}if(!result.job)throw new Error('REQUEST_UNRESOLVED');existing=result.job;}
      catch{throw new Error('先前请求尚未核对，请重新连接查询；已阻止新的收费提交。');}
      if(!isFinalJob(existing))throw new Error('已有任务运行或提交待核对，请先处理该任务。');
    }
  }
  const operation:Operation={kind,requestId:crypto.randomUUID(),ownerId:ownerId(),inputFingerprint:payload.inputFingerprint};
  // Persist before POST. Cross-tab recovery is separate for each kind.
  saveOperation(operation);
  let reserved=false;
  try {
    const receipt:RequestReceipt=await request('/requests',{requestId:operation.requestId,kind,inputFingerprint:operation.inputFingerprint});
    assertReceipt(operation,receipt);reserved=true;
    const job:ReplicationJob=await request('/'+kind,{...payload,requestId:operation.requestId});
    assertOperation(operation,job);saveIfCurrent({...operation,jobId:job.id});return job;
  } catch(error) {
    const status=(error as any).status;
    const closedFailure=()=>Number.isInteger(status)&&status>=400&&status<600?error:
      Object.assign(new Error(ERROR_MESSAGES.REQUEST_CLOSED),{code:'REQUEST_CLOSED'});
    if(!reserved&&[401,403,413,422].includes(status)){forgetIfCurrent(operation);throw error;}
    // GET cannot dispatch work. A 404 alone is never permission to forget or retry.
    let recovered;
    try{recovered=await lookupOperation(operation);}catch{}
    if(recovered?.job)return recovered.job;
    if(recovered?.closed){forgetIfCurrent(operation);throw closedFailure();}
    let sealed;
    try{sealed=await closeOperation(operation);}catch{}
    if(sealed?.closed)throw closedFailure();
    if(sealed?.job)return sealed.job;
    throw Object.assign(new Error('提交结果尚未确认。已停止页面等待；请查询原请求或安全结束本次提交，勿重复提交。'),{code:'SUBMISSION_UNKNOWN'});
  }
}
export async function startAnalysis(source:File,references:Array<{file:File;angle:ReferenceAngle}>,target:string):Promise<ReplicationJob> {
  const sourceHash=await digest(await source.arrayBuffer());
  const refs=await Promise.all(references.map(async r=>({hash:await digest(await r.file.arrayBuffer()),angle:r.angle})));
  const inputFingerprint=await digest(canonicalJson(materialIdentity(sourceHash,refs,target)));
  const images=await Promise.all([fileToBase64(source),...references.map(r=>fileToBase64(r.file))]);
  return submit('analysis',{inputFingerprint,target:target.trim(),sourceImage:images[0],references:references.map((r,i)=>({image:images[i+1],angle:r.angle}))});
}
export const startGeneration=(input:GenerationInput):Promise<ReplicationJob>=>submit('generation',input);
