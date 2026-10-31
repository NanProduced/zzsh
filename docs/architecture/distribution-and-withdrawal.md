# 分销与本地提现

支付、退款、真实银行卡提现及新旧资金承接的共同口径见[支付与资金领域规格](payments-and-funds.md)。本页维护分销计算、显式准入装配与本地受控边界，不代替正式渠道准入。

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

v2 UNIFORM 的数据库前向结构、支付依据推导、NATIVE 账本/冲回 scope 尚未安装：源码已登记0121–0123，见[前向迁移与验收合同](../../apps/api/migrations/candidates/distribution-business-closure-1/README.md)（已进入源码journal，实库安装、ACL与业务验收仍未完成）。在这些结构安装并验收前，正式 v2 政策提交、NATIVE basis 冻结、NATIVE 计提/冲回都应保持不可用，不能以源码存在视为经营开放。

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

v2/NATIVE 结构必须作为一个前向包安装：政策 v2 形状/guard、按 scope 的 head 锁、UNIFORM 支付依据推导、participant v1/v2 约束与 trigger、NATIVE 分录/冲回 scope、`distribution_policy_contract_version()=2`。0121–0123须在同一迁移事务应用；函数标记只在同包成功后存在，runtime EXECUTE由公共`applyRuntimePrivileges`步骤授予，随后`configureDistributionFinancialPrivileges`收敛财务权限；有效权限仍须实库读回。v2 `levels=[]`、`level_code=null` 合法；v2 disabled 只停止新首款计佣，注册资格仍为 `ELIGIBLE`，旧 v1 的 disabled→`INELIGIBLE` 语义不变。注册必须引用其 scope 的当前不可变 head，旧头或伪造新生 proof 拒绝；后续仅更新上级关系知识/版本时保留原注册政策，实际更换政策来源才重新校验当前头。

空 NATIVE 政策的首版由显式 `distribution-policy-initialize.v1` 审批发起：完整填写两类比例、租赁方式、最低计提、结算期限和原因，经独立 Boss 审批后在同一执行事务插入 revision 1 与 head。它不接受伪造的 `expectedPolicyId`/正 revision，不灌 5% 或旧等级。Admin 政策页在 `knowledge=UNKNOWN` 且结构/审批就绪时显示首版表单；未就绪保持只读。首版初始化载荷当前未冻结LOCAL/NATIVE scope；有待决初始化申请时不得切换装配范围，跨scope须先处置旧申请并重新发起。此限制未作运行时完整验收，不能据首版表单存在就开放正式政策。

漏计提发现按 `(posted_at,id)` 稳定 keyset 向旧分页，返回 `nextCursor`；管理端必须能继续检查更早记录。COMPLETE/SKIPPED/UNKNOWN/CONFLICT 均占扫描页但不隐藏旧 MISSING；没有下一页不等于没有漏计提，新单需从最新重查。到期与重放命令共用一个维护键空间（`[actor, userId, 'distribution.maintenance', null]` + `requestId`），持久保存原命令快照 `command{limit|orderIds,games}`、原 earningIds/versions 或 orderIds、参数指纹与状态回执：指纹包含 operation，因此同一键换 operation 或换参数一律 409，读取也不会挑到另一操作的批次。计划与执行在同一次持锁内完成，不留重规划窗口；每根仍是该连接上的独立事务，外层批次回执不承诺回滚已提交的内层钱。若 ROLLBACK 未确认，立即停止该连接上的回执保存与后续事务并销毁连接；原计划保留，另连接只按原键恢复，不能借下一次 COMMIT 结束未知旧事务。`POST` 走原命令、`resumeBatch` 只按原键读原计划（不重算 limit、不重挑下一批），UNKNOWN 后必须走这两条路之一。`GET /maintenance/orders/:orderId` 与 `GET /maintenance/batches/:key` 成功读取均为 HTTP 200，原执行状态保留在 `httpStatus`；批次读取在同一事务内按当前游戏范围逐个复核计划中的订单/收益根，范围被收回即 `FORBIDDEN`，不返回旧计划。批次回执的 `command` 允许页面在重载后用同一 `requestId` 精确重建原 body。

