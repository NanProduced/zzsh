# 数据库结构导航

源：[业务迁移目录](../../apps/api/migrations/business) · [迁移执行](../../apps/api/src/database/business-migrations.ts) · [启动身份断言](../../apps/api/src/database/business.ts) · [结构与权限核对](acl-comparison.md)

## 迁移基线与结构事实

业务迁移位于 `apps/api/migrations/business/`，源码共 **101 份 SQL**，`meta/_journal.json` **101 条**登记（idx 0…100，tag 与文件名一一对应）。源码登记不表示数据库已经执行；实际链与权限须分别核验。另有一条独立正式迁移线 `apps/api/migrations/0000_fnd004_test_metadata.sql`（`zzsh_meta.database_marker`，journal 1 条）。两条线分别由 `apps/api/src/database/migrations.ts` 与 `business-migrations.ts` 执行，记账 schema 分别为 `zzsh_meta` 与 `zzsh_business_meta`（后者不在任何 SQL 中 CREATE，由 migrator 自建）。

下列计数仅为 0000–0090 的历史静态扫描基线，不含 0091–0100，**不是真实 PostgreSQL 目录核验**：`CREATE TABLE` 146 条（全部当前存在，含 5 张 `LIKE … INCLUDING ALL` 克隆表，全部在 `zzsh_auth_admin`）、`CREATE SEQUENCE` 3 条、函数定义事件 222 次对应 **182 个输入类型签名身份**（76 次 `CREATE OR REPLACE`，0 个同名重载）、触发器创建事件 256 次（211 条 `CREATE TRIGGER` + 45 条 `CREATE CONSTRAINT TRIGGER`）对应 **233 个（目标表+名称）身份**（当前存在 232、已删除 1），`DROP TRIGGER` 49 条、`DROP COLUMN` 2 条、`CREATE INDEX` 128 条（36 UNIQUE + 92 非唯一）对应 **126 个不同索引身份**（当前存在 123、已删除 3、删除后重建 3；其中 39 个 partial、2 个表达式索引）、隐式索引身份 277（当前存在 275）、约束身份 1348（当前存在 1332）。无 `DROP TABLE`/`DROP FUNCTION`、无 `RENAME`、无 `CREATE VIEW`、无 `CREATE POLICY`、无 `ROW LEVEL SECURITY`、无 `COMMENT ON`。

> 计数用于导航，不替代逐对象清单。创建/修改/删除/重建事件、源文件行号和跨 schema 依赖由按需生成的静态结构索引给出；该索引是只读派生资料，不进入迁移链，也不随正式文档发布。

授权关键字计数不是 ACL 清单：迁移目录中顶层 `GRANT` 语句 0 条；顶层 `REVOKE … FROM PUBLIC` 语句 64 条（静态扫描）。函数体、动态 `EXECUTE` 字符串和注释中的关键字不计入顶层语句，也不代表当前数据库权限。当前 ACL 期望清单属独立演练，不在本文件范围。

7 个业务 schema：`zzsh_iam`、`zzsh_auth_user`、`zzsh_auth_admin`、`zzsh_supply`、`zzsh_content`、`zzsh_order`、`zzsh_credit`。

**迁移顺序是开发顺序视图，不是当前结构视图。** "这个表现在长什么样"必须按创建迁移 + 后续 `ALTER` 叠加得出；替换型函数（`CREATE OR REPLACE FUNCTION`）只有文件级 journal，没有函数级留痕。已经应用的迁移不重排、不重命名、不 squash；新增变更沿 journal 前向追加。本文与所附对象清单里的"创建迁移"列只是 `CREATE TABLE`/`CREATE SEQUENCE` 所在的那一份迁移，**不等于完整当前定义**。

### 迁移顺序概览（按 idx）

