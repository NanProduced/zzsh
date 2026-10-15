# Serena 子项目注册与激活

对 ZZSH 主检出只注册以下三个子项目；禁止注册/激活仓库根 `E:/zzsh/zzsh`、父目录 `E:/zzsh`，以及 `D:/CodexWorktrees`、`E:/zzsh/worktrees` 等 worktree 容器。Serena 全局 registry 中的其他仓库项目不属于本规则，不因本项目清理而删除。

| 名称 | 相对仓库路径 | 职责 |
|---|---|---|
| zzsh-admin | apps/admin | 管理平台前端（React/Vite） |
| zzsh-api | apps/api | 统一业务后端（NestJS），可包含管理端 BFF 适配模块 |
| zzsh-web | apps/web | 用户平台前端及 Next.js 服务端 Web BFF |

每台机器通过 Serena 官方 CLI 在对应子项目创建本地 `.serena/project.yml`，再通过 activate_project 注册。Serena 1.7+ 使用 `language_servers` 字段；三端使用 TypeScript、UTF-8、当前子项目根 `ls_workspace_folders: ["."]`，并显式配置 `ignored_paths` 排除构建产物、依赖和本地敏感数据。`.serena` 整体由根 `.gitignore` 忽略，不随 Git 分发；如果需要固定 LF，应在 `project.yml` 显式设置 `line_ending: lf`，否则遵循本机/仓库约定。

## 使用方式

每次会话先调用 initial_instructions。按任务选择：

```text
activate_project(project="zzsh-admin")
activate_project(project="zzsh-api")
activate_project(project="zzsh-web")
```

上面是三个备选调用，不是每次工作都需要全部依次执行。新克隆尚未注册时，使用该机器上对应子目录的绝对路径激活；配置中的唯一名称会用于之后按名称切换。MCP 启动优先传入对应子项目的 `--project`；只有从该子项目目录启动时才使用 `--project-from-cwd`，不要从 monorepo 根目录或 worktree 容器启动。

切换后使用 get_current_config 确认项目名称、根路径和语言服务器状态，符号工具路径从子项目根算起，例如 API 的 `src/health/health.controller.ts`，不是 `apps/api/src/...`。同一个 Serena 实例的激活状态会改变；并行任务不要抢占同一会话，跨项目查询必须顺序执行。

跨包引用需要普通搜索与调用方检查补充。packages/ui、根文档和配置不单独注册，也不通过扩大根目录处理。配置限制与 AGENTS.md 是范围规则，不声称构成操作系统级安全沙箱。

## 配置验证

配置变更后，分别对实际子项目路径执行 `serena project health-check <子项目路径>`，再在 MCP 中核对激活项目和实际源码符号读取。注册、onboarding、语言服务器健康和业务验收是不同结果；本机验证记录保存在忽略的过程目录。

项目配置、initial_prompt、缓存、日志和 memories 全部保留本机并忽略；ignored_paths 不构成安全沙箱。协作约束维护在根 `AGENTS.md` 和本文。现有其他仓库项目注册不修改；本项目配置或 Serena 版本变更后，重启已有 MCP 会话并报告 health-check 和实际 MCP 启动结果。
