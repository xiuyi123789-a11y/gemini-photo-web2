import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import express from 'express';
import sharp from 'sharp';
import {newDb} from 'pg-mem';
import {createStore} from '../server/database.js';
import {createPgReplicationStore,createFileReplicationStore} from '../server/replication-store.js';
import {createReplicationAssets,sha256} from '../server/replication-assets.js';
import {createReplicationRouter} from '../server/replication.js';
import {createReplicationProvider} from '../server/replication-provider.js';
import {parseProductAnalysis,generationPrompt} from '../server/replication-prompts.js';
import {compositeReplicationImage,prepareMasks} from '../server/replication-composite.js';
import {canonicalJson,materialIdentity,REPLICATION_MODELS,isFinalJob,matchesOperation,recoveryKey} from '../shared/replication-contract.js';
import {createApp} from '../server/app.js';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

const testRoot=fileURLToPath(new URL('../.local/migration-archive/test-data/',import.meta.url));
const source=await sharp({create:{width:96,height:64,channels:4,background:'#777777'}}).png().toBuffer();
const dataUri='data:image/png;base64,'+source.toString('base64');
const fixture=()=>({schema_version:'1.0',new_product:{category:'鞋',brand:null,colors:['黑','白'],observed_features:[{name:'黑白拼接鞋面',evidence_refs:[1,2],certainty:'observed'}],uncertainties:['背面不可见']},reference_views:[{ref_index:1,view:'front',visible_features:['鞋头']},{ref_index:2,view:'side',visible_features:['鞋底']}],scene:{old_product_instances:[{instance_id:'left',location:'画面左侧鞋',visible_view:'side',occluders:['裤脚'],selection_required:true},{instance_id:'right',location:'画面右侧鞋',visible_view:'side',occluders:['袜子'],selection_required:true}],lighting:{direction:'unknown',temperature:'unknown'}},old_new_differences:[{attribute:'配色',observation:'新参考黑白'}],warnings:['确认两只鞋的范围']});
const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const editMasks=[{instanceId:'left',points:rect(.1,.3,.3,.45)},{instanceId:'right',points:rect(.55,.3,.3,.45)}];
const fingerprint=sha256(canonicalJson(materialIdentity(sha256(source),[{hash:sha256(source),angle:'front'},{hash:sha256(source),angle:'side'}],'')));
const analysisBody=(patch={})=>({requestId:randomUUID(),inputFingerprint:fingerprint,sourceImage:dataUri,references:[{image:dataUri,angle:'front'},{image:dataUri,angle:'side'}],target:'',...patch});
const generated=await sharp(source).composite([{input:Buffer.from('<svg width="96" height="64"><rect x="9" y="19" width="30" height="30" fill="black"/><rect x="52" y="19" width="30" height="30" fill="white"/></svg>')}]).png().toBuffer();
function generationBody(job,patch={}){return {requestId:randomUUID(),inputFingerprint:job.inputFingerprint,analysisJobId:job.id,analysisRevisionHash:job.analysis.revisionHash,
  selectedInstances:['left','right'],masks:editMasks,protectMasks:[rect(.1,.3,.75,.06)],maskSpace:{width:job.source.width,height:job.source.height,sourceHash:job.source.sha256},resolution:'2K',count:1,preserve:['background','lighting'],notes:'',confirmedPredictions:1,...patch};}

async function harness(options={}) {
  await mkdir(testRoot,{recursive:true});const directory=options.directory||await mkdtemp(path.join(testRoot,'replication-v2-'));
  const store=options.store||createFileReplicationStore(directory),created=[],canceled=[],queried=[],logs=[],predictions=new Map();
  let serial=0;
  const provider={accountRef:'fake-account',connectivity:async()=>Object.values(REPLICATION_MODELS).map(model=>({model,accessible:true})),
    create:async(model,input)=>{
      created.push({model,input});const id='prediction-'+(++serial);
      const p={id,model,input,status:options.pending||(options.pendingGeneration&&model===REPLICATION_MODELS.generation)?'processing':'succeeded',created_at:new Date().toISOString(),output:model===REPLICATION_MODELS.analysis?(options.analysisOutput===undefined?JSON.stringify(fixture()):options.analysisOutput):'https://replicate.delivery/fake.png'};
      predictions.set(id,p);
      if(options.createDelayMs)await pause(options.createDelayMs);
      if(options.createError)throw options.createError;
      if(options.rejectCreateAt===serial)throw {code:'PROVIDER_REJECTED',status:422};
      return p;
    },
    get:async id=>{queried.push(id);if(options.getError)throw new Error('fake disconnect');const p=predictions.get(id);if(!p)throw new Error('not found');return {...p};},
    cancel:async id=>{canceled.push(id);if(options.cancelError)throw new Error('fake cancel disconnect');const p=predictions.get(id);p.status='canceled';return p;}};
  const assets=createReplicationAssets(directory,{download:options.download||(async()=>options.outputBytes||generated)});
  const routers=[];let server,base;
  const start=async()=>{
    const app=express();app.use(express.json({limit:'50mb'}));app.use((req,res,next)=>{req.userId=req.get('x-user-id')||'alice';next();});
    const router=createReplicationRouter({store,assets,getProvider:req=>req.get('x-replicate-token')==='wrong'?{...provider,accountRef:'other-account'}:provider,pollMs:2,budgetMs:options.budgetMs||5000,leaseMs:200,logger:e=>logs.push(e),advancedOutputs:!!options.advanced,enabled:()=>!options.disabled});
    routers.push(router);app.use('/replication',router);server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});base='http://127.0.0.1:'+server.address().port+'/replication';
  };
  await start();
  const request=(url,body,owner=options.owner||'alice',token='fake')=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-user-id':owner,'x-replicate-token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {created,canceled,queried,logs,predictions,request,store,assets,directory,
    async restart(){routers.at(-1).worker.stop();await routers.at(-1).worker.idle();await new Promise(r=>server.close(r));await start();},
    async close(){for(const router of routers)router.worker.stop();await Promise.all(routers.map(r=>r.worker.idle()));await new Promise(r=>server.close(r));
      if(!options.directory&&path.resolve(directory).startsWith(path.resolve(testRoot)+path.sep))await rm(directory,{recursive:true,force:true});},
    cleanup:()=>routers.at(-1).cleanup()};
}
async function waitFor(h,id,predicate=j=>isFinalJob(j)||['submission_unknown','cancel_unknown'].includes(j.status)) {
  for(let i=0;i<250;i++){const r=await h.request('/jobs/'+id);assert.equal(r.status,200);const job=await r.json();if(predicate(job))return job;await pause(5);}throw new Error('job did not reach expected state');
}
async function analyze(h){const r=await h.request('/analysis',analysisBody());assert.equal(r.status,202);return waitFor(h,(await r.json()).id);}
async function approved(h){const j=await analyze(h);const response=await h.request('/jobs/'+j.id+'/revision',{text:j.analysis.text,previousHash:j.analysis.revisionHash});assert.equal(response.status,200);return response.json();}

