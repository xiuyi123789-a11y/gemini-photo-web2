import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';

function service(state={records:new Map(),failWrite:false}){
  const indexedDB={open:()=>{const request={};queueMicrotask(()=>{
    request.result={transaction:()=>{
      const tx={objectStore:()=>({
        put:(value,key)=>queueMicrotask(()=>{if(state.failWrite)tx.onerror();else{state.records.set(key,value);tx.oncomplete();}}),
        get:key=>{const r={};queueMicrotask(()=>{r.result=state.records.get(key);r.onsuccess();});return r;},
        delete:key=>queueMicrotask(()=>{state.records.delete(key);tx.oncomplete();})
      })};return tx;
    }};request.onsuccess();
  });return request;}};
  const context=vm.createContext({indexedDB:state.blocked?{open:()=>({})}:indexedDB,Blob,File,console,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,25)),clearTimeout});
  const code=ts.transpileModule(readFileSync('services/replicationDraft.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};vm.runInContext('(function(module,exports){'+code+'\n})',context)(module,module.exports);
  return module.exports;
}
test('unsubmitted source and all references survive a reload, remain owner-isolated and can be cleared without network calls',async()=>{
  const state={records:new Map(),failWrite:false},s=service(state);
  const draft={version:1,source:{file:new File(['scene-data'],'scene.webp',{type:'image/webp'}),width:1080,height:1440},references:[1,2,3,4].map(n=>({file:new File(['ref-'+n],n+'.png',{type:'image/png'}),width:600,height:400,angle:'side'})),savedAt:1};
  assert(await s.saveReplicationDraft('alice',draft));
  const refreshed=service(state);assert.equal(await refreshed.loadReplicationDraft('bob'),null);
  const restored=await refreshed.loadReplicationDraft('alice');assert.equal(restored.references.length,4);assert.equal(await restored.source.file.text(),'scene-data');
  assert.equal(await restored.references[3].file.text(),'ref-4');assert.equal(restored.references[3].angle,'side');
  await refreshed.clearReplicationDraft('alice');assert.equal(await refreshed.loadReplicationDraft('alice'),null);
});
test('draft storage failures do not throw or lock the page and cannot erase the previously saved draft',async()=>{
  const state={records:new Map(),failWrite:false},s=service(state);
  const draft={version:1,source:{file:new File(['a'],'a.png'),width:1,height:1},references:[],savedAt:1};
  assert(await s.saveReplicationDraft('alice',draft));state.failWrite=true;
  assert.equal(await s.saveReplicationDraft('alice',{...draft,savedAt:2}),false);assert.equal((await s.loadReplicationDraft('alice')).savedAt,1);
});

test('blocked IndexedDB cannot hold task and result recovery indefinitely',async()=>{
  const s=service({blocked:true});assert.equal(await s.loadReplicationDraft('alice'),null);
});

test('drafts can retain owned server asset URLs and changed reference angles without original browser files',async()=>{
  const s=service(),image={file:null,url:'/api/replication/assets/local-job/source.png',width:900,height:600};
  const draft={version:1,source:image,references:[{...image,url:'/api/replication/assets/local-job/ref-1.png',angle:'side'}],fingerprint:'',savedAt:Date.now()};
  await s.saveReplicationDraft('alice',draft);assert.equal((await s.loadReplicationDraft('alice')).references[0].angle,'side');assert.equal(await s.loadReplicationDraft('bob'),null);
  await s.saveReplicationDraft('alice',{...draft,source:{...image,url:'https://other.example/private.png'}});assert.equal(await s.loadReplicationDraft('alice'),null);
});
