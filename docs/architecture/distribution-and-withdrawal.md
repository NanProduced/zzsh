# 分销与本地提现

支付、退款、真实银行卡提现及新旧资金承接的共同口径见[支付与资金领域规格](payments-and-funds.md)。本页维护分销计算与本地受控装配，不代替正式渠道准入。

新政策使用 `distribution-policy.v2` 的 `UNIFORM` 模式，分别配置租客来源和号主来源两个统一比例，不再按等级编辑。运营提交冻结变更，经有资格的 Boss 审批后执行；直接 PUT 不再用于管理端改政策。经营比例须明确给出，不从海报、历史等级或测试示例推导。旧 `distribution-policy.v1` 和已冻结依据保留兼容，最低提现额仍与计佣规则分开。

租客和号主分别通过自己的直属 `DISTRIBUTION_LEADER` 确定受益人；v2 按受益角色使用统一比例，旧 v1 依据继续使用原受益人等级。注册 `INVITER` 与分销上级分别保存，登录不重写注册来源。新 v2 关闭只停止新首款计佣，不删除合法关系或改写既有依据、计提和责任；旧结构上的 v1 注册/绑定保留原准入规则，避免源码先部署时破坏原约束。当前只支持一层、禁止自身上级，ordinary/custom 可配置，fast 不计佣。最低计佣额与最低提现额互不替代。

付款原事务冻结政策版本、关系、受益人资格和比例。付款估算基数为 quote 的 platformFullProfit；最终佣金按不可变结算 posting 的 `platformContributionCents - compensationFeeCents` 计算，HALF_UP 到分，两角色总额不得超过该基数。不是订单支付总额的 5%。已有 APPLIED 付款只读原冻结依据；缺失保持 `MISSING_ORIGINAL_BASIS`，不能换政策追补。历史佣金观察和旧钱包期初不生成新佣金。

本人收益详情的 v2 投影可返回本笔冻结的分销比例、受益等级、政策版本、计佣口径与舍入说明；不公开计佣基数、平台贡献或补偿费数值。来源订单公开号仅对该订单的租客或号主本人可见，收益受益人身份本身不增加订单读取权。原依据缺失或不一致保持未知，历史观察未记录的比例不按当前政策倒算。Web 用稳定收益记录 ID 定位详情，刷新与浏览器历史恢复仍按当前登录主体重新授权。

本人收益v2另以`currentResponsibility`表达按原`source_record_id`及受益人绑定的持久佣金责任：PENDING/MATURED/VOID/SETTLED、当前金额、修订及成熟时间；与已验证终定事实`currentFinance`分列。原记录金额/状态与筛选不变，责任状态SETTLED本身不代替财账核验；未知不补零，成熟时间不自动改变持久状态。列表及详情在同一读取快照内按页批取责任，责任版本参与游标失效；GET不推进成熟、作废或过账，v1载荷保持，旧v2缺新字段按未知兼容。

`createLocalDistributionRuntime` 只为明确的本地 test/fake 资源组装已有能力，返回可传入认证装配的 `auth` 与有界 `earnings`。构造时不连接数据库，不写政策、注册身份或准入数据，也不生成默认 5% 政策。最多接受 100 个唯一订单；实际付款还要求该订单原生创建审计和有效的精确 admission。无此显式装配时，原行为保持。

正式汇聚收款另在原接纳事务中通过 `createNativePaymentDistributionStore` 冻结分销依据，不使用本地100单名单。该付款接线不代表正式政策/关系维护、结算后计提或到期入账已启用；本候选增加独立NATIVE装配，但政策、注册及账务的前向结构和同版验收仍未闭合，默认不启用。

把返回的 `auth` 传入 `createApp` 的认证选项后，新注册、付款冻结、本人条款/佣金读与结算提交后计提使用现有模块。新原生钱包初始化仍需数据库端准入与同事务 INSERT 证明；缺失来源不能冒充零钱包。可选提现 binding 必须绑定 resource、subject、admission、destination、intent、payoutKey。

结算确认及管理员复核提交后从原 posting 幂等计提 PENDING 佣金。回调异常单独记为 UNKNOWN，不改变已提交的结算事实；恢复依据是原订单的不可变 posting、冻结 basis 和唯一经济根。维护方可先 `earnings.readOrder(pool, orderId)` 只读核原根与原转换回执，再对同一原来源恢复 `accrue`。不得换业务键、回填旧付款或把回滚请求当作写入未发生的证明。