| idx | 内容 |
|---|---|
| 0000–0014 | `zzsh_iam` + `zzsh_auth_user`/`zzsh_auth_admin`（admin 表 `LIKE … INCLUDING ALL` 克隆后改 FK）、审计与恢复凭据、首次激活证据、管理权限与审批审计、身份门禁、工作区布局 |
| 0015–0029 | `zzsh_supply` 目录/计价/条款/协议/发布接受/媒体/幂等、枪械与改枪码、来源身份唯一、收藏、`zzsh_content` 内容基础 |
| 0030–0045 | `zzsh_order.rental_order` 与占用、云信身份映射与咨询、OIM 付款/派单/群/成员/操作/首响/升级、租赁会员 |
| 0046–0051 | 开租确认、结算版本/判定/接收/过账与守卫、个人报价 v2 守卫修正 |
| 0052–0055 | `listing_publication`、号主保证金证明、资金守卫修正、皮肤身份合同（`skin_owner`） |
| 0056–0057, 0069, 0072 | 旧号只读快照、`legacy_order_read_snapshot`（Admin 订单兼容读）、来源状态、旧展示快照 |
| 0058, 0075–0076, 0084 | 期初/经济根/覆盖事件/观察/钱包覆盖与修订、历史覆盖、stored opening 解码 |
| 0059–0060 | 受控提现准入/目的地/意图/渠道事实/受控操作/通知与审计结论 |
| 0061–0066 | 分销政策版本/参与人/邀请码/关系、原生钱包来源证明、原生资源准入合同 |
| 0067 | `zzsh_credit` 三表 + 号主保证金 requirement/payment/refund/reconciliation |
| 0068, 0080, 0085 | 成长政策/贡献/状态/礼遇、旧覆盖、合计折扣 |
| 0074, 0077–0079 | 旧单续办证据/版本/责任/修订/在途、旧责任财务合同与事实、个人报价 v4、旧保证金历史 |
| 0081–0083, 0086–0087 | 公开编号序列/计数器、pricing compat 禁用模式、日期编号、旧皮肤持有、旧责任审计别名 |
| 0088–0089 | 皮肤品质证据、典藏/默认状态与素材来源；按类型和品质配置的推荐押金合同 |
| 0090 | 个人流水与历史财务观察按主体读取的复合索引，keyset ID 使用 C collation |
| 0091–0096 | 用户目录与注册投影、用户详情操作和资金权限、审批最终载荷、会员押金减免额度 |
| 0097 | 收款请求、观察、流水锚点及原生收款凭据，7 个新关系 |
| 0098 | 原生租赁退款意图、观察及证据，5 个新关系 |
| 0099 | 原生提现意图、尝试、观察及证据，依赖0098父守卫，4 个新关系 |
| 0100 | 商户账户只读观察，1 个新关系 |

### 按 schema 查对象（0000–0090 历史静态基线）

| schema | 职责 | 表 | 序列 | 函数 | 触发器 | 显式索引 | 约束 |
|---|---|---:|---:|---:|---:|---:|---:|
| `zzsh_iam` | 身份、管理权限、审批、审计、IM 客服、会员成长 | 32 | 1 | 16 | 14 | 34 | 201 |
| `zzsh_auth_user` | 用户认证（Better Auth） | 5 | 0 | 0 | 7 | 5 | 13 |
| `zzsh_auth_admin` | 管理员认证（5 张 `LIKE` 克隆表） | 5 | 0 | 0 | 7 | 5 | 13 |
| `zzsh_supply` | 目录、皮肤、账号、发布、计价、条款、媒体 | 41 | 1 | 49 | 50 | 29 | 365 |
| `zzsh_content` | 内容条目、版本、轮播 | 3 | 0 | 0 | 0 | 5 | 29 |
| `zzsh_order` | 订单、占用、云信建群、结算、资金观察、提现 | 57 | 1 | 114 | 151 | 45 | 679 |
| `zzsh_credit` | 信用状态/事件/恢复、号主保证金 | 3 | 0 | 0 | 3 | 0 | 32 |

`zzsh_business_meta`（业务迁移记账）和 `zzsh_meta`（test metadata 线）由 migrator 使用，不是这 7 个业务 schema 的一部分；`zzsh_credit` 不在 `BUSINESS_SCHEMAS` 的 USAGE 循环内，走独立授权分支。

按对象查源头的顺序：先按 `schema.table` 找到 `CREATE TABLE` 所在迁移，再沿该对象的后续 `ALTER TABLE`/`DROP`/重建事件读；函数按输入类型签名、触发器按目标表+名称、索引按 schema+名称区分。创建位置只是定义出现处，不是当前完整定义。

0097–0100的fresh-install前检要求本组新关系均不存在，并核对被替换父函数的准确签名及正文；已有支付fixture不能直接重装。运行角色窄权统一由 `configureJoinpayFinancialPrivileges` 在既有独立ACL事务中收敛，迁移SQL不使用测试角色GUC授予权限。Schema提交与ACL提交/未知分别报告；本源码登记不授权安装、服务切换或渠道启用。

