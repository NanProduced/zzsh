# release_production_0153 生产新装基线

基于 canonical 前 154 份迁移（至 0153_stored_opening_cached_observations）形成的空库生产投影。表和有效列均含写入数据库目录的中文 COMMENT。

本基线不部署测试元数据、已下线的工作台布局或纯模拟资金辅助表；正式渠道守卫、旧来源、责任和审计表保留。

剥离的业务 schema 表：

- `zzsh_iam.admin_workspace_layout`
- `zzsh_order.local_financial_sandbox_registration`
- `zzsh_order.local_controlled_refund_operation`
- `zzsh_order.local_controlled_refund_evidence`
- `zzsh_order.controlled_payment_declaration`
- `zzsh_order.controlled_payout_notice`
- `zzsh_order.controlled_payout_operation`
- `zzsh_order.withdrawal_admission`
- `zzsh_order.withdrawal_destination`
- `zzsh_order.withdrawal_intent`
- `zzsh_order.withdrawal_provider_fact`

已装 canonical 或旧 initial 的数据库沿各自记录升级。生产投影只用于空库；版本账记一条 baseline 及后续 canonical 增量。
