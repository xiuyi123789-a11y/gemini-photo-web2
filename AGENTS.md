# 本项目工作约定

- 唯一正式工作目录为本文件所在项目根目录：E:\桌面\量子跃迁ai修图工作室。
- 所有修改先写入本目录的实体文件，验证后再提交并同步 GitHub。不要先通过远程 API 修改 GitHub 后回填本地。
- 不在 C 盘或其他目录另建本项目工作副本。源码、文档、部署配置、测试及本地数据均放在项目内。
- 源码包放 .local/releases，归档和工具放 .local/migration-archive，npm 缓存放 .local/npm-cache。
- .local、node_modules、dist、data、备份和真实环境凭据不提交 GitHub，不打入 Docker 镜像。
- 使用 npm run export:source 生成源码包，不包含密钥和用户数据。
- 删除本地目录不会删除腾讯云资源或停止云端计费；云端实例、数据库卷和备份需另行管理。
