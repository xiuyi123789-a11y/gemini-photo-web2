import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Check, Download, Expand, ImagePlus, Layers, LoaderCircle, Plus, RefreshCw, ScanEye, Settings2, ShieldCheck, Sparkles, Trash2, X, PlugZap } from 'lucide-react';
import { ImageModal } from './ImageModal';
import { userStorage } from '../services/browserStorage';
import { MAX_REFERENCES, isFinalJob } from '../shared/replication-contract.js';
import { BRUSH_LIMITS, matchBrushSubjects, validSubjectBox } from '../shared/replication-brush.js';
import { startAnalysis,startGeneration,listActiveJobs,cancelReplicationJob,checkReplicationConnection,getReplicationCapabilities,
  reviseAnalysis,reviewReplication,reconcileReplication,readOperation,saveOperation,forgetOperation,assertOperation,ownerId,
  lookupOperation,closeOperation,resumeReplicationJob,
  type Operation,type ReplicationJob,type ReferenceAngle,type PreserveKey,type Point,type EditMask,type JobResult,type BrushStroke } from '../services/replicationService';
import './ImageReplicationView.css';

type Material={id:string;file:File|null;preview:string;width:number;height:number;angle:ReferenceAngle};
type Candidate={job:ReplicationJob;result:JobResult};
const angles:Record<ReferenceAngle,string>={front:'正面',side:'侧面',back:'背面',detail:'细节',other:'其他'};
const locks:Record<PreserveKey,string>={background:'背景与道具',composition:'构图与位置',lighting:'光线与阴影',perspective:'角度与透视'};
const stages:Record<string,string>={queued:'等待提交',submitting:'正在提交',running:'模型运行中',postprocessing:'正在检查结果',submission_unknown:'提交待核对',cancel_requested:'正在请求取消',cancel_unknown:'取消未确认',completed_needs_review:'待人工复核',quality_failed:'未通过结果检查',succeeded:'已完成',failed:'执行失败',canceled:'远端已取消'};
const issue=(e:unknown)=>e instanceof Error?e.message:'操作未完成，请重试查询。';
const qualityMessage:Record<string,string>={HUMAN_PRODUCT_IDENTITY_REVIEW_REQUIRED:'需要人工核对新产品结构、配色与标识。',SELECTED_INSTANCE_UNCHANGED:'至少一个选中对象几乎没有变化，不能确认替换成功。',OUTPUT_ASPECT_MISMATCH:'模型结果与原图比例不一致，未强行拉伸合成。',POSSIBLE_LAYOUT_DRIFT:'模型候选的场景布局可能偏移，请重点检查位置与遮挡。',OUTPUT_INVALID:'未获得可用的图像输出。'};
export const ImageReplicationView:React.FC=()=>{
  const [source,setSource]=useState<Material|null>(null),[references,setReferences]=useState<Material[]>([]);
  const [analysisJob,setAnalysisJob]=useState<ReplicationJob|null>(null),[generationJob,setGenerationJob]=useState<ReplicationJob|null>(null);
  const [analysisText,setAnalysisText]=useState(''),[fingerprint,setFingerprint]=useState('');
  const [selectedIds,setSelectedIds]=useState<string[]>([]),[masks,setMasks]=useState<EditMask[]>([]),[protectMasks,setProtectMasks]=useState<Point[][]>([]);
  const [strokes,setStrokes]=useState<BrushStroke[]>([]),[tool,setTool]=useState<'paint'|'erase'|'pan'>('paint'),[brushSize,setBrushSize]=useState(.06),[zoom,setZoom]=useState(100);
  const [showLocations,setShowLocations]=useState(false),[cursor,setCursor]=useState<Point|null>(null),[canvasWidth,setCanvasWidth]=useState(600);
  const [painting,setPainting]=useState(false);
  const preserve=Object.keys(locks) as PreserveKey[];
  const [notes,setNotes]=useState(''),[count,setCount]=useState(1),[resolution,setResolution]=useState('2K');
  const [caps,setCaps]=useState({enabled:true,maxReferences:MAX_REFERENCES,counts:[1],resolutions:['1K','2K']});
  const [pendingKind,setPendingKind]=useState<'analysis'|'generation'|null>(null),[reading,setReading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [operations,setOperations]=useState<{analysis:Operation|null;generation:Operation|null}>(()=>({analysis:readOperation('analysis'),generation:readOperation('generation')}));
  const [mode,setMode]=useState<'original'|'raw'|'result'|'compare'>('original'),[candidate,setCandidate]=useState<Candidate|null>(null),[split,setSplit]=useState(50),[enlarged,setEnlarged]=useState<string|null>(null);
  const [costConfirmed,setCostConfirmed]=useState(false),[reviewChecks,setReviewChecks]=useState<Record<string,boolean>>({}),[reconcileId,setReconcileId]=useState('');
  const sourceInput=useRef<HTMLInputElement>(null),refsInput=useRef<HTMLInputElement>(null),mounted=useRef(true),urls=useRef(new Set<string>()),operationBusy=useRef(false);
  const viewport=useRef<HTMLDivElement>(null),paintRef=useRef<{pointerId:number;stroke:BrushStroke}|null>(null),panRef=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const brushMaskId=useRef('brush-'+crypto.randomUUID());
  const currentFingerprint=useRef(''),loops=useRef({analysis:0,generation:0});
  const latestRevisions=useRef(new Map<string,number>());
  const restoredInputs=useRef(new Set<string>());
  const activeJob=[analysisJob,generationJob].find(j=>j&&!isFinalJob(j));
  const unresolved=(Object.values(operations) as Array<Operation|null>).filter((op):op is Operation=>!!op&&![analysisJob,generationJob].some(j=>j?.requestId===op.requestId&&isFinalJob(j)));
  const feeLocked=!!activeJob||unresolved.length>0;
  const locked=reading||!!pendingKind||feeLocked;
  const syncOperations=()=>setOperations({analysis:readOperation('analysis'),generation:readOperation('generation')});
  const instances=analysisJob?.analysis?.data?.scene?.old_product_instances||[];
  const brush={version:1 as const,strokes};
  const selection=matchBrushSubjects(brush,instances,source?.width||1,source?.height||1);
  const brushReady=validSubjectBox(instances[0]?.bbox)&&instances.every((i:any)=>validSubjectBox(i.bbox));
  const validAnalysis=analysisJob?.status==='succeeded'&&analysisJob.inputFingerprint===fingerprint&&!!analysisJob.analysis?.data;
  const materialFrom=(a:any):Material=>({id:a.name,file:null,preview:a.url,width:a.width,height:a.height,angle:a.angle||'other'});
  function apply(next:ReplicationJob,restore=false){
    if(!mounted.current)return;
    if(next.revision<(latestRevisions.current.get(next.id)??-1))return;
    latestRevisions.current.set(next.id,next.revision);
    if(next.kind==='analysis'){
      setAnalysisJob(next);
      if(next.status==='succeeded'&&next.analysis?.data)setAnalysisText(next.analysis.text);
    }else{
      setGenerationJob(next);
      if(next.results.length){setCandidate({job:next,result:next.results[next.results.length-1]});setMode(next.results.at(-1)?.composite?'compare':'raw');}
    }
    if(restore&&!currentFingerprint.current){
      currentFingerprint.current=next.inputFingerprint;setFingerprint(next.inputFingerprint);
      setSource(materialFrom(next.source));setReferences(next.references.map(materialFrom));
    }
    if(restore&&next.kind==='generation'&&next.input&&currentFingerprint.current===next.inputFingerprint&&!restoredInputs.current.has(next.id)){
      setSelectedIds(next.input.selectedInstances);setMasks(next.input.masks);setProtectMasks(next.input.protectMasks);setStrokes(next.input.brush?.strokes||[]);restoredInputs.current.add(next.id);
    }
    if(next.kind==='analysis'&&next.status==='succeeded'&&(!currentFingerprint.current||currentFingerprint.current===next.inputFingerprint)){
      currentFingerprint.current=next.inputFingerprint;setFingerprint(next.inputFingerprint);
      // Masks always use the server's orientation-corrected source, not the browser thumbnail dimensions.
      setSource(previous=>({...materialFrom(next.source),file:previous?.file||null}));
      setReferences(previous=>next.references.map((a,i)=>({...materialFrom(a),file:previous[i]?.file||null})));
    }
    if(next.error)setError(next.error+' ['+next.errorCode+']');else setError('');
    if(isFinalJob(next))setNotice(next.kind==='analysis'?(next.status==='succeeded'?'识别完成。请在右侧涂抹想替换的产品；不会自动生图。':'产品识别未完成，请查看提示。'):
      next.status==='completed_needs_review'?'候选已生成，需核对新产品身份与场景后再确认合格。':stages[next.status]||next.status);
  }
  async function track(operation:Operation,recover=false){
    const serial=++loops.current[operation.kind];
    while(mounted.current&&serial===loops.current[operation.kind]){
      try{
        const result=await lookupOperation(operation);
        if(!mounted.current||serial!==loops.current[operation.kind])return;
        setPendingKind(previous=>previous===operation.kind?null:previous);
        if(result.closed){forgetOperation(operation.kind);syncOperations();setError('');setNotice('本次提交已安全结束，可以重新上传或提交。');return;}
        if(!result.job){syncOperations();setNotice('原请求尚无模型任务。可重新连接查询，或安全结束本次提交；不会自动重发。');return;}
        let job=result.job;
        if(recover&&job.recoveryNeeded&&!isFinalJob(job)&&!['submission_unknown','cancel_unknown'].includes(job.status))job=await resumeReplicationJob(job.id);
        if(!mounted.current||serial!==loops.current[operation.kind])return;
        assertOperation(operation,job);operation={...operation,jobId:job.id};saveOperation(operation);apply(job,true);
        syncOperations();
        if(isFinalJob(job)||job.recoveryErrorCode||['submission_unknown','cancel_unknown'].includes(job.status))return;
      }catch(e){if(mounted.current){setPendingKind(previous=>previous===operation.kind?null:previous);syncOperations();setError(issue(e));setNotice('查询已中断。原请求仍保留，可重新连接或安全结束；不会自动重发。');}return;}
      await new Promise(r=>window.setTimeout(r,1600));
    }
  }
  async function restore(kind:'analysis'|'generation'){
    let op=readOperation(kind);
    if(!op){
      const active=await listActiveJobs(kind);const job=active.jobs[0],receipt=active.requests?.[0];if(!job&&!receipt)return;
      op=job?{kind,jobId:job.id,requestId:job.requestId,inputFingerprint:job.inputFingerprint,ownerId:ownerId()}:
        {kind,requestId:receipt!.requestId,inputFingerprint:receipt!.inputFingerprint,ownerId:ownerId()};saveOperation(op);syncOperations();
    }
    await track(op,true);
  }
  useEffect(()=>{
    mounted.current=true;
    void getReplicationCapabilities().then(c=>mounted.current&&setCaps(c)).catch(()=>{});
    void Promise.all([restore('analysis'),restore('generation')]).catch(e=>{if(mounted.current)setError(issue(e));});
    if(userStorage.getItem('replication_active_job'))setNotice('检测到旧版任务标识，未自动关联到新版分析；历史费用与任务需单独核对。');
    return()=>{mounted.current=false;loops.current.analysis++;loops.current.generation++;urls.current.forEach(u=>URL.revokeObjectURL(u));};
  },[]);
  useEffect(()=>{
    const element=viewport.current;if(!element||!source)return;
    const fit=()=>setCanvasWidth(Math.max(1,Math.min(element.clientWidth,element.clientHeight*source.width/source.height)));
    fit();if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(fit);observer.observe(element);return()=>observer.disconnect();
  },[source?.width,source?.height]);
  function stale(){
    if(feeLocked)return;
    setAnalysisJob(null);setGenerationJob(null);setAnalysisText('');setFingerprint('');currentFingerprint.current='';
    setSelectedIds([]);setMasks([]);setProtectMasks([]);setStrokes([]);paintRef.current=null;panRef.current=null;setZoom(100);setCandidate(null);setMode('original');setCostConfirmed(false);setError('');setNotice('素材已改变，请重新识别产品。');
    forgetOperation('analysis');forgetOperation('generation');
    syncOperations();
  }
  async function upload(files:FileList|File[],kind:'source'|'refs'){
    if(locked||operationBusy.current||!files.length)return;setReading(true);setError('');
    try{
      const list=Array.from(files);
      if((kind==='source'&&list.length!==1)||(kind==='refs'&&references.length+list.length>caps.maxReferences))throw new Error(`原图须1张；新产品参考最多${caps.maxReferences}张。`);
      const total=list.reduce((n,f)=>n+f.size,0)+(kind==='source'?references.reduce((n,r)=>n+(r.file?.size||0),0):(source?.file?.size||0)+references.reduce((n,r)=>n+(r.file?.size||0),0));
      if(total>32*1024*1024)throw new Error('图片总计不能超过32 MB。');
      const added:Material[]=[];
      for(const file of list){
        if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>20*1024*1024)throw new Error('支持 JPG/PNG/WEBP，单张最多20 MB。');
        const url=URL.createObjectURL(file);urls.current.add(url);const img=new Image();
        await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('图片无法读取。'));img.src=url;});
        if(img.naturalWidth*img.naturalHeight>32*1024*1024)throw new Error('图片最多支持3200万像素。');
        added.push({id:crypto.randomUUID(),file,preview:url,width:img.naturalWidth,height:img.naturalHeight,angle:'other'});
      }
      stale();if(kind==='source')setSource(added[0]);else setReferences(prev=>[...prev,...added]);
    }catch(e){setError(issue(e));}finally{setReading(false);}
  }
  async function analyze(){
    if(locked||operationBusy.current)return;
    if(!source?.file||!references.length||references.some(r=>!r.file)){setError('请上传场景原图和产品参考。已恢复的分析可直接确认并复刻；重新分析需重新上传素材。');return;}
    operationBusy.current=true;setPendingKind('analysis');setError('');setNotice('仅执行 o4-mini 产品文字分析，不会生成图片。');
    try{
      setMasks([]);setProtectMasks([]);setSelectedIds([]);setStrokes([]);setMode('original');
      const next=await startAnalysis(source.file,references.map(r=>({file:r.file!,angle:r.angle})), '');
      currentFingerprint.current=next.inputFingerprint;setFingerprint(next.inputFingerprint);apply(next);
      const op=readOperation('analysis');if(op)await track(op);
    }catch(e){setError(issue(e));}
    finally{operationBusy.current=false;setPendingKind(null);syncOperations();}
  }
  async function generate(){
    if(locked||operationBusy.current)return;
    if(!validAnalysis||!analysisJob){setError('请先识别产品与替换位置。');return;}
    if(!brushReady||!selection.valid){setError('请在识别到的产品上涂抹，确认需要替换的范围。');return;}
    if(!costConfirmed){setError(`请确认本次会请求${count}个图像预测，费用以供应商记录为准。`);return;}
    operationBusy.current=true;setPendingKind('generation');setError('');setReviewChecks({});setCostConfirmed(false);
    try{
      // User's explicit generation click confirms the visible analysis and brush
      // together. Revision is a local write and cannot create a prediction.
      let approved=analysisJob;
      if(!approved.analysis!.confirmedAt||approved.analysis!.text!==analysisText){approved=await reviseAnalysis(approved,analysisText);setAnalysisJob(approved);}
      const next=await startGeneration({inputFingerprint:fingerprint,analysisJobId:approved.id,analysisRevisionHash:approved.analysis!.revisionHash,
        selectedInstances:selection.selectedInstances,masks:[],protectMasks:[],brush,
        maskSpace:{width:analysisJob.source.width,height:analysisJob.source.height,sourceHash:analysisJob.source.sha256},
        resolution,count,preserve,notes,confirmedPredictions:count});
      apply(next);const op=readOperation('generation');if(op)await track(op);
    }catch(e){setError(issue(e));}
    finally{operationBusy.current=false;setPendingKind(null);syncOperations();}
  }
  function brushPoint(event:React.PointerEvent<SVGSVGElement>):Point|null{
    if(!source)return null;const matrix=event.currentTarget.getScreenCTM();if(!matrix)return null;
    const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
    return {x:Math.min(1,Math.max(0,p.x/source.width)),y:Math.min(1,Math.max(0,p.y/source.height))};
  }
  function beginBrush(event:React.PointerEvent<SVGSVGElement>){
    if(locked||!validAnalysis||!brushReady||event.button!==0||paintRef.current||panRef.current)return;
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    if(tool==='pan'){if(viewport.current)panRef.current={x:event.clientX,y:event.clientY,left:viewport.current.scrollLeft,top:viewport.current.scrollTop};return;}
    const p=brushPoint(event);if(!p)return;
    if(strokes.length>=BRUSH_LIMITS.strokes||strokes.reduce((n,s)=>n+s.points.length,0)>=BRUSH_LIMITS.points){setError('笔画较多，请撤销部分笔画或清空后重画。');return;}
    const stroke:BrushStroke={tool,size:brushSize,points:[p]};paintRef.current={pointerId:event.pointerId,stroke};
    setStrokes(previous=>[...previous,stroke]);setPainting(true);setMasks([]);setProtectMasks([]);setCostConfirmed(false);setError('');setCursor(p);
  }
  function moveBrush(event:React.PointerEvent<SVGSVGElement>){
    if(panRef.current&&viewport.current){viewport.current.scrollLeft=panRef.current.left+panRef.current.x-event.clientX;viewport.current.scrollTop=panRef.current.top+panRef.current.y-event.clientY;return;}
    const p=brushPoint(event);setCursor(p);const active=paintRef.current;
    if(!p||!active||active.pointerId!==event.pointerId||locked)return;
    const last=active.stroke.points.at(-1)!;
    if(Math.hypot(p.x-last.x,p.y-last.y)<.001)return;
    if(strokes.reduce((n,s)=>n+s.points.length,0)>=BRUSH_LIMITS.points){setError('涂抹已达到点数上限，请撤销部分笔画。');endBrush(event);return;}
    active.stroke={...active.stroke,points:[...active.stroke.points,p]};const stroke=active.stroke;
    setStrokes(previous=>[...previous.slice(0,-1),stroke]);
  }
  function endBrush(event:React.PointerEvent<SVGSVGElement>){
    if(paintRef.current&&paintRef.current.pointerId!==event.pointerId)return;
    paintRef.current=null;panRef.current=null;setPainting(false);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function cancel(){if(!activeJob)return;try{const next=await cancelReplicationJob(activeJob.id);apply(next);const op=readOperation(next.kind);if(op)await track(op);}catch(e){setError(issue(e));}}
  async function reconnect(){setError('');try{await Promise.all([restore('analysis'),restore('generation')]);}catch(e){setError(issue(e));}}
  async function safelyEnd(op:Operation){
    try{const result=await closeOperation(op);syncOperations();if(result.job)apply(result.job);
      if(result.closed){setError('');setNotice('已确认未提交模型并封存原请求，可以重新提交。');}
      else setNotice('该请求已有预测记录，费用保护仍保留；请查询或取消原任务，不会重新创建预测。');
    }catch(e){setError(issue(e));}finally{setPendingKind(null);syncOperations();}
  }
  async function reconcile(){if(!activeJob||!reconcileId)return;try{const next=await reconcileReplication(activeJob.id,reconcileId.trim());apply(next);setReconcileId('');const op=readOperation(next.kind);if(op)await track(op);}catch(e){setError(issue(e));}}
  async function review(decision:'accept'|'reject'){
    if(!candidate)return;try{const next=await reviewReplication(candidate.job.id,decision,reviewChecks);apply(next);setCandidate({job:next,result:next.results.at(-1)!});}catch(e){setError(issue(e));}
  }
  async function download(url:string,label:string){try{const response=await fetch(url,{credentials:'same-origin'});if(!response.ok)throw new Error('下载失败。');
    const u=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=u;a.download=`图像复刻_${label}_${Date.now()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(e){setError(issue(e));}}
  const originalUrl=candidate&&mode!=='original'?candidate.job.source.url:source?.preview;
  const preview=mode==='raw'?candidate?.result.raw.url:mode==='result'?candidate?.result.composite?.url:originalUrl;
  const polygonPoints=(p:Point[])=>p.map(v=>`${v.x*(source?.width||1)},${v.y*(source?.height||1)}`).join(' ');
  const generationReady=validAnalysis&&brushReady&&selection.valid&&!locked&&caps.enabled;
  return <section className="rp-view" aria-label="图像复刻工作台">
    <div className="rp-heading"><div><h1>图像复刻 <span>换产品，保留场景</span></h1><p>上传你的产品，AI 找到场景中的对应物品。涂哪里，就替换哪里。</p></div>
      <button className="rp-button" disabled={reading||!!pendingKind} onClick={async()=>{try{await checkReplicationConnection();setNotice('两模型元数据可访问，未创建预测任务。');}catch(e){setError(issue(e));}}}><PlugZap/>检查连接</button></div>
    <div className="rp-workflow"><span>01 上传场景与产品</span><span>02 AI 识别对应物品</span><span>03 涂抹确认</span><span>04 开始替换</span></div>
    {!caps.enabled&&<div className="rp-message">新任务入口已关闭，现有任务仍可查询。</div>}
    {(error||notice)&&<div className={'rp-message '+(error?'rp-error':'')} role={error?'alert':'status'}>{error||notice}</div>}
    <div className="rp-layout"><section className="rp-card rp-materials">
      <div className="rp-card-title"><h2><Layers/>输入素材</h2><button className="rp-text" disabled={locked} onClick={()=>{if(window.confirm('清空本次素材与编辑？已保存的任务不会删除。')){stale();setSource(null);setReferences([]);}}}><Trash2/>清空</button></div>
      <div className="rp-section-label"><b>01</b>想保留的场景照片</div>
      <div className="rp-source" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(e.dataTransfer.files,'source');}}>
        <button disabled={locked} onClick={()=>sourceInput.current?.click()} aria-label="上传场景原图">{source?<img src={source.preview} alt="场景原图缩略图"/>:<span className="rp-empty-upload"><ImagePlus/>上传场景原图</span>}</button>
        <input ref={sourceInput} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e=>{if(e.target.files)void upload(e.target.files,'source');e.target.value='';}}/></div>
      {source&&<p className="rp-hint">{source.width} × {source.height} · {source.file?'本地上传':'已恢复的服务器素材'}</p>}
      <div className="rp-section-label"><b>02</b>要换进去的新产品<small>{references.length}/{caps.maxReferences}</small></div>
      <div className="rp-references" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(e.dataTransfer.files,'refs');}}>
        {references.map((r,i)=><div className="rp-reference" key={r.id}><button onClick={()=>setEnlarged(r.preview)}><img src={r.preview} alt={`产品参考${i+1}`}/></button><button className="rp-remove" disabled={locked} aria-label={`移除参考${i+1}`} onClick={()=>{stale();setReferences(list=>list.filter(item=>item.id!==r.id));}}><X/></button><select aria-label={`参考${i+1}角度`} disabled={locked} value={r.angle} onChange={e=>{stale();setReferences(list=>list.map(item=>item.id===r.id?{...item,angle:e.target.value as ReferenceAngle}:item));}}>{Object.entries(angles).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></div>)}
        {references.length<caps.maxReferences&&<button disabled={locked} className="rp-add-ref" onClick={()=>refsInput.current?.click()}><Plus/>添加参考</button>}
        <input ref={refsInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e=>{if(e.target.files)void upload(e.target.files,'refs');e.target.value='';}}/></div>
      <p className="rp-hint">同一新产品；JPG/PNG/WEBP；单张20 MB，合计32 MB。</p>
      <button className="rp-button rp-primary rp-wide" disabled={locked||!caps.enabled} onClick={analyze}><ScanEye/>{pendingKind==='analysis'?'正在提交分析素材…':analysisJob&&!isFinalJob(analysisJob)?(['submission_unknown','cancel_unknown'].includes(analysisJob.status)?'分析任务待核对':stages[analysisJob.status]||'分析任务待恢复'):unresolved.some(op=>op.kind==='analysis')?'分析提交待核对':'识别产品与替换位置'}</button>
      <p className="rp-hint">自动理解产品并寻找场景中的同类物品，无需填写产品名称。识别不会生成图片。</p>
      {validAnalysis&&<div className="rp-recognition" role="status"><b>识别到：{analysisJob!.analysis!.data.new_product.category}</b><p>{instances.length?`场景中找到 ${instances.length} 个对应物品。请在右侧涂抹想替换的部分。`:'场景中没有找到对应物品，请更换场景照片后识别。'}</p>{instances.map((i:any)=><span key={i.instance_id}>{i.location}</span>)}</div>}
      {validAnalysis&&<details className="rp-advanced"><summary>查看 / 调整产品特征（可选）</summary><textarea className="rp-analysis" aria-label="产品分析摘要" value={analysisText} disabled={locked} maxLength={16000} onChange={e=>{setAnalysisText(e.target.value);setCostConfirmed(false);}}/>{!!analysisJob?.analysis?.rawText&&<details><summary>原始分析返回</summary><pre className="rp-json">{analysisJob.analysis.rawText}</pre></details>}</details>}
    </section><div className="rp-right">
      <section className="rp-card rp-preview"><div className="rp-preview-head"><div className="rp-tabs" role="tablist" aria-label="预览模式">
        {([['original','原图'],['raw','模型原始结果'],['result','最终合成候选'],['compare','滑动对比']] as const).map(([key,label])=><button role="tab" aria-selected={mode===key} key={key} disabled={key!=='original'&&(!candidate||(key!=='raw'&&!candidate.result.composite))} className={mode===key?'rp-tab-active':''} onClick={()=>setMode(key)}>{label}</button>)}
      </div><button className="rp-icon-button" aria-label="放大当前预览" disabled={!preview} onClick={()=>preview&&setEnlarged(preview)}><Expand/></button></div>
      <div className="rp-brush-toolbar" aria-label="涂抹工具">
        <div className="rp-mask-tools">{([['paint','画笔'],['erase','橡皮擦'],['pan','拖动画面']] as const).map(([value,label])=><button className={'rp-button '+(tool===value?'rp-tool-active':'')} key={value} aria-pressed={tool===value} disabled={locked||painting||!validAnalysis||!brushReady} onClick={()=>{setTool(value);setMode('original');}}>{label}</button>)}
          <button className="rp-button" disabled={locked||painting||!strokes.length} onClick={()=>{setStrokes(s=>s.slice(0,-1));setCostConfirmed(false);}}>撤销一笔</button><button className="rp-button" disabled={locked||painting||!strokes.length} onClick={()=>{setStrokes([]);setCostConfirmed(false);}}>清空涂抹</button></div>
        <label>画笔大小 <span>细</span><input aria-label="画笔大小" type="range" min="0.005" max="0.2" step="0.005" value={brushSize} disabled={locked} onChange={e=>setBrushSize(Number(e.target.value))}/><span>粗</span></label>
        <label>放大 <input aria-label="画布缩放" type="range" min="100" max="400" step="25" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><span>{zoom}%</span></label>
        {validAnalysis&&brushReady&&<label><input type="checkbox" checked={showLocations} onChange={e=>setShowLocations(e.target.checked)}/>显示 AI 识别位置</label>}
      </div>
      <div className="rp-canvas-wrap" ref={viewport}><div className="rp-canvas-center"><div className="rp-canvas" style={{width:source?canvasWidth*zoom/100:'100%',height:source?canvasWidth*zoom/100*source.height/source.width:350}}>
        {preview?<img className="rp-canvas-image" src={preview} alt={mode==='original'?'场景原图':mode==='raw'?'模型原始结果':'待审核合成候选'}/>:<div className="rp-canvas-empty"><ImagePlus/><p>上传场景原图和新产品参考</p></div>}
        {mode==='compare'&&candidate?.result.composite&&<><img className="rp-canvas-image" src={candidate.result.composite.url} alt="最终合成候选" style={{clipPath:`inset(0 0 0 ${split}%)`}}/><div className="rp-compare-line" style={{left:split+'%'}}><span><ArrowLeftRight/></span></div><input className="rp-compare-range" type="range" value={split} onChange={e=>setSplit(Number(e.target.value))} aria-label="原图与合成候选滑动对比"/></>}
        {source&&mode==='original'&&<svg className={'rp-region-svg '+(validAnalysis&&brushReady&&!locked?'rp-region-selecting':'')+' rp-tool-'+tool} viewBox={`0 0 ${source.width} ${source.height}`} preserveAspectRatio="xMidYMid meet" onPointerDown={beginBrush} onPointerMove={moveBrush} onPointerUp={endBrush} onPointerCancel={endBrush} onLostPointerCapture={()=>{paintRef.current=null;panRef.current=null;setPainting(false);}} onPointerLeave={()=>setCursor(null)} aria-label="涂抹替换范围画布">
          <defs><mask id={brushMaskId.current} maskUnits="userSpaceOnUse" x="0" y="0" width={source.width} height={source.height}><rect width={source.width} height={source.height} fill="black"/>{strokes.map((s,i)=>s.points.length===1?<circle key={i} cx={s.points[0].x*source.width} cy={s.points[0].y*source.height} r={s.size*Math.min(source.width,source.height)/2} fill={s.tool==='erase'?'black':'white'}/>:<polyline key={i} points={polygonPoints(s.points)} fill="none" stroke={s.tool==='erase'?'black':'white'} strokeWidth={s.size*Math.min(source.width,source.height)} strokeLinecap="round" strokeLinejoin="round"/>)}</mask></defs>
          <rect width={source.width} height={source.height} fill="#3074ff" opacity=".45" mask={`url(#${brushMaskId.current})`}/>
          {!strokes.length&&masks.filter(m=>selectedIds.includes(m.instanceId)).map(m=><polygon key={m.instanceId} points={polygonPoints(m.points)} fill="#3b75ef40"/>)}
          {!strokes.length&&protectMasks.map((p,i)=><polygon key={i} points={polygonPoints(p)} fill="#e85c5740"/>)}
          {showLocations&&instances.filter((i:any)=>validSubjectBox(i.bbox)).map((i:any)=><g key={i.instance_id}><rect x={i.bbox[0]*source.width} y={i.bbox[1]*source.height} width={i.bbox[2]*source.width} height={i.bbox[3]*source.height} fill="none" stroke="#3874de" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"/><text x={i.bbox[0]*source.width} y={i.bbox[1]*source.height} fontSize={Math.min(source.width,source.height)*.025} fill="#2454b4">{i.location}</text></g>)}
          {cursor&&tool!=='pan'&&validAnalysis&&brushReady&&!locked&&<circle cx={cursor.x*source.width} cy={cursor.y*source.height} r={brushSize*Math.min(source.width,source.height)/2} fill="none" stroke={tool==='erase'?'#e55353':'#fff'} strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>}
        </svg>}
        <span className="rp-image-label">{mode==='original'?'原图':mode==='raw'?'模型原始结果':candidate?.job.status==='succeeded'?'人工确认合格':'待审核候选 · 尚未确认替换成功'}</span>
      </div></div></div>
      <div className="rp-preserve-strip"><ShieldCheck/>请涂满要替换的整个产品，并留出必要的轮廓和阴影空间。未涂抹处保留原图；袜子、裤脚等请留白或擦除。</div></section>
      <section className="rp-card rp-settings"><div className="rp-card-title"><h2><Sparkles/>确认涂抹并开始替换</h2></div>
        {!validAnalysis?<p className="rp-hint">上传两类图片后点击“识别产品与替换位置”，再用画笔涂抹产品。</p>:!instances.length?<p className="rp-hint">未找到对应物品，暂不能替换。</p>:!brushReady?<p className="rp-hint">这份历史分析没有主体定位信息。可查看原任务；如需新的替换，请重新上传素材并识别。</p>:<div className="rp-selection-summary" role="status">{selection.selectedInstances.length?<><b>涂抹已对应到 {selection.selectedInstances.length} 个物品：</b>{instances.filter((i:any)=>selection.selectedInstances.includes(i.instance_id)).map((i:any)=><span key={i.instance_id}>{i.location}</span>)}</>:<b>在右侧涂抹你想换掉的物品。</b>}{selection.painted>0&&!selection.valid&&<p>涂抹与识别到的产品位置不匹配，请擦除背景等无关区域后重新确认。</p>}</div>}
        <label className="rp-label">补充要求（可选）<textarea disabled={locked} value={notes} maxLength={4000} onChange={e=>{setNotes(e.target.value);setCostConfirmed(false);}} placeholder="例如：保留鞋带自然垂落的状态"/></label>
        <details className="rp-advanced"><summary>输出设置（默认即可）</summary><div className="rp-settings-grid"><div><span className="rp-field-label">始终保留</span><p className="rp-hint">背景、构图、人物、视角与原场景光线。</p></div>
          <div><span className="rp-field-label">输出设置</span><div className="rp-output"><select aria-label="模型分辨率" disabled={locked} value={resolution} onChange={e=>{setResolution(e.target.value);setCostConfirmed(false);}}>{caps.resolutions.map(v=><option key={v}>{v}</option>)}</select><select aria-label="候选数量" disabled={locked} value={count} onChange={e=>{setCount(Number(e.target.value));setCostConfirmed(false);}}>{caps.counts.map(v=><option key={v} value={v}>{v} 张</option>)}</select></div><p className="rp-hint">首版默认单张，4K/批量需验证后由维护者开放。合成输出保持原图像素尺寸。</p></div></div>
        </details>
        <label className="rp-cost"><input aria-label="确认本次替换费用" type="checkbox" disabled={locked||!generationReady} checked={costConfirmed} onChange={e=>setCostConfirmed(e.target.checked)}/>本次请求 {count} 个 Nano Banana 2 图像预测；金额以供应商实际记录为准，失败或取消也可能计费。</label>
        <button className="rp-button rp-primary" disabled={!generationReady||!costConfirmed||painting} onClick={generate}><Sparkles/>开始替换</button>
      </section>
      {(analysisJob||generationJob||pendingKind||unresolved.length>0)&&<section className="rp-card rp-settings" aria-label="任务状态">
        <div className="rp-card-title"><h2>独立任务状态</h2><button className="rp-button" onClick={reconnect}><RefreshCw/>重新连接查询</button></div>
        {pendingKind&&<p>{pendingKind==='analysis'?'分析':'生图'}请求尚在提交或接收待确认；请勿重复提交。</p>}
        {unresolved.map(op=><div className="rp-task" key={op.requestId}><b>{op.kind==='analysis'?'分析':'生图'}请求 · 原请求保留</b><small>请求：{op.requestId}</small><button className="rp-button" disabled={!!pendingKind} onClick={()=>safelyEnd(op)}>安全结束本次提交</button><small>仅当服务端确认没有预测提交记录时解除费用保护；不取消、不重建预测。</small></div>)}
        {[analysisJob,generationJob].filter(Boolean).map(j=><div className="rp-task" key={j!.id}><b>{j!.kind==='analysis'?'o4-mini 产品分析':'Nano Banana 2 图像生成'} · {stages[j!.status]||j!.status}</b><small>任务：{j!.id}<br/>请求：{j!.requestId}</small>{j!.predictions.map((p,i)=><small key={i}>{p.model} · {p.predictionId||'预测ID尚未确认'} · {p.remoteStatus||p.reconciliationState}</small>)}</div>)}
        {activeJob&&<><button className="rp-button" onClick={cancel}>请求取消远端任务</button><p className="rp-hint">远端终态确认后才标记取消；中断浏览器不会自动停止收费。</p>{['submission_unknown','cancel_unknown'].includes(activeJob.status)&&<label className="rp-label">手动核对供应商预测ID（会验证模型、时间和输入摘要）<input value={reconcileId} onChange={e=>setReconcileId(e.target.value)}/><button className="rp-button" onClick={reconcile}>关联并查询原预测</button></label>}</>}
      </section>}
      {candidate&&<section className="rp-card rp-settings" aria-label="候选质量审核"><h2>结果审核 · {stages[candidate.job.status]||candidate.job.status}</h2>
        <p className="rp-hint">像素检查无法证明新产品身份正确，请对照全部参考审核。</p><ul>{candidate.result.quality.reasons?.map(r=><li key={r}>{qualityMessage[r]||r}</li>)}</ul>
        {candidate.job.status==='completed_needs_review'&&<><div className="rp-review-checks">{Object.entries({identity:'新产品结构、配色和标识正确',allInstances:'每个选中对象都已替换',occlusion:'裤脚、袜子等遮挡自然',scene:'场景、视角和光影合理'}).map(([k,v])=><label key={k}><input type="checkbox" checked={!!reviewChecks[k]} onChange={e=>setReviewChecks(p=>({...p,[k]:e.target.checked}))}/>{v}</label>)}</div><div className="rp-mask-tools"><button className="rp-button rp-primary" disabled={!['identity','allInstances','occlusion','scene'].every(k=>reviewChecks[k])} onClick={()=>review('accept')}>确认替换合格</button><button className="rp-button" onClick={()=>review('reject')}>标记效果不合格</button></div></>}
        <div className="rp-mask-tools"><button className="rp-button" onClick={()=>download(candidate.result.raw.url,'模型原始结果')}><Download/>下载原始候选</button>{candidate.result.composite&&<button className="rp-button" onClick={()=>download(candidate.result.composite!.url,candidate.job.status==='succeeded'?'确认合格':'待审核候选')}><Download/>下载合成{candidate.job.status==='succeeded'?'结果':'候选'}</button>}</div>
      </section>}
    </div></div>{enlarged&&<ImageModal src={enlarged} onClose={()=>setEnlarged(null)}/>}</section>;
};
