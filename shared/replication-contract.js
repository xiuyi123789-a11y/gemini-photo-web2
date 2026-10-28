export const REPLICATION_MODELS = Object.freeze({ analysis: 'google/gemini-2.5-flash', generation: 'google/nano-banana-2' });
export const REPLICATION_MODEL_NAMES = Object.freeze({analysis:'Gemini 2.5 Flash',generation:'Nano Banana 2'});
export const MAX_REFERENCES = 6;
export const FINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'completed_needs_review', 'quality_failed']);
export const isFinalJob = job => FINAL_STATUSES.has(job.status);
export const canonicalJson = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonicalJson(v)))
    : Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, JSON.parse(canonicalJson(value[k]))]))
  : value);
export const materialIdentity = (sourceHash, references, target = '') => ({ sourceHash, references, target: target.trim() });
export const recoveryKey = kind => `replication_v2_${kind}`;
// A response for an old source, another account, or another intent cannot update this operation.
export function matchesOperation(expected, job) {
  return !!expected && job.kind === expected.kind && job.requestId === expected.requestId &&
    job.ownerId === expected.ownerId && job.inputFingerprint === expected.inputFingerprint &&
    (!expected.jobId || job.id === expected.jobId);
}
// A saved human rejection is history, not a new model/API error. Local failure
// reasons must remain visible instead of being flattened into QUALITY_FAILED.
export function compositionFailure(job){
  if(job?.kind!=='generation'||job.status!=='quality_failed')return null;
  if(job.stage==='human_review')return {code:'RESULT_REJECTED',message:'上次结果经审核未通过，原图和历史记录已保留。可以重新测试智能合成；这不会重新生图。'};
  const reasons=[...(job.quality?.reasons||[]),...(job.results?.at(-1)?.quality?.reasons||[])];
  const code=reasons.find(r=>r!=='HUMAN_PRODUCT_IDENTITY_REVIEW_REQUIRED'&&typeof ERROR_MESSAGES[r]==='string')||'COMPOSITION_FAILED';
  return {code,message:ERROR_MESSAGES[code]};
}
export const ERROR_MESSAGES = {
  COMPOSITION_FAILED:'本次智能合成未完成，模型原图已保留。请修正识别范围后重新测试；不会重新生图。',
  SEGMENTATION_UNAVAILABLE:'本地分割组件未配置或依赖缺失。已保留模型原图，不使用涂抹范围强行裁切。',
  SEGMENTATION_TIMEOUT:'本地轮廓识别超时，未输出合成图；模型原图已保留。',
  SEGMENTATION_BUSY:'本地分割正在处理其他图片，已保留模型原图。可稍后仅重新合成，不必再次生图。',
  SEGMENTATION_FAILED:'本地轮廓识别失败，未输出合成图。可修正产品内部或背景提示点后仅重新合成。',
  SEGMENTATION_INVALID:'分割返回的轮廓数据无效，未输出合成图。',
  CONTOUR_UNCERTAIN:'产品完整轮廓无法可靠确认，请补充产品内部或背景提示点。',
  INSTANCE_AMBIGUOUS:'多个产品轮廓发生冲突或对应不明确，已停止合成。',
  ALIGNMENT_UNRELIABLE:'模型图与原图无法可靠对齐，未强行拉伸或输出合成图。',
  OCCLUSION_UNCERTAIN:'袜子、裤脚等遮挡尚未可靠确认，请在原图上添加保护遮挡物提示点。',
  BACKGROUND_RESTORATION_UNCERTAIN:'旧产品移除后的背景无法可靠恢复，未输出可能有残留的合成图。',
  OLD_PRODUCT_RESIDUE:'旧产品移除区域仍与原产品过于一致，疑似残留，未输出合成候选。',
  MODEL_UNAVAILABLE: '供应商返回模型不存在或已停用。任务已停止，未自动重试；请核对模型配置后再提交。',
  REQUEST_CLOSED: '本次请求已安全结束，尚未启动模型。请核对素材后重新点击。',
  ASSET_PREPARATION_FAILED: '素材已收到，但服务器处理失败。已保留当前选择，可稍后重试。',
  ANIMATED_IMAGE_UNSUPPORTED: '暂不支持多帧或动态图片，请使用静态 JPG、PNG 或 WEBP。',
  QUEUE_BUSY: '当前任务队列繁忙，请稍后重新提交。已保留所选素材。',
  REQUEST_PROCESSING: '素材仍在接收，请查询原请求或安全结束本次提交。',
  INPUT_PREPARATION_FAILED: '素材读取或准备失败，尚未调用模型；请检查图片后重新提交。',
  PRE_SUBMISSION_INTERRUPTED: '服务重启前任务尚未提交模型，已安全结束；请重新提交。',
  TOKEN_HEADER_INVALID: 'API Key 含无效字符，请在设置中检查；本次未发送请求。',
  INVALID_JSON: '请求内容不完整或格式无效，请重新选择素材。',
  PAYLOAD_TOO_LARGE: '上传请求过大，请减小图片体积。',
  UPLOAD_INTERRUPTED: '素材传输已中断，请核对原请求状态。',
  ANALYSIS_REQUIRED: '请先识别产品与替换位置。',
  ANALYSIS_SCHEMA_INVALID: '分析返回不完整或格式不符合要求，未启动生图。可查看原始分析文本。',
  ANALYSIS_STALE: '素材或分析版本已改变，请重新分析并确认。',
  TARGET_SELECTION_REQUIRED: '请在识别到的产品上涂抹，确认需要替换的范围。',
  IDEMPOTENCY_CONFLICT: '请求标识已用于不同内容，已阻止重复提交。',
  SUBMISSION_UNKNOWN: '提交结果待核对；可能已创建远端任务，不会自动重新提交。',
  CANCEL_UNKNOWN: '远端取消未确认，请核对供应商运行记录；仍可能计费。',
  PREDICTION_TIMEOUT: '模型超时，正在核对远端终态。',
  PROVIDER_ACCOUNT_MISMATCH: '请使用创建该任务时的 Replicate 凭据查询或取消。',
  CREDENTIAL_REQUIRED: '请输入创建任务时使用的 Replicate API Key 以恢复查询。',
  TASK_BUSY: '已有收费任务运行或提交待核对，请先处理该任务。',
  FEATURE_DISABLED: '图像复刻新任务入口已关闭，现有任务仍可查询。',
  QUALITY_FAILED: '结果未通过图像检查，请查看原始结果与问题说明。',
  OUTPUT_INVALID: '模型输出不是可用图片，未标记为复刻成功。',
  RESULT_DOWNLOAD_INTERRUPTED: '模型已生成，图片下载中断。请重新连接取回原结果；不会重新生图。',
  INPUT_INVALID: '素材或参数无效，请检查后重试。',
  TOKEN_INVALID: 'Replicate Token 无效或无模型权限。',
  BALANCE_REQUIRED: 'Replicate 额度不足。',
  PROVIDER_REJECTED: '供应商拒绝了输入，未自动重试。',
  PREDICTION_FAILED: '模型执行失败，未自动重试。',
  INPUT_FINGERPRINT_MISMATCH: '素材摘要不一致，请重新检查上传内容。',
  OUTPUT_OPTION_DISABLED: '当前未开放该分辨率或批量数量。',
  COST_CONFIRMATION_REQUIRED: '请先确认本次图像预测数量与费用提示。',
  JOB_NOT_FOUND: '任务不存在或不属于当前账号。',
  JOB_EXPIRED: '任务已超过保存期限，请保留所需文件。',
  PROVIDER_UNREACHABLE: '供应商查询暂时中断，后台可能仍在运行；请重新连接查询。',
  POSTPROCESSING_INTERRUPTED: '图像检查尚未完成，可重新连接继续后处理；不会重新生图。',
  RECONCILIATION_EVIDENCE_REQUIRED: '该预测的模型、时间或输入摘要无法匹配，未关联任务。',
  REVIEW_REQUIRED: '请先完成全部产品与场景核验项。',
};
