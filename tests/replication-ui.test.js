// Runs the actual TS service and TSX handlers in memory. React hooks/DOM and all
// HTTP responses are mocked; no real HTTP implementation enters this sandbox.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const {randomUUID,webcrypto}=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const root=process.cwd();
const contract=require(path.join(root,'shared/replication-contract.js'));
const realSetTimeout=setTimeout;

function harness(mode,storage=new Map(),serverSnapshot=null){
  let cursor=0,values=[],effects=[],effectMounted=false,tree,memoComputations=0;
  const calls=[],timeouts=[],downloads=[];let accepted=0,remoteCreates=0,currentJob=serverSnapshot?.currentJob||null,receipt=serverSnapshot?.receipt||null,lookupFailures=serverSnapshot?.lookupFailures||0;
  const storageApi={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useState:initial=>{const i=cursor++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value;}];},
    useRef:initial=>{const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];},
    useMemo:(fn,deps)=>{const i=cursor++;if(!(i in values)||deps.some((v,n)=>!Object.is(v,values[i].deps[n]))){memoComputations++;values[i]={deps,value:fn()};}return values[i].value;},
    useEffect:effect=>{cursor++;if(!effectMounted)effects.push(effect);}};
  const response=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  const makeJob=(payload,status)=>({id:randomUUID(),jobId:'unused',ownerId:'owner-incident',requestId:payload.requestId,kind:'analysis',status,stage:status,
    inputFingerprint:payload.inputFingerprint,sourceHash:'a'.repeat(64),revision:1,createdAt:Date.now(),updatedAt:Date.now(),completed:status==='succeeded'?1:0,total:1,
    source:{name:'source.png',url:'/fake-source.png',width:96,height:64,sha256:'a'.repeat(64)},
    references:[{name:'ref-1.png',url:'/fake-reference.png',width:96,height:64,angle:'other'}],target:'',results:[],images:[],predictions:[],
    errorCode:status==='submission_unknown'?'SUBMISSION_UNKNOWN':null,error:status==='submission_unknown'?'提交待核对':null,
    analysis:status==='succeeded'?{data:{new_product:{category:'鞋'},scene:{old_product_instances:[{instance_id:'left',location:'画面左侧鞋',bbox:[.05,.15,.4,.65],occluders:[]},{instance_id:'right',location:'画面右侧鞋',bbox:[.55,.15,.4,.65],occluders:[]}]}},text:'MOCK 产品分析文字',rawText:'MOCK_ONLY',revision:1,revisionHash:'h',confirmedAt:null}:null});
  const fakeFetch=async(url,options={})=>{
    assert.equal(typeof url,'string');assert(url.startsWith('/api/replication/')||url==='/fake-raw.png','Non-local fetch blocked');
    new Headers(options.headers); // Real browser Fetch header validation, before any request can reach a server.
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;calls.push({method,url,requestId:body?.requestId,body});
    if(url==='/fake-raw.png')return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});
    if(url.endsWith('/capabilities'))return response(200,{enabled:!mode.startsWith('retry-'),maxReferences:6,counts:[1],resolutions:['1K','2K'],...(mode==='no-segmenter'?{adaptiveComposition:{configured:false}}:{}),...(mode==='generation-only'?{submission:{analysis:false,generation:true}}:{})});
    if(url.endsWith('/workbench'))return response(200,{jobs:serverSnapshot?.workbenchJobs||[],requests:receipt&&['reserved','preparing'].includes(receipt.state)?[receipt]:[]});
    if(url.includes('/active?'))return response(200,{jobs:[],requests:receipt&&url.endsWith(receipt.kind)&&['reserved','preparing'].includes(receipt.state)?[receipt]:[]});
    if(url.endsWith('/requests')&&method==='POST'){
      if(mode==='offline')throw new TypeError('MOCK disconnected');
      receipt={...body,ownerId:'owner-incident',state:'reserved',jobId:null,revision:0};return response(202,receipt);
    }
    if(url.includes('/requests/')&&url.endsWith('/close')){
      if(['offline','cannot-seal'].includes(mode))throw new TypeError('MOCK disconnected');
      receipt={...body,ownerId:'owner-incident',state:currentJob?'accepted':'closed',jobId:currentJob?.id||null,revision:1};
      return response(200,{closed:!currentJob,receipt,job:currentJob});
    }
    if(url.includes('/requests/')){
      if(mode==='offline')throw new TypeError('MOCK disconnected');
      return receipt?response(200,receipt):response(404,{errorCode:'JOB_NOT_FOUND'});
    }
    if(method==='POST'&&url.endsWith('/analysis')){
      if(mode==='preparation-failure'){
        receipt={...receipt,state:'closed',revision:receipt.revision+1};
        return response(500,{errorCode:'ASSET_PREPARATION_FAILED'});
      }
      if(mode==='503')return response(503,{errorCode:'QUEUE_BUSY'});
      if(['401','403','413','422'].includes(mode))return response(Number(mode),{errorCode:'INPUT_INVALID'});
      if(['timeout-before-accept','cannot-seal'].includes(mode))return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
      accepted++;remoteCreates++;
      currentJob=makeJob(body,mode==='unknown'?'submission_unknown':'succeeded');
      if(mode==='truncated-analysis')currentJob={...currentJob,status:'failed',stage:'failed',errorCode:'ANALYSIS_SCHEMA_INVALID',error:contract.ERROR_MESSAGES.ANALYSIS_SCHEMA_INVALID,
        analysis:{data:null,text:'',rawText:'{"schema_version":"1.0","new_product":{',revision:0,revisionHash:null,confirmedAt:null}};
      receipt={...receipt,state:'accepted',jobId:currentJob.id};
      if(mode==='lost-ack')throw new TypeError('MOCK response lost');
      return response(202,currentJob);
    }
    if(method==='POST'&&url.endsWith('/revision')){currentJob={...currentJob,analysis:{...currentJob.analysis,text:body.text,revisionHash:'confirmed-h',confirmedAt:Date.now()},revision:2};return response(200,currentJob);}
    if(method==='POST'&&url.endsWith('/generation')){
      accepted++;remoteCreates++;currentJob={...makeJob(body,'completed_needs_review'),kind:'generation',analysis:null,input:body,analysisJobId:body.analysisJobId};return response(202,currentJob);
    }
    if(method==='POST'&&url.endsWith('/recompose')){
      assert(mode.startsWith('retry-'));assert(!new Headers(options.headers).has('x-replicate-token'));
      if(mode==='retry-rejected')return response(422,{errorCode:'INPUT_INVALID'});
      if(mode==='retry-offline')throw new TypeError('Local response unavailable');
      await pause(10);
      currentJob={...currentJob,id:randomUUID(),requestId:body.requestId,origin:'local_recomposition',derivedFrom:currentJob.id,revision:1,stage:'completed_needs_review',
        status:'completed_needs_review',errorCode:null,error:null,input:{...currentJob.input,contourHints:body.hints},
        results:[{raw:currentJob.results[0].raw,composite:{name:'composite-1.png',url:'/fake-composite.png'},quality:{status:'needs_review',mechanism:'adaptive-v1',reasons:['HUMAN_PRODUCT_IDENTITY_REVIEW_REQUIRED']}}]};
      if(mode==='retry-contour')currentJob={...currentJob,status:'quality_failed',stage:'quality_failed',errorCode:'QUALITY_FAILED',error:contract.ERROR_MESSAGES.QUALITY_FAILED,quality:{status:'failed',reasons:['CONTOUR_UNCERTAIN']},results:currentJob.results.map(r=>({...r,composite:null,quality:{status:'failed',reasons:['CONTOUR_UNCERTAIN']}}))};
      if(mode==='retry-lost-ack')throw new TypeError('Local ACK lost');
      return response(202,currentJob);
    }
    if(url.includes('/request/'))return currentJob&&url.endsWith(currentJob.requestId)?response(200,currentJob):response(404,{errorCode:'JOB_NOT_FOUND'});
    if(mode==='output-recovery'&&method==='POST'&&url.endsWith('/resume')){
      currentJob={...currentJob,status:'completed_needs_review',stage:'completed_needs_review',revision:2,errorCode:null,error:null,outputRecoveryAvailable:false,
        results:[{raw:{url:'/fake-raw.png'},composite:null,quality:{status:'needs_review'}}]};return response(200,currentJob);
    }
    if(url.includes('/jobs/')){if(lookupFailures-->0)throw new TypeError('Mock lost GET response');const job=mode==='output-recovery'?currentJob:serverSnapshot?.jobs?.[url.split('/jobs/')[1]]||currentJob;return job?response(200,job):response(404,{errorCode:'JOB_NOT_FOUND'});}
    throw new Error('Unexpected mock route '+method+' '+url);
  };
  class FakeImage{naturalWidth=96;naturalHeight=64;set src(v){queueMicrotask(()=>this.onload());}}
  const moduleCache=new Map();
  class FakePoint{constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}}
  const context=vm.createContext({crypto:webcrypto,TextEncoder,Uint8Array,ArrayBuffer,URL,File,Blob,DOMPoint:FakePoint,
    fetch:fakeFetch,AbortSignal:{timeout:ms=>{timeouts.push(ms);return AbortSignal.timeout(['timeout-before-accept','cannot-seal'].includes(mode)?15:ms);}},
    window:{setTimeout:(fn)=>realSetTimeout(fn,1),confirm:()=>true},document:{createElement:()=>({href:'',download:'',click(){downloads.push({href:this.href,download:this.download});}})},setTimeout:realSetTimeout,Image:FakeImage,console});
  function compile(relative){
    if(moduleCache.has(relative))return moduleCache.get(relative);
    const source=fs.readFileSync(path.join(root,relative),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
    const module={exports:{}};
    const requireFake=name=>{
      if(name==='react')return {__esModule:true,default:react,...react};
      if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
      if(name.endsWith('ReplicationImageViewer'))return {ReplicationImageViewer:'ReplicationImageViewer'};
      if(name.endsWith('ReplicationContourEditor'))return compile('components/ReplicationContourEditor.tsx');
      if(name.endsWith('.css'))return {};
      if(name.endsWith('browserStorage'))return {userStorage:storageApi,getStorageUser:()=> 'owner-incident'};
      if(name.endsWith('replicationDraft')){const draft=compile('services/replicationDraft.ts');return serverSnapshot?.draft?{...draft,loadReplicationDraft:async()=>serverSnapshot.draft}:draft;}
      if(name.endsWith('userIdentity'))return {getUserId:()=> 'owner-incident'};
      if(name.endsWith('replicateService'))return {fileToBase64:async file=>'data:image/png;base64,'+Buffer.from(await file.arrayBuffer()).toString('base64')};
      if(name.endsWith('replication-contract.js'))return contract;
      if(name.endsWith('replication-brush.js'))return require(path.join(root,'shared/replication-brush.js'));
      if(name.endsWith('replicationService'))return compile('services/replicationService.ts');
      throw new Error('Unapproved module '+name);
    };
    vm.runInContext('(function(require,module,exports){'+code+'\n})',context,{filename:relative})(requireFake,module,module.exports);
    moduleCache.set(relative,module.exports);return module.exports;
  }
  const Component=compile('components/ImageReplicationView.tsx').ImageReplicationView;
  function render(){cursor=0;tree=Component();return tree;}
  function nodes(value){if(!value)return [];if(Array.isArray(value))return value.flatMap(nodes);if(typeof value!=='object')return [];return [value,...nodes(value.props?.children)];}
  function label(value){if(Array.isArray(value))return value.map(label).join('');if(typeof value==='string'||typeof value==='number')return String(value);return value?.props?label(value.props.children):'';}
  function button(text){return nodes(tree).find(node=>node.type==='button'&&(label(node).includes(text)||node.props['aria-label']?.includes(text)));}
  async function click(text){render();const node=button(text);assert(node,'Button missing: '+text);assert(!node.props.disabled,'Button disabled: '+text);await node.props.onClick();render();}
  async function upload(){
    for(const refs of [false,true]){render();const input=nodes(tree).find(node=>node.type==='input'&&node.props.type==='file'&&!!node.props.multiple===refs);
      input.props.onChange({target:{files:[new File([new Uint8Array([1,2,3])],refs?'ref.png':'scene.png',{type:'image/png'})],value:'x'}});
      await pause(5);render();}
  }
  async function mountEffects(){effects.forEach(fn=>fn());effectMounted=true;await pause(15);render();}
  async function waitFor(predicate){const deadline=Date.now()+1500;do{render();if(predicate())return;await pause(5);}while(Date.now()<deadline);assert.fail('Mock UI did not reach the expected state');}
  function change(label,value){render();const node=nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']===label);assert(node);assert(!node.props.disabled);node.props.onChange({target:{value,checked:value}});render();}
  async function paint(points){
    const element={getScreenCTM:()=>({inverse:()=>({})}),setPointerCapture:()=>{},hasPointerCapture:()=>true,releasePointerCapture:()=>{}};
    for(let n=0;n<points.length;n++){render();const svg=nodes(tree).find(node=>node.props?.['aria-label']==='涂抹替换范围画布');assert(svg);
      const e={clientX:points[n].x*96,clientY:points[n].y*64,pointerId:1,button:0,currentTarget:element,preventDefault:()=>{}};
      svg.props[n?'onPointerMove':'onPointerDown'](e);
    }
    render();nodes(tree).find(node=>node.props?.['aria-label']==='涂抹替换范围画布').props.onPointerUp({pointerId:1,currentTarget:element});render();
  }
  render();
  return {storage,calls,timeouts,downloads,render,button,click,upload,mountEffects,waitFor,change,paint,nodes:()=>nodes(tree),snapshot:()=>({receipt,currentJob}),label:()=>label(tree),counts:()=>({accepted,remoteCreates}),memoComputations:()=>memoComputations,service:compile('services/replicationService.ts')};
}

test('interrupted upload: durable seal ends loading, clears the orphan only after acknowledgment, and permits a new submit',async()=>{
  const h=harness('timeout-before-accept');await h.upload();await h.click('识别产品与替换位置');
  assert.equal(h.counts().remoteCreates,0);assert(h.label().includes('已安全结束'));assert(!h.button('识别产品与替换位置').props.disabled);
  assert(!h.storage.has('replication_v2_analysis'));assert(h.timeouts.includes(60000));
  assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,1);
  assert(h.calls.some(c=>c.url.endsWith('/close')));
});
test('503 without a job is safely sealed; no permanent busy state and no paid retry',async()=>{
  const h=harness('503');await h.upload();await h.click('识别产品与替换位置');assert.equal(h.counts().accepted,0);
  assert(!h.button('识别产品与替换位置').props.disabled);assert(!h.storage.has('replication_v2_analysis'));assert(h.label().includes('任务队列繁忙'));
});
test('server-closed preparation failure keeps its real error and selected files; no automatic or generation retry',async()=>{
  const h=harness('preparation-failure');await h.upload();await h.click('识别产品与替换位置');
  assert(h.label().includes('素材已收到，但服务器处理失败'));assert(!h.label().includes('本次请求已安全结束'));
  assert(!h.button('识别产品与替换位置').props.disabled);assert(!h.storage.has('replication_v2_analysis'));
  assert.equal(h.counts().remoteCreates,0);assert(!h.calls.some(c=>c.url.endsWith('/generation')));
  const first=h.calls.find(c=>c.url.endsWith('/analysis'));
  assert(!h.calls.some(c=>c.url.endsWith('/close')),'already-closed receipt needs no second seal');
  await h.click('识别产品与替换位置');
  const posts=h.calls.filter(c=>c.url.endsWith('/analysis'));assert.equal(posts.length,2);
  assert.notEqual(posts[1].requestId,first.requestId);assert.equal(posts[1].body.sourceImage,first.body.sourceImage);
  assert.deepEqual(posts[1].body.references,first.body.references);assert.equal(h.counts().remoteCreates,0);
});
test('404 alone keeps fee protection, but refresh always exposes reconnect and safe-end; a seal acknowledgment releases it',async()=>{
  const h=harness('cannot-seal');await h.upload();await h.click('识别产品与替换位置');
  assert(h.storage.has('replication_v2_analysis'));assert(h.button('分析提交待核对').props.disabled);
  assert(!h.button('检查连接'));assert(!h.button('重新连接查询').props.disabled);assert(!h.label().includes('正在提交分析素材'));
  const refreshed=harness('legacy-orphan',h.storage);await refreshed.mountEffects();
  assert(refreshed.button('重新连接查询'));assert(refreshed.button('安全结束本次提交'));assert(refreshed.button('分析提交待核对').props.disabled);
  await refreshed.click('重新连接查询');assert(refreshed.storage.has('replication_v2_analysis'));
  await refreshed.click('安全结束本次提交');assert(!refreshed.storage.has('replication_v2_analysis'));assert(!refreshed.button('识别产品与替换位置').props.disabled);
  assert.equal(refreshed.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,0);
});
test('unknown provider submission is labeled pending reconciliation, keeps fee protection and never creates again',async()=>{
  const h=harness('unknown');await h.upload();await h.click('识别产品与替换位置');
  assert(h.label().includes('提交待核对'));assert(h.button('分析任务待核对').props.disabled);await h.click('重新连接查询');await h.click('安全结束本次提交');
  assert(h.storage.has('replication_v2_analysis'));assert.equal(h.counts().remoteCreates,1);assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,1);
});
test('lost POST acknowledgment recovers the durable completed job with GET and fills text',async()=>{
  const h=harness('lost-ack');await h.upload();await h.click('识别产品与替换位置');
  assert(!h.button('识别产品与替换位置').props.disabled);assert(h.label().includes('识别完成'));
  assert.equal(h.counts().remoteCreates,1);assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,1);
});
test('truncated analysis unlocks the page, exposes incomplete raw text for audit, and cannot enable generation after refresh',async()=>{
  const h=harness('truncated-analysis');await h.upload();await h.click('识别产品与替换位置');
  assert(h.label().includes('分析返回不完整'));assert(h.label().includes('查看未完成的分析返回（未启动生图）'));
  assert(h.label().includes('schema_version'));assert(!h.button('识别产品与替换位置').props.disabled);assert(h.button('开始替换').props.disabled);
  assert.equal(h.counts().remoteCreates,1);assert(!h.calls.some(c=>c.url.endsWith('/generation')));
  const refreshed=harness('normal',h.storage,h.snapshot());await refreshed.mountEffects();
  assert(refreshed.label().includes('查看未完成的分析返回（未启动生图）'));assert(refreshed.button('开始替换').props.disabled);
  assert.equal(refreshed.counts().remoteCreates,0);assert(!refreshed.calls.some(c=>c.url.endsWith('/analysis')||c.url.endsWith('/generation')));
});
test('REAL UI/service: definitive 401/403/413/422 rejection clears pending state and does not create a prediction',async()=>{
  for(const status of ['401','403','413','422']){const h=harness(status);await h.upload();await h.click('识别产品与替换位置');
    assert(!h.button('识别产品与替换位置').props.disabled);assert(!h.storage.has('replication_v2_analysis'));assert.equal(h.counts().remoteCreates,0);}
});
test('REAL UI/service: duplicate concurrent handler calls create only one mock analysis and zero generation calls',async()=>{
  const h=harness('lost-ack');await h.upload();const node=h.button('识别产品与替换位置');await Promise.all([node.props.onClick(),node.props.onClick()]);h.render();
  assert.equal(h.counts().remoteCreates,1);assert.equal(h.calls.filter(c=>c.url.endsWith('/generation')).length,0);
});
test('invalid token header is rejected before reserving or saving an operation; loading and fee lock both release',async()=>{
  for(const token of ['bad\r\nheader','中文占位符']){
    const h=harness('lost-ack',new Map([['replicate_api_token',token]]));await h.upload();await h.click('识别产品与替换位置');
    assert.equal(h.calls.length,0);assert.equal(h.counts().remoteCreates,0);
    assert(h.label().includes('API Key 含无效字符'));assert(!h.button('识别产品与替换位置').props.disabled);
    assert(!h.storage.has('replication_v2_analysis'));
  }
});
test('complete network loss ends the UI spinner while preserving a visible, queryable fee guard',async()=>{
  const h=harness('offline');await h.upload();await h.click('识别产品与替换位置');
  assert(h.storage.has('replication_v2_analysis'));assert(h.button('分析提交待核对').props.disabled);
  assert(!h.label().includes('正在提交分析素材'));assert(h.button('重新连接查询'));assert(h.button('安全结束本次提交'));
  assert.equal(h.counts().remoteCreates,0);
});
test('lost local marker can discover the durable server intake after refresh and end it without a prediction',async()=>{
  const h=harness('cannot-seal');await h.upload();await h.click('识别产品与替换位置');
  const refreshed=harness('normal',new Map(),h.snapshot());await refreshed.mountEffects();
  assert(refreshed.storage.has('replication_v2_analysis'));assert(refreshed.button('安全结束本次提交'));
  await refreshed.click('安全结束本次提交');assert(!refreshed.button('识别产品与替换位置').props.disabled);
  assert.equal(refreshed.counts().remoteCreates,0);assert(!refreshed.calls.some(c=>c.url.endsWith('/analysis')));
});

