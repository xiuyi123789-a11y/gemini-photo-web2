import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Download, Expand, ImagePlus, Layers, Plus, RefreshCw, ScanEye, Sparkles, Trash2, X } from 'lucide-react';
import { ReplicationImageViewer } from './ReplicationImageViewer';
import { userStorage } from '../services/browserStorage';
import {saveReplicationDraft,loadReplicationDraft,clearReplicationDraft} from '../services/replicationDraft';
import { MAX_REFERENCES, isFinalJob, REPLICATION_MODEL_NAMES } from '../shared/replication-contract.js';
import { BRUSH_LIMITS, matchBrushSubjects, validSubjectBox } from '../shared/replication-brush.js';
import { startAnalysis,startGeneration,getReplicationWorkbench,replicationImageUrl,cancelReplicationJob,getReplicationCapabilities,
  reviseAnalysis,readOperation,saveOperation,forgetOperation,assertOperation,ownerId,
  lookupOperation,closeOperation,resumeReplicationJob,
  type Operation,type ReplicationJob,type ReferenceAngle,type PreserveKey,type Point,type EditMask,type JobResult,type BrushStroke } from '../services/replicationService';
import './ImageReplicationView.css';

type Material={id:string;file:File|null;preview:string;width:number;height:number;angle:ReferenceAngle};
type Candidate={job:ReplicationJob;result:JobResult};
const NO_INSTANCES:any[]=[];
const angles:Record<ReferenceAngle,string>={front:'正面',side:'侧面',back:'背面',detail:'细节',other:'其他'};
const locks:Record<PreserveKey,string>={background:'背景与道具',composition:'构图与位置',lighting:'光线与阴影',perspective:'角度与透视'};
const stages:Record<string,string>={queued:'等待提交',submitting:'正在提交',running:'模型运行中',postprocessing:'正在保存结果',submission_unknown:'提交待核对',cancel_requested:'正在请求取消',cancel_unknown:'取消未确认',completed_needs_review:'图片已生成',quality_failed:'结果需查看',succeeded:'已完成',failed:'执行失败',canceled:'远端已取消'};
const issue=(e:unknown)=>e instanceof Error?e.message:'操作未完成，请重试查询。';
export const ImageReplicationView:React.FC=()=>{
  const [source,setSource]=useState<Material|null>(null),[references,setReferences]=useState<Material[]>([]);
  const [analysisJob,setAnalysisJob]=useState<ReplicationJob|null>(null),[generationJob,setGenerationJob]=useState<ReplicationJob|null>(null);
  const [analysisText,setAnalysisText]=useState(''),[fingerprint,setFingerprint]=useState('');
  const [selectedIds,setSelectedIds]=useState<string[]>([]),[masks,setMasks]=useState<EditMask[]>([]),[protectMasks,setProtectMasks]=useState<Point[][]>([]);
  const [strokes,setStrokes]=useState<BrushStroke[]>([]),[tool,setTool]=useState<'paint'|'erase'|'pan'>('paint'),[brushSize,setBrushSize]=useState(.06),[zoom,setZoom]=useState(100);
  const [cursor,setCursor]=useState<Point|null>(null),[canvasWidth,setCanvasWidth]=useState(600);
  const [painting,setPainting]=useState(false);
  const preserve=Object.keys(locks) as PreserveKey[];
  const [notes,setNotes]=useState(''),[count,setCount]=useState(1),[resolution,setResolution]=useState('2K');
  const [caps,setCaps]=useState<{enabled:boolean;maxReferences:number;counts:number[];resolutions:string[];submission?:{analysis:boolean;generation:boolean};adaptiveComposition?:{configured:boolean}}>({enabled:true,maxReferences:MAX_REFERENCES,counts:[1],resolutions:['1K','2K']});
  const [pendingKind,setPendingKind]=useState<'analysis'|'generation'|null>(null),[reading,setReading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [operations,setOperations]=useState<{analysis:Operation|null;generation:Operation|null}>(()=>({analysis:readOperation('analysis'),generation:readOperation('generation')}));
  const [mode,setMode]=useState<'original'|'raw'|'compare'>('original'),[candidate,setCandidate]=useState<Candidate|null>(null),[split,setSplit]=useState(50),[enlarged,setEnlarged]=useState<{src:string;label:string}|null>(null);
  const [costConfirmed,setCostConfirmed]=useState(false);
  const [restoring,setRestoring]=useState(false),[imageRetry,setImageRetry]=useState(0),[failedImages,setFailedImages]=useState<string[]>([]);
  const sourceInput=useRef<HTMLInputElement>(null),refsInput=useRef<HTMLInputElement>(null),mounted=useRef(true),urls=useRef(new Set<string>()),operationBusy=useRef(false);
  const viewport=useRef<HTMLDivElement>(null),paintRef=useRef<{pointerId:number;stroke:BrushStroke}|null>(null),panRef=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const brushMaskId=useRef('brush-'+crypto.randomUUID());
  const currentFingerprint=useRef(''),loops=useRef({analysis:0,generation:0});
  const latestRevisions=useRef(new Map<string,number>());
  const restoredInputs=useRef(new Set<string>());
  const materialsJob=useRef<ReplicationJob|null>(null),restoreSerial=useRef(0);
  const latestKinds=useRef(new Map<string,ReplicationJob>());
  const activeJob=[analysisJob,generationJob].find(j=>j&&!isFinalJob(j));
  const unresolved=(Object.values(operations) as Array<Operation|null>).filter((op):op is Operation=>!!op&&![analysisJob,generationJob].some(j=>j?.requestId===op.requestId&&isFinalJob(j)));
  const feeLocked=!!activeJob||unresolved.length>0;
  const locked=restoring||reading||!!pendingKind||feeLocked;
  const syncOperations=()=>setOperations({analysis:readOperation('analysis'),generation:readOperation('generation')});
  const instances=analysisJob?.analysis?.data?.scene?.old_product_instances||NO_INSTANCES;
  const brush={version:1 as const,strokes};
  const selection=useMemo(()=>matchBrushSubjects({version:1,strokes},instances,source?.width||1,source?.height||1),[strokes,instances,source?.width,source?.height]);
  const brushReady=validSubjectBox(instances[0]?.bbox)&&instances.every((i:any)=>validSubjectBox(i.bbox));
  const validAnalysis=analysisJob?.status==='succeeded'&&analysisJob.inputFingerprint===fingerprint&&!!analysisJob.analysis?.data;
  const sourceFailed=!!source&&failedImages.includes(source.preview+'#canvas');
  const materialFrom=(a:any):Material=>({id:a.name,file:null,preview:a.url,width:a.width,height:a.height,angle:a.angle||'other'});
  function apply(next:ReplicationJob,restore=false){
    if(!mounted.current)return;
    const latest=latestKinds.current.get(next.kind);
    if(latest&&latest.id!==next.id&&latest.createdAt>next.createdAt)return;
    if(next.revision<(latestRevisions.current.get(next.id)??-1))return;
    latestRevisions.current.set(next.id,next.revision);
    latestKinds.current.set(next.kind,next);
    if(next.kind==='analysis'){
      setAnalysisJob(next);
      if(next.status==='succeeded'&&next.analysis?.data)setAnalysisText(next.analysis.text);
    }else{
      setGenerationJob(next);
      if(next.results.length){setCandidate({job:next,result:next.results[next.results.length-1]});setMode('raw');}
    }
    if(restore&&!currentFingerprint.current){
      currentFingerprint.current=next.inputFingerprint;setFingerprint(next.inputFingerprint);
    }
    if(restore&&next.kind==='generation'&&next.input&&currentFingerprint.current===next.inputFingerprint&&!restoredInputs.current.has(next.id)){
      setSelectedIds(next.input.selectedInstances);setMasks(next.input.masks);setProtectMasks(next.input.protectMasks);setStrokes(next.input.brush?.strokes||[]);restoredInputs.current.add(next.id);
    }
    if((restore||next.kind==='analysis'&&next.status==='succeeded')&&(!currentFingerprint.current||currentFingerprint.current===next.inputFingerprint)&&
      (!materialsJob.current||next.createdAt>materialsJob.current.createdAt||next.id===materialsJob.current.id)){
      currentFingerprint.current=next.inputFingerprint;setFingerprint(next.inputFingerprint);
      materialsJob.current=next;
      // Masks always use the server's orientation-corrected source, not the browser thumbnail dimensions.
      setSource(previous=>({...materialFrom(next.source),file:previous?.file||null}));
      setReferences(previous=>next.references.map((a,i)=>({...materialFrom(a),file:previous[i]?.file||null})));
    }
    const rawFromHistoricalComposition=next.kind==='generation'&&next.status==='quality_failed'&&next.results.some(r=>r.raw)&&next.errorCode==='QUALITY_FAILED';
    if(next.error&&!rawFromHistoricalComposition)setError(next.error);else setError('');
    if(isFinalJob(next))setNotice(next.kind==='analysis'?(next.status==='succeeded'?'识别完成。请在右侧涂抹想替换的产品；不会自动生图。':'产品识别未完成，请查看提示。'):
      next.results.length?'图片已生成，可查看、对比和下载。':stages[next.status]||next.status);
  }
  async function track(operation:Operation,recover=false,initial?:Awaited<ReturnType<typeof lookupOperation>>){
    const serial=++loops.current[operation.kind];
    let first=initial,readFailures=0;
    while(mounted.current&&serial===loops.current[operation.kind]){
      let readingStatus=true;
      try{
        const result=first||await lookupOperation(operation);first=undefined;readFailures=0;
        readingStatus=false;
        if(!mounted.current||serial!==loops.current[operation.kind])return;
        setPendingKind(previous=>previous===operation.kind?null:previous);
        if(result.closed){forgetOperation(operation.kind);syncOperations();setError('');setNotice('本次提交已安全结束，可以重新上传或提交。');return;}
        if(!result.job){syncOperations();setNotice('原请求尚无模型任务。可重新连接查询，或安全结束本次提交；不会自动重发。');return;}
        let job=result.job;
        if(recover&&job.recoveryNeeded&&!isFinalJob(job)&&!['submission_unknown','cancel_unknown'].includes(job.status))job=await resumeReplicationJob(job.id,job.origin==='local_recomposition');
        recover=false;
        if(!mounted.current||serial!==loops.current[operation.kind])return;
        assertOperation(operation,job);
        const latest=latestKinds.current.get(job.kind);
        if(isFinalJob(job)&&(currentFingerprint.current&&currentFingerprint.current!==job.inputFingerprint||latest&&latest.id!==job.id&&latest.createdAt>job.createdAt)){
          if(readOperation(operation.kind)?.requestId===operation.requestId)forgetOperation(operation.kind);syncOperations();return;
        }
        operation={...operation,jobId:job.id};saveOperation(operation);apply(job,true);
        syncOperations();
        if(isFinalJob(job)||job.recoveryErrorCode||job.errorCode==='RESULT_DOWNLOAD_INTERRUPTED'||['submission_unknown','cancel_unknown'].includes(job.status))return;
      }catch(e){
        // Only repeat read-only lookups. Never repeat POST submission or resume.
        if(readingStatus&&(!(e as any).status||(e as any).status>=500)&&++readFailures<=2){await new Promise(r=>window.setTimeout(r,readFailures*1000));continue;}
        if(mounted.current&&serial===loops.current[operation.kind]){setPendingKind(previous=>previous===operation.kind?null:previous);syncOperations();setError(issue(e));setNotice('查询已中断。原请求仍保留，可重新连接或安全结束；不会自动重发。');}return;
      }
      await new Promise(r=>window.setTimeout(r,1600));
    }
  }
  async function restoreAll(){
    const serial=++restoreSerial.current;setRestoring(true);
    try{
      const snapshot=await getReplicationWorkbench();
      if(!mounted.current||serial!==restoreSerial.current)return;
      // Choose one material context before applying either concurrent response.
      const newest=[...snapshot.jobs].sort((a,b)=>b.createdAt-a.createdAt||b.updatedAt-a.updatedAt)[0];
      if(newest&&!currentFingerprint.current){currentFingerprint.current=newest.inputFingerprint;setFingerprint(newest.inputFingerprint);materialsJob.current=newest;
        setSource(materialFrom(newest.source));setReferences(newest.references.map(materialFrom));}
      const tracks=(['analysis','generation'] as const).map(async kind=>{
        let op=readOperation(kind),job=snapshot.jobs.find(j=>j.kind===kind);
        if(op&&job&&job.requestId!==op.requestId){
          // Another tab may have finished a newer task. Verify the old marker's
          // terminal state before replacing it; 404 alone never releases a fee lock.
          const old=await lookupOperation(op);
          if(old.closed||old.job&&isFinalJob(old.job)){forgetOperation(kind);op=null;}
          else job=undefined;
        }
        if(!op){const receipt=snapshot.requests.find(r=>r.kind===kind);if(!job&&!receipt)return;
          op=job?{kind,jobId:job.id,requestId:job.requestId,inputFingerprint:job.inputFingerprint,ownerId:ownerId()}:
            {kind,requestId:receipt!.requestId,inputFingerprint:receipt!.inputFingerprint,ownerId:ownerId()};saveOperation(op);syncOperations();}
        return track(op,true,job?{job,receipt:null,closed:false}:undefined);
      });
      // Polling may last minutes; it must not keep the refresh spinner locked.
      setRestoring(false);await Promise.all(tracks);
    }finally{if(mounted.current&&serial===restoreSerial.current)setRestoring(false);}
  }
  const refreshCapabilities=()=>getReplicationCapabilities().then(c=>{if(mounted.current)setCaps(c);}).catch(()=>{});
  useEffect(()=>{
    mounted.current=true;
    void refreshCapabilities();
    const initialize=async()=>{
      const recovering=restoreAll().catch(e=>{if(mounted.current)setError(issue(e));});
      const draft=await loadReplicationDraft(ownerId());
      if(!mounted.current)return;
      if(draft&&!currentFingerprint.current&&!materialsJob.current&&!source&&!references.length&&urls.current.size===0&&!readOperation('analysis')&&!readOperation('generation')){
        const material=(image:{file:File;width:number;height:number;angle?:string}):Material=>{
          const url=URL.createObjectURL(image.file);urls.current.add(url);
          return {id:crypto.randomUUID(),file:image.file,preview:url,width:image.width,height:image.height,angle:(image.angle||'other') as ReferenceAngle};
        };
        setSource(material(draft.source));setReferences(draft.references.map(material));setNotice('已恢复未提交的素材，请点击识别产品与替换位置。');
      }
      await recovering;
    };
    void initialize().catch(e=>{if(mounted.current)setError(issue(e));});
    window.addEventListener?.('focus',refreshCapabilities);
    if(userStorage.getItem('replication_active_job'))setNotice('检测到旧版任务标识，未自动关联到新版分析；历史费用与任务需单独核对。');
    return()=>{mounted.current=false;restoreSerial.current++;loops.current.analysis++;loops.current.generation++;window.removeEventListener?.('focus',refreshCapabilities);window.setTimeout(()=>{if(!mounted.current)urls.current.forEach(u=>URL.revokeObjectURL(u));},0);};
  },[]);
  useEffect(()=>{
    if(!currentFingerprint.current&&source?.file&&references.every(r=>r.file))void saveReplicationDraft(ownerId(),{version:1,source:{file:source.file,width:source.width,height:source.height},references:references.map(r=>({file:r.file!,width:r.width,height:r.height,angle:r.angle})),savedAt:Date.now()}).then(saved=>{
      if(saved&&mounted.current&&!currentFingerprint.current&&!operationBusy.current&&!readOperation('analysis')&&!readOperation('generation'))setNotice('素材已在本机保存，请点击识别产品与替换位置。');
    });
    const element=viewport.current;if(!element||!source)return;
    const fit=()=>setCanvasWidth(Math.max(1,Math.min(element.clientWidth,element.clientHeight*source.width/source.height)));
    fit();if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(fit);observer.observe(element);return()=>observer.disconnect();
  },[source?.width,source?.height,source?.file,references]);
  function stale(){
    if(feeLocked)return;
    setAnalysisJob(null);setGenerationJob(null);setAnalysisText('');setFingerprint('');currentFingerprint.current='';
    setSelectedIds([]);setMasks([]);setProtectMasks([]);setStrokes([]);paintRef.current=null;panRef.current=null;setZoom(100);setCandidate(null);setMode('original');setCostConfirmed(false);setError('');setNotice('素材已改变，请重新识别产品。');
    materialsJob.current=null;latestKinds.current.clear();setFailedImages([]);forgetOperation('analysis');forgetOperation('generation');
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
    operationBusy.current=true;setPendingKind('analysis');setError('');setNotice(`仅执行 ${REPLICATION_MODEL_NAMES.analysis} 产品文字分析，不会生成图片。`);
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
    if(sourceFailed){setError('请先重新加载场景图片，再确认替换范围。');return;}
    if(!validAnalysis||!analysisJob){setError('请先识别产品与替换位置。');return;}
    if(!brushReady||!selection.valid){setError('请在识别到的产品上涂抹，确认需要替换的范围。');return;}
    if(!costConfirmed){setError(`请确认本次会请求${count}个图像预测，费用以供应商记录为准。`);return;}
    operationBusy.current=true;setPendingKind('generation');setError('');setCostConfirmed(false);
    try{
      // User's explicit generation click confirms the visible analysis and brush
      // together. Revision is a local write and cannot create a prediction.
      let approved=analysisJob;
      if(!approved.analysis!.confirmedAt||approved.analysis!.text!==analysisText){approved=await reviseAnalysis(approved,analysisText);setAnalysisJob(approved);}
      const next=await startGeneration({inputFingerprint:fingerprint,analysisJobId:approved.id,analysisRevisionHash:approved.analysis!.revisionHash,
        selectedInstances:selection.selectedInstances,masks:[],protectMasks:[],brush,
        maskSpace:{width:analysisJob.source.width,height:analysisJob.source.height,sourceHash:analysisJob.source.sha256},
        resolution,count,preserve,notes,confirmedPredictions:count,outputMode:'model'});
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
    if(locked||!validAnalysis||!brushReady||sourceFailed||event.button!==0||paintRef.current||panRef.current)return;
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
  async function cancel(){if(!activeJob)return;try{const next=await cancelReplicationJob(activeJob.id,activeJob.origin==='local_recomposition');apply(next);const op=readOperation(next.kind);if(op)await track(op);}catch(e){setError(issue(e));}}
  async function reconnect(){setError('');try{await restoreAll();}catch(e){setError(issue(e));}}
  async function recoverOutput(){
    if(!generationJob?.outputRecoveryAvailable||locked||operationBusy.current)return;
    operationBusy.current=true;setPendingKind('generation');setError('');
    try{
      const next=await resumeReplicationJob(generationJob.id);
      const op:Operation={kind:'generation',jobId:next.id,requestId:next.requestId,inputFingerprint:next.inputFingerprint,ownerId:ownerId()};
      saveOperation(op);apply(next,true);syncOperations();await track(op);
    }catch(e){setError(issue(e));}finally{operationBusy.current=false;setPendingKind(null);syncOperations();}
  }
  async function safelyEnd(op:Operation){
    if(op.localOnly){forgetOperation(op.kind);syncOperations();setNotice('已结束等待本地测试，原图与任务记录保留；没有重新调用生图模型。');setError('');return;}
    try{const result=await closeOperation(op);syncOperations();if(result.job)apply(result.job);
      if(result.closed){setError('');setNotice('已确认未提交模型并封存原请求，可以重新提交。');}
      else setNotice('该请求已有预测记录，费用保护仍保留；请查询或取消原任务，不会重新创建预测。');
    }catch(e){setError(issue(e));}finally{setPendingKind(null);syncOperations();}
  }
  async function download(url:string,label:string){try{const response=await fetch(url,{credentials:'same-origin'});if(!response.ok)throw new Error('下载失败。');
    const u=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=u;a.download=`图像复刻_${label}_${Date.now()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(e){setError(issue(e));}}
  const originalUrl=candidate&&mode!=='original'?candidate.job.source.url:source?.preview;
  const preview=mode==='raw'?candidate?.result.raw.url:originalUrl;
  const polygonPoints=(p:Point[])=>p.map(v=>`${v.x*(source?.width||1)},${v.y*(source?.height||1)}`).join(' ');
  const feeReady=validAnalysis&&!locked&&caps.enabled&&caps.submission?.generation!==false;
  const generationReady=feeReady&&brushReady&&selection.valid&&!sourceFailed;
  const generatingAgain=!!generationJob?.results.length;
  const unavailable=!caps.enabled||!validAnalysis&&caps.submission?.analysis===false;
  const statusText=error||(failedImages.length?'图片加载失败，任务和生成结果已保留，请重新加载图片。':restoring?'正在恢复素材与生成结果…':pendingKind?pendingKind==='analysis'?'正在提交分析素材…':'正在提交生图任务…':activeJob?
    `${activeJob.kind==='analysis'?'产品分析':'图片生成'} · ${stages[activeJob.status]||'处理中'}`:unresolved.length?'提交结果待确认，请重新连接查询。':
    candidate?'图片已生成 · 可预览、对比和下载':unavailable?`产品分析入口暂未开放 · ${notice||'已保留上传素材。'}`:notice||(validAnalysis?'识别完成，请涂抹要替换的物品。':'上传场景与产品图片，识别后涂抹替换。'));
  const enlarge=(src:string|undefined,label:string)=>{if(src)setEnlarged({src,label});};
  const imageProps=(url:string,thumbnail:boolean|'canvas'=false)=>{
    const key=url+(thumbnail===true?'#thumbnail':thumbnail==='canvas'?'#canvas':'');
    return {src:replicationImageUrl(url,thumbnail,imageRetry),decoding:'async' as const,
      onError:()=>setFailedImages(previous=>previous.includes(key)?previous:[...previous,key]),
      onLoad:()=>setFailedImages(previous=>previous.includes(key)?previous.filter(v=>v!==key):previous)};
  };
  return <section className="rp-view" aria-label="图像复刻工作台">
    <header className="rp-heading"><h1>图像复刻</h1><div className={'rp-status-line '+(error?'rp-status-error':'')} role={error?'alert':'status'} title={statusText}>{statusText}</div>
      {failedImages.length>0&&<button className="rp-button" onClick={()=>setImageRetry(n=>n+1)}><RefreshCw/>重新加载图片</button>}
      {generationJob?.outputRecoveryAvailable&&<button className="rp-button" disabled={locked} onClick={recoverOutput}><RefreshCw/>取回已生成图片</button>}
      {(unresolved.length>0||activeJob)&&<div className="rp-actions"><button className="rp-button" disabled={!!pendingKind} onClick={reconnect}><RefreshCw/>重新连接查询</button>
        {unresolved.filter(op=>![analysisJob,generationJob].some(j=>j?.requestId===op.requestId&&!['submission_unknown','cancel_unknown'].includes(j.status))).map(op=><button key={op.requestId} className="rp-button" disabled={!!pendingKind} onClick={()=>safelyEnd(op)}>安全结束本次提交</button>)}
        {activeJob&&<button className="rp-button" onClick={cancel}>请求取消任务</button>}</div>}
    </header>
    <div className="rp-layout"><aside className="rp-card rp-materials">
      <div className="rp-card-title"><h2><Layers/>输入素材</h2><button className="rp-text" disabled={locked} onClick={()=>{if(window.confirm('清空本次素材与编辑？已保存的任务不会删除。')){stale();setSource(null);setReferences([]);void clearReplicationDraft(ownerId());}}}><Trash2/>清空</button></div>
      <div className="rp-section-label">场景原图{source&&<button className="rp-text" disabled={locked} onClick={()=>sourceInput.current?.click()}>更换</button>}</div>
      <div className="rp-source" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(e.dataTransfer.files,'source');}}>
        <button disabled={!source&&locked} onClick={()=>source?enlarge(source.preview,'场景原图'):sourceInput.current?.click()} aria-label={source?'放大场景原图':'上传场景原图'}>{source?<><img {...imageProps(source.preview,true)} alt="场景原图缩略图"/><span className="rp-upload-overlay"><Expand/>放大查看</span></>:<span className="rp-empty-upload"><ImagePlus/>上传场景原图</span>}</button>
        <input ref={sourceInput} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e=>{if(e.target.files)void upload(e.target.files,'source');e.target.value='';}}/></div>
      <div className="rp-section-label">新产品参考图<small>{references.length}/{caps.maxReferences}</small></div>
      <div className="rp-references" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(e.dataTransfer.files,'refs');}}>
        {references.map((r,i)=><div className="rp-reference" key={r.id}><button aria-label={`放大产品参考${i+1}`} onClick={()=>enlarge(r.preview,`产品参考${i+1}`)}><img {...imageProps(r.preview,true)} alt={`产品参考${i+1}`}/></button><button className="rp-remove" disabled={locked} aria-label={`移除参考${i+1}`} onClick={()=>{stale();setReferences(list=>list.filter(item=>item.id!==r.id));}}><X/></button><select aria-label={`参考${i+1}角度`} disabled={locked} value={r.angle} onChange={e=>{stale();setReferences(list=>list.map(item=>item.id===r.id?{...item,angle:e.target.value as ReferenceAngle}:item));}}>{Object.entries(angles).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></div>)}
        {references.length<caps.maxReferences&&<button disabled={locked} className="rp-add-ref" aria-label="添加产品参考" onClick={()=>refsInput.current?.click()}><Plus/>添加参考</button>}
        <input ref={refsInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e=>{if(e.target.files)void upload(e.target.files,'refs');e.target.value='';}}/></div>
      <p className="rp-hint">JPG / PNG / WEBP · 单张20 MB · 合计32 MB</p>
      <button className="rp-button rp-primary rp-wide" disabled={locked||!caps.enabled||caps.submission?.analysis===false} onClick={analyze}><ScanEye/>{pendingKind==='analysis'?'正在提交分析素材…':analysisJob&&!isFinalJob(analysisJob)?(['submission_unknown','cancel_unknown'].includes(analysisJob.status)?'分析任务待核对':'正在分析产品…'):unresolved.some(op=>op.kind==='analysis')?'分析提交待核对':'识别产品与替换位置'}</button>
      {validAnalysis&&<p className="rp-recognition">识别到：{analysisJob!.analysis!.data.new_product.category} · {instances.length} 个对应物品</p>}
      {validAnalysis&&<details className="rp-advanced"><summary>产品特征（可选调整）</summary><textarea aria-label="产品分析摘要" value={analysisText} disabled={locked} maxLength={16000} onChange={e=>{setAnalysisText(e.target.value);setCostConfirmed(false);}}/></details>}
      {analysisJob?.status==='failed'&&!!analysisJob.analysis?.rawText&&<details className="rp-advanced"><summary>查看未完成的分析返回（未启动生图）</summary><pre className="rp-json">{analysisJob.analysis.rawText}</pre></details>}
      <section className="rp-settings" aria-label="生成设置"><div className="rp-card-title"><h2><Sparkles/>生成图片</h2></div>
        <p className="rp-selection-summary">{!validAnalysis?'识别后，在原图上涂抹要替换的物品。':!instances.length?'未找到对应物品，请更换场景。':!brushReady?'历史分析无位置信息，请重新上传并识别。':selection.selectedInstances.length?`涂抹已对应到 ${selection.selectedInstances.length} 个物品`:'请在原图上涂抹想换掉的物品。'}{selection.painted>0&&!selection.valid&&' · 与产品位置不匹配'}</p>
        <textarea className="rp-notes" aria-label="补充要求" disabled={locked} value={notes} maxLength={4000} onChange={e=>{setNotes(e.target.value);setCostConfirmed(false);}} placeholder="补充要求（可选）"/>
        <div className="rp-output"><select aria-label="模型分辨率" disabled={locked} value={resolution} onChange={e=>{setResolution(e.target.value);setCostConfirmed(false);}}>{caps.resolutions.map(v=><option key={v}>{v}</option>)}</select><select aria-label="生成数量" disabled={locked} value={count} onChange={e=>{setCount(Number(e.target.value));setCostConfirmed(false);}}>{caps.counts.map(v=><option key={v} value={v}>{v} 张</option>)}</select></div>
        <label className="rp-cost" title="金额以供应商实际记录为准；失败或取消也可能计费。"><input aria-label="确认本次替换费用" type="checkbox" disabled={!feeReady} checked={costConfirmed} onChange={e=>setCostConfirmed(e.target.checked)}/>确认本次 {count} 张生图费用</label>
        <button className="rp-button rp-primary rp-wide" title={!caps.enabled?'当前新生图入口已关闭，已有图片仍可查看和下载。':generationReady&&!costConfirmed?'请先勾选费用确认。':undefined} disabled={!generationReady||!costConfirmed||painting} onClick={generate}><Sparkles/>{generatingAgain?'重新生成一张':'开始替换'}</button>
        {generationReady&&!costConfirmed&&<p className="rp-hint">勾选费用确认后即可生成。</p>}
        {feeReady&&!generationReady&&<p className="rp-hint">{sourceFailed?'请先重新加载场景图片，再涂抹确认。':selection.painted&&!selection.valid?'涂抹与AI定位不一致，请重新上传识别产品，或调整涂抹。':'请先在场景原图上涂抹要替换的商品。'}</p>}
      </section>
    </aside><section className="rp-card rp-preview">
      <div className="rp-preview-head"><div className="rp-tabs" role="tablist" aria-label="预览模式">{([['original','场景原图'],['raw','生成结果'],['compare','滑动对比']] as const).map(([key,label])=><button role="tab" aria-selected={mode===key} key={key} disabled={key!=='original'&&!candidate} className={mode===key?'rp-tab-active':''} onClick={()=>{setMode(key);setZoom(100);}}>{label}</button>)}</div>
        <div className="rp-actions"><button className="rp-button" aria-label="放大当前预览" disabled={!preview} onClick={()=>enlarge(mode==='compare'?candidate?.result.raw.url:preview,mode==='original'?'场景原图':'生成结果')}><Expand/>放大</button><button className="rp-button" disabled={!candidate} onClick={()=>candidate&&download(candidate.result.raw.url,'生成结果')}><Download/>下载图片</button></div></div>
      <div className="rp-brush-toolbar" aria-label="涂抹工具">{mode==='original'?<><div className="rp-mask-tools">{([['paint','画笔'],['erase','橡皮擦'],['pan','拖动画面']] as const).map(([value,label])=><button className={'rp-button '+(tool===value?'rp-tool-active':'')} key={value} aria-pressed={tool===value} disabled={locked||painting||!validAnalysis||!brushReady} onClick={()=>setTool(value)}>{label}</button>)}<button className="rp-button" disabled={locked||painting||!strokes.length} onClick={()=>{setStrokes(s=>s.slice(0,-1));setCostConfirmed(false);}}>撤销一笔</button><button className="rp-button" disabled={locked||painting||!strokes.length} onClick={()=>{setStrokes([]);setCostConfirmed(false);}}>清空涂抹</button></div><label>画笔<input aria-label="画笔大小" type="range" min="0.005" max="0.2" step="0.005" value={brushSize} disabled={locked} onChange={e=>setBrushSize(Number(e.target.value))}/></label><label>缩放<input aria-label="画布缩放" type="range" min="100" max="400" step="25" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/>{zoom}%</label></>:<span>{mode==='compare'?'拖动分割线，对比场景原图与生成结果。':'点击图片放大查看；滚轮缩放，按住拖动。'}</span>}</div>
      <div className="rp-canvas-wrap" ref={viewport}><div className="rp-canvas-center"><div className="rp-canvas" style={{width:source?canvasWidth*zoom/100:'100%',height:source?canvasWidth*zoom/100*source.height/source.width:350}}>
        {preview?<img className="rp-canvas-image" {...imageProps(preview,'canvas')} alt={mode==='original'||mode==='compare'?'场景原图':'生成结果'} onClick={mode==='raw'?()=>enlarge(preview,'生成结果'):undefined}/>:<div className="rp-canvas-empty"><ImagePlus/><p>上传场景与新产品图片</p><small>识别产品 → 涂抹确认 → 开始替换</small></div>}
        {mode==='compare'&&candidate&&<><img className="rp-canvas-image" {...imageProps(candidate.result.raw.url,'canvas')} alt="生成结果对比" style={{clipPath:`inset(0 0 0 ${split}%)`}}/><div className="rp-compare-line" style={{left:split+'%'}}><span><ArrowLeftRight/></span></div><input className="rp-compare-range" type="range" value={split} onChange={e=>setSplit(Number(e.target.value))} aria-label="原图与生成结果滑动对比"/></>}
        {source&&mode==='original'&&<svg className={'rp-region-svg '+(validAnalysis&&brushReady&&!locked?'rp-region-selecting':'')+' rp-tool-'+tool} viewBox={`0 0 ${source.width} ${source.height}`} preserveAspectRatio="xMidYMid meet" onPointerDown={beginBrush} onPointerMove={moveBrush} onPointerUp={endBrush} onPointerCancel={endBrush} onLostPointerCapture={()=>{paintRef.current=null;panRef.current=null;setPainting(false);}} onPointerLeave={()=>setCursor(null)} aria-label="涂抹替换范围画布">
          <defs><mask id={brushMaskId.current} maskUnits="userSpaceOnUse" x="0" y="0" width={source.width} height={source.height}><rect width={source.width} height={source.height} fill="black"/>{strokes.map((s,i)=>s.points.length===1?<circle key={i} cx={s.points[0].x*source.width} cy={s.points[0].y*source.height} r={s.size*Math.min(source.width,source.height)/2} fill={s.tool==='erase'?'black':'white'}/>:<polyline key={i} points={polygonPoints(s.points)} fill="none" stroke={s.tool==='erase'?'black':'white'} strokeWidth={s.size*Math.min(source.width,source.height)} strokeLinecap="round" strokeLinejoin="round"/>)}</mask></defs>
          <rect width={source.width} height={source.height} fill="#3074ff" opacity=".45" mask={`url(#${brushMaskId.current})`}/>
          {!strokes.length&&masks.filter(m=>selectedIds.includes(m.instanceId)).map(m=><polygon key={m.instanceId} points={polygonPoints(m.points)} fill="#3b75ef40"/>)}
          {!strokes.length&&protectMasks.map((p,i)=><polygon key={i} points={polygonPoints(p)} fill="#e85c5740"/>)}
          {cursor&&tool!=='pan'&&validAnalysis&&brushReady&&!locked&&<circle cx={cursor.x*source.width} cy={cursor.y*source.height} r={brushSize*Math.min(source.width,source.height)/2} fill="none" stroke={tool==='erase'?'#e55353':'#fff'} strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>}
        </svg>}
        {mode==='compare'&&<><span className="rp-image-label">场景原图</span><span className="rp-image-label rp-label-right">生成结果</span></>}
      </div></div></div>
    </section></div>{enlarged&&<ReplicationImageViewer key={enlarged.src} src={enlarged.src} label={enlarged.label} onClose={()=>setEnlarged(null)}/>}</section>;
};
