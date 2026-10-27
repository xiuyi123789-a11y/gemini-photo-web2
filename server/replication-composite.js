import sharp from 'sharp';
import { sha256 } from './replication-assets.js';
import { canonicalJson } from '../shared/replication-contract.js';
import { brushSvg, matchBrushSubjects, validSubjectBox } from '../shared/replication-brush.js';
import { adaptiveComposite } from './replication-adaptive.js';

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

// The legacy edit/protect rasters are selection and explicit foreground hints only.
// No fallback is allowed to use them as the final product cutout.
export async function compositeReplicationImage(source,generated,input,subjects=[],{vision}={}) {
  const {width,height}=await sharp(source).metadata();
  const {edit:selectionMask}=await prepareMasks(width,height,input.masks,input.protectMasks,{brush:input.brush,subjects});
  const {protect:explicitOcclusion}=await prepareMasks(width,height,[],input.protectMasks);
  return adaptiveComposite(source,generated,{selectionMask,explicitOcclusion,selectedInstances:input.selectedInstances||input.masks.map(m=>m.instanceId),subjects,hints:input.contourHints},vision);
}
