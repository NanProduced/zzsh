# 业务数据库新装基线

生产空库使用 `apps/api/migrations/initial/release_production_0153/`，覆盖 canonical 0000–0153。它由空库安装原链后生成，保留业务结构、静态种子、约束和权限。所有业务表和有效列，以及业务版本账，都有数据库目录中的中文 `COMMENT`。安装前先确认目标业务 schema 为空，并使用已有 migration profile 的独立 DDL 与 runtime 身份：

```sh
npm run migrate:business -w @zzsh/api -- --initial --baseline release_production_0153
```

四个 SQL 段依次安装结构、必要静态种子、约束和触发器、PUBLIC 权限。runtime 窄权由 `applyRuntimePrivileges` 安装。manifest 校验源迁移、覆盖前缀、各段及组合的原始字节；保留函数正文的换行，不格式化已封签的 SQL。

生产投影省略已下线的管理工作台布局、纯本地模拟支付声明、退款沙箱、模拟提现及其辅助对象，也不安装独立的 `zzsh_meta` 测试元数据。保留 `zzsh_business_meta.migrations` 业务版本账、正式汇聚收款／退款／出款、绑卡、钱包及旧来源和审计。通用 `payment_channel_observation` 保留作兼容观察读取，生产约束仅接受未验证的汇聚观察；正式收款观察保存在 `joinpay_collection_observation`，任何单条观察均不代表已收款或到账。

已装 `release_0141`、`release_0151` 或原 canonical 的库按原版本账接后续编号迁移；原文件与哈希不变。生产 initial 只记一条明确的基线和后续增量，不补造覆盖历史，也不用于删表重灌。以后正常迁移无需重复传 `--initial`。空库使用初始安装时显式选基线；仅用 `--initial` 仍由 registry 的兼容默认值决定。

本地受控渠道测试使用登记的独立测试资源，按其原 canonical 链或 `--initial --baseline release_0151` 新装，并使用已有受控资源准入。不要将测试辅助对象、模拟凭据或事实迁入生产基线。此路径的受控成功也不代表真实渠道或银行到账。

`node scripts/migration/build-business-initial.mjs --plan` 不连接数据库。生产导出需 `--execute --production --source-db <登记的临时生成库> --oid <现场OID> --baseline <新版本> --source-count <冻结迁移数>`，并绑定准确 marker、nonce 和维护锁。生成器只读空业务库的同一快照，仅允许固定的静态种子；发现业务数据、缺失中文注释或混入排除对象即拒绝。发布前比较原链与生产投影的有意差集、投影与新装的结构和有效权限，以及已装旧基线的升级路径。目录和安装验证不替代真实旧数据转换或渠道验收。
