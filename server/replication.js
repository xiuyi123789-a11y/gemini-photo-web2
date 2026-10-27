import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { REPLICATION_MODELS, MAX_REFERENCES, isFinalJob, ERROR_MESSAGES, canonicalJson, compositionFailure } from '../shared/replication-contract.js';
import { sha256 } from './replication-assets.js';
import { createReplicationWorker } from './replication-worker.js';
import { prepareMasks, createRegionGuide } from './replication-composite.js';
import { matchBrushSubjects } from '../shared/replication-brush.js';
import {createLocalVision,localVisionConfigured} from './replication-vision.js';
import { validateAnalysisInput, validateGenerationInput, validateRequestIdentity, validateContourHints, payloadHash, fail, UUID } from './replication-validation.js';
export { REPLICATION_MODELS };

export function createReplicationRouter({store,assets,getProvider,vision,pollMs,budgetMs,leaseMs,logger,
  enabled=()=>process.env.REPLICATION_ENABLED!=='false',canSubmit=()=>true,advancedOutputs=process.env.REPLICATION_ADVANCED_OUTPUTS==='true',retentionDays=30,maxReferences=MAX_REFERENCES}) {
  const router=Router(),worker=createReplicationWorker({store,assets,vision,pollMs,budgetMs,leaseMs,logger});
  let visionProbe;
  const requireVision=async()=>{
    if(vision)return; // Dependency injection is restricted to application composition/tests.
    if(!localVisionConfigured())throw fail('SEGMENTATION_UNAVAILABLE',503);
    visionProbe ||= createLocalVision()({probe:true}).then(v=>v.ready===true).catch(()=>false);
    if(!await visionProbe){visionProbe=null;throw fail('SEGMENTATION_UNAVAILABLE',503);}
  };
  const view=async job=>({id:job.id,jobId:job.id,ownerId:job.ownerId,requestId:job.requestId,kind:job.kind,status:job.status,stage:job.stage,
    inputFingerprint:job.inputFingerprint,sourceHash:job.sourceHash,createdAt:job.createdAt,updatedAt:job.updatedAt,revision:job.revision,
    recoveryNeeded:!isFinalJob(job)&&(!job.workerLease||job.workerLease.until<=Date.now()),
    completed:job.kind==='analysis'?(job.status==='succeeded'?1:0):job.results.length,total:job.total,
    analysis:job.analysis||null,analysisJobId:job.analysisJobId||null,approvedAnalysis:job.approvedAnalysis||null,origin:job.origin||null,derivedFrom:job.derivedFrom||null,
    source:job.assets.source,references:job.assets.references,target:job.target||'',input:job.kind==='generation'?job.input:null,
    results:job.results,images:job.kind==='analysis'?[]:job.images,pendingRaw:job.pendingRaw||null,quality:job.quality||null,
    errorCode:job.errorCode||null,error:compositionFailure(job)?.message||(job.errorCode?(ERROR_MESSAGES[job.errorCode]||'任务尚未完成，请查看阶段与任务标识。'):null),
    expiresAt:job.expiresAt,
    predictions:(await store.attempts(job.id)).map(a=>({localAttemptId:a.id,model:a.model,predictionId:a.predictionId,attemptNo:a.attemptNo,
      remoteStatus:a.remoteStatus,createStartedAt:a.createStartedAt,cancelRequestedAt:a.cancelRequestedAt||null,reconciliationState:a.reconciliationState,metrics:a.metricsSummary||null}))});
  async function own(req,id) {
    if(!UUID.test(id||''))throw fail('JOB_NOT_FOUND',404);
    const j=await store.get(id);if(!j||j.ownerId!==req.userId)throw fail('JOB_NOT_FOUND',404);
    if(!j.retainOriginals&&j.expiresAt<Date.now()&&isFinalJob(j))throw fail('JOB_EXPIRED',410);return j;
  }
  const error=(res,e)=>res.status(e.status&&e.status<600?e.status:500).json({errorCode:e.code||'INTERNAL_ERROR',error:ERROR_MESSAGES[e.code]||'请求未完成，请核对任务状态。'});
  const route=handler=>async(req,res)=>{try{await handler(req,res);}catch(e){error(res,e);}};
  const resume=(req,job)=>{
    if(isFinalJob(job))return null;
    if(job.origin==='local_recomposition'){worker.wake(job,{accountRef:'local'},{resumeOnly:true});return null;}
    try{const provider=getProvider(req);if(provider.accountRef!==job.providerAccountRef)return 'PROVIDER_ACCOUNT_MISMATCH';worker.wake(job,provider,{resumeOnly:true});return null;}
    catch{return 'CREDENTIAL_REQUIRED';}
  };
  const receiptView=r=>({ownerId:r.ownerId,requestId:r.requestId,kind:r.kind,inputFingerprint:r.inputFingerprint,state:r.state,jobId:r.jobId||null,revision:r.revision});
  async function reserve(identity) {
    const old=await store.getRequest(identity.ownerId,identity.requestId);
    if(old){if(old.kind!==identity.kind||old.inputFingerprint!==identity.inputFingerprint)throw fail('IDEMPOTENCY_CONFLICT',409);return old;}
    if((await store.list()).some(j=>j.ownerId===identity.ownerId&&!isFinalJob(j)))throw fail('TASK_BUSY',409);
    return store.reserveRequest({...identity,state:'reserved',jobId:null,revision:0,createdAt:Date.now(),updatedAt:Date.now()});
  }
  function same(old,kind,hash) {
    if(old.kind!==kind||old.payloadHash!==hash)throw fail('IDEMPOTENCY_CONFLICT',409);return old;
  }
  async function create(req,res,kind) {
    if(!enabled()||!canSubmit(kind,req))throw fail('FEATURE_DISABLED',503);
    const input=kind==='analysis'?validateAnalysisInput(req.body,{maxReferences}):validateGenerationInput(req.body,{advancedOutputs});
    const identity={ownerId:req.userId,requestId:input.requestId,kind,inputFingerprint:input.inputFingerprint};
    const hash=payloadHash(input),old=await store.byRequest(req.userId,input.requestId);
    if(old){same(old,kind,hash);return res.status(202).json(await view(old));}
    let analysisJob;
    if(kind==='generation') {
      if(input.outputMode!=='model')await requireVision(); // Historical adaptive requests still require reliable local composition.
      analysisJob=await own(req,input.analysisJobId);
      if(analysisJob.kind!=='analysis'||analysisJob.status!=='succeeded'||!analysisJob.analysis?.data||!analysisJob.analysis.confirmedAt)throw fail('ANALYSIS_REQUIRED',409);
      if(analysisJob.inputFingerprint!==input.inputFingerprint||analysisJob.analysis.revisionHash!==input.analysisRevisionHash)throw fail('ANALYSIS_STALE',409);
      const ids=analysisJob.analysis.data.scene.old_product_instances.map(i=>i.instance_id);
      if(input.selectedInstances.some(i=>!ids.includes(i)))throw fail('TARGET_SELECTION_REQUIRED',422);
      const s=analysisJob.assets.source;
      if(input.maskSpace.width!==s.width||input.maskSpace.height!==s.height||input.maskSpace.sourceHash!==s.sha256)throw fail('TARGET_SELECTION_REQUIRED',422);
      const subjects=analysisJob.analysis.data.scene.old_product_instances;
      if(input.brush){
        const match=matchBrushSubjects(input.brush,subjects,s.width,s.height);
        if(!match.valid||canonicalJson([...match.selectedInstances].sort())!==canonicalJson([...input.selectedInstances].sort()))throw fail('TARGET_SELECTION_REQUIRED',422);
      }
      await prepareMasks(s.width,s.height,input.masks,input.protectMasks,{brush:input.brush,subjects});
    }
    const provider=getProvider(req);
    const active=(await store.list()).filter(j=>!isFinalJob(j));
    if(active.some(j=>j.ownerId===req.userId))throw fail('TASK_BUSY',409);
    if(active.length>=20)throw fail('QUEUE_BUSY',503);
    const receipt=await reserve(identity);
    if(receipt.state==='closed')throw fail('REQUEST_CLOSED',410);
    const intakeId=randomUUID();
    const claimed=await store.updateRequest(req.userId,input.requestId,r=>r.state==='reserved'?{...r,state:'preparing',intakeId,payloadHash:hash}:null);
    if(claimed?.state==='closed')throw fail('REQUEST_CLOSED',410);
    if(claimed?.payloadHash!==hash)throw fail('IDEMPOTENCY_CONFLICT',409);
    if(claimed?.intakeId!==intakeId)throw fail('REQUEST_PROCESSING',409);
    const job={id:randomUUID(),ownerId:req.userId,requestId:input.requestId,kind,payloadHash:hash,inputFingerprint:input.inputFingerprint,
      sourceHash:kind==='analysis'?input.sourceHash:analysisJob.sourceHash,referenceHashes:kind==='analysis'?input.referenceHashes:analysisJob.referenceHashes,
      target:kind==='analysis'?input.target:analysisJob.target,providerAccountRef:provider.accountRef,status:'queued',stage:'queued',revision:0,
      createdAt:Date.now(),updatedAt:Date.now(),expiresAt:Date.now()+retentionDays*86400000,results:[],images:[],analysis:null,
      total:kind==='analysis'?1:input.count,errorCode:null,workerLease:null,cancelRequested:false,
      ...(kind==='generation'?{retainOriginals:true,analysisJobId:analysisJob.id,approvedAnalysis:{text:analysisJob.analysis.text,revisionHash:analysisJob.analysis.revisionHash,revision:analysisJob.analysis.revision,subjects:analysisJob.analysis.data.scene.old_product_instances},input}:{}),assets:null};
    try {
      job.assets=kind==='analysis'?await assets.prepare(job,input):await assets.cloneMaterials(job,analysisJob);
      if(kind==='generation')job.assets.guide=await assets.saveGuide(job,await createRegionGuide(await assets.read(job,job.assets.source),input,job.approvedAnalysis.subjects));
      const stored=await store.create(job);
      if(stored.id!==job.id){await assets.remove(job);same(stored,kind,hash);return res.status(202).json(await view(stored));}
      const accepted=await store.updateRequest(req.userId,input.requestId,r=>r.state==='preparing'&&r.intakeId===intakeId?{...r,state:'accepted',jobId:job.id}:null);
      if(accepted?.state!=='accepted'||accepted.jobId!==job.id){await store.closeRequest(identity);throw fail('REQUEST_CLOSED',410);}
      res.status(202).json(await view(job));worker.wake(job,provider);
    } catch(e){
      // No worker has been dispatched until the accepted receipt is durable.
      // Preserve a tombstone so a delayed body cannot be accepted later.
      await store.closeRequest(identity).catch(()=>{});
      (logger||((entry)=>console.warn(JSON.stringify(entry))))({event:'request.preparation_failed',request_id:job.requestId,job_kind:kind,error_code:e.code||'INTERNAL_ERROR',http_status:e.status||500});
      if(!await store.get(job.id))await assets.remove(job).catch(()=>{});throw e;
    }
  }
  router.get('/capabilities',route(async(req,res)=>res.json({version:2,enabled:enabled(),maxReferences,
    submission:{analysis:enabled()&&canSubmit('analysis',req),generation:enabled()&&canSubmit('generation',req)},
    counts:advancedOutputs?[1,2,4]:[1],resolutions:advancedOutputs?['1K','2K','4K']:['1K','2K'],models:REPLICATION_MODELS,retentionDays,adaptiveComposition:{configured:!!vision||localVisionConfigured()}})));
  router.post('/connectivity',route(async(req,res)=>res.json({success:true,models:await getProvider(req).connectivity()})));
  router.post('/requests',route(async(req,res)=>{
    if(!enabled())throw fail('FEATURE_DISABLED',503);
    const identity={...validateRequestIdentity(req.body),ownerId:req.userId};
    if(!canSubmit(identity.kind,req))throw fail('FEATURE_DISABLED',503);
    const r=await reserve(identity);
    if(r.state==='closed')throw fail('REQUEST_CLOSED',410);res.status(202).json(receiptView(r));
  }));
  router.get('/requests/:requestId',route(async(req,res)=>{
    if(!UUID.test(req.params.requestId))throw fail('INPUT_INVALID');
    const r=await store.getRequest(req.userId,req.params.requestId);if(!r)throw fail('JOB_NOT_FOUND',404);res.json(receiptView(r));
  }));
  router.post('/requests/:requestId/close',route(async(req,res)=>{
    const identity={...validateRequestIdentity({...req.body,requestId:req.params.requestId}),ownerId:req.userId};
    const result=await store.closeRequest(identity);res.json({closed:result.closed,receipt:receiptView(result.receipt),job:result.job?await view(result.job):null});
  }));
  router.post('/analysis',route((req,res)=>create(req,res,'analysis')));
  router.post('/generation',route((req,res)=>create(req,res,'generation')));
  router.get('/active',route(async(req,res)=>{
    if(!['analysis','generation'].includes(req.query.kind))throw fail('INPUT_INVALID');
    const jobs=(await store.list()).filter(j=>j.ownerId===req.userId&&j.kind===req.query.kind&&!isFinalJob(j));
    res.json({jobs:await Promise.all(jobs.map(j=>view(j))),requests:(await store.activeRequests(req.userId,req.query.kind)).map(receiptView)});
  }));
  router.get('/request/:requestId',route(async(req,res)=>{
    if(!UUID.test(req.params.requestId))throw fail('JOB_NOT_FOUND',404);
    const job=await store.byRequest(req.userId,req.params.requestId);if(!job)throw fail('JOB_NOT_FOUND',404);
    res.json(await view(job));
  }));
  const read=route(async(req,res)=>{const job=await own(req,req.params.id);res.json(await view(job));});
  router.get('/jobs/:id',read);router.get('/:id',read);
  router.post('/jobs/:id/resume',route(async(req,res)=>{
    const job=await own(req,req.params.id);
    if(job.origin==='local_recomposition'){resume(req,job);return res.json(await view(job));}
    if(!isFinalJob(job)&&!(await store.attempts(job.id)).length){
      if(job.workerLease?.until>Date.now())return res.json(await view(job));
      const result=await store.closeRequest({ownerId:job.ownerId,requestId:job.requestId,kind:job.kind,inputFingerprint:job.inputFingerprint});
      return res.json(await view(result.job));
    }
    const recoveryErrorCode=resume(req,job);
    res.json({...await view(job),recoveryErrorCode,...(recoveryErrorCode?{errorCode:recoveryErrorCode,error:ERROR_MESSAGES[recoveryErrorCode]}:{})});
  }));
  const cancel=route(async(req,res)=>{
    const job=await own(req,req.params.id);if(isFinalJob(job))return res.status(202).json(await view(job));
    const provider=job.origin==='local_recomposition'?{accountRef:'local'}:getProvider(req);if(provider.accountRef!==job.providerAccountRef)throw fail('PROVIDER_ACCOUNT_MISMATCH',409);
    const next=await store.update(job.id,j=>isFinalJob(j)?null:{...j,cancelRequested:true,status:'cancel_requested',stage:'cancel_requested'});
    worker.wake(next,provider,{resumeOnly:true});res.status(202).json(await view(next));
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
    if(decision==='accept'&&job.results.some(r=>!r.composite||r.quality.mechanism!=='adaptive-v1'))throw fail('REVIEW_REQUIRED',422);
    if(decision==='accept'&&(!checks||!['identity','allInstances','occlusion','scene'].every(k=>checks[k]===true)))throw fail('REVIEW_REQUIRED',422);
    const next=await store.update(job.id,j=>j.status!=='completed_needs_review'?null:{...j,status:decision==='accept'?'succeeded':'quality_failed',
      stage:'human_review',quality:{status:decision==='accept'?'passed':'failed',reviewedAt:Date.now(),checks:decision==='accept'?checks:null},errorCode:decision==='accept'?null:'QUALITY_FAILED'});
    res.json(await view(next));
  }));
  // Explicit, local-only reprocessing creates a new record; old images and jobs remain immutable.
  // This endpoint never calls getProvider and works even while paid submissions are disabled.
  router.post('/jobs/:id/recompose',route(async(req,res)=>{
    const previous=await own(req,req.params.id);
    if(previous.kind!=='generation'||!isFinalJob(previous))throw fail('REVIEW_NOT_AVAILABLE',409);
    const raw=previous.results.at(-1)?.raw||previous.pendingRaw;if(!raw)throw fail('OUTPUT_INVALID',422);
    const hints=validateContourHints(req.body,previous.input.selectedInstances);
    const hash=sha256(canonicalJson({derivedFrom:previous.id,raw:raw.sha256,hints}));
    const existing=await store.byRequest(req.userId,req.body.requestId);
    if(existing){same(existing,'generation',hash);return res.status(202).json(await view(existing));}
    if((await store.list()).some(j=>j.ownerId===req.userId&&!isFinalJob(j)))throw fail('TASK_BUSY',409);
    const job={...previous,id:randomUUID(),requestId:req.body.requestId,origin:'local_recomposition',derivedFrom:previous.id,retainOriginals:true,
      payloadHash:hash,providerAccountRef:'local',status:'queued',stage:'queued',revision:0,total:1,createdAt:Date.now(),updatedAt:Date.now(),
      input:{...previous.input,requestId:req.body.requestId,contourHints:hints},results:[],images:[],pendingRaw:null,quality:null,errorCode:null,workerLease:null,cancelRequested:false,
      expiresAt:Date.now()+retentionDays*86400000,sourcePredictionId:previous.results.at(-1)?.predictionId||previous.sourcePredictionId||null};
    job.assets=await assets.cloneMaterials(job,previous);
    job.assets.raw=await assets.saveRawBytes(job,1,await assets.read(previous,raw));
    const stored=await store.create(job);
    if(stored.id!==job.id){await assets.remove(job);same(stored,'generation',hash);return res.status(202).json(await view(stored));}
    res.status(202).json(await view(job));worker.wake(job,{accountRef:'local'});
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
    worker.wake(next,provider,{resumeOnly:true});res.json(await view(next));
  }));
  router.get('/assets/:id/:name',route(async(req,res)=>{
    const job=await own(req,req.params.id);
    const list=[job.assets.source,job.assets.inferenceSource,job.assets.guide,job.assets.raw,...job.assets.references,...job.results.flatMap(r=>[r.raw,r.composite,...Object.values(r.compositeMasks||{})]),job.pendingRaw].filter(Boolean);
    const asset=list.find(a=>a.name===req.params.name);if(!asset)throw fail('JOB_NOT_FOUND',404);
    res.type('png').send(await assets.read(job,asset));
  }));
  // Cleanup is local-only, explicit, and never removes unresolved remote attempts.
  router.cleanup=async()=>{for(const job of await store.list())if(!job.retainOriginals&&isFinalJob(job)&&job.expiresAt<Date.now()){
    const dependents=(await store.list()).some(j=>j.analysisJobId===job.id&&(!isFinalJob(j)||j.expiresAt>Date.now()));
    if(!dependents){await assets.remove(job);await store.remove(job.id);}
  }};
  router.worker=worker;
  return router;
}