test('simplified workflow needs no target text, instance checkbox or separate analysis confirmation; paint alone never generates',async()=>{
  const h=harness('normal');await h.upload();await h.click('识别产品与替换位置');
  assert(h.label().includes('识别到：鞋'));assert(!h.label().includes('替换对象（'));assert(!h.button('确认分析内容'));assert(!h.button('绘制编辑范围'));
  assert(h.button('开始替换').props.disabled);await h.paint([{x:.2,y:.4},{x:.3,y:.5}]);
  assert(h.label().includes('涂抹已对应到 1 个物品'));assert.equal(h.counts().remoteCreates,1);
  assert(!h.calls.some(c=>c.url.endsWith('/generation')));assert(h.button('开始替换').props.disabled);
  h.change('确认本次替换费用',true);await h.click('开始替换');
  const gen=h.calls.filter(c=>c.url.endsWith('/generation'));assert.equal(gen.length,1);assert.deepEqual(gen[0].body.selectedInstances,['left']);
  assert.equal(gen[0].body.brush.strokes.length,1);assert.equal(gen[0].body.masks.length,0);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/revision')).length,1);assert.equal(h.counts().remoteCreates,2);
});

test('paint/erase/undo/clear automatically recheck one or two subjects and invalidate the previous fee confirmation',async()=>{
  const h=harness('normal');await h.upload();await h.click('识别产品与替换位置');
  await h.paint([{x:.2,y:.4},{x:.3,y:.5}]);await h.paint([{x:.7,y:.4},{x:.8,y:.5}]);assert(h.label().includes('涂抹已对应到 2 个物品'));
  h.change('确认本次替换费用',true);await h.click('橡皮擦');h.change('画笔大小',.2);await h.paint([{x:.7,y:.4},{x:.8,y:.5}]);
  assert(h.label().includes('涂抹已对应到 1 个物品'));assert(h.button('开始替换').props.disabled);
  await h.click('撤销一笔');assert(h.label().includes('涂抹已对应到 2 个物品'));await h.click('清空涂抹');assert(!h.label().includes('涂抹已对应到 2 个物品'));
  assert(h.button('开始替换').props.disabled);assert.equal(h.counts().remoteCreates,1);
});

