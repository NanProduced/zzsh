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

API 启动前校验 `APP_PROFILE`、数据库/Redis 目标和 provider 模式；缺失 `.env`、凭据文件或越界目标会在连接前失败。默认 provider 为 fake，`test`/`migration` 禁止 real；`provider-test` 必须提供显式范围，但范围配置不等于 Owner 的真实渠道授权。默认绑定本机。PORT 被占用时应处理自己的进程或修改配置，不结束身份不明进程。

凭据来源有明确优先级：设置 `DB_PASSWORD_FILE`/`REDIS_PASSWORD_FILE` 时，文件路径优先于对应环境变量；路径必须位于 `.secrets/` 内，文件内容会去除首尾空白且不能全空白，路径缺失、文件不可读或内容为空都会失败，不能回退到环境变量。未设置 file 变量时才读取环境变量，同样拒绝全空白并去除首尾空白。不要把两类凭据写进仓库。`ecs-test` profile 保留用于未来测试 ECS，但当前没有已确认并登记的真实目标，启动始终失败关闭；示例域名、确认标记或本地环境变量不能绕过这一限制。待 IN-06 提供目标后，须另行设计和审核接入，不在本卡创建云资源或目标注册服务。

## 请求日志

API 默认将每个请求结束事件输出为一行 JSON；测试可注入内存 sink。事件采用字段白名单：
`event`、`requestId`、`method`、匹配到的路由模板 `route`、HTTP `status`、整数
`durationMs`、`outcome` 和 `completion`。正常 `finish` 记录
`completion=completed`；客户端提前断开时只记录一次 `completion=aborted`、
`outcome=aborted`、`status=null`，不伪造客户端收到的状态。未匹配路由固定为
`<unmatched>`，不从原始 URL、query 或 path 参数拼接日志。一个请求只在
`finish`/`close` 的首个事件记录一次；异常响应与 requestId filter 使用同一请求上下文中的 ID。

日志不包含请求/响应 body、query、Cookie、Authorization、手机号、实名、卡号、密码、
OTP、provider 原始响应或堆栈。扩展日志必须增加显式字段和专用方法，不能把任意对象或
自由文本交给公共日志入口。调用方提供的 requestId 只是关联标识，不代表身份或授权；
缺失、越界或恶意值会生成新的安全 ID。当前测试覆盖成功、400/401/403/404/429/500、
并发关联、提前断连、失败 sink 隔离和敏感值负向。sink 失败只发出不含原始异常的固定
告警，不重试或递归调用 sink，不能改变业务响应或后续请求处理；未覆盖生产日志采集、
集中存储、告警、保留周期及脱敏后的运营展示。

## 数据库迁移与测试 reset

Drizzle 正式迁移入口位于 `apps/api/migrations/`，当前只建立
`zzsh_meta.database_marker` 这一项测试目标元数据，不创建业务表。FND-004 的
测试目标固定为 `APP_PROFILE=test`、`PROVIDER_MODE=fake`、
`DB_TARGET=local-compose`、`DB_NAME=zzsh_test_fnd004`，并由现有 `loadConfig`
校验 loopback 地址 `127.0.0.1:55432`、角色 `zzsh` 和本地凭据。

离线 `npm test -w @zzsh/api` 与根 `npm run check:offline` 不加载本机 `.env`，不连接
真实数据库；`npm run check` 会在离线检查后显式运行同一数据库验证入口，因此需要
已核验的本地测试库。单独运行真实数据库验证时使用：

```powershell
npm run test:db -w @zzsh/api
```

该命令在已核验的 `zzsh` 实例中确认维护库身份、测试库 owner、marker 表 owner
和 marker 内容后，才允许在 `fnd004_probe` schema 内执行事务性 drop/create reset。
reset 不删除数据库、卷或其他 schema；缺配置、错误库名/地址/身份、marker 不符
或 schema owner 不符均在 DDL 前失败，保留哨兵数据。`zzsh_meta` 元数据及测试
schema 均由角色 `zzsh` 持有；维护库连接仅用于核验或创建独立测试库。

FND-004 的迁移失败回滚、错误目标保护和 reset 结果仅代表本地 Compose 测试库，
不代表生产迁移、备份恢复、故障切换或生产数据库接入。CI 仅使用隔离服务和测试占位凭据。

