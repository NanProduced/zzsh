# 旧平台数据转换与迁移脚本

本目录同时包含离线规划工具和真实本地迁移入口，不能将两者混为一谈。`legacy-rehearsal.mjs` 不连库、不执行写入；`capture-local-source.mjs` 可只读提取源库；`load-local-dataset.mjs` 和初始化入口在显式执行、输入与资源核验通过后会写目标库。真实数据、凭据、执行参数、检查点和结果均在受限目录，不能提交 Git。

## 先看执行顺序

转换核心复用 `apps/api/src/legacy-load/`、`supply/legacy-*`、`order/legacy-*` 和 `finance/legacy-*` 中已有的正式 planner / writer。脚本负责源提取、组合、阶段编排和恢复，不另写一套价格或账务规则。

1. **冻结源和目标版本**：绑定源快照、物理表列、源截点、代码与构建摘要；独立创建并核验目标资源。源库当前的行数不能套用另一份旧快照。

新一轮本机源可由 `prepare-local-mysql-source.mjs` 恢复：先以 `--prepare` 绑定备份字节摘要、导出开始和结束时间及本机 MySQL 镜像，再以 `--execute` 使用封存计划创建专用无网络容器和数据卷。MySQL 导入流逐字节核摘要，客户端报错或识别到警告时保留现场并停止，不自动重试；成功后核必要源表并启用 `super_read_only`。客户端凭据放在容器内存目录，源备份和回执仍须受限保存。只读状态、容器和备份摘要在采集前后重核，结束后按资源登记清理。导出结束时间不证明旧站已停写或备份具有跨表一致性，须另行确认；此入口尚未覆盖完整转换和服务器端部署。

`run-local-source-workflow.mjs --execute --input <受限输入> --input-sha <摘要>` 可依次运行上述准备、恢复、完整采集、资金补采和退款补采，并校验来源与工具版本；受限输入 `schema` 为 `zzsh.local-source-workflow.v1`，包含 `suffix`、`imageId`、`dump`、UTC `exportStartedAt`/`cutoff` 及新建的 `out` 路径。各阶段记录实际耗时和结果，失败保留原资源与回执；`SOURCE_CAPTURED_DATASET_NOT_PREPARED` 只表示来源阶段完成，不表示目标已初始化、数据已转换或整轮已验收。

新源的基础采集和资金、退款补采使用 `capture-local-source.mjs --source-origin-v2 <来源绑定> --source-origin-sha <摘要>`，轮次输入同时携带相同来源绑定；源文件、采集结果、补采或已封存工具不匹配时停止。旧轮已封存输入继续沿原合同验证，不将旧登记补写为新恢复证明。
2. **安装新平台结构及基础资料**：从 `apps/api/migrations/initial/` 安装明确基线，再执行对应后续迁移和 runtime ACL；首次创建新管理员，再初始化游戏、目录、皮肤词条、价目和规则。旧轮法律文书入口要求有效管理员会话；新轮不得以该入口冒充不依赖 Boss 的首次初始化。旧管理员、会话与 IM 身份不迁入。

新库业务包必须使用验证通过的 `OWNER_KIND_V2` 目录，禁止把已退役的皮肤分类表或近战类型数据随旧版包重新写入；旧版包仍可只读验证供溯源。新一轮回执必须绑定当前目录模型，不能复用缺少模型证明的旧初始化回执。

当前租赁业务包验证会检查游戏服务、当前封存规则、资源标准价目、租期与哈夫币规则映射，以及已配置的包赔条款；初始化回执绑定检查器及目标配置摘要，轮次独立读回分别用迁移和 runtime 角色复核该摘要。该检查仅覆盖列出的配置读取，不等于全部 runtime 权限、API 路由或页面已验收。
3. **抽取和离线转换**：`capture-local-source.mjs` → `prepare-local-dataset.mjs`。迁入完整用户；账号范围为采集时正在上架的账号，以及有成功付款记录的订单所关联账号；订单仅保留旧付款记录 `order_type=1` 且 `pay_is=1` 的订单，未成功付款订单不迁。保留原来源三元组、关联、金额、状态、时间与隔离原因；旧站付款标记不等同独立核实汇聚到账。

源包和转换包的 JSONL 以 LF 分隔记录；读取兼容文本内的 U+2028/U+2029，并对实际文件字节核 SHA，不能把内容字符当换行或改写原始证据。范围核验边解析边计算所消费字节的摘要，之后再次核文件；只有两次核对通过后才能使用结果。

若成功付款记录存在而订单自身标为未付，订单仍在选入范围，但当前订单读模型会保留该矛盾：执行入口在连接目标或写入前停止并报告待核，不能静默按未付展示或改写源事实。反向的“订单标已付但没有成功付款记录”按上述选择政策排除，并单独计数；是否渠道到账仍需渠道凭证核对。