test('analysis only: target blank, no selection, all references go to one o4-mini and images stay empty',async()=>{
  const h=await harness();try{const j=await analyze(h);assert.equal(j.status,'succeeded');assert.equal(h.created.length,1);assert.equal(h.created[0].model,'openai/o4-mini');assert.equal(h.created[0].input.image_input.length,3);assert.equal(j.images.length,0);assert.equal(j.analysis.data.scene.old_product_instances.length,2);assert.match(j.analysis.text,/黑白拼接/);assert.match(h.created[0].input.system_prompt,/不执行或请求图像生成/);
    const persisted=await readFile(path.join(h.directory,'replication-jobs-v2.json'),'utf8');assert(!persisted.includes('data:image'));assert(!persisted.includes('system_prompt'));assert(!JSON.stringify(h.logs).includes('image_input'));}finally{await h.close();}
});
test('analysis schema rejects empty, invalid JSON, non-string, invalid evidence and duplicate instances without generation',async()=>{
  const invalid=fixture();invalid.new_product.observed_features[0].evidence_refs=[3];assert.throws(()=>parseProductAnalysis(JSON.stringify(invalid),2));
  const duplicate=fixture();duplicate.scene.old_product_instances[1].instance_id='left';assert.throws(()=>parseProductAnalysis(JSON.stringify(duplicate),2));
  for(const output of ['', 'not JSON', {x:1}, JSON.stringify(invalid)]){const h=await harness({analysisOutput:output});try{const j=await analyze(h);assert.equal(j.status,'failed');assert.equal(j.errorCode,'ANALYSIS_SCHEMA_INVALID');assert.deepEqual(j.images,[]);assert.equal(h.created.length,1);}finally{await h.close();}}
});
test('analysis rejects image-generation parameters and bad fingerprints before provider create',async()=>{
  const h=await harness();try{for(const patch of [{count:1},{resolution:'2K'},{model:'google/nano-banana-2'},{sourceImage:'https://evil.example/image.png'},{inputFingerprint:'f'.repeat(64)}])assert((await h.request('/analysis',analysisBody(patch))).status>=400);assert.equal(h.created.length,0);}finally{await h.close();}
});
test('generation without analysis, selection, valid masks or cost acknowledgment cannot call provider',async()=>{
  const h=await harness();try{let r=await h.request('/generation',{requestId:randomUUID(),inputFingerprint:fingerprint});assert.equal(r.status,409);assert.equal((await r.json()).errorCode,'ANALYSIS_REQUIRED');assert.equal(h.created.length,0);
    const unconfirmed=await analyze(h);assert.equal((await h.request('/generation',generationBody(unconfirmed))).status,409);assert.equal(h.created.length,1);
    const j=await (await h.request('/jobs/'+unconfirmed.id+'/revision',{text:unconfirmed.analysis.text,previousHash:unconfirmed.analysis.revisionHash})).json();
    for(const patch of [{selectedInstances:[]},{masks:[]},{protectMasks:[rect(0,0,.8,.9)]},{maskSpace:{width:1,height:1,sourceHash:j.source.sha256}},{masks:[{instanceId:'left',points:rect(-.1,0,.3,.3)}]},{selectedInstances:['absent']},{confirmedPredictions:0}]){const response=await h.request('/generation',generationBody(j,patch));assert.equal(response.status,422);}
    assert.equal(h.created.length,1);
  }finally{await h.close();}
});
test('same request ID with identical body returns one job across concurrent requests; conflicting kind/payload is 409',async()=>{
  const h=await harness();try{const body=analysisBody();const responses=await Promise.all(Array.from({length:4},()=>h.request('/analysis',body)));const values=await Promise.all(responses.map(r=>r.json()));
    responses.forEach((r,i)=>assert(r.status===202||r.status===409&&values[i].errorCode==='REQUEST_PROCESSING'));
    const jobs=values.filter(j=>j.id);assert(jobs.length);assert.equal(new Set(jobs.map(j=>j.id)).size,1);const j=await waitFor(h,jobs[0].id);assert.equal(h.created.length,1);
    assert.equal((await (await h.request('/analysis',body)).json()).id,j.id);
    assert.equal((await h.request('/analysis',{...body,target:'different'})).status,409);
    const conflict=await h.request('/generation',generationBody(j,{requestId:body.requestId}));assert.equal(conflict.status,409);assert.equal((await conflict.json()).errorCode,'IDEMPOTENCY_CONFLICT');assert.equal(h.created.length,1);
  }finally{await h.close();}
});
test('analysis revisions are hashed and stale generation is blocked; explicit generation creates one Nano Banana 2',async()=>{
  const h=await harness();try{const j=await analyze(h),body=generationBody(j);const revised=await (await h.request('/jobs/'+j.id+'/revision',{text:j.analysis.text+' 用户确认黑白配色',previousHash:j.analysis.revisionHash})).json();
    assert.notEqual(revised.analysis.revisionHash,j.analysis.revisionHash);assert.equal((await h.request('/generation',body)).status,409);
    const started=await h.request('/generation',generationBody(revised));assert.equal(started.status,202);const g=await waitFor(h,(await started.json()).id);
    assert.equal(g.status,'completed_needs_review');assert.equal(h.created.length,2);assert.equal(h.created[1].model,'google/nano-banana-2');assert.equal(h.created[1].input.image_input.length,3);assert.equal(g.results.length,1);assert(g.results[0].raw.url);assert(g.results[0].composite.url);assert.notEqual(g.source.url,j.source.url);assert.equal(g.results[0].quality.identityVerified,false);
    assert.equal((await h.request('/jobs/'+g.id+'/review',{decision:'accept',checks:{identity:true}})).status,422);
    const reviewed=await (await h.request('/jobs/'+g.id+'/review',{decision:'accept',checks:{identity:true,allInstances:true,occlusion:true,scene:true}})).json();assert.equal(reviewed.status,'succeeded');assert.equal(reviewed.quality.status,'passed');
  }finally{await h.close();}
});
test('unchanged source and wrong aspect ratio never get a successful business status; raw is retained',async()=>{
  for(const outputBytes of [source,await sharp({create:{width:64,height:96,channels:4,background:'red'}}).png().toBuffer()]){
    const h=await harness({outputBytes});try{const j=await approved(h);const r=await h.request('/generation',generationBody(j));const g=await waitFor(h,(await r.json()).id);assert.equal(g.status,'quality_failed');assert(g.results[0].raw.url);assert.notEqual(g.quality?.status,'passed');assert.equal(h.created.length,2);}finally{await h.close();}
  }
});
test('creation lost response/429 becomes unknown and never resubmits through refresh or backend restart',async()=>{
  for(const createError of [Object.assign(new Error('secret-token raw-body'),{uncertain:true,code:'SUBMISSION_UNKNOWN'}),Object.assign(new Error('429'),{uncertain:true,code:'SUBMISSION_UNKNOWN',status:429})]){
    const h=await harness({createError});try{const body=analysisBody();const r=await h.request('/analysis',body);const j=await waitFor(h,(await r.json()).id);assert.equal(j.status,'submission_unknown');await h.restart();await h.request('/jobs/'+j.id);await h.request('/analysis',body);await pause(20);assert.equal(h.created.length,1);assert.equal((await h.request('/analysis',analysisBody())).status,409);assert(!JSON.stringify(j).includes('secret-token'));}finally{await h.close();}
  }
});
test('reconcile unknown attempt requires exact input evidence and never creates a new prediction',async()=>{
  const h=await harness({createError:{uncertain:true,code:'SUBMISSION_UNKNOWN'}});try{const r=await h.request('/analysis',analysisBody()),j=await waitFor(h,(await r.json()).id);const p=h.predictions.get('prediction-1');
    p.model='wrong/model';assert.equal((await h.request('/jobs/'+j.id+'/reconcile',{predictionId:p.id})).status,422);p.model=REPLICATION_MODELS.analysis;
    assert.equal((await h.request('/jobs/'+j.id+'/reconcile',{predictionId:p.id})).status,200);const done=await waitFor(h,j.id);assert.equal(done.status,'succeeded');assert.equal(h.created.length,1);
  }finally{await h.close();}
});
test('acknowledged prediction stays unchanged on GET after restart; explicit resume only queries the existing prediction',async()=>{
  const h=await harness({pending:true});try{const r=await h.request('/analysis',analysisBody()),id=(await r.json()).id;await waitFor(h,id,j=>j.predictions.length&&j.predictions[0].predictionId);await h.restart();h.predictions.get('prediction-1').status='succeeded';
    const before=await h.store.get(id),reads=h.queried.length;await h.request('/jobs/'+id);await h.request('/request/'+before.requestId);await h.request('/active?kind=analysis');await pause(20);assert.equal((await h.store.get(id)).revision,before.revision);assert.equal(h.queried.length,reads);assert.equal(h.created.length,1);
    await h.request('/jobs/'+id+'/resume',{});const j=await waitFor(h,id);assert.equal(j.status,'succeeded');assert.equal(h.created.length,1);}finally{await h.close();}
});
test('cancel is confirmed with a GET; timeout or cancellation failure is never labeled canceled',async()=>{
  const h=await harness({pending:true,cancelError:true});try{const r=await h.request('/analysis',analysisBody()),id=(await r.json()).id;await waitFor(h,id,j=>j.predictions[0]?.predictionId);await h.request('/jobs/'+id+'/cancel',{});const j=await waitFor(h,id);assert.equal(j.status,'cancel_unknown');assert.equal(j.errorCode,'CANCEL_UNKNOWN');assert.equal(h.created.length,1);}finally{await h.close();}
  const ok=await harness({pending:true,budgetMs:15});try{const r=await ok.request('/analysis',analysisBody()),j=await waitFor(ok,(await r.json()).id);assert.equal(j.status,'canceled');assert(ok.canceled.length>0);assert.equal(ok.created.length,1);}finally{await ok.close();}
  const race=await harness({createDelayMs:100,createError:{uncertain:true,code:'SUBMISSION_UNKNOWN'}});try{const r=await race.request('/analysis',analysisBody()),id=(await r.json()).id;await waitFor(race,id,j=>j.status==='submitting');await race.request('/jobs/'+id+'/cancel',{});const j=await waitFor(race,id);assert.equal(j.status,'cancel_unknown');assert.equal(j.errorCode,'CANCEL_UNKNOWN');assert.equal(race.created.length,1);}finally{await race.close();}
});
test('owner isolation covers jobs, assets, request lookup, cancel, review and original credential',async()=>{
  const h=await harness({pending:true});try{const body=analysisBody(),r=await h.request('/analysis',body),j=await r.json();for(const url of ['/jobs/'+j.id,'/request/'+body.requestId,j.source.url.replace('/api/replication','')])assert.equal((await h.request(url,undefined,'bob')).status,404);
    for(const url of ['/jobs/'+j.id+'/cancel','/jobs/'+j.id+'/review','/jobs/'+j.id+'/revision'])assert.equal((await h.request(url,{},'bob')).status,404);
    assert.equal((await h.request('/jobs/'+j.id+'/cancel',{},'alice','wrong')).status,409);
    await waitFor(h,j.id,x=>x.predictions[0]?.predictionId);
    const readable=await (await h.request('/jobs/'+j.id,undefined,'alice','wrong')).json();assert.equal(readable.recoveryErrorCode,undefined);
    const wrongCredential=await (await h.request('/jobs/'+j.id+'/resume',{},'alice','wrong')).json();assert.equal(wrongCredential.recoveryErrorCode,'PROVIDER_ACCOUNT_MISMATCH');
    await h.request('/jobs/'+j.id+'/cancel',{});assert.equal((await waitFor(h,j.id)).status,'canceled');
  }finally{await h.close();}
});
test('batch cancellation stops later samples and partial failure retains completed candidate files',async()=>{
  const h=await harness({pendingGeneration:true,advanced:true});try{const j=await approved(h),r=await h.request('/generation',generationBody(j,{count:4,confirmedPredictions:4})),g=await r.json();
    await waitFor(h,g.id,x=>x.predictions[0]?.predictionId);await h.request('/jobs/'+g.id+'/cancel',{});assert.equal((await waitFor(h,g.id)).status,'canceled');assert.equal(h.created.length,2);
  }finally{await h.close();}
  const partial=await harness({advanced:true,rejectCreateAt:3});try{const j=await approved(partial),r=await partial.request('/generation',generationBody(j,{count:4,confirmedPredictions:4})),g=await waitFor(partial,(await r.json()).id);
    assert.equal(g.status,'failed');assert.equal(g.results.length,1);assert.equal(g.images.length,1);assert.equal(partial.created.length,3);
  }finally{await partial.close();}
});
test('expired unresolved submissions remain available for audit and still block a fresh charge',async()=>{
  const h=await harness({createError:{uncertain:true,code:'SUBMISSION_UNKNOWN'}});try{const j=await analyze(h);await h.store.update(j.id,x=>({...x,expiresAt:Date.now()-1}));await h.cleanup();assert(await h.store.get(j.id));assert.equal((await h.request('/analysis',analysisBody())).status,409);}finally{await h.close();}
});
test('feature flag blocks new tasks; connectivity does not call predictions; advanced outputs gated',async()=>{
  const h=await harness({disabled:true});try{assert.equal((await h.request('/analysis',analysisBody())).status,503);assert.equal((await h.request('/connectivity',{})).status,200);assert.equal(h.created.length,0);}finally{await h.close();}
  const a=await harness();try{const j=await analyze(a);for(const patch of [{count:2,confirmedPredictions:2},{resolution:'4K'}])assert.equal((await a.request('/generation',generationBody(j,patch))).status,422);assert.equal(a.created.length,1);}finally{await a.close();}
});
test('two masks protect foreground and every outside pixel, with no fill stretching',async()=>{
  const protect=[rect(.1,.3,.75,.06)];const result=await compositeReplicationImage(source,generated,{masks:editMasks,protectMasks:protect});const decoded=await sharp(result.buffer).raw().toBuffer();const original=await sharp(source).raw().toBuffer();const coverage=await prepareMasks(96,64,editMasks,protect);let changed=0;
  for(let i=0;i<96*64;i++){const a=decoded.subarray(i*4,i*4+4),b=original.subarray(i*4,i*4+4);if(!coverage.edit[i]||coverage.protect[i])assert.deepEqual(a,b);else if(!a.equals(b))changed++;}assert(changed>100);assert.equal(result.quality.instances.length,2);assert(result.quality.instances.every(i=>i.changedFraction>.02));
});
test('orientation normalization is persisted before mask coordinates, and expires cleanup preserves unresolved jobs',async()=>{
  const h=await harness();try{const j=await analyze(h);const job=await h.store.get(j.id);await h.store.update(j.id,x=>({...x,expiresAt:Date.now()-1}));await h.cleanup();assert.equal(await h.store.get(j.id),null);
    const image=await sharp({create:{width:40,height:24,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();const assets=await h.assets.prepare({...job,id:randomUUID()},{sourceImage:'data:image/jpeg;base64,'+image.toString('base64'),references:[{image:dataUri,angle:'front'}]});assert.equal(assets.source.width,24);assert.equal(assets.source.height,40);
  }finally{await h.close();}
});
test('PostgreSQL store has additive tables, unique request/active user/attempt constraints, CAS and durable rereads',async()=>{
  // pg-mem's AST coverage checker flags skipped IF NOT EXISTS definitions on the second init.
  const {Pool}=newDb({noAstCoverageCheck:true}).adapters.createPg(),pool=new Pool(),db=createStore(pool);await db.init();await db.init();
  const user=await db.createUser('replication-user','test-hash'),store=createPgReplicationStore(pool);
  const job={id:randomUUID(),ownerId:user.id,requestId:randomUUID(),kind:'analysis',payloadHash:'hash',status:'queued',revision:0,createdAt:Date.now(),updatedAt:Date.now()};
  try{await store.create(job);assert.equal((await store.byRequest(user.id,job.requestId)).id,job.id);await assert.rejects(store.create({...job,id:randomUUID(),requestId:randomUUID()}),/TASK_BUSY/);
    const attempt={id:randomUUID(),jobId:job.id,attemptNo:1,predictionId:null};assert.equal(await store.claimAttempt(attempt),true);assert.equal(await store.claimAttempt({...attempt,id:randomUUID()}),false);
    await Promise.all([store.update(job.id,j=>({...j,a:1})),store.update(job.id,j=>({...j,b:2}))]);const reread=await createPgReplicationStore(pool).get(job.id);assert.equal(reread.a,1);assert.equal(reread.b,2);
    await store.updateAttempt({...attempt,predictionId:'prediction-persisted'});assert.equal((await store.attempts(job.id))[0].predictionId,'prediction-persisted');
  }finally{await pool.end();}
});
test('client recovery identity checks kind + owner + fingerprint + requestId + jobId; slots are distinct',()=>{
  const expected={kind:'analysis',ownerId:'alice',inputFingerprint:'hash',requestId:'request',jobId:'job'},job={...expected,id:'job'};assert(matchesOperation(expected,job));
  for(const patch of [{kind:'generation'},{ownerId:'bob'},{inputFingerprint:'other'},{requestId:'other'},{id:'other'}])assert(!matchesOperation(expected,{...job,...patch}));assert.notEqual(recoveryKey('analysis'),recoveryKey('generation'));
});
test('complete analysis-confirm-generation-review flow also persists through the PostgreSQL adapter',async()=>{
  const {Pool}=newDb().adapters.createPg(),pool=new Pool(),db=createStore(pool);await db.init();const user=await db.createUser('pg-flow','fixture-hash');
  const store=createPgReplicationStore(pool),h=await harness({store,owner:user.id});
  try{const a=await approved(h);assert(a.analysis.confirmedAt);const response=await h.request('/generation',generationBody(a));assert.equal(response.status,202);const g=await waitFor(h,(await response.json()).id);assert.equal(g.status,'completed_needs_review');
    const recovered=await createPgReplicationStore(pool).get(g.id);assert.equal(recovered.results.length,1);assert.equal((await store.attempts(g.id))[0].predictionId,'prediction-2');assert.equal(h.created.length,2);
  }finally{await h.close();await pool.end();}
});
test('generation prompt uses new identity and per-instance geometry; ordinary retouch models unchanged',async()=>{
  const text=generationPrompt({selectedInstances:['left','right'],masks:editMasks,preserve:[],notes:''},'new product identity');assert.match(text,/NEW silhouette may legitimately differ/);assert.match(text,/left/);assert.match(text,/right/);
  const appSource=await readFile(new URL('../server/app.js',import.meta.url),'utf8');assert.match(appSource,/model = "google\/nano-banana"/);assert.match(appSource,/model = "black-forest-labs\/flux-fill-dev"/);
});
test('legacy development image previews load without a custom header; ordinary retouch still uses its existing models',async()=>{
  const h=await harness(),models=[];
  const fakeSdk={models:{get:async(owner,name)=>{models.push(owner+'/'+name);return {latest_version:{id:'version-fixture'}};}},predictions:{create:async()=>({id:'ordinary-fixture',status:'succeeded',output:dataUri})}};
  const app=createApp({dataDir:h.directory,replicateClientFactory:()=>fakeSdk,replicationProviderFactory:()=>{throw new Error('No replication calls in this test');}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),url='http://127.0.0.1:'+server.address().port;
  try{const j=await analyze(h);assert.equal((await fetch(url+j.source.url)).status,200);
    for(const mask of [undefined,dataUri]){const response=await fetch(url+'/api/retouch-image',{method:'POST',headers:{'Content-Type':'application/json','x-user-id':'alice','x-replicate-token':'fake'},body:JSON.stringify({image:dataUri,prompt:'fixture edit',...(mask?{mask}:{})})});assert.equal(response.status,200);}
    assert.deepEqual(models,['google/nano-banana','black-forest-labs/flux-fill-dev']);
  }finally{app.locals.replication.worker.stop();await new Promise(resolve=>server.close(resolve));await h.close();}
});
test('native provider sends exactly one official-model POST with Cancel-After, even on network errors or 429',async()=>{
  for(const behavior of ['network',429,201]){const calls=[];const provider=createReplicationProvider('fake-unit-test-token',{fetchImpl:async(url,options)=>{calls.push({url,options});if(behavior==='network')throw new TypeError('fetch failed with secret');return new Response(JSON.stringify({id:'prediction-native',model:REPLICATION_MODELS.analysis,status:'starting'}),{status:behavior});}});
    if(behavior===201)await provider.create(REPLICATION_MODELS.analysis,{prompt:'safe fixture'});else await assert.rejects(provider.create(REPLICATION_MODELS.analysis,{prompt:'safe fixture'}),e=>e.code==='SUBMISSION_UNKNOWN');
    assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.replicate.com/v1/models/openai/o4-mini/predictions');assert.equal(calls[0].options.headers['Cancel-After'],'300s');assert(!calls[0].options.headers.Prefer);
    await assert.rejects(provider.create('unapproved/model',{}));assert.equal(calls.length,1);
  }
});

test('pre-submission asset read failure terminates safely, including after restart, with zero predictions',async()=>{
  const h=await harness();
  try{
    h.assets.dataUri=async()=>{throw Object.assign(new Error('MOCK missing asset'),{code:'ENOENT'});};
    const response=await h.request('/analysis',analysisBody());assert.equal(response.status,202);
    const id=(await response.json()).id;
    const first=await waitFor(h,id,j=>j.errorCode==='INPUT_PREPARATION_FAILED');
    assert.equal(first.status,'failed');assert(isFinalJob(first));assert.equal(h.created.length,0);assert.equal((await h.store.attempts(id)).length,0);
    await h.restart();
    const after=await waitFor(h,id,j=>j.errorCode==='INPUT_PREPARATION_FAILED');
    assert.equal(after.status,'failed');assert.equal(h.created.length,0);assert.equal((await h.store.attempts(id)).length,0);
  }finally{await h.close();}
});

test('array text chunks parse and refill as one analysis, without invoking generation',async()=>{
  const text=JSON.stringify(fixture());
  const h=await harness({analysisOutput:[text.slice(0,40),text.slice(40)]});
  try{const r=await h.request('/analysis',analysisBody());const j=await waitFor(h,(await r.json()).id);
    assert.equal(j.status,'succeeded');assert.equal(j.analysis.rawText,text);assert(j.analysis.text.length>0);
    assert.equal(h.created.length,1);assert.equal(h.created[0].model,'openai/o4-mini');
  }finally{await h.close();}
});

test('GET of queued legacy generation is read-only; explicit recovery terminates without any Nano Banana 2',async()=>{
  const h=await harness();
  try{
    const a=await approved(h),original=await h.store.get(a.id);
    const job={...original,id:randomUUID(),requestId:randomUUID(),kind:'generation',status:'queued',stage:'queued',workerLease:null,
      analysis:null,analysisJobId:a.id,approvedAnalysis:{text:a.analysis.text,revisionHash:a.analysis.revisionHash},input:generationBody(a),results:[],images:[],total:1};
    job.assets=await h.assets.cloneMaterials(job,original);
    await h.store.create(job);
    assert.equal(h.created.length,1);assert.equal((await h.store.attempts(job.id)).length,0);
    assert.equal((await h.request('/jobs/'+job.id)).status,200);
    await pause(20);assert.equal(h.created.length,1);assert.equal((await h.store.get(job.id)).status,'queued');
    await h.request('/jobs/'+job.id+'/resume',{});const g=await waitFor(h,job.id);assert.equal(g.status,'failed');assert.equal(h.created.length,1);
  }finally{await h.close();}
});

async function intakeApp(){
  const h=await harness();let providerCalls=0;
  const blocked=()=>{providerCalls++;throw new Error('MOCK_PROVIDER_MUST_NOT_BE_CALLED');};
  const app=createApp({dataDir:h.directory,replicateClientFactory:()=>({}),replicationProviderFactory:blocked});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  return {h,app,server,port:server.address().port,calls:()=>providerCalls,async close(){app.locals.replication.worker.stop();await app.locals.replication.worker.idle();await new Promise(resolve=>server.close(resolve));await h.close();}};
}

test('actual Express intake: interrupted JSON upload logs UPLOAD_INTERRUPTED, no POST intake log/job/model; original request lookup is 404',async()=>{
  const x=await intakeApp(),errors=[],logs=[],originalError=console.error,originalLog=console.log;
  console.error=(...args)=>errors.push(args);console.log=(...args)=>logs.push(args);
  try{
    const requestId=randomUUID();
    await new Promise(resolve=>{
      const request=http.request({host:'127.0.0.1',port:x.port,path:'/api/replication/analysis',method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':'100000','x-user-id':'alice','x-replication-request-id':requestId}},response=>response.resume());
      request.on('error',resolve);
      request.write('{"requestId":"'+requestId+'","sourceImage":"');
      setTimeout(()=>request.destroy(),30);
    });
    for(let i=0;i<20&&!errors.length;i++)await pause(5);
    const entry=errors.map(args=>{try{return JSON.parse(args[0]);}catch{return null;}}).find(e=>e?.error_code==='UPLOAD_INTERRUPTED');
    assert(entry);assert.equal(entry.http_status,400);assert.equal(entry.request_id,requestId);
    assert.equal(entry.expected_bytes,100000);assert(entry.received_bytes>0&&entry.received_bytes<entry.expected_bytes);
    assert(!logs.some(args=>String(args[0]).includes('[Request] POST /api/replication/analysis')));
    const response=await fetch('http://127.0.0.1:'+x.port+'/api/replication/request/'+requestId,{headers:{'x-user-id':'alice'}});
    assert.equal(response.status,404);assert.equal((await response.json()).errorCode,'JOB_NOT_FOUND');
    assert.equal((await x.h.store.list()).length,0);assert.equal(x.calls(),0);
  }finally{console.error=originalError;console.log=originalLog;await x.close();}
});

test('actual Express intake: malformed JSON returns its correct 400 classification, without a task or model call',async()=>{
  const x=await intakeApp();
  try{
    const response=await fetch('http://127.0.0.1:'+x.port+'/api/replication/analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
    assert.equal(response.status,400);assert.equal((await response.json()).errorCode,'INVALID_JSON');assert.equal((await x.h.store.list()).length,0);assert.equal(x.calls(),0);
  }finally{await x.close();}
});

test('actual Express intake: expanded body over 50 MiB returns 413 with a safe request trace and zero model calls',async()=>{
  const x=await intakeApp(),errors=[],originalError=console.error,requestId=randomUUID();console.error=(...args)=>errors.push(args);
  try{
    // Reuse a 1 MiB whitespace block through gzip: exercise the real parser
    // limit without allocating or transmitting a 51 MiB request body at once.
    const block=Buffer.alloc(1024*1024,32);
    const response=await new Promise((resolve,reject)=>{
      const request=http.request({host:'127.0.0.1',port:x.port,path:'/api/replication/analysis',method:'POST',
        headers:{'Content-Type':'application/json','Content-Encoding':'gzip','x-user-id':'alice',
          'x-replication-request-id':requestId,'x-replicate-token':'MOCK_SECRET_DO_NOT_LOG'}},response=>{
          let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));
        });
      request.setTimeout(10000,()=>request.destroy(new Error('MOCK_REQUEST_TIMEOUT')));request.on('error',reject);
      const source=Readable.from(Array(51).fill(block)),zip=createGzip();source.on('error',reject);zip.on('error',reject);source.pipe(zip).pipe(request);
    });
    assert.equal(response.status,413);assert.equal(response.body.errorCode,'PAYLOAD_TOO_LARGE');
    const entry=JSON.parse(errors.find(args=>String(args[0]).includes('PAYLOAD_TOO_LARGE'))[0]);assert.equal(entry.http_status,413);assert.equal(entry.request_id,requestId);
    assert(!JSON.stringify(errors).includes('MOCK_SECRET_DO_NOT_LOG'));assert.equal((await x.h.store.list()).length,0);assert.equal(x.calls(),0);
  }finally{console.error=originalError;await x.close();}
});

const requestIdentity=body=>({requestId:body.requestId,kind:'analysis',inputFingerprint:body.inputFingerprint});
test('intake survives restart; GET is read-only; sealing a 404 request fences all delayed submissions',async()=>{
  const h=await harness();try{
    const body=analysisBody(),identity=requestIdentity(body);
    assert.equal((await h.request('/requests',identity)).status,202);assert.equal(h.created.length,0);
    await h.restart();assert.equal((await h.request('/requests/'+body.requestId)).status,200);
    assert.equal((await h.request('/request/'+body.requestId)).status,404);
    assert.equal((await (await h.request('/active?kind=analysis')).json()).requests.length,1);
    const sealed=await (await h.request('/requests/'+body.requestId+'/close',identity)).json();assert.equal(sealed.closed,true);
    assert.equal((await h.request('/analysis',body)).status,410);assert.equal((await h.request('/requests',identity)).status,410);
    assert.equal(h.created.length,0);assert.equal((await h.store.list()).length,0);
    assert.equal((await h.request('/requests/'+body.requestId,undefined,'bob')).status,404);
    assert.equal((await h.request('/requests',{...identity,inputFingerprint:'b'.repeat(64)})).status,409);
  }finally{await h.close();}
});
test('two concurrent reservations for one account accept only one; closing the rejected identity never releases the accepted one',async()=>{
  const h=await harness();try{
    const a=requestIdentity(analysisBody()),b=requestIdentity(analysisBody()),r=await Promise.all([h.request('/requests',a),h.request('/requests',b)]);
    assert.deepEqual(r.map(x=>x.status).sort(),[202,409]);const accepted=r[0].status===202?a:b,rejected=r[0].status===202?b:a;
    assert.equal((await (await h.request('/requests/'+rejected.requestId+'/close',rejected)).json()).closed,true);
    assert.equal((await h.store.getRequest('alice',accepted.requestId)).state,'reserved');assert.equal(h.created.length,0);
  }finally{await h.close();}
});
test('sealing during normalization wins before dispatch; the late body fails and a fresh request can run',async()=>{
  const h=await harness();let release,entered;
  const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),prepare=h.assets.prepare.bind(h.assets);
  h.assets.prepare=async(...args)=>{entered();await gate;return prepare(...args);};
  try{
    const body=analysisBody(),identity=requestIdentity(body);await h.request('/requests',identity);
    const pending=h.request('/analysis',body);await ready;
    assert.equal((await (await h.request('/requests/'+body.requestId+'/close',identity)).json()).closed,true);
    release();assert.equal((await pending).status,410);assert.equal(h.created.length,0);
    assert.equal((await h.store.byRequest('alice',body.requestId)).status,'failed');
    h.assets.prepare=prepare;assert.equal((await analyze(h)).status,'succeeded');assert.equal(h.created.length,1);
  }finally{release();await h.close();}
});
test('sealing while worker reads images fences its later attempt insertion, so a seal acknowledgment cannot be followed by a charge',async()=>{
  const h=await harness();let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),read=h.assets.dataUri.bind(h.assets);
  h.assets.dataUri=async(...args)=>{entered();await gate;return read(...args);};
  try{
    const body=analysisBody(),r=await h.request('/analysis',body),job=await r.json();await ready;
    const sealed=await (await h.request('/requests/'+body.requestId+'/close',requestIdentity(body))).json();assert.equal(sealed.closed,true);
    release();await pause(30);assert.equal(h.created.length,0);assert.equal((await h.store.attempts(job.id)).length,0);
    assert.equal((await h.store.get(job.id)).status,'failed');
  }finally{release();await h.close();}
});
test('once an attempt exists, safe-end cannot clear the fee guard, including a lost provider acknowledgment',async()=>{
  const h=await harness({createDelayMs:70,createError:{uncertain:true,code:'SUBMISSION_UNKNOWN'}});try{
    const body=analysisBody(),r=await h.request('/analysis',body),job=await r.json();await waitFor(h,job.id,j=>j.predictions.length===1);
    const sealed=await (await h.request('/requests/'+body.requestId+'/close',requestIdentity(body))).json();assert.equal(sealed.closed,false);
    const unknown=await waitFor(h,job.id);assert.equal(unknown.status,'submission_unknown');
    await h.restart();await h.request('/jobs/'+job.id+'/resume',{});await h.request('/analysis',body);await pause(20);
    assert.equal(h.created.length,1);assert.equal((await h.request('/analysis',analysisBody())).status,409);
  }finally{await h.close();}
});
test('PostgreSQL receipt sealing and attempt fencing are durable and reject a stale worker lease',async()=>{
  const {Pool}=newDb().adapters.createPg(),pool=new Pool(),db=createStore(pool);await db.init();const user=await db.createUser('pg-seal','fixture'),store=createPgReplicationStore(pool);
  try{
    const identity={ownerId:user.id,requestId:randomUUID(),kind:'analysis',inputFingerprint:'f'.repeat(64)};
    await store.reserveRequest({...identity,state:'reserved',revision:0});
    const job={...identity,id:randomUUID(),payloadHash:'hash',status:'queued',revision:0,workerLease:{id:'old-lease',until:Date.now()+10000}};
    await store.create(job);const result=await store.closeRequest(identity);assert(result.closed);assert.equal(result.job.status,'failed');
    const a={id:randomUUID(),jobId:job.id,attemptNo:1};assert.equal(await store.claimAttempt(a,'old-lease'),false);
    // pg-mem incorrectly selects the partial active-user index for a nonactive
    // receipt lookup. Verify persisted rows by a full scan; real PostgreSQL
    // indexed lookup/locking remains a separate pre-release integration check.
    const persisted=(await pool.query('SELECT document FROM replication_requests')).rows.find(r=>r.document.requestId===identity.requestId).document;
    assert.equal(persisted.state,'closed');
    assert.equal((await store.attempts(job.id)).length,0);
    const next={...identity,requestId:randomUUID()};await store.reserveRequest({...next,state:'reserved',revision:0});
    const queued={...job,...next,id:randomUUID()};await store.create(queued);assert.equal(await store.claimAttempt({...a,id:randomUUID(),jobId:queued.id},'old-lease'),true);
    assert.equal((await store.closeRequest(next)).closed,false);
  }finally{await pool.end();}
});
test('resuming an interrupted batch keeps its existing candidate and cannot create the next paid sample',async()=>{
  const h=await harness({advanced:true});let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),save=h.assets.saveComposite.bind(h.assets);
  h.assets.saveComposite=async(...args)=>{entered();await gate;return save(...args);};
  try{
    const a=await approved(h),r=await h.request('/generation',generationBody(a,{count:4,confirmedPredictions:4})),job=await r.json();await ready;
    const restart=h.restart();release();await restart;
    assert.equal((await h.store.get(job.id)).results.length,1);assert.equal(h.created.length,2);
    await h.request('/jobs/'+job.id+'/resume',{});const done=await waitFor(h,job.id);
    assert.equal(done.status,'failed');assert.equal(done.errorCode,'PRE_SUBMISSION_INTERRUPTED');assert.equal(done.results.length,1);assert.equal(h.created.length,2);
  }finally{release();await h.close();}
});