## 权限与不可变性模型

没有行级安全（RLS）。权限由两部分组成：

1. 迁移 SQL 内的 `REVOKE … FROM PUBLIC`，以及函数体内的 `REVOKE ALL … FROM PUBLIC`；
2. 运行时列级授权：`apps/api/src/database/business-migrations.ts` 的 `applyRuntimePrivileges`，含多个 `to_regclass`/`to_regprocedure` 存在性分支，另有 7 个 `configure*` 收敛函数（`configureAdminSecurityCommandPrivileges`、`configureSkinIdentityPrivileges`、`configureDistributionFinancialPrivileges`、`configureCreditGuaranteePrivileges`、`configureMembershipGrowthPrivileges`、`configureLegacyGrowthCoveragePrivileges`、`configureContinuityFinancePrivileges`）。

`BUSINESS_SCHEMAS`（USAGE 授权循环）覆盖 `zzsh_iam`、`zzsh_auth_user`、`zzsh_auth_admin`、`zzsh_supply`、`zzsh_content`、`zzsh_order`；`zzsh_credit` 有单独分支（`GRANT USAGE ON SCHEMA zzsh_credit` + 列级 GRANT/REVOKE），不在该数组内。

启动身份断言见 `apps/api/src/database/business.ts`，**三件事要分开看**：

- `BUSINESS_SCHEMA_NAMES`（定义见 `business.ts`）列 **8 个 schema**（含 `zzsh_business_meta` 与 `zzsh_content`），用于归属查询（"当前角色是否拥有任一业务 schema / 任一业务关系"）；它是归属集合，不是授权集合。
- 同一查询里的 **CREATE 否定探针只有 6 个**（`business.ts` 的身份查询：`zzsh_iam`、`zzsh_auth_user`、`zzsh_auth_admin`、`zzsh_supply`、`zzsh_content`、`zzsh_order`）。`zzsh_business_meta` 与 `zzsh_credit` **没有**在这条查询里逐个检查 CREATE；`zzsh_credit` 的运行授权由 `configureCreditGuaranteePrivileges` 独立处理。因此不能表述为"对 8 个 schema 都查 CREATE，任一有 CREATE 必拒启动"。
- 审计表 `zzsh_iam.audit_event` 的 UPDATE/DELETE/TRUNCATE 是另一组否定断言，不属于上述 schema CREATE 探针。

不可变性由 **ACL 与触发器共同承担**，不是仅靠其一：运行时角色对审计表、`rule_release`、多数资金表没有 UPDATE/DELETE 权限（列级 GRANT 收敛），同时 `finance_immutable`、`guard_release_immutable`、`guard_version_identity`、`guard_legacy_*`、`public_derivative` 等触发器家族在语句层再拦一道；`zzsh_iam.audit_event` 为追加型；部分表另有 `BEFORE TRUNCATE` 守卫。

DDL 与 ACL 是两个事务：`runBusinessMigrations` 先迁移，再单独开 ACL 事务；`applyRuntimePrivileges` 自身不拥有事务。ACL 失败时保留 `BusinessMigrationAclError` 的 outcome、原 cause 与 `rollbackAcknowledged`：`ACL_NOT_COMMITTED` 表示 COMMIT 未尝试发出，但不自动等于回滚已确认；`ACL_COMMIT_UNKNOWN` 不得被改报成功或已回滚，坏连接退役。权限观察和只重放 ACL 的条件见[结构与权限核对](acl-comparison.md)。

### 权限入口怎么看

- **迁移元数据**：业务线在 `zzsh_business_meta.migrations` 记账（`business-migrations.ts:16-20`），test metadata 线在 `zzsh_meta`（`migrations.ts:10`）；两者由 migrator 管理，不是业务对象 schema，也不在 `BUSINESS_SCHEMAS` 的 USAGE 循环内。
- **运行时授权**：`applyRuntimePrivileges`（`business-migrations.ts:63`）先对 `BUSINESS_SCHEMAS` 的 6 个 schema 执行 `GRANT USAGE`，再按表/列 `GRANT`/`REVOKE`，并由 7 个 `configure*` 分支收敛 `zzsh_credit`、皮肤、分销资金、会员成长、旧覆盖、连续性资金和管理安全命令。`zzsh_credit` 的 USAGE 与列级授权在该分支单独处理。
- **启动断言**：`assertBusinessRuntimeIdentity` 检查 6 个 schema 的 CREATE 否定探针和 `zzsh_iam.audit_event` 的 UPDATE/DELETE/TRUNCATE 否定断言；这不等于逐对象 ACL 清单。
- **实际 ACL**：只能由指定资源、角色和观察时点的只读 catalog 观察确认；迁移文本、关键字计数、对象索引和本页都不能替代。