test('background painting cannot enable generation; zoom does not change normalized stroke coordinates or create a prediction',async()=>{
  const h=harness('normal');await h.upload();await h.click('识别产品与替换位置');h.change('画布缩放',300);
  await h.paint([{x:.5,y:.02},{x:.9,y:.02}]);assert(h.button('开始替换').props.disabled);assert(h.label().includes('不匹配'));
  await h.click('清空涂抹');await h.paint([{x:.2,y:.4},{x:.3,y:.5}]);h.change('确认本次替换费用',true);await h.click('开始替换');
  const body=h.calls.find(c=>c.url.endsWith('/generation')).body;assert(Math.abs(body.brush.strokes[0].points[0].x-.2)<1e-6);assert(Math.abs(body.brush.strokes[0].points[0].y-.4)<1e-6);
});

test('restored images and analysis permit an explicit new generation under a generation-only grant, with a fresh fee confirmation',async()=>{
  const original=harness('normal');await original.upload();await original.click('识别产品与替换位置');
  const analysis=structuredClone(original.snapshot().currentJob);analysis.analysis.confirmedAt=Date.now();analysis.analysis.revisionHash='confirmed-h';
  await original.paint([{x:.2,y:.4},{x:.3,y:.5}]);original.change('确认本次替换费用',true);await original.click('开始替换');
  const generation={...original.snapshot().currentJob,results:[{raw:{url:'/fake-raw.png'},composite:null,quality:{status:'failed',reasons:['CONTOUR_UNCERTAIN']}}]};
  const h=harness('generation-only',new Map(original.storage),{currentJob:generation,jobs:{[analysis.id]:analysis,[generation.id]:generation}});
  await h.mountEffects();assert(h.button('识别产品与替换位置').props.disabled);
  assert(h.label().includes('勾选费用确认后即可生成'));
  assert(h.button('重新生成一张').props.disabled);assert.equal(h.counts().remoteCreates,0);
  assert(!h.calls.some(c=>c.method==='POST'),'restoring the screen must be read-only');
  h.change('确认本次替换费用',true);assert(!h.button('重新生成一张').props.disabled);
  await h.click('重新生成一张');
  assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/generation')).length,1);
  assert(!h.calls.some(c=>c.url.endsWith('/analysis')));assert.equal(h.counts().remoteCreates,1);
});

