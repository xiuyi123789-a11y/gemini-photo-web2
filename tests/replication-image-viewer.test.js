import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function viewer(){
  let cursor=0,values=[],effects=[],tree,closed=0,focusRestored=0,captured=false;
  const listeners=new Map(),wheels=new Map();
  const element={getBoundingClientRect:()=>({left:100,top:60,width:1000,height:700}),
    addEventListener:(key,fn)=>wheels.set(key,fn),removeEventListener:key=>wheels.delete(key),
    setPointerCapture:()=>{captured=true;},hasPointerCapture:()=>captured,releasePointerCapture:()=>{captured=false;}};
  const document={body:{style:{overflow:'auto'}},activeElement:{focus:()=>focusRestored++}};
  const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],v=>{values[i]=v;}];},
    useRef:initial=>{const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];},useEffect:fn=>{cursor++;if(!effects.length)effects.push(fn);}};
  const context=vm.createContext({document,window:{addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:k=>listeners.delete(k)}});
  const source=readFileSync('components/ReplicationImageViewer.tsx','utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  const require=name=>name==='react'?{__esModule:true,default:react,...react}:name==='react-dom'?{createPortal:node=>node}:name==='lucide-react'?{X:'X',RotateCcw:'RotateCcw'}:{};
  vm.runInContext('(function(require,module,exports){'+code+'\n})',context)(require,module,module.exports);
  function nodes(n){return !n?[]:Array.isArray(n)?n.flatMap(nodes):typeof n==='object'?[n,...nodes(n.props?.children)]:[];}
  function render(){cursor=0;tree=module.exports.ReplicationImageViewer({src:'/local-image.png',label:'产品参考',onClose:()=>closed++});
    for(const n of nodes(tree)){if(n.props?.className?.startsWith('rp-viewer-stage'))n.props.ref.current=element;if(n.props?.role==='dialog')n.props.ref.current={focus(){},querySelectorAll:()=>[]};}
  }
  render();const cleanup=effects[0]();
  const event=(patch={})=>({button:0,pointerId:7,clientX:850,clientY:410,currentTarget:element,preventDefault(){},stopPropagation(){},...patch});
  const stage=()=>nodes(tree).find(n=>n.props?.className?.startsWith('rp-viewer-stage'));
  const transform=()=>{const image=nodes(tree).find(n=>n.type==='img');const nums=image.props.style.transform.match(/-?[\d.]+/g).map(Number);return {x:nums[0],y:nums[1],scale:nums[2]};};
  return {render,transform,document,closed:()=>closed,focusRestored:()=>focusRestored,captured:()=>captured,
    wheel:delta=>{wheels.get('wheel')(event({deltaY:delta,deltaMode:0}));render();},
    key:(repeat=false)=>{listeners.get('keydown')(event({key:'Escape',repeat}));render();},
    down:(x,y)=>{stage().props.onPointerDown(event({clientX:x,clientY:y}));render();},
    move:(x,y)=>{stage().props.onPointerMove(event({clientX:x,clientY:y}));render();},
    up:()=>{stage().props.onPointerUp(event());render();},
    closeButton:()=>{nodes(tree).find(n=>n.props?.['aria-label']==='还原或关闭大图').props.onClick();render();},
    cleanup:()=>cleanup(),listeners,wheels};
}
test('wheel zoom keeps the pixel under the pointer fixed; zoom is bounded and never closes the image',()=>{
  const h=viewer();try{
    h.wheel(-120);const t=h.transform();assert(t.scale>1);assert(Math.abs((250-t.x)/t.scale-250)<.00001);assert(Math.abs(t.y)<.00001);assert.equal(h.closed(),0);
    h.wheel(-100000);assert.equal(h.transform().scale,12);h.wheel(100000);assert.equal(h.transform().scale,.25);
  }finally{h.cleanup();}
});
test('drag works immediately at the fitted size; position persists after release and a second drag accumulates',()=>{
  const h=viewer();try{
    h.down(500,400);h.move(570,440);h.up();assert.deepEqual(h.transform(),{scale:1,x:70,y:40});assert(!h.captured());assert.equal(h.closed(),0);
    h.down(600,400);h.move(620,390);h.up();assert.deepEqual(h.transform(),{scale:1,x:90,y:30});
  }finally{h.cleanup();}
});
test('Escape first restores size and position, second closes; holding Escape cannot skip the restore step',()=>{
  const h=viewer();try{
    h.wheel(-120);h.down(400,400);h.move(500,440);h.up();h.key();assert.deepEqual(h.transform(),{scale:1,x:0,y:0});assert.equal(h.closed(),0);
    h.key(true);assert.equal(h.closed(),0);h.key();assert.equal(h.closed(),1);
  }finally{h.cleanup();}
});
test('top-right close follows the same reset-then-close rule; cleanup restores focus, scroll and listeners',()=>{
  const h=viewer();assert.equal(h.document.body.style.overflow,'hidden');h.down(400,400);h.move(410,420);h.up();
  h.closeButton();assert.deepEqual(h.transform(),{scale:1,x:0,y:0});assert.equal(h.closed(),0);h.closeButton();assert.equal(h.closed(),1);
  h.cleanup();assert.equal(h.document.body.style.overflow,'auto');assert.equal(h.focusRestored(),1);assert.equal(h.listeners.size,0);assert.equal(h.wheels.size,0);
});
