# 图像复刻 V2 腾讯云发布与验证

本次用户已授权生产部署和验证。付费图片分析、生成不包含在本脚本的验证中；脚本不创建或取消供应商预测。

## 发布目标

- 服务器目录：`/home/ubuntu/quantumleap-studio`
- 部署分支：`chore/tencent-cloud-migration`
- 公网：`https://studio.xiuyi-ai.cn`
- 页面版本：v1.4.0，分析和生图独立，生成前需要确认分析和绘制目标范围。
- 数据库：PostgreSQL 17，启动时增量创建 replication_jobs、replication_predictions 与防重复约束，保留已有账号与数据。

## 执行

使用交付消息中完整的 40 位部署提交，先 fetch，再用 `git show <提交>:deploy/update.sh` 提取对应脚本运行。不要使用旧版脚本，不要 reset、stash、删除卷或手动修改生产 .env.tencent。

脚本核对当前分支、未提交源文件、目标提交和磁盘空间；锁定并保存旧镜像、配置、数据库及整个图片卷的备份，验证备份后更新源码和构建。备份时 app 短暂停止；构建期间旧 app 恢复服务。新镜像启动或验收失败时尝试恢复保存的旧镜像，不自动恢复数据库或删除新增表。

## 自动验收

新容器健康后执行：

```bash
sudo docker compose --env-file .env.tencent exec -T --interactive=false app \
  node server/deployment-check.js https://studio.xiuyi-ai.cn
```

`server/deployment-check.js` 检查：

1. sharp 原生库可用；两个模型固定为 openai/o4-mini、google/nano-banana-2。
2. 原有四表、新增两表及部分唯一索引存在。事务内插入随机测试账号、任务与本地预测记录，验证任务重读、revision 更新、请求唯一性、单用户未结任务唯一性与 attempt 防重复，然后全部 ROLLBACK。测试记录不对后台 worker 可见，不调用模型，不留下测试账号。
3. 容器内和公网健康检查、账号模式，以及 capabilities、任务、素材、分析、生图和连通性接口的匿名 401 保护；伪造 x-user-id 也不能绕过。
4. 构建产物含 V2 交互文案；公网 index.html 指向相同脚本，公开脚本 SHA-256 与容器产物一致。
5. 如果服务器配有 Replicate Token，仅 GET 查询两个模型元数据；若为空，只确认无凭据网络可达，并明确输出 BYOK 未验证。不会输出 Token。

完整成功标记：

```text
POSTGRES_SCHEMA_STORE_IDEMPOTENCY_AND_ROLLBACK_OK
DEPLOYMENT_V2_NONBILLABLE_CHECK_OK
DEPLOYMENT_OK <完整提交> https://studio.xiuyi-ai.cn
```

无完整成功标记不能判定发布完成。网络或模型元数据检查也不代表真实鞋图效果通过。上线后浏览器需强制刷新，避免旧页面配新接口。

## 手动回滚

失败时先查看脚本输出是否已自动恢复旧镜像，并查看 app 健康状态。若需手动回滚，将下方 `<备份目录>` 替换为该次脚本实际打印的路径：

```bash
cd /home/ubuntu/quantumleap-studio &&
sudo docker compose --env-file .env.tencent -f compose.yaml \
  -f <备份目录>/rollback.compose.yaml up -d --no-deps --no-build app &&
sudo docker compose --env-file .env.tencent ps
```

保留全部新增表、预测记录和资产。镜像回滚不会取消供应商已创建的任务；有 V2 未结预测时需要继续核对，不能盲目重试。

## 本地验证与云端状态

发布准备阶段：38 项假供应商测试、类型检查、Vite 构建与 Bash 语法检查通过；部署脚本 12 项成功/故障场景及 2 项备份场景通过。云端状态以实际执行输出与公网复核为准。
