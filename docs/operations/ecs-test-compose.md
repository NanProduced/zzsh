# 香港内部测试服：Compose 运行说明

状态：部署候选准备中，尚未部署。Owner 已选择香港 Ubuntu 22.04 x86_64 ECS（2 核、8 GiB、40 GiB 系统盘），并指定 `test.nanproduced.cloud`、`admin-test.nanproduced.cloud`、`api-test.nanproduced.cloud`；首次启动平台或导入数据库必须等 Owner 完成本地实测审核。地址、DNS、证书、代码版本和容量以操作前实查为准。

## 管理连接与文件传输

本机可用 [阿里云 Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/connect-to-an-instance-through-workbench-cli/) 连接和管理 Linux ECS。凭据只从本机受限配置或已授权环境读取，不写入仓库、命令参数或日志。每次针对实例执行命令或传输文件前，用 `workbench list ecs -r <地域>` 核对账号、地域和实例 ID，再显式指定目标；`workbench exec` 每次运行于独立 shell，不继承前次目录或环境。首次连接可能自动添加 Workbench 所需的安全组规则，应先核对现有配置。

`workbench upload` / `download` [经 OSS 中转](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances)，实例需能访问对应地域的 OSS 内网端点。上传前核对当前 CLI/服务端的文件体积限制和目标磁盘余量；目标已存在时保留覆盖保护，先核对并选择新路径，不用 `--force` 或删除原文件绕过。首次平台部署和数据库导入仍须先完成第六轮本地实测并经 Owner 审核批准；此前不得上传真实业务 dump。

## 结构与边界

`deploy/ecs-test/compose.yaml` 在单机运行 Next 用户站、Nest API、PostgreSQL 16、Redis 7 和 Caddy；Admin 为 Caddy 镜像中的静态构建。仅 Caddy 发布宿主 80/443，三个域名分别进入用户站、Admin 和 API；Admin 的 `/api/*` 原路径转 API，其他路径回退 Admin SPA。用户站的 `/api/*` 仍由 Next BFF 处理。数据库与 Redis 仅连接内部数据网络，不发布宿主端口。

Owner 已选择测试站保持公网开放，使用平台自身的登录和权限控制；用户端公开列表可在未登录时访问，不额外配置内测口令或 IP 白名单。

Caddy 自动申请并续期公网 HTTPS 证书，证书与配置放在独立持久卷。直连 ECS 的代理清除客户端自带的转发/IP 内部头，再写入实际对端地址；Compose 用固定内网地址限制 API 和 Next 信任的代理。若引入 CDN、负载均衡或更改子网，须重新设计并验证信任链，不能直接信任任意转发头。`compose.env.example` 给出可调整的域名和三个私网网段；先核对其不与 VPC、宿主路由冲突。

PG 和 Redis 使用本环境独立 CA 和与 `postgres` / `redis` 主机名匹配的证书；API 强制 `DB_TLS_MODE=verify-full`、`REDIS_TLS_MODE=verify-full`。PG 拒绝非 TLS TCP 连接；Redis 关闭明文端口，使用单独 ACL 用户。Redis 当前只服务依赖健康检查，ACL 仅授连接和 PING；扩展用途时先补充精确权限与测试。不要用跳过证书校验代替部署。

Compose 把汇聚收款、退款、提现和账户查询四个 `JOINPAY_*_ENABLED` 固定为 `false`，不读取商户配置。云信、短信、实名、OSS 按 Owner 配置的真实测试环境装配；启动时的配置不等于外部服务验收，也不等于汇聚或银行到账。受控测试支付与真实资金事实保持分开。

## 云信事件回调

