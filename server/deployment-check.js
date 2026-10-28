// Non-billable production checks. Never create or cancel provider predictions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { createPgReplicationStore } from './replication-store.js';
import { createReplicationProvider } from './replication-provider.js';
import { REPLICATION_MODELS } from '../shared/replication-contract.js';

const check = (condition, code) => assert.ok(condition, code);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const get = (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
const fakeId = randomUUID();

async function checkHttp(origin) {
  const health = await get(origin + '/api/health');
  check(health.status === 200 && (await health.json()).status === 'ok', 'HEALTH_FAILED');
  const me = await get(origin + '/api/auth/me');
  const account = await me.json();
  check(me.status === 200 && account.mode === 'accounts' && account.user === null, 'ACCOUNT_MODE_FAILED');
  for (const [method, pathname] of [
    ['GET', '/capabilities'], ['GET', '/active?kind=analysis'],
    ['GET', '/jobs/' + fakeId], ['GET', '/requests/' + fakeId], ['GET', '/assets/' + fakeId + '/source.png?owner=' + fakeId],
    ['POST', '/connectivity'], ['POST', '/analysis'], ['POST', '/generation'],
    ['POST', '/requests'], ['POST', '/requests/' + fakeId + '/close'], ['POST', '/jobs/' + fakeId + '/resume']
  ]) {
    const response = await get(origin + '/api/replication' + pathname, {
      method, headers: { 'Content-Type': 'application/json', 'x-user-id': fakeId },
      ...(method === 'POST' ? { body: '{}' } : {})
    });
    check(response.status === 401, 'AUTH_REQUIRED_' + method + '_' + pathname);
  }
  console.log('HEALTH_ACCOUNT_AND_PRIVATE_API_OK ' + origin);
}

async function checkDatabase() {
  const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    max: 1, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    for (const name of ['users', 'sessions', 'knowledge_bases', 'error_notebook', 'replication_jobs', 'replication_predictions', 'replication_requests']) {
      const result = await client.query('SELECT to_regclass($1) AS relation', [name]);
      check(result.rows[0]?.relation, 'MISSING_TABLE_' + name);
    }
    const index = await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='replication_one_active_user'");
    check(index.rows[0]?.indexdef.includes('UNIQUE INDEX') && index.rows[0]?.indexdef.includes('submission_unknown'), 'ACTIVE_JOB_INDEX_MISSING');
    // All fixtures are private to this uncommitted transaction. No worker can see
    // them; ROLLBACK removes the fixture user, jobs and prediction rows together.
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    const ownerId = randomUUID(), jobId = randomUUID(), requestId = randomUUID();
    await client.query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',
      [ownerId, 'deployment-check-' + ownerId, 'disabled-deployment-fixture']);
    const job = { id: jobId, ownerId, requestId, kind: 'analysis', payloadHash: 'deployment-check',
      status: 'queued', revision: 0, updatedAt: Date.now() };
    const store = createPgReplicationStore(client,{inTransaction:true});
    await store.create(job);
    assert.equal((await createPgReplicationStore(client).byRequest(ownerId, requestId)).id, jobId);
    await store.update(jobId, current => ({ ...current, status: 'running' }));
    assert.equal((await store.get(jobId)).revision, 1);
    async function mustBeUnique(statement, values) {
      await client.query('SAVEPOINT deployment_unique');
      let code;
      try { await client.query(statement, values); } catch (error) { code = error.code; }
      await client.query('ROLLBACK TO SAVEPOINT deployment_unique');
      check(code === '23505', 'UNIQUENESS_GUARD_FAILED');
    }
    await mustBeUnique('INSERT INTO replication_jobs(job_id,user_id,kind,request_id,payload_hash,status,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [randomUUID(), ownerId, 'analysis', randomUUID(), 'deployment-check', 'queued', '{}']);
    await mustBeUnique('INSERT INTO replication_jobs(job_id,user_id,kind,request_id,payload_hash,status,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [randomUUID(), ownerId, 'analysis', requestId, 'deployment-check', 'failed', '{}']);
    const attempt = { id: randomUUID(), jobId, attemptNo: 0, model: REPLICATION_MODELS.analysis };
    assert.equal(await store.claimAttempt(attempt), true);
    assert.equal(await store.claimAttempt({ ...attempt, id: randomUUID() }), false);
    await store.updateAttempt({ ...attempt, predictionId: 'deployment-check-' + randomUUID() });
    assert.equal((await createPgReplicationStore(client).attempts(jobId)).length, 1);
    await client.query('ROLLBACK');
    transactionOpen = false;
    const removed = await client.query('SELECT id FROM users WHERE id=$1', [ownerId]);
    assert.equal(removed.rows.length, 0);
    console.log('POSTGRES_SCHEMA_STORE_IDEMPOTENCY_AND_ROLLBACK_OK');
  } finally {
    if (client) { if (transactionOpen) await client.query('ROLLBACK').catch(() => {}); client.release(); }
    await pool.end();
  }
}

async function checkBundles(publicOrigin) {
  const html = await fs.readFile('dist/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="(\/assets\/[^"?#]+\.js)"/g)].map(match => match[1]);
  check(scripts.length > 0, 'BUILD_SCRIPTS_MISSING');
  let text = '';
  for (const script of scripts) {
    const bytes = await fs.readFile('dist' + script);
    text += bytes.toString('utf8');
    if (publicOrigin) {
      const response = await get(publicOrigin + script);
      check(response.status === 200 && hash(Buffer.from(await response.arrayBuffer())) === hash(bytes), 'PUBLIC_BUNDLE_MISMATCH');
    }
  }
  for (const marker of ['v1.5.3', 'Gemini 2.5 Flash', 'replication_v2_', '识别产品与替换位置', '开始替换', '安全结束本次提交', '重新加载图片', '取回已生成图片']) check(text.includes(marker), 'V2_UI_MARKER_MISSING_' + marker);
  if (publicOrigin) {
    const response = await get(publicOrigin);
    const publicHtml = await response.text();
    check(response.status === 200 && scripts.every(script => publicHtml.includes(script)), 'PUBLIC_HTML_VERSION_MISMATCH');
  }
  console.log('V2_UI_AND_PUBLIC_BUNDLE_OK');
}

async function main() {
  check(process.env.NODE_ENV === 'production', 'PRODUCTION_ENV_REQUIRED');
  check(process.env.DATABASE_URL || process.env.PGHOST, 'POSTGRES_CONFIG_REQUIRED');
  assert.deepEqual(REPLICATION_MODELS, { analysis: 'google/gemini-2.5-flash', generation: 'google/nano-banana-2' });
  const publicOrigin = process.argv[2];
  check(!publicOrigin || /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(publicOrigin), 'INVALID_PUBLIC_ORIGIN');
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } }).png().toBuffer();
  check(png.length > 0, 'SHARP_FAILED');
  await checkDatabase();
  await checkHttp('http://127.0.0.1:' + (process.env.PORT || '3001'));
  if (publicOrigin) await checkHttp(publicOrigin);
  await checkBundles(publicOrigin);
  if (process.env.REPLICATE_API_TOKEN?.trim()) {
    const models = await createReplicationProvider(process.env.REPLICATE_API_TOKEN).connectivity();
    check(models.length === 2 && models.every(model => model.accessible), 'MODEL_METADATA_FAILED');
    console.log('REPLICATE_MODEL_METADATA_OK (GET only; no prediction created)');
  } else {
    for (const model of Object.values(REPLICATION_MODELS)) {
      const response = await get('https://api.replicate.com/v1/models/' + model);
      check([200, 401, 403].includes(response.status), 'REPLICATE_NETWORK_FAILED');
    }
    console.log('REPLICATE_NETWORK_ONLY_OK (server token absent; user BYOK not tested)');
  }
  console.log('DEPLOYMENT_V2_NONBILLABLE_CHECK_OK');
}

main().catch(error => {
  // Do not log credentials, SQL values, provider bodies or arbitrary error text.
  console.error('DEPLOYMENT_CHECK_FAILED', error.code || (error.name === 'AssertionError' ? error.message : error.name));
  process.exitCode = 1;
});