管理员维护的每笔实际资金事务在事务内重新核管理员安全/会话、当前 permission 和订单游戏范围，审计记录发起管理员与批次；结算后的内部 system callback 保持原系统身份。可选到期 worker 仅在显式 `DISTRIBUTION_DUE_WORKER_ENABLED=true` 且已装配 NATIVE 时启动，间隔 60–3600 秒、批量 1–100、worker 锁 806007。每轮先确认自己的数据库会话仍持有该锁（按 int8 advisory 键精确读 `pg_locks`），失锁或会话消失即停止驱动且不启动新钱事务；未持锁的实例每轮重试接管，不靠重启。资金事务就跑在持锁会话上，因此执行权与账务写入同生同灭，不只是定时器或内存布尔。每轮先恢复自己已持久但未完成的批次（`findUnfinishedBatch`→`resumeBatch`），没有未完批次才用新键计划；异常（含可能发生在提交之后的异常）不换键、不重挑下一批。失锁/断线须归还并销毁不可用的池连接，移除监听器；不能只清空内存引用。worker 默认关闭，且不承诺跨实例负载调度。

全额冲回采用 `distribution.earning.reverse` 独立审批：payload 只允许原 earning/order/满额并显式 `full:true`；审批执行只授权、不写钱，返回 `DISTRIBUTION_REVERSAL_AUTHORIZED` 且 `result_detail` 为原 earningId。owner 声明工具只消费已核清的授权：同一事务内 `FOR UPDATE` 锁原请求与执行记录，要求请求为 `EXECUTED`、执行记录为 `SUCCEEDED` 且结果码/原 earning 精确匹配、payload 摘要未变、申请人与审批人不同、审批人当时仍为 `ACTIVE` 的 Boss、原 NATIVE admission digest 与订单绑定；`APPROVED` 本身不再是资金依据。声明写入 `rental_referral_reversal_source` 时同事务写审计，把 sourceId、approvalRequestId、payload hash、执行回执 id、原根/订单/满额/basis/posting/受益角色耐久绑定，因此可从声明追到实际消费的审批；原 source 已存在时须核对其成功声明审计中的原 approvalRequestId、payloadHash、执行回执及完整经济根/admission 绑定，才能只读回放（即使根后来转为 REVOKED/RECOVERY_REQUIRED）；缺审计或换另一份审批必须拒绝。管理员安全行先于收益根加锁。默认 PLAN 是纯离线检查：只读密封授权文件，不读凭据、不开连接；`--execute` 才要求 owner 身份/资源核对。冲回的对象范围一律由服务器派生：earning→rental_order.game_id，绝不接受客户端提供的 gameId。申请创建、Boss 决定候选/可用动作与执行授权共用同一个判据（同一订单同一判据）：非 Boss 管理员需当前游戏范围覆盖该订单，收回范围后既不能再读出原金额/受益人，也不能生成授权执行回执；Boss 与 ALL_GAMES 按既有合同保持全局；原根不可解析时按越权失败关闭，不视为全局。审批详情对 reverse 走独立白名单投影（原 earning/order、受益角色与受益人、原额、full、basis/posting/政策版本、请求与原根摘要、授权回执状态），不套政策变更投影，也不以可自由填写的 summary 代替；无分销读取权限仍拒绝。Admin 转换按原 source 执行 REVOKE/RECOVER，不接受任意客户端金额。部分更正的最小合同为：原 posting 与基准绑定、金额不超过原根且累计不超过原额、与计提相同的 HALF_UP 舍入、独立审批和可追溯回执；当前运行时只接受全额，部分请求明确 `PARTIAL_CORRECTION_CONTRACT_UNAVAILABLE`，不能用全额 REVOKE 代替。

本人邀请/条款读取使用装配的 policy scope 返回 `LOCAL_CONTROLLED` 或 `NATIVE`；当前 Web 解析两种 scope，旧客户端版本须另核兼容，不能从字段未变化推定其接受新增值。NATIVE 自助绑定写 `NATIVE_SELF_BIND`，不伪装为本地来源。

