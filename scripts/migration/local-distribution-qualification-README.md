# 本地旧分销资格计划、执行及读回

此工具只用于已登记的第六轮本地 `zzsh_test_regression` 场景库；必须同时核对 `ROUND06_BOOTSTRAP_RESERVED`、新 OID、nonce 和场景摘要，明确拒绝第五轮 OID。它承接旧参与者的资格和档位，**不导入或重放佣金、不调用资金渠道**。新政策仍由现有管理端审批流程发布；旧关系、旧佣金和新政策/资格分别保留。

## 输入

在 R06 本轮核心迁移、资金历史与独立读回完成后，使用本轮封签的 `zzsh.local-round.v1`、新 Boss profile/session/actor 和最终隔离 API build，调用同一准备入口生成新的受限输入。路径、摘要和会话均不得沿用 R05：

```powershell
node scripts/migration/prepare-local-distribution.mjs input --round-input <r06-round-input.json> --round-sha <sha256> --round-receipt <round-receipt.json> --round-receipt-sha <sha256> --core-readback <readback.json> --core-readback-sha <sha256> --source-mode reused --build <isolated-api-dist-src> --profile <new-profile.json> --session-one <boss-one-state.json> --session-two <boss-two-state.json> --actor <boss-one-actor.json> --candidate <same-source-candidate.json> --out <new-private-dir/input.json>
```

生成的输入包含：

```json
"distribution": {
  "scope": "NATIVE",
  "coreEvidence": {
    "roundInputSha256": "<round input SHA-256>",
    "roundReceipt": { "path": "<completed round receipt>", "sha256": "<receipt SHA-256>" },
    "readback": { "path": "<independent core readback>", "sha256": "<readback SHA-256>" }
  },
  "candidate": { "path": "<restricted/candidate.json>", "sha256": "<candidate file SHA-256>" },
  "lockfileSha256": "<root package-lock.json sha256>",
  "approval": {
    "profile": { "path": "<registered local-auth profile>", "sha256": "<sha256>" },
    "firstActor": "boss-one", "secondActor": "boss-two",
    "sessions": {
      "boss-one": { "path": "<existing storage-state>", "sha256": "<sha256>" },
      "boss-two": { "path": "<existing storage-state>", "sha256": "<sha256>" }
    },
    "apiOrigin": "http://127.0.0.1:4232", "adminOrigin": "http://127.0.0.1:4231", "userOrigin": "http://127.0.0.1:4230",
    "adminSecret": { "path": "E:/zzsh/zzsh/apps/api/.secrets/auth_admin_secret", "sha256": "<existing file sha256>" },
    "userSecret": { "path": "E:/zzsh/zzsh/apps/api/.secrets/auth_user_secret", "sha256": "<existing file sha256>" }
  }
}
```

本地库将导出给测试服务器时使用 `NATIVE`，因为单个参与者只能绑定一个政策版本；不要先写 `LOCAL_CONTROLLED` 再假定切换 scope 自动生效。`source`、`dataset`、`target`、`actor`、`window`、`credentials` 必须绑定本次目标登记及同一冻结源。`apiDist` 须为当前工作树内 `tmp/<独立构建名>/api/dist/src`，不能指向运行中服务的 `apps/api/dist`；`buildFiles` 必须包含该目录全部 `.js` 的准确摘要，需在最终 API 构建后重新封签。不得沿用其他轮次的 OID、nonce、角色、构建或政策引用。所有源、计划、权限及输出均留在 `E:/zzsh-local-state/restricted/`，不要打印其中的用户信息。

输入额外固定分销候选 SHA。工具会重读所绑定源回执、旧配置和档位文件，校验文件 SHA、数量及候选原文，再由源配置重建策略；它不会把一份自称已审核的比例当来源证据。当前规则改变或不确定时停止并重新核业务，不能自动沿用旧轮数据。

封签和各阶段执行会核对已完成的本轮迁移回执、独立读回 SHA、目标 OID/nonce、场景摘要及财务观察逐域无差异；每次现场读取时也核对旧财务观察总数与读回一致，再比较全行摘要。空财务基线仅在本轮读回确实证明为空时有效。

## 计划及发布

```powershell
node scripts/migration/run-local-distribution-qualification.mjs --prepare --input <input.json> --input-sha <input-sha256> --out <new-restricted-directory>
```

计划在 `REPEATABLE READ READ ONLY` 事务按当前目标读取参与者和来源审计，复用服务端旧源资格投影，分辨待准入、已准入、不参与和异常；分批上限 1000 人，人数和批数自动计算。`plan.json` 含受限主体数据，标准输出只给数量与计划 SHA。`REVIEW_REQUIRED` 包含缺源、状态/冻结不一致、未映射档位、目标缺主体或目标已有资格，不能据此新建计划覆盖；已有资格必须找到原计划和执行回执，先按原键恢复。

