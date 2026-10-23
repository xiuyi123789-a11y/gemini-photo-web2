# 图像复刻 P0 修复验收记录（v1.4.1 候选）

日期：2026-10-23（北京时间）。基线：`3c9c7bbb95c90a61be57ce35788f5e835405514d`。修复分支：`codex/replication-p0-recovery`。

本轮已实现五类代码修复，完成 61 项本地 Mock 回归、TypeScript 检查和生产构建。**没有创建真实 Replicate 预测，没有部署生产服务，没有修改生产数据库。**生产事故是否消失仍需后续获准部署后的验收，不能用本地测试代替。

## 1. 修复范围和行为

| 已确认缺陷 | 最小修复 | 主要文件 |
| --- | --- | --- |
| 前端把等待状态和费用保护绑定，异常后永久显示分析中 | `pendingKind` 与持久化 `operations` / `feeLocked` 分开；异常和离线均停止页面等待，保留可见的重新连接、安全结束入口；刷新可从服务器受理回执恢复 | `components/ImageReplicationView.tsx`、`services/replicationService.ts` |
| 大请求中断时没有 job；404 后无法判定是否可重提 | 上传前先持久化小体积受理回执；按 owner / requestId / kind / inputFingerprint 核对；只有服务器原子封存成功才移除费用保护，拒绝同一 UUID 的迟到上传；不自动重试收费提交 | `server/replication.js`、`server/replication-store.js`、`server/replication-validation.js`、前端 service |
| GET 查询隐式唤醒 worker，可能执行旧生图或后续收费样本 | 所有任务 GET 仅查询；增加显式恢复 POST，强制 `resumeOnly`；缺少原 attempt 的 queued 任务安全结束，恢复中断批次不再创建下一样本 | `server/replication.js`、`server/replication-worker.js` |
| JSON 解析前的中断、超限被统一返回 500 | 复刻请求按异常类型区分 400 `UPLOAD_INTERRUPTED`、400 `INVALID_JSON`、413 `PAYLOAD_TOO_LARGE`；保留其他合法 4xx；记录安全 requestId 和已收/预期字节数 | `server/app.js`、`shared/replication-contract.js` |
| worker 在创建 attempt 前失败也被标为 running，永远无预测可恢复 | 已知零 attempt 的素材读取/输入准备失败进入 failed / `INPUT_PREPARATION_FAILED`；查询 attempt 本身失败时不猜测为零、不解除保护 | `server/replication-worker.js` |

原有分析模型 `openai/o4-mini`、生图模型 `google/nano-banana-2` 未变。`server/replication-prompts.js` 与基线完全相同；分析输入仍为场景图在前、全部产品参考图随后，`reasoning_effort: low`、`max_completion_tokens: 4096`。分析入口不调用生图模型。普通修图等其他业务流程未重构。

## 2. 受理与费用保护的准确边界

正常流程：保存本地 requestId → 小体积 POST 受理 → 上传完整素材 → 持久化 job 与 accepted 回执 → 原始 worker 可以创建用户这次明确提交的预测。

中断流程：先纯查询原 requestId；没有 job 或查询失败时尝试安全封存。404 只说明查询时没有找到 job，**不是免除费用风险或允许重发的凭据**。

- `closed: true`：服务器已封存 UUID，且没有本地预测提交 attempt；后续迟到上传或旧 worker 都不能再为该请求创建预测。此时允许解除保护并由用户重新提交。
- `closed: false`：已存在 attempt，包括 predictionId 尚未取得的情况；保留原 job 和费用保护，继续核对原预测，不创建替代预测。
- 封存响应丢失或断网：停止页面加载，保留回执标识、恢复入口和费用保护；再次查询/封存是幂等的。
- 已知 predictionId 的恢复：只查询、取回原结果，必要时执行既有取消逻辑；不会 POST 新预测。
- 原始 worker 正在执行时，恢复请求不抢占其有效租约。进程消失后，租约过期才允许接管；默认租约约 90 秒。

