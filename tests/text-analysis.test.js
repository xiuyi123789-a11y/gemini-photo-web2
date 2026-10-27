import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {createTextAnalyzer,TEXT_ANALYSIS_MODEL} from '../server/text-analysis.js';
import {loadStudioServices} from './studio-service-harness.js';

const bytes=await sharp({create:{width:48,height:32,channels:3,background:'white'}}).png().toBuffer();
const file=()=>new File([bytes],'sample.png',{type:'image/png'});
const understanding='【主体 / Subject】\n白色低帮鞋\n【姿势与动作 / Pose & Action】\n侧面静置\n【场景与环境 / Scene & Environment】\n白色背景\n【构图与镜头 / Composition & Camera】\n平视近景\n【光照与氛围 / Lighting & Atmosphere】\n柔和光线\n【服装与造型 / Clothing & Styling】\n无人物\n【风格与后期 / Style & Post-processing】\n产品摄影';
async function harness({createError,output,pollFailure=false}={}){
  const root=path.resolve('.local/migration-archive/test-data');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'text-model-'));
  const calls=[],tokens=[],imageModels=[],fetches=[];let prediction;
  const provider={create:async(model,input)=>{
    calls.push({model,input});if(createError)throw createError;
    const result=output!==undefined?output:input.system_instruction.includes('电商图片任务型')?
      '```json\n'+JSON.stringify(input.prompt.includes('科技感')?{type:'generate',aspect_ratio:'3:4',prompt:'科技感产品摄影'}:{type:'clarify',missing_slots:['style'],question:'需要什么风格？'})+'\n```':
      input.prompt.includes('positive_prompt')?'```json\n{"positive_prompt":"(product:1.3)","negative_prompt":"blurry"}\n```':
      input.prompt.includes('【给AI看的】')?'【参数】\n重绘幅度：0.65\n【给用户看的】\n改善光线。\n【给AI看的】\n(soft lighting:1.3), (photorealistic:1.2)':
      input.prompt.includes('image_type')?'```json\n{"image_type":"product","product":{"present":true,"category":"鞋"}}\n```':understanding;
    prediction={id:'fake-gemini-'+calls.length,model,status:pollFailure?'processing':'succeeded',output:[result.slice(0,12),result.slice(12)]};return prediction;
  },get:async()=>{throw Object.assign(new Error('private-provider-error'),{code:'PROVIDER_UNREACHABLE',status:502});}};
  const sdk={models:{get:async(owner,name)=>{imageModels.push(owner+'/'+name);return {latest_version:{id:'fake-image-version'}};}},predictions:{create:async()=>({id:'fake-image',status:'succeeded',output:'data:image/png;base64,'+bytes.toString('base64')})}};
  const app=createApp({dataDir:dir,replicateClientFactory:()=>sdk,textAnalysisOptions:{providerFactory:token=>{tokens.push(token);return provider;},pollMs:1,budgetMs:1000}});
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const origin='http://127.0.0.1:'+server.address().port;
  const service=loadStudioServices({origin,token:'mock-byok',fetchImpl:(url,options)=>{fetches.push(url);return fetch(url,options);}});
  return {app,calls,tokens,imageModels,fetches,service,origin,async close(){app.locals.replication.worker.stop();await new Promise(r=>server.close(r));assert(dir.startsWith(root+path.sep));await rm(dir,{recursive:true,force:true});}};
}
test('all four sections use Gemini native inputs and parse their text/JSON outputs, without creating any image model',async()=>{
  const h=await harness();try{
    const s=h.service;
    assert.equal(JSON.parse(await s.taskChatWithGemini([{role:'user',content:'画一个商品'}])).type,'clarify');
    assert.equal(JSON.parse(await s.taskChatWithGemini([{role:'user',content:'科技感 3:4 商品摄影'}])).type,'generate');
    const results=await s.analyzeImages([file()]);assert(!results[0].error);assert(results[0].analysis.includes('白色低帮鞋'));
    const categorized=await s.analyzeAndCategorizeImageForKB(file());assert.equal(Object.keys(categorized.fragments).length,7);
    const merged=await s.analyzeAndMergeReferenceImagesForGeneration([file()]);assert(merged.trim());
    const retouch=await s.analyzeImageSmartRetouch(file());assert(retouch.understanding.includes('白色低帮鞋'));assert(retouch.suggestions.includes('【给AI看的】'));
    assert(await s.mergeRetouchPromptsWithImage(file(),understanding,'修改背景'));
    const sd=await s.extractSdPromptsFromImage(file());assert.equal(sd.positive,'(product:1.3)');assert.equal(sd.negative,'blurry');
    assert.equal(h.calls.length,10);assert(h.calls.every(c=>c.model===TEXT_ANALYSIS_MODEL));assert.deepEqual(h.imageModels,[]);assert(h.tokens.every(t=>t==='mock-byok'));
    for(const {input} of h.calls){assert.equal(input.thinking_budget,128);assert.equal(input.dynamic_thinking,false);assert(input.max_output_tokens>=256);assert(Array.isArray(input.images));for(const key of ['image_input','messages','system_prompt','max_completion_tokens','reasoning_effort','verbosity'])assert(!(key in input));}
    const history=h.calls[1].input;assert(history.prompt.includes('科技感'));assert(history.system_instruction.includes('missing_slots'));
  }finally{await h.close();}
});
test('non-image frontend calls never retry create after 429, timeout-like failures or lost provider polling; no stream fallback',async()=>{
  for(const createError of [{code:'SUBMISSION_UNKNOWN',status:429,uncertain:true},{code:'SUBMISSION_UNKNOWN',status:502,uncertain:true}]){
    const h=await harness({createError});try{await assert.rejects(h.service.runVisionAnalysis(file(),undefined,{retries:3}));assert.equal(h.calls.length,1);assert.equal(h.fetches.length,1);}finally{await h.close();}
  }
  const h=await harness({pollFailure:true});try{await assert.rejects(h.service.taskChatWithGemini([{role:'user',content:'test'}]));assert.equal(h.calls.length,1);assert.equal(h.fetches.length,1);}finally{await h.close();}
});
test('Gemini empty output and invalid structured output fail explicitly with no replacement prediction',async()=>{
  for(const output of ['',{unexpected:true},'not JSON']){
    const h=await harness({output});try{await assert.rejects(h.service.taskChatWithGemini([{role:'user',content:'test'}]));assert.equal(h.calls.length,1);}finally{await h.close();}
  }
});
test('Gemini migration leaves Nano Banana 2 generation, Nano Banana retouch and masked image models unchanged',async()=>{
  const h=await harness();try{
    for(const [route,body] of [['generate-image',{prompt:'test'}],['retouch-image',{image:'data:image/png;base64,'+bytes.toString('base64'),prompt:'test'}],['retouch-image',{image:'x',mask:'x',prompt:'test'}]]){
      const r=await fetch(h.origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','x-user-id':'image-test','x-replicate-token':'fake'},body:JSON.stringify(body)});assert.equal(r.status,200);
    }
    assert.deepEqual(h.imageModels,['google/nano-banana-2','google/nano-banana','black-forest-labs/flux-fill-dev']);assert.equal(h.calls.length,0);
  }finally{await h.close();}
});
test('text-only frontend POST timeout sends once even when callers request three retries',async()=>{
  let creates=0;
  const s=loadStudioServices({fetchImpl:async()=>{creates++;throw new TypeError('simulated lost response');}});
  await assert.rejects(s.runVisionAnalysis(file(),'describe',{retries:3}));assert.equal(creates,1);
});
test('text adapter rejects image-model output and preserves the original prediction ID on failure',async()=>{
  const analyze=createTextAnalyzer({providerFactory:()=>({create:async()=>({id:'wrong-model-prediction',status:'succeeded',model:'google/nano-banana-2',output:'image-url'})})});
  await assert.rejects(analyze('fake',{prompt:'test',system:'test'}),e=>e.code==='PREDICTION_MODEL_MISMATCH'&&e.predictionId==='wrong-model-prediction');
});

test('invalid local inputs do not submit predictions; SD schema failure keeps the original ID without exposing raw output',async()=>{
  const h=await harness({output:'private-invalid-output'});try{
    const headers={'Content-Type':'application/json','x-user-id':'text-test'};
    for(const route of ['/api/task-chat','/api/merge-generation-understanding']){
      const r=await fetch(h.origin+route,{method:'POST',headers,body:'{}'});assert.equal(r.status,400);
    }
    const corrupt=new FormData();corrupt.append('image',new File(['not an image'],'corrupt.png',{type:'image/png'}));
    assert.equal((await fetch(h.origin+'/api/analyze-image',{method:'POST',body:corrupt})).status,422);assert.equal(h.calls.length,0);
    const valid=new FormData();valid.append('image',file());
    const r=await fetch(h.origin+'/api/sd-prompt-from-image',{method:'POST',body:valid});assert.equal(r.status,502);
    const data=await r.json();assert.equal(data.errorCode,'ANALYSIS_SCHEMA_INVALID');assert.equal(data.predictionId,'fake-gemini-1');
    assert(!JSON.stringify(data).includes('private-invalid-output'));assert.equal(h.calls.length,1);
  }finally{await h.close();}
});
