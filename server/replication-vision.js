import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
export const localVisionConfigured=()=>!!process.env.REPLICATION_VISION_PYTHON&&!!process.env.REPLICATION_SAM_CHECKPOINT&&existsSync(process.env.REPLICATION_SAM_CHECKPOINT);
let activeProcesses=0;
// This process only reads local pixels. It has no provider credentials or HTTP API.
export function createLocalVision({python=process.env.REPLICATION_VISION_PYTHON,timeoutMs=120000}={}) {
  return async input=>{
    if(!python)throw Object.assign(new Error('SEGMENTATION_UNAVAILABLE'),{code:'SEGMENTATION_UNAVAILABLE'});
    if(activeProcesses)throw Object.assign(new Error('SEGMENTATION_BUSY'),{code:'SEGMENTATION_BUSY'});
    activeProcesses++;
    return new Promise((resolve,reject)=>{
      const child=spawn(python,[fileURLToPath(new URL('./vision/replication_segment.py',import.meta.url))],{
        windowsHide:true,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|LANG|LC_ALL|REPLICATION_VISION_PACKAGES|REPLICATION_SAM_CHECKPOINT|REPLICATION_VISION_THREADS)$/i.test(k))),PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
      let output='',size=0,done=false;
      const finish=(error,value)=>{if(done)return;done=true;activeProcesses--;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>{child.kill();finish(Object.assign(new Error('SEGMENTATION_TIMEOUT'),{code:'SEGMENTATION_TIMEOUT'}));},timeoutMs);
      child.on('error',()=>finish(Object.assign(new Error('SEGMENTATION_UNAVAILABLE'),{code:'SEGMENTATION_UNAVAILABLE'})));
      child.stdout.on('data',b=>{size+=b.length;if(size>48*1024*1024){child.kill();finish(new Error('SEGMENTATION_INVALID'));}else output+=b;});
      child.stderr.resume(); // Never return third-party tracebacks or environment data.
      child.on('close',()=>{try{const value=JSON.parse(output);if(value.error)throw Object.assign(new Error(value.error),{code:value.error});finish(null,value);}catch(e){finish(e);}});
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify(input));
    });
  };
}
