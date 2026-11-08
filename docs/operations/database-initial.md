# 业务数据库新装基线

生产空库显式选择 `apps/api/migrations/initial/release_production_0174/`，覆盖 canonical 0000–0174。它从受控的 0153 生产基线与完整后续链生成，保留业务结构、静态种子、约束和权限。所有业务表和有效列，以及业务版本账，都有数据库目录中的中文 `COMMENT`。安装前先确认目标业务 schema 为空，并使用已有 migration profile 的独立 DDL 与 runtime 身份：

```sh
npm run migrate:business -w @zzsh/api -- --initial --baseline release_production_0174
```

四个 SQL 段依次安装结构、`02-initial_data.sql` 中的必要静态种子、约束和触发器、PUBLIC 权限。静态种子只包含权限与角色、审批模板、头像审核默认策略、退款等待期默认 0/7 天，以及旧订单资金责任运行合同；不包含管理员、TOTP、旧上架保证金或用户交易数据。游戏目录、价目、会员和分销政策、信用档案与法律文书仍须单独按各自来源初始化和验证。runtime 窄权由 `applyRuntimePrivileges` 安装。manifest 校验源迁移、覆盖前缀、各段及组合的原始字节；保留函数正文的换行，不格式化已封签的 SQL。

该基线之后的 canonical 尾迁移包含 `0175_legacy_account_capture_facts`、`0176_user_auth_throttle` 和 `0177_market_identity_provider`。`0176` 安装用户认证限流及挑战防重放结构，运行角色的表、序列和清理所需列权限由 `applyRuntimePrivileges` 收敛；使用 PostgreSQL 限流时，新版 API 启动前会核验依赖，旧版 API 不具备该检查。`0177` 扩展实名提供方约束，保留原有来源，新供应商的实名调用在请求前检查结构是否就绪。已有同名结构仅在完整结构指纹和所有者一致时承接。基线源文件校验只对已独立确认的 `0155` LF/CRLF 固定字节对兼容，其他内容或换行变化仍拒绝。

生产投影省略已下线的管理工作台布局、纯本地模拟支付声明、退款沙箱、模拟提现及其辅助对象，也不安装独立的 `zzsh_meta` 测试元数据。保留 `zzsh_business_meta.migrations` 业务版本账、正式汇聚收款／退款／出款、绑卡、钱包及旧来源和审计。通用 `payment_channel_observation` 保留作兼容观察读取，生产约束仅接受未验证的汇聚观察；正式收款观察保存在 `joinpay_collection_observation`，任何单条观察均不代表已收款或到账。

已装 `release_0141`、`release_0151`、`release_production_0153` 或原 canonical 的库按原版本账接后续编号迁移；原文件与哈希不变。生产 initial 只记一条明确的基线和后续增量，不补造覆盖历史，也不用于删表重灌。以后正常迁移无需重复传 `--initial`。空库使用初始安装时显式选基线；仅用 `--initial` 仍由 registry 的兼容默认值决定。

本地受控渠道测试使用登记的独立测试资源，按其原 canonical 链或 `--initial --baseline release_0151` 新装，并使用已有受控资源准入。不要将测试辅助对象、模拟凭据或事实迁入生产基线。此路径的受控成功也不代表真实渠道或银行到账。

`node scripts/migration/build-business-initial.mjs --plan` 不连接数据库。生产导出需 `--execute --production --source-db <登记的临时生成库> --oid <现场OID> --baseline <新版本> --source-count <冻结迁移数>`，并绑定准确 marker、nonce 和维护锁。若生成库从已登记生产基线安装后追加 canonical 尾链，显式传入 `--source-baseline <原基线>`，工具会复用基线校验并逐项核对实际版本账。使用本机 `pg_dump` 时须以 `--pg-dump-executable <绝对路径> --pg-dump-sha256 <摘要>` 绑定工具字节；未指定时保留原本地 Docker 执行方式。生成器只读空业务库的同一快照，仅允许固定的静态种子；四张权限、角色、角色权限和审批模板表必须与绑定 canonical 全链的行集证明一致，只排除生成时变化的 `created_at`、`updated_at`；默认单例逐值核对。发现额外、缺失或更改的种子、其他业务数据、缺失中文注释或混入排除对象即拒绝。发布前比较原链与生产投影的有意差集、投影与新装的结构和有效权限，以及已装旧基线的升级路径。目录和安装验证不替代真实旧数据转换或渠道验收。
