import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {localPredictionAllowance} from '../scripts/local-prediction-allowance.mjs';

test('a generation-only local grant survives races, lost responses and restart without replenishing paid calls',async()=>{
  const root=path.resolve('.local/migration-archive/test-data');await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'allowance-'));
  const options={directory,name:'fake-generation-v2',model:'google/nano-banana-2',promptVersion:'replacement-v4.0'};
  const grant=localPredictionAllowance(options);
  try{
    assert(!grant.enabled());
    await writeFile(grant.grantFile,JSON.stringify({model:options.model,promptVersion:options.promptVersion,maxPredictions:1,ownerId:'alice'}));
    assert(grant.enabled());assert(grant.canSubmit('generation',{userId:'alice'}));
    assert(!grant.canSubmit('analysis',{userId:'alice'}));assert(!grant.canSubmit('generation',{userId:'bob'}));
    await assert.rejects(grant.claim('google/gemini-2.5-flash'),{code:'MODEL_NOT_ALLOWED'});
    assert(grant.enabled(),'an analysis rejection cannot consume the image allowance');
    let fakeCalls=0;
    const submit=async()=>{await grant.claim(options.model);fakeCalls++;throw new Error('Fake response lost');};
    await Promise.allSettled([submit(),submit()]);assert.equal(fakeCalls,1);assert(!grant.enabled());
    const restarted=localPredictionAllowance(options);assert(!restarted.enabled());
    await assert.rejects(restarted.claim(options.model),{code:'MODEL_NOT_ALLOWED'});assert.equal(fakeCalls,1);
  }finally{assert(path.resolve(directory).startsWith(root+path.sep));await rm(directory,{recursive:true,force:true});}
});
