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
  const context=vm.createContext({indexedDB,Blob,File,console});
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
