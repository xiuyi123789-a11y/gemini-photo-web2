import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const invalid=()=>Object.assign(new Error('INPUT_INVALID'),{code:'INPUT_INVALID',status:400});
const preparationFailure=()=>Object.assign(new Error('ASSET_PREPARATION_FAILED'),{code:'ASSET_PREPARATION_FAILED',status:500});
// Gemini's Replicate wrapper accepts at most 10 images, each up to 7 MB.
// Upload limits stay independent; only model copies are bounded here.
export const MODEL_IMAGE_LIMITS=Object.freeze({imageBytes:7_000_000,totalBytes:32*1024*1024,referenceEdge:3072});
// Lossless PNG can be much larger than an otherwise valid uploaded JPEG/WebP.
// Bound the model copies, rather than rejecting the user's valid upload after
// receipt. The full scene remains the canonical pixel source for composition.
async function modelCopy(bytes,budget){
  let edge=MODEL_IMAGE_LIMITS.referenceEdge;
  for(;;){
    const copy=await sharp(bytes,{limitInputPixels:32*1024*1024}).rotate().resize({width:edge,height:edge,fit:'inside',withoutEnlargement:true}).toColourspace('srgb').png().toBuffer();
    if(copy.length<=budget)return copy;
    if(edge<=512)throw preparationFailure();
    edge=Math.max(512,Math.floor(edge*Math.min(.8,Math.sqrt(budget/copy.length)*.95)));
  }
}
export function decodeImage(value) {
  if(typeof value!=='string')throw invalid();
  const match=value.match(/^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/);
  if(!match||match[2].length%4)throw invalid();
  const bytes=Buffer.from(match[2],'base64');
  if(!bytes.length||bytes.length>20*1024*1024)throw invalid();
  const signature=match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
      bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!signature)throw invalid();
  return bytes;
}
export function createReplicationAssets(dataDir,{download=downloadModelImage}={}) {
  const base=path.resolve(dataDir);
  const directory=job=>{
    if(!/^[a-zA-Z0-9-]+$/.test(job.ownerId)||!/^[0-9a-f-]{36}$/.test(job.id))throw invalid();
    const dir=path.resolve(base,job.ownerId,'replication',job.id);
    if(!dir.startsWith(base+path.sep))throw invalid();return dir;
  };
  const filename=name=>{if(!/^(?:source|model-source|guide|ref-\d+|raw-\d+|composite-\d+)\.png$/.test(name))throw invalid();return name;};
  async function save(job,name,bytes) {
    const target=path.join(directory(job),filename(name));await fs.mkdir(path.dirname(target),{recursive:true});
    const metadata=await sharp(bytes,{limitInputPixels:64*1024*1024}).metadata();
    await fs.writeFile(target,bytes,{mode:0o600});
    return {name,url:`/api/replication/assets/${job.id}/${name}?owner=${encodeURIComponent(job.ownerId)}`,width:metadata.width,height:metadata.height,
      sha256:sha256(bytes),bytes:bytes.length,mime:'image/png',colourspace:metadata.space||'srgb'};
  }
  return {
    async prepare(job,input) {
      const buffers=[decodeImage(input.sourceImage),...input.references.map(r=>decodeImage(r.image))];
      if(buffers.reduce((n,b)=>n+b.length,0)>32*1024*1024)throw invalid();
      try{
        const metadata=[];
        for(const bytes of buffers){const meta=await sharp(bytes,{limitInputPixels:32*1024*1024}).metadata();
          if((meta.pages||1)>1)throw Object.assign(new Error('ANIMATED_IMAGE_UNSUPPORTED'),{code:'ANIMATED_IMAGE_UNSUPPORTED',status:422});metadata.push(meta);}
        const canonical=await sharp(buffers[0],{limitInputPixels:32*1024*1024}).rotate().toColourspace('srgb').png().toBuffer();
        const source={...await save(job,'source.png',canonical),uploadedHash:sha256(buffers[0]),uploadedBytes:buffers[0].length};
        const sceneCopy=canonical.length>MODEL_IMAGE_LIMITS.imageBytes?await modelCopy(canonical,MODEL_IMAGE_LIMITS.imageBytes):canonical;
        const inferenceSource=sceneCopy===canonical?null:await save(job,'model-source.png',sceneCopy);
        const budget=Math.min(MODEL_IMAGE_LIMITS.imageBytes,Math.floor((MODEL_IMAGE_LIMITS.totalBytes-sceneCopy.length)/input.references.length));
        const references=[];let modelInputBytes=sceneCopy.length;
        for(let i=1;i<buffers.length;i++){
          const normalized=await modelCopy(buffers[i],budget);modelInputBytes+=normalized.length;
          references.push({...await save(job,`ref-${i}.png`,normalized),uploadedHash:sha256(buffers[i]),uploadedBytes:buffers[i].length,
            uploadedWidth:metadata[i].width,uploadedHeight:metadata[i].height,angle:input.references[i-1].angle});
        }
        return {source,references,...(inferenceSource?{inferenceSource}:{}),modelInputBytes,preprocessingVersion:'bounded-png-v2-gemini'};
      }catch(e){if(e.status)throw e;throw preparationFailure();}
    },
    read:(job,asset)=>fs.readFile(path.join(directory(job),filename(asset.name))),
    async cloneMaterials(job,fromJob) {
      const source={...fromJob.assets.source,...await save(job,'source.png',await this.read(fromJob,fromJob.assets.source))};
      const references=[];
      for(let i=0;i<fromJob.assets.references.length;i++)references.push({...fromJob.assets.references[i],...await save(job,`ref-${i+1}.png`,await this.read(fromJob,fromJob.assets.references[i]))});
      const inferenceSource=fromJob.assets.inferenceSource?await save(job,'model-source.png',await this.read(fromJob,fromJob.assets.inferenceSource)):null;
      return {source,references,...(inferenceSource?{inferenceSource}:{}),modelInputBytes:fromJob.assets.modelInputBytes,preprocessingVersion:fromJob.assets.preprocessingVersion};
    },
    async dataUri(job,asset){return 'data:image/png;base64,'+(await this.read(job,asset)).toString('base64');},
    async saveRaw(job,index,url){const bytes=await download(url);const png=await sharp(bytes,{limitInputPixels:64*1024*1024}).rotate().toColourspace('srgb').ensureAlpha().png().toBuffer();return save(job,`raw-${index}.png`,png);},
    saveComposite:(job,index,bytes)=>save(job,`composite-${index}.png`,bytes),
    saveGuide:(job,bytes)=>save(job,'guide.png',bytes),
    async remove(job){const dir=directory(job);if(!dir.startsWith(base+path.sep))throw invalid();await fs.rm(dir,{recursive:true,force:true});}
  };
}
export async function downloadModelImage(url) {
  let u;try{u=new URL(url);}catch{throw invalid();}
  if(u.protocol!=='https:'||u.username||u.password||!(u.hostname==='replicate.delivery'||u.hostname.endsWith('.replicate.delivery')))throw invalid();
  const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!r.ok||!r.body||Number(r.headers.get('content-length'))>50*1024*1024)throw invalid();
  let size=0;const chunks=[];
  for await(const c of r.body){size+=c.length;if(size>50*1024*1024)throw invalid();chunks.push(c);}
  return Buffer.concat(chunks);
}
