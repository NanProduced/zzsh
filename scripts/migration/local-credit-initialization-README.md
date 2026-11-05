# 本地迁入主体信用初始化

本入口用于已登记的第六轮本地回归资源。它复用 `credit-initialization` 的正式 100 分批处理、当前 Boss 会话、资源检查与幂等回执；不复制旧管理员，不重置已有信用分或历史事件。入口依赖 Windows 本机受限资源登记和维护锁，不声明可用于 Linux、测试服务器或生产。

执行前须完成本轮核心数据和会员成长导入、独立零差异读回与锁移交。输入绑定同一轮的 round input、完成回执、core readback、源场景和最终 API build manifest；逐次核 OID、nonce、runtime 角色、marker、Boss 会话及原包摘要。只为旧来源中 ACTIVE、未暂停、无信用档案且无信用事件的主体分包；冻结、注销、暂停、已有档案分别统计并保留。未知状态、无档案却已有事件、分母或资源不符时停止。

从持有本入口的工作树根目录运行。以下占位符须替换为本轮真实受限文件及 SHA；输出目录必须是受限目录下尚不存在的新目录。先与其他维护者串行交接 806006，锁忙停止，不换库或换锁。

```powershell
$context = @(
  '--round-input', '<round-input.json>', '--round-input-sha', '<round-input-sha256>',
  '--round-receipt', '<round-receipt.json>', '--round-receipt-sha', '<round-receipt-sha256>',
  '--core-readback', '<readback.json>', '--core-readback-sha', '<readback-sha256>',
  '--build', '<same-tree-isolated-api-dist-src>',
  '--build-manifest', '<final-build-manifest.json>', '--build-manifest-sha', '<build-manifest-sha256>'
)
node scripts/migration/run-local-credit-initialization.mjs --validate @context --out '<new-private-validation-dir>'
node scripts/migration/run-local-credit-initialization.mjs --prepare @context --out '<new-private-plan-dir>'
```

`--validate` 只检查封签文件与当前资源登记，不读取数据库凭据或连接数据库。`--prepare` 仍须先拿维护锁并独立只读目标。核 `manifest.json` 的 `PREPARED_NOT_APPROVED`、类别计数、分母平衡、孤立事件为零、批次及锁/连接关闭状态。计划及分包含用户内部 ID，原件仅保存在受限目录。仅在负责人核验后，以该原 manifest 的 SHA 封签本地执行凭据：

```powershell
node scripts/migration/run-local-credit-initialization.mjs --authorize @context --plan '<plan-dir/manifest.json>' --plan-sha '<plan-sha256>' --approval-ref '<reviewed-reference>' --window-minutes 120 --out '<new-private-authority-dir>'
node scripts/migration/run-local-credit-initialization.mjs --execute @context --plan '<plan-dir/manifest.json>' --plan-sha '<plan-sha256>' --authority '<authority-dir/authorization.json>' --authority-sha '<authority-sha256>' --out '<new-private-execution-dir>'
```

每批先正式 PREVIEW，再以相同对象集正式 APPLY；每批独立事务，只有数据库 COMMIT ACK 才记录已提交。随后关闭写连接，新连接只读核每位新档案的分数/事件、逐批原键与审计，并比较此前全部其他信用档案和事件的摘要。`CREDIT_INITIALIZATION_READBACK_PASS` 且 `readback.independentConnection=true`、人数一致、锁和连接均关闭，才表示本轮通过；零待初始化也经只读核验，不产生空写。

出现 `COMMIT_UNKNOWN_STOPPED`、`COMMIT_ACK_RECEIPT_FAILED_STOPPED`、`PARTIAL_COMMITTED_STOPPED` 或 `COMMITTED_ACK_READBACK_REQUIRED` 时保留原 summary、pending 的批次键、原业务包及 authority，禁止重跑整个计划。按现有 `credit-initialization-cli` 的 `RECOVER_READ` 合同，在新有效窗口使用原业务包、原 actor 与原键只读查询；未确认前暂停后续批次。不得换键、补造成功或覆盖原回执。

可先运行 `node --test scripts/migration/local-credit-initialization-plan.test.mjs` 与 `node --check scripts/migration/run-local-credit-initialization.mjs`。纯合成测试和本地数据库结果均不等于线上渠道验收。
