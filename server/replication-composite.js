import sharp from 'sharp';
import { sha256 } from './replication-assets.js';
import { canonicalJson } from '../shared/replication-contract.js';

async function raster(width,height,polygons) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>`+
    polygons.map(points=>`<polygon fill="white" points="${points.map(p=>`${p.x*width},${p.y*height}`).join(' ')}"/>`).join('')+'</svg>';
  return sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer();
}
export async function prepareMasks(width,height,masks,protectMasks) {
  const edit=await raster(width,height,masks.map(m=>m.points));
  const protect=await raster(width,height,protectMasks);
  const instances=[];
  for(const m of masks){
    const pixels=await raster(width,height,[m.points]);let count=0;
    for(let i=0;i<pixels.length;i++)if(pixels[i]>128&&!protect[i])count++;
    if(count<4)throw Object.assign(new Error('TARGET_SELECTION_REQUIRED'),{code:'TARGET_SELECTION_REQUIRED',status:422});
    instances.push({instanceId:m.instanceId,pixels,count});
  }
  return {edit,protect,instances,checksum:sha256(canonicalJson({width,height,masks,protectMasks}))};
}

// Full-frame, uniform scaling only. No fit:fill; an aspect mismatch is a failed quality gate.
export async function compositeReplicationImage(source,generated,{masks,protectMasks}) {
  const {data:original,info}=await sharp(source,{limitInputPixels:32*1024*1024}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const metadata=await sharp(generated,{limitInputPixels:64*1024*1024}).metadata();
  const ratioError=Math.abs(Math.log((metadata.width/metadata.height)/(info.width/info.height)));
  if(!Number.isFinite(ratioError)||ratioError>.015)return {buffer:null,quality:{status:'failed',reasons:['OUTPUT_ASPECT_MISMATCH'],ratioError}};
  const candidate=await sharp(generated).resize(info.width,info.height,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const {edit,protect,instances,checksum}=await prepareMasks(info.width,info.height,masks,protectMasks);
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
