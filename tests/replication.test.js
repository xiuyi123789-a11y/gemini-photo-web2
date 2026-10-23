import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createReplicationRouter, validateReplicationInput, REPLICATION_MODELS } from '../server/replication.js';
import sharp from 'sharp';
import { compositeReplicationImage } from '../server/replication-composite.js';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const input=(overrides={})=>({requestId:randomUUID(),sourceImage:png,references:[{image:png,angle:'front'},{image:png,angle:'back'}],target:'桌面中央的瓶子',analysis:'琥珀玻璃瓶，黑色滴管，米白标签',preserve:['background','composition','lighting','perspective'],resolution:'2K',count:1,notes:'保留标签文字',region:{x:.2,y:.1,width:.5,height:.8},...overrides});
async function harness(options={}) {
  const created=[], canceled=[], saved=[];
  let serial=0;
  const client={
    models:{get:async()=>({})},
    predictions:{
      create:async args=>{
        created.push(args);const id='prediction-'+(++serial);
        if(options.createError)throw options.createError;
        if(options.failOn===serial)throw Object.assign(new Error('unsafe provider input: secret-token'),{status:422});
        return {id,status:options.pending?'processing':'succeeded',output:args.model===REPLICATION_MODELS.analysis?['产品','分析']: 'https://replicate.delivery/test-'+serial+'.png'};
      },
      get:async(id)=>({id,status:'processing'}),
      cancel:async id=>{canceled.push(id);return {id,status:'canceled'};}
    }
  };
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.userId=req.get('x-user-id')||'alice';next();});
  app.use('/replication',createReplicationRouter({
    getClient:()=>client,saveOutput:async(url,owner)=>{saved.push({url,owner});return '/api/images/'+owner+'/'+saved.length+'.png';},processOutput:async url=>url,
    pollMs:2,predictionTimeoutMs:options.timeout||1000
  }));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port+'/replication';
  const request=(path,body,owner='alice')=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-user-id':owner},...(body?{body:JSON.stringify(body)}:{})});
  return {created,canceled,saved,request,close:()=>new Promise(resolve=>server.close(resolve))};
}
async function done(h,id) {
  for(let i=0;i<150;i++){
    const job=await (await h.request('/'+id)).json();
    if(['succeeded','failed','canceled'].includes(job.status))return job;
    await pause(5);
  }
  throw new Error('Task did not finish');
}
test('rejects remote URLs, bad image signatures, invalid output settings and excess references',()=>{
  for(const patch of [
    {sourceImage:'https://example.com/private.png'},
    {sourceImage:'data:image/png;base64,QUFBQQ=='},
    {references:Array.from({length:13},()=>({image:png,angle:'front'}))},
    {references:[{image:png,angle:'unknown'}]},
    {resolution:'8K'},{count:100},{analysis:''},{preserve:['__proto__']},{region:null},{region:{x:.8,y:0,width:.5,height:1}}
  ])assert.throws(()=>validateReplicationInput(input(patch),'generation'));
});
test('analysis sends original first and every reference to exactly o4-mini',async()=>{
  const h=await harness();
  try{
    const response=await h.request('/analysis',input());assert.equal(response.status,202);
    const job=await done(h,(await response.json()).id);
    assert.equal(job.status,'succeeded');assert.equal(job.analysis,'产品分析');
    assert.equal(h.created[0].model,'openai/o4-mini');
    assert.equal(h.created[0].input.image_input.length,3);
    assert.equal(h.created[0].input.reasoning_effort,'low');
    assert.match(h.created[0].input.prompt,/图片1是场景原图/);
    assert.match(h.created[0].input.prompt,/图片3.*背面/);
  }finally{await h.close();}
});
test('generation uses Nano Banana 2, all references, original aspect, requested resolution and separate saved outputs',async()=>{
  const h=await harness();
  try{
    const payload=input({count:2,resolution:'4K'});
    const {id}=await (await h.request('/generation',payload)).json();
    const job=await done(h,id);
    assert.equal(job.status,'succeeded');assert.equal(h.created.length,2);assert.equal(job.images.length,2);
    for(const call of h.created){
      assert.equal(call.model,'google/nano-banana-2');
      assert.equal(call.input.image_input.length,3);assert.equal(call.input.image_input[0],png);
      assert.equal(call.input.aspect_ratio,'match_input_image');assert.equal(call.input.resolution,'4K');assert.equal(call.input.output_format,'png');
      assert.match(call.input.prompt,/黑色滴管/);assert.match(call.input.prompt,/非目标元素/);
      assert.equal(call.input.image_search,false);
    }
    assert(h.saved.every(item=>item.owner==='alice'));
    assert.equal((await h.request('/'+id,undefined,'bob')).status,404);
    assert.equal((await h.request('/'+id+'/cancel',{},'bob')).status,404);
    assert.equal((await h.request('/request/'+payload.requestId,undefined,'bob')).status,404);
  }finally{await h.close();}
});
test('idempotent request IDs never create duplicate paid predictions',async()=>{
  const h=await harness();
  try{
    const payload=input();const first=await (await h.request('/generation',payload)).json();
    await done(h,first.id);
    const second=await (await h.request('/generation',payload)).json();
    assert.equal(second.id,first.id);assert.equal(h.created.length,1);
    const recovered=await (await h.request('/request/'+payload.requestId)).json();
    assert.equal(recovered.id,first.id);
  }finally{await h.close();}
});
test('partial failures preserve finished images and do not expose provider request details',async()=>{
  const h=await harness({failOn:2});
  try{
    const {id}=await (await h.request('/generation',input({count:4}))).json();
    const job=await done(h,id);
    assert.equal(job.status,'failed');assert.equal(job.images.length,1);assert.equal(h.created.length,2);
    assert.match(job.error,/模型拒绝/);assert(!JSON.stringify(job).includes('secret-token'));
  }finally{await h.close();}
});
test('cancellation reaches the active provider prediction and stops the remaining batch',async()=>{
  const h=await harness({pending:true});
  try{
    const {id}=await (await h.request('/generation',input({count:4}))).json();
    assert.equal((await h.request('/generation',input())).status,409);
    await h.request('/'+id+'/cancel',{});
    const job=await done(h,id);
    assert.equal(job.status,'canceled');assert.equal(h.canceled.length,1);assert.equal(h.created.length,1);
  }finally{await h.close();}
});
test('provider timeout cancels the prediction instead of leaving it running',async()=>{
  const h=await harness({pending:true,timeout:20});
  try{
    const {id}=await (await h.request('/analysis',input())).json();const job=await done(h,id);
    assert.equal(job.status,'failed');assert.match(job.error,/超时/);assert.equal(h.canceled.length,1);
  }finally{await h.close();}
});
test('invalid credentials are reported without exposing the credential',async()=>{
  const h=await harness({createError:Object.assign(new Error('Bearer secret-token'),{status:401})});
  try{
    const {id}=await (await h.request('/analysis',input())).json();const job=await done(h,id);
    assert.equal(job.status,'failed');assert.match(job.error,/Token 无效/);assert(!job.error.includes('secret-token'));
  }finally{await h.close();}
});
test('composition changes the selected region while keeping every outside pixel identical',async()=>{
  const source=await sharp({create:{width:48,height:32,channels:4,background:'#bb3344'}}).png().toBuffer();
  const generated=await sharp({create:{width:96,height:64,channels:4,background:'#3388cc'}}).png().toBuffer();
  const region={x:.25,y:.25,width:.5,height:.5};
  const output=await compositeReplicationImage('data:image/png;base64,'+source.toString('base64'),generated,region);
  const {data,info}=await sharp(output).raw().toBuffer({resolveWithObject:true});
  const original=await sharp(source).raw().toBuffer();
  assert.equal(info.width,48);assert.equal(info.height,32);
  let changes=0;
  for(let y=0;y<32;y++)for(let x=0;x<48;x++){
    const offset=(y*48+x)*4;
    if(x<12||x>=36||y<8||y>=24)assert.deepEqual(data.subarray(offset,offset+4),original.subarray(offset,offset+4));
    else if(!data.subarray(offset,offset+4).equals(original.subarray(offset,offset+4)))changes++;
  }
  assert(changes>100);
});
test('composition follows EXIF orientation before applying the region',async()=>{
  const source=await sharp({create:{width:40,height:24,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const generated=await sharp({create:{width:24,height:40,channels:3,background:'blue'}}).png().toBuffer();
  const output=await compositeReplicationImage('data:image/jpeg;base64,'+source.toString('base64'),generated,{x:.2,y:.2,width:.6,height:.6});
  const metadata=await sharp(output).metadata();assert.equal(metadata.width,24);assert.equal(metadata.height,40);
});
