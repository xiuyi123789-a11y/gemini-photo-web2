import sharp from 'sharp';
import { sha256 } from './replication-assets.js';
import { canonicalJson } from '../shared/replication-contract.js';
import { brushSvg, matchBrushSubjects, validSubjectBox } from '../shared/replication-brush.js';

async function raster(width,height,polygons) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>`+
    polygons.map(points=>`<polygon fill="white" points="${points.map(p=>`${p.x*width},${p.y*height}`).join(' ')}"/>`).join('')+'</svg>';
  return sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer();
}
export async function prepareMasks(width,height,masks,protectMasks,{brush,subjects=[]}={}) {
  const edit=brush?await sharp(Buffer.from(brushSvg(brush,width,height))).removeAlpha().greyscale().raw().toBuffer():await raster(width,height,masks.map(m=>m.points));
  const protect=await raster(width,height,protectMasks);
  const instances=[];
  if(brush){
    const match=matchBrushSubjects(brush,subjects,width,height);
    if(!match.valid)throw Object.assign(new Error('TARGET_SELECTION_REQUIRED'),{code:'TARGET_SELECTION_REQUIRED',status:422});
    // Protect every unselected recognized object, even an incidental brush edge.
    const selected=subjects.filter(s=>match.selectedInstances.includes(s.instance_id));
    for(const s of subjects.filter(s=>validSubjectBox(s.bbox)&&!match.selectedInstances.includes(s.instance_id))){
      const [x,y,w,h]=s.bbox;for(let py=Math.floor(y*height);py<Math.min(height,Math.ceil((y+h)*height));py++)
        for(let px=Math.floor(x*width);px<Math.min(width,Math.ceil((x+w)*width));px++)protect[py*width+px]=255;
    }
    for(const s of selected){
      const pixels=Buffer.alloc(width*height),[x,y,w,h]=s.bbox;let count=0;
      for(let py=Math.floor(y*height);py<Math.min(height,Math.ceil((y+h)*height));py++)for(let px=Math.floor(x*width);px<Math.min(width,Math.ceil((x+w)*width));px++){
        const i=py*width+px;if(edit[i]>128&&!protect[i]){pixels[i]=255;count++;}
      }
      if(count<4)throw Object.assign(new Error('TARGET_SELECTION_REQUIRED'),{code:'TARGET_SELECTION_REQUIRED',status:422});
      instances.push({instanceId:s.instance_id,pixels,count});
    }
  }
  for(const m of masks){
    const pixels=await raster(width,height,[m.points]);let count=0;
    for(let i=0;i<pixels.length;i++)if(pixels[i]>128&&!protect[i])count++;
    if(count<4)throw Object.assign(new Error('TARGET_SELECTION_REQUIRED'),{code:'TARGET_SELECTION_REQUIRED',status:422});
    instances.push({instanceId:m.instanceId,pixels,count});
  }
  return {edit,protect,instances,checksum:sha256(canonicalJson({width,height,masks,protectMasks,...(brush?{brush,subjects}: {})}))};
}

export async function createRegionGuide(source,input,subjects){
  const {data,info}=await sharp(source).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {edit,protect}=await prepareMasks(info.width,info.height,input.masks,input.protectMasks,{brush:input.brush,subjects});
  const colors=[48,116,255];
  for(let i=0;i<edit.length;i++)if(edit[i]&&!protect[i])for(let c=0;c<3;c++)data[i*4+c]=Math.round(data[i*4+c]*(1-.5*edit[i]/255)+colors[c]*.5*edit[i]/255);
  return sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).resize({width:1536,height:1536,fit:'inside',withoutEnlargement:true}).png().toBuffer();
}

// Full-frame, uniform scaling only. No fit:fill; an aspect mismatch is a failed quality gate.
export async function compositeReplicationImage(source,generated,{masks,protectMasks,brush},subjects=[]) {
  const {data:original,info}=await sharp(source,{limitInputPixels:32*1024*1024}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const metadata=await sharp(generated,{limitInputPixels:64*1024*1024}).metadata();
  const ratioError=Math.abs(Math.log((metadata.width/metadata.height)/(info.width/info.height)));
  if(!Number.isFinite(ratioError)||ratioError>.015)return {buffer:null,quality:{status:'failed',reasons:['OUTPUT_ASPECT_MISMATCH'],ratioError}};
  const candidate=await sharp(generated).resize(info.width,info.height,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const {edit,protect,instances,checksum}=await prepareMasks(info.width,info.height,masks,protectMasks,{brush,subjects});
  const feather=await sharp(edit,{raw:{width:info.width,height:info.height,channels:1}}).blur(1).greyscale().raw().toBuffer();
  const out=Buffer.from(original);let outsideCount=0,outsideDiff=0;
  const changes=instances.map(m=>{let sum=0,changed=0;
    for(let i=0;i<m.pixels.length;i++)if(m.pixels[i]>128&&!protect[i]){const o=i*4;const diff=(Math.abs(original[o]-candidate[o])+Math.abs(original[o+1]-candidate[o+1])+Math.abs(original[o+2]-candidate[o+2]))/3;sum+=diff;if(diff>8)changed++;}
    return {instanceId:m.instanceId,meanDifference:sum/m.count,changedFraction:changed/m.count};
  });
  for(let i=0;i<edit.length;i++){
    const o=i*4;
    if(!edit[i]){outsideCount++;outsideDiff+=(Math.abs(original[o]-candidate[o])+Math.abs(original[o+1]-candidate[o+1])+Math.abs(original[o+2]-candidate[o+2]))/(3*255);}
    if(!edit[i]||protect[i])continue;
    const alpha=(edit[i]/255)*(feather[i]/255);
    for(let c=0;c<4;c++)out[o+c]=Math.round(original[o+c]*(1-alpha)+candidate[o+c]*alpha);
  }
  const reasons=[];
  if(changes.some(c=>c.meanDifference<2||c.changedFraction<.02))reasons.push('SELECTED_INSTANCE_UNCHANGED');
  const layoutDrift=outsideCount?outsideDiff/outsideCount:null;
  if(layoutDrift!==null&&layoutDrift>.12)reasons.push('POSSIBLE_LAYOUT_DRIFT');
  const quality={status:reasons.includes('SELECTED_INSTANCE_UNCHANGED')?'failed':'needs_review',reasons:[...reasons,'HUMAN_PRODUCT_IDENTITY_REVIEW_REQUIRED'],
    instances:changes,layoutDrift,maskChecksum:checksum,protectedPixelsPreserved:true,outsidePixelsPreserved:true,
    semanticTargetCountVerified:false,identityVerified:false};
  return {buffer:await sharp(out,{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer(),quality};
}