封存与 attempt 插入在 PostgreSQL 内锁定同一 job 行；本地文件存储使用同一串行事务队列。封存先赢，旧租约插入失败；attempt 先赢，封存就不能确认无提交。不能把“请求超时”或“安全结束按钮被点击”本身视为已取消远端任务。

## 3. API 和持久化变化

新增 `replication_requests` 表，主键 `(user_id, request_id)`；部分唯一索引限制每账号最多一个 `reserved/preparing` 受理请求。表只存操作身份、状态和关联信息，不存 Token、图片字节、完整提示词。迁移为现有 `database.init()` 内的增量建表，**本轮未在生产执行**。

| 接口（统一前缀 `/api/replication`） | 行为 |
| --- | --- |
| `POST /requests` | 记录轻量受理身份；重复相同身份返回原回执，不调用供应商 |
| `GET /requests/:requestId` | 只读回执，不启动 worker |
| `POST /requests/:requestId/close` | 原子封存未提交请求；存在 attempt 则返回原 job 并保留费用保护 |
| `POST /jobs/:id/resume` | 显式恢复已有预测；没有 attempt 时安全终止，不创建新预测 |
| `GET /active?kind=...` | 只读返回该账号活动 job 和未完成受理回执，支持本地标识丢失后的恢复 |
| 原有 job、request、asset GET | 全部只读，不调用供应商 create / get / cancel，不修改任务或租约 |
| 重复原 `/analysis` 或 `/generation` POST | 已有持久 job 就返回该 job，不再唤醒创建；正在准备则 409；已封存且无旧 job 则 410 |

GET、受理和安全封存无需 Replicate Token，仍须通过现有账号认证。供应商操作保留原账号指纹校验。Token 含非法 HTTP 头字符时，在保存新操作和发出 HTTP 前拒绝。新增请求跟踪头 `x-replication-request-id`。

## 4. Mock 验收结果

全量命令：`npm test`。结果：**61 passed，0 failed，0 skipped**。

| 场景 | 核对结果 |
| --- | --- |
| 正常文字、字符串数组输出、空/非法分析输出 | 正确回填或明确失败；分析只用 o4-mini，无自动生图 |
| 请求体中断、创建 POST 超时、503、完全离线 | 停止页面等待；不自动重发预测；按封存是否确认保留/解除费用保护 |
| 404 且无 job | 单次 404 不清除保护；封存成功后可重新提交 |
| 封存与素材准备、worker 读取图片并发 | 迟到请求与旧 worker 均不能在封存确认后创建预测 |
| 供应商创建响应丢失、predictionId 未知 | 只保留一个 attempt，submission_unknown；重启/重连/重复 POST 均不重新创建 |
| 远端已完成但前端断线 | 通过 GET 找回原 job 和分析文字，不再付费创建 |
| 重复点击、并发 POST、并发受理 | 同一任务仅一次 Mock 创建；每账号最多一个准备中的受理请求 |
| 刷新、本地标识遗失、服务端重启 | 恢复原回执/job；有明确恢复入口，无永久提交加载状态 |
| GET 遇到旧 queued 生图 | 查询保持 queued、数据库 revision 不变、零生图；显式恢复安全终止 |
| 重启后的已知预测与中断批次 | 仅恢复已存在预测；保留已有候选，不创建下一收费样本 |
| 请求体格式错误 / 解压后超过 50 MiB | 实际 Express 中分别返回 400 / 413；无 job、无模型调用；日志不含测试 Token |
| 账号、素材指纹、模型、取消、审核、既有其他板块回归 | 通过现有全量测试；新增入口受登录认证和 owner 隔离约束 |

测试执行真实前端 TS service / TSX 事件处理逻辑，React hooks、DOM 和网络响应在 VM 中模拟；服务端使用真实 Express、图片处理与本地持久存储，供应商为注入式 Mock；数据库用 pg-mem。`npm test` 预加载外部 fetch 阻断器，禁止测试通过默认 fetch 访问远端模型。测试使用固定假凭据，没有使用真实 Token 发出请求。

