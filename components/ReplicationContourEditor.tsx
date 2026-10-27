import React,{useState} from 'react';
import type {ContourHint,ReplicationJob,JobResult} from '../services/replicationService';
export function ReplicationContourEditor({job,result,busy,onRecompose,hints,onHintsChange,open,onOpenChange}:{key?:string;job:ReplicationJob;result:JobResult;busy:boolean;onRecompose:(hints:ContourHint[])=>Promise<void>;hints:ContourHint[];onHintsChange:(hints:ContourHint[])=>void;open:boolean;onOpenChange:(open:boolean)=>void}){
  const selected=job.input?.selectedInstances||[];
  const [instanceId,setInstance]=useState(selected[0]),[kind,setKind]=useState<ContourHint['kind']>('foreground');
  const subjects=(job.approvedAnalysis as any)?.subjects||[];
  const add=(image:ContourHint['image'],e:React.MouseEvent<HTMLImageElement>)=>{
    if(busy||hints.length>=64||(kind==='occlusion'&&image!=='source'))return;
    const rect=e.currentTarget.getBoundingClientRect();onHintsChange([...hints,{image,kind,instanceId,x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height}]);
  };
  return <details id="replication-contour-editor" className="rp-advanced" open={open} onToggle={e=>onOpenChange(e.currentTarget.open)}><summary>修正轮廓并重新合成（本地处理，不重新生图）</summary>
    <p>在产品内部点一下可提示前景；点到误识别区域可提示背景。袜子、手、裤脚等遮挡物，请在原图上点选“保护遮挡物”。无需描绘新产品的最终尺寸。</p>
    <div className="rp-mask-tools"><select aria-label="修正的产品实例" value={instanceId} disabled={busy} onChange={e=>setInstance(e.target.value)}>{selected.map(id=><option key={id} value={id}>{subjects.find((s:any)=>s.instance_id===id)?.location||id}</option>)}</select>
      <select aria-label="轮廓提示类型" value={kind} disabled={busy} onChange={e=>setKind(e.target.value as ContourHint['kind'])}><option value="foreground">产品内部</option><option value="background">排除背景</option><option value="occlusion">保护遮挡物（原图）</option></select>
      <button disabled={busy||!hints.length} className="rp-button" onClick={()=>onHintsChange(hints.slice(0,-1))}>撤销修正点</button></div>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>{([['source',job.source.url,'场景原图'],['generated',result.raw.url,'模型原始结果']] as const).map(([image,url,label])=><div key={image}><b>{label}</b><div style={{position:'relative',lineHeight:0}}><img src={url} alt={label+'轮廓修正'} style={{width:'100%',cursor:'crosshair'}} onClick={e=>add(image,e)}/>{hints.filter(p=>p.image===image).map((p,i)=><span key={i} title={p.kind} style={{position:'absolute',left:p.x*100+'%',top:p.y*100+'%',width:10,height:10,border:'2px solid white',borderRadius:'50%',transform:'translate(-50%,-50%)',pointerEvents:'none',background:p.kind==='foreground'?'#18a878':p.kind==='occlusion'?'#e9a32d':'#ef4444'}}/>)}</div></div>)}</div>
    <p>已添加 {hints.length} 个修正点。处理会创建独立合成记录，保留原任务和原始图片；无法可靠识别时仍会报告失败。</p>
    <button className="rp-button" disabled={busy} onClick={()=>onRecompose(hints)}>仅重新智能合成（不调用生图模型）</button>
  </details>;
}
