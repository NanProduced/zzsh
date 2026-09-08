# Monorepo 管理方式

采用 npm workspaces。用户站、管理站与 API 共用仓库，各自具有独立的 package.json、构建和部署边界；monorepo 不等于同进程部署。

当前目录：

```text
apps/web       Next.js 用户站框架
apps/admin     React/Vite 管理站框架
apps/api       NestJS 业务 API
packages/ui    两端共享样式；后续按实际需求增加组件
docs/          已确认决定、设计和操作说明
```

已建立可运行框架与锁文件。从根目录执行 `npm ci`，通过 `npm run <script> --workspace <name>` 定位应用；根目录 `npm run dev` 启动三端，`npm run check` 执行类型检查、API 测试、构建及产物 smoke。

前后台共享必要的接口契约和设计基础，不把数据库实体直接当成公开 API。业务规则不在多个应用中重复实现；后台 worker 若需要独立进程，优先复用 API 工程的业务模块。

多端/BFF 依赖边界见 [专门约定](multi-client-bff.md)。Web BFF 优先置于 Next.js 服务端，Admin BFF 可在 apps/api 内按模块组织，Vite 本身不提供生产服务端 BFF。后续 App/小程序按真实适配需求扩展，不预先创建空工程，也不要求每个 BFF 独立部署。

暂不增加 Turborepo/Nx、微服务、多仓库、CI 部署凭据或无业务内容的脚手架。有真实构建性能或团队边界需求时再评估。