## 单位与金额

金额一律整数分（`*_cents numeric(24,0)`）或精确十进制文本；单价保精度（`buyer_unit_amount`/`owner_unit_amount numeric(24,8)`）。数量单位当前集合为 `zzsh_supply.billable_item.unit ∈ {HAFF_BASE, ROUND, PIECE, DAY}`——`DAY` 由 `0035_supply_day_unit.sql` 加入约束（时间型耗材如顶级保险卡），不是集合之外的特例；`quantity_scale` 另计。`settlement_snapshot_cents(text)` 只接受 `^\d+\.\d{2}$`。

## 按域导航

下表给"职责 → 关键对象 → 创建迁移 → API reader/writer → 权限依据 → 转换规则 ID"。"创建迁移"只是该对象 `CREATE TABLE`/`CREATE SEQUENCE` 所在的那一份，**不是完整当前定义**；逐对象的后续变更链、触发器名与事件、索引与 `STATIC_PARTIAL` 标注由按需生成的静态结构索引给出，不在本文件维护。本文件的表格与说明可独立阅读，不依赖任何过程资料。

| 域 | 关键对象（创建迁移） | API reader/writer | 权限依据 | 转换规则 ID |
|---|---|---|---|---|
| 身份 | `zzsh_auth_user.user`(0000)、`zzsh_iam.user_identity_state`(0010)、`zzsh_auth_admin.user`(0000, LIKE 克隆)、`zzsh_iam.admin_role`/`admin_permission`/`admin_user_role`/`admin_user_permission`(0008)、`zzsh_iam.approval_request`(0009)、`zzsh_iam.audit_event`(0000) | `apps/api/src/auth/*` | 审计表 REVOKE UPDATE/DELETE/TRUNCATE + 追加型语义；启动身份断言否定 CREATE（6 探针） | IO-ID-01/02、IO-ID-04/05 |
| 目录与发布 | `zzsh_supply.game`(0015)、`game_service_operation`(0026)、`billable_item`(0015)、`skin`(0015)、`skin_category`(0015)、`skin_rarity`(0015)、`skin_owner`(0055)、`firearm`(0026)、`entitlement`(0015)、`rental_account`(0015)、`listing_version`(0018)、`listing_publication`(0052)、`rule_release`(0015)、`rule_acceptance`(0015)、`price_version`/`price_line`(0015)、`term_version`/`term_option`(0015)、`agreement_version`(0015)、`full_payout_terms_version`(0071)、`media_asset`(0015)、`listing_filter_config`(0042) | `apps/api/src/supply/catalog.ts`、`publishing.ts`、`publishing-routes.ts`、`rules.ts`、`media.ts`、`gunsmith.ts`、`listing-filter-routes.ts` | `zzsh_supply` schema USAGE + 列级 GRANT；`assertGameScope`/`ADMIN_PERMISSION` | SUP-CATALOG-013、SUP-QTY-004/005、SUP-QTY-006、SUP-SKIN-019/020、SUP-SOURCE-001/002、SUP-VIS-014、SUP-NUM-015 v2、SUP-MODE-009/PRICE-011/TERM-012、SUP-MEDIA-017 |
| 订单 | `zzsh_order.rental_order`(0030)、`payment_confirmation`(0036)、`rental_opening`(0046)、`settlement_version`(0046)、`settlement_intake`(0047)、`settlement_posting`(0048)、`settlement_ledger_entry`(0048)、`legacy_order_read_snapshot`(0057) | `apps/api/src/order/*` | `zzsh_order` schema USAGE + 结算不可变触发器 + 无 DELETE 权限 | IO-ORD-01…08 |
| 资金和观察 | `zzsh_order.finance_opening_basis`/`finance_covered_event`/`finance_economic_root`/`finance_event`/`finance_observation_admission`(0058)、`wallet_coverage`/`wallet_revision`(0058)、`personal_finance_observation`(0058)、`personal_finance_observation_coverage`(0075)、`withdrawal_intent`(0059) | `apps/api/src/finance/*` | 列级 GRANT（无 DELETE/TRUNCATE）；`finance_immutable` 触发器 | GF-HISTORY-008、GF-OPENING-009、GF-COVERAGE-006、GF-WITHDRAW-010 |
| 成长信用 | `zzsh_credit.user_credit_state`/`credit_event`/`credit_recovery_request`(0067)、`zzsh_iam.membership_growth_policy`/`contribution`/`state`/`membership_entitlement`(0068)、`membership_growth_legacy_coverage`(0080)、`user_rental_membership`(0040) | `apps/api/src/credit/*`、`membership-*` | `zzsh_credit` 单独分支（USAGE + REVOKE CREATE + 列级 GRANT）；函数 `REVOKE ALL … FROM PUBLIC` + 单函数 `GRANT EXECUTE` | GF-CREDIT-007、GF-GROWTH-003、GF-MEMBER-002 |
| 内容 | `zzsh_content.content_item`/`content_version`/`carousel_item`(0024) | `apps/api/src/content/*` | `zzsh_content` schema USAGE + `GRANT SELECT, INSERT, UPDATE` / `REVOKE DELETE, TRUNCATE` + `ALTER DEFAULT PRIVILEGES` | CONTENT-HISTORY-020（承接用途未裁定，见下） |

