# 腾讯云全新部署指南

## 1. 选型

建议起点：**Lighthouse 或 CVM，2 核 4 GB、60 GB 以上 SSD、Ubuntu 24.04 LTS、x86_64**。模型运行在 Replicate，不需要 GPU。适合几位成员，图片增长后扩容磁盘或接 COS。价格、流量和续费以购买页当日为准。

优先比较中国香港或新加坡实例，最终以到 Replicate 和镜像仓库的实测连通性决定，不保证某地域始终可用。有备案且偏重国内访问速度时也可评估内地实例。内地网站部署涉及备案，香港及境外地域无需 ICP 备案。参考：[Lighthouse](https://cloud.tencent.com/product/lighthouse)、[腾讯云备案说明](https://cloud.tencent.com/act/pro/mobile-beian)。

可选腾讯云 Docker CE 镜像，或按 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Engine 和 Compose 插件。以下命令假设管理员已有 Docker 执行权限。

防火墙/安全组：80、443/TCP 对外开放，可选 443/UDP；22/TCP 限管理员 IP。**不开放 3001、5173、5432**。数据库和 app 不映射到公网。

## 2. 域名和网络

准备 `studio.你的域名`，A 记录指向实例公网 IPv4；IPv6 不可达时不要配置 AAAA。Caddy 自动签发续期 HTTPS，需要域名解析正确且公网 80/443 可达。[Caddy HTTPS 说明](https://caddyserver.com/docs/quick-starts/https)

```sh
docker version
docker compose version
curl -I --connect-timeout 10 https://api.replicate.com
```

Replicate 未带凭据返回 401/404 等 HTTP 响应可用于确认 DNS/TLS/网络，不证明 Token 或模型可用；付费模型测试留到验收。

## 3. 全新部署

把迁移源码包上传并解压至 `/opt/quantumleap`。不要上传旧 `.env`、`.env.local`、`node_modules` 和 `data/`。

```sh
cd /opt/quantumleap
cp .env.tencent.example .env.tencent
chmod 600 .env.tencent
openssl rand -hex 32
```

用编辑器填写 `.env.tencent`：DOMAIN 为真实域名，不加协议或路径；POSTGRES_PASSWORD 替换为新生成随机值；REPLICATE_API_TOKEN 可留空，让每位成员在页面输入自己的 Token。若填共享 Token，所有登录用户均可使用该额度，尚无按用户配额。

密钥不要放进代码、截图或聊天。曾在 Zeabur 使用的 Token 应在供应商处更换：[Zeabur 公告](https://zeabur.com/blogs/zeabur-is-shutting-down)也披露了安全事件。

```sh
docker compose --env-file .env.tencent config --quiet
docker compose --env-file .env.tencent up -d --build
docker compose --env-file .env.tencent ps
docker compose --env-file .env.tencent logs --tail=100 app caddy
docker compose --env-file .env.tencent exec app node server/create-user.js owner
```

账号密码交互隐藏输入，不出现在命令参数或历史。用户名 3-40 位英文小写字母/数字/下划线/连字符，密码 12-256 字符。每位成员重复开通独立账号，不开放公开注册。首次启动自动创建数据库表和持久卷。

项目名固定为 quantumleap，后续更新不要改名；不要执行 `docker compose down -v`，该命令会删除数据和证书卷。数据库初始化后，只改环境文件不能修改数据库内已存在的密码。

## 4. 上线验收

1. HTTPS 主页面显示登录表单，`/api/health` 正常。
2. 错误密码无法登录；A 的知识库/图片不能由 B 读取，伪造 `x-user-id` 也无效。
3. 新 Token 小规模测试分析、生成和放大，检查费用、超时、结果保存与轮询。
4. 重启 app/db 后数据仍在；退出后数据 API 返回 401。
5. 不同账号的浏览器草稿分开保存。
6. 备份完成，并在隔离环境成功恢复。

本地 `npm test` 使用 PostgreSQL 内存兼容实现验证实际应用 HTTP 路由，不替代真实数据库、Docker、TLS 和公网验收。

## 5. 备份和恢复

```sh
bash deploy/backup.sh
```

脚本短暂停止 app，获得一致的 SQL/图片快照，期间页面可能返回 502；先等待付费模型任务完成。输出 `backups/时间戳/database.dump` 和 `images.tar.gz`，必须一起复制到独立安全存储。包含密码哈希和用户数据，不公开上传。建议至少每日备份并定期测试恢复。

恢复仅在新建或明确可覆盖的环境执行，使用可信备份。先正常启动 db/app，再执行：

```sh
docker compose --env-file .env.tencent stop app
docker compose --env-file .env.tencent exec -T db pg_restore -U quantumleap -d quantumleap --clean --if-exists --no-owner < backups/时间戳/database.dump
docker compose --env-file .env.tencent run --rm --no-deps -T --entrypoint tar app -C /app/data -xzf - < backups/时间戳/images.tar.gz
docker compose --env-file .env.tencent start app
```

会话也在 SQL 备份内，如需强制全部重新登录，可由管理员在数据库执行 `DELETE FROM sessions;`。不要解压不可信归档。

## 6. 更新和回滚

现有实例的实际工作目录为 /home/ubuntu/quantumleap-studio，当前使用 chore/tencent-cloud-migration 分支。不要把前文用于新建部署的 /opt/quantumleap 示例路径当作现有实例目录。

deploy/update.sh 用于更新已有实例，调用时必须给出经本地验证并推送的完整 Git 提交 SHA。它会核对当前分支、远端提交、工作区修改和磁盘空间，保留服务器自行修改的 deploy/Caddyfile，保存当前镜像为回滚标签，并短暂停止应用获得数据库与图片的一致性备份。

备份完成后先恢复旧应用，再拉取源码并构建新镜像，构建期间旧应用继续服务。新镜像先验证 Linux sharp 原生库，之后仅替换 app，核验容器健康、登录保护、新板块资源、公网 HTTPS 和 Replicate 出站网络。网络检查不验证用户 Token 或执行付费生成。替换后的检查失败时自动尝试恢复旧镜像；失败结果不会被报告为部署成功。部署锁阻止两个更新同时执行。

从已有源码目录运行（将 SHA 替换为实际发布的完整提交号）：

~~~bash
bash deploy/update.sh 完整40位提交SHA https://studio.xiuyi-ai.cn
~~~

若服务器尚未拉到此脚本，先 git fetch，将经审核提交里的 deploy/update.sh 用 git show 导出到 .local/deployments 下，再执行该文件；这样可以在变更生产源码前完成备份。真实环境文件、数据库备份和图片备份仅留在服务器 .local/deployments/时间戳，权限受限，不能提交 Git 或进入镜像。

脚本不会处理服务器密码。如果 Docker 权限要求认证，请由使用者在当前服务器终端运行 sudo docker info 并完成隐藏密码输入，再执行更新脚本。看到 DEPLOYMENT_OK 和对应提交号才说明脚本已完成发布检查；仍需在浏览器登录检查实际页面与用户提供 Token 的模型接口。

网页终端执行备份时必须关闭交互式标准输入，不能只使用 `-T`。更新脚本的数据库导出使用非交互的 `docker exec`，图片快照使用关闭 stdin、只读挂载数据卷的临时容器；每个备份步骤都有明确提示和超时上限。数据库备份最多 90 秒、图片备份最多 180 秒；失败或收到中断信号时尝试恢复旧应用。原应用在快照写完后立即恢复，归档校验与镜像构建期间继续提供服务。手动 `deploy/backup.sh` 同样关闭交互输入并增加超时。参阅 [Docker exec 的交互模式说明](https://docs.docker.com/reference/cli/docker/compose/exec/)。

备份使用的 `umask 077` 不用于源码拉取；Git 更新单独使用 `umask 022`，避免新增源码默认变成仅当前用户可读。Docker 镜像还会显式将运行目录中的 `package.json`、`package-lock.json` 设为 `0644`，兼容此前已经以 `0600` 拉取的文件。镜像构建在 `USER node` 后导入实际服务器模块并执行 sharp 图片处理，不能通过非 root 用户检查的镜像不会进入替换步骤。

更新前先备份，记录当前源码提交/源码包和镜像 ID；新源码 `up -d --build`，数据留在卷中。失败时使用之前保存的源码/镜像重建 app；未来涉及数据库结构变化时也需配套数据库恢复。本次是全新数据库，不导入旧站数据。

现阶段只运行一个 app 副本。知识库为每账号整份写入，任务状态在内存中；多人同账号同时编辑有后写覆盖风险。后续团队协作可再做逐条数据库操作、共享知识库、持久任务队列和 COS 存储。

## 网页终端密码输入排查

若账号创建提示密码长度不合，可改用 `bash deploy/create-user.sh 用户名`。该辅助脚本隐藏输入、报告字符数并允许重试，通过 stdin 交给容器；无需将密码写入命令、环境文件或聊天。默认 Node 交互命令也已增加字符数诊断。

更新服务器版本后重建 app，再运行辅助脚本：

```sh
git pull --ff-only
sudo docker compose --env-file .env.tencent up -d --build app
bash deploy/create-user.sh xiuyi
```

输入长度检测和 stdin 读取增加 4 项测试，总计 14 项测试通过。网页终端中的实际输入仍需由使用者在服务器验证；这些测试不证明此前失败的具体原因。

### 服务器 sudo 密码与工作室密码

辅助脚本先尝试当前用户访问 Docker，再以 `sudo -n docker info` 检查现有授权；不再单独执行 `sudo -v`。`-n` 不会绕过系统认证，需要密码时会退出并给出说明。若仍无权限，先在终端执行 `sudo docker info`；此时如提示输入密码，需要 Ubuntu 服务器账号密码，不是将要设置的工作室密码。成功验证后重新运行辅助脚本。不要将任何一种密码发到聊天中。
