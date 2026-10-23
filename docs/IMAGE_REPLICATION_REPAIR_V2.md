# 图像复刻 V2 修复与交付记录

日期：2026-10-23，Asia/Shanghai。基线：`chore/tencent-cloud-migration` / `7cecf2aecdabc3003ef055cd1e6ed7a1b6e3e5ad` / v1.3.1。修复分支：`codex/replication-repair-v2`，页面版本 v1.4.0。依据用户提供的《图像复刻模块修复设计与 Codex 执行指令（提案 V1）》增量实现。

本次只改复刻及其必要的数据库、静态资源与配置接入；普通修图的 Nano Banana 和 Flux Fill 分支保留。所有推理测试使用 fake provider 和本地 fixtures；没有真实付费预测、线上部署或生产数据库修改。

## 1. 证据审计与结论边界

源码确认旧分析按钮走 analysis 分支、生成按钮才有自动分析后生成；共享 active_job 和 SDK 底层重试是风险，不能凭它们认定用户误触发的根因。

本次只读 GET 本地 `.env` Token 对应的供应商预测历史，HTTP 200。当日查询范围是北京时间 2026-10-23；返回相关记录 o4-mini 2 条、Nano Banana 2 2 条，均为既有 succeeded。时间分别约为北京时间 10:59:47/15:12:54（分析）、11:00:00/11:07:30（生图）。查询没有创建预测，没有读取或导出图片内容和完整请求体，没有查询到实际账单金额。

没有原始 Network 录制、准确故障点击时间、旧 jobId，也未确认生产用户是否使用该本地 Token。因此这些记录只能证明该凭据账户发生过相应预测，**无法证明“点击分析导致生图”或具体收费金额**。生产访问日志与当前运行 bundle 本次未登录核实。脱敏审计存于私有 `.local/migration-archive/replication-v2-readonly-audit.json`，不提交。

## 2. 已实现的行为

- **仅分析**：`POST /analysis` 只接受素材、角度、目标、UUID requestId 和 inputFingerprint，拒绝 count/resolution/model 等生成参数。只用 `openai/o4-mini`，输出经严格本地字段、长度、证据索引、实例 ID 校验；成功 images=[]。无有效 JSON 则 ANALYSIS_SCHEMA_INVALID，保留原文，不追加收费格式修复。
- **显式生成**：删除自动分析后生成分支。用户先确认可编辑分析，服务端保存 revision、SHA-256、confirmedAt；生成必须引用本人成功且已确认的 analysisJobId 与当前 hash。缺分析409、失效分析409、缺实例/合法范围422。图像模型固定 Nano Banana 2。
- **实例与范围**：默认不选任何实例，可分别选左侧/右侧对象或全部。逐对象多边形编辑范围、独立前景保护多边形、撤销顶点/保护区。坐标绑定 EXIF 校正后的源尺寸和 SHA-256；拒绝越界、空范围、过大/自交多边形和完全被保护遮住的编辑范围。
- **候选与审核**：独立保存规范化原图、模型原始输出、合成候选及文件摘要/尺寸/格式。比例不符不 fit:fill；只做等比缩放、局部合成，保护区优先恢复原图。逐实例不变检查失败 → quality_failed；其余候选 → completed_needs_review。只有用户逐项确认身份、全部对象、遮挡与场景后才能标 succeeded。
- **恢复隔离**：analysisJob/generationJob 分开，分别存 `replication_v2_analysis` / `replication_v2_generation`；核对 owner、kind、requestId、jobId、inputFingerprint，忽略较旧 revision。旧 shared key 不自动串入新任务。刷新恢复服务器素材、任务、候选及所选范围；确认与费用选项不会被自动勾选。
- **费用防护**：显式预测数量确认，默认1张；4K/批量默认关闭。创建结果未知时不重发 POST；重连只查原请求/预测。取消阻止后续候选，并查询远端终态；cancel_unknown 不表示已取消或免计费。

## 3. 持久存储与供应商调用

`server/replication-store.js` 为 PostgreSQL 新增两张表：

| 表 | 主要字段/约束 |
|---|---|
| replication_jobs | job_id UUID PK、user_id FK users、kind、request_id UUID、payload_hash、status、revision、document JSONB；UNIQUE(user_id,request_id) |
| replication_predictions | local_attempt_id UUID PK、job_id FK、attempt_no、prediction_id nullable UNIQUE、document JSONB；UNIQUE(job_id,attempt_no) |

job JSONB 包含素材 checksum/order、source hash、私有资产引用、分析修订/关联、选区、状态、时间与过期信息。prediction JSONB 包含账户不可逆指纹、模型、输入摘要、模板版本、提交/确认/取消时间、远端状态、有限 metrics、对账状态；没有 Token、Base64 或完整 prompt。

