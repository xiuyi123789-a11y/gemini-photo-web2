import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { REPLICATION_MODELS, MAX_REFERENCES, isFinalJob, ERROR_MESSAGES, canonicalJson } from '../shared/replication-contract.js';
import { sha256 } from './replication-assets.js';
import { createReplicationWorker } from './replication-worker.js';
import { prepareMasks } from './replication-composite.js';
import { validateAnalysisInput, validateGenerationInput, payloadHash, fail, UUID } from './replication-validation.js';
export { REPLICATION_MODELS };

export function createReplicationRouter({store,assets,getProvider,pollMs,budgetMs,leaseMs,logger,
  enabled=()=>process.env.REPLICATION_ENABLED!=='false',advancedOutputs=process.env.REPLICATION_ADVANCED_OUTPUTS==='true',retentionDays=30,maxReferences=MAX_REFERENCES}) {
  const router=Router(),worker=createReplicationWorker({store,assets,pollMs,budgetMs,leaseMs,logger});
  const view=async job=>({id:job.id,jobId:job.id,ownerId:job.ownerId,requestId:job.requestId,kind:job.kind,status:job.status,stage:job.stage,
    inputFingerprint:job.inputFingerprint,sourceHash:job.sourceHash,createdAt:job.createdAt,updatedAt:job.updatedAt,revision:job.revision,
    completed:job.kind==='analysis'?(job.status==='succeeded'?1:0):job.results.length,total:job.total,
    analysis:job.analysis||null,analysisJobId:job.analysisJobId||null,approvedAnalysis:job.approvedAnalysis||null,
    source:job.assets.source,references:job.assets.references,target:job.target||'',input:job.kind==='generation'?job.input:null,
    results:job.results,images:job.kind==='analysis'?[]:job.images,pendingRaw:job.pendingRaw||null,quality:job.quality||null,
    errorCode:job.errorCode||null,error:job.errorCode?(ERROR_MESSAGES[job.errorCode]||'任务尚未完成，请查看阶段与任务标识。'):null,
    expiresAt:job.expiresAt,
    predictions:(await store.attempts(job.id)).map(a=>({localAttemptId:a.id,model:a.model,predictionId:a.predictionId,attemptNo:a.attemptNo,
      remoteStatus:a.remoteStatus,createStartedAt:a.createStartedAt,cancelRequestedAt:a.cancelRequestedAt||null,reconciliationState:a.reconciliationState,metrics:a.metricsSummary||null}))});
  async function own(req,id) {
    if(!UUID.test(id||''))throw fail('JOB_NOT_FOUND',404);
    const j=await store.get(id);if(!j||j.ownerId!==req.userId)throw fail('JOB_NOT_FOUND',404);
    if(j.expiresAt<Date.now()&&isFinalJob(j))throw fail('JOB_EXPIRED',410);return j;
  }
  const error=(res,e)=>res.status(e.status&&e.status<600?e.status:500).json({errorCode:e.code||'INTERNAL_ERROR',error:ERROR_MESSAGES[e.code]||'请求未完成，请核对任务状态。'});
  const route=handler=>async(req,res)=>{try{await handler(req,res);}catch(e){error(res,e);}};
  const resume=(req,job)=>{
    if(isFinalJob(job))return null;
    try{const provider=getProvider(req);if(provider.accountRef!==job.providerAccountRef)return 'PROVIDER_ACCOUNT_MISMATCH';worker.wake(job,provider);return null;}
    catch{return 'CREDENTIAL_REQUIRED';}
  };
  const recoveringView=async(req,job)=>{const recoveryErrorCode=resume(req,job);return {...await view(job),recoveryErrorCode,
    ...(recoveryErrorCode?{errorCode:recoveryErrorCode,error:ERROR_MESSAGES[recoveryErrorCode]}:{})};};
  function same(old,kind,hash) {
    if(old.kind!==kind||old.payloadHash!==hash)throw fail('IDEMPOTENCY_CONFLICT',409);return old;
  }
  async function create(req,res,kind) {
    if(!enabled())throw fail('FEATURE_DISABLED',503);
    const input=kind==='analysis'?validateAnalysisInput(req.body,{maxReferences}):validateGenerationInput(req.body,{advancedOutputs});
    const hash=payloadHash(input),old=await store.byRequest(req.userId,input.requestId);
    if(old){same(old,kind,hash);resume(req,old);return res.status(202).json(await view(old));}
    let analysisJob;
    if(kind==='generation') {
      analysisJob=await own(req,input.analysisJobId);
      if(analysisJob.kind!=='analysis'||analysisJob.status!=='succeeded'||!analysisJob.analysis?.data||!analysisJob.analysis.confirmedAt)throw fail('ANALYSIS_REQUIRED',409);
      if(analysisJob.inputFingerprint!==input.inputFingerprint||analysisJob.analysis.revisionHash!==input.analysisRevisionHash)throw fail('ANALYSIS_STALE',409);
      const ids=analysisJob.analysis.data.scene.old_product_instances.map(i=>i.instance_id);
      if(input.selectedInstances.some(i=>!ids.includes(i)))throw fail('TARGET_SELECTION_REQUIRED',422);
      const s=analysisJob.assets.source;
      if(input.maskSpace.width!==s.width||input.maskSpace.height!==s.height||input.maskSpace.sourceHash!==s.sha256)throw fail('TARGET_SELECTION_REQUIRED',422);
      await prepareMasks(s.width,s.height,input.masks,input.protectMasks);
    }
    const provider=getProvider(req);
    const active=(await store.list()).filter(j=>!isFinalJob(j));
    if(active.some(j=>j.ownerId===req.userId))throw fail('TASK_BUSY',409);
    if(active.length>=20)throw fail('QUEUE_BUSY',503);
    const job={id:randomUUID(),ownerId:req.userId,requestId:input.requestId,kind,payloadHash:hash,inputFingerprint:input.inputFingerprint,
      sourceHash:kind==='analysis'?input.sourceHash:analysisJob.sourceHash,referenceHashes:kind==='analysis'?input.referenceHashes:analysisJob.referenceHashes,
      target:kind==='analysis'?input.target:analysisJob.target,providerAccountRef:provider.accountRef,status:'queued',stage:'queued',revision:0,
      createdAt:Date.now(),updatedAt:Date.now(),expiresAt:Date.now()+retentionDays*86400000,results:[],images:[],analysis:null,
      total:kind==='analysis'?1:input.count,errorCode:null,workerLease:null,cancelRequested:false,
      ...(kind==='generation'?{analysisJobId:analysisJob.id,approvedAnalysis:{text:analysisJob.analysis.text,revisionHash:analysisJob.analysis.revisionHash,revision:analysisJob.analysis.revision},input}:{}),assets:null};
    try {
      job.assets=kind==='analysis'?await assets.prepare(job,input):await assets.cloneMaterials(job,analysisJob);
      const stored=await store.create(job);
      if(stored.id!==job.id){await assets.remove(job);same(stored,kind,hash);resume(req,stored);return res.status(202).json(await view(stored));}
      res.status(202).json(await view(job));worker.wake(job,provider);
    } catch(e){if(!await store.get(job.id))await assets.remove(job).catch(()=>{});throw e;}
  }
  router.get('/capabilities',route(async(req,res)=>res.json({version:2,enabled:enabled(),maxReferences,
    counts:advancedOutputs?[1,2,4]:[1],resolutions:advancedOutputs?['1K','2K','4K']:['1K','2K'],models:REPLICATION_MODELS,retentionDays})));
  router.post('/connectivity',route(async(req,res)=>res.json({success:true,models:await getProvider(req).connectivity()})));
  router.post('/analysis',route((req,res)=>create(req,res,'analysis')));
  router.post('/generation',route((req,res)=>create(req,res,'generation')));
  router.get('/active',route(async(req,res)=>{
    if(!['analysis','generation'].includes(req.query.kind))throw fail('INPUT_INVALID');
    const jobs=(await store.list()).filter(j=>j.ownerId===req.userId&&j.kind===req.query.kind&&!isFinalJob(j));
    res.json({jobs:await Promise.all(jobs.map(j=>recoveringView(req,j)))});
  }));
  router.get('/request/:requestId',route(async(req,res)=>{
    if(!UUID.test(req.params.requestId))throw fail('JOB_NOT_FOUND',404);
    const job=await store.byRequest(req.userId,req.params.requestId);if(!job)throw fail('JOB_NOT_FOUND',404);
    res.json(await recoveringView(req,job));
  }));
  const read=route(async(req,res)=>{const job=await own(req,req.params.id);res.json(await recoveringView(req,job));});
  router.get('/jobs/:id',read);router.get('/:id',read);
  const cancel=route(async(req,res)=>{
    const job=await own(req,req.params.id);if(isFinalJob(job))return res.status(202).json(await view(job));
    const provider=getProvider(req);if(provider.accountRef!==job.providerAccountRef)throw fail('PROVIDER_ACCOUNT_MISMATCH',409);
    const next=await store.update(job.id,j=>isFinalJob(j)?null:{...j,cancelRequested:true,status:'cancel_requested',stage:'cancel_requested'});
    worker.wake(next,provider);res.status(202).json(await view(next));
  });
  router.post('/jobs/:id/cancel',cancel);router.post('/:id/cancel',cancel);
  router.post('/jobs/:id/revision',route(async(req,res)=>{
    const job=await own(req,req.params.id),{text,previousHash}=req.body||{};
    if(job.kind!=='analysis'||job.status!=='succeeded'||!job.analysis?.data)throw fail('ANALYSIS_REQUIRED',409);
    if(typeof text!=='string'||!text.trim()||text.length>16000)throw fail('INPUT_INVALID');
    let conflict=false;
    const next=await store.update(job.id,j=>{if(j.analysis.revisionHash!==previousHash){conflict=true;return null;}return {...j,analysis:{...j.analysis,text:text.trim(),revision:j.analysis.revision+1,revisionHash:sha256(text.trim()),confirmedAt:Date.now()}};});
    if(conflict)throw fail('ANALYSIS_STALE',409);res.json(await view(next));
  }));
  router.post('/jobs/:id/review',route(async(req,res)=>{
    const job=await own(req,req.params.id),{decision,checks}=req.body||{};
    if(job.kind!=='generation'||job.status!=='completed_needs_review')throw fail('REVIEW_NOT_AVAILABLE',409);
    if(!['accept','reject'].includes(decision))throw fail('INPUT_INVALID');
    if(decision==='accept'&&(!checks||!['identity','allInstances','occlusion','scene'].every(k=>checks[k]===true)))throw fail('REVIEW_REQUIRED',422);
    const next=await store.update(job.id,j=>j.status!=='completed_needs_review'?null:{...j,status:decision==='accept'?'succeeded':'quality_failed',
      stage:'human_review',quality:{status:decision==='accept'?'passed':'failed',reviewedAt:Date.now(),checks:decision==='accept'?checks:null},errorCode:decision==='accept'?null:'QUALITY_FAILED'});
    res.json(await view(next));
  }));
  // Manual reconciliation is explicit and evidence-bound. Never guess from neighboring timestamps.
  router.post('/jobs/:id/reconcile',route(async(req,res)=>{
    const job=await own(req,req.params.id);
    if(!['submission_unknown','cancel_unknown'].includes(job.status))throw fail('RECONCILIATION_NOT_REQUIRED',409);
    const provider=getProvider(req);if(provider.accountRef!==job.providerAccountRef)throw fail('PROVIDER_ACCOUNT_MISMATCH',409);
    const attempt=(await store.attempts(job.id)).find(a=>!a.predictionId);
    if(!attempt)throw fail('RECONCILIATION_NOT_REQUIRED',409);
    const prediction=await provider.get(req.body?.predictionId);
    const createdAt=Date.parse(prediction.created_at);
    if(prediction.model!==attempt.model||!prediction.input||sha256(canonicalJson(prediction.input))!==attempt.inputHash||
      !Number.isFinite(createdAt)||createdAt<attempt.createStartedAt-120000||createdAt>attempt.deadlineAt)throw fail('RECONCILIATION_EVIDENCE_REQUIRED',422);
    await store.updateAttempt({...attempt,predictionId:prediction.id,remoteStatus:prediction.status,reconciliationState:'manual_evidence_linked',createAckAt:Date.now()});
    const next=await store.update(job.id,j=>({...j,status:j.cancelRequested?'cancel_requested':'running',errorCode:null}));
    worker.wake(next,provider);res.json(await view(next));
  }));
  router.get('/assets/:id/:name',route(async(req,res)=>{
    const job=await own(req,req.params.id);
    const list=[job.assets.source,...job.assets.references,...job.results.flatMap(r=>[r.raw,r.composite]),job.pendingRaw].filter(Boolean);
    const asset=list.find(a=>a.name===req.params.name);if(!asset)throw fail('JOB_NOT_FOUND',404);
    res.type('png').send(await assets.read(job,asset));
  }));
  // Cleanup is local-only, explicit, and never removes unresolved remote attempts.
  router.cleanup=async()=>{for(const job of await store.list())if(isFinalJob(job)&&job.expiresAt<Date.now()){
    const dependents=(await store.list()).some(j=>j.analysisJobId===job.id&&(!isFinalJob(j)||j.expiresAt>Date.now()));
    if(!dependents){await assets.remove(job);await store.remove(job.id);}
  }};
  router.worker=worker;
  return router;
}