计划中的 `approvalBody`、`approvalKey` 供**既有正式审批**使用。NATIVE 可通过以下受控进程内入口申请、由第二位 Boss 批准、由第一位执行，并读回：

```powershell
node scripts/migration/run-local-distribution-qualification.mjs --approve --input <input.json> --input-sha <input-sha256> --plan <plan.json> --plan-sha <plan-sha256> --out <new-restricted-directory>
```

它复用当前版本 `mountAuthHandlers`、Better Auth 和完整 `handleAdminSecurity`，已有管理员 session 必须有效；决定和执行逐次验证原密码及 TOTP。原运行时仅装配至不监听的惰性接收器，NATIVE scope 只注入本进程审批执行器，禁止用于 HTTP 装配；没有汇聚、IM、资金 worker。模板不存在或候选明确为空时通过原模板入口和版本校验配置第二位 Boss；已有其他候选而第二位不合格时停止，不覆盖。凭据和 session 仅在内存使用，不写日志/回执。策略与审批状态分别读回，`NATIVE_POLICY_APPROVED_READBACK_PASSED` 才表示本次政策已发布。若返回 `STOPPED_APPROVAL_OUTCOME_UNKNOWN`，保留回执中的原 key，先沿审批恢复合同查证，不新建申请。

计划时 head 为空可以准备，不能据此说政策已经发布；已有不同 head 必须走现行政策变更合同，不直接覆盖。当前实现为候选，尚待独立合成与目标一致的隔离数据库验证后才能执行。

## 执行及恢复

执行前使用同一目标 OID/nonce 绑定的有效 Boss 会话 actor 文件；本地任务负责人基于实际计划及已成功读回的政策回执，通过同一入口生成新的受限 authority：

```powershell
node scripts/migration/prepare-local-distribution.mjs authority --input <input.json> --input-sha <sha256> --plan <plan.json> --plan-sha <sha256> --policy-receipt <successful-policy-receipt.json> --policy-sha <sha256> --review-ref <stable-review-ref> --attempt <stable-attempt> --request-id <stable-request-id> --out <new-private-dir/authority.json>
```

生成的内容包含：

```json
{
  "schema": "root-reviewed-legacy-distribution-qualification.v2",
  "approvedBy": "Root", "status": "APPROVED",
  "inputSha256": "<input sha>", "planSha256": "<plan sha>",
  "target": { "database": "zzsh_test_regression", "oid": "<registered oid>", "nonce": "<registered nonce>", "marker": "zzsh:regression-test:v1", "migrationRoleOid": "<registered role oid>" },
  "scope": "<same scope>", "policyId": "<plan policyId>", "policyDigest": "<plan policyDigest>",
  "policyReceipt": { "path": "<same target successful approval receipt>", "sha256": "<receipt sha256>" },
  "lock": 806006, "allowFinancialWrites": false,
  "notBefore": "<UTC within input window>", "expiresAt": "<UTC within input window, at most 30 minutes>",
  "approvalRef": "<local review reference>", "attempt": "<stable attempt>",
  "actor": { "userId": "<same new-platform admin>", "sessionId": "<same admin session>", "requestId": "<request id>" }
}
```

```powershell
node scripts/migration/run-local-distribution-qualification.mjs --execute --input <input.json> --input-sha <input-sha256> --plan <plan.json> --plan-sha <plan-sha256> --authority <authority.json> --authority-sha <authority-sha256> --out <new-restricted-directory>
```

执行持有现有维护锁、复用 `qualifyReviewedLegacyParticipants`，所有批在同一事务中校验来源、有效政策、权限、版本及 CAS，最后一次提交；运行期间反复校验封签构建。各批回执在最终 COMMIT ACK 前仅标“事务中已确认”，不能当作分别提交。成功提交后由新的只读连接逐主体核对资格、档位、冻结标记、来源和版本，并逐批检查原幂等记录及审计记录。`COMMITTED_ACK_READBACK_REQUIRED` 并非完成，`COMMIT_UNKNOWN` 不得重新提交或换幂等键：先保留原输入/计划/凭证/回执，以相同计划运行只读恢复：

```powershell
node scripts/migration/run-local-distribution-qualification.mjs --readback --input <input.json> --input-sha <input-sha256> --plan <plan.json> --plan-sha <plan-sha256> --out <new-restricted-directory>
```

只有 `EXACT_QUALIFICATION_READBACK_PASSED` 证明本计划的目标读回匹配；它不证明旧平台全量迁移、政策 UI 或真实渠道验收。计划无待准入主体时直接使用 `--readback`，不执行空写。若原输入、构建、目标、政策或窗口变化，先保存证据并重新计划，不能修改旧计划后当作原结果。
