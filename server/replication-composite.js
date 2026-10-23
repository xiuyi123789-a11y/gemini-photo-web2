import sharp from 'sharp';

// Work at the original dimensions. Every pixel outside the selected region is copied
// from the decoded, orientation-corrected original, never from the generated scene.
export async function compositeReplicationImage(sourceDataUrl, generated, region) {
  const source = Buffer.from(sourceDataUrl.slice(sourceDataUrl.indexOf(',') + 1), 'base64');
  const { data: original, info } = await sharp(source, { limitInputPixels: 32 * 1024 * 1024 }).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const generatedPixels = await sharp(generated, { limitInputPixels: 32 * 1024 * 1024 }).rotate().resize(info.width,info.height,{fit:'fill'}).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const left=Math.max(0,Math.floor(region.x*info.width)), top=Math.max(0,Math.floor(region.y*info.height));
  const right=Math.min(info.width,Math.ceil((region.x+region.width)*info.width)), bottom=Math.min(info.height,Math.ceil((region.y+region.height)*info.height));
  const feather=Math.max(1,Math.min(10,Math.floor(Math.min(right-left,bottom-top)*.04)));
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
    const blend=Math.min(1,Math.min(x-left,y-top,right-1-x,bottom-1-y)/feather);
    const offset=(y*info.width+x)*4;
    for(let channel=0;channel<4;channel++)original[offset+channel]=Math.round(original[offset+channel]*(1-blend)+generatedPixels[offset+channel]*blend);
  }
  return sharp(original,{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer();
}

export async function preserveReplicationScene(url, input, signal) {
  const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
  if(!response.ok)throw new Error('Unable to fetch model image');
  if(Number(response.headers.get('content-length'))>50*1024*1024)throw new Error('Model image too large');
  const chunks=[];let size=0;
  for await(const chunk of response.body){
    size+=chunk.length;if(size>50*1024*1024)throw new Error('Model image too large');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return compositeReplicationImage(input.sourceImage,Buffer.concat(chunks),input.region);
}