跨域复用对象：`zzsh_supply.idempotency_record (scope_key, key)` 被 order/finance/membership/invitation 多域复用；`zzsh_iam.audit_event` 由 0060 触发器跨 schema 写入受控付款结论。两者域边界与 schema 名不一致，**不建议改名**（迁移历史与已应用库兼容）。

旧皮肤持有的存储事实：`zzsh_supply.legacy_skin_holding` 主键是 `account_id`，另存 `observation_version_id`、`source_system`、`source_entity`、`legacy_id`、`source_digest`、`holding_digest`、`skin_ids text[]`、`evidence_ref`、`created_by_admin_id`、`created_at`。它**没有** `source_cutoff` 列；"四列原字符串封存"是服务端受信输入/来源证据，不是该表的存储字段。

## 版本身份（目录/条款缓存的前提）

公开读取响应里有**五种互不替代**的版本计数，任何缓存键都不得把它们混为一个：

| 身份 | 存储 | 推进者 | 不推进的场景 |
|---|---|---|---|
| `game.catalog_revision`（`bigint`，`0015:9`） | `zzsh_supply.game` | 目录条目增改、封面绑定、目录导入 seam（真正 INSERT 时）、`updateGame`（含 `enabled` 切换）、媒体撤为 PRIVATE_REVIEW 时的绑定回收 | 游戏服务启停、规则激活、筛选配置保存、媒体转公开、账号发布写 |
| `game.current_release_id` + `rule_release.generation` | `zzsh_supply.game` / `zzsh_supply.rule_release` | 规则激活 | 目录写、筛选配置 |
| `listing_filter_config.revision` | `zzsh_supply.listing_filter_config`（append-only 新行） | 筛选配置保存/恢复 | 目录写、规则激活 |
| `game_service_operation.revision` | `zzsh_supply.game_service_operation` | 服务启停 | 其余全部 |
| `media_asset.revision` | `zzsh_supply.media_asset` | 媒体审核/可见性变更 | 其余全部 |

`catalog_revision` 是 `bigint`，用作缓存键或接口字段时按 `::text` 精确文本处理，不用 JavaScript Number。`game.cover_media_id`、`skin.media_id`、`billable_item.media_id`、`firearm.media_id` 是绑定，公开投影在读取期当场复查 media 的 `review_state`/`access_class`/`public_storage_key`，不把绑定当作公开资格。

条款正文的版本身份是**被封存版本的主键 + digest**：`agreement_version.id`/`digest`、`full_payout_terms_version.id`/`digest` + `price_version.id`，并要求 `status='SEALED'`。详见 `docs/architecture/supply-form-contract.md` 与 `apps/api/src/supply/full-payout-terms.ts`。

**"有公开资格检查"不等于"版本新鲜"**：`requirePublicGameService`（`apps/api/src/supply/game-services.ts`）只核 `supported`/`game.enabled`/`service.enabled`，不读任何 revision。

## 回溯链：页面 → 原始转换依据

