# 离线迁移准备与对账

本工具只读取明确文件并调用现有API planner；不连接数据库、调用渠道或执行writer，apply始终拒绝。示例全部为合成数据。格式正确和conserved=true不能证明文件来自真实数据库，也不表示迁移、可租或渠道验收通过。

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
- `bootstrap-local-reference.mjs`：仅在准确登记的回归OID/nonce恢复已审参考包中的原5个管理员、凭据/会话及必要目录/规则。原JSON文本在PG转换，保numeric精度；FK顺序与draft/seal约束照常执行。不会初始化新Boss、改realm secret、复制订单付款或禁用触发器。
- `load-local-dataset.mjs`：显式execute后才读取已登记migration身份；复用正式writer按身份→账号/观察/快照→旧单→历史观察/续办/责任/佣金执行，分批事务保存checkpoint和原键。COMMIT UNKNOWN停止，recover只读，不自动换键重发。
- `prepare-local-display.mjs`：独立补提账号展示字段，逐字段核对原冻结提取，任何共同字段漂移即拒绝；不修改原dataset或把缺项补成0。
- `load-local-dataset.mjs --enrich-display`：只在核心导入完成的已知checkpoint追加正式历史展示快照；`--import-openings`独立绑定已审原余额证明，金额写入仍走正式maintenance准入/原键/账务writer，不按流水求和。
- `load-local-dataset.mjs --enrich-holdings`：只消费四列实源与原字典来源，保留已确认九项来源歧义，通过完整集合mapper与sealed admission追加独立持有；不将部分命中当完整集合、不建立ID等价、不放开交易。
- `readback-local-dataset.mjs`：在准确同OID/nonce上持维护锁，以只读一致快照按批核身份/旧凭据/持久化默认头像、账号来源/观察版本/原价快照，以及旧单完整关系/状态/金额/摘要。公开报告只输出安全差异标识，不输出手机号、凭据或证件。

每个命令的`--plan`列出必需参数。实际源及目标都须独立绑定manifest SHA；本地目标固定唯一回归组，禁止日常库、IM保留库或任意临时后缀。源缺主体、重复手机号、金额/时间/旁证不完整均分类保留，不造账号、成年、已到账或0余额。

全量导入占用唯一回归资源时，在中央resource状态登记`protectedDataset`；普通reset必须在任何DROP前拒绝。验收或日常承接后由维护者明确解除，不增加绕过保护的环境开关。耗时按原始回执、事务checkpoint和后续phase单调计时分别记录；缺计数标未知，不据本地吞吐自行承诺线上停机窗口。

参考包承接与真实旧业务转换分别对账：旧支付标记只能形成历史记录，不生成原生PAID/渠道证据；已没收只保留`LEGACY_RECORDS`终态，不再支付；已有退款记录不重退。钱包期初必须另有正式经济根/覆盖证明，历史展示成功不能当作可提现余额。媒体只保留来源、ID、storageKey和字节摘要，未核验的字节明确待处理。

这些脚本不调用真实支付、短信、实名、云信或银行渠道；本地通过不代替线上迁移及到账验收。新环境数据库initial入口见`docs/operations/database-initial.md`。
