# 洲洲商行

游戏账号业务平台重建项目：NestJS API、React/Vite 管理站和 Next.js 用户站，使用 npm workspaces。生产数据库目标为托管 PostgreSQL，本地使用独立 PostgreSQL/Redis Compose 环境。

```sh
npm ci
npm run dev
npm run check
```

先按 [开发说明](docs/development.md) 配置本地依赖与秘密。Node 版本见 .node-version。

- [文档导航](docs/README.md)
- [认证与账号安全](docs/architecture/authentication.md)
- [协作规范](AGENTS.md)

当前认证与初始化已有实现，交易、权限与生产部署仍在建设中。不要把本地验收视为生产上线结论。生产配置、数据库快照、个人数据与过程资料不得加入 Git。
