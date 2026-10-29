import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import express from 'express';
import sharp from 'sharp';
import ts from 'typescript';
import vm from 'node:vm';
import {createImageDelivery} from '../server/image-delivery.js';

const testRoot=fileURLToPath(new URL('../.local/migration-archive/test-data/',import.meta.url));
async function fixture(){
  await mkdir(testRoot,{recursive:true});const dir=await mkdtemp(path.join(testRoot,'delivery-'));
  const file=path.join(dir,'original.png'),bytes=await sharp({create:{width:2200,height:1800,channels:3,background:'#bd755a'}}).png().toBuffer();
  await writeFile(file,bytes);return {dir,file,bytes,close:()=>rm(dir,{recursive:true,force:true})};
}
test('persistent previews coalesce same-source requests and survive a delivery-service restart',async()=>{
  const f=await fixture();let renders=0;
  const options={render:async()=>{renders++;await pause(15);return Buffer.from('private-preview');}};
  try{
    const a=createImageDelivery(f.dir,options),files=await Promise.all(Array.from({length:12},()=>a.preview(f.file,'alice','same-hash','canvas')));
    assert.equal(new Set(files).size,1);assert.equal(renders,1);
    const restarted=createImageDelivery(f.dir,{render:()=>{throw new Error('must reuse disk preview');}});
    assert.equal(await restarted.preview(f.file,'alice','same-hash','canvas'),files[0]);
    assert.equal((await readFile(files[0])).toString(),'private-preview');
    assert.notEqual(await a.preview(f.file,'bob','same-hash','canvas'),files[0]);assert.equal(renders,2);
    await assert.rejects(a.preview(f.file,'alice','same-hash','__proto__'),/INVALID_PREVIEW_VARIANT/);
  }finally{await f.close();}
});
test('different preview transforms are limited to two concurrent Sharp jobs',async()=>{
  const f=await fixture();let active=0,peak=0;
  try{const a=createImageDelivery(f.dir,{render:async()=>{active++;peak=Math.max(peak,active);await pause(10);active--;return Buffer.from('preview');}});
    await Promise.all(Array.from({length:9},(_,i)=>a.preview(f.file,'alice','hash-'+i,'1')));assert.equal(peak,2);assert.equal(active,0);
  }finally{await f.close();}
});
test('native download streams the complete original with attachment, length and Range; preview cache never substitutes the file',async()=>{
  const f=await fixture(),delivery=createImageDelivery(f.dir),app=express();let server;
  app.get('/image',async(req,res,next)=>{try{await delivery.serve(req,res,{file:f.file,owner:'alice',identity:'fixture-sha',versioned:req.query.v==='fixture-sha',downloadName:'original.png'});}catch(e){next(e);}});
  try{server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const url='http://127.0.0.1:'+server.address().port+'/image';
    const preview=await fetch(url+'?v=fixture-sha&preview=canvas');assert.equal(preview.status,200);
    assert.match(preview.headers.get('cache-control'),/private, max-age=3600, immutable/);assert.match(preview.headers.get('vary'),/Cookie/);
    const small=Buffer.from(await preview.arrayBuffer());assert(small.length<f.bytes.length);assert.equal((await sharp(small).metadata()).width,1600);
    const full=await fetch(url+'?download=1&preview=1&filename='+encodeURIComponent('图像复刻_结果.png'),{headers:{'If-None-Match':preview.headers.get('etag')}});
    assert.equal(full.status,200);assert.match(full.headers.get('content-disposition'),/^attachment;.*filename\*/);assert.equal(Number(full.headers.get('content-length')),f.bytes.length);assert.match(full.headers.get('content-type'),/png/);
    assert(full.headers.get('etag'));assert.equal(full.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await full.arrayBuffer()),f.bytes);
    const partial=await fetch(url+'?download=1',{headers:{Range:'bytes=0-63'}});assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),f.bytes.subarray(0,64));
    const legacy=await fetch(url);assert.match(legacy.headers.get('cache-control'),/must-revalidate/);await legacy.arrayBuffer();
    const retry=await fetch(url+'?v=fixture-sha&preview=canvas&retry=1');assert.equal(retry.headers.get('cache-control'),'private, no-store');await retry.arrayBuffer();
  }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
test('download click stays synchronous, uses an attached anchor and requests original bytes; display URLs never alter stored originals',async()=>{
  let attached=false,clicked=false,fetches=0;
  const context=vm.createContext({URL,location:{origin:'https://studio.example'},fetch:()=>{fetches++;throw new Error('No fetch permitted');},
    document:{body:{appendChild:()=>{attached=true;},removeChild:()=>{attached=false;}},createElement:()=>({style:{},click(){assert(attached);clicked=this.href;}})}});
  const source=await readFile(new URL('../services/imageDelivery.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  context.exports={};vm.runInContext(code,context);const api=context.exports;
  const original='/api/replication/assets/job/raw-1.png?owner=alice&v=abc';
  const display=api.imageDisplayUrl(original,'thumb');assert.match(display,/preview=1&pv=2/);assert(!original.includes('preview'));
  const props=api.imagePreviewProps(original,'thumb');let currentSrc=props.src,fallbacks=0;
  const image={getAttribute:()=>currentSrc,set src(value){currentSrc=value;fallbacks++;}};
  props.onError({currentTarget:image});assert.equal(currentSrc,original);props.onError({currentTarget:image});assert.equal(fallbacks,1,'failed preview falls back once without a loop');
  api.startImageDownload(display+'&retry=2','结果.png');assert(clicked);assert(!attached);assert.equal(fetches,0);
  const url=new URL(clicked,'https://studio.example');assert.equal(url.searchParams.get('download'),'1');assert.equal(url.searchParams.get('filename'),'结果.png');assert(!url.searchParams.has('preview'));assert(!url.searchParams.has('retry'));assert.equal(url.searchParams.get('v'),'abc');
  for(const remote of ['blob:local-preview','data:image/png;base64,AA==','https://replicate.delivery/image.png'])assert.equal(api.imageDisplayUrl(remote),remote);
  assert.throws(()=>api.startImageDownload('javascript:alert(1)','x'),/下载地址无效/);
});
