# 开租与结算确认

写接口只在受控测试配置下注册：`ZZSH_SETTLEMENT_RECORDING=controlled`、测试 profile、fake provider，且当前库是 `zzsh_test_order_*`、运行角色是 `zzsh_order_*_r`。不满足时这些路径不存在。生产默认关闭。

`ready: true` 只表示这一版结算单已经具备后续过账条件。响应里的 `postingAuthorized` 固定为 `false`，`feeDeducted` 固定为 `false`。本接口不把订单改为 `COMPLETED`，不释放账号占用，不写余额、退款或已扣包赔费。

买家和号主使用 `/api/v1/orders/:orderId/...`。有本单资格的客服使用 `/api/v1/admin/orders/:orderId/...`。用户 BFF `/api/bff/user/orders/...` 和管理 BFF `/api/bff/admin/orders/...` 转发到同一业务函数。写请求需要 `Idempotency-Key`。

- 客服 `POST .../openings` 提交期初数量。数量必须与已付款订单的冻结报价行一致，否则不保存。受权 `GET .../settlement` 返回每一版清单的数量、冻结报价上的单位和计价类型，以及报价/收款摘要。买卖双方凭读到的版本号 `POST .../openings/:openingId/confirm`。付款、建群、首响和消息不会开租。已确认清单不能覆盖。
- `POST .../settlement-preview` 返回服务端明细和 `versionHash`。这个 hash 绑定当前结算版本、决定进展，以及最新 intake 的 `id`、单调 `versionNo`、状态和关联费用版；没有申请时绑定 `null`。因此同数量的新申请、`OPEN` 转为 `CLASSIFIED`/`SUPERSEDED` 或新申请替代旧申请都会使旧 hash 失效。`POST .../settlements` 必须带回刚读到的 hash。正常结算由服务端按消耗比例判定；发起方这次提交就是自己的确认，另一方 `POST .../settlements/:versionId/decision`。
- 消耗低于 70% 时，当事人用预览返回的数量凭据提交开租后的剩余量。服务端记下发起人，不生成费用版本，也不写成任一方已经确认。客服 `POST .../settlements/classify` 指定 `TENANT_VOLUNTARY_EARLY` 或 `OWNER_OR_ACCOUNT_EARLY` 后才生成可展示的费用版本。双方确认之后，客服才能 `POST .../review`。
- 有 `OPEN` intake 时，读取的 `currentRequest` 指向该申请，`settlement` 返回 `null`，`ready=false` 且包含 `SETTLEMENT_INTAKE_PENDING`；旧费用版和确认仍保留在 `versions`，但不是当前可过账依据。没有待处理申请时，`currentRequest` 指向当前结算版本。
- 客服按新预览合法改量时，分类只将预览绑定的确切 `OPEN` intake 关联到新费用版；原申请数量保留，费用版快照与成功审计记录来源申请及分类数量差异。旧申请、版本和确认保留为历史。
- 同一读取返回全部历史版本，包含拒绝记录。
- 人工调整 `POST .../settlements/adjustments` 只接受两个拟调整净额和原因。系统原算、拟调整值、差额和批准申请分列保存。批准走既有审批，申请人不能自审。双方确认和提前复核都要求这笔申请已经由其他人批准、未过有效期且载荷仍是当前版本；拒绝不受批准阻挡。即使存储状态尚为 `APPROVED`，超过有效期也不能新确认或显示为ready，旧预览须重新读取；原幂等成功回执仍按历史结果重放。本包没有资金执行器，`approval.request.execute` 对未过期的已批准申请返回冲突，过期按既有IAM规则处理。拟调整净额之和超过实收时拒绝，不新增出资、不挪押金。
- 客服改数量、原因或净额都会生成新版本。旧确认、复核和批准留在旧版本上。

客服写操作需要 `order.settlement.write`，并且是该订单群里 `JOINED` 的客服。`order.read` 只能查看，不能写入。正式建单仍拒绝选择全额包赔；这类订单不能从本接口进入结算。