部分唯一索引限制每用户一个非终态任务，包含 submission_unknown/cancel_unknown；乐观 revision 更新避免旧状态覆盖。唯一 attempt 在外发前落库，工作租约和心跳防止多个 worker 同时处理同一 job。开发无数据库模式写原子 JSON 文件，只限单服务进程；生产始终用 PostgreSQL。

原项目没有版本化迁移工具，本次沿用 `database.init()` 的 CREATE IF NOT EXISTS，加两张表和索引，不修改已有表数据。该 DDL 仅在本地 pg-mem 模拟执行过；**未对生产执行**。日后启动新镜像会执行增量 DDL，发布前必须备份并在测试 PostgreSQL 验证。

`server/replication-provider.js` 使用原生 fetch 向固定官方模型端点只发一次创建 POST；不经过 SDK，不设置同步等待。取得 prediction ID 后立即持久化，再 GET 轮询。设置 Cancel-After 远端期限，和浏览器超时独立；规则依据 [Replicate 创建预测文档](https://replicate.com/docs/topics/predictions/create-a-prediction) 与 [HTTP API](https://replicate.com/docs/reference/http)。HTTP429/408/5xx 或网络/响应不明都不会自动重发创建。读接口允许再次查询；取消也以远端 GET 终态为准。

输入图片仍兼容 Data URL，但先验证/规范化并私有保存。普通用户输入不接受任意 URL；供应商图片下载只允许 HTTPS replicate.delivery 及其子域，限制大小/像素和跳转。原图与保护像素的比较基准是方向和 sRGB 校正后的解码图。

## 4. 状态与接口

状态：queued → submitting → running → postprocessing → 分析 succeeded / 生图 completed_needs_review。其他可为 submission_unknown、failed、cancel_requested、cancel_unknown、canceled、quality_failed。生图审核通过后才 succeeded，旧轮询不能将终态降回运行。

| 接口（前缀 `/api/replication`） | 作用 |
|---|---|
| GET `/capabilities` | 返回新任务开关、数量/分辨率/参考数限制 |
| POST `/connectivity` | 只查询两个模型元数据 |
| POST `/analysis` / `/generation` | 强类型路由、固定模型、HTTP202，返回 jobId/id/kind/status/requestId 等 |
| GET `/jobs/:id` | 本人任务、阶段、分析、原图/候选、预测摘要和错误码 |
| GET `/active?kind=analysis\|generation` | 本人按 kind 查询未结任务，允许原凭据恢复 GET 轮询 |
| GET `/request/:requestId` | 请求回查；同UUID同hash返回旧任务，异kind/hash为409冲突 |
| POST `/jobs/:id/cancel` | HTTP202取消请求，不等于远端已终止 |
| POST `/jobs/:id/revision` | `{text,previousHash}`；确认分析并保存修订/hash/confirmedAt |
| POST `/jobs/:id/review` | `{decision:"accept"\|"reject",checks}`；accept必须四项核验true |
| POST `/jobs/:id/reconcile` | 手动提供 predictionId；核对原凭据、模型、创建时间和输入hash才可关联未知提交 |
| GET `/assets/:id/:name` | 按本人任务元数据白名单读取私有 PNG |

旧 GET `/:id` 和 POST `/:id/cancel` 保留别名；旧内存任务不能恢复，也不会自动迁移成新任务。旧创建 payload 不再静默兼容：缺新指纹/确认/范围会明确拒绝，避免继续使用旧自动链路。必须同时更新前端与后端，不能混用旧页面。

生成请求包括：UUID requestId、inputFingerprint、analysisJobId、analysisRevisionHash、selectedInstances、masks、protectMasks、maskSpace（规范尺寸和 source SHA）、count/resolution、preserve/notes、confirmedPredictions。masks 为每实例 points:[{x,y}]，0..1 归一化；不传供应商 mask 参数，因为该模型没有此项硬约束。本地合成负责像素保护。

生产 Cookie 决定所有任务/资产归属，不能用 header/query 越权。本地 legacy 的 img 标签不能带自定义身份头，因此资产 URL 附 owner 提示，只有无数据库开发模式采用；生产依然优先会话身份，回归覆盖伪造提示。

## 5. 可调配置、保留与回滚

| 配置 | 默认与说明 |
|---|---|
| REPLICATION_ENABLED | true；false仅关闭新建，查询/取消/审核仍可用 |
| REPLICATION_ADVANCED_OUTPUTS | false；确认真实效果后再开放2/4张及4K |
| REPLICATION_TIMEOUT_SECONDS | 300；应用限制5–900秒，供应商 Cancel-After 同步配置 |
| REPLICATION_RETENTION_DAYS | 30；限制1–365天，过期终态资产/任务每小时清理 |
| REPLICATION_MAX_REFERENCES | 6；限制1–6，前端从 capabilities 读取 |

未核实的远端提交/取消不自动过期删除；存在未过期依赖的分析也保留。没有将 Token 写入库、图片文件或日志。BYOK 重启恢复需原凭据再次由用户会话提供；缺失时任务可读，但无法替用户查询供应商。工作租约失效最长约90秒，之后 GET 可接管恢复；不会重新 POST 已有 attempt。

回滚步骤（仅说明，本次未执行）：

1. 在维护窗口关闭新建任务入口（REPLICATION_ENABLED=false，容器环境变更需重建 app），继续保留查询/取消；先处理已知远端任务，特别是 unknown。
2. 备份 PostgreSQL、整个数据卷、当前代码/镜像与配置。记录部署提交和未结预测，不删除审计表。
3. 回退 app 镜像和页面到已审查旧版本；保留新增表与 `data/<owner>/replication/` 文件。旧程序不读取这些表，勿自动 DROP TABLE。
4. 旧版入口可能重新引入原有风险，不能把镜像回退当作取消供应商预测；V2 未结记录须由维护者继续核对。更稳妥的是关闭复刻入口直至恢复新查询能力。

Docker 运行阶段增加复制 shared/，否则后端导入会失败。没有更换普通修图 SDK 或模型，也没有添加新付费分割/审核模型、COS、webhook、向量库。

## 6. 验证记录

自动化执行：`npm test` 38项全部通过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。

覆盖：分析唯一模型和三图输入；空/非法 JSON、证据越界、重复实例；拒绝生成参数；未确认分析/无实例/无mask/无费用确认；UUID 幂等与冲突；修订hash失效；原图回传/错比例；丢响应/429和创建未知对账；后端重启只GET；取消未知与超时确认；批量停止和部分结果保存；所有权/资产/原凭据；功能开关；双mask/保护区逐像素测试；EXIF；过期清理；PostgreSQL唯一键、CAS与重读；恢复kind/owner/hash/request/id隔离；原普通修图API实际假客户端回归；原生fetch创建次数和远端截止头。

PostgreSQL 测试使用 pg-mem，不能代替真实 PostgreSQL/容器恢复演练。测试不使用线上数据库或真实预测。未在本次运行 Docker 镜像或云端安装测试。

浏览器本地假供应商验收：上传合成场景+2张参考，空target、无选区点分析，仅1条 fake o4-mini，文字和2个未选中实例回填；确认后分别画2个编辑多边形及2个裤脚保护区，点击生成只新增1条 fake Nano Banana2，候选先待审，四项核验后才合格。刷新后两个既有任务和素材/范围恢复，模型事件仍只有2条。修复了验收中发现的 legacy 私有图片预览问题，并加入账号模式防越权回归。

私有证据：`.local/migration-archive/replication-v2-all-tests.txt`、`replication-v2-browser-qa/model-events.json`、`replication-v2-browser-qa/模拟验收-双目标合成.png`。其中图片为测试几何示意，**不是实际模型生成的鞋类效果**。

## 7. 未解决风险与后续授权边界

1. 历史故障点击无法归因，实际计费未核验；已通过新请求/任务/预测日志建立后续追踪条件。
2. 提示词 JSON 并非供应商强制 schema，真实 o4-mini 结构化稳定性和 Nano Banana2 产品身份保真尚未验证。失败不会自动收费重试。
3. 当前自动质量只判断图片有效性、比例、逐实例变化、非目标候选差异及合成保护；无法自动证明鞋型、Logo、实例语义数量正确。必须人工核验，不能宣传自动识别替换必然成功。
4. 没有收费分割模型或ROI多次预测；多边形仍需要用户准确绘制。新轮廓和接触阴影超出范围会被裁掉，保护区画大也会保留旧像素。
5. 大图片规范化和像素合成会占用内存；尚未做真实服务器负载/容量测试。Data URL和私有本地文件沿用，COS以后单独评估。
6. 未启用每账户安全 webhook，也不自动从相近时间猜历史预测。未知创建只有精确证据匹配才可手动关联；供应商删除 input 后可能无法验证，应保持未知并由维护者对账，不盲目解锁重发。
7. **真实鞋图分析、首次真实生成、测试环境迁移演练以及生产部署均需用户另行授权。** 本次停在可审查的代码与无付费验证结果，不声称已上线或真实效果通过。