function retryFixture(mode){
  const job={id:randomUUID(),ownerId:'owner-incident',requestId:randomUUID(),kind:'generation',status:'quality_failed',stage:'human_review',revision:1,
    inputFingerprint:'a'.repeat(64),sourceHash:'a'.repeat(64),createdAt:Date.now(),updatedAt:Date.now(),completed:1,total:1,analysis:null,
    source:{name:'source.png',url:'/fake-source.png',width:96,height:64,sha256:'a'.repeat(64)},references:[],predictions:[],images:[],
    errorCode:'QUALITY_FAILED',error:contract.ERROR_MESSAGES.QUALITY_FAILED,quality:{status:'failed'},
    input:{selectedInstances:['left'],masks:[],protectMasks:[],contourHints:[{image:'source',instanceId:'left',kind:'foreground',x:.2,y:.5}]},
    results:[{raw:{name:'raw-1.png',url:'/fake-raw.png'},composite:{name:'old-composite.png',url:'/old-composite.png'},quality:{status:'needs_review',reasons:['HUMAN_PRODUCT_IDENTITY_REVIEW_REQUIRED']}}]};
  const storage=new Map([['replication_v2_generation',JSON.stringify({kind:'generation',ownerId:job.ownerId,requestId:job.requestId,inputFingerprint:job.inputFingerprint,jobId:job.id})]]);
  return {job,h:harness(mode,storage,{currentJob:job})};
}
test('compact workbench drops correction, adaptive candidates and audit panels; status is one line without task identifiers',async()=>{
  const {job,h}=retryFixture('retry-normal');await h.mountEffects();
  for(const label of ['修正识别范围','重新测试智能合成','智能合成候选','结果审核','显示 AI 识别位置','查看自动范围','QUALITY_FAILED'])assert(!h.label().includes(label));
  assert(h.label().includes('图片已生成'));assert(!h.label().includes(job.id));assert(!h.label().includes(job.requestId));
  assert.equal(h.nodes().filter(n=>n.props.role==='status').length,1);
  assert(!h.button('下载图片').props.disabled);assert(!h.calls.some(c=>c.method==='POST'));
});
test('slider compares the original with full model output even when adaptive composition failed',async()=>{
  const {h}=retryFixture('retry-normal');await h.mountEffects();
  const tab=h.nodes().find(n=>n.props.role==='tab'&&n.props.children.includes('滑动对比'));assert(!tab.props.disabled);tab.props.onClick();h.render();
  const slider=h.nodes().find(n=>n.props['aria-label']==='原图与生成结果滑动对比');assert(slider);slider.props.onChange({target:{value:'72'}});h.render();
  const compared=h.nodes().find(n=>n.type==='img'&&n.props.alt==='生成结果对比');assert.equal(compared.props.src,'/fake-raw.png');assert.equal(compared.props.style.clipPath,'inset(0 0 0 72%)');
  assert(!h.nodes().some(n=>n.props.src==='/old-composite.png'));assert(!h.calls.some(c=>c.method==='POST'));
});
test('all inputs and output can open the image viewer without model calls; download uses the full model image',async()=>{
  const h=harness('normal');await h.upload();await h.click('放大场景原图');
  let viewer=h.nodes().find(n=>n.type==='ReplicationImageViewer');assert(viewer.props.src);assert.equal(viewer.props.label,'场景原图');viewer.props.onClose();h.render();
  await h.click('放大产品参考1');viewer=h.nodes().find(n=>n.type==='ReplicationImageViewer');assert.equal(viewer.props.label,'产品参考1');
  assert.equal(h.counts().remoteCreates,0);
  const restored=retryFixture('retry-normal').h;await restored.mountEffects();await restored.click('放大当前预览');
  viewer=restored.nodes().find(n=>n.type==='ReplicationImageViewer');assert.equal(viewer.props.src,'/fake-raw.png');
  await restored.click('下载图片');assert.equal(restored.downloads.length,1);assert.match(restored.downloads[0].download,/生成结果/);
  assert(restored.calls.some(c=>c.url==='/fake-raw.png'));assert(!restored.calls.some(c=>c.method==='POST'));
});
test('direct model output has no dependency on a configured local segmenter and generation double clicks submit once',async()=>{
  const h=harness('no-segmenter');await h.mountEffects();await h.upload();await h.click('识别产品与替换位置');
  await h.paint([{x:.2,y:.4},{x:.3,y:.5}]);h.change('确认本次替换费用',true);
  const onClick=h.button('开始替换').props.onClick;await Promise.all([onClick(),onClick()]);h.render();
  const calls=h.calls.filter(c=>c.url.endsWith('/generation'));assert.equal(calls.length,1);assert.equal(calls[0].body.outputMode,'model');
});
test('after a completed round, new uploads allow a new analysis and explicit generation without carrying the old lock',async()=>{
  const h=harness('normal');await h.mountEffects();
  for(let round=0;round<2;round++){
    if(round)await h.click('清空');await h.upload();assert(!h.button('识别产品与替换位置').props.disabled);
    await h.click('识别产品与替换位置');await h.paint([{x:.2,y:.4},{x:.3,y:.5}]);
    assert(h.button('开始替换').props.disabled);h.change('确认本次替换费用',true);await h.click('开始替换');
  }
  const analyses=h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')),images=h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/generation'));
  assert.equal(analyses.length,2);assert.equal(images.length,2);assert.equal(h.counts().remoteCreates,4);
  assert.notEqual(analyses[0].requestId,analyses[1].requestId);assert.notEqual(images[0].requestId,images[1].requestId);
});
test('closed analysis capabilities explain the disabled button rather than telling the user to upload again',async()=>{
  const h=harness('retry-normal');await h.mountEffects();await h.upload();assert(h.button('识别产品与替换位置').props.disabled);
  assert(h.label().includes('产品分析入口暂未开放'));assert(!h.calls.some(c=>c.method==='POST'));
});
test('a reloaded unsubmitted draft restores usable files and all four references; analysis runs only after an explicit click',async()=>{
  const image={file:new File([new Uint8Array([1,2,3])],'scene.png',{type:'image/png'}),width:96,height:64};
  const draft={version:1,source:image,references:[1,2,3,4].map(n=>({...image,file:new File([new Uint8Array([n])],n+'.png',{type:'image/png'}),angle:'other'})),savedAt:1};
  const h=harness('normal',new Map(),{draft});await h.mountEffects();
  assert(!h.button('识别产品与替换位置').props.disabled);assert(h.button('放大产品参考4'));assert(!h.calls.some(c=>c.method==='POST'));
  await h.click('识别产品与替换位置');const calls=h.calls.filter(c=>c.url.endsWith('/analysis'));assert.equal(calls.length,1);assert.equal(calls[0].body.references.length,4);
  assert(h.label().includes('识别到：鞋'));assert(!h.calls.some(c=>c.url.endsWith('/generation')));
});
test('local-only resume and cancel ignore an invalid stored model token',async()=>{
  const {job,h}=retryFixture('retry-normal');h.storage.set('replicate_api_token','不能作为请求头的凭据');
  await h.service.resumeReplicationJob(job.id,true);await h.service.cancelReplicationJob(job.id,true);
  assert.equal(h.calls.filter(c=>c.method==='POST').length,2);assert.equal(h.counts().remoteCreates,0);
});

