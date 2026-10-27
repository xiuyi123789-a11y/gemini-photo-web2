import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Executes the actual frontend service without a browser or any implicit model
// calls. HTTP is supplied by the caller (Mock in npm test; loopback in live QA).
export function loadStudioServices({origin='http://127.0.0.1:1',fetchImpl=fetch,token='',userId='text-analysis-qa',consoleImpl=console}={}){
  class Reader{
    readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type||'image/png'};base64,${Buffer.from(bytes).toString('base64')}`;this.onload?.();this.onloadend?.();},e=>this.onerror?.(e));}
  }
  const cache=new Map(),context=vm.createContext({fetch:fetchImpl,File,Blob,FormData,FileReader:Reader,Headers,Response,URL,
    AbortController,AbortSignal,DOMException,console:consoleImpl,window:{location:{origin},setTimeout,clearTimeout}});
  function compile(file){
    if(cache.has(file))return cache.get(file);
    const code=ts.transpileModule(fs.readFileSync(path.resolve(file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    const module={exports:{}};
    const require=name=>{
      if(name.endsWith('userIdentity'))return {getUserId:()=>userId};
      if(name.endsWith('browserStorage'))return {userStorage:{getItem:key=>key==='replicate_api_token'?token:null}};
      if(name.endsWith('knowledgeBaseService'))return {getKnowledgeBase:async()=>[]};
      if(name.endsWith('errorNotebookService'))return {addToErrorNotebook:async()=>{}};
      if(name.endsWith('/types'))return compile('types.ts');
      throw new Error('Unexpected dependency: '+name);
    };
    vm.runInContext('(function(require,module,exports){'+code+'\n})',context,{filename:file})(require,module,module.exports);
    cache.set(file,module.exports);return module.exports;
  }
  return compile('services/replicateService.ts');
}
