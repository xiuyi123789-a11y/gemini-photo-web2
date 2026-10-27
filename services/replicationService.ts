import { userStorage, getStorageUser } from './browserStorage';
import { getUserId } from './userIdentity';
import { fileToBase64 } from './replicateService';
import { canonicalJson, materialIdentity, recoveryKey, matchesOperation, ERROR_MESSAGES, isFinalJob } from '../shared/replication-contract.js';

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
  origin?:string|null;derivedFrom?:string|null;
  input?:{masks:EditMask[];protectMasks:Point[][];brush?:BrushSelection;selectedInstances:string[];resolution:string;contourHints?:ContourHint[]};
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
};
export const ownerId = () => getStorageUser() || getUserId();
export async function digest(value:BufferSource|string):Promise<string> {
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const readOperation=(kind:ReplicationKind):Operation|null=>{
  try {const value=JSON.parse(userStorage.getItem(recoveryKey(kind))||'null');return value?.kind===kind&&value?.ownerId===ownerId()?value:null;}catch{return null;}
};
export const saveOperation=(operation:Operation)=>userStorage.setItem(recoveryKey(operation.kind),JSON.stringify(operation));
export const forgetOperation=(kind:ReplicationKind)=>userStorage.removeItem(recoveryKey(kind));
export const assertOperation=(operation:Operation,job:ReplicationJob)=>{if(!matchesOperation(operation,job))throw new Error('恢复任务与账号、素材或操作类型不一致，已阻止关联。');};
async function request(path:string,body?:unknown,localOnly=false):Promise<any> {
  const token=!localOnly&&/^\/(analysis|generation|connectivity)$|\/(resume|cancel|reconcile)$/.test(path)?validToken():null;
  const requestId=(body as any)?.requestId;
  const response=await fetch('/api/replication'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','x-user-id':getUserId(),...(token?{'x-replicate-token':token}:{}),...(requestId?{'x-replication-request-id':requestId}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(ERROR_MESSAGES[data.errorCode]||data.error||`请求未完成（HTTP ${response.status}）`),{status:response.status,code:data.errorCode});
  return data;
}
function validToken():string|null {
  const value=userStorage.getItem('replicate_api_token')?.trim();
  if(value&&/[^\x20-\x7e]/.test(value))throw Object.assign(new Error(ERROR_MESSAGES.TOKEN_HEADER_INVALID),{code:'TOKEN_HEADER_INVALID'});
  return value||null;
}
export const getReplicationJob=(id:string):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id));
export const findReplicationRequest=(id:string):Promise<ReplicationJob>=>request('/request/'+encodeURIComponent(id));
export const listActiveJobs=(kind:ReplicationKind):Promise<{jobs:ReplicationJob[];requests?:RequestReceipt[]}>=>request('/active?kind='+kind);
export const resumeReplicationJob=(id:string,localOnly=false):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id)+'/resume',{},localOnly);
export const cancelReplicationJob=(id:string,localOnly=false):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id)+'/cancel',{},localOnly);
export const checkReplicationConnection=():Promise<any>=>request('/connectivity',{});
export const getReplicationCapabilities=():Promise<{enabled:boolean;maxReferences:number;counts:number[];resolutions:string[];adaptiveComposition?:{configured:boolean}}>=>request('/capabilities');
export const reviseAnalysis=(job:ReplicationJob,text:string):Promise<ReplicationJob>=>request('/jobs/'+job.id+'/revision',{text,previousHash:job.analysis?.revisionHash});
export const reviewReplication=(id:string,decision:'accept'|'reject',checks?:Record<string,boolean>):Promise<ReplicationJob>=>request('/jobs/'+id+'/review',{decision,checks});
export const recomposeReplication=(id:string,requestId:string,hints:ContourHint[]):Promise<ReplicationJob>=>request('/jobs/'+id+'/recompose',{requestId,hints});
export const reconcileReplication=(id:string,predictionId:string):Promise<ReplicationJob>=>request('/jobs/'+id+'/reconcile',{predictionId});

const assertReceipt=(operation:Operation,receipt:RequestReceipt)=>{
  if(receipt.ownerId!==operation.ownerId||receipt.kind!==operation.kind||receipt.requestId!==operation.requestId||receipt.inputFingerprint!==operation.inputFingerprint)
    throw new Error('受理回执与账号、素材或操作类型不一致，已阻止关联。');
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
    assertOperation(operation,job);saveOperation({...operation,jobId:job.id});return {receipt,job,closed:false};
  }catch(e){if((e as any).status!==404)throw e;return {receipt,job:null,closed:false};}
}
export async function closeOperation(operation:Operation):Promise<{closed:boolean;receipt:RequestReceipt;job:ReplicationJob|null}> {
  const result=await request('/requests/'+encodeURIComponent(operation.requestId)+'/close',
    {requestId:operation.requestId,kind:operation.kind,inputFingerprint:operation.inputFingerprint});
  assertReceipt(operation,result.receipt);if(result.job)assertOperation(operation,result.job);
  if(result.closed)forgetOperation(operation.kind);else if(result.job)saveOperation({...operation,jobId:result.job.id});
  return result;
}

async function submit(kind:ReplicationKind,payload:any):Promise<ReplicationJob> {
  validToken(); // Header failures are known to occur before HTTP; create no orphan marker.
  for(const k of ['analysis','generation'] as const){
    const previous=readOperation(k);
    if(previous){
      let existing:ReplicationJob;
      try{const result=await lookupOperation(previous);if(result.closed){forgetOperation(k);continue;}if(!result.job)throw new Error('REQUEST_UNRESOLVED');existing=result.job;}
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
    assertOperation(operation,job);saveOperation({...operation,jobId:job.id});return job;
  } catch(error) {
    const status=(error as any).status;
    const closedFailure=()=>Number.isInteger(status)&&status>=400&&status<600?error:
      Object.assign(new Error(ERROR_MESSAGES.REQUEST_CLOSED),{code:'REQUEST_CLOSED'});
    if(!reserved&&[401,403,413,422].includes(status)){forgetOperation(kind);throw error;}
    // GET cannot dispatch work. A 404 alone is never permission to forget or retry.
    let recovered;
    try{recovered=await lookupOperation(operation);}catch{}
    if(recovered?.job)return recovered.job;
    if(recovered?.closed){forgetOperation(kind);throw closedFailure();}
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