async function completedWorkbench(){
  const original=harness('normal');await original.upload();await original.click('识别产品与替换位置');
  const analysis=structuredClone(original.snapshot().currentJob);analysis.analysis.confirmedAt=1;analysis.createdAt=100;
  await original.paint([{x:.2,y:.4},{x:.3,y:.5}]);original.change('确认本次替换费用',true);await original.click('开始替换');
  const generation={...original.snapshot().currentJob,createdAt:200,results:[{raw:{url:'/fake-raw.png'},composite:null,quality:{status:'needs_review'}}]};
  return {analysis,generation,storage:new Map(original.storage),jobs:{[analysis.id]:analysis,[generation.id]:generation}};
}

test('fee checkbox remains usable before painting or with a mismatched brush, but invalid selection cannot create an image',async()=>{
  const h=harness('normal');await h.upload();await h.click('识别产品与替换位置');
  h.change('确认本次替换费用',true);assert(h.button('开始替换').props.disabled);
  await h.paint([{x:.5,y:.02},{x:.9,y:.02}]);h.change('确认本次替换费用',true);
  assert(h.button('开始替换').props.disabled);assert(h.label().includes('涂抹与AI定位不一致'));assert.equal(h.counts().remoteCreates,1);
  await h.click('清空涂抹');await h.paint([{x:.2,y:.4},{x:.3,y:.5}]);h.change('确认本次替换费用',true);
  assert(!h.button('开始替换').props.disabled);assert(!h.calls.some(c=>c.url.endsWith('/generation')));
});

