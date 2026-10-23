import { canonicalJson, materialIdentity, MAX_REFERENCES } from '../shared/replication-contract.js';
import { decodeImage, sha256 } from './replication-assets.js';
export const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const text=(v,max,empty=true)=>{if(typeof v!=='string'||v.length>max||(!empty&&!v.trim()))throw fail('INPUT_INVALID');return v.trim();};
const only=(body,keys)=>{if(!body||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))throw fail('INPUT_INVALID');};
export function validateAnalysisInput(body,{maxReferences=MAX_REFERENCES}={}) {
  only(body,['requestId','inputFingerprint','sourceImage','references','target']);
  if(!UUID.test(body.requestId||'')||!HASH.test(body.inputFingerprint||''))throw fail('INPUT_INVALID');
  const source=decodeImage(body.sourceImage);let size=source.length;
  if(!Array.isArray(body.references)||!body.references.length||body.references.length>maxReferences)throw fail('INPUT_INVALID');
  const references=body.references.map(ref=>{
    if(!ref||!['front','side','back','detail','other'].includes(ref.angle))throw fail('INPUT_INVALID');
    const bytes=decodeImage(ref.image);size+=bytes.length;return {hash:sha256(bytes),angle:ref.angle};
  });
  if(size>32*1024*1024)throw fail('INPUT_INVALID');
  const target=text(body.target??'',500),sourceHash=sha256(source);
  const inputFingerprint=sha256(canonicalJson(materialIdentity(sourceHash,references,target)));
  if(inputFingerprint!==body.inputFingerprint)throw fail('INPUT_FINGERPRINT_MISMATCH',409);
  return {...body,target,sourceHash,referenceHashes:references,inputFingerprint};
}
function polygon(p) {
  if(!Array.isArray(p)||p.length<3||p.length>200||p.some(v=>!v||!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<0||v.y<0||v.x>1||v.y>1))throw fail('TARGET_SELECTION_REQUIRED',422);
  const points=p.map(v=>({x:Math.round(v.x*1e6)/1e6,y:Math.round(v.y*1e6)/1e6}));
  let area=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];area+=a.x*b.y-b.x*a.y;}
  if(Math.abs(area)/2<.0001||Math.abs(area)/2>.8)throw fail('TARGET_SELECTION_REQUIRED',422);
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for(let i=0;i<points.length;i++)for(let j=i+2;j<points.length;j++){
    if(i===0&&j===points.length-1)continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)throw fail('TARGET_SELECTION_REQUIRED',422);
  }
  return points;
}
export function validateGenerationInput(body,{advancedOutputs=false}={}) {
  only(body,['requestId','inputFingerprint','analysisJobId','analysisRevisionHash','selectedInstances','masks','protectMasks','maskSpace','resolution','count','preserve','notes','confirmedPredictions']);
  if(!UUID.test(body.requestId||'')||!HASH.test(body.inputFingerprint||''))throw fail('INPUT_INVALID');
  if(!UUID.test(body.analysisJobId||'')||!HASH.test(body.analysisRevisionHash||''))throw fail('ANALYSIS_REQUIRED',409);
  const selected=body.selectedInstances;
  if(!Array.isArray(selected)||!selected.length||selected.length>12||new Set(selected).size!==selected.length||!selected.every(s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(s)))throw fail('TARGET_SELECTION_REQUIRED',422);
  if(!Array.isArray(body.masks)||body.masks.length!==selected.length||new Set(body.masks.map(m=>m?.instanceId)).size!==selected.length)throw fail('TARGET_SELECTION_REQUIRED',422);
  const masks=body.masks.map(m=>{if(!m||!selected.includes(m.instanceId))throw fail('TARGET_SELECTION_REQUIRED',422);return {instanceId:m.instanceId,points:polygon(m.points)};});
  if(!Array.isArray(body.protectMasks)||body.protectMasks.length>20)throw fail('TARGET_SELECTION_REQUIRED',422);
  const protectMasks=body.protectMasks.map(polygon);
  const s=body.maskSpace;
  if(!s||!Number.isInteger(s.width)||!Number.isInteger(s.height)||!HASH.test(s.sourceHash||''))throw fail('TARGET_SELECTION_REQUIRED',422);
  const count=body.count??1,resolution=body.resolution??'2K';
  if(![1,2,4].includes(count)||!['1K','2K','4K'].includes(resolution)||(!advancedOutputs&&(count!==1||resolution==='4K')))throw fail('OUTPUT_OPTION_DISABLED',422);
  if(body.confirmedPredictions!==count)throw fail('COST_CONFIRMATION_REQUIRED',422);
  if(!Array.isArray(body.preserve)||body.preserve.length>4||body.preserve.some(p=>!['background','composition','lighting','perspective'].includes(p)))throw fail('INPUT_INVALID');
  return {...body,selectedInstances:[...selected],masks,protectMasks,maskSpace:{width:s.width,height:s.height,sourceHash:s.sourceHash},count,resolution,
    preserve:[...new Set(body.preserve)],notes:text(body.notes??'',4000)};
}
export const payloadHash=input=>sha256(canonicalJson(Object.fromEntries(Object.entries(input).filter(([k])=>!['requestId','sourceImage','references'].includes(k)))));