原私有 `diagnostic-mocks.test.cjs`、`backend-stall.test.mjs` 已改为调用跟踪的修复验收套件；旧复现源码仅以 `.txt` 保存在私有 `baseline-reproducers` 目录作为历史证据，不再作为通过条件。原历史报告及日志保持原样。本次报告、测试、类型检查、构建证据随验收包交付。

其他检查：`npm run typecheck`、`npm run build`、`git diff --check`、`npm run export:source`。源码包由项目既有导出命令生成，不包含 `.env`、`.local`、数据、密钥、node_modules 或 dist。

## 5. 修改文件

- 前端与契约：`components/ImageReplicationView.tsx`、`services/replicationService.ts`、`shared/replication-contract.js`。
- 后端：`server/replication.js`、`server/replication-worker.js`、`server/replication-store.js`、`server/replication-validation.js`、`server/app.js`。
- 回归：`tests/replication-ui.test.js`、`tests/replication.test.js`、`tests/accounts.test.js`、`tests/block-external-fetch.js`、`package.json`。
- 交付辅助：`server/deployment-check.js`（适配事务客户端、新增私有路由/表/版本检查；未在生产执行）、`src/data/changelog.json`、本报告。

## 6. 剩余风险与后续验收门槛

1. **Mock 不能证明实际 PostgreSQL 多连接锁语义。**pg-mem 在状态改为 accepted/closed 后的部分索引选择存在模拟器偏差，封存测试通过全表扫描核对持久记录；账号测试在 reserved 阶段验证回执的登录隔离，accepted/closed 查询用文件存储覆盖；生产查询没有为模拟器改写。未来生产发布前，需要在隔离 PostgreSQL 17 验证迁移、封存/claim 两种锁顺序和跨进程竞争，不调用模型。
2. UI 测试不是实际浏览器 E2E；未来应在预发布环境验证真实上传中断、标签页并发、刷新和按钮可用性。前端 60 秒传输上限保留，网络中断的来源并未因这次修复而消失；修复目标是中断后的状态、恢复与费用安全。
3. 有 attempt 而无 predictionId 时，系统仍无法凭本地记录证明远端未创建。必须保留费用保护并对账；安全封存不会强行清除它，重启也不会猜测重发。
4. 为阻止旧 UUID 迟到提交，closed 回执当前不自动过期；长期使用将增加小量元数据，需要后续设计保留策略。不能直接删除封存记录来“解锁”。
5. 部分批量任务中断后只恢复已有预测和候选，其余样本明确停止。用户需要重新明确提交新任务才能生成后续样本；此项是保守的费用保护行为。
6. 本轮**不需要且没有进行真实付费验证**。Mock 与隔离数据库/E2E 验证后，如需验收模型结果质量，应另行取得授权，限单次受控分析并记录 requestId / jobId / predictionId；连接健康或修改提示词不能替代本故障的验收。

## 7. 回滚与恢复

本轮只提交并同步修复分支，部署分支和生产服务未切换，因此目前无需生产回滚。未修改的正式基线是 `3c9c7bbb95c90a61be57ce35788f5e835405514d`。本地在工作区干净时可切回原分支查看基线；不要覆盖尚未提交的用户文件。

将来发布后若需回退，优先使用当前补丁代码并设置已有 `REPLICATION_ENABLED=false` 关闭新任务入口，保留只读查询、原预测恢复和安全封存。核对已有 attempt 和远端终态后再处理版本回退。

**禁止直接把复刻流量切回存在 GET 唤醒缺陷的基线。**若必须回退旧镜像，需先在网关暂停复刻 API、阻断旧页面访问，再核对 queued / submitting / submission_unknown / cancel_unknown 等未完结任务。回滚代码不会取消远端预测，也不会撤销已经发生的费用。

保留 `replication_requests` 表、原 job/attempt、封存记录、素材和备份；不要 DROP 新表、删除未知任务或重新提交来代替恢复。代码回退不要求删除增量表。恢复流量前必须确认接收流量的版本保持 GET 只读、且不会替未知任务创建新预测。