test('refresh with lost local markers restores the completed model result from one read-only server snapshot',async()=>{
  const f=await completedWorkbench(),h=harness('normal',new Map(),{...f,workbenchJobs:[f.analysis,f.generation]});await h.mountEffects();
  const img=h.nodes().find(n=>n.type==='img'&&n.props.alt==='生成结果');assert.equal(img.props.src,'/fake-raw.png');
  assert(!h.button('下载图片').props.disabled);assert(h.label().includes('图片已生成'));
  assert.equal(h.calls.filter(c=>c.url.endsWith('/workbench')).length,1);
  assert.equal(h.calls.filter(c=>c.url.includes('/jobs/')||c.method==='POST').length,0);
  assert(!h.nodes().find(n=>n.type==='input'&&n.props['aria-label']==='确认本次替换费用').props.checked);
});

test('a stale analysis marker cannot replace the newer generation materials or bind old instance positions to new images',async()=>{
  const f=await completedWorkbench(),old={...structuredClone(f.analysis),id:randomUUID(),requestId:randomUUID(),inputFingerprint:'old-fingerprint',createdAt:1};
  f.storage.set('replication_v2_analysis',JSON.stringify({kind:'analysis',ownerId:old.ownerId,jobId:old.id,requestId:old.requestId,inputFingerprint:old.inputFingerprint}));
  const h=harness('normal',f.storage,{...f,jobs:{...f.jobs,[old.id]:old},workbenchJobs:[f.analysis,f.generation]});await h.mountEffects();
  assert.equal(JSON.parse(h.storage.get('replication_v2_analysis')).jobId,f.analysis.id);
  assert.equal(h.nodes().find(n=>n.type==='img'&&n.props.alt==='生成结果').props.src,'/fake-raw.png');
  h.change('确认本次替换费用',true);assert(!h.button('重新生成一张').props.disabled);
  assert(!h.calls.some(c=>c.method==='POST'));assert.equal(h.counts().remoteCreates,0);
});