`scripts/distribution-pg-native-acceptance.mjs` 是唯一验收宿主，模式按实际副作用命名，整包为 rollback-only 装配：PLAN 只做静态检查（配置摘要、中央 state、逐候选字节 SHA、原生合同字段），回执显式 `readsSecrets:false, connections:0`；缺任意外部输入时 PLAN 直接列出精确字段与格式，`--full-native/--restore-regression` 在读凭据、连库、加载 dist 之前以 `NATIVE_CONTRACT_INCOMPLETE` 退出 2，不交一个"填了也必失败"的宿主。`--verify-identity` 核数据库身份、`pg_roles` 实查的角色名+OID、非 super/bypass/createdb/inherit、runtime 不拥有 `zzsh_order` 对象（必须在目标库查询，维护库答复不了）、`pg_has_role` 阻止 runtime 成为 owner/migration，并要求登记 migration 会话确实是 runtime 成员（否则 `RUNTIME_SET_ROLE_UNAVAILABLE`，不临时授予成员关系）；外来 client backend 数必须恰为本宿主自己一条。`--execute` 在一个迁移事务内应用0121–0123 后调用共用的 `applyRuntimePrivileges` 与 `configureDistributionFinancialPrivileges`（marker 的 runtime EXECUTE 只由这条公共路径授予），再读 `has_function_privilege` 有效权限、`SET LOCAL ROLE` 到登记 runtime 做正负断言（权限负例走 SAVEPOINT，事务保持可用后 `RESET ROLE`），最后 `SET CONSTRAINTS ALL IMMEDIATE` + ROLLBACK 并逐项比较函数体/约束定义/head/行数。`--full-native` 不先回滚结构：同一被批准装配内按封签阶段顺序跑真实编译应用资金体 `accrueOn/transitionOn`（钱以 runtime 身份、声明以表 owner 身份，顺序为 fixture→计提→重复计提幂等→未到期拒绝→SETTLE→全额 REVOKE 充足/不足→同原 source RECOVER），每阶段先写 journal 再进入下一阶段，失败保留原键与 `UNKNOWN` 阶段，且全程不 COMMIT，因此不存在"已提交对象丢失"；回执固定标注 `assembly:"rollback-only"`。不可变账本不用 DELETE 凑清零：`--restore-regression` 只读核残留并把任何残留连原键交给登记的受控复位（`npm run test:db:reset -w @zzsh/api`），宿主自身绝不 DROP/ALTER/TRUNCATE/禁 trigger。收尾顺序为先结束工作连接、再释放维护锁、最后结束 owner 连接，未确认即 `CLEANUP_UNKNOWN` 并把结果降级为 pass:false 且退出 1。源码登记不代替实库验收；前向结构、有效ACL、并发锁与资金链须在唯一登记回归资源与受限凭据引用上集中验证。



### Rollback-only 验收的输入与证据边界

审批恢复装配必须使用服务器派生的原订单 gameId，不能因 payload 不带 gameId 而改用中性全范围。范围被收回后原回执也须拒绝；合法原范围可只读恢复，不创建新授权。

验收 fixture 只接受被封签的纯 DML，禁止事务控制/DDL；原生数据在 runtime 身份、同一父事务内建立，结构和声明仍用对应维护身份。每次调用 On 资金体先恢复 DEFERRED，原资金体执行 IMMEDIATE 闭包，错误先回保存点再复原角色，不能让 RESET ROLE 的25P02覆盖原错误。该事务/约束合同仍需真实PG验证，SQL形状校验不是任意SQL安全沙箱。

资金不足到 RECOVER 之间必须有明确封签的合成 fundingSql，通过既有合法账本补足可用额；同一原债/原声明、版本与责任金额保持不变。缺补款、换债/换源、补款偷做终定、RECOVER仅重放不能算新债闭环。期满与未到期使用合法独立样本，不改到期/种子。所有模拟操作在同一事务回滚，不证明真实充值或渠道到账。

执行日志限于仓库tmp的已核路径，逐阶段flush，失败停止并回滚；错误日志再失败仍保留原主错误。原生earning键纳入封签输入并核实际输出，残留检查使用完整原计划队列，不把空列表通过当清理完成；仍不删除不可变账务证据。配置文档使用已核字节内联装配，避免绝对秘密文件路径和二次读漂移。身份模式仅目录/READ ONLY角色能力核验，不执行候选或政策。缺少真实fixture、角色SET能力或精确资源绑定时仍不可宣称PG验收就绪。