新轮次的 `SELECTED_BUSINESS_SCOPE` 在轮次校验和执行前独立重读封存源用户、账号、订单及付款记录，核对用户全集、已付订单和在架/关联账号的选择，以及各自准备与隔离分区；对有历史快照的账号，还逐项核对原号主、状态、编号、租金、物资预付、押金、租期及日耗。源文件摘要变化、账号状态或租赁付款标记不在旧站已知范围、成功付款找不到订单或保留订单找不到账号时停止。已明确标记未成功的付款仍按既定政策排除，不能把未知标记直接当作未付款。核心导入器直接执行时也会复核，结果随轮次回执或检查点保存。该检查只覆盖所列来源和准备包字段，不证明目标已导入、全部金额正确或渠道到账；其他领域仍需各自独立读回。

退款来源同时检查主体和订单关联：准备迁入用户的租赁退款必须指向本轮保留且可写入的订单；无法关联或来源类型超出现有处理范围时先停止核实，例如旧站另有充值退款类型，不将其误认为租赁退款或静默丢弃。即使原订单 ID 可找到，退款主体或非空订单号与原单不一致也只保留为关联待核，并在回执单列；新准备包明确封存 `legacy-refund-relationship-v2`，两边订单号均为空也保持待核，旧封存包恢复沿用原判定以保留指纹。源用户已隔离的退款也单列数量，不能声称已导入。具体退款状态和渠道到账仍由资金读回确认。

轮次结果的 `COMPLETE` 只覆盖其列出的数据集和会员成长阶段。分销政策与资格、信用、在架接管、旧绑卡、备份恢复及页面验收仍需各自同源、同目标的证据；轮次回执和检查输出明确标记这些事项未由该入口评估，不把此结果当作可部署结论。

新版轮次在核心写入前用同一来源的分销配置、等级与同版 API 校验器预检政策；等待天数依旧站实际规则从来源计算，比例由 API 做等值十进制规范化，原始来源值仍保留。配置缺失、源摘要漂移或政策不被 API 接受时停止。预检只证明来源可构造政策，实际发布、资格承接和目标读回仍是后续必需阶段；旧轮封存的政策及恢复合同保持原样。

`run-local-distribution-workflow.mjs` 将分销来源准备、政策初始化、资格承接及读回按固定顺序串联，空资格集合仅进行读回。执行前须绑定同轮来源、目标、构建与核心读回，逐阶段保存原始意图和回执；出现未知结果时停止，不能自动换键重试。该入口当前仍受本机目标、会话与维护锁约束，必须完成隔离全流程及恢复验证后才能用于下一轮；它不包含其他迁移阶段，也不能作为整轮完成证明。

在架接管源计划会完整扫描本次冻结的旧账号文件，并在扫描前后校验文件摘要；原状态在架且未删除的集合必须与本次已审名单及各行来源摘要完全一致。新增、遗漏、重复、状态未知或内容变化均停止，不能仅凭上一轮的名单决定接管范围。第七轮专用皮肤/报价审计仍有固定数量和旧源绑定，新数据不能直接复用；空在架集合的专项接管尚未完整接线。

新的完整 MySQL 源采集在同一只读一致性事务中采集 `la_sg_game.profit_dot` 和 `la_system_config` 的 `game/profitFirstDot`，缺少物理列立即停止；数据集准备核对相应捕获标识、游戏与配置记录唯一性，并复用旧报价整数解析器校验原值。该证据只代表 MySQL 快照，Redis 实际生效值、报价装配与目标结果仍需独立核实；旧封存源若未采集则标记 `NOT_CAPTURED_IN_BASE`，不能据此补造数据。

