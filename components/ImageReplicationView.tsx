import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ArrowRight, Check, Download, Expand, ImagePlus, Layers, LoaderCircle, Plus, RefreshCw, ScanEye, Settings2, ShieldCheck, Sparkles, Trash2, X, PlugZap } from 'lucide-react';
import { ImageModal } from './ImageModal';
import { userStorage } from '../services/browserStorage';
import { startReplication, getReplicationJob, cancelReplicationJob, checkReplicationConnection, type PreserveKey, type ReferenceAngle, type ReplicationInput, type ReplicationJob, type ReplicationKind } from '../services/replicationService';
import './ImageReplicationView.css';

type Asset = { id: string; file: File; preview: string; width: number; height: number; angle: ReferenceAngle };
type Result = { url: string; source: string | null; resolution: string; time: number };
const angleLabels: Record<ReferenceAngle,string> = { front:'正面', side:'侧面', back:'背面', detail:'细节', other:'其他' };
const preserveLabels: Record<PreserveKey,string> = { background:'背景与道具', composition:'构图与位置', lighting:'光线与阴影', perspective:'角度与透视' };
const storageKey = 'replication_active_job';
const terminal = (job: ReplicationJob) => ['succeeded','failed','canceled'].includes(job.status);
const message = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
const wait = () => new Promise(resolve => window.setTimeout(resolve, 1600));

