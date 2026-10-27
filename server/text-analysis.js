import {setTimeout as pause} from 'node:timers/promises';
import {createReplicationProvider} from './replication-provider.js';
import {REPLICATION_MODELS,ERROR_MESSAGES} from '../shared/replication-contract.js';

export const TEXT_ANALYSIS_MODEL=REPLICATION_MODELS.analysis;
const failure=(code,status=502,predictionId)=>Object.assign(new Error(code),{code,status,predictionId});
export function parseAnalysisJson(text){
  try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}
  catch{throw failure('ANALYSIS_SCHEMA_INVALID');}
}
export function createTextAnalyzer({providerFactory=token=>createReplicationProvider(token),pollMs=1000,budgetMs=300000}={}){
  return async(token,{prompt,system,images=[],maxOutputTokens=8192})=>{
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>120000||typeof system!=='string')throw failure('INPUT_INVALID',400);
    const input={prompt,system_instruction:system,images,temperature:.2,thinking_budget:128,dynamic_thinking:false,
      max_output_tokens:Math.max(256,Math.min(8192,Math.floor(maxOutputTokens)||8192))};
    const provider=providerFactory(token),deadline=Date.now()+budgetMs;
    // Exactly one create. Failed streaming, polling or parsing NEVER falls back
    // to another prediction. The acknowledged ID is returned with later errors.
    let prediction=await provider.create(TEXT_ANALYSIS_MODEL,input);
    try{
      while(!['succeeded','failed','canceled'].includes(prediction.status)){
        if(Date.now()>=deadline)throw failure('PREDICTION_TIMEOUT',504);
        await pause(pollMs);prediction=await provider.get(prediction.id);
      }
      if(prediction.model&&prediction.model!==TEXT_ANALYSIS_MODEL)throw failure('PREDICTION_MODEL_MISMATCH');
      if(prediction.status!=='succeeded')throw failure('PREDICTION_FAILED');
      const output=prediction.output;
      const text=typeof output==='string'?output:Array.isArray(output)&&output.every(v=>typeof v==='string')?output.join(''):'';
      if(!text.trim())throw failure('OUTPUT_INVALID');
      return {text:text.trim(),predictionId:prediction.id,model:TEXT_ANALYSIS_MODEL};
    }catch(e){throw Object.assign(e,{predictionId:prediction.id});}
  };
}
export function textAnalysisError(res,error){
  const code=error.code||'ANALYSIS_FAILED';
  console.error(JSON.stringify({event:'text_analysis.failed',code,predictionId:error.predictionId||null}));
  res.status(Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:502).json({success:false,errorCode:code,
    error:ERROR_MESSAGES[code]||'文字分析未完成，未自动重试。',...(error.predictionId?{predictionId:error.predictionId}:{})});
}