新轮次同时校验余额期初的用户分母和金额分区，在 `externalReadiness.storedOpening` 中单列需核对人数及对应旧余额。即使待核对用户的旧余额为零，也不因此标记为已承接；相关用户需按原始记录和资金合同继续核实。
4. **迁入关系骨架**：`load-local-dataset.mjs --core-only` 按用户 → 游戏账号及号主 → 订单及双方/账号关联执行。账号必须先有号主，订单必须先有账号、号主和租客。
5. **迁入资金及在途责任**：不带 `--core-only` 复用同一检查点，跳过已完成核心阶段，承接邀请事实、收益/提现/佣金/付款/退款记录、退款尝试、各域覆盖证明，以及旧单续办、退款责任和待结佣金。旧平台的上架保证金在切换前结清，不迁移或初始化为新平台保证金。旧付款记录不冒充新的渠道支付成功。
6. **建立钱包期初**：`local-opening-proof.mjs` 准备原余额与经济来源证明，再由 `load-local-dataset.mjs --import-openings` 写入。先核身份、资金记录和覆盖，再接纳原余额；不将流水重算净和，不重复支付已结佣金。
7. **补齐账号可读内容**：`--enrich-display` 追加账号展示属性，`--enrich-holdings` 将旧皮肤字符串映射到已确认的新词条。二者依赖账号和目录，并不依赖钱包期初；同一检查点内仍串行执行。无法完整映射的集合保留原因，不能写成空集合。
8. **读回对账并接入服务**：`readback-local-dataset.mjs` 核对关系、逐项金额、记录集合、状态、来源摘要、责任与余额。数据库对账后，才切换同版 API/BFF/页面，验证连续时间查询和后续操作。字段来源保留在证据层，不要求用户区分升级前后的记录。

旧本地演练的管理员初始化会自动完成改密和 TOTP 绑定；`--initialize-admins` 对 NEXT 目标在读取凭据或发起请求前拒绝。新目标的 `initialize-first-administrators.mjs` 先以 `--prepare` 绑定完成的结构回执和同版构建，生成受限的四份初始密码；再以 `--execute` 创建两个固定 Boss 和两个全游戏运营账号，提交前及独立读回均按封存的尾链证明核对完整角色、权限与审批模板种子，发现漂移即停止；独立读回通过后才交付密码。四人自行改密并绑定 TOTP，不代为登录；已有库升级不得使用。依赖、维护锁、写连接及目标身份在创建 claim 前检查；前置失败回执只证明本次调用未写目标，不证明数据库为空。当该回执确认连接与锁收尾、当前原目录仍无 claim/result 时，可修复前置条件后用同一准备文件和密码再次执行。若已有 claim、提交或本机回执结果不明，保留原准备目录和密码文件，以 `--readback` 按同一请求只读核对，不得重建或换密码；旧版已生成的 claim 不因空读回自动释放。此入口目前限已登记的本地新目标，完整新装、服务器适配和普通发版保护仍需实测。

旧本地演练的会员政策通过 `initialize-local-policy.mjs` 走新管理员申请、审批与执行；该旧入口对 NEXT 目标在读取会话或发起请求前拒绝。NEXT 的首版会员政策及法律文书仍须接入已确认配置，不能把测试折扣或旧审批当作经营政策。信用初始化复用 `apps/api/src/credit/credit-initialization-cli.ts` 及其批处理；它们属于新平台初始化，不复制旧管理员或凭空制造旧成长消费。历史成长补齐仍需原消费/退款及覆盖证明，不能把缺证当作零。

新轮次成长输入可使用 `packageLayout=PACKED_V2`：每 1,000 个用户原始包按序合入一个文件，每个包仍保留原字节、摘要和原幂等键，并核对分包布局及整体摘要。写入前检查全部包，写入完成后重新打开并复核；准备、续跑与原键恢复均绑定 PostgreSQL 实例身份。旧 `v1` 包和其恢复凭据保持原格式。该布局只减少文件数量，不改变逐用户事务或已有成长来源规则。

新轮次可同时使用 `approvalLayout=INLINE_INTENT_V1`：原审批字节、摘要和原键在事务前写入同一份受限意图日志并刷盘，不再逐用户创建审批文件；最后一次确认后再次刷盘并逐项核验，轮次检查会重核日志及各阶段回执摘要。已收到全部提交确认但日志刷盘或核验失败时，结果为 `ALL_COMMITS_ACK_LOG_REVIEW_REQUIRED`，不能当作未写入重跑。该日志含受限身份和业务追溯资料，必须保留；旧格式及恢复输入保持原样。意外断进程后不能只凭旧摘要自动重发，须先确认原进程、锁和原键状态；硬中断的自动恢复仍需完整演练。

成长写入提交前会核对维护连接仍持有本实例的登记锁；锁失效时当前事务回滚并保留原意图。旧轮仅跨连接检查，不能消除检查后维护锁立即断开的窗口；新目标候选还在实际写连接持有共同目标锁。其他阶段仍须完成相同保护及完整并发、恢复验证。

新版成长回执按事务、授权、幂等、覆盖、贡献、审计、目标检查及其他类别记录查询次数，只保存分类和数量，不记录 SQL 或参数。分类用于定位下一轮的重复查询，包含阶段前后核验且不代表各类别耗时。

成长覆盖写入将执行键和事实指纹的预查合并为一次查询，仍使用现有唯一索引；两种匹配同时存在时保留执行键优先，冲突、重放、审计与逐用户事务规则不变。该优化减少一次数据库往返，不改变覆盖证据，也不替代完整迁移的耗时与恢复演练。

