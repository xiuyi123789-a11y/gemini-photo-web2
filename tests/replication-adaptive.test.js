import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {adaptiveComposite} from '../server/replication-adaptive.js';
const width=96,height=64,n=width*height;
const box=(x,y,w,h)=>{const mask=Buffer.alloc(n);for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)mask[j*width+i]=255;return mask;};
const union=(...items)=>Buffer.from(Array.from({length:n},(_,i)=>items.some(m=>m[i])?255:0));
const png=mask=>sharp(mask,{raw:{width,height,channels:1}}).png().toBuffer();
const image=async(objects=[],bg=[50,55,60],foreground=null)=>{
  const pixels=Buffer.alloc(n*4);for(let i=0;i<n;i++){for(let c=0;c<3;c++)pixels[i*4+c]=bg[c]+(i%7);pixels[i*4+3]=255;}
  for(const [mask,color] of objects)for(let i=0;i<n;i++)if(mask[i])for(let c=0;c<3;c++)pixels[i*4+c]=color[c];
  if(foreground)for(let i=0;i<n;i++)if(foreground[i])pixels.set([240,241,242,255],i*4);
  return sharp(pixels,{raw:{width,height,channels:4}}).png().toBuffer();
};
async function scenario({old=[box(12,24,23,16)],fresh=[box(9,22,34,21)],selected=[0],occlusion=Buffer.alloc(n),selection=box(20,30,3,3),bg,patch={},unchanged=false,keepOld=false}={}){
  const source=await image(old.map(m=>[m,[185,70,50]]),undefined,occlusion),generated=unchanged?source:await image([...(keepOld?old.map(m=>[m,[185,70,50]]):[]),...fresh.map(m=>[m,[20,125,205]])],bg,occlusion);
  const b64=async m=>(await png(m)).toString('base64');
  const evidence={alignment:{verified:true,inliers:50,coverage:4,error:.1,shift:0,scaleError:0,rotation:0},alignedImage:generated.toString('base64'),
    occlusionMask:await b64(occlusion),protectedMask:await b64(union(...old.filter((_,i)=>!selected.includes(i)))),occlusionResolved:true,restorationVerified:true,
    instances:await Promise.all(selected.map(async i=>({instanceId:'object-'+i,sourceObjectMask:await b64(old[i]),generatedObjectMask:await b64(fresh[i]),confidence:.99,stability:.99,matched:true,borderTouch:false}))),...patch};
  const result=await adaptiveComposite(source,generated,{selectionMask:selection,selectedInstances:selected.map(i=>'object-'+i),subjects:[]},async()=>evidence);
  return {result,source,generated,old,fresh,occlusion,selection};
}
const pixels=bytes=>sharp(bytes).ensureAlpha().raw().toBuffer();
async function checkComplete(s){
  assert(s.result.buffer);assert.equal(s.result.quality.status,'needs_review');assert.equal(s.result.quality.identityVerified,false);
  const out=await pixels(s.result.buffer),raw=await pixels(s.generated),before=await pixels(s.source),mask=await sharp(s.result.maskBuffers.compositeMask).greyscale().raw().toBuffer();
  for(let i=0;i<n;i++){
    if(s.fresh[0][i]&&!s.occlusion[i])assert.deepEqual(out.subarray(i*4,i*4+4),raw.subarray(i*4,i*4+4),'whole new object, no inward feather');
    if(!mask[i]||s.occlusion[i])assert.deepEqual(out.subarray(i*4,i*4+4),before.subarray(i*4,i*4+4),'protected/outside exact');
  }
}
test('adaptive: wider and thicker sole extends outside selection; all product pixels survive',async()=>{await checkComplete(await scenario());});
test('adaptive: smaller product replaces the whole old object with new product and restored background',async()=>{
  const s=await scenario({old:[box(12,24,29,20)],fresh:[box(20,28,14,10)]});await checkComplete(s);
  const out=await pixels(s.result.buffer),raw=await pixels(s.generated);for(let i=0;i<n;i++)if(s.old[0][i]&&!s.fresh[0][i])assert.deepEqual(out.subarray(i*4,i*4+4),raw.subarray(i*4,i*4+4));
});
test('adaptive: two selected shoes retain separate complete instance masks',async()=>{
  const s=await scenario({old:[box(12,24,20,12),box(58,25,20,12)],fresh:[box(8,22,29,17),box(54,23,28,17)],selected:[0,1],selection:union(box(18,28,2,2),box(64,29,2,2))});
  await checkComplete(s);assert.equal(s.result.quality.instances.length,2);
  const out=await pixels(s.result.buffer),raw=await pixels(s.generated);for(let i=0;i<n;i++)if(s.fresh[1][i])assert.deepEqual(out.subarray(i*4,i*4+4),raw.subarray(i*4,i*4+4));
});
test('adaptive: only one selected shoe changes, the unselected shoe uses source pixels',async()=>{
  const s=await scenario({old:[box(12,24,20,12),box(58,25,20,12)],fresh:[box(8,22,29,17),box(54,23,28,17)]});await checkComplete(s);
  const out=await pixels(s.result.buffer),before=await pixels(s.source);for(let i=0;i<n;i++)if(s.old[1][i])assert.deepEqual(out.subarray(i*4,i*4+4),before.subarray(i*4,i*4+4));
});
test('adaptive: socks and trouser occlusion remain original without eroding the visible sole',async()=>{await checkComplete(await scenario({occlusion:box(23,20,10,8)}));});
test('adaptive: coarse selection does not limit the new toe or heel, mask roles remain distinct',async()=>{
  const s=await scenario();await checkComplete(s);assert.equal(Object.keys(s.result.maskBuffers).length,5);
  assert(!(await png(s.selection)).equals(s.result.maskBuffers.compositeMask));
});
test('adaptive: generated background changes are removed outside actual product contours',async()=>{await checkComplete(await scenario({bg:[90,100,110]}));});
test('adaptive: unreliable alignment or large translation produces no composite',async()=>{
  for(const alignment of [{verified:false},{verified:true,inliers:50,coverage:4,error:.2,shift:.1,scaleError:0,rotation:0}]){const {result}=await scenario({patch:{alignment}});assert.equal(result.buffer,null);assert.deepEqual(result.quality.reasons,['ALIGNMENT_UNRELIABLE']);}
});
test('adaptive: failed segmentation and unknown occlusion never produce a pseudo-success',async()=>{
  const low=await scenario();const instances=[{instanceId:'object-0',confidence:.4}];
  assert.equal((await scenario({patch:{instances}})).result.buffer,null);
  const occluded=(await scenario({patch:{occlusionResolved:false}})).result;assert.equal(occluded.buffer,null);assert(occluded.maskBuffers);assert.deepEqual(occluded.quality.reasons,['OCCLUSION_UNCERTAIN']);
  assert.equal(low.result.quality.status,'needs_review');assert.equal(low.result.quality.identityVerified,false,'even correct contours cannot certify the generated product');
});
test('adaptive: product errors are never auto-approved; unchanged generation is rejected',async()=>{
  const s=await scenario();assert.equal(s.result.quality.status,'needs_review');assert(s.result.quality.reasons.includes('HUMAN_PRODUCT_IDENTITY_REVIEW_REQUIRED'));
  assert.deepEqual((await scenario({unchanged:true})).result.quality.reasons,['SELECTED_INSTANCE_UNCHANGED']);
});
test('adaptive: blending preserves every new sole, toe and internal design pixel exactly',async()=>{await checkComplete(await scenario({fresh:[box(5,18,43,28)]}));});
test('adaptive: uncertain restoration and visible old residue block smaller-product composition',async()=>{
  const s=await scenario({fresh:[box(20,28,14,10)],patch:{restorationVerified:false}});assert.equal(s.result.buffer,null);assert.deepEqual(s.result.quality.reasons,['BACKGROUND_RESTORATION_UNCERTAIN']);
  const residue=await scenario({fresh:[box(20,28,14,10)],keepOld:true});assert.equal(residue.result.buffer,null);assert.deepEqual(residue.result.quality.reasons,['OLD_PRODUCT_RESIDUE']);
});
test('adaptive: missing CPU segmenter fails closed without legacy brush clipping',async()=>{
  const s=await scenario();const result=await adaptiveComposite(s.source,s.generated,{selectionMask:s.selection,selectedInstances:['object-0'],subjects:[]},async()=>{throw Object.assign(new Error('disabled'),{code:'SEGMENTATION_UNAVAILABLE'});});
  assert.equal(result.buffer,null);assert.deepEqual(result.quality.reasons,['SEGMENTATION_UNAVAILABLE']);
});
