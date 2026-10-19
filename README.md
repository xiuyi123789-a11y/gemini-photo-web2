# 量子跃迁 AI 修图工作室

React + Express 的 AI 图片分析、生成、修图与灵感知识库应用。当前通过 Replicate 调用模型，不直接使用 Gemini API。

## 腾讯云部署

详见 [腾讯云部署指南](docs/TENCENT_DEPLOYMENT.md) 和 [本地与 GitHub 比对记录](docs/MIGRATION_AUDIT.md)。

浏览器 → Caddy HTTPS → Express → Replicate；PostgreSQL 保存用户、会话、知识库及错误笔记，独立持久卷保存图片。

- Node.js 24、Docker Compose、PostgreSQL 17。
- 生产环境必须启用数据库和账号；管理员通过服务器命令开通账号，不开放注册。
- 密码使用 scrypt 加盐哈希；7 天登录会话通过 HttpOnly、Secure、SameSite=Strict Cookie 传递，数据库仅保存会话摘要。
- 服务端从会话确定身份，客户端 x-user-id 在账号模式下不作为身份依据。
- 模型 Token 仅存在当前标签页的 sessionStorage，也可由管理员配置服务端共享 Token。
- 知识库、图片、错误笔记按账号隔离；聊天草稿仍在当前浏览器，按账号区分，不跨设备同步。

## 本地开发

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
