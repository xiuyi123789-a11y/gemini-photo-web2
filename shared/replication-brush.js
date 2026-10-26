// Brush coordinates are normalized to the orientation-corrected source image.
export const BRUSH_LIMITS=Object.freeze({strokes:300,points:6000,minSize:.002,maxSize:.25});
export const validSubjectBox=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]>0&&b[3]>0&&b[0]+b[2]<=1.000001&&b[1]+b[3]<=1.000001;
export function validBrush(brush){
  return brush?.version===1&&Array.isArray(brush.strokes)&&brush.strokes.length>0&&brush.strokes.length<=BRUSH_LIMITS.strokes&&
    brush.strokes.reduce((n,s)=>n+(Array.isArray(s?.points)?s.points.length:BRUSH_LIMITS.points+1),0)<=BRUSH_LIMITS.points&&
    brush.strokes.every(s=>s&&['paint','erase'].includes(s.tool)&&Number.isFinite(s.size)&&s.size>=BRUSH_LIMITS.minSize&&s.size<=BRUSH_LIMITS.maxSize&&
      Array.isArray(s.points)&&s.points.length>0&&s.points.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1));
}
export function brushMarkup(brush,width,height){
  return brush.strokes.map(s=>{
    const color=s.tool==='erase'?'black':'white',radius=s.size*Math.min(width,height)/2;
    if(s.points.length===1)return `<circle cx="${s.points[0].x*width}" cy="${s.points[0].y*height}" r="${radius}" fill="${color}"/>`;
    return `<polyline points="${s.points.map(p=>`${p.x*width},${p.y*height}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${radius*2}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
}
export const brushSvg=(brush,width,height)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>${brushMarkup(brush,width,height)}</svg>`;

// Small deterministic raster used by both browser and server for subject matching.
// The final edit mask is rasterized at full resolution by sharp, never this grid.
export function matchBrushSubjects(brush,subjects,sourceWidth,sourceHeight){
  const scale=192/Math.max(sourceWidth,sourceHeight),width=Math.max(1,Math.round(sourceWidth*scale)),height=Math.max(1,Math.round(sourceHeight*scale));
  const pixels=new Uint8Array(width*height),unit=Math.min(width,height);
  for(const s of brush.strokes){
    const r=s.size*unit/2,value=s.tool==='erase'?0:1;
    for(let n=0;n<s.points.length;n++){
      const a=s.points[Math.max(0,n-1)],b=s.points[n],ax=a.x*width,ay=a.y*height,bx=b.x*width,by=b.y*height,dx=bx-ax,dy=by-ay,len=dx*dx+dy*dy;
      for(let y=Math.max(0,Math.floor(Math.min(ay,by)-r));y<Math.min(height,Math.ceil(Math.max(ay,by)+r));y++)
        for(let x=Math.max(0,Math.floor(Math.min(ax,bx)-r));x<Math.min(width,Math.ceil(Math.max(ax,bx)+r));x++){
          const t=len?Math.max(0,Math.min(1,((x+.5-ax)*dx+(y+.5-ay)*dy)/len)):0;
          if((x+.5-ax-t*dx)**2+(y+.5-ay-t*dy)**2<=r*r)pixels[y*width+x]=value;
        }
    }
  }
  const located=subjects.filter(s=>validSubjectBox(s.bbox)),hits=new Map(located.map(s=>[s.instance_id,0]));let painted=0,outside=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[y*width+x]){
    painted++;const nx=(x+.5)/width,ny=(y+.5)/height;
    const candidates=located.filter(s=>nx>=s.bbox[0]&&ny>=s.bbox[1]&&nx<=s.bbox[0]+s.bbox[2]&&ny<=s.bbox[1]+s.bbox[3]);
    if(!candidates.length){outside++;continue;}
    candidates.sort((a,b)=>{const d=s=>((nx-s.bbox[0])/s.bbox[2]-.5)**2+((ny-s.bbox[1])/s.bbox[3]-.5)**2;return d(a)-d(b);});
    hits.set(candidates[0].instance_id,hits.get(candidates[0].instance_id)+1);
  }
  const selectedInstances=located.filter(s=>hits.get(s.instance_id)>=Math.max(2,Math.ceil(s.bbox[2]*s.bbox[3]*width*height*.003))).map(s=>s.instance_id);
  return {selectedInstances,painted,outsideFraction:painted?outside/painted:0,locatedCount:located.length,
    valid:painted>0&&selectedInstances.length>0&&outside/painted<=.65};
}
