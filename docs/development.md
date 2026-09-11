# 本地开发与验证

## 环境

Node.js 24.20.0 / npm 11.19.0，版本见 `.node-version` 和根 package.json。使用根目录的单一 package-lock.json。

`.agents/`、`skills-lock.json` 和 `.claude/skills/` 均为本机技能及安装器状态，保留本地并由根 `.gitignore` 忽略，不随业务仓库提交。其他机器按需自行安装技能；项目协作要求以仓库 AGENTS.md 和正式文档为准。

```powershell
npm ci
npm run dev
```

## 本地 PostgreSQL / Redis

`compose.yaml` 只提供本地 PostgreSQL 和 Redis；用户站、管理站与 API 仍直接在主机运行。Compose 项目固定为 `zzsh-rebuild-local`，使用独立网络和命名卷，不复用其他项目资源。

| 服务 | 镜像标签 | 宿主机端口 | Compose 资源 |
|---|---|---|---|
| PostgreSQL | `postgres:16-alpine` | `127.0.0.1:55432` → `5432` | `zzsh-rebuild-local-postgres-data` |
| Redis | `redis:7-alpine` | `127.0.0.1:56379` → `6379` | `zzsh-rebuild-local-redis-data` |

首次使用先复制 `apps/api/.env.example` 为被忽略的 `apps/api/.env`，并在被忽略的 `apps/api/.secrets/` 下创建 `postgres_password` 与 `redis_password` 两个单值文件。模板只包含占位配置，不要把凭据写回仓库。

```powershell
docker compose --env-file apps/api/.env -p zzsh-rebuild-local config --quiet
docker compose --env-file apps/api/.env -p zzsh-rebuild-local up -d --wait
docker compose --env-file apps/api/.env -p zzsh-rebuild-local ps
docker compose --env-file apps/api/.env -p zzsh-rebuild-local stop
docker compose --env-file apps/api/.env -p zzsh-rebuild-local start --wait
```

端口只绑定 loopback；停止或重启使用 `stop`/`start` 保留命名卷。PostgreSQL 的主机 TCP 连接使用密码认证，Redis 要求密码；容器内 socket 与主机映射 TCP 是不同验收路径。该 Compose 配置仅供本地隔离验证，不提供生产凭据或生产连接配置。

PostgreSQL 主机 TCP 使用 SCRAM，Redis 使用密码认证；容器内 socket 仍是独立路径，不能用 socket 成功替代主机 TCP 验证。认证切换在现有 PostgreSQL 数据卷上原地完成，不通过删除卷或重跑初始化变量绕过；认证配置完成前不导入敏感数据、不用于非本地环境。

| 应用 | 本地入口 | 独立启动 |
|---|---|---|
| 用户站 Next.js | http://127.0.0.1:3100 | npm run dev -w @zzsh/web |
| 管理站 React/Vite | http://127.0.0.1:3101 | npm run dev -w @zzsh/admin |
| NestJS API liveness | http://127.0.0.1:3102/api/health | npm run dev -w @zzsh/api |
| NestJS API readiness | http://127.0.0.1:3102/api/ready | npm run dev -w @zzsh/api |
| OpenAPI 文档 | http://127.0.0.1:3102/docs | 随 API 启动，仅非 production 环境 |

API 启动前校验 `APP_PROFILE`、数据库/Redis 目标和 provider 模式；缺失 `.env`、凭据文件或越界目标会在连接前失败。默认 provider 为 fake，`test`/`migration` 禁止 real；`provider-test` 必须提供显式范围，但范围配置不等于 Owner 的真实渠道授权。默认绑定本机。PORT 被占用时应处理自己的进程或修改配置，不结束身份不明进程。非资金测试执行器默认关闭，只有显式 `ENABLE_TEST_OPERATIONS=true` 且同时为 `APP_PROFILE=test`、`PROVIDER_MODE=fake` 时才会把能力传入核心；请求体不能覆盖该能力。

凭据来源有明确优先级：设置 `DB_PASSWORD_FILE`/`REDIS_PASSWORD_FILE` 时，文件路径优先于对应环境变量；路径必须位于 `.secrets/` 内，文件内容会去除首尾空白且不能全空白，路径缺失、文件不可读或内容为空都会失败，不能回退到环境变量。未设置 file 变量时才读取环境变量，同样拒绝全空白并去除首尾空白。不要把两类凭据写进仓库。`ecs-test` profile 保留用于未来测试 ECS，但当前没有已确认并登记的真实目标，启动始终失败关闭；示例域名、确认标记或本地环境变量不能绕过这一限制。待提供真实目标后，须另行设计和审核接入，不自动创建云资源或目标注册服务。

## 检查与迁移

```powershell
npm run check:offline
npm run check
npm run test:auth -w @zzsh/api
npm run migrate:business -w @zzsh/api
```

check:offline 包括类型检查、API 单元测试、三端构建和 smoke；check 还包含本地真实数据库测试。test:auth 使用有标记的隔离库及专用角色，不使用开发业务库；缺失配置应失败，不静默跳过。管理员个人工作台布局测试使用独立库 `zzsh_test_m2_workspace_layout` 与锁 `805014`，不占用 M2 auth 套件的 `805002`。迁移身份与运行身份分离，runtime 无 DDL/角色继承和审计修改权限。管理员目录与操作权限依赖 business migration `0008_m2_admin_permissions`；未应用时管理会话快照会查询失败。具体环境变量见 apps/api/.env.example，禁止将本地秘密提交。

test:readiness 会受控停止/恢复本项目依赖，不属于日常前端检查。禁止影响其它 Compose 项目。灾备命令 security:disaster-recovery 仅为 test/fake 验证入口，维护身份、线下确认及预登记通知必须配置，生产启用仍未验收。

API 请求日志只记录方法、路由模板、状态、requestId和耗时，不记录请求体、Cookie、密码、OTP及密钥。认证细节见 [认证说明](architecture/authentication.md)。

Admin 免账号 mock 预览已移除。真实初始化使用独立测试账号，不重置他人正在使用的账号。tmp/ 保存本地过程资料，.impeccable/ 保存工具状态，二者不进入 Git。
