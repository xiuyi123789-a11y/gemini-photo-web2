# 量子跃迁 AI 修图工作室

React + Express 的 AI 图片分析、生成、修图与灵感知识库应用。当前通过 Replicate 调用模型，不直接使用 Gemini API。

## 腾讯云部署

详见 [腾讯云部署指南](docs/TENCENT_DEPLOYMENT.md) 和 [本地与 GitHub 比对记录](docs/MIGRATION_AUDIT.md)。

浏览器 → Caddy HTTPS → Express → Replicate；PostgreSQL 保存用户、会话、知识库、错误笔记及复刻任务/预测记录，独立持久卷保存图片。

- Node.js 24、Docker Compose、PostgreSQL 17。
- 生产环境必须启用数据库和账号；管理员通过服务器命令开通账号，不开放注册。
- 密码使用 scrypt 加盐哈希；7 天登录会话通过 HttpOnly、Secure、SameSite=Strict Cookie 传递，数据库仅保存会话摘要。
- 服务端从会话确定身份，客户端 x-user-id 在账号模式下不作为身份依据。
- 模型 Token 仅存在当前标签页的 sessionStorage，也可由管理员配置服务端共享 Token。
- 知识库、图片、错误笔记按账号隔离；聊天草稿仍在当前浏览器，按账号区分，不跨设备同步。

## 本地开发

### 图像复刻

左侧“图像复刻”采用 V2 独立流程：上传 1 张原图与最多 6 张同一新产品的参考 → 仅文字分析 → 确认分析 → 选择目标与多边形编辑/前景保护范围 → 显式生成 → 人工审核。分析模型为 [openai/o4-mini](https://replicate.com/openai/o4-mini/api)，生成模型为 [google/nano-banana-2](https://replicate.com/google/nano-banana-2/api)。普通修图旧模型不变。完整契约、测试与回滚见 [V2 修复交付记录](docs/IMAGE_REPLICATION_REPAIR_V2.md)。

- 上传格式 JPG / PNG / WEBP，单张最大 20 MB、3200 万像素，原图和参考图合计最大 32 MB。
- 分析不要求目标文字或选区，返回带参考证据索引的 JSON 与可编辑摘要。没有确认过的分析，生成 API 返回 409，绝不自动分析后生图。
- 多个同类实例分别列出，默认不选择；每个所选对象分别绘制多边形，另绘制裤脚、袜子等前景保护区。范围外及保护区回填原图像素；不强行拉伸比例错误的模型结果。
- 原图、模型原始输出与合成候选分别保存。原样回传判不合格，其他有效候选也先待人工审核，不将供应商 succeeded 等同产品替换成功。
- 默认 1 张、1K/2K 模型档位，最终合成保持原图像素尺寸。2/4 张及4K默认关闭，须维护者验证后开放；用户需确认预测数量，失败/取消仍可能计费。
- 复用顶部 Replicate API Key 或服务端 Token。检查连接只读取模型信息，不创建收费预测；分析和生成会产生实际模型调用。
- 复刻绕开 SDK 创建重试，单次 POST 后只查已有预测；创建不明、取消不明分别保留状态，阻止自动额外收费。应用 requestId 不代表供应商保证恰好一次。
- 任务和预测记录在 PostgreSQL 持久化，开发兼容模式使用原子文件；分析/生成恢复槽分开并核对账号、kind、请求和素材摘要。服务重启后使用原凭据通过 GET 继续核对已有预测，不重新创建。
- 规范化素材与原始/合成候选保存于账号私有目录，默认30天保留，未核实的远端任务不自动清理。浏览器不保存图片字节；恢复后仍可对比，重新分析恢复素材须重新上传。
- 相关接口位于 /api/replication，生产环境仍要求登录；前端不得传入图片远程 URL，避免任意地址被当作素材使用。

### 启动与验证

需要 Node.js 24：

```sh
npm ci
npm run dev
```

未配置数据库时，仅非生产环境使用原文件存储模式。需要本地验证账号时，在 .env 配置 DATABASE_URL，或 PGHOST、PGPORT、PGUSER、PGPASSWORD、PGDATABASE。开发 Cookie 不要求 HTTPS。Vite 5173 代理 /api 到 Express 3001。

可选 REPLICATE_API_TOKEN 供后端使用，不要使用 VITE_ 前缀或提交真实凭据。用户 Token 优先；用户提供无效 Token 时，不自动切换到共享额度。

```sh
npm test
npm run typecheck
npm run build
```

生产还需要 PUBLIC_ORIGIN=https://你的域名，Compose 自动设置。DATA_DIR 可覆盖图片存储位置。构建不再自动修改日志；更新版本信息时单独执行 npm run changelog。

本次迁移基线为 6371972112ed8ff6352e9c1591eb382bb2b1c1b2，本地与远端 37 个跟踪文件一致。按用户要求全新部署，不导入旧图片或知识库。旧 Zeabur 部署配置已移除。

## 本地文件统一存放

本项目唯一工作目录是 `E:\桌面\量子跃迁ai修图工作室`。所有修改先落盘、完成验证，再同步 GitHub。源码在项目根目录，说明在 `docs/`，部署配置在 `deploy/`。

- `.local/releases/`：部署源码包；运行 `npm run export:source` 重新生成。
- `.local/migration-archive/`：之前 C 盘工作副本和工具的历史归档，不再用于开发；其中旧脚本的 C 盘路径已过时，不要执行。
- `.local/npm-cache/`：项目专用 npm 下载缓存，由根目录 `.npmrc` 指定。
- `node_modules/`、`dist/`、`data/`：依赖、构建产物和本地用户数据。

`.local` 不提交 Git、不进入 Docker 构建，源码包也排除真实凭据和用户数据。删除这个项目目录即可清理以上本地项目文件；腾讯云实例、数据库卷和异地备份是独立云资源，需要单独处理。

## 网页终端中创建账号

如果 OrcaTerm 中直接执行 Node 交互输入时反复提示密码长度错误，可在服务器项目根目录运行：

```sh
bash deploy/create-user.sh xiuyi
```

辅助脚本使用 Bash 隐藏输入，只显示收到的字符数，长度合格且两次一致后，通过 stdin 管道交给容器。密码不出现在命令参数、导出的环境变量或文件中。请逐次粘贴单行密码并回车；不要使用真实密码测试普通 Shell 命令行。该脚本需要运行中、包含最新 server/create-user.js 的 app 镜像。