成长写入必须收到 `COMMIT` 命令确认。若提交结果未知，或提交已确认但本地结果记录失败，保留原请求和回执并停止；只允许按原键只读核对，不能自动重新写入。原键查询为缺失、冲突或未知时返回 `RECOVERY_READBACK_REVIEW_REQUIRED`，不将只读查询完成当作原写入成功。回滚结果也须收到 `ROLLBACK` 确认才能标记为已回滚。

在架报价按测试环境已确认的 MySQL 来源生成时，`prepare-listed-same-capture-policy.mjs --with-audits` 需要受限的 `--test-authority-template` 和其 SHA-256。模板使用 `zzsh.listed-test-authority-template.v1`，包含 `status=APPROVED`、`decision=OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY`、`scope=LOCAL_AND_TEST_SERVER`、`runtimeCacheKnowledge=UNKNOWN`、`productionCutover=REVERIFY_SOURCE_RUNTIME_POLICY`，以及可追溯的 `authorityRef`、`instruction`。模板必须对应已有的测试授权；脚本按每批实际政策摘要生成绑定记录，不能把它当作生产上线授权或 Redis 价格证据。

旧银行卡专项执行后须同时检查来源和目标隔离计数；`NO_BINDINGS_IMPORTED` 仅表示没有导入且没有隔离，若一张未导入且有隔离则返回 `NO_BINDINGS_IMPORTED_REVIEW_REQUIRED` 并以非零状态停止，不能按空数据放行。部分导入但仍有隔离会单列为 `READBACK_MATCHED_WITH_ISOLATIONS`，须按明细核实，不代表全部承接完成。原键恢复只读重查整个来源计划：原键未匹配、来源有隔离或目标集合不一致时返回 `ORIGINAL_KEYS_READ_BACK_REVIEW_REQUIRED` 并以非零状态停止；来源分类或回查数量不闭合则停止。`ORIGINAL_KEYS_READ_BACK` 是核查时的目标状态，不能替代原事务回执或据此换键重试。

银行卡源文件与恢复快照的比较在只读事务内逐行读取临时盐摘要，再核对原始数据集的数量及完整摘要；不使用有长度上限的 `GROUP_CONCAT`，也不输出姓名或卡号。执行和原键回查均在独立只读事务核验目标身份，逐条核对匹配后再比较整个目标绑定与旧导入审计的数量；零来源同样要求两者为零。权限不足或行级安全可能遮挡数据时停止，发现额外记录则待核。此集合检查面向尚未投入使用的新目标，已有其他绑卡业务的目标需单独核实，不得按数量不符删除。新来源绑定已接入银行卡来源核对；完整银行卡 CLI 与整轮流程仍须独立演练，不能直接作为线上迁移工具。

新轮次目标使用独立本机实例身份。核心导入、成长、信用、银行卡、在架接管和截图路径的候选写入跨批持有目标连接锁，业务基础包、分销资格写入及独立读回使用同一目标事务锁；锁丢失或清理未确认时不能将轮次标为完成。管理员、会员政策和部分分销政策等阶段尚未全部接入此锁，故核心轮次、成长、分销、信用、银行卡、在架接管和路径迁入的新目标写入入口目前主动阻断；初始化和只读专项不能当作完整迁移流程使用。完成全阶段接线和真实并发、恢复验证前不得放开。

本地业务包执行需提供 `--maintenance-admin-id`、`--maintenance-session-id` 和 `--legal-input` / `--legal-input-sha`。法律输入为受限 JSON：`schema` 为 `zzsh.legal-initial-source.v1`，`effectiveAt` 为 UTC 时间，`terms` 与 `privacy` 各有已审正文绝对路径和原始字节 `sha256`，`build` 映射同版 `legal/legal-documents.js`、`auth/security-core.js`、`supply/content-hash.js`、`supply/supply-util.js` 四个构建文件的摘要。两篇当前生效版本须与输入完全一致；缺一篇、内容冲突或来源变化均停止，不覆盖已有运营内容。轮次执行器验证目标绑定的初始化回执，并在只读对账再次核两篇当前版本；它目前**不会自动执行**管理员、业务包或法律初始化，仍需预先取得对应回执。

R07 本地输入装配器的 `runtime` 需要 `paths.secrets.identity` 和 `paths.secrets.identityProfile`；`round` 需要 `paths.legal`、`paths.secrets.identitySubjectHmac` 和 `paths.secrets.identityProfile`。装配器将两份独立密钥的文件摘要与启动绑定核对，并校验协议输入、业务包回执和同版构建一致；缺失、混用或变更时停止。运行态不输出密钥，旧轮次原回执不因此改写。该装配器仍是本机工具，不等于完整一键迁移。

