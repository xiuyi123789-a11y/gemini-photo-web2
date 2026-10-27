import sharp from 'sharp';
import {createLocalVision} from './replication-vision.js';
import {sha256} from './replication-assets.js';
const failure=(reason,extra={})=>({buffer:null,quality:{status:'failed',reasons:[reason],identityVerified:false,...extra}});
const rgba=bytes=>sharp(bytes,{limitInputPixels:32*1024*1024}).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
async function mask64(value,width,height){
  if(typeof value!=='string'||value.length>12*1024*1024)throw new Error('SEGMENTATION_INVALID');
  const {data,info}=await sharp(Buffer.from(value,'base64'),{limitInputPixels:32*1024*1024}).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
  if(info.width!==width||info.height!==height)throw new Error('SEGMENTATION_INVALID');
  return Buffer.from(data.map(v=>v>127?255:0));
}
const png=(mask,width,height)=>sharp(mask,{raw:{width,height,channels:1}}).png().toBuffer();
export async function adaptiveComposite(source,generated,{selectionMask,explicitOcclusion,selectedInstances,subjects,hints},vision=createLocalVision()){
  const original=await rgba(source),{width,height}=original.info,n=width*height;
  let evidence;
  try{evidence=await vision({source:source.toString('base64'),generated:generated.toString('base64'),selectionMask:(await png(selectionMask,width,height)).toString('base64'),selectedInstances,subjects,hints:hints||[]});}
  catch(e){return failure(['SEGMENTATION_UNAVAILABLE','SEGMENTATION_TIMEOUT','SEGMENTATION_BUSY','ALIGNMENT_UNRELIABLE','CONTOUR_UNCERTAIN','OCCLUSION_UNCERTAIN'].includes(e.code)?e.code:'SEGMENTATION_FAILED');}
  const alignment=evidence.alignment;
  if(!alignment?.verified||!['inliers','coverage','error','shift','scaleError','rotation'].every(k=>Number.isFinite(alignment[k]))||alignment.inliers<16||alignment.coverage<3||alignment.error>2||Math.abs(alignment.shift)>.025||Math.abs(alignment.scaleError)>.015||Math.abs(alignment.rotation)>1)return failure('ALIGNMENT_UNRELIABLE',{alignment});
  try{
    const aligned=await rgba(Buffer.from(evidence.alignedImage,'base64'));
    if(aligned.info.width!==width||aligned.info.height!==height)return failure('ALIGNMENT_UNRELIABLE');
    const occlusionMask=await mask64(evidence.occlusionMask,width,height),protectedMask=await mask64(evidence.protectedMask,width,height);
    if(explicitOcclusion)for(let i=0;i<n;i++)if(explicitOcclusion[i])occlusionMask[i]=255;
    const sourceObjectMask=Buffer.alloc(n),generatedObjectMask=Buffer.alloc(n),shadowMask=evidence.shadowMask?await mask64(evidence.shadowMask,width,height):Buffer.alloc(n);
    const instances=[];
    if(!Array.isArray(evidence.instances)||evidence.instances.length!==selectedInstances.length||new Set(evidence.instances.map(s=>s.instanceId)).size!==selectedInstances.length)throw new Error('SEGMENTATION_INVALID');
    for(const instanceId of selectedInstances){
      const instance=evidence.instances.find(i=>i.instanceId===instanceId);
      if(!instance||!Number.isFinite(instance.confidence)||!Number.isFinite(instance.stability)||instance.confidence<.88||instance.stability<.9||instance.matched!==true||instance.borderTouch!==false)return failure('CONTOUR_UNCERTAIN',{alignment});
      const old=await mask64(instance.sourceObjectMask,width,height),fresh=await mask64(instance.generatedObjectMask,width,height);
      let oldArea=0,newArea=0,selectionHits=0,changed=0,totalDifference=0,overlap=0,oldX=0,oldY=0,newX=0,newY=0;
      for(let i=0;i<n;i++){
        if(old[i]){oldArea++;oldX+=i%width;oldY+=Math.floor(i/width);if(selectionMask[i])selectionHits++;if(sourceObjectMask[i])throw new Error('INSTANCE_AMBIGUOUS');sourceObjectMask[i]=255;}
        if(fresh[i]){newArea++;if(generatedObjectMask[i]||protectedMask[i])throw new Error('INSTANCE_AMBIGUOUS');generatedObjectMask[i]=255;
          newX+=i%width;newY+=Math.floor(i/width);if(old[i])overlap++;
          const d=[0,1,2].reduce((s,c)=>s+Math.abs(original.data[i*4+c]-aligned.data[i*4+c]),0)/3;totalDifference+=d;if(d>8)changed++;}
      }
      if(oldArea<8||newArea<8||!selectionHits||newArea/oldArea<.2||newArea/oldArea>5)throw new Error('CONTOUR_UNCERTAIN');
      const subject=subjects.find(s=>s.instance_id===instanceId);
      if(subject?.bbox&&oldArea/(subject.bbox[2]*subject.bbox[3]*n)<.12)throw new Error('CONTOUR_UNCERTAIN');
      if(overlap/Math.min(oldArea,newArea)<.2||Math.hypot(oldX/oldArea-newX/newArea,oldY/oldArea-newY/newArea)>Math.sqrt(oldArea)*.65)throw new Error('INSTANCE_AMBIGUOUS');
      if(changed/newArea<.02)return failure('SELECTED_INSTANCE_UNCHANGED',{alignment});
      instances.push({instanceId,oldArea,newArea,meanDifference:totalDifference/newArea,changedFraction:changed/newArea,confidence:instance.confidence,stability:instance.stability});
    }
    // Preserve diagnosed contours even if the foreground or restoration needs correction.
    const compositeMask=Buffer.alloc(n),restoration=Buffer.alloc(n);let restoredPixels=0,residualPixels=0;
    for(let i=0;i<n;i++){
      if(protectedMask[i]&&sourceObjectMask[i])throw new Error('INSTANCE_AMBIGUOUS');
      if(sourceObjectMask[i]&&!generatedObjectMask[i]&&!occlusionMask[i]){restoration[i]=255;restoredPixels++;
        if([0,1,2].reduce((s,c)=>s+Math.abs(original.data[i*4+c]-aligned.data[i*4+c]),0)/3<3)residualPixels++;}
      if((sourceObjectMask[i]||generatedObjectMask[i]||shadowMask[i])&&!occlusionMask[i]&&!protectedMask[i])compositeMask[i]=255;
    }
    const masks={selectionMask,sourceObjectMask,generatedObjectMask,occlusionMask,compositeMask};
    const maskBuffers=Object.fromEntries(await Promise.all(Object.entries(masks).map(async([k,v])=>[k,await png(v,width,height)])));
    const failWithMasks=reason=>({...failure(reason,{alignment,instances}),maskBuffers});
    if(!evidence.occlusionResolved)return failWithMasks('OCCLUSION_UNCERTAIN');
    if(restoredPixels&&evidence.restorationVerified!==true)return failWithMasks('BACKGROUND_RESTORATION_UNCERTAIN');
    if(restoredPixels&&residualPixels/restoredPixels>.2)return failWithMasks('OLD_PRODUCT_RESIDUE');
    // The entire new object is copied at alpha=1. No inward blur can eat a sole or logo.
    // Only the 1px seam OUTSIDE both segmented objects is blended, and only on matching background.
    const out=Buffer.from(original.data),seam=Buffer.alloc(n);let outsidePixels=0;
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
      const i=y*width+x;if(compositeMask[i]||protectedMask[i]||occlusionMask[i])continue;
      if([i-1,i+1,i-width,i+width].some(j=>compositeMask[j]===255)){
        const diff=[0,1,2].reduce((s,c)=>s+Math.abs(original.data[i*4+c]-aligned.data[i*4+c]),0)/3;
        if(diff<10){seam[i]=1;compositeMask[i]=128;}
      }
    }
    for(let i=0;i<n;i++){
      if(!compositeMask[i]){outsidePixels++;continue;}
      const alpha=seam[i]?.5:1;for(let c=0;c<4;c++)out[i*4+c]=Math.round(original.data[i*4+c]*(1-alpha)+aligned.data[i*4+c]*alpha);
    }
    maskBuffers.compositeMask=await png(compositeMask,width,height);
    return {buffer:await sharp(out,{raw:{width,height,channels:4}}).png().toBuffer(),maskBuffers,quality:{status:'needs_review',reasons:['HUMAN_PRODUCT_IDENTITY_REVIEW_REQUIRED'],
      mechanism:'adaptive-v1',alignment,instances,restoredPixels,outsidePixels,maskChecksum:sha256(maskBuffers.compositeMask),outsidePixelsPreserved:true,protectedPixelsPreserved:true,identityVerified:false,semanticTargetCountVerified:false}};
  }catch(e){return failure(['INSTANCE_AMBIGUOUS','CONTOUR_UNCERTAIN'].includes(e.message)?e.message:'SEGMENTATION_INVALID',{alignment});}
}
