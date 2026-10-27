// Ground-truth segmentation for HTTP/worker tests. Not production recognition.
import sharp from 'sharp';
export async function fixtureVision(request){
  const source=Buffer.from(request.source,'base64'),generated=Buffer.from(request.generated,'base64');
  const {width,height}=await sharp(source).metadata(),meta=await sharp(generated).metadata();
  if(Math.abs(Math.log((meta.width/meta.height)/(width/height)))>.015)return {alignment:{verified:false}};
  const raster=async boxes=>(await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>${boxes.map(b=>`<rect x="${Math.floor(b[0]*width)}" y="${Math.floor(b[1]*height)}" width="${Math.ceil(b[2]*width)}" height="${Math.ceil(b[3]*height)}" fill="white"/>`).join('')}</svg>`)).greyscale().png().toBuffer()).toString('base64');
  const selected=request.subjects.filter(s=>request.selectedInstances.includes(s.instance_id));
  return {alignment:{verified:true,inliers:30,coverage:4,error:.1,shift:0,scaleError:0,rotation:0},alignedImage:(await sharp(generated).resize(width,height).png().toBuffer()).toString('base64'),
    occlusionResolved:true,restorationVerified:true,occlusionMask:await raster([]),protectedMask:await raster(request.subjects.filter(s=>!request.selectedInstances.includes(s.instance_id)).map(s=>s.bbox)),
    instances:await Promise.all(selected.map(async s=>({instanceId:s.instance_id,sourceObjectMask:await raster([s.bbox]),generatedObjectMask:await raster([s.bbox]),confidence:.99,stability:.99,matched:true,borderTouch:false})))};
}