承接旧实名资料时，源提取必须包含 `la_user.real_name` 和 `id_card`。在受限环境分别提供原 `USER_IDENTITY_SUBJECT_HMAC_KEY_FILE` 和独立的 `USER_LEGACY_IDENTITY_PROFILE_KEY_FILE`；后者用于加密完整资料，正式 API 读取时也需使用相同密钥版本。准备文件含旧源资料，必须受限保存，普通日志和报告不得输出明文。导入和只读对账绑定同一份源及密钥证明；旧实名仍保留原来源，不能标成新渠道核验。

## 脚本职责导航

| 入口或模块 | 目的 | 依赖与输出 |
| --- | --- | --- |
| `build-business-initial.mjs` | 从受控空库安装后的最终结构生成新装基线 | 原迁移链、种子白名单、结构/ACL等价验证；不转换旧业务数据 |
| `admin-staging-handoff.mjs` / `retire-r07-local-auth.mjs` | 精确退役交付副本中的本机认证材料，保留业务身份和用户密码 | 仅接受专用合成库或绑定回执的第七轮独立本机副本；不连接线上、不清空全局验证记录 |
| `bootstrap-local-reference.mjs` | 旧本地演练的管理员初始化，封包/装载已审业务基础资料 | 管理员旧入口禁止 NEXT 目标；业务包不包含管理员凭据、会话、审批执行或交易 |
| `initialize-local-policy.mjs` | 旧本地演练的会员政策发布 | 使用旧审批流程，禁止 NEXT 目标；新政策初始化待接入 |
| `capture-local-source.mjs` | 在本地源 MySQL 一致只读事务中提取数据 | 绑定源、物理字段和截点；输出受限 JSONL、摘要及读回收尾回执 |
| `prepare-local-dataset.mjs` | 构建有完整关联的迁移 cohort 与各域输入 | 已核 SHA 的源包；输出执行包、依赖及隔离清单，不写目标 |
| `prepare-listed-same-capture-policy.mjs` | 从完整源账号流和同一快照配置准备在架报价证据 | 核对源包、绑定、原 dump 与编译依赖；可依据已确认的测试授权模板生成每批审计资料和测试授权，不创建正式切换授权或接管账号 |
| `run-listed-batches.mjs` | 按完整来源集合处理在架账号 | `--validate` 只核输入；`--execute` 先准备全部批次和回滚试运行，再逐批接管及读回，最后调用全量回查。失败保留原请求键、检查点和结果，不自动重发；空集使用独立空集回查。此入口只覆盖在架接管，不代表完整迁移通过 |
| `verify-legacy-listed-policy-dump.mjs` | 校验旧 dump 中的游戏价差配置 | 对同一数据流边计算摘要边解析，摘要不符即拒绝；结果不能证明未采集的 Redis 运行时配置 |
| `load-legacy-listed-accounts.mjs` | 按已核来源接管在架账号并只读回查单批结果 | 皮肤须有对应原观察版本的完整承接，明确为空与记录缺失分开；执行后保留原检查点，`--readback` 核对原请求回执、发布版本、来源报价和当前公开可租状态。单批读回不证明全部批次闭合、归档恢复或页面验收 |
| `readback-listed-batches.mjs` | 对全部非空在架批次做独立闭合回查 | 核全部批次来源、回滚试运行、原检查点和单批读回，再在同一只读快照核当前发布、报价、原请求回执、可租状态及来源集合外的观察/发布；只覆盖回查时点 |
| `readback-empty-legacy-listed.mjs` | 对来源没有在架账号的情况做独立只读核验 | 核同源完整账号流、核心/成长回执、目标身份及工具均已列入同版封存清单；目标旧在架观察或已迁账号发布记录非零、权限/RLS 不完整时停止或待核。仅覆盖回查时点，不替代其他初始化及验收 |
| `local-source-adapter.mjs` / `local-source-scenarios.mjs` | 物理列适配、精确金额/时间转换与场景选择 | 被准备脚本复用，不作为另一个写库入口 |
| `prepare-local-display.mjs` | 准备完整账号展示字段 | 同源账号与已有提取逐字段核对，保留 `null` / `false` / `0` 的区别 |
| `local-funds-plan.mjs` | 准备五类资金记录、退款尝试、覆盖、保证金及责任 | 绑定基础数据和必要补提包；声明各类实际记录数量，不能只迁金额汇总 |
| `local-opening-proof.mjs` | 准备原钱包余额及来源证明 | 身份、原余额、收益/订单/提现/佣金关联；未知或冲突保留待核 |
| `load-local-dataset.mjs` | 执行核心、资金、期初、展示和皮肤各阶段 | 同一资源、原请求键与检查点；分批提交、失败停止、未知提交只读回查 |
| `local-target-{finance,opening,display,holdings}.mjs` | 各阶段的装载编排 | 由总导入器调用，最终写入仍复用 API 正式 writer |
| `local-load-checkpoint.mjs` | 排他暂存、落盘和替换检查点 | 保留失败暂存件；文件写入重试不意味着允许重发 SQL |
| `readback-local-dataset.mjs` | 目标只读对账 | 原转换包、同一 OID/nonce；不补写、不换键恢复 |
| `legacy-rehearsal.mjs` | 离线 planner / 合成 fixture 对账 | 不连库、`apply` 拒绝；仅用于准备及回归，不能当实际迁移结果 |

