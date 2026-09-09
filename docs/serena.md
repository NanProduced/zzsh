# Serena 子项目注册与激活

只注册以下三个子项目，禁止注册/激活仓库根 `E:/zzsh/zzsh` 或父目录 `E:/zzsh`。

| 名称 | 相对仓库路径 | 职责 |
|---|---|---|
| zzsh-admin | apps/admin | 管理平台前端（React/Vite） |
| zzsh-api | apps/api | 统一业务后端（NestJS），可包含管理端 BFF 适配模块 |
| zzsh-web | apps/web | 用户平台前端及 Next.js 服务端 Web BFF |

每台机器通过 Serena 官方 CLI 在对应子项目创建本地 `.serena/project.yml`，再通过 activate_project 注册。`.serena` 整体由根 `.gitignore` 忽略，不随 Git 分发；创建时选择 TypeScript（包含 TSX 支持）、UTF-8、LF，仅将各自目录作为索引根，不配置上级/兄弟 workspace。

## 使用方式

每次会话先调用 initial_instructions。按任务选择：

```text
activate_project(project="zzsh-admin")
activate_project(project="zzsh-api")
activate_project(project="zzsh-web")
```

上面是三个备选调用，不是每次工作都需要全部依次执行。新克隆尚未注册时，使用该机器上对应子目录的绝对路径激活；配置中的唯一名称会用于之后按名称切换。

切换后使用 get_current_config 确认项目，符号工具路径从子项目根算起，例如 API 的 `src/health/health.controller.ts`，不是 `apps/api/src/...`。同一个 Serena 实例的激活状态会改变；并行任务不要抢占同一会话，跨项目查询必须顺序执行。

跨包引用需要普通搜索与调用方检查补充。packages/ui、根文档和配置不单独注册，也不通过扩大根目录处理。配置限制与 AGENTS.md 是范围规则，不声称构成操作系统级安全沙箱。

## 验证记录

2026-09-08 已分别激活并成功读取：admin 的 App、API 的 HealthController/getHealth、web 的 Home。注册列表含三个唯一名称；没有创建根 `.serena/project.yml`。本轮未写 memories 或执行 onboarding。

项目配置、initial_prompt、缓存、日志和 memories 全部保留本机并忽略；协作约束维护在根 `AGENTS.md` 和本文。现有其他项目注册不修改；本轮不运行应用、不连接生产、不提交推送。
