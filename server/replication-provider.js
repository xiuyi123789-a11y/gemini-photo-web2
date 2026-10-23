import { createHash } from 'node:crypto';
import { REPLICATION_MODELS } from '../shared/replication-contract.js';

const API = 'https://api.replicate.com/v1';
const allowed = new Set(Object.values(REPLICATION_MODELS));
export const accountRef = token => createHash('sha256').update('replication-provider-v2\0' + token).digest('hex');
export const providerFailure = (code, status = 502, uncertain = false) => Object.assign(new Error(code), { code, status, uncertain });

// Native fetch has no application retries. In particular, NEVER wrap create() in SDK retries.
export function createReplicationProvider(token, { fetchImpl = fetch, requestTimeoutMs = 30000, deadlineSeconds = 300 } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw providerFailure('CREDENTIAL_REQUIRED', 401);
  const account = accountRef(token);
  async function request(method, pathname, body, creating = false, signal) {
    let response;
    try {
      response = await fetchImpl(API + pathname, {
        method, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          ...(creating ? { 'Cancel-After': `${Math.max(5, Math.min(86400, deadlineSeconds))}s` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs)
      });
    } catch { throw providerFailure(creating ? 'SUBMISSION_UNKNOWN' : 'PROVIDER_UNREACHABLE', 502, creating); }
    if (!response.ok) {
      const uncertain = creating && (response.status === 429 || response.status >= 500 || response.status === 408);
      const code = uncertain ? 'SUBMISSION_UNKNOWN' : [401, 403].includes(response.status) ? 'TOKEN_INVALID'
        : response.status === 402 ? 'BALANCE_REQUIRED' : 'PROVIDER_REJECTED';
      // Do not propagate upstream bodies, URLs, headers, or fetch error messages.
      throw Object.assign(providerFailure(code, response.status, uncertain),{httpStatus:response.status});
    }
    try { const data=await response.json();if(data&&typeof data==='object')Object.defineProperty(data,'httpStatus',{value:response.status});return data; }
    catch { throw providerFailure(creating ? 'SUBMISSION_UNKNOWN' : 'OUTPUT_INVALID', 502, creating); }
  }
  const predictionId = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{6,100}$/.test(id)) throw providerFailure('OUTPUT_INVALID');
    return encodeURIComponent(id);
  };
  return {
    accountRef: account,
    async create(model, input) {
      if (!allowed.has(model)) throw providerFailure('MODEL_NOT_ALLOWED', 400);
      return request('POST', `/models/${model}/predictions`, { input }, true);
    },
    get: id => request('GET', '/predictions/' + predictionId(id)),
    cancel: id => request('POST', '/predictions/' + predictionId(id) + '/cancel', {}),
    async connectivity() {
      return Promise.all([...allowed].map(async model => { await request('GET', '/models/' + model); return { model, accessible: true }; }));
    }
  };
}