实际阶段不要求一个巨大事务完成，但必须沿依赖顺序，并保留可核对的阶段结果。准备、装载、读回和页面通过分别报告。每阶段记录处理单位（记录/主体组/批）、实际执行耗时、查询量、失败与恢复；人工排错停顿不混入转换吞吐。当前本地执行器仍有本机路径与资源约束，不能原样当作已验收的线上一键迁移入口。

## 离线规划与合成对账

以下示例仅调用 `legacy-rehearsal.mjs`，全部为合成数据。格式正确和 `conserved=true` 不能证明文件来自真实数据库，也不表示迁移、可租或渠道验收通过。

使用项目Node24.20.0，先构建API：

```sh
npm run build -w @zzsh/api
npm run test:migration-rehearsal
npm run migration:rehearsal -- plan --out tmp/rehearsal/plan
npm run migration:rehearsal -- reconcile --plan tmp/rehearsal/plan/plan.json --target scripts/migration/fixtures/target-readback.positive.json --out tmp/rehearsal/compare
npm run migration:rehearsal -- missing-evidence --plan tmp/rehearsal/plan/plan.json --out tmp/rehearsal/missing
npm run migration:rehearsal -- readiness --plan tmp/rehearsal/plan/plan.json --reconcile tmp/rehearsal/compare/reconcile.json --out tmp/rehearsal/readiness
```

默认plan。构建取apps/api/dist/src，或显式--api-dist；不从环境变量或其他工作树静默选择。输入manifest绑定代码基线、实际加载API模块的source/compiled SHA、共享模块及依赖锁，漂移拒绝；示例绑定37676018。变更依赖闭包后由维护者重新构建、核定并绑定，不能绕过来源检查。

复用身份/账号/订单、皮肤持有、旧单续办及资金来源的正式planner，经济根类型复用正式资金来源常量。独立近战、收益流水与期初截点、当前责任沿各自正式合同。输出仅保留命令原键、fingerprint、正文摘要及必要关联；执行正文仍取受限原输入，公开plan不构成写入批准。

目标导出须含源manifest SHA、代码基线、fixtureOnly及读取资源信息。实际目标导出还必须与plan明确绑定的PostgreSQL OID/库名一致，无绑定拒绝。zzsh_restore/sg_zzsh_restore只是历史MySQL恢复源的候选标签，不是已确认的PostgreSQL目标。

对账核身份/关系/原状态、CNY整数分、责任原订单及受益人、期初用户、皮肤持有集合、续办原键、媒体关联/来源/审核/可见性及占用。缺失金额保持未知，不按零汇总；只对已准备好的同主体/同来源种类经济根判重，未证期初不当已覆盖。期初按用户身份对账，一个旧钱包不能同时生成两份期初；样例openingId仅是算例标签，不是数据库basis ID。真实可租须另验当前报价、本人接受、媒体和占用，空报价对象不是证明。

默认样例只含一份可准备的110分期初。FIN-02的另一110分算例单独使用fixtures/manifest-fin02.json，不能与同主体FIN-01相加成220分。各域样例来自独立合成用例，并不构成同一真实截点快照；真实输入仍须核一致来源与截点。

readiness核对应plan摘要，合成对账仅标FIXTURE_PASS。缺证种子随plan保存，省略manifest参数也不丢FIN-01/02或具体资金缺项。成长/信用及目标运行门独立记录。工具只覆盖其列明字段，不是全量数据、全平台权限、实际媒体字节或银行到账证明。

真实源提取、受限文件权限、物理列与提取别名核对、目标选择及数据库读取另行绑定。示例不含批准、秘密、真实导出、claim或窗口；这些资料不得加入Git。

## 本地真实源核心域转换工具

以下入口与上面的离线fixture planner分开，默认均只输出plan，不读凭据、不连库：

