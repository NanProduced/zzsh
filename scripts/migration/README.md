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