到期维护方显式调用 `earnings.settleDue(pool, limit, requestId)`，limit 为 1–100。它只选该订单名单内、DB 时钟已到期的 PENDING 根，每个根在原锁、版本、到期复核和独立事务内 SETTLE。异常返回 UNKNOWN 并停止本批，`notAttempted` 标出未执行数；先读原回执，再安排恢复。默认不启动后台循环，也不在 GET 中驱动资金写入。只有 SETTLE 的真实分录才能把 pending 转到可用余额。

本地受控测试策略使用最低 200 分、银行固定费 100 分、支付码 2% HALF_UP，日额度按北京时间计算；这些是测试参数，不是正式经营费率或正式提现上下限。报价/预留仍须核定钱包覆盖和余额、有效准入、精确目标、钱包版本及未清分销追偿。此装配为 LOCAL_CONTROLLED，SQL 持久化的失败/超时场景不代表银行或支付码到账；全局 withdrawable 保持 UNKNOWN。正式银行卡渠道适配已提供，须另核当前身份、有效政策、商户产品与原目标规则，不沿用这些测试参数开放出款。

外部收款、退款及银行卡代付只对接国内[汇聚支付 JoinPay](https://www.joinpay.com/)。旧银行卡提现使用单笔代付；旧微信/支付宝收款码分支是后台人工确认记录，不能认作汇聚自动出款。旧代码的非生产配置会把代付金额改为 0.01 元，但仍请求生产地址，不能作为沙盒运行方式。新适配保留原请求号、金额、商户作用域、验签、幂等和原号查单；收款成功、退款应付、退款到账及代付终态分别核定，不复制旧代码把请求返回直接当到账的行为。

汇聚产品与联调必须按[官方凭据边界](https://github.com/Joinpay-Official/hj-payment-skills/blob/main/hj-joinpay-pay-shared-base/governance/credential-boundary.md)及实际商户开通范围核定，不能只凭域名判断为无资金沙盒。公共技术测试账号只支持收款签名验证，不能外推退款、代付、压测或真实收款许可。本地受控结果不是汇聚或银行到账验收。

## 管理读取与统一政策准入

分销管理将当前政策、订单佣金和邀请关系分开读取，均按实际对象权限与来源核对。计提事件、入账事件和回退记录不相加成重复收益；可入账时点不称为已结算日期。历史观察不冒充当前钱包或渠道到账。

`distribution.policy.publish` 冻结原政策ID、revision、digest、明确改动和理由；审批人与申请人分离，执行前再次核权限、原头CAS及幂等。新申请和执行均需要显式写准入及版本2的结构标记，读scope不授予写入；前向结构尚未安装时保持不可提交，不回退直接改政策。现有v1读取与冻结计算继续兼容。正式结构、实际身份与写准入应分别验收，源码存在不表示经营写入已开放。

用户本人条款仅显式 `projectionVersion=2` 才消费统一政策投影；收益计算扩展使用 `calculationVersion=2`。旧v1不悄悄添加字段，也不以空等级冒充未知后继续使用新规则。

## 正式 NATIVE 装配与维护

正式进程不再按测试库名、端口或未满 100 单名单挂载分销。`loadNativeDistributionRuntime` 只由显式 `DISTRIBUTION_NATIVE_ENABLED=true` 开启，并要求真实的汇聚正式准入（同一 database/runtimeUser）、Authentication 打开、`provider=real`；它只从该准入构造 NATIVE 政策 scope 与收益 store，不创建政策、比例、身份或准入。缺失接管、上下文不符或本地 `createLocalDistributionRuntime` 同时存在时拒绝装配。LOCAL_CONTROLLED 工厂保留给测试，NATIVE 与 LOCAL 的支付依据、政策 scope、账本 `details.scope`、冲回来源 scope 各自标记，不能互相别名。

维护命令走 `GET/POST /api/v1/admin/distribution/maintenance`：GET `/accruals?limit=` 只读检查已过账但缺失/冲突的 Original 经济根；POST `/accruals/replay` 以 1–100 个原订单重放同一 `accrue`；POST `/due-settlements` 以 1–100 上界执行 `settleDue`。三者都要求 `personal.distribution.policy.manage`、有效管理员和游戏对象范围；不接受全表调度器，也不在页面 GET 中写钱。GET 只报告 `MISSING/PARTIAL/CONFLICT/SKIPPED/UNKNOWN`，不代替修复。

场景口径：未付款取消没有冻结 basis 或 posting，不计佣；未开租终止在存在正额佣金时 fail-closed（现有 `earning_count` 校验），不先 VOID 绕过；正常结算退款只核销租客应退责任，不改变 posting 的平台贡献，因此不重复扣佣；结算后退款/更正若需要部分冲回，当前合同只支持“同一原根全额 REVOKE/RECOVER”，部分比例更正尚未定义，不能以任意全额 REVOKE 代替。已入账追偿继续走原 `rental_referral_reversal_source` → `REVOKE`（余额不足转 `RECOVERY_REQUIRED`）→ 原来源 `RECOVER`，冲回声明仍只允许维护 owner 角色执行。

v2 UNIFORM 的数据库前向结构、支付依据推导、NATIVE 账本/冲回 scope 尚未安装：见[未编号迁移候选](../../apps/api/migrations/candidates/distribution-business-closure-1/README.md)（Root编号前不进入正式journal，真实业务验收另列）。在这些结构安装并验收前，正式 v2 政策提交、NATIVE basis 冻结、NATIVE 计提/冲回都应保持不可用，不能以源码存在视为经营开放。

## 旧关系与旧佣金承接

旧 `inviter_id` 迁为 `INVITER`，旧直属上级迁为 `DISTRIBUTION_LEADER`，两者可同一人但类型不合并；`second_leader`/`third_leader` 只作历史对照，不生成新计佣边。旧已结算佣金只随钱包期初承接并标记已覆盖，不再按新政策计提；旧已失效（VOID/失效状态）保持只读，不复活；旧待结算必须逐笔核父单仍完成、原受益人/原比例/原基数与父单证据，再按原责任显式入账，不能用切换日重算到期或新比例追补。旧等级和 5/10/20/30 比例仅作历史显示，不能成为新政策默认值。旧聚合在其最新源副本导入并逐域对账前只是观察，不是当前钱包或渠道到账事实。

| 旧源 | 目标 | 规则 |
| --- | --- | --- |
| `la_user.inviter_id` | `invitation_relation(INVITER, source_type=LEGACY_MYSQL)` | 只表达注册来源；与分销上级分开，同人也不合并 |
| `la_user.first_leader` | `invitation_relation(DISTRIBUTION_LEADER)` | 唯一计佣边；原父非零但未映射时拒绝，不补建 |
| `second_leader`/`third_leader`/`ancestor_relation` | 不迁计佣边 | 只留历史对照；新平台一层 |
| `la_distribution.level_id` | `distribution_participant.level_code` | 仅历史等级；v2 不读等级 |
| `la_distribution.is_freeze`/`is_distribution`/`is_delete` | `commission_frozen`/`eligibility` | 冻结、资格和删除分别映射；未知不冒充资格 |
| `la_distribution_order.status=2` | `personal_finance_observation(HISTORICAL_DISTRIBUTION)` + 期初 covered | 已入账只承接一次；不再新增佣金，不按新比例重算 |
| `status=1` 待结 | 原责任逐笔核验后显式入账 | 需父单完成、原受益人/比例/基数/原到期证据；不进 `settleDue` 的新 PENDING |
| `status=3` 失效 | 只读历史 | 不复活、不补扣快照中未入账的失效行 |
| 原 `ratio`/`level` 快照 | 原行保留 | 历史显示；不按当前政策倒算 |

对账以最新源副本为准：逐域核对源行数/金额、已映射主体、关系闭包、已覆盖期初和未结责任；同一来源键不重复导入。对账前旧聚合只是观察。关系导入复用 `importReviewedLegacyInvitations`/`recoverReviewedLegacyInvitations`，佣金观察与期初复用 `prepareFrozenFinanceObservation`/`prepareFrozenFinanceHistory`，不另写迁移框架。

## v2/NATIVE 前向合同与维护恢复

v2/NATIVE 结构必须作为一个前向包安装：政策 v2 形状/guard、按 scope 的 head 锁、UNIFORM 支付依据推导、participant v1/v2 约束与 trigger、NATIVE 分录/冲回 scope、`distribution_policy_contract_version()=2`。三份未编号候选须由 Root 编号并在同一迁移事务应用；函数标记只在同包成功后存在，runtime EXECUTE 由既有 `configureDistributionFinancialPrivileges` 在 ACL 事务授予并读回。v2 `levels=[]`、`level_code=null` 合法；v2 disabled 只停止新首款计佣，注册资格仍为 `ELIGIBLE`，旧 v1 的 disabled→`INELIGIBLE` 语义不变。注册必须引用其 scope 的当前不可变 head，旧头或伪造新生 proof 拒绝；后续仅更新上级关系知识/版本时保留原注册政策，实际更换政策来源才重新校验当前头。

空 NATIVE 政策的首版由显式 `distribution-policy-initialize.v1` 审批发起：完整填写两类比例、租赁方式、最低计提、结算期限和原因，经独立 Boss 审批后在同一执行事务插入 revision 1 与 head。它不接受伪造的 `expectedPolicyId`/正 revision，不灌 5% 或旧等级。Admin 政策页在 `knowledge=UNKNOWN` 且结构/审批就绪时显示首版表单；未就绪保持只读。

漏计提发现按 `(posted_at,id)` 稳定 keyset 向旧分页，返回 `nextCursor`；管理端必须能继续检查更早记录。COMPLETE/SKIPPED/UNKNOWN/CONFLICT 均占扫描页但不隐藏旧 MISSING；没有下一页不等于没有漏计提，新单需从最新重查。到期与重放命令以 `requestId` 作为持久批次键，复用 `zzsh_supply.idempotency_record` 固定原 earningIds/versions 或 orderIds、参数指纹与回执：同键同参只恢复原计划，同键换参 409，UNKNOWN 不换键重发；每根仍在独立事务按原根幂等执行，外层批次回执不承诺回滚已提交的内层钱。`GET /maintenance/orders/:orderId` 按游戏范围读取；`GET /maintenance/batches/:key` 成功读取为 HTTP 200，原执行状态保留在 `httpStatus`。批次读取的逐对象范围复核和跨 operation 区分仍需补齐，不能当作完整受权恢复。管理端当前页保留原 key/body、阻止未决批次被新命令替换；页面重载后的持久恢复仍未实现。

管理员维护的每笔实际资金事务在事务内重新核管理员安全/会话、当前 permission 和订单游戏范围，审计记录发起管理员与批次；结算后的内部 system callback 保持原系统身份。可选到期 worker 仅在显式 `DISTRIBUTION_DUE_WORKER_ENABLED=true` 且已装配 NATIVE 时启动，固定 worker 锁、间隔 60–3600 秒、批量 1–100；返回 UNKNOWN 时仅在本进程内停止；异常、重启后的原批次恢复及失锁接管尚未闭合。worker 默认关闭，这些恢复门槛未完成前不得作为可靠的自动入账装配，不能把按钮或无人监管循环冒充已入账。

全额冲回采用 `distribution.earning.reverse` 独立审批：payload 只允许原 earning/order/满额并显式 `full:true`；审批执行只授权、不写钱。owner 维护工具按原始 admission digest 与审批状态准备 `rental_referral_reversal_source`，runtime 不获声明写权；但工具尚未强制成功的授权执行回执，也未耐久关联原审批，审批页的原根/金额摘要亦需补齐。满足这些合同前不得作为正式冲回声明入口；当前 `--execute` 在读取凭据和连接前以 `REVERSAL_EXECUTION_RECEIPT_CONTRACT_UNAVAILABLE` 拒绝，只保留 PLAN。Admin 转换按原 source 执行 REVOKE/RECOVER，不接受任意客户端金额。部分更正的最小合同为：原 posting 与基准绑定、金额不超过原根且累计不超过原额、与计提相同的 HALF_UP 舍入、独立审批和可追溯回执；当前运行时只接受全额，部分请求明确 `PARTIAL_CORRECTION_CONTRACT_UNAVAILABLE`，不能用全额 REVOKE 代替。

本人邀请/条款读取使用装配的 policy scope 返回 `LOCAL_CONTROLLED` 或 `NATIVE`；当前 Web 解析两种 scope，旧客户端版本须另核兼容，不能从字段未变化推定其接受新增值。NATIVE 自助绑定写 `NATIVE_SELF_BIND`，不伪装为本地来源。

候选 PG 验收器仍有身份/OID绑定、未提交 DDL 跨连接读取和收尾证据限制；默认 plan 也会连接数据库，不能作为零秘密/零连接预检。修复这些入口后才可在明确回归资源中应用三份候选并验证/回滚，不能以当前成功输出宣告 runtime ACL 或完整资金验收。无完整 fixture 时必须保持 INCOMPLETE。完整 Native 付款→posting→计提→SETTLE→全额撤销/不足追偿/恢复的真实 fixture 尚须在 Root 指定回归边界执行；该缺口与真实渠道/页面分别列示。