- `capture-local-source.mjs`：只读已绑定的本地MySQL恢复容器，保留原物理字段、支付原号、身份/密码来源及资金旁证；同一只读一致快照逐域流式写受限JSONL，确认ROLLBACK及客户端关闭。原始数据不进Git。
- `prepare-local-dataset.mjs`：逐件核源SHA，复用正式身份/账号/订单/续办与资金纯函数，生成受限执行输入及完整隔离分母；原dump截止点与采集时间分开。READY只是源侧参数准入。
- `bootstrap-local-reference.mjs`：旧本地管理员入口创建并激活两 Boss 及运营、客服，禁止对 NEXT 目标使用；另行装载不含管理员身份和交易的已审业务基础资料。旧管理员、凭据/会话和 IM 映射的恢复路径已经拒绝；不改 realm secret、不复制订单付款、不禁用触发器。
- `load-local-dataset.mjs`：显式execute后才读取已登记migration身份；复用正式writer按身份→账号/观察/快照→旧单→历史观察/续办/责任/佣金执行，分批事务保存checkpoint和原键。COMMIT UNKNOWN停止，recover只读，不自动换键重发。
- `prepare-local-display.mjs`：独立补提账号展示字段，逐字段核对原冻结提取，任何共同字段漂移即拒绝；不修改原dataset或把缺项补成0。
- `load-local-dataset.mjs --enrich-display`：只在核心导入完成的已知checkpoint追加正式历史展示快照；`--import-openings`独立绑定已审原余额证明，金额写入仍走正式maintenance准入/原键/账务writer，不按流水求和。
- `load-local-dataset.mjs --enrich-holdings`：只消费四列实源与原字典来源，通过完整集合mapper与sealed admission追加独立持有；有精确受审映射时额外绑定 `--holding-mapping-overlay` 与 `--holding-mapping-overlay-sha`，写入前重核当前目录。不改旧v1输入的判定，不将部分命中当完整集合、不建立ID等价、不放开交易。
- `readback-local-dataset.mjs`：在准确同OID/nonce上持维护锁，以只读一致快照按批核身份/旧凭据/持久化默认头像、账号来源/观察版本/原价快照，以及旧单完整关系/状态/金额/摘要。公开报告只输出安全差异标识，不输出手机号、凭据或证件。

每个命令的`--plan`列出必需参数。实际源及目标都须独立绑定manifest SHA；本地目标固定唯一回归组，禁止日常库、IM保留库或任意临时后缀。源缺主体、重复手机号、金额/时间/旁证不完整均分类保留，不造账号、成年、已到账或0余额。

全量导入占用唯一回归资源时，在中央resource状态登记`protectedDataset`；普通reset必须在任何DROP前拒绝。验收或日常承接后由维护者明确解除，不增加绕过保护的环境开关。耗时按原始回执、事务checkpoint和后续phase单调计时分别记录；缺计数标未知，不据本地吞吐自行承诺线上停机窗口。

参考包承接与真实旧业务转换分别对账：旧支付标记只能形成历史记录，不生成原生PAID/渠道证据；已没收只保留`LEGACY_RECORDS`终态，不再支付；已有退款记录不重退。钱包期初必须另有正式经济根/覆盖证明，历史展示成功不能当作可提现余额。媒体只保留来源、ID、storageKey和字节摘要，未核验的字节明确待处理。

这些脚本不调用真实支付、短信、实名、云信或银行渠道；本地通过不代替线上迁移及到账验收。新环境数据库initial入口见[数据库基线说明](../../docs/operations/database-initial.md)，字段及业务映射见[旧数据转换契约](../../docs/architecture/legacy-data-mapping.md)。

同快照在架报价证据采用独立 V2 口径，注明 MySQL 配置与账号同时采集、Redis 运行时未核；不改写旧补采 V1 证据。来源真实为空时只记录源侧空集合，不声称目标已核验。来源准备按完整账号集合确定性分批，逐批限制现有 32 KiB 证据上限并验证并集；单条仍超限时停止。分批证据尚未接入目标接管执行器，皮肤核对和整轮自动接管仍须独立完成。

V2 接管前需安装支持同快照政策的数据库守卫，执行器核对迁移版本账、函数正文摘要及政策和报价两条触发器是否启用；旧 V1 的证据及原有报价守卫保持不变。应用能解析政策包不等于目标数据库已支持写入。

新完整采集对账号皮肤列、字典类型及条目做同快照列检查。目标持有准备在既有九项来源歧义之外识别新增重复词条；涉及未确认词条或名称和值不一致的账号保持隔离。旧来源包继续沿用原固定规则，不能重写旧检查点或将旧来源补采标成同快照。

### 第七轮独立副本：账号采集事实补充（候选）