export const ImageReplicationView: React.FC = () => {
  const [source,setSource] = useState<Asset|null>(null);
  const [references,setReferences] = useState<Asset[]>([]);
  const [target,setTarget] = useState('');
  const [analysis,setAnalysis] = useState('');
  const [preserve,setPreserve] = useState<PreserveKey[]>(Object.keys(preserveLabels) as PreserveKey[]);
  const [resolution,setResolution] = useState('2K'), [count,setCount] = useState(1);
  const [notes,setNotes] = useState('');
  const [job,setJob] = useState<ReplicationJob|null>(null);
  const [working,setWorking] = useState(false), [reading,setReading] = useState(false);
  const [disconnected,setDisconnected] = useState(false), [connecting,setConnecting] = useState(false);
  const [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [results,setResults] = useState<Result[]>([]), [selected,setSelected] = useState<Result|null>(null);
  const [mode,setMode] = useState<'original'|'result'|'compare'>('original'), [split,setSplit] = useState(50);
  const [enlarged,setEnlarged] = useState<string|null>(null);
  const [dragging,setDragging] = useState<'source'|'refs'|null>(null);
  const [region,setRegion] = useState<ReplicationInput['region']>(null), [selecting,setSelecting] = useState(false);
  const regionAnchor=useRef<{x:number;y:number}|null>(null);
  const sourceInput = useRef<HTMLInputElement>(null), refsInput = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>()), mounted = useRef(true), tracking = useRef(0);
  const activeId = useRef<string|null>(null), operationSource = useRef<string|null>(null);
  const locked = working || reading;

  const invalidate = (clearHistory=false) => {
    setSelected(null);setMode('original');setError('');setNotice('');
    if(clearHistory)setResults([]);
  };
  const free = (asset: Asset|null) => {
    if(asset){URL.revokeObjectURL(asset.preview);objectUrls.current.delete(asset.preview);}
  };
  const applyJob = (next: ReplicationJob) => {
    if(!mounted.current)return;
    setJob(next);
    if(!terminal(next)){activeId.current=next.id;userStorage.setItem(storageKey,next.id);}
    if(next.kind==='analysis' && next.status==='succeeded' && next.analysis)setAnalysis(next.analysis);
    if(next.images.length) {
      const items = next.images.map(url=>({url,source:operationSource.current,resolution:next.resolution || '2K',time:next.createdAt}));
      setResults(previous=>[...items,...previous.filter(item=>!next.images.includes(item.url))].slice(0,8));
      const latest=items[items.length-1];setSelected(latest);
      setMode(latest.source?'compare':'result');setSplit(50);
    }
    if(terminal(next)){
      userStorage.removeItem(storageKey);activeId.current=null;
      if(next.error)setError(next.error);
      if(next.status==='canceled')setNotice('任务已取消，已完成的图片仍可下载。');
      if(next.status==='succeeded')setNotice(next.kind==='analysis'?'产品分析完成，可编辑后开始复刻。':'复刻完成，请对比检查产品结构、标识与场景细节。');
    }
  };
  async function track(id: string): Promise<ReplicationJob|null> {
    const run=++tracking.current;let failures=0;
    while(mounted.current && run===tracking.current){
      try {
        const next=await getReplicationJob(id);
        if(!mounted.current || run!==tracking.current)return null;
        failures=0;setDisconnected(false);applyJob(next);
        if(terminal(next))return next;
      } catch(err) {
        if(++failures>=3){
          if(mounted.current){setDisconnected(true);setError('连接中断，后台任务可能仍在运行。请点击“重新连接”，不要重复提交。');}
          return null;
        }
      }
      await wait();
    }
    return null;
  }
  useEffect(()=>{
    mounted.current=true;
    const id=userStorage.getItem(storageKey);
    if(id) {
      activeId.current=id;setWorking(true);setNotice('正在恢复上次任务…');
      void getReplicationJob(id).then(async next=>{
        if(!mounted.current)return;
        applyJob(next);
        if(!terminal(next))await track(id);
        if(mounted.current && !activeId.current)setWorking(false);
      }).catch(err=>{
        if(!mounted.current)return;
        // An expired task can be cleared; network failures must remain recoverable.
        if(message(err).includes('任务不存在')){userStorage.removeItem(storageKey);activeId.current=null;setWorking(false);}
        else setDisconnected(true);
        setError(message(err));
      });
    }
    return ()=>{mounted.current=false;tracking.current++;for(const url of objectUrls.current)URL.revokeObjectURL(url);objectUrls.current.clear();};
  },[]);
  async function readImage(file: File): Promise<Asset> {
    if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('仅支持 JPG、PNG、WEBP 图片。');
    if(file.size>20*1024*1024)throw new Error('单张图片不能超过 20 MB。');
    const preview=URL.createObjectURL(file), image=new Image();
    try {
      await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('图片无法读取，请确认文件未损坏。'));image.src=preview;});
      if(image.naturalWidth*image.naturalHeight>32*1024*1024)throw new Error('图片最多支持 3200 万像素，请缩小后上传。');
      if(!mounted.current)throw new Error('页面已关闭');
      objectUrls.current.add(preview);
      return {id:crypto.randomUUID(),file,preview,width:image.naturalWidth,height:image.naturalHeight,angle:'other'};
    } catch(err){URL.revokeObjectURL(preview);throw err;}
  }
  async function upload(files: FileList|File[], kind: 'source'|'refs') {
    if(locked || !files.length)return;
    setReading(true);setError('');const accepted:Asset[]=[];
    try {
      const candidates=Array.from(files);
      if(kind==='refs' && references.length+candidates.length>12)throw new Error('最多上传 12 张产品参考图。');
      if(kind==='source' && candidates.length>1)throw new Error('场景原图每次请选择 1 张。');
      const existingBytes=kind==='source'?references.reduce((sum,ref)=>sum+ref.file.size,0):
        (source?.file.size||0)+references.reduce((sum,ref)=>sum+ref.file.size,0);
      if(existingBytes+candidates.reduce((sum,file)=>sum+file.size,0)>32*1024*1024)throw new Error('原图和参考图合计不能超过 32 MB，请压缩图片后上传。');
      for(const file of candidates)accepted.push(await readImage(file));
      invalidate(true);setAnalysis('');
      if(kind==='source'){free(source);setSource(accepted[0]);setRegion(null);setSelecting(false);}
      else setReferences(previous=>[...previous,...accepted]);
    } catch(err){accepted.forEach(free);if(mounted.current)setError(message(err));}
    finally{if(mounted.current)setReading(false);}
  }
  function inputData(description=analysis): ReplicationInput {
    if(!source)throw new Error('请先上传场景原图。');
    if(!references.length)throw new Error('请至少上传一张产品参考图。');
    return {source:source.file,references:references.map(ref=>({file:ref.file,angle:ref.angle})),target:target.trim(),analysis:description,preserve,resolution,count,notes,region};
  }
  async function run(kind: ReplicationKind, input: ReplicationInput) {
    const next=await startReplication(kind,input);
    if(!mounted.current)return null;
    activeId.current=next.id;userStorage.setItem(storageKey,next.id);applyJob(next);
    return track(next.id);
  }
  async function start(kind: ReplicationKind) {
    if(locked || activeId.current)return;
    try {
      let input=inputData();
      if(kind==='generation'&&!region){setMode('original');setSelecting(true);throw new Error('请先在原图上框选完整产品及必要的接触阴影，区域外将保持原图。');}
      setWorking(true);setDisconnected(false);setError('');setNotice('正在提交任务…');
      setSelected(null);setMode('original');setJob(null);operationSource.current=source?.preview||null;
      if(kind==='analysis')await run('analysis',input);
      else {
        if(!input.analysis.trim()){
          const analyzed=await run('analysis',input);
          if(!analyzed || analyzed.status!=='succeeded' || !analyzed.analysis)return;
          input={...input,analysis:analyzed.analysis};
        }
        setNotice('');await run('generation',input);
      }
    } catch(err){
      if(mounted.current){
        setError(message(err));
        const pending=userStorage.getItem(storageKey);
        if(pending){activeId.current=pending;setDisconnected(true);}
      }
    }
    finally {if(mounted.current && !activeId.current)setWorking(false);}
  }
  async function reconnect() {
    const id=activeId.current;if(!id)return;
    setError('');setDisconnected(false);setWorking(true);
    // Direct read distinguishes expiration from a temporary outage.
    try {
      const next=await getReplicationJob(id);applyJob(next);
      if(!terminal(next))await track(id);
    } catch(err){
      if(message(err).includes('任务不存在')){userStorage.removeItem(storageKey);activeId.current=null;}
      else setDisconnected(true);
      setError(message(err));
    } finally {if(!activeId.current)setWorking(false);}
  }
  async function cancel() {
    if(!activeId.current)return;
    try {const next=await cancelReplicationJob(activeId.current);applyJob(next);if(disconnected)void reconnect();}
    catch(err){setError('取消请求未确认：'+message(err));}
  }
  function clear() {
    if(locked || !window.confirm('清空本次素材、产品描述和预览记录？电脑上的原文件不会被删除。'))return;
    objectUrls.current.forEach(url=>URL.revokeObjectURL(url));objectUrls.current.clear();
    invalidate(true);setSource(null);setReferences([]);setTarget('');setAnalysis('');setNotes('');setJob(null);setRegion(null);setSelecting(false);
  }
  async function checkConnection() {
    setConnecting(true);setError('');setNotice('');
    try{await checkReplicationConnection();setNotice('分析与生图模型均可访问。此检查不产生生图任务。');}
    catch(err){setError(message(err));}finally{setConnecting(false);}
  }
  async function download(result: Result) {
    try{
      const response=await fetch(result.url,{credentials:'same-origin'});
      if(!response.ok)throw new Error('下载失败，请检查登录状态后重试。');
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
      link.href=url;link.download='图像复刻_'+result.time+'_'+result.resolution+'.png';link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(err){setError(message(err));}
  }
  const drop = (kind:'source'|'refs') => ({
    onDragOver:(event:React.DragEvent)=>{event.preventDefault();if(!locked)setDragging(kind);},
    onDragLeave:(event:React.DragEvent)=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(null);},
    onDrop:(event:React.DragEvent)=>{event.preventDefault();setDragging(null);void upload(event.dataTransfer.files,kind);}
  });
  const regionPoint=(event:React.PointerEvent<SVGSVGElement>)=>{
    const transform=event.currentTarget.getScreenCTM();
    if(!transform||!source)return null;
    const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(transform.inverse());
    return {x:Math.min(1,Math.max(0,point.x/source.width)),y:Math.min(1,Math.max(0,point.y/source.height))};
  };
  const regionPointer={
    onPointerDown:(event:React.PointerEvent<SVGSVGElement>)=>{
      if(!selecting||locked||event.button!==0)return;
      const point=regionPoint(event);if(!point)return;
      event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
      invalidate();regionAnchor.current=point;setRegion(null);
    },
    onPointerMove:(event:React.PointerEvent<SVGSVGElement>)=>{
      const anchor=regionAnchor.current,point=regionPoint(event);if(!anchor||!point)return;
      setRegion({x:Math.min(anchor.x,point.x),y:Math.min(anchor.y,point.y),width:Math.abs(anchor.x-point.x),height:Math.abs(anchor.y-point.y)});
    },
    onPointerUp:(event:React.PointerEvent<SVGSVGElement>)=>{
      const anchor=regionAnchor.current,point=regionPoint(event);if(!anchor||!point)return;
      regionAnchor.current=null;setSelecting(false);
      const next={x:Math.min(anchor.x,point.x),y:Math.min(anchor.y,point.y),width:Math.abs(anchor.x-point.x),height:Math.abs(anchor.y-point.y)};
      if(next.width<.01||next.height<.01){setRegion(null);setError('框选范围太小，请拖动覆盖完整产品。');}
      else {setRegion(next);setNotice('替换区域已锁定。框外将保留原图，完整产品和必要的阴影应包含在框内。');}
    },
    onPointerCancel:()=>{regionAnchor.current=null;setSelecting(false);setRegion(null);}
  };
  const resultSource=selected?.source || source?.preview;
  const previewImage=mode==='result'?selected?.url:resultSource;
  const active=job && !terminal(job);
  return <section className="rp-view" aria-label="图像复刻工作台">
    <div className="rp-heading"><div><h1>图像复刻 <span>产品场景替换</span></h1><p>保留好场景，让画面里的主角换成你的产品。</p></div>
      <div className="rp-actions"><button className="rp-button" onClick={checkConnection} disabled={connecting||locked}>{connecting?<LoaderCircle className="rp-spin"/>:<PlugZap/>}检查连接</button><button className="rp-button rp-primary" onClick={()=>start('generation')} disabled={locked}><Sparkles/>开始复刻</button></div>
    </div>
    <div className="rp-workflow"><span>01 上传场景原图</span><ArrowRight/><span>02 添加产品参考</span><ArrowRight/><span>03 分析并复刻</span><small>o4-mini 分析 · Nano Banana 2 生图</small></div>
    {(error||notice)&&<div className={'rp-message '+(error?'rp-error':'')} role={error?'alert':'status'}>{error||notice}</div>}
    {disconnected&&<button className="rp-button" onClick={reconnect}><RefreshCw/>重新连接后台任务</button>}
    <div className="rp-layout">
      <section className="rp-card rp-materials">
        <div className="rp-card-title"><h2><Layers/>输入素材</h2><button className="rp-text" onClick={clear} disabled={locked}><Trash2/>清空</button></div>
        <div className="rp-section-label"><b>01</b>场景原图<small>1 张</small></div>
        <div className={'rp-source '+(dragging==='source'?'rp-drag':'')} {...drop('source')}>
          <button onClick={()=>sourceInput.current?.click()} disabled={locked} aria-label="上传或更换场景原图">
            {source?<><img src={source.preview} alt="场景原图缩略图"/><span className="rp-upload-overlay">点击更换原图</span></>:<span className="rp-empty-upload"><ImagePlus/><strong>拖入原图，或点击上传</strong><small>场景图、海报或其他产品图片</small></span>}
          </button>
          <input ref={sourceInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="上传场景原图" hidden onChange={event=>{if(event.target.files)void upload(event.target.files,'source');event.target.value='';}}/>
        </div>
        {source&&<div className="rp-file-meta"><span title={source.file.name}>{source.file.name}</span><small>{source.width} × {source.height}</small><button aria-label="移除原图" disabled={locked} onClick={()=>{invalidate(true);setAnalysis('');free(source);setSource(null);setRegion(null);setSelecting(false);}}><X/></button></div>}
        <div className="rp-section-label"><b>02</b>你的产品参考图<small>{references.length} / 12 张</small></div>
        <div className={'rp-references '+(dragging==='refs'?'rp-drag':'')} {...drop('refs')}>
          {references.map((ref,index)=><div className="rp-reference" key={ref.id}><button onClick={()=>setEnlarged(ref.preview)} aria-label={'放大参考图 '+(index+1)}><img src={ref.preview} alt={'产品参考图 '+(index+1)}/></button><button className="rp-remove" disabled={locked} aria-label={'删除参考图 '+(index+1)} onClick={()=>{invalidate(true);setAnalysis('');free(ref);setReferences(previous=>previous.filter(item=>item.id!==ref.id));}}><X/></button><select aria-label={'参考图 '+(index+1)+' 的角度'} value={ref.angle} disabled={locked} onChange={event=>{invalidate(true);setAnalysis('');setReferences(previous=>previous.map(item=>item.id===ref.id?{...item,angle:event.target.value as ReferenceAngle}:item));}}>{Object.entries(angleLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>)}
          {references.length<12&&<button className="rp-add-ref" disabled={locked} onClick={()=>refsInput.current?.click()}><Plus/><span>添加图片</span></button>}
          <input ref={refsInput} type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="上传多张产品参考图" hidden onChange={event=>{if(event.target.files)void upload(event.target.files,'refs');event.target.value='';}}/>
        </div>
        <p className="rp-hint">上传同一产品的正面、侧面、背面及细节。支持 JPG / PNG / WEBP；单张 20 MB，合计 32 MB。</p>
        <div className="rp-section-label"><b>03</b>产品特征<small>可编辑</small></div>
        <div className="rp-analysis-title"><ScanEye/>o4-mini 产品分析</div>
        <textarea className="rp-analysis" aria-label="产品特征分析" value={analysis} maxLength={16000} disabled={locked} onChange={event=>{invalidate();setAnalysis(event.target.value);}} placeholder="综合多角度图分析产品的结构、材质、颜色、标识及与原场景的关系。"/>
        <button className="rp-button rp-wide" disabled={locked} onClick={()=>start('analysis')}>{working&&job?.kind==='analysis'?<LoaderCircle className="rp-spin"/>:<ScanEye/>}{working&&job?.kind==='analysis'?'AI 正在分析产品…':analysis?'重新分析产品':'分析产品特征'}</button>
        <p className="rp-hint">{source&&references.length?'已添加场景原图和 '+references.length+' 张产品参考图，可直接分析。':'上传场景原图和产品参考图，即可由 AI 分析特征。'}无需先手填产品描述或框选。开始复刻时需框选替换区域。</p>
      </section>
      <div className="rp-right">
        <section className="rp-card rp-preview">
          <div className="rp-preview-head"><div className="rp-tabs" role="tablist" aria-label="预览模式">{([['original','原图'],['result','复刻效果'],['compare','滑动对比']] as const).map(([value,label])=><button role="tab" aria-selected={mode===value} key={value} className={mode===value?'rp-tab-active':''} disabled={value!=='original'&&(!selected||(value==='compare'&&!selected.source))} onClick={()=>setMode(value)}>{value==='compare'&&<ArrowLeftRight/>}{label}</button>)}</div><div className="rp-actions"><button className="rp-icon-button" title="放大查看" aria-label="放大当前图片" disabled={!previewImage} onClick={()=>previewImage&&setEnlarged(previewImage)}><Expand/></button><button className="rp-icon-button" title="下载结果" aria-label="下载复刻结果" disabled={!selected} onClick={()=>selected&&download(selected)}><Download/></button></div></div>
          {source&&<div className="rp-region-toolbar"><button className={'rp-button '+(selecting?'rp-primary':'')} disabled={locked} onClick={()=>{setMode('original');setSelecting(value=>!value);setError('');}}><ScanEye/>{selecting?'正在框选：在原图上拖动':region?'重新框选产品区域':'框选替换区域'}</button><small>{region?'区域已锁定 · 框外保持原图':'覆盖完整产品，并留出光影适配空间'}</small></div>}
          <div className="rp-canvas-wrap"><div className="rp-canvas" style={{aspectRatio:source?source.width/source.height:1.6}}>
            {previewImage?<img className="rp-canvas-image" src={previewImage} alt={mode==='result'?'复刻生成结果':'场景原图'}/>:<div className="rp-canvas-empty"><ImagePlus/><p>你的产品，即将成为画面主角</p><small>上传场景原图和产品参考图后开始</small></div>}
            {mode==='compare'&&selected&&<><img className="rp-canvas-image" src={selected.url} alt="替换后的产品场景" style={{clipPath:'inset(0 0 0 '+split+'%)'}}/><div className="rp-compare-line" style={{left:split+'%'}}><span><ArrowLeftRight/></span></div><input type="range" min="0" max="100" value={split} onChange={event=>setSplit(Number(event.target.value))} aria-label="原图与复刻效果滑动对比" className="rp-compare-range"/></>}
            {source&&mode==='original'&&!working&&<svg className={'rp-region-svg '+(selecting?'rp-region-selecting':'')} viewBox={'0 0 '+source.width+' '+source.height} preserveAspectRatio="xMidYMid meet" aria-label="产品替换区域框选画布" {...regionPointer}>{region&&<rect x={region.x*source.width} y={region.y*source.height} width={region.width*source.width} height={region.height*source.height} fill="#3b75ef16" stroke="#4b80e8" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"/>}</svg>}
            {previewImage&&<span className="rp-image-label">{mode==='result'?'复刻效果':'场景原图'}</span>}
            {mode==='compare'&&<span className="rp-image-label rp-label-right">替换后</span>}
            {working&&<div className="rp-progress" role="status"><LoaderCircle className="rp-spin"/><h3>{disconnected?'等待重新连接':job?.status==='canceling'?'正在取消远端任务':job?.kind==='analysis'&&active?'正在分析产品与场景':job?.kind==='generation'&&active?'正在生成第 '+Math.min(job.completed+1,job.total)+' / '+job.total+' 张':'正在准备任务'}</h3><p>{job?.kind==='generation'? 'Nano Banana 2 · 已完成 '+job.completed+' 张':'o4-mini · 多角度产品理解'}</p>{active&&job?.kind==='generation'&&<progress value={job.completed} max={job.total}/>}<button className="rp-button" disabled={!activeId.current||job?.status==='canceling'} onClick={cancel}>取消任务</button><small>取消会请求停止远端任务；已完成的调用仍可能计费。</small></div>}
          </div><div className="rp-canvas-footer"><span>{selected?'模型生成 + 原图区域合成 · 请核对产品细节':'上传素材预览'}</span><span>{selected?'模型 '+selected.resolution+' · 输出原图尺寸':source?source.width+' × '+source.height:'跟随原图比例'}</span></div></div>
          <div className="rp-preserve-strip"><ShieldCheck/>场景保留{preserve.map(key=><span key={key}><Check/>{preserveLabels[key]}</span>)}</div>
        </section>
        <section className="rp-card rp-settings"><div className="rp-card-title"><h2><Settings2/>复刻设置</h2><small>场景跟随原图 · 产品忠于参考</small></div>
          <label className="rp-target"><span>替换对象（可选）</span><input value={target} maxLength={500} disabled={locked} onChange={event=>{invalidate();setTarget(event.target.value);setAnalysis('');}} placeholder="留空由 AI 识别；有多个同类产品时可指定，例如：抬起的脚上的鞋"/></label>
          <div className="rp-settings-grid"><div><span className="rp-field-label">框内生成约束</span><div className="rp-locks">{Object.entries(preserveLabels).map(([key,label])=><label key={key}><input type="checkbox" disabled={locked} checked={preserve.includes(key as PreserveKey)} onChange={event=>{invalidate();setPreserve(previous=>event.target.checked?[...previous,key as PreserveKey]:previous.filter(item=>item!==key));}}/>{label}</label>)}</div><p className="rp-hint">新产品结构以参考图为准；框外始终保留原图。</p></div><div><span className="rp-field-label">模型输出设置</span><div className="rp-output"><select aria-label="输出分辨率" value={resolution} disabled={locked} onChange={event=>{invalidate();setResolution(event.target.value);}}>{['1K','2K','4K'].map(value=><option key={value} value={value}>{value} 模型分辨率</option>)}</select><select aria-label="生成数量" value={count} disabled={locked} onChange={event=>{invalidate();setCount(Number(event.target.value));}}>{[1,2,4].map(value=><option key={value} value={value}>生成 {value} 张</option>)}</select></div><p className="rp-hint">按原图尺寸合成 PNG，保留框外像素。多张结果逐张生成。</p></div></div>
          <details className="rp-advanced"><summary>补充要求与细节约束</summary><textarea aria-label="补充复刻要求" value={notes} maxLength={4000} disabled={locked} onChange={event=>{invalidate();setNotes(event.target.value);}} placeholder="例如：保留标签上的全部文字，不改变右侧绿植与底座。"/></details>
          <div className="rp-generate-row"><button className="rp-button rp-primary" disabled={locked} onClick={()=>start('generation')}>{working?<LoaderCircle className="rp-spin"/>:<Sparkles/>}{working?'处理进行中':'开始复刻'}<ArrowRight/></button><p>o4-mini 分析 · Nano Banana 2 生图<br/><span>严格保留场景为生成目标，请通过对比核验最终结果。</span></p></div>
        </section>
        {!!results.length&&<section className="rp-card rp-history"><div className="rp-card-title"><h2>本次生成记录</h2><small>图片已保存到当前账号</small></div><div>{results.map((result,index)=><button key={result.url} className={selected?.url===result.url?'rp-selected':''} onClick={()=>{setSelected(result);setMode(result.source?'compare':'result');}} aria-label={'查看结果 '+(index+1)}><img src={result.url} alt={'复刻结果 '+(index+1)}/><span>{result.resolution} · {new Date(result.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span></button>)}</div></section>}
      </div>
    </div>
    {enlarged&&<ImageModal src={enlarged} onClose={()=>setEnlarged(null)}/>}
  </section>;
};
