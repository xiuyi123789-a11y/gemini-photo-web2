# 本地与 GitHub 比对 / 腾讯云迁移记录

检查日期：2026-10-19（北京时间）。

| 项目 | 检查结果 |
|---|---|
| 本地目录 | `E:\桌面\量子跃迁ai修图工作室` |
| origin | `git@github.com:xiuyi123789-a11y/gemini-photo-web2.git` |
| 本地 HEAD / GitHub main | 均为 `6371972112ed8ff6352e9c1591eb382bb2b1c1b2` |
| 提交时间 | 2026-01-05 19:10:46 +08:00 |
| 提交标题 | Revert models to google/nano-banana and restore API configurations |
| 受跟踪文件 | 37 个，Git 索引 blob SHA 与 GitHub 递归树逐项一致，工作区无修改 |
| 文档 | README、PRD、UPDATE_LOG 与远端相同，但 Gemini 等说明落后于实际代码 |

结论：两份代码没有新旧之分，以共同提交作为迁移基线。实际模型调用通过 Replicate，不能仅凭旧文档判断供应商。

本地另有 Git 忽略的 `.env`、`.env.local`、`data/`、依赖和编辑器文件，不在远端比对范围。只统计了 data 数量和容量，没有读取凭据值：116 个文件，共 52,017,870 字节。按用户要求，新部署不导入这些数据。

## 迁移内容

- 去除 Zeabur 专用配置，新增 Dockerfile、Compose、Caddy、环境模板和备份脚本。
- PostgreSQL 保存用户、会话摘要、知识库和错误笔记；独立持久卷保存用户图片。
- 管理员开通账号、登录、退出、7 天会话、失败限流及来源校验。生产环境缺少数据库配置会拒绝启动。
- 服务端从会话确定身份，检查图片和任务归属；不信任客户端 `x-user-id`。
- 修复放大轮询缺少用户标识和原有两个工具函数缺少导出的问题。
- 浏览器草稿按账号分开；模型 Token 使用 sessionStorage，退出时清除。
- 构建与更新日志生成分开，避免容器构建时修改版本记录。

## 范围与限制

适合几位成员、单个 app 实例。知识库仍整份数组保存，同账号多标签同时编辑可能后写覆盖先写；成员应使用独立账号。聊天草稿保存在各自浏览器，尚未跨设备同步。共享团队知识库、密码自助找回、按用户额度控制及多副本不在本次范围。放大任务状态在进程内，重启会丢失进行中任务。

用户尚未购买服务器，未执行购买、云端部署、域名切换或真实模型付费请求。本机 Docker 引擎未运行；容器、真实 PostgreSQL、HTTPS 与腾讯云到 Replicate 的链路需在目标实例验收。

## 本地验证结果

- `npm run build`：通过。
- `npm run typecheck`：通过。
- `npm test`：10/10 通过，覆盖未登录拦截、Cookie 属性、会话摘要、过期/撤销、来源校验、失败限流，以及知识库/图片/错误笔记/任务的账号隔离。
- `docker compose --env-file .env.tencent.example config --quiet`：配置解析通过，不依赖 Docker 引擎启动。
- 测试未访问真实 Replicate 或产生模型费用；数据库测试使用 pg-mem，真实 PostgreSQL 容器尚未验证。

参考：[基线提交](https://github.com/xiuyi123789-a11y/gemini-photo-web2/commit/6371972112ed8ff6352e9c1591eb382bb2b1c1b2)、[Zeabur 公告](https://zeabur.com/blogs/zeabur-is-shutting-down)。