测试服模板启用 `ORDER_IM_EVENTS_ENABLED`；`ORDER_IM_EVENTS_APP_KEY` 须与 `YUNXIN_APP_KEY` 指向同一测试 App，`ORDER_IM_EVENTS_APP_SECRET_FILE` 指向该 App 对应的受限密钥文件。先核该 App 的群容量与权限、API 域名 HTTPS 证书和可达性，确认服务能原样接收签名请求，再在获授权后按云信官方说明配置[消息抄送](https://doc.commsease.com/messaging2/server-apis/jY5MDk1NTQ?platform=server)和[第三方回调](https://doc.commsease.com/console/concept/Tk3NjMzMjg?platform=console)：群消息抄送地址为 `https://<API域名>/api/v1/im/order-events/copy`，群消息发送前回调为 `https://<API域名>/api/v1/im/order-events/pre-send`。只选择本平台支持的群消息类型；不要擅自覆盖其他环境或 App 既有回调。控制台的回调失败策略须明确核验，云信默认放行时不能声称供应商侧拦截已生效。

配置完成后分别验证：抄送地址的已签名空正文探针返回 200，错签拒绝；测试 App 的实际咨询和新订单群收发、发送前放行/拒绝、群消息抄送及首响事实按各自身份与权限核对。只为事件开启后新 READY 群启动首响跟踪，历史群不批量补启；无法验证的事件和失败策略保持未验。普通咨询的客户端鉴权与该供应商回调是不同环节。85 已读回执仍按既定独立设置，不因上述配置自动开放。

## 构建与私有配置

1. 固定经本地实测审核的同一提交及依赖锁，确认三端、迁移账本和待导入数据属于该版本；不要把未提交工作树或旧预览构建冒充发布版本。构建前检查 `df -h` 和 `docker system df`。40 GiB 系统盘还要容纳镜像、构建缓存、数据库、受限 dump 和可恢复备份；不足时先扩盘或在兼容 x86_64 的独立机器构建。不要对共享 Docker 环境执行全局 prune。
2. 在仓库外准备受限配置，例如 `/srv/zzsh-test/restricted/compose.env` 和 `/srv/zzsh-test/api.env`，从 `deploy/ecs-test/` 的两个 `.example` 复制并按实际值填写；受限目录权限为 0700，文件仅维护者可读。`api.env` 的 OSS 凭据由现有适配器以进程环境读取，必须保护该文件及 Docker 管理权限，不输出完整 Compose 配置、进程环境或容器 inspect。短信、实名、云信凭据分别配置；现有 OSS 静态 STS 不会自动续期。
3. 在全新的仓库外空目录运行 `sudo bash deploy/ecs-test/create-internal-secrets.sh /srv/zzsh-test/secrets`。脚本生成内网 CA、两个服务证书、三个数据库角色口令与 Redis ACL/口令；已有内容时拒绝覆盖。API/migration 分别只读挂载各自所需密钥，CA 私钥留在 root 专用目录。按 `api.env` 的 `_FILE` 路径另行放入认证、游标、身份摘要、短信、实名、云信及银行卡保护材料，文件可被容器 uid/gid 1000 读取；不要将真实值放入仓库。CA、密钥及恢复材料须安全备份，重启/发布不能重生成。证书到期前另行受控续签。
4. 使用 `docker compose --env-file /srv/zzsh-test/restricted/compose.env -f deploy/ecs-test/compose.yaml config --quiet` 验证配置；也可运行 `node deploy/ecs-test/verify-compose.mjs`，用合成环境检查汇聚强制关闭、网络和 TLS 等关键约束。Dockerfile 多阶段使用锁文件安装；2 核 8 GiB 机器应在业务服务启动前串行执行 `... build api`、`... build web`、`... build proxy`，不要并行构建或一边服务一边在同机全量构建。也可转入同架构构建机，以已审核镜像摘要交付。构建层与产物包含第三方依赖，实际大小及磁盘峰值须在目标验证。

银行卡资料的只读/写入配置结构可从 `deploy/ecs-test/withdrawal-bank-binding.json.example` 复制到受限 API secret 目录；模板仅引用环境变量名，保护钥另存 `_FILE` 指向的文件，格式为 32 字节 base64url。若恢复数据已有银行卡加密内容，须按原记录保留对应旧 key version，再决定当前写入版本；不能为了让新环境启动而随机替换旧钥。

已安装 Buildx 且支持 `--resource` 时，下面的顺序为每个构建容器设 3 GiB 内存、1 核配额；`ZZSH_IMAGE_TAG` 必须与受限 Compose 配置中的 `ZZSH_TEST_IMAGE_TAG` 完全一致。Next 构建使用 1 个静态页面 worker，并从运行镜像移除 webpack 构建缓存；这不是 ECS 峰值资源验收。

```sh
ZZSH_IMAGE_TAG=REPLACE_WITH_REVIEWED_REVISION
docker buildx build --load --resource memory=3g --resource cpu-quota=100000 --resource cpu-period=100000 --target api -t "zzsh-ecs-test/api:$ZZSH_IMAGE_TAG" -f deploy/ecs-test/app.Dockerfile .
docker buildx build --load --resource memory=3g --resource cpu-quota=100000 --resource cpu-period=100000 --target web -t "zzsh-ecs-test/web:$ZZSH_IMAGE_TAG" -f deploy/ecs-test/app.Dockerfile .
docker buildx build --load --resource memory=3g --resource cpu-quota=100000 --resource cpu-period=100000 --target proxy -t "zzsh-ecs-test/proxy:$ZZSH_IMAGE_TAG" -f deploy/ecs-test/app.Dockerfile .
```

## 第六轮本地审核门禁

第六轮必须处理 Owner 已指出的问题，不能因页面可打开或数据已落库就默认通过：旧平台在架账号承接后可租且属性、来源和报价正确；云信客服可用；分销政策、分销商和新会员等级按确认规则初始化；旧数据迁移与新库初始化职责可核对。用户钱包和管理端的总览、查找、期间核对、资金/订单详情须区分业务记录、余额变动、责任及渠道事实，来源和金额有据可查，未知不得显示为零、成功或到账。

旧提现申请与余额子流水须实现**一申请一业务展示**，同时保证子流水号可查、未闭合/冲突来源不隐藏、不重复计入金额。当前仅有可查优先的回退方案，可能并列显示多条记录，不能作为此项通过。第六轮还须验证桌面/小屏、权限、失败和恢复路径，记录数据截止、版本及明确的未通过项；由 Owner 看本地实页并审核后，才进行首次服务器平台启动和数据导入。

汇聚四个能力在首版明确关闭：涉及真实收款、退款、出款或账户渠道查询时须准确显示未接入或无法确认，不伪造成功、无记录或银行到账。真实汇聚证据、商户回调及对账需要 Owner 后续授权并单独联验；不能把这部分未验冒充首版已通过，也不能借此放过非渠道页面可修的关键错误。

## 首次导入与启动（仅审核后执行）

首次导入使用 `deploy/ecs-test/restore_approved_dump.py`，在 Linux 上通过标准库和 Docker Compose 执行；此入口只接收**已经过 Owner 本地验收和批准的 PostgreSQL 16 自定义格式 dump**，不导出本地数据库，也不是将来 MySQL 全量转换的实现。正式数据的导出、源库一致性快照与审核材料仍须使用并验证相应工具，不能把本入口的合成验证当作真实导出或导入验收。

当前候选仍有上线阻断：`--no-acl` 不会还原源归档的对象、列、函数及默认权限；现有迁移后的授权收敛也不能证明完整等价。须先完成同快照受审核 ACL 基线、角色映射、目标权限重建和独立读回，才能用于服务器导入或启动应用；隔离数据演练须单独说明此限制。

将经审核的 dump、来源清单、Compose 环境文件和回执放在主机独占的受限目录中。`zzsh.ecs-test-approved-dump.v1` 来源清单绑定 dump 路径、字节数和 SHA、PostgreSQL 主版本、数据截止、场景和迁移树 SHA、原迁移账本、关键域计数与账务借贷合计；还须绑定需承接的认证、身份摘要、订单、列表游标和银行卡各版本密钥的文件 SHA，以及已审核的账号/会话保留或脱敏决定。清单保存摘要，不保存密钥或业务正文。原始密钥按受限文件承接，不能随机替换后宣称既有 TOTP、身份摘要或银行卡仍可解密。

清单结构见 `deploy/ecs-test/approved-dump-manifest.example.json`；其中的数量和占位值必须替换为同一已审核来源的实际结果。存在银行卡时，`bankVersions` 列出所有实际需要的密钥版本，`keys` 另增加每个对应的 `WITHDRAWAL_BANK_KEY_<版本变量>_FILE` 文件 SHA；配置中的版本映射、当前版本和目标身份必须一致。不要将私有清单或密钥提交仓库。

认证、实名主体、个人确认、列表游标及银行卡的来源密钥按清单核原摘要；`USER_AUTH_THROTTLE_HMAC_KEY_FILE`、`ADMIN_ALTCHA_HMAC_KEY_FILE` 是目标运行所需的独立密钥，按要求另行安全配置和备份。若测试环境新建这两项，旧节流主体摘要及未完成的验证码挑战不能沿用，须明确接受该影响。`ORDER_CONFIRMATION_KEY_ID`、`LISTING_CURSOR_KEY_ID` 须设置非占位的稳定标识；更换标识可能使旧令牌失效。不得将新运行时密钥冒称源数据密钥。

会员逐表计数分别覆盖租赁会员资格、成长快照、旧来源覆盖、成长贡献、成长政策和旧来源读取准入。成长快照为零不表示会员等级不存在：有效等级由正式 reader 在指定时间依事实动态计算。计数匹配不能代替同版 reader 的实际读取或全表内容比对；跨源与恢复目标的等级比较须有同一截止时间的源端 reader 证据。

```sh
python3 deploy/ecs-test/restore_approved_dump.py plan \
  --manifest /srv/zzsh-test/restricted/approved-manifest.json --manifest-sha256 '<实际SHA256>' \
  --env-file /srv/zzsh-test/restricted/compose.env --private-root /srv/zzsh-test/restricted \
  --out /srv/zzsh-test/restricted/restore-plan.json
```

`plan` 核配置、目标范围、四个汇聚开关、镜像 ID、TLS/私有端口、来源密钥 SHA、dump 内容和迁移树；不宣称尚未创建的目标库已验空。首次恢复要求 PG 未运行，且不存在同项目的停止容器或目标数据卷；发现已有资源即停止核查，不启动旧数据。Linux 主机需支持 `memfd_create` 和文件封印，并为完整 dump 留出内存或受控交换空间：检查容量足够后，程序将一次打开的源文件复制到匿名文件、校验实际字节并封印，检查与恢复只读取封印后的同一份字节。可用内存是时点估计，实际运行前仍须核资源及交换空间保护。审阅同一计划和来源后，按实际 SHA 生成只用于该计划且有效期不超过 24 小时的 `zzsh.ecs-test-dump-approval.v1` 授权文件；其中 `decision=APPROVED`、`planSha256`、`manifestSha256`、`notBefore` 和 `expiresAt` 必须与明确审核决定一致，不能由准备计划的过程伪造。
授权结构见 `deploy/ecs-test/approved-dump-approval.example.json`；占位文件本身无执行效力。

```sh
python3 deploy/ecs-test/restore_approved_dump.py apply \
  --plan /srv/zzsh-test/restricted/restore-plan.json --plan-sha256 '<计划SHA256>' \
  --approval /srv/zzsh-test/restricted/approval.json --approval-sha256 '<授权文件SHA256>' \
  --run-dir /srv/zzsh-test/restricted/restore-first
```

`apply` 重新核计划输入及 Docker 实例，确认 API/Web/代理均已停止后串行启动 PG/Redis，仅在目标库与三个角色均不存在时建库；各服务通过封印的 Compose 覆盖配置固定计划批准的镜像 ID，不依赖执行时可变的 tag。每个新写入或启动阶段在实际副作用前重新核原批准有效期，过期则停止该阶段；已启动阶段的结果按原 checkpoint 核实。验 OID、角色权限、marker 和真正空库后，以 `verify-full` 和单事务恢复，保留原 dump，不运行 `--clean`。脚本随后独立核原账本、关键域计数、资金合计和密钥版本，按同版迁移链核 runtime ACL，并以目标 OID/角色登记原生钱包准入；对该准入的表 owner、禁止 runtime/PUBLIC 的表级和列级写入（含继承权限）及不可变触发器也做只读复核。已有冲突记录停止，不覆盖旧准入。当前 `startServices=true` 直接拒绝；仅当独立隔离数据演练经授权后可使用 `false`，终态明确为 `RESTORE_DATA_ONLY_ACL_UNVERIFIED`，不表示完整 ACL、HTTPS、会员 reader 或第三方渠道已通过。

中断时保留原 plan、checkpoint、原始文件、卷和受限记录。使用相同 `--plan`、`--plan-sha256` 与 `--run-dir` 执行 `inspect` 查看现场；`recover` 仅在原目标、活动连接和结果足以判明时记录可恢复状态，再使用相同计划与原授权执行 `apply --resume`。若建库步骤中断，现有记录无法证明当前目标由本次运行创建，必须人工核对，不能仅凭通用 marker 或空库认领。若恢复提交可能已发生且无法证明安全，保持 `RECOVERY_REQUIRED`，人工核对原结果，不改键、不清库、不盲目重放。

```sh
python3 deploy/ecs-test/restore_approved_dump.py inspect --plan /srv/zzsh-test/restricted/restore-plan.json --plan-sha256 '<计划SHA256>' --run-dir /srv/zzsh-test/restricted/restore-first
python3 deploy/ecs-test/restore_approved_dump.py recover --plan /srv/zzsh-test/restricted/restore-plan.json --plan-sha256 '<计划SHA256>' --run-dir /srv/zzsh-test/restricted/restore-first
```

## 验证与恢复

- 核对仅 80/443 对外，PG/Redis 没有宿主发布端口；API 的 `/api/health` 与 `/api/ready`、三个 HTTPS 域名、证书主机名和过期时间均正常。反代须实测伪造 `X-Forwarded-For` 和内部 IP 头不会覆盖真实来源；Next BFF、Admin 原路径、回调路径和 SPA fallback 分别验证。
- 从 API 容器检查四个 `JOINPAY_*_ENABLED` 均为 `false`，不得输出其他环境值；同版验证角色、登录/TOTP、必要政策、旧数据、云信、短信、实名和 OSS。真实第三方调用的结果、成本与授权另行记录；不以本地合成结果当作渠道验收。
- 建立定期备份、磁盘/内存告警和一次隔离恢复演练。Compose 持久卷包含 PG、Redis 及 Caddy 证书；应用密钥和内网 CA 另有受限备份。回退按版本、已接纳业务事实和恢复合同处理，不盲跑 down SQL、不删除卷；不得用重新生成的密钥冒充原身份或 TOTP 恢复。
