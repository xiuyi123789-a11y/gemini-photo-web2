import {readFileSync,existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

// A local real-model test consumes its allowance BEFORE the create request.
// Unknown outcomes and process restarts must never replenish a paid call.
export function localPredictionAllowance({directory,name,model,promptVersion}) {
  if(!/^[a-z0-9-]+$/.test(name))throw new Error('Invalid local allowance name');
  const grantFile=path.join(directory,name+'.approved.json'),claimFile=path.join(directory,name+'.consumed.json');
  const denied=()=>Object.assign(new Error('MODEL_NOT_ALLOWED'),{code:'MODEL_NOT_ALLOWED',status:409});
  function grant(){
    try{
      const g=JSON.parse(readFileSync(grantFile,'utf8'));
      return g.model===model&&g.promptVersion===promptVersion&&g.maxPredictions===1&&typeof g.ownerId==='string'?g:null;
    }catch{return null;}
  }
  const enabled=()=>!!grant()&&!existsSync(claimFile);
  const canSubmit=(kind,req)=>kind==='generation'&&enabled()&&req.userId===grant()?.ownerId;
  async function claim(requestedModel){
    if(requestedModel!==model||!enabled())throw denied();
    try{await writeFile(claimFile,JSON.stringify({model,promptVersion,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});}
    catch(e){if(e.code==='EEXIST')throw denied();throw e;}
  }
  return {enabled,canSubmit,claim,grantFile,claimFile};
}
