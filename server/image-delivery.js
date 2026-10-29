import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';

const sha=value=>createHash('sha256').update(value).digest('hex');
const variants={'1':{edge:384,quality:75},display:{edge:1024,quality:85},canvas:{edge:1600,quality:85}};
export function createImageDelivery(dataDir,{render=async(file,options)=>sharp(file,{limitInputPixels:64*1024*1024})
  .resize({width:options.edge,height:options.edge,fit:'inside',withoutEnlargement:true}).webp({quality:options.quality}).toBuffer()}={}){
  const previews=new Map();let active=0;const waiting=[];
  async function convert(action){
    if(active<2)active++;else await new Promise(resolve=>waiting.push(resolve));
    try{return await action();}finally{const next=waiting.shift();if(next)next();else active--;}
  }
  async function preview(file,owner,identity,variant){
    if(!/^[a-zA-Z0-9-]+$/.test(owner))throw new Error('INVALID_IMAGE_OWNER');
    if(!Object.hasOwn(variants,variant))throw new Error('INVALID_PREVIEW_VARIANT');
    const options=variants[variant],key=sha(identity+':'+variant+':webp-v2');
    const target=path.join(path.resolve(dataDir),owner,'previews',key+'.webp');
    if(!previews.has(target)){
      const pending=(async()=>{
        try{if((await fs.stat(target)).size>0)return target;}catch(e){if(e.code!=='ENOENT')throw e;}
        return convert(async()=>{
          const bytes=await render(file,options);await fs.mkdir(path.dirname(target),{recursive:true});
          const temp=target+'.'+randomUUID()+'.tmp';
          try{await fs.writeFile(temp,bytes,{mode:0o600});await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
          return target;
        });
      })().catch(e=>{previews.delete(target);throw e;});
      previews.set(target,pending);if(previews.size>256)previews.delete(previews.keys().next().value);
    }
    return previews.get(target);
  }
  return {preview,async serve(req,res,{file,owner,identity,versioned=false,downloadName}){
    const start=performance.now(),download=req.query.download==='1',variant=!download&&typeof req.query.preview==='string'&&Object.hasOwn(variants,req.query.preview)?req.query.preview:null;
    const target=variant?await preview(file,owner,identity,variant):file;
    const etag='"'+sha(identity+(variant?':'+variant+':webp-v2':':original'))+'"';
    // Caller authenticates and checks ownership first. Cookie/identity variants
    // prevent a fresh private response from being reused by a different account.
    res.vary('Cookie');res.vary('x-user-id');
    res.set('Cache-Control',download||req.query.retry?'private, no-store':versioned?'private, max-age=3600, immutable':'private, max-age=0, must-revalidate');
    res.set('ETag',etag);
    if(download){
      // Download is an explicit request for bytes, including after a preview was
      // cached. Keep Range/If-Range for resumable transfers, discard validators
      // which could otherwise turn an attachment into an empty 304 response.
      delete req.headers['if-none-match'];delete req.headers['if-modified-since'];
      const requested=typeof req.query.filename==='string'?req.query.filename:'';
      const name=requested.length>0&&requested.length<=180&&!/[\x00-\x1f\x7f/\\]/.test(requested)?requested:downloadName;
      res.attachment(name);
    }
    if(!download&&req.get('If-None-Match')?.split(',').map(v=>v.trim().replace(/^W\//,'')).some(v=>v===etag||v==='*')){res.status(304).end();return;}
    res.set('Server-Timing',`image;dur=${(performance.now()-start).toFixed(1)}`);
    await new Promise((resolve,reject)=>res.sendFile(target,{cacheControl:false,lastModified:false,etag:!download,dotfiles:'allow'},e=>{
      if(e&&!res.headersSent&&e.code!=='ECONNABORTED')reject(e);else resolve();
    }));
  }};
}
