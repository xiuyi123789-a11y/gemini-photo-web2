// Stored originals stay unchanged. These helpers only select a delivery variant.
function localImage(url:string):URL|null {
  try{
    const origin=typeof location==='undefined'?'http://localhost':location.origin;
    const parsed=new URL(url,origin);
    return parsed.origin===origin&&/^\/api\/(?:images\/|replication\/assets\/)/.test(parsed.pathname)?parsed:null;
  }catch{return null;}
}
const relative=(url:URL)=>url.pathname+url.search;
export function imageMetadataUrl(url:string):string|null {
  const parsed=localImage(url);if(!parsed)return null;
  parsed.searchParams.delete('preview');parsed.searchParams.delete('download');
  parsed.searchParams.set('metadata','1');return relative(parsed);
}
export function imageDisplayUrl(url:string,variant:'thumb'|'canvas'|'display'='display'):string {
  const parsed=localImage(url);if(!parsed)return url;
  parsed.searchParams.set('preview',variant==='thumb'?'1':variant);
  parsed.searchParams.set('pv','2');return relative(parsed);
}
export function imagePreviewProps(url:string,variant:'thumb'|'canvas'|'display'='display'){
  const first=imageDisplayUrl(url,'thumb'),detail=imageDisplayUrl(url,variant);
  return {src:first,decoding:'async' as const,loading:variant==='thumb'?'lazy' as const:'eager' as const,
    onLoad:(event?:{currentTarget:HTMLImageElement})=>{
      const image=event?.currentTarget;
      if(!image||first===detail||image.getAttribute('src')!==first||typeof Image==='undefined')return;
      // Decode detail separately: the already-visible small image stays on
      // screen even if the larger transfer is slow or fails.
      const next=new Image();next.decoding='async';
      next.onload=()=>{if(image.getAttribute('src')===first)image.src=detail;};
      next.src=detail;
    },onError:(event:{currentTarget:HTMLImageElement})=>{
    const image=event.currentTarget;if(image.getAttribute('src')!==url)image.src=url;
  }};
}
export function imageDownloadUrl(url:string,filename:string):string {
  const parsed=localImage(url);if(!parsed)return url;
  for(const key of ['preview','pv','retry','metadata'])parsed.searchParams.delete(key);
  parsed.searchParams.set('download','1');parsed.searchParams.set('filename',filename);
  return relative(parsed);
}
export function startImageDownload(url:string,filename:string):void {
  if(!/^(?:https?:|blob:|data:(?:image|video)\/|\/)/i.test(url))throw new Error('下载地址无效。');
  // Keep the click in the original user gesture. The browser streams the file
  // and shows its download UI without awaiting a large fetch/blob in JavaScript.
  const link=document.createElement('a');link.href=imageDownloadUrl(url,filename);link.download=filename;
  link.style.display='none';document.body.appendChild(link);
  try{link.click();}finally{document.body.removeChild(link);}
}
