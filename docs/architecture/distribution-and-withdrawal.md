# 分销与本地提现

邀请海报的 5% 与最低 2 元提现是业务要求。当前后端保留按受益人等级配置比例的模型；全等级经营政策、升级条件和真实提现渠道尚未核定，不能从测试示例推导生效配置。

租客和号主分别通过自己的直属 `DISTRIBUTION_LEADER` 确定受益人，读取**该受益人**等级的 renter/owner 比例。注册 `INVITER` 与分销上级分别保存；已有账号登录不重写注册来源。当前模型仅支持一层、无自身上级，ordinary/custom 可配置，fast 不计佣。最低计佣额与最低提现额互不替代。

付款原事务冻结政策版本、关系、受益人资格和比例。付款估算基数为 quote 的 platformFullProfit；最终佣金按不可变结算 posting 的 `platformContributionCents - compensationFeeCents` 计算，HALF_UP 到分，两角色总额不得超过该基数。不是订单支付总额的 5%。已有 APPLIED 付款只读原冻结依据；缺失保持 `MISSING_ORIGINAL_BASIS`，不能换政策追补。历史佣金观察和旧钱包期初不生成新佣金。

`createLocalDistributionRuntime` 只为明确的本地 test/fake 资源组装已有能力，返回可传入认证装配的 `auth` 与有界 `earnings`。构造时不连接数据库，不写政策、注册身份或准入数据，也不生成默认 5% 政策。最多接受 100 个唯一订单；实际付款还要求该订单原生创建审计和有效的精确 admission。无此显式装配时，原行为保持。

把返回的 `auth` 传入 `createApp` 的认证选项后，新注册、付款冻结、本人条款/佣金读与结算提交后计提使用现有模块。新原生钱包初始化仍需数据库端准入与同事务 INSERT 证明；缺失来源不能冒充零钱包。可选提现 binding 必须绑定 resource、subject、admission、destination、intent、payoutKey。

结算确认及管理员复核提交后从原 posting 幂等计提 PENDING 佣金。回调异常单独记为 UNKNOWN，不改变已提交的结算事实；恢复依据是原订单的不可变 posting、冻结 basis 和唯一经济根。维护方可先 `earnings.readOrder(pool, orderId)` 只读核原根与原转换回执，再对同一原来源恢复 `accrue`。不得换业务键、回填旧付款或把回滚请求当作写入未发生的证明。

到期维护方显式调用 `earnings.settleDue(pool, limit, requestId)`，limit 为 1–100。它只选该订单名单内、DB 时钟已到期的 PENDING 根，每个根在原锁、版本、到期复核和独立事务内 SETTLE。异常返回 UNKNOWN 并停止本批，`notAttempted` 标出未执行数；先读原回执，再安排恢复。默认不启动后台循环，也不在 GET 中驱动资金写入。只有 SETTLE 的真实分录才能把 pending 转到可用余额。

本地提现策略最低 200 分；银行固定费 100 分、支付码 2% HALF_UP，日额度按北京时间计算。报价/预留仍须核定钱包覆盖和余额、有效准入、精确目标、钱包版本及未清分销追偿。提现能力为 LOCAL_CONTROLLED，SQL 持久化的失败/超时场景不代表银行或支付码到账；全局 withdrawable 保持 UNKNOWN。真实渠道、真实身份与目的地验证另行接入验收。

外部收款、退款及银行卡代付只对接国内[汇聚支付 JoinPay](https://www.joinpay.com/)。旧银行卡提现使用单笔代付；旧微信/支付宝收款码分支是后台人工确认记录，不能认作汇聚自动出款。旧代码的非生产配置会把代付金额改为 0.01 元，但仍请求生产地址，不能作为沙盒运行方式。新适配保留原请求号、金额、商户作用域、验签、幂等和原号查单；收款成功、退款应付、退款到账及代付终态分别核定，不复制旧代码把请求返回直接当到账的行为。

汇聚官方技术资料列出的聚合支付联调地址为 `https://trade.joinpay.cc`，并要求[联调使用专用密钥，禁用生产密钥](https://github.com/Joinpay-Official/hj-payment-skills/blob/main/hj-joinpay-pay-shared-base/governance/credential-boundary.md)。是否另发测试商户号以及单笔代付联调范围须由汇聚确认；现有本地受控收款和提现不构成汇聚协议适配或沙盒验收。上述本地手续费也不作为已批准的正式渠道费率。
