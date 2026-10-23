import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { REPLICATION_MODELS, isFinalJob, canonicalJson } from '../shared/replication-contract.js';
import { sha256 } from './replication-assets.js';
import { analysisPrompt, ANALYSIS_SYSTEM, generationPrompt, parseProductAnalysis, PROMPT_VERSIONS } from './replication-prompts.js';
import { compositeReplicationImage } from './replication-composite.js';

const remoteFinal=new Set(['succeeded','failed','canceled']);
export function createReplicationWorker({store,assets,pollMs=1500,budgetMs=300000,leaseMs=90000,logger=event=>console.info(JSON.stringify(event))}) {
  const running=new Map();let stopping=false;
  const event=(job,name,fields={})=>logger({event:name,timestamp:new Date().toISOString(),user_id_hash:sha256(job.ownerId).slice(0,16),
    ui_intent:job.kind,job_kind:job.kind,request_id:job.requestId,job_id:job.id,model:REPLICATION_MODELS[job.kind],
    source_sha256_prefix:job.sourceHash.slice(0,12),reference_count:job.assets.references.length,provider_account_ref:job.providerAccountRef.slice(0,16),prompt_template_version:PROMPT_VERSIONS[job.kind],...fields});
  const transition=(id,status,extra={},lease)=>store.update(id,j=>{
    if(isFinalJob(j)||(lease&&j.workerLease?.id!==lease))return null;
    let nextStatus=status,nextExtra=extra;
    if(j.cancelRequested){
      if(status==='submission_unknown'){nextStatus='cancel_unknown';nextExtra={...extra,errorCode:'CANCEL_UNKNOWN'};}
      else if(['succeeded','completed_needs_review'].includes(status))nextStatus='canceled';
      else if(!['canceled','failed','cancel_unknown','quality_failed'].includes(status))nextStatus='cancel_requested';
    }
    return {...j,...nextExtra,status:nextStatus,stage:nextStatus};
  });
  async function inputFor(job) {
    const images=[await assets.dataUri(job,job.assets.source)];
    for(const ref of job.assets.references)images.push(await assets.dataUri(job,ref));
    return job.kind==='analysis'?{system_prompt:ANALYSIS_SYSTEM,prompt:analysisPrompt({target:job.target,references:job.assets.references}),image_input:images,reasoning_effort:'low',max_completion_tokens:4096}:
      {prompt:generationPrompt(job.input,job.approvedAnalysis.text),image_input:images,aspect_ratio:'match_input_image',resolution:job.input.resolution,output_format:'png',image_search:false,google_search:false};
  }
  async function saveRemote(attempt,prediction) {
    if(!prediction||typeof prediction.id!=='string'||!/^[a-zA-Z0-9_-]{6,100}$/.test(prediction.id))throw Object.assign(new Error('SUBMISSION_UNKNOWN'),{code:'SUBMISSION_UNKNOWN',uncertain:true});
    if(attempt.predictionId&&attempt.predictionId!==prediction.id)throw Object.assign(new Error('PREDICTION_ID_MISMATCH'),{code:'PREDICTION_FAILED'});
    const changed=attempt.remoteStatus!==prediction.status;
    const next={...attempt,predictionId:prediction.id,createAckAt:attempt.createAckAt||Date.now(),remoteStatus:prediction.status,
      remoteCompletedAt:prediction.completed_at||attempt.remoteCompletedAt||null,
      metricsSummary:prediction.metrics?Object.fromEntries(Object.entries(prediction.metrics).filter(([k,v])=>['predict_time','total_time','input_token_count','output_token_count'].includes(k)&&typeof v==='number')):attempt.metricsSummary};
    await store.updateAttempt(next);return {next,changed};
  }
  async function run(id,provider) {
    const lease=randomUUID();let claimed=false,heartbeat;
    const state=(jobId,status,extra)=>transition(jobId,status,extra,lease);
    try {
      let job=await store.update(id,j=>{
        if(isFinalJob(j)||j.providerAccountRef!==provider.accountRef||(j.workerLease&&j.workerLease.until>Date.now()))return null;
        return {...j,workerLease:{id:lease,until:Date.now()+leaseMs}};
      });
      if(!job||job.workerLease?.id!==lease)return;claimed=true;
      heartbeat=setInterval(()=>store.update(id,j=>j.workerLease?.id===lease?{...j,workerLease:{id:lease,until:Date.now()+leaseMs}}:null).catch(()=>{}),Math.max(5,Math.floor(leaseMs/3)));
      heartbeat.unref();
      event(job,'job.resume');
      while(!isFinalJob(job)) {
        if(stopping)return;
        job=await store.get(id);
        if(job.workerLease?.id!==lease)return;
        await store.update(id,j=>j.workerLease?.id===lease?{...j,workerLease:{id:lease,until:Date.now()+leaseMs}}:null);
        if(isFinalJob(job))return;
        if(job.results.some(r=>r.quality.status==='failed')){await state(id,'quality_failed',{errorCode:'QUALITY_FAILED'});return;}
        const index=job.kind==='analysis'?1:job.results.length+1;
        if(job.kind==='generation'&&index>job.total){await state(id,'completed_needs_review',{quality:{status:'needs_review'}});return;}
        let attempt=(await store.attempts(id)).find(a=>a.attemptNo===index),prediction;
        if(!attempt) {
          if(job.cancelRequested){await state(id,'canceled');return;}
          const input=await inputFor(job);
          attempt={id:randomUUID(),jobId:id,attemptNo:index,model:REPLICATION_MODELS[job.kind],providerAccountRef:provider.accountRef,
            inputHash:sha256(canonicalJson(input)),promptTemplateVersion:PROMPT_VERSIONS[job.kind],createStartedAt:Date.now(),deadlineAt:Date.now()+budgetMs,
            predictionId:null,remoteStatus:null,reconciliationState:'submitting',estimatedCost:null};
          if(!await store.claimAttempt(attempt))continue;
          await state(id,'submitting');event(job,'prediction.create_started',{local_attempt_id:attempt.id,create_attempt_no:index});
          try {
            prediction=await provider.create(attempt.model,input);
            // Persist acknowledgment before polling, formatting, or other work. A lost DB ACK is never permission to POST again.
            ({next:attempt}=await saveRemote(attempt,prediction));
            attempt.reconciliationState='linked';await store.updateAttempt(attempt);
            event(job,'prediction.create_result',{prediction_id:attempt.predictionId,create_attempt_no:index,remote_status:prediction.status,http_status:prediction.httpStatus||null,elapsed_ms:Date.now()-attempt.createStartedAt});
          } catch(e) {
            attempt.createHttpStatus=e.httpStatus||null;attempt.errorCode=e.code||'SUBMISSION_UNKNOWN';
            event(job,'prediction.create_error',{local_attempt_id:attempt.id,error_code:attempt.errorCode,http_status:attempt.createHttpStatus,elapsed_ms:Date.now()-attempt.createStartedAt});
            if(e.uncertain||!['TOKEN_INVALID','BALANCE_REQUIRED','PROVIDER_REJECTED','MODEL_NOT_ALLOWED'].includes(e.code)){attempt.reconciliationState='submission_unknown';await store.updateAttempt(attempt);
              await state(id,job.cancelRequested?'cancel_unknown':'submission_unknown',{errorCode:job.cancelRequested?'CANCEL_UNKNOWN':'SUBMISSION_UNKNOWN'});return;}
            attempt.reconciliationState='rejected';await store.updateAttempt(attempt);await state(id,'failed',{errorCode:e.code});return;
          }
        } else if(!attempt.predictionId) {
          // Another process may have died after sending POST. An existing attempt is NEVER submitted twice.
          await state(id,job.cancelRequested?'cancel_unknown':'submission_unknown',{errorCode:job.cancelRequested?'CANCEL_UNKNOWN':'SUBMISSION_UNKNOWN'});return;
        }
        if(!prediction) {
          try {prediction=await provider.get(attempt.predictionId);({next:attempt}=await saveRemote(attempt,prediction));}
          catch {await state(id,job.cancelRequested?'cancel_unknown':'running',{errorCode:job.cancelRequested?'CANCEL_UNKNOWN':'PROVIDER_UNREACHABLE'});return;}
        }
        if(prediction.model&&prediction.model!==attempt.model){await state(id,'failed',{errorCode:'PREDICTION_MODEL_MISMATCH'});return;}
        job=await store.get(id);
        if(isFinalJob(job)||job.workerLease?.id!==lease)return;
        const timedOut=Date.now()>attempt.deadlineAt;
        if(!remoteFinal.has(prediction.status)&&(job.cancelRequested||timedOut)) {
          attempt.cancelRequestedAt=attempt.cancelRequestedAt||Date.now();await store.updateAttempt(attempt);
          await state(id,'cancel_requested',{cancelRequested:true,errorCode:timedOut?'PREDICTION_TIMEOUT':null});
          try {await provider.cancel(attempt.predictionId);prediction=await provider.get(attempt.predictionId);({next:attempt}=await saveRemote(attempt,prediction));}
          catch {await state(id,'cancel_unknown',{errorCode:'CANCEL_UNKNOWN'});return;}
          if(!remoteFinal.has(prediction.status)){await state(id,'cancel_unknown',{errorCode:'CANCEL_UNKNOWN'});return;}
        }
        if(!remoteFinal.has(prediction.status)) {
          await state(id,'running',{errorCode:null});await pause(pollMs);continue;
        }
        if(prediction.status!=='succeeded') {await state(id,prediction.status==='canceled'?'canceled':'failed',{errorCode:prediction.status==='failed'?'PREDICTION_FAILED':null});return;}
        await state(id,'postprocessing');
        if(job.kind==='analysis') {
          if(job.cancelRequested){await state(id,'canceled');return;}
          try {
            const analysis=parseProductAnalysis(prediction.output,job.assets.references.length);
            const revisionHash=sha256(analysis.text);
            await state(id,'succeeded',{analysis:{...analysis,revision:1,revisionHash,confirmedAt:null},images:[],errorCode:null});
          } catch {const raw=typeof prediction.output==='string'?prediction.output:Array.isArray(prediction.output)?prediction.output.filter(s=>typeof s==='string').join(''):'';
            await state(id,'failed',{errorCode:'ANALYSIS_SCHEMA_INVALID',analysis:{data:null,text:'',rawText:raw.slice(0,24000),revision:0,revisionHash:null}});}
          return;
        }
        // Saved raw output survives even if local composition or quality checks fail.
        const url=Array.isArray(prediction.output)?prediction.output[0]:prediction.output;
        let rawAsset;
        try {rawAsset=job.pendingRaw||await assets.saveRaw(job,index,url);}catch{await state(id,'quality_failed',{errorCode:'OUTPUT_INVALID',quality:{status:'failed',reasons:['OUTPUT_INVALID']}});return;}
        const live=await store.update(id,j=>!isFinalJob(j)&&j.workerLease?.id===lease?{...j,pendingRaw:rawAsset}:null);
        if(isFinalJob(live)||live.workerLease?.id!==lease)return;
        const source=await assets.read(job,job.assets.source),generated=await assets.read(job,rawAsset);
        const composed=await compositeReplicationImage(source,generated,job.input);
        const composite=composed.buffer?await assets.saveComposite(job,index,composed.buffer):null;
        const result={raw:rawAsset,composite,quality:composed.quality,predictionId:attempt.predictionId};
        await store.update(id,j=>!isFinalJob(j)&&j.workerLease?.id===lease?{...j,results:[...j.results,result],images:[...j.images,...(composite?[composite.url]:[])],pendingRaw:null}:null);
        event(job,'image.quality_result',{prediction_id:attempt.predictionId,quality_status:composed.quality.status});
        if(composed.quality.status==='failed'){await state(id,'quality_failed',{errorCode:'QUALITY_FAILED',quality:composed.quality});return;}
        job=await store.get(id);
        if(job.cancelRequested){await state(id,'canceled');return;}
        if(index>=job.total){await state(id,'completed_needs_review',{quality:{status:'needs_review'},errorCode:null});return;}
      }
    } catch {
      // Never log exceptions with provider payloads. Keep acknowledged attempts recoverable by GET.
      const job=await store.get(id).catch(()=>null);
      if(job&&!isFinalJob(job)) {
        const attempts=await store.attempts(id).catch(()=>[]);
        const uncertain=attempts.some(a=>!a.predictionId);
        await state(id,uncertain?'submission_unknown':'running',{errorCode:uncertain?'SUBMISSION_UNKNOWN':'POSTPROCESSING_INTERRUPTED'}).catch(()=>{});
      }
    } finally {
      if(heartbeat)clearInterval(heartbeat);
      if(claimed)await store.update(id,j=>j.workerLease?.id===lease?{...j,workerLease:null}:null).catch(()=>{});
    }
  }
  return {
    wake(job,provider) {
      if(stopping||isFinalJob(job)||running.has(job.id)||provider.accountRef!==job.providerAccountRef)return;
      const p=run(job.id,provider).finally(()=>running.delete(job.id));running.set(job.id,p);
    },
    async idle(){await Promise.all([...running.values()]);}
    ,stop(){stopping=true;}
  };
}