test('two lost GET responses recover the existing finished image without repeating POST or reverting to the original',async()=>{
  const f=await completedWorkbench();f.storage.delete('replication_v2_analysis');
  const h=harness('normal',f.storage,{...f,lookupFailures:2});await h.mountEffects();
  await h.waitFor(()=>h.nodes().some(n=>n.type==='img'&&n.props.alt==='生成结果'));
  assert.equal(h.nodes().find(n=>n.type==='img'&&n.props.alt==='生成结果').props.src,'/fake-raw.png');
  assert.equal(h.calls.filter(c=>c.url.includes('/jobs/')).length,3);assert(!h.calls.some(c=>c.method==='POST'));
});

test('image-load retry retains the generated asset and download, and never substitutes the original or sends a model POST',async()=>{
  const f=await completedWorkbench();f.generation.results[0].raw.url='/api/replication/assets/'+f.generation.id+'/raw-1.png?owner=owner-incident';
  const h=harness('normal',new Map(),{...f,workbenchJobs:[f.analysis,f.generation]});await h.mountEffects();
  h.nodes().find(n=>n.type==='img'&&n.props.alt==='生成结果').props.onError();h.render();
  assert(h.label().includes('任务和生成结果已保留'));assert(!h.button('下载图片').props.disabled);
  await h.click('重新加载图片');const img=h.nodes().find(n=>n.type==='img'&&n.props.alt==='生成结果');
  assert(img.props.src.includes('/raw-1.png'));assert(img.props.src.includes('retry=1'));img.props.onLoad();h.render();assert(!h.button('重新加载图片'));
  assert(!h.calls.some(c=>c.method==='POST'));assert(!h.nodes().some(n=>n.type==='img'&&n.props.alt==='场景原图'));
  h.nodes().find(n=>n.props.role==='tab'&&n.props.children.includes('场景原图')).props.onClick();h.render();
  h.nodes().find(n=>n.type==='img'&&n.props.alt==='场景原图缩略图').props.onError();h.render();
  h.nodes().find(n=>n.type==='img'&&n.props.alt==='场景原图').props.onLoad();h.render();
  assert(h.button('重新加载图片'),'a successful canvas load must not erase a separate thumbnail failure');
  h.nodes().find(n=>n.type==='img'&&n.props.alt==='场景原图缩略图').props.onLoad();h.render();assert(!h.button('重新加载图片'));
});