`complete-r07-account-capture.mjs` 默认只打印 plan，不读取凭据或连接数据库。它针对已经导入 V1 且不可变的 R07 历史账号，补充同一来源采集时的 `base_bot` 与 `is_full_payout`；不会将它们当作旧订单创建时的冻结值，也不会修改 V1、原价、钱包、库存或上架权限。先在独立副本应用经过审查的 `0174` 与 `0175`，实际 PostgreSQL journal、触发器、约束及 runtime 只读权限必须与本地代码一致。原 R07 system identifier 和原回归 marker 均拒绝。

受限输入 JSON 约定为 `schema: "zzsh.r07-capture-fact-input.v1"`，`sourceReceipt`、`datasetManifest`、`restoreReceipt`、`actor` 各为 `{path,sha256}`；恢复回执必须绑定已验证的源快照、目标 system identifier/OID/marker/nonce、角色及 ACL/RLS 读回。`credentialsPath` 指向已登记副本的受限凭据文件，同目录 `resource.json` 需具备独立 cluster system identifier、OID、marker `zzsh:r07-delivery-clone:v1`、nonce、owner/migration/runtime 角色及其 OID、锁、与原 dataset manifest SHA 相等的 `protectedDataset.manifestSha256`。actor 必须在副本的正式认证流程中取得，包含 admin ID、session ID 和相同资源 OID/nonce。资源、输入、输出都只放受限路径；不要把密码/Token/个人数据写入命令或 Git。

1. `node scripts/migration/complete-r07-account-capture.mjs --prepare --input <input.json> --input-sha <sha256> --out <新受限目录>`：只读快照逐个核源文件、已选账号与目标锚点，要求目标无已有补充事实；输出带目标、代码依赖闭包和逐账号摘要的受限 plan，成功必须确认 rollback、锁释放及连接关闭。
2. 维护者按已审 plan 准备 `zzsh.r07-capture-fact-authority.v1` 受限文件，绑定 `planSha256`、完全相同的 `target`、准确 `maxAccounts`、`APPEND_SOURCE_BOUND_ACCOUNT_CAPTURE`、`allowFinancialWrites:false`、`approvalRef`、`attempt` 及不超过 30 分钟的 `notBefore`/`expiresAt`。这是本地任务范围和来源/资源绑定，不替代 Owner 对服务器部署的审核。
3. `node scripts/migration/complete-r07-account-capture.mjs --execute --input <input.json> --input-sha <sha256> --plan <plan.json> --plan-sha <sha256> --authority <authority.json> --authority-sha <sha256> --out <另一新受限目录>`：持专用锁、在单一事务内按 400 条使用正式受限 writer 和原键追加并记录批次审计；逐批核文件包对应的原账号摘要。过期、来源漂移或目标变化回滚；COMMIT UNKNOWN 保留原 key/receipt，禁止换键盲重试。
4. `node scripts/migration/complete-r07-account-capture.mjs --readback --input <input.json> --input-sha <sha256> --plan <plan.json> --plan-sha <sha256> --apply-receipt <receipt.json> --apply-sha <sha256> --out <另一新受限目录>`：只读重新比对全部源/目标键与值、V1 锚点、事实摘要、每个批次原幂等回执与审计。提交回执为 UNKNOWN 时，只有锁与连接收尾已确认、全部原键及现态匹配才可确认提交；缺失或冲突保持 UNKNOWN，不换键重跑。完成后仍需实际页面、原在架报价和订单回归。输出中的已知/未知数量只说明账号采集事实，不证明渠道到账。

这是一份候选接线；在独立真实数据交付副本完成完整 prepare / execute / readback 前，不应称其已完成 R07 修复。环境角色、授权窗口、文件身份和实际输出摘要均由执行阶段另行登记。

### 第七轮独立副本：本地认证材料退役

`retire-r07-local-auth.mjs` 是绑定到本次已登记副本的维护入口。受限输入引用已封存恢复、邀请人数、结构及账号事实回读；`--prepare` 只读记录精确管理员、用户 session 和已过期短信挑战的行 ID/数据库内摘要，并对用户 account 做整体摘要。`--execute` 需要绑定 plan、目标、数量和时窗的受限 authority，事务内重核前像及全部入向 FK，再定点退役；用户 account/密码和被引用的管理员 user 主键、业务事实及原审计保留。不清空全局 verification；发现不能归属的验证记录即停止。

`--readback` 依据原审计键和目标现态只读核对，提交结果未知时只有连接和锁已确认收尾、原审计与现态全部吻合才能确认；否则保留 UNKNOWN，不换键重跑。该工具不创建目标 Boss、不安装模拟支付结构，也不授权服务器部署。
