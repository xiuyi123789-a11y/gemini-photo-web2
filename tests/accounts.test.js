import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { newDb } from 'pg-mem';
import { createStore } from '../server/database.js';
import { hashPassword, digest } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { sha256 } from '../server/replication-assets.js';
import { canonicalJson, materialIdentity } from '../shared/replication-contract.js';

let store, server, base, directory, alice, bob, aliceCookie, bobCookie;
const testRoot = fileURLToPath(new URL('../.local/migration-archive/test-data/', import.meta.url));
const password = 'test-only-long-password-729';
async function request(endpoint, { cookie, body, method, headers = {} } = {}) {
  return fetch(base + endpoint, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}
async function login(username) {
  const response = await request('/api/auth/login', { body: { username, password } });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
before(async () => {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  store = createStore(new Pool());
  await store.init();
  const hash = await hashPassword(password);
  alice = await store.createUser('alice', hash);
  bob = await store.createUser('bob', hash);
  await mkdir(testRoot, { recursive: true });
  directory = await mkdtemp(path.join(testRoot, 'quantumleap-test-'));
  const app = createApp({ database: store, dataDir: directory });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  aliceCookie = await login('alice'); bobCookie = await login('bob');
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await store?.pool.end(); if (directory && path.resolve(directory).startsWith(path.resolve(testRoot) + path.sep)) await rm(directory, { recursive: true, force: true }); });

test('every API except auth and health requires a valid session', async () => {
  assert.equal((await request('/api/health')).status, 200);
  for (const endpoint of ['/api/knowledge', '/api/error-notebook', '/api/images/any/file.png', '/api/upscale-image/result/missing', '/api/replication/missing', '/api/replication/request/missing']) {
    assert.equal((await request(endpoint, { headers: { 'x-user-id': alice.id } })).status, 401);
  }
  for (const endpoint of ['/api/analyze-image', '/api/generate-image', '/api/retouch-image', '/api/upscale-image/start', '/api/replication/analysis', '/api/replication/generation', '/api/replication/connectivity', '/api/replication/missing/cancel']) {
    assert.equal((await request(endpoint, { body: {} })).status, 401);
  }
});
test('session cookies are HttpOnly, SameSite Strict; only hashes are stored', async () => {
  const response = await request('/api/auth/login', { body: { username: 'alice', password } });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/);
  const token = header.split(';')[0].split('=')[1];
  assert.equal((await store.getSession(digest(token))).id, alice.id);
  assert.equal(await store.getSession(token), undefined);
});
test('production cookies carry Secure', async () => {
  const { createAuth } = await import('../server/auth.js');
  const express = (await import('express')).default;
  const app = express(); app.use(express.json()); app.use(createAuth(store, { secure: true }).router);
  const s = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password }) });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
  } finally { await new Promise(resolve => s.close(resolve)); }
});
test('forged x-user-id cannot read or overwrite another user knowledge', async () => {
  const entries = [{ id: 'one', promptFragment: 'private-alice' }];
  assert.equal((await request('/api/knowledge', { cookie: aliceCookie, body: entries, headers: { 'x-user-id': bob.id } })).status, 200);
  assert.deepEqual(await (await request('/api/knowledge', { cookie: bobCookie, headers: { 'x-user-id': alice.id } })).json(), []);
  assert.deepEqual(await store.getKnowledge(alice.id), entries);
  await request('/api/knowledge', { cookie: bobCookie, body: [{ id: 'two' }], headers: { 'x-user-id': alice.id } });
  assert.deepEqual(await store.getKnowledge(alice.id), entries);
});
test('images require the owning account', async () => {
  await mkdir(path.join(directory, alice.id, 'images'), { recursive: true });
  await writeFile(path.join(directory, alice.id, 'images', 'test.png'), 'image-fixture');
  const endpoint = `/api/images/${alice.id}/test.png`;
  assert.equal((await request(endpoint, { cookie: bobCookie })).status, 404);
  assert.equal((await request(endpoint, { cookie: aliceCookie })).status, 200);
});
test('replication jobs use the signed-in owner even when x-user-id is forged', async () => {
  let canceled=false;
  const provider = {accountRef:'fake-account',
    create: async () => ({ id:'test-replication-provider', model:'openai/o4-mini', status:'processing' }),
    get: async () => ({ id:'test-replication-provider', model:'openai/o4-mini', status:canceled?'canceled':'processing' }),
    cancel: async () => {canceled=true;return {status:'canceled'};}
  };
  const app = createApp({ database: store, dataDir: directory, replicationProviderFactory: () => provider,replicationOptions:{pollMs:2,logger:()=>{}} });
  const listener = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  const endpoint = 'http://127.0.0.1:'+listener.address().port+'/api/replication';
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'white'}}).png().toBuffer();
  const png='data:image/png;base64,'+bytes.toString('base64');
  const inputFingerprint=sha256(canonicalJson(materialIdentity(sha256(bytes),[{hash:sha256(bytes),angle:'front'}],'产品')));
  const call=(url,cookie,body)=>fetch(endpoint+url,{method:body?'POST':'GET',headers:{cookie,'x-user-id':bob.id,'x-replicate-token':'test-only-unused-token','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try {
    const start=await call('/analysis',aliceCookie,{requestId:randomUUID(),inputFingerprint,sourceImage:png,references:[{image:png,angle:'front'}],target:'产品'});
    assert.equal(start.status,202);const {id}=await start.json();
    assert.equal((await call('/'+id,bobCookie)).status,404);
    assert.equal((await call('/'+id+'/cancel',bobCookie,{})).status,404);
    assert.equal((await call('/'+id,aliceCookie)).status,200);
    // An asset's legacy owner hint must NEVER override the production login cookie.
    const job=await (await call('/'+id,aliceCookie)).json();
    const forgedAsset=job.source.url.replace(/owner=[^&]+/,'owner='+bob.id);
    const assetRequest=(cookie)=>fetch('http://127.0.0.1:'+listener.address().port+forgedAsset,{headers:{cookie}});
    assert.equal((await assetRequest(aliceCookie)).status,200);
    assert.equal((await assetRequest(bobCookie)).status,404);
    assert.equal((await call('/'+id+'/cancel',aliceCookie,{})).status,202);
    for(let i=0;i<20;i++){
      const job=await (await call('/'+id,aliceCookie)).json();
      if(job.status==='canceled')break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  } finally { await new Promise(resolve=>listener.close(resolve)); }
});
test('error notebook is private per account', async () => {
  assert.equal((await request('/api/error-notebook', { cookie: aliceCookie, body: { issue: 'alice only', solution: 'fixed' } })).status, 200);
  assert.deepEqual(await (await request('/api/error-notebook', { cookie: bobCookie })).json(), []);
  assert.equal((await (await request('/api/error-notebook', { cookie: aliceCookie })).json()).length, 1);
});
test('cross-origin writes and login are rejected', async () => {
  const headers = { Origin: 'https://other.example' };
  assert.equal((await request('/api/knowledge', { cookie: aliceCookie, body: [], headers })).status, 403);
  assert.equal((await request('/api/auth/login', { body: { username: 'alice', password }, headers })).status, 403);
});
test('async task results require their owner even with a forged user header', async () => {
  // Unsupported model deliberately exercises job tracking without an external API call.
  const start = await request('/api/upscale-image/start', { cookie: aliceCookie, body: { model: 'test-unsupported', image: 'data:image/png;base64,AAAA' }, headers: { 'x-replicate-token': 'test-only-unused-token' } });
  assert.equal(start.status, 202);
  const { jobId } = await start.json();
  const endpoint = `/api/upscale-image/result/${jobId}`;
  assert.equal((await request(endpoint, { cookie: bobCookie, headers: { 'x-user-id': alice.id } })).status, 404);
  const own = await request(endpoint, { cookie: aliceCookie });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).status, 'failed');
});
test('expired and revoked sessions cannot access data', async () => {
  const token = 'a'.repeat(43);
  await store.addSession(digest(token), alice.id, new Date(Date.now() - 60000));
  assert.equal((await request('/api/knowledge', { cookie: `ql_session=${token}` })).status, 401);
  const cookie = await login('alice');
  assert.equal((await request('/api/auth/logout', { cookie, method: 'POST' })).status, 200);
  assert.equal((await request('/api/knowledge', { cookie })).status, 401);
});
test('bad passwords fail, repeated guesses are throttled', async () => {
  let status;
  for (let n = 0; n < 6; n++) {
    const r = await request('/api/auth/login', { body: { username: 'alice', password: 'wrong-password' } });
    status = r.status;
    assert.ok(status === 401 || status === 429);
  }
  assert.equal(status, 429);
});