1. 页面 → Web BFF `apps/web/src/app/api/**` → API 模块（BFF 不直连交易库、不重复业务规则）；
2. 旧号：`apps/api/src/supply/legacy-listing-read.ts` 读 `legacy_listing_read_snapshot`（PK account_id）+ `legacy_listing_display_snapshot`（PK account_id,schema_version，含 `resources`）→ `legacy_supply_map`（**PK evidence_ref**，`source_system/source_entity/legacy_id`）→ 源 MySQL 行；
3. 旧皮肤持有：`legacy_skin_holding`（PK account_id，`skin_ids` + `source_digest`/`holding_digest` + `evidence_ref`）优先于 `listing_skin`；
4. 旧单：`zzsh_order.legacy_order_read_snapshot` → `legacy_continuation_evidence`（`evidence_ref`/`source_digest`/`parameter_digest`/`facts_digest`/`source_as_of`）→ `legacy_continuation_version` → `legacy_order_duty(+revision/admission)`；
5. 财务观察：`personal_finance_observation`（UQ source_*）+ `personal_finance_observation_coverage`（`source_cutoff`）+ `finance_opening_basis`/`finance_covered_event`/`finance_observation_admission`。

### 现有的转换依据读取出口（不写"完全没有"）

- **财务单据**：`apps/api/src/finance/admin-finance-routes.ts:58` 的 `documents/{ref}` 路由调 `readAdminFinanceDocument`（`apps/api/src/finance/admin-finance-read.ts:305`），对受权管理员返回 `document`、`entries`（含 `sourceDigest`、`basisId`、`reasonCodes`、`evidence`）、`evidence`、`related`、`reasonCodes`、`platform`。
- **旧单续办**：`apps/api/src/order/legacy-continuation-evidence.ts` 的写入回执含 `evidenceId`；`legacy-continuation-model.ts:144` 的投影含 `revision` 与 `evidenceId`。
- **仍缺的字段**：个人侧旧单读取（`legacy-user-order-read.ts`）只暴露 `continuationStage`，不给 `evidenceId`/`revision`；财务单据投影不含 `parameter_digest`/`facts_digest`；钱包观察不返回 `source_cutoff` 之外的完整证据链。争议单据的完整举证仍需组合多个出口或内部查询。

转换规则 ID 与源字段映射以 `docs/architecture/legacy-data-mapping.md` 为权威，本文件不新增规则、不推算未知值。

## 相关文档

- [技术选择](technology-decisions.md) · [仓库结构](repository-layout.md) · [多端与 BFF](multi-client-bff.md)
- [API v1 契约](api-v1-contract.md) · [旧数据转换与字段映射](legacy-data-mapping.md)
- [结构与权限核对](acl-comparison.md) · [转换规则证据边界](rule-coverage.md)
- [公开列表组合筛选与配置](listing-query.md) · [账号公开查看、可租状态与编号](account-visibility.md)
- [供给表单数据契约](supply-form-contract.md) · [开租与结算确认](settlement-confirmation.md)
- [信用与号主保证金运行合同](credit-guarantee.md) · [会员成长与人工礼遇](membership-growth.md)
- [本地 PostgreSQL 使用规范](../local-postgresql.md) · [测试、验证与验收脚本规范](../testing.md)

## 已知限制（不得当作已核）

- 本文件的结构事实来自迁移 SQL 与迁移执行链的**静态扫描**，不是真实 PostgreSQL 目录核验。已应用集合、实际权限、索引与统计须在隔离资源按 `docs/testing.md` 实测。
- "创建迁移"列不等于完整当前定义：函数重载、`DROP TRIGGER` 后的重建、跨迁移重建的索引（128 条 `CREATE INDEX` 语句 → 126 个身份）、`LIKE` 克隆展开均未完整静态归约，相关"当前唯一定义"判定标 `STATIC_PARTIAL`。
- 授权关键字出现次数、顶层语句与当前 ACL 清单互不相同；本文件只说明前两种的边界，不给 ACL 清单。
- `zzsh_content` 三个公开读取的 writer 与版本身份未逐个枚举；在补齐前，内容不进入任何缓存候选。
- 源→目标字段覆盖仍有大块 DEFER（TXN_HISTORY、COMMERCE_SCAFFOLD、THIRD_PARTY_CONFIG 等），以 `docs/architecture/legacy-data-mapping.md` 的规则版本为准；`CONTENT-HISTORY-020` 的经营/法律正文承接用途未裁定。
