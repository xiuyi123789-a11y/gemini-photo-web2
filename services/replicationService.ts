import { userStorage } from './browserStorage';
import { getUserId } from './userIdentity';
import { fileToBase64 } from './replicateService';

export type ReferenceAngle = 'front' | 'side' | 'back' | 'detail' | 'other';
export type PreserveKey = 'background' | 'composition' | 'lighting' | 'perspective';
export type ReplicationKind = 'analysis' | 'generation';
export type ReplicationJob = {
  id: string; kind: ReplicationKind;
  status: 'queued' | 'analyzing' | 'generating' | 'canceling' | 'succeeded' | 'failed' | 'canceled';
  completed: number; total: number; analysis: string | null; images: string[]; error: string | null;
  resolution: string | null; createdAt: number;
};
export type ReplicationInput = {
  source: File; references: Array<{ file: File; angle: ReferenceAngle }>; target: string;
  analysis: string; preserve: PreserveKey[]; resolution: string; count: number; notes: string;
  region: {x:number;y:number;width:number;height:number}|null;
};
const request = async (path: string, body?: unknown): Promise<any> => {
  const token = userStorage.getItem('replicate_api_token');
  const response = await fetch('/api/replication' + path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-user-id': getUserId(), ...(token ? { 'x-replicate-token': token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败（HTTP ' + response.status + '）'), {status:response.status});
  return data;
};
export async function startReplication(kind: ReplicationKind, input: ReplicationInput): Promise<ReplicationJob> {
  const [sourceImage, ...images] = await Promise.all([fileToBase64(input.source), ...input.references.map(ref => fileToBase64(ref.file))]);
  // This POST is deliberately not retried automatically: generation is a paid operation.
  const requestId=crypto.randomUUID();
  userStorage.setItem('replication_active_job','pending:'+requestId);
  try { return await request('/' + kind, {
    requestId, sourceImage,
    references: input.references.map((ref,index) => ({ image: images[index], angle: ref.angle })),
    target: input.target, analysis: input.analysis, preserve: input.preserve,
    resolution: input.resolution, count: input.count, notes: input.notes, region:input.region
  }); } catch(error) {
    const status=(error as {status?:number}).status;
    if(status && status<500){userStorage.removeItem('replication_active_job');throw error;}
    // A lost response may already have created a paid task. Look it up; never resubmit.
    try{return await request('/request/'+requestId);}
    catch(lookupError){
      if((lookupError as {status?:number}).status===404)userStorage.removeItem('replication_active_job');
      throw error;
    }
  }
}
export const getReplicationJob = (id: string): Promise<ReplicationJob> => request(id.startsWith('pending:')?'/request/'+encodeURIComponent(id.slice(8)):'/' + encodeURIComponent(id));
export const cancelReplicationJob = (id: string): Promise<ReplicationJob> => request('/' + encodeURIComponent(id) + '/cancel', {});
export const checkReplicationConnection = (): Promise<{ success: boolean; models: Array<{ model: string; accessible: boolean }> }> => request('/connectivity', {});
