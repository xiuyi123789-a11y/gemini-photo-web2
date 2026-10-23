import { userStorage, getStorageUser } from './browserStorage';
import { getUserId } from './userIdentity';
import { fileToBase64 } from './replicateService';
import { canonicalJson, materialIdentity, recoveryKey, matchesOperation, ERROR_MESSAGES, isFinalJob } from '../shared/replication-contract.js';

export type ReferenceAngle = 'front'|'side'|'back'|'detail'|'other';
export type PreserveKey = 'background'|'composition'|'lighting'|'perspective';
export type ReplicationKind = 'analysis'|'generation';
export type Point = {x:number;y:number};
export type EditMask = {instanceId:string;points:Point[]};
export type Asset = {name:string;url:string;width:number;height:number;sha256:string;angle?:ReferenceAngle};
export type Analysis = {data:any;text:string;rawText:string;revision:number;revisionHash:string;confirmedAt:number|null};
export type Quality = {status:string;reasons?:string[];instances?:Array<{instanceId:string;meanDifference:number;changedFraction:number}>};
export type JobResult = {raw:Asset;composite:Asset|null;quality:Quality;predictionId:string};
export type ReplicationJob = {
  id:string;jobId:string;requestId:string;ownerId:string;kind:ReplicationKind;
  status:string;stage:string;inputFingerprint:string;sourceHash:string;revision:number;
  completed:number;total:number;createdAt:number;updatedAt:number;
  analysis:Analysis|null;approvedAnalysis?:{text:string;revisionHash:string};analysisJobId:string|null;
  source:Asset;references:Asset[];target:string;results:JobResult[];images:string[];
  errorCode:string|null;error:string|null;quality:Quality|null;pendingRaw:Asset|null;
  recoveryErrorCode?:string|null;
  input?:{masks:EditMask[];protectMasks:Point[][];selectedInstances:string[];resolution:string};
  predictions:Array<{model:string;predictionId:string|null;remoteStatus:string;reconciliationState:string}>;
};
export type Operation = {jobId?:string;requestId:string;kind:ReplicationKind;inputFingerprint:string;ownerId:string};
export type GenerationInput = {
  inputFingerprint:string;analysisJobId:string;analysisRevisionHash:string;
  selectedInstances:string[];masks:EditMask[];protectMasks:Point[][];
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
async function request(path:string,body?:unknown):Promise<any> {
  const token=userStorage.getItem('replicate_api_token');
  const response=await fetch('/api/replication'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','x-user-id':getUserId(),...(token?{'x-replicate-token':token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(ERROR_MESSAGES[data.errorCode]||data.error||`请求未完成（HTTP ${response.status}）`),{status:response.status,code:data.errorCode});
  return data;
}
export const getReplicationJob=(id:string):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id));
export const findReplicationRequest=(id:string):Promise<ReplicationJob>=>request('/request/'+encodeURIComponent(id));
export const listActiveJobs=(kind:ReplicationKind):Promise<{jobs:ReplicationJob[]}>=>request('/active?kind='+kind);
export const cancelReplicationJob=(id:string):Promise<ReplicationJob>=>request('/jobs/'+encodeURIComponent(id)+'/cancel',{});
export const checkReplicationConnection=():Promise<any>=>request('/connectivity',{});
export const getReplicationCapabilities=():Promise<{enabled:boolean;maxReferences:number;counts:number[];resolutions:string[]}>=>request('/capabilities');
export const reviseAnalysis=(job:ReplicationJob,text:string):Promise<ReplicationJob>=>request('/jobs/'+job.id+'/revision',{text,previousHash:job.analysis?.revisionHash});
export const reviewReplication=(id:string,decision:'accept'|'reject',checks?:Record<string,boolean>):Promise<ReplicationJob>=>request('/jobs/'+id+'/review',{decision,checks});
export const reconcileReplication=(id:string,predictionId:string):Promise<ReplicationJob>=>request('/jobs/'+id+'/reconcile',{predictionId});

async function submit(kind:ReplicationKind,payload:any):Promise<ReplicationJob> {
  for(const k of ['analysis','generation'] as const){
    const previous=readOperation(k);
    if(previous){
      let existing:ReplicationJob;
      try{existing=previous.jobId?await getReplicationJob(previous.jobId):await findReplicationRequest(previous.requestId);assertOperation(previous,existing);}
      catch{throw new Error('先前请求尚未核对，请重新连接查询；已阻止新的收费提交。');}
      if(!isFinalJob(existing))throw new Error('已有任务运行或提交待核对，请先处理该任务。');
    }
  }
  const operation:Operation={kind,requestId:crypto.randomUUID(),ownerId:ownerId(),inputFingerprint:payload.inputFingerprint};
  // Persist before POST. Cross-tab recovery is separate for each kind.
  saveOperation(operation);
  try {
    const job:ReplicationJob=await request('/'+kind,{...payload,requestId:operation.requestId});
    assertOperation(operation,job);saveOperation({...operation,jobId:job.id});return job;
  } catch(error) {
    const status=(error as any).status;
    if(status&&status<500){forgetOperation(kind);throw error;}
    // Only GET recovery. A 404 here can race an in-flight server request; keep the pending slot.
    try {const job=await findReplicationRequest(operation.requestId);assertOperation(operation,job);saveOperation({...operation,jobId:job.id});return job;}
    catch {throw Object.assign(new Error('提交结果尚未确认，后台可能已经接收。请重新连接查询，请勿重复提交。'),{code:'SUBMISSION_UNKNOWN'});}
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