test('hover and unrelated renders reuse brush matching; concurrent reads coalesce without changing POST semantics',async()=>{
  const h=harness('normal');await h.upload();await h.click('识别产品与替换位置');await h.paint([{x:.2,y:.4},{x:.3,y:.5}]);
  const before=h.memoComputations();for(let i=0;i<25;i++){h.nodes().find(n=>n.props['aria-label']==='涂抹替换范围画布').props.onPointerMove({clientX:10+i,clientY:10,currentTarget:{getScreenCTM:()=>({inverse:()=>({})})}});h.render();}
  assert.equal(h.memoComputations(),before);
  const id=h.snapshot().currentJob.id,reads=h.calls.filter(c=>c.url.includes('/jobs/')).length;
  await Promise.all([h.service.getReplicationJob(id),h.service.getReplicationJob(id)]);
  assert.equal(h.calls.filter(c=>c.url.includes('/jobs/')).length,reads+1);assert(h.timeouts.includes(15000));
});

test('legacy missing output exposes an explicit read/download recovery action, rather than silently presenting the original as a result',async()=>{
  const f=await completedWorkbench();Object.assign(f.generation,{status:'quality_failed',errorCode:'OUTPUT_INVALID',error:'模型图片未取回',outputRecoveryAvailable:true,results:[]});
  const h=harness('output-recovery',new Map(),{...f,currentJob:f.generation,workbenchJobs:[f.analysis,f.generation]});await h.mountEffects();
  assert(h.button('取回已生成图片'));assert(h.button('下载图片').props.disabled);await h.click('取回已生成图片');
  assert.equal(h.nodes().find(n=>n.type==='img'&&n.props.alt==='生成结果').props.src,'/fake-raw.png');
  assert(!h.button('取回已生成图片'));assert(!h.button('下载图片').props.disabled);
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert(h.calls.find(c=>c.method==='POST').url.endsWith('/resume'));
  assert.equal(h.counts().remoteCreates,0);
});