`npm run dev` 同时启动三端。API 先编译，再由 TypeScript watch 与 Node watch 更新；Ctrl+C 停止启动的进程组。启动脚本不会连接旧数据库或第三方服务。

## 检查

```powershell
npm run typecheck
npm test
npm run build
npm run test:smoke
# 仅运行不需要数据库的检查
npm run check:offline
# 顺序执行离线检查及显式 PostgreSQL 验证
npm run check
```

默认 `npm test -w @zzsh/api`、`npm run check:offline` 和 smoke 不连接数据库或 Redis。
smoke 在临时本地端口启动三份构建产物，API 子进程显式使用 `test` + `fake` 和合成凭据，
不读取 `.env` 或 `.secrets/`，也不绕过启动校验；检查用户站 HTML、管理站资源、API liveness
以及 production 下文档不可访问，结束后关闭自己启动的子进程。`npm run check` 追加
`npm run test:db -w @zzsh/api`，缺少数据库配置或连接被拒绝时必须非零退出。fake readiness
只允许显式 test profile，不能用于生产默认启动。

真实本地依赖探针必须显式运行，并且只接受已核验的 `zzsh-rebuild-local` Compose 资源：

```powershell
npm run test:readiness -w @zzsh/api
```

该命令读取被忽略的 `.env`/`.secrets/`，连接前核验 Compose project/service/image/loopback 端口，只停止和启动 zzsh 自己的 Redis、PostgreSQL，验证 `/api/ready` 的 200→503→200 以及 `/api/health` 始终 200，最后恢复原运行状态。缺配置、目标身份或服务状态不符时失败，不静默跳过；不操作 Claread。该探针保持显式独立入口，不属于普通 `check` 或 CI。

`/api/health` 只表示进程 liveness；`/api/ready` 在有限超时内执行 PostgreSQL `SELECT 1` 和 Redis `PING`，任一依赖失败返回 503 且不返回连接/认证错误。依赖恢复后下一次 readiness 检查可恢复 200。Nest shutdown 开始时先标记 stopping、拒绝新工作，有限等待在途 HTTP 请求；到达 drain deadline 时销毁仍在途的真实 response，再有界关闭 PostgreSQL/Redis，关闭操作幂等，不用 `process.exit` 掩盖连接泄漏。当前连接是 readiness 专用的 PostgreSQL `max=1` pool 和 Redis client，不是未来业务连接池；业务事务排空仍未实现。Windows 下 SIGTERM 的子进程语义由显式 readiness 探针实测到“子进程退出”，不等同于已证明资金事务排空。

GitHub Actions 使用独立的 PostgreSQL/Redis 服务、测试专用占位凭据并运行 `npm run check`；
Redis 在检查前切换到占位密码认证，healthcheck 严格匹配 `PONG`，配置步骤严格匹配
`CONFIG SET=OK` 与认证 `PING=PONG`，不读取真实 secrets。`test:readiness` 不进入 CI。本地本轮
未执行远端 GitHub Actions，不能据此声明远端通过。

## 当前范围

后续业务开发遵循[多端与 BFF 约束](architecture/multi-client-bff.md)。当前没有业务 BFF；三端框架可独立启动不代表多端身份、聚合、平台支付或兼容层已经实现。

- Next.js App Router 用户站；React/Vite 管理站；两端使用 Tailwind CSS 4 和 @zzsh/ui 共享样式。
- 开发入口为占位内容，不是最终品牌设计，无虚构账号、成交数字或可执行管理操作。
- shadcn 组件在实际表单/按钮需求出现时引入；本轮没有为展示占位页安装整套组件。
- API 的 `/api/health` 表示进程存活，`/api/ready` 才检查本地 PostgreSQL/Redis 就绪；生产关闭 OpenAPI 文档。
- 当前仅有 Drizzle/pg 数据访问与 FND-004 测试元数据迁移；没有业务表、用户认证、交易模块、worker、Directus、Sentry/PostHog 或真实外部服务。
- 所有业务写接口实施前须补服务端认证授权、输入校验、金额与幂等规则；当前没有写接口。
- 未部署云端、未迁移数据、未构建应用容器；本地 PostgreSQL/Redis 由 Compose 提供。生产版本升级、网络与渠道验收另行安排。
