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
  let cursor=0,values=[],effects=[],effectMounted=false,tree;
  const calls=[],timeouts=[];let accepted=0,remoteCreates=0,currentJob=serverSnapshot?.currentJob||null,receipt=serverSnapshot?.receipt||null;
  const storageApi={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useState:initial=>{const i=cursor++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value;}];},
    useRef:initial=>{const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];},
    useEffect:effect=>{cursor++;if(!effectMounted)effects.push(effect);}};
  const response=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  const makeJob=(payload,status)=>({id:randomUUID(),jobId:'unused',ownerId:'owner-incident',requestId:payload.requestId,kind:'analysis',status,stage:status,
    inputFingerprint:payload.inputFingerprint,sourceHash:'a'.repeat(64),revision:1,createdAt:Date.now(),updatedAt:Date.now(),completed:status==='succeeded'?1:0,total:1,
    source:{name:'source.png',url:'/fake-source.png',width:96,height:64,sha256:'a'.repeat(64)},
    references:[{name:'ref-1.png',url:'/fake-reference.png',width:96,height:64,angle:'other'}],target:'',results:[],images:[],predictions:[],
    errorCode:status==='submission_unknown'?'SUBMISSION_UNKNOWN':null,error:status==='submission_unknown'?'提交待核对':null,
    analysis:status==='succeeded'?{data:{scene:{old_product_instances:[]}},text:'MOCK 产品分析文字',rawText:'MOCK_ONLY',revision:1,revisionHash:'h',confirmedAt:null}:null});
  const fakeFetch=async(url,options={})=>{
    assert.equal(typeof url,'string');assert(url.startsWith('/api/replication/'),'Non-local fetch blocked');
    new Headers(options.headers); // Real browser Fetch header validation, before any request can reach a server.
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;calls.push({method,url,requestId:body?.requestId});
    if(url.endsWith('/capabilities'))return response(200,{enabled:true,maxReferences:6,counts:[1],resolutions:['1K','2K']});
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
      if(mode==='503')return response(503,{errorCode:'QUEUE_BUSY'});
      if(['401','403','413','422'].includes(mode))return response(Number(mode),{errorCode:'INPUT_INVALID'});
      if(['timeout-before-accept','cannot-seal'].includes(mode))return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
      accepted++;remoteCreates++;
      currentJob=makeJob(body,mode==='unknown'?'submission_unknown':'succeeded');
      receipt={...receipt,state:'accepted',jobId:currentJob.id};
      if(mode==='lost-ack')throw new TypeError('MOCK response lost');
      return response(202,currentJob);
    }
    if(url.includes('/request/')||url.includes('/jobs/'))return currentJob?response(200,currentJob):response(404,{errorCode:'JOB_NOT_FOUND'});
    throw new Error('Unexpected mock route '+method+' '+url);
  };
  class FakeImage{naturalWidth=96;naturalHeight=64;set src(v){queueMicrotask(()=>this.onload());}}
  const moduleCache=new Map();
  const context=vm.createContext({crypto:webcrypto,TextEncoder,Uint8Array,ArrayBuffer,URL,File,Blob,
    fetch:fakeFetch,AbortSignal:{timeout:ms=>{timeouts.push(ms);return AbortSignal.timeout(['timeout-before-accept','cannot-seal'].includes(mode)?15:ms);}},
    window:{setTimeout:(fn)=>realSetTimeout(fn,1),confirm:()=>true},setTimeout:realSetTimeout,Image:FakeImage,console});
  function compile(relative){
    if(moduleCache.has(relative))return moduleCache.get(relative);
    const source=fs.readFileSync(path.join(root,relative),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
    const module={exports:{}};
    const requireFake=name=>{
      if(name==='react')return {__esModule:true,default:react,...react};
      if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
      if(name.endsWith('ImageModal'))return {ImageModal:'ImageModal'};
      if(name.endsWith('.css'))return {};
      if(name.endsWith('browserStorage'))return {userStorage:storageApi,getStorageUser:()=> 'owner-incident'};
      if(name.endsWith('userIdentity'))return {getUserId:()=> 'owner-incident'};
      if(name.endsWith('replicateService'))return {fileToBase64:async file=>'data:image/png;base64,'+Buffer.from(await file.arrayBuffer()).toString('base64')};
      if(name.endsWith('replication-contract.js'))return contract;
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
  function button(text){return nodes(tree).find(node=>node.type==='button'&&label(node).includes(text));}
  async function click(text){render();const node=button(text);assert(node,'Button missing: '+text);assert(!node.props.disabled,'Button disabled: '+text);await node.props.onClick();render();}
  async function upload(){
    for(const refs of [false,true]){render();const input=nodes(tree).find(node=>node.type==='input'&&node.props.type==='file'&&!!node.props.multiple===refs);
      input.props.onChange({target:{files:[new File([new Uint8Array([1,2,3])],refs?'ref.png':'scene.png',{type:'image/png'})],value:'x'}});
      await pause(5);render();}
  }
  async function mountEffects(){effects.forEach(fn=>fn());effectMounted=true;await pause(15);render();}
  render();
  return {storage,calls,timeouts,render,button,click,upload,mountEffects,snapshot:()=>({receipt,currentJob}),label:()=>label(tree),counts:()=>({accepted,remoteCreates}),service:compile('services/replicationService.ts')};
}

test('interrupted upload: durable seal ends loading, clears the orphan only after acknowledgment, and permits a new submit',async()=>{
  const h=harness('timeout-before-accept');await h.upload();await h.click('分析产品特征');
  assert.equal(h.counts().remoteCreates,0);assert(h.label().includes('已安全结束'));assert(!h.button('分析产品特征').props.disabled);
  assert(!h.storage.has('replication_v2_analysis'));assert(h.timeouts.includes(60000));
  assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,1);
  assert(h.calls.some(c=>c.url.endsWith('/close')));
});
test('503 without a job is safely sealed; no permanent busy state and no paid retry',async()=>{
  const h=harness('503');await h.upload();await h.click('分析产品特征');assert.equal(h.counts().accepted,0);
  assert(!h.button('分析产品特征').props.disabled);assert(!h.storage.has('replication_v2_analysis'));assert(h.label().includes('已安全结束'));
});
test('404 alone keeps fee protection, but refresh always exposes reconnect and safe-end; a seal acknowledgment releases it',async()=>{
  const h=harness('cannot-seal');await h.upload();await h.click('分析产品特征');
  assert(h.storage.has('replication_v2_analysis'));assert(h.button('分析提交待核对').props.disabled);
  assert(!h.button('检查连接').props.disabled);assert(!h.button('重新连接查询').props.disabled);assert(!h.label().includes('正在提交分析素材'));
  const refreshed=harness('legacy-orphan',h.storage);await refreshed.mountEffects();
  assert(refreshed.button('重新连接查询'));assert(refreshed.button('安全结束本次提交'));assert(refreshed.button('分析提交待核对').props.disabled);
  await refreshed.click('重新连接查询');assert(refreshed.storage.has('replication_v2_analysis'));
  await refreshed.click('安全结束本次提交');assert(!refreshed.storage.has('replication_v2_analysis'));assert(!refreshed.button('分析产品特征').props.disabled);
  assert.equal(refreshed.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,0);
});
test('unknown provider submission is labeled pending reconciliation, keeps fee protection and never creates again',async()=>{
  const h=harness('unknown');await h.upload();await h.click('分析产品特征');
  assert(h.label().includes('提交待核对'));assert(h.button('分析任务待核对').props.disabled);await h.click('重新连接查询');await h.click('安全结束本次提交');
  assert(h.storage.has('replication_v2_analysis'));assert.equal(h.counts().remoteCreates,1);assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,1);
});
test('lost POST acknowledgment recovers the durable completed job with GET and fills text',async()=>{
  const h=harness('lost-ack');await h.upload();await h.click('分析产品特征');
  assert(!h.button('分析产品特征').props.disabled);assert(h.label().includes('产品分析已结束'));
  assert.equal(h.counts().remoteCreates,1);assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/analysis')).length,1);
});
test('REAL UI/service: definitive 401/403/413/422 rejection clears pending state and does not create a prediction',async()=>{
  for(const status of ['401','403','413','422']){const h=harness(status);await h.upload();await h.click('分析产品特征');
    assert(!h.button('分析产品特征').props.disabled);assert(!h.storage.has('replication_v2_analysis'));assert.equal(h.counts().remoteCreates,0);}
});
test('REAL UI/service: duplicate concurrent handler calls create only one mock analysis and zero generation calls',async()=>{
  const h=harness('lost-ack');await h.upload();const node=h.button('分析产品特征');await Promise.all([node.props.onClick(),node.props.onClick()]);h.render();
  assert.equal(h.counts().remoteCreates,1);assert.equal(h.calls.filter(c=>c.url.endsWith('/generation')).length,0);
});
test('invalid token header is rejected before reserving or saving an operation; loading and fee lock both release',async()=>{
  for(const token of ['bad\r\nheader','中文占位符']){
    const h=harness('lost-ack',new Map([['replicate_api_token',token]]));await h.upload();await h.click('分析产品特征');
    assert.equal(h.calls.length,0);assert.equal(h.counts().remoteCreates,0);
    assert(h.label().includes('API Key 含无效字符'));assert(!h.button('分析产品特征').props.disabled);
    assert(!h.storage.has('replication_v2_analysis'));
  }
});
test('complete network loss ends the UI spinner while preserving a visible, queryable fee guard',async()=>{
  const h=harness('offline');await h.upload();await h.click('分析产品特征');
  assert(h.storage.has('replication_v2_analysis'));assert(h.button('分析提交待核对').props.disabled);
  assert(!h.label().includes('正在提交分析素材'));assert(h.button('重新连接查询'));assert(h.button('安全结束本次提交'));
  assert.equal(h.counts().remoteCreates,0);
});
test('lost local marker can discover the durable server intake after refresh and end it without a prediction',async()=>{
  const h=harness('cannot-seal');await h.upload();await h.click('分析产品特征');
  const refreshed=harness('normal',new Map(),h.snapshot());await refreshed.mountEffects();
  assert(refreshed.storage.has('replication_v2_analysis'));assert(refreshed.button('安全结束本次提交'));
  await refreshed.click('安全结束本次提交');assert(!refreshed.button('分析产品特征').props.disabled);
  assert.equal(refreshed.counts().remoteCreates,0);assert(!refreshed.calls.some(c=>c.url.endsWith('/analysis')));
});
