# 本地开发与验证

测试选型、证据等级、必要性与重跑范围遵守[测试、验证与验收脚本规范](testing.md)。优先覆盖本次核心业务风险，不默认新增执行器或运行全平台检查。

## 环境

启动、停止、重启和测试隔离先遵守[本地环境使用规则](local-environments.md)。主环境由Master或指定维护者管理；已有服务先检查并复用，不默认每个agent启动三端。

本地测试库按[PostgreSQL使用规范](local-postgresql.md)登记、复用及清理。新任务先查主检出tmp/postgresql-resources.md；已结束测试不按返修轮次保留成批随机数据库。

Node.js 24.20.0 / npm 11.19.0，版本见 `.node-version` 和根 package.json。使用根目录的单一 package-lock.json。

`.agents/`、`skills-lock.json` 和 `.claude/skills/` 均为本机技能及安装器状态，保留本地并由根 `.gitignore` 忽略，不随业务仓库提交。其他机器按需自行安装技能；项目协作要求以仓库 AGENTS.md 和正式文档为准。

```powershell
npm ci
# 以下仅供负责整套主环境的维护者；其他任务按需启动单个应用。
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

API 启动前校验 `APP_PROFILE`、数据库/Redis 目标和 provider 模式；缺失 `.env`、凭据文件或越界目标会在连接前失败。默认 provider 为 fake，`test`/`migration` 禁止 real；`provider-test` 必须提供显式范围，但范围配置不等于 Owner 的真实渠道授权。默认绑定本机。主环境端口被占用时核对归属，不自行换号；分支环境按登记分配端口，Vite须使用--strictPort，不结束身份不明进程。非资金测试执行器默认关闭，只有显式 `ENABLE_TEST_OPERATIONS=true` 且同时为 `APP_PROFILE=test`、`PROVIDER_MODE=fake` 时才会把能力传入核心；请求体不能覆盖该能力。

凭据来源有明确优先级：设置 `DB_PASSWORD_FILE`/`REDIS_PASSWORD_FILE` 时，文件路径优先于对应环境变量；路径必须位于 `.secrets/` 内，文件内容会去除首尾空白且不能全空白，路径缺失、文件不可读或内容为空都会失败，不能回退到环境变量。未设置 file 变量时才读取环境变量，同样拒绝全空白并去除首尾空白。不要把两类凭据写进仓库。`ecs-test` profile 保留用于未来测试 ECS，但当前没有已确认并登记的真实目标，启动始终失败关闭；示例域名、确认标记或本地环境变量不能绕过这一限制。待提供真实目标后，须另行设计和审核接入，不自动创建云资源或目标注册服务。

## 检查与迁移

M3-B 的 `0016_m3b_review_guards` 与 `0017_m3b_idempotency_realm` 是前向返修迁移，不改写已应用0015；0017按原操作/上传actor迁移旧幂等键，无法确定realm或发生键冲突时停止，需核对后处理，不丢弃原成功结果。先在隔离库验证，再由环境维护者迁移目标；历史媒体缺少已验证衍生图时保持公共读取拒绝，重新上传后再审核公开。媒体阶段新增 `0023_m3_media_item_binding`（billable_item.media_id 外键），同样只前向应用，不改写历史迁移。

auth 默认资源锁805002被占用时不得抢占。需要并行隔离时设置 `M2_AUTH_TEST_RESOURCE_SET=<小写标识>`（1–21位字母数字/下划线、字母开头），库、迁移/runtime角色及资源锁一起派生；不得同时覆盖为旧库/旧角色。该套件在标记、归属与独占锁核验后，将供给外键涉及表纳入明确的同次TRUNCATE清单，不使用CASCADE；未知资源拒绝修改。测试账号在隔离库内生成，首次及重复运行均需回归。

```powershell
npm run check:offline
npm run check
npm run test:auth -w @zzsh/api
npm run migrate:business -w @zzsh/api
```

check:offline 先检查离线环境及测试入口登记，再执行类型检查、显式API/Web/Admin测试、三端构建和会启动临时服务的smoke；fake readiness不代表真实依赖或业务通过。可单独运行 `node scripts/check-test-entries.mjs` 静态检查三端 test 目录中的 TypeScript/MJS 套件；它不加载被盘点套件，从实际 runner 和 import 图区分默认离线、check 追加的数据库范围、显式 opt-in、人工入口和 helper。孤儿或无法识别的源码/默认调用形状使检查失败；新命令形状须先扩展检查，不能把 UNKNOWN 当覆盖。

部分测试受环境变量控制进入PG，执行前核实际入口与继承环境。check增加test:db:compiled，但不自动覆盖所有专用资金/IM套件；例如order-reservation的深层验收依赖ORDER_TEST_RESOURCE_SET及具体资源分支，两个独立 IM PG 命令也不在默认离线入口中，未进入须列NOT_RUN。不要把根命令或CI绿灯当作全部交易验收。Web 独立 typecheck 保留，不依赖 Next 构建的实验类型检查开关替代它。

test:auth 使用有标记的隔离库及专用角色，不使用开发业务库；缺失配置应失败，不静默跳过。管理员个人工作台布局测试使用独立库 `zzsh_test_m2_workspace_layout` 与锁 `805014`，不占用 M2 auth 套件的 `805002`。迁移身份与运行身份分离，runtime 无 DDL/角色继承和审计修改权限。管理员目录与操作权限依赖 business migration `0008_m2_admin_permissions`；未应用时管理会话快照会查询失败。具体环境变量见 apps/api/.env.example，禁止将本地秘密提交。

test:readiness 会受控停止/恢复本项目依赖，不属于日常前端检查。禁止影响其它 Compose 项目。灾备命令 security:disaster-recovery 仅为 test/fake 验证入口，维护身份、线下确认及预登记通知必须配置，生产启用仍未验收。

API 请求日志只记录方法、路由模板、状态、requestId和耗时，不记录请求体、Cookie、密码、OTP及密钥。认证细节见 [认证说明](architecture/authentication.md)。

Admin 免账号 mock 预览已移除。真实初始化使用独立测试账号，不重置他人正在使用的账号。tmp/ 保存本地过程资料，.impeccable/ 保存工具状态，二者不进入 Git。

## 正式收款与恢复装配

`JOINPAY_COLLECTION_ENABLED` 缺省或 `false` 时不额外读取支付配置/密钥，不配置支付恢复任务；非法布尔拒绝。启用沿原 `APP_PROFILE=provider-test`、`PROVIDER_MODE=real`、认证和准确 runtime 数据库身份限制；合法配置不代表渠道或真实资金授权。

启动 JSON 经现有 `readSecret` 从 `JOINPAY_COLLECTION_CONFIG` 或 `JOINPAY_COLLECTION_CONFIG_FILE` 取得，文件引用相对工作目录且限于 `.secrets`，不新增 `.env` 加载行为。完整结构见 `apps/api/src/order/joinpay-collection-runtime.ts` 的 `JoinpayCollectionRuntimeDocument`：显式准入、最多32份profile、当前SUBMIT/QUERY、原key到单一通知profile映射、key变量引用、商品名、QR精确host名单、`newRequestsEnabled` 和可选 `recovery`。密钥不写入JSON/profile或交接件。

`newRequestsEnabled=true` 要求完整SUBMIT/QUERY/NOTIFY准入、SUBMIT selector、商品名和非空QR精确host名单。为false时只关闭新创建，SUBMIT selector和商品名可省略，QUERY/NOTIFY仍完整校验，QR名单可空。保留完整profile仅切开关时准入canonical/hash不变，已持久化旧请求仍可依原授权首次派发；它不表示撤销全部旧单执行。

确实退役SUBMIT、只保留QUERY/NOTIFY时，旧单须在 `acceptedInitialAdmissions` 显式保留原准入引用/摘要；通知映射可引用退役的初始key版本，但不读取旧下单钥，仍只选一份明确通知profile。后台从受信准入操作集合确定首派资格，QUERY/NOTIFY型在扫描和原执行器两处禁止首次SUBMIT，继续查已尝试原号及接纳已验观察。历史证据按原profileId/摘要/keyVersionRef三元复验，不轮试或猜钥；历史QUERY/NOTIFY自身三元所需的profile和旧钥仍须保留，不能一并当作退役下单钥删除。key引用限 `JOINPAY_COLLECTION_KEY_` 前缀，实际值或 `_FILE` 惰性读取，按版本在进程内缓存；A2不能进入正式收款装配。普通GET只读本地，不读取支付钥或调用商户。

collection `recovery` 显式配置workerId、每批1–10、最小间隔30–86400秒；缺省不启动。退款与提现可由下述显式运行配置装配；提现条件仍由受信身份、当前银行卡绑定和正式钱包/配额依据共同决定，客户端配置不能生成资格。提现还须真实executor、通知和routes使用同一scope；不能用客户端参数或单独flag替代。未配置保持关闭，不创建或批准新意图。

恢复任务在Nest启动后才派发，先释放扫描连接，再顺序调用原单执行器；自动QUERY在原行锁内按PG时间重核间隔，持久化计数最多10次，不靠重启清零。关闭先停止下一轮、排空在途，再结束原池；不承诺固定排空时长。提交未知保留原单/阶段并停止对应域，预算耗尽不标失败、不换号重发、不释放或核销。实际Schema/窄权、资源与商户资格、官方协议/KAT及资金链须独立验收，源码/合成测试不是到账证明。

退款 `JOINPAY_REFUND_ENABLED` 缺省/false时不额外读取退款配置或钥，不注册该装配；启用仍须原真实provider、认证及准确runtime身份，在建池前校验。配置经原 `readSecret` 从 `JOINPAY_REFUND_CONFIG`/`JOINPAY_REFUND_CONFIG_FILE` 读取，JSON最多256KiB、文件限相对工作目录的 `.secrets`，不新增 `.env` 加载。结构见 `JoinpayRefundRuntimeDocument`：最多32份按操作＋profileId索引的受审profile、准入引用、当前QUERY、原初始key到单一NOTIFY的明确映射、`JOINPAY_REFUND_KEY_` 变量引用及可选recovery；私钥惰性读取并按退款领域独立缓存。原证据按profileId/摘要/keyVersionRef三元复验，所需历史QUERY/NOTIFY profile和钥继续保留，不轮试或猜钥。收款与退款可明确引用同一商户私钥文件，变量前缀隔离不要求供应商另发密钥；A2不获正式能力。

`newRefundsEnabled=true` 必须有初始SUBMIT、完整三操作准入及显式recovery。仅对原JOINPAY/APPLIED款项和已冻结posting创建原租客全额应退意图，原key由posting稳定派生；复用原付款预算锁、金额/期限复核、幂等与审计，不重算七天截止，不接收客户端金额，不重开其他key或已失败责任。分配提交未知保留posting和原key并停止该域，不伪造intentId或继续外呼。关闭新分配不撤销已持久化旧授权；真正仅QUERY/NOTIFY准入在扫描与原执行器两处禁止首次SUBMIT，仍可查原号。此源码接线不启用受控结算或商户能力，暂停/恢复、正式结算及真实退款到账另验；旧单、保证金和过账后新增责任不在本路径。

## 银行资料、提现历史与商户账户

`WITHDRAWAL_BANK_BINDING_ENABLED`、`JOINPAY_PAYOUT_ENABLED`、`JOINPAY_ACCOUNTS_ENABLED` 缺省均为false；关闭时不读取各自配置/密钥或启动任务。显式开启使用同名 `_CONFIG`/`_CONFIG_FILE`，继续由原 `readSecret` 限定文件位置及准确runtime资源。银行卡保护钥引用为 `WITHDRAWAL_BANK_KEY_`，只在受权存取时按版本读取；新银行卡测试表尚未转为正式迁移，不能因源码已接线就启用。

银行卡保存/修改由本人会话、Origin、原key和版本约束，公开结果只给掩码。绑定表以AES-GCM保护资料；`USER_AUTHORIZED_BANK_BINDING`只证明用户声明，不能显示成银行要素验证。显式 `LEGACY_CODE_PASSTHROUGH` 供给原S104字段原值，既有私有提现意图及canonical可能保留该目标原值，`Enc`字段名不代表本地密文；不得把完整目标放入DTO、审计或日志。正式启用仍需真实受信身份及商户资料、目标存储保护和产品要求专项核验，当前fake身份不能取得新提现资格。

提现options读取本地政策/资格及本人掩码，不解密或出网；原quote继续核钱包、配额与完整资格。银行卡变更使旧目标报价失效，已外发单按原目标/原号查询。新请求关闭时仅保留明确历史QUERY/NOTIFY恢复，不首次SUBMIT。`GET /api/v1/users/me/withdrawal-history`及`/api/bff/user/withdrawal-history`提供v2本人历史，历史/LOCAL_CONTROLLED/JOINPAY分段分页；旧v1保持。缺schema/证据保持不可用，原目标只从原意图读取，原key找到本地记录不等于原调用ACK或银行到账。

商户账户配置可只提供显式管理员到商户范围的本地读取；GET不查供应商、不读取商户钥，也不从finance.read推导刷新命令。仅配置observation才按原业务池启动串行观察，每轮最多两项，60–86400秒间隔；当前限一个指定观察实例，无跨实例频控。关闭先中止HTTP并等待记录收尾，再关闭池；未知观察保留，商户余额不表示用户钱包或银行到账。以上默认关闭源码与离线检查不替代PG、身份/商户或真实资金验证。

## 供给发布验证

发布模型需前向应用0018–0021；不修改0015–0017或M1/M2迁移。先在隔离目标检查旧接受记录/媒体归属是否满足新增外键，冲突时停止核对，不造版本或清共享表绕过。现有保留API未自动迁移或重启，不能据新的前端菜单认为旧API已支持发布。

供给完整PG入口为 `npm run test:supply -w @zzsh/api`，已纳入根check。可设置 `SUPPLY_TEST_RESOURCE_SET=<小写标识>` 一起派生独立库、迁移/runtime角色和锁；不得混用旧资源。auth仍使用 `M2_AUTH_TEST_RESOURCE_SET`。相关测试复用明确的业务表TRUNCATE清单并核schema所有权，不使用CASCADE扩大清理。

默认保证金和占用均UNKNOWN；正向发布只在已启用test/fake能力的受控测试fixture中验证。管理审核页面为 `/supply/reviews`；用户端本阶段只交付API/BFF，无正式发布页面验收。生产CDN及真实身份、资金、云信仍未接入本阶段验证。

媒体存储通过 `MEDIA_STORAGE` 显式选择（默认 `local`，内容寻址文件在 `uploads/`）；设为 `oss` 时要求 `OSS_BUCKET/OSS_REGION/OSS_ENDPOINT/OSS_OBJECT_PREFIX` 及服务端进程环境的 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`（可选 `ALIBABA_CLOUD_SECURITY_TOKEN`），缺失即启动失败，不自动回退。该选择独立于 `PROVIDER_MODE`，只为媒体启用OSS，不会同时打开短信、身份或支付真实渠道；凭据不写入 `.env`、源码或前端。上传在对象写入前用短事务复核当前权限与归属，已撤权请求零对象写入，最终事务内再次复核。切换存储后端不迁移历史对象：数据库只存内容哈希，没有逐对象后端定位，改变 `MEDIA_STORAGE` 会把全部历史读取指向新后端；已有本地对象未复制时会缺图。切换前提为保留 `local`，或先把历史原始/衍生对象复制到新后端并逐键（或按哈希清单）核验后再切换；本阶段不建设双写系统或对象迁移框架。已授权开发目标为 zzsh-dev Bucket 的 `zzsh-rebuild/dev/` 前缀，适配器已在开发Bucket完成合成图片上传/读取/匿名拒绝/衍生图/清理的直连验证；这不等于整条 HTTP API→OSS 的权限/撤权端到端浏览器验收，生产CDN与公开域名另验。

M3-D数据层新增0022_m3d_favorites，需在隔离目标先验证并纳入既有测试表清理清单。Web数据代理复用ZZSH_API_ORIGIN/ZZSH_WEB_ORIGIN；生产缺少有效Origin配置即503，不使用本地假数据。当前仅接口/调用层完成，用户UI工作树整合后再连接正式页面。测试仍用独立SUPPLY_TEST_RESOURCE_SET及M2_AUTH_TEST_RESOURCE_SET，根check包含收藏/失效及M3-C R1–R3回归。
