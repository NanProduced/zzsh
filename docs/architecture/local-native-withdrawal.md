# 本地原生提现作用域

本契约仅描述显式 test/fake 的原生金融验收装配，不构成生产渠道、真实KYC或全历史可提现结论。未装配 scope 时保留原 R6 资源路径。

服务端通过 `createNativeWithdrawalScope` 创建不可伪造 token，绑定准确资源、主体、准入、目的地、意向和 payoutKey。允许集合复制保存；HTTP/ENV不能创建或修改 scope。每个实际连接检查数据库名、OID、marker、runtime角色及所需基础表。

新报价和预留在现有用户排他锁之后检查原生分佣债务；新预留检查仅位于幂等新执行分支。缺债务结构或异常事实不能解释为零。原已接受回执、原结果查询及失败释放不受新债务拦截，但仍校验原对象和原操作来源。释放或追回后必须以当前账本版本重新报价。

带 scope 的钱包和本地提现列表增加可选 `nativeWithdrawal`：

| 字段 | 含义 |
|---|---|
| `scope` | `NATIVE_REFERRAL_OBLIGATIONS_ONLY`，只覆盖这类债务 |
| `subjectInScope` | 主体是否列入本地作用域，不等于真实KYC或当前准入有效 |
| `recovery.knowledge` | `KNOWN` 或 `UNKNOWN`；未知金额为 null |
| `reservationState` | `NOT_IN_SCOPE`、`UNKNOWN`、`BLOCKED_BY_RECOVERY` 或 `REQUIRES_CURRENT_QUOTE` |
| `globalWithdrawable` | 始终 `UNKNOWN` |

`REQUIRES_CURRENT_QUOTE`仅允许请求新报价，不保证目的地、期限、额度、余额或版本校验通过。`available`是账本桶，不等于可提现。普通用户钱包不会因未列入提现scope而消失；旧无scope响应形状不变。


