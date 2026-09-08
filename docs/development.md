# 本地开发与验证

## 环境

Node.js 24.20.0 / npm 11.19.0，版本见 `.node-version` 和根 package.json。使用根目录的单一 package-lock.json。

项目 skills 的规范副本位于 `.agents/skills`，来源记录在 `skills-lock.json`；本机 `.claude/skills` 是安装器创建的 junction，保留本地并忽略，避免 Git 重复收录。其他机器按所用工具恢复对应映射，不修改规范副本。

```powershell
npm ci
npm run dev
```

| 应用 | 本地入口 | 独立启动 |
|---|---|---|
| 用户站 Next.js | http://127.0.0.1:3100 | npm run dev -w @zzsh/web |
| 管理站 React/Vite | http://127.0.0.1:3101 | npm run dev -w @zzsh/admin |
| NestJS API | http://127.0.0.1:3102/api/health | npm run dev -w @zzsh/api |
| OpenAPI 文档 | http://127.0.0.1:3102/docs | 随 API 启动，仅非 production 环境 |

API 默认无需 .env。需要调整时将 apps/api/.env.example 复制为同目录 .env；仅 HOST、PORT，没有数据库或渠道凭据。默认绑定本机。PORT 被占用时应处理自己的进程或修改配置，不结束身份不明进程。

`npm run dev` 同时启动三端。API 先编译，再由 TypeScript watch 与 Node watch 更新；Ctrl+C 停止启动的进程组。启动脚本不会连接旧数据库或第三方服务。

## 检查

```powershell
npm run typecheck
npm test
npm run build
npm run test:smoke
# 顺序执行全部检查
npm run check
```

smoke 在临时本地端口启动三份构建产物，检查用户站 HTML、管理站资源、API 健康返回以及 production 下文档不可访问，结束后关闭自己启动的子进程。它不是管理站完整浏览器交互验收，也不证明 SIGTERM 在途事务排空或生产可用性。

GitHub Actions 已配置同一检查命令；远端运行要等后续推送，本轮不声明 CI 已在 GitHub 通过。

## 当前范围

后续业务开发遵循[多端与 BFF 约束](architecture/multi-client-bff.md)。当前没有业务 BFF；三端框架可独立启动不代表多端身份、聚合、平台支付或兼容层已经实现。

- Next.js App Router 用户站；React/Vite 管理站；两端使用 Tailwind CSS 4 和 @zzsh/ui 共享样式。
- 开发入口为占位内容，不是最终品牌设计，无虚构账号、成交数字或可执行管理操作。
- shadcn 组件在实际表单/按钮需求出现时引入；本轮没有为展示占位页安装整套组件。
- API 仅有 /api/health，表示进程存活，不代表数据库或第三方就绪；生产关闭 OpenAPI 文档。
- 没有数据库驱动/ORM、用户认证、交易模块、worker、Directus、Sentry/PostHog 或真实外部服务。
- 所有业务写接口实施前须补服务端认证授权、输入校验、金额与幂等规则；当前没有写接口。
- 未部署云端、未迁移数据、未构建容器。生产版本升级、网络与渠道验收另行安排。
