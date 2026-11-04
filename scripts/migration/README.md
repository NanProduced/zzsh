# 旧平台数据转换与迁移脚本

本目录同时包含离线规划工具和真实本地迁移入口，不能将两者混为一谈。`legacy-rehearsal.mjs` 不连库、不执行写入；`capture-local-source.mjs` 可只读提取源库；`load-local-dataset.mjs` 和初始化入口在显式执行、输入与资源核验通过后会写目标库。真实数据、凭据、执行参数、检查点和结果均在受限目录，不能提交 Git。

## 先看执行顺序

转换核心复用 `apps/api/src/legacy-load/`、`supply/legacy-*`、`order/legacy-*` 和 `finance/legacy-*` 中已有的正式 planner / writer。脚本负责源提取、组合、阶段编排和恢复，不另写一套价格或账务规则。

1. **冻结源和目标版本**：绑定源快照、物理表列、源截点、代码与构建摘要；独立创建并核验目标资源。源库当前的行数不能套用另一份旧快照。
2. **安装新平台结构及基础资料**：从 `apps/api/migrations/initial/` 安装明确基线，再执行对应后续迁移和 runtime ACL；通过正式流程新建管理员，再初始化游戏、目录、皮肤词条、价目和规则。旧管理员、会话与 IM 身份不迁入。
3. **抽取和离线转换**：`capture-local-source.mjs` → `prepare-local-dataset.mjs`。按订单选择租客、号主、关联账号和必要的邀请上级/受益人；保留原来源三元组、关联、金额、状态、时间与隔离原因。
4. **迁入关系骨架**：`load-local-dataset.mjs --core-only` 按用户 → 游戏账号及号主 → 订单及双方/账号关联执行。账号必须先有号主，订单必须先有账号、号主和租客。
5. **迁入资金及在途责任**：不带 `--core-only` 复用同一检查点，跳过已完成核心阶段，承接邀请事实、收益/提现/佣金/付款/退款记录、退款尝试、各域覆盖证明、保证金，以及旧单续办、退款责任和待结佣金。旧付款记录不冒充新的渠道支付成功。
6. **建立钱包期初**：`local-opening-proof.mjs` 准备原余额与经济来源证明，再由 `load-local-dataset.mjs --import-openings` 写入。先核身份、资金记录和覆盖，再接纳原余额；不将流水重算净和，不重复支付已结佣金。
7. **补齐账号可读内容**：`--enrich-display` 追加账号展示属性，`--enrich-holdings` 将旧皮肤字符串映射到已确认的新词条。二者依赖账号和目录，并不依赖钱包期初；同一检查点内仍串行执行。无法完整映射的集合保留原因，不能写成空集合。
8. **读回对账并接入服务**：`readback-local-dataset.mjs` 核对关系、逐项金额、记录集合、状态、来源摘要、责任与余额。数据库对账后，才切换同版 API/BFF/页面，验证连续时间查询和后续操作。字段来源保留在证据层，不要求用户区分升级前后的记录。

会员政策通过 `initialize-local-policy.mjs` 走新管理员的正式申请、审批与执行。信用初始化复用 `apps/api/src/credit/credit-initialization-cli.ts` 及其批处理；它们属于新平台初始化，不复制旧管理员或凭空制造旧成长消费。历史成长补齐仍需原消费/退款及覆盖证明，不能把缺证当成零。

## 脚本职责导航

| 入口或模块 | 目的 | 依赖与输出 |
| --- | --- | --- |
| `build-business-initial.mjs` | 从受控空库安装后的最终结构生成新装基线 | 原迁移链、种子白名单、结构/ACL等价验证；不转换旧业务数据 |
| `bootstrap-local-reference.mjs` | 正式初始化新管理员，封包/装载已审业务基础资料 | 新目标与正式认证入口；业务包不包含管理员凭据、会话、审批执行或交易 |
| `initialize-local-policy.mjs` | 用新两Boss正式发布已审本地会员政策 | 正式 API、明确政策正文、原请求键；不直接写政策表 |
| `capture-local-source.mjs` | 在本地源 MySQL 一致只读事务中提取数据 | 绑定源、物理字段和截点；输出受限 JSONL、摘要及读回收尾回执 |
| `prepare-local-dataset.mjs` | 构建有完整关联的迁移 cohort 与各域输入 | 已核 SHA 的源包；输出执行包、依赖及隔离清单，不写目标 |
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
- `bootstrap-local-reference.mjs`：通过正式初始化/创建流程新建两Boss及运营、客服；另行装载不含管理员身份和交易的已审业务基础资料。旧管理员、凭据/会话和IM映射的恢复路径已经拒绝；不改realm secret、不复制订单付款、不禁用触发器。
- `load-local-dataset.mjs`：显式execute后才读取已登记migration身份；复用正式writer按身份→账号/观察/快照→旧单→历史观察/续办/责任/佣金执行，分批事务保存checkpoint和原键。COMMIT UNKNOWN停止，recover只读，不自动换键重发。
- `prepare-local-display.mjs`：独立补提账号展示字段，逐字段核对原冻结提取，任何共同字段漂移即拒绝；不修改原dataset或把缺项补成0。
- `load-local-dataset.mjs --enrich-display`：只在核心导入完成的已知checkpoint追加正式历史展示快照；`--import-openings`独立绑定已审原余额证明，金额写入仍走正式maintenance准入/原键/账务writer，不按流水求和。
- `load-local-dataset.mjs --enrich-holdings`：只消费四列实源与原字典来源，通过完整集合mapper与sealed admission追加独立持有；有精确受审映射时额外绑定 `--holding-mapping-overlay` 与 `--holding-mapping-overlay-sha`，写入前重核当前目录。不改旧v1输入的判定，不将部分命中当完整集合、不建立ID等价、不放开交易。
- `readback-local-dataset.mjs`：在准确同OID/nonce上持维护锁，以只读一致快照按批核身份/旧凭据/持久化默认头像、账号来源/观察版本/原价快照，以及旧单完整关系/状态/金额/摘要。公开报告只输出安全差异标识，不输出手机号、凭据或证件。

每个命令的`--plan`列出必需参数。实际源及目标都须独立绑定manifest SHA；本地目标固定唯一回归组，禁止日常库、IM保留库或任意临时后缀。源缺主体、重复手机号、金额/时间/旁证不完整均分类保留，不造账号、成年、已到账或0余额。

全量导入占用唯一回归资源时，在中央resource状态登记`protectedDataset`；普通reset必须在任何DROP前拒绝。验收或日常承接后由维护者明确解除，不增加绕过保护的环境开关。耗时按原始回执、事务checkpoint和后续phase单调计时分别记录；缺计数标未知，不据本地吞吐自行承诺线上停机窗口。

参考包承接与真实旧业务转换分别对账：旧支付标记只能形成历史记录，不生成原生PAID/渠道证据；已没收只保留`LEGACY_RECORDS`终态，不再支付；已有退款记录不重退。钱包期初必须另有正式经济根/覆盖证明，历史展示成功不能当作可提现余额。媒体只保留来源、ID、storageKey和字节摘要，未核验的字节明确待处理。

这些脚本不调用真实支付、短信、实名、云信或银行渠道；本地通过不代替线上迁移及到账验收。新环境数据库initial入口见[数据库基线说明](../../docs/operations/database-initial.md)，字段及业务映射见[旧数据转换契约](../../docs/architecture/legacy-data-mapping.md)。
