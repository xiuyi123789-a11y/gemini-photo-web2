import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isFinalJob } from '../shared/replication-contract.js';

// Additive migration, separate from all existing account/knowledge data.
export const REPLICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS replication_jobs (
  job_id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, request_id UUID NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, document JSONB NOT NULL,
  UNIQUE(user_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS replication_one_active_user ON replication_jobs(user_id)
  WHERE status IN ('queued','submitting','running','postprocessing','submission_unknown','cancel_requested','cancel_unknown');
CREATE TABLE IF NOT EXISTS replication_predictions (
  local_attempt_id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES replication_jobs(job_id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL, prediction_id TEXT UNIQUE, document JSONB NOT NULL,
  UNIQUE(job_id, attempt_no)
);
CREATE TABLE IF NOT EXISTS replication_requests (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id UUID NOT NULL,
  state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, document JSONB NOT NULL,
  PRIMARY KEY(user_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS replication_one_intake_user ON replication_requests(user_id)
  WHERE state IN ('reserved','preparing');`;

const clone = v => v == null ? v : structuredClone(v);
const busy = () => Object.assign(new Error('TASK_BUSY'), { code:'TASK_BUSY',status:409 });
const checkRequest = (old, identity) => {
  if(old.kind!==identity.kind||old.inputFingerprint!==identity.inputFingerprint)
    throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'),{code:'IDEMPOTENCY_CONFLICT',status:409});
};
const closedRequest = identity => ({...identity,state:'closed',jobId:null,revision:0,createdAt:Date.now(),updatedAt:Date.now(),closedAt:Date.now()});
export function createPgReplicationStore(pool,{inTransaction=false}={}) {
  // Serialize sealing and attempt insertion on the job row. A successful seal
  // and a provider submission can never both win, including across processes.
  async function transaction(action) {
    const borrowed=!inTransaction;
    const client=borrowed?await pool.connect():pool;
    let begun=false;
    try {await client.query(borrowed?'BEGIN':'SAVEPOINT replication_store');begun=true;
      const result=await action(client);await client.query(borrowed?'COMMIT':'RELEASE SAVEPOINT replication_store');return result;}
    catch(e){if(begun)await client.query(borrowed?'ROLLBACK':'ROLLBACK TO SAVEPOINT replication_store').catch(()=>{});throw e;}
    finally{if(borrowed)client.release();}
  }
  return {
    async getRequest(owner,id) {return (await pool.query('SELECT document FROM replication_requests WHERE user_id=$1 AND request_id=$2',[owner,id])).rows[0]?.document||null;},
    async activeRequests(owner,kind){return (await pool.query("SELECT document FROM replication_requests WHERE user_id=$1 AND state IN ('reserved','preparing')",[owner])).rows.map(r=>r.document).filter(r=>r.kind===kind);},
    async reserveRequest(receipt) {
      try {await pool.query('INSERT INTO replication_requests(user_id,request_id,state,document) VALUES($1,$2,$3,$4::jsonb)',
        [receipt.ownerId,receipt.requestId,receipt.state,JSON.stringify({...receipt,revision:0})]);return receipt;}
      catch(e){if(e.code==='23505'){const old=await this.getRequest(receipt.ownerId,receipt.requestId);if(old){checkRequest(old,receipt);return old;}throw busy();}throw e;}
    },
    async updateRequest(owner,id,mutate) {
      for(let n=0;n<12;n++){
        const old=await this.getRequest(owner,id);if(!old)return null;const next=mutate(clone(old));if(!next)return old;
        next.revision=old.revision+1;next.updatedAt=Date.now();
        const r=await pool.query('UPDATE replication_requests SET state=$1,revision=$2,document=$3::jsonb WHERE user_id=$4 AND request_id=$5 AND revision=$6 RETURNING request_id',
          [next.state,next.revision,JSON.stringify(next),owner,id,old.revision]);if(r.rows.length)return next;
      }
      throw Object.assign(new Error('STATE_CONFLICT'),{code:'STATE_CONFLICT',status:409});
    },
    async closeRequest(identity) {
      return transaction(async c=>{
        const sealed=closedRequest(identity);
        await c.query('INSERT INTO replication_requests(user_id,request_id,state,document) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(user_id,request_id) DO NOTHING',
          [identity.ownerId,identity.requestId,'closed',JSON.stringify(sealed)]);
        const receipt=(await c.query('SELECT document FROM replication_requests WHERE user_id=$1 AND request_id=$2 FOR UPDATE',[identity.ownerId,identity.requestId])).rows[0].document;
        checkRequest(receipt,identity);
        let job=(await c.query('SELECT document FROM replication_jobs WHERE user_id=$1 AND request_id=$2 FOR UPDATE',[identity.ownerId,identity.requestId])).rows[0]?.document||null;
        const attempted=job&&(await c.query('SELECT local_attempt_id FROM replication_predictions WHERE job_id=$1',[job.id])).rows.length>0;
        const next={...receipt,state:attempted?'accepted':'closed',jobId:job?.id||null,revision:receipt.revision+1,updatedAt:Date.now(),...(!attempted?{closedAt:Date.now()}:{})};
        if(job&&!attempted&&!isFinalJob(job)){
          job={...job,status:'failed',stage:'failed',errorCode:'REQUEST_CLOSED',workerLease:null,revision:job.revision+1,updatedAt:Date.now()};
          await c.query('UPDATE replication_jobs SET status=$1,revision=$2,document=$3::jsonb WHERE job_id=$4',[job.status,job.revision,JSON.stringify(job),job.id]);
        }
        await c.query('UPDATE replication_requests SET state=$1,revision=$2,document=$3::jsonb WHERE user_id=$4 AND request_id=$5',
          [next.state,next.revision,JSON.stringify(next),identity.ownerId,identity.requestId]);
        return {closed:!attempted,receipt:next,job};
      });
    },
    async get(id) { return (await pool.query('SELECT document FROM replication_jobs WHERE job_id=$1', [id])).rows[0]?.document || null; },
    async byRequest(owner, requestId) { return (await pool.query('SELECT document FROM replication_jobs WHERE user_id=$1 AND request_id=$2', [owner,requestId])).rows[0]?.document || null; },
    async list(owner) { return (await pool.query('SELECT document FROM replication_jobs'+(owner?' WHERE user_id=$1':''),owner?[owner]:[])).rows.map(r=>r.document); },
    async create(job) {
      try { await pool.query('INSERT INTO replication_jobs(job_id,user_id,kind,request_id,payload_hash,status,revision,document) VALUES($1,$2,$3,$4,$5,$6,0,$7::jsonb)',
        [job.id,job.ownerId,job.kind,job.requestId,job.payloadHash,job.status,JSON.stringify({...job,revision:0})]); return job; }
      catch(e) { if(e.code==='23505') { const old=await this.byRequest(job.ownerId,job.requestId);if(old)return old;throw busy(); } throw e; }
    },
    async update(id, mutate) {
      for(let tries=0;tries<12;tries++) {
        const old=await this.get(id); if(!old)return null;
        const next=mutate(clone(old)); if(!next)return old;
        next.revision=old.revision+1;next.updatedAt=Date.now();
        const r=await pool.query('UPDATE replication_jobs SET status=$1,revision=$2,document=$3::jsonb WHERE job_id=$4 AND revision=$5 RETURNING job_id',
          [next.status,next.revision,JSON.stringify(next),id,old.revision]);
        if(r.rows.length)return next;
      }
      throw Object.assign(new Error('STATE_CONFLICT'),{code:'STATE_CONFLICT',status:409});
    },
    async attempts(jobId) { return (await pool.query('SELECT document FROM replication_predictions WHERE job_id=$1 ORDER BY attempt_no',[jobId])).rows.map(r=>r.document); },
    async claimAttempt(attempt,lease) {
      return transaction(async c=>{
        const job=(await c.query('SELECT document FROM replication_jobs WHERE job_id=$1 FOR UPDATE',[attempt.jobId])).rows[0]?.document;
        if(!job||isFinalJob(job)||(lease&&job.workerLease?.id!==lease))return false;
        const r=await c.query('INSERT INTO replication_predictions(local_attempt_id,job_id,attempt_no,document) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(job_id,attempt_no) DO NOTHING RETURNING local_attempt_id',
          [attempt.id,attempt.jobId,attempt.attemptNo,JSON.stringify(attempt)]);
        return r.rows.some(row=>row.local_attempt_id===attempt.id);
      });
    },
    async updateAttempt(attempt) {
      await pool.query('UPDATE replication_predictions SET prediction_id=$1,document=$2::jsonb WHERE local_attempt_id=$3', [attempt.predictionId||null,JSON.stringify(attempt),attempt.id]);
    },
    async remove(id) { await pool.query('DELETE FROM replication_predictions WHERE job_id=$1',[id]);await pool.query('DELETE FROM replication_jobs WHERE job_id=$1',[id]); }
  };
}

// Durable local-development fallback. Production always uses PostgreSQL.
// One serialized instance per data directory; no tokens, image bytes, or prompts in this file.
const fileStores=new Map();
export function createFileReplicationStore(directory) {
  const filename=path.resolve(directory,'replication-jobs-v2.json');
  if(fileStores.has(filename))return fileStores.get(filename);
  let tail=Promise.resolve();
  const transaction=(mutate,write=true)=>{
    const operation=tail.then(async()=>{
      await fs.mkdir(path.dirname(filename),{recursive:true});
      let data;
      try {data=JSON.parse(await fs.readFile(filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;data={jobs:[],attempts:[]};}
      data.requests ||= [];
      const value=await mutate(data);
      if(write){const temp=filename+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(data),{mode:0o600});await fs.rename(temp,filename);}
      return clone(value);
    });
    tail=operation.catch(()=>{});return operation;
  };
  const store={
    getRequest:(owner,id)=>transaction(d=>d.requests.find(r=>r.ownerId===owner&&r.requestId===id)||null,false),
    activeRequests:(owner,kind)=>transaction(d=>d.requests.filter(r=>r.ownerId===owner&&r.kind===kind&&['reserved','preparing'].includes(r.state)),false),
    reserveRequest:r=>transaction(d=>{const old=d.requests.find(x=>x.ownerId===r.ownerId&&x.requestId===r.requestId);
      if(old){checkRequest(old,r);return old;}if(d.requests.some(x=>x.ownerId===r.ownerId&&['reserved','preparing'].includes(x.state)))throw busy();
      d.requests.push({...r,revision:0});return r;}),
    updateRequest:(owner,id,mutate)=>transaction(d=>{const i=d.requests.findIndex(r=>r.ownerId===owner&&r.requestId===id);if(i<0)return null;
      const next=mutate(clone(d.requests[i]));if(next){next.revision=d.requests[i].revision+1;next.updatedAt=Date.now();d.requests[i]=next;}return d.requests[i];}),
    closeRequest:identity=>transaction(d=>{
      let receipt=d.requests.find(r=>r.ownerId===identity.ownerId&&r.requestId===identity.requestId);
      if(!receipt){receipt=closedRequest(identity);d.requests.push(receipt);}checkRequest(receipt,identity);
      const job=d.jobs.find(j=>j.ownerId===identity.ownerId&&j.requestId===identity.requestId)||null;
      const attempted=job&&d.attempts.some(a=>a.jobId===job.id);
      Object.assign(receipt,{state:attempted?'accepted':'closed',jobId:job?.id||null,revision:receipt.revision+1,updatedAt:Date.now(),...(!attempted?{closedAt:Date.now()}:{})});
      if(job&&!attempted&&!isFinalJob(job))Object.assign(job,{status:'failed',stage:'failed',errorCode:'REQUEST_CLOSED',workerLease:null,revision:job.revision+1,updatedAt:Date.now()});
      return {closed:!attempted,receipt,job};
    }),
    get:id=>transaction(d=>d.jobs.find(j=>j.id===id)||null,false),
    byRequest:(owner,id)=>transaction(d=>d.jobs.find(j=>j.ownerId===owner&&j.requestId===id)||null,false),
    list:owner=>transaction(d=>owner?d.jobs.filter(j=>j.ownerId===owner):d.jobs,false),
    create:job=>transaction(d=>{
      const old=d.jobs.find(j=>j.ownerId===job.ownerId&&j.requestId===job.requestId);if(old)return old;
      if(d.jobs.some(j=>j.ownerId===job.ownerId&&!isFinalJob(j)))throw busy();
      d.jobs.push({...job,revision:0});return job;
    }),
    update:(id,mutate)=>transaction(d=>{const i=d.jobs.findIndex(j=>j.id===id);if(i<0)return null;const next=mutate(clone(d.jobs[i]));
      if(next){next.revision=d.jobs[i].revision+1;next.updatedAt=Date.now();d.jobs[i]=next;}return d.jobs[i];}),
    attempts:id=>transaction(d=>d.attempts.filter(a=>a.jobId===id).sort((a,b)=>a.attemptNo-b.attemptNo),false),
    claimAttempt:(a,lease)=>transaction(d=>{const job=d.jobs.find(j=>j.id===a.jobId);if(!job||isFinalJob(job)||(lease&&job.workerLease?.id!==lease)||d.attempts.some(p=>p.jobId===a.jobId&&p.attemptNo===a.attemptNo))return false;d.attempts.push(a);return true;}),
    updateAttempt:a=>transaction(d=>{if(a.predictionId&&d.attempts.some(p=>p.id!==a.id&&p.predictionId===a.predictionId))throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'),{code:'IDEMPOTENCY_CONFLICT',status:409});
      const i=d.attempts.findIndex(p=>p.id===a.id);if(i>=0)d.attempts[i]=a;}),
    remove:id=>transaction(d=>{d.jobs=d.jobs.filter(j=>j.id!==id);d.attempts=d.attempts.filter(a=>a.jobId!==id);})
  };
  fileStores.set(filename,store);return store;
}
