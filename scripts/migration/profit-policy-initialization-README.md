# 派生初始化价目

此工具只生成私有业务参考包，不连接数据库或渠道。它适用于已审核的单游戏封签包，供新目标库初始化之前审阅；不能用它替换已使用中的规则或原地修改 SEALED 版本。当前候选以 Owner 明确选择的普通/自定义价差 6、极速价差 12 为准，要求上游现价分别为 8/12，并绑定已核的 R06 旧 MySQL 来源比较回执。旧站同截点 Redis 值仍为 UNKNOWN，该证据不是生产切换证明。

工具保留上游全部封存价格版本、规则版本和物资价目行；追加一个价格版本、对应物资行和一个规则版本，切换派生包中的游戏当前版本指针。旧封存行按原始字符串保留，物资数值不经 JavaScript 浮点重算。新版本创建和激活时间为明确标记的**包内种子时间**，不代表已向目标库执行或生效的回执。新会员政策须之后绑定新规则版本；旧在架承接使用自己的来源冻结价。

调用前准备私有 decision JSON，明确 `kind: "ZZSH_BUSINESS_PROFIT_POLICY_DECISION_V1"`、`authorization: "OWNER_DIRECTED_FRESH_INITIALIZATION"`、`gameCode: "delta"`、`expectedOldOrdinary: "8"`、`ordinarySpread: "6"`、`fastSpread: "12"`、`derivedAt`（UTC 毫秒精度的包种子时间）、`sourceManifestSha256` 与 `policyEvidenceSha256`。上游为派生包时，另提供其 `derivation-receipt.json` 的 `parentReceiptSha256`；工具核验上游回执中派生 manifest 摘要，并把必要回执、决策与策略证据按摘要复制进新包。

```text
node scripts/migration/derive-business-reference-profit-policy.mjs \
  --private-root <私有根目录绝对路径> --source <已封签业务包目录> \
  --decision <decision.json> --decision-sha <decision 的 SHA-256> \
  --evidence <来源策略比较回执> --out <不存在的新私有目录>
node scripts/migration/bootstrap-local-reference.mjs --verify --manifest <新包 manifest.json> --manifest-sha <新 manifest 的 SHA-256>
```

来源包、决策、回执及输出均需受限目录，输出只允许新建且实施最小权限。成功回执在源文件与输出逐个读回后生成，列明表级行数和摘要变化；任何失败都不产生成功回执。重试使用新输出目录并重核摘要，不能覆盖原包。`media-objects.json` 原样保留，其摘要继续指向原始采集包，不意味着本次检查了 OSS 内容。

`bootstrap-local-reference.mjs` 的导入回执将派生包的 `sourceRawUnchanged` 标为 false；`sourceIdsPreserved` 对派生包为未知，避免把新增行误说为旧来源原样。完整来源/派生链需与单次初始化回执一起留存。业务正式启用、数据库前向迁移、真实账号和支付渠道均未由该工具执行。
