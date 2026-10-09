# 信用与号主保证金运行合同

信用/保证金属于显式部署能力。`CREDIT_GUARANTEE_ENABLED`只接受`true`或`false`，默认`false`。关闭时不挂信用路由，不在新用户注册事务访问信用表，正式供给继续原有G0政策/proof门禁；这不表示既有保证金责任消失或可删除。读取/处理既有信用责任应使用已审schema就绪的受控启用环境，不能通过清库解除。

开启前必须完成正式迁移`0067_credit_guarantee_contract`和`applyRuntimePrivileges`。启动检查七张表可读、`zzsh_credit.runtime_contract_version()=1`及runtime不能CREATE该schema；缺失/部分部署/权限错误阻止启动。运行中依赖故障维持UNKNOWN并拒绝新发布/确认/建单，不退回免缴。仅设置开关不执行迁移、赋权或回填。

新schema为已有用户建立100分初始状态和INITIALIZED事件，并定义四项管理权限，不给管理员自动授角色/游戏范围。启用后的新用户注册在原事务初始化信用；分销/原生钱包初始化顺序和独立准入边界保持。保证金沿既有经济根、finance_event与ledger记账，不增加第二总账。

正式发布、个人确认和建单共用信用/coverage权威读取：credit state与存在的requirement通过同一业务PoolClient持FOR SHARE，写方FOR UPDATE；锁至事务提交/回滚释放。信用/coverage版本封入既有guarantee.reference摘要，个人ruleRefs仍严格五键，listingHash完整绑定原发布资料。启用状态变更应先处理未决责任，不静默换key或签名正文。

原保证金支付意图先校主体/账号，再按原key读取冻结回执；当前政策/版本异常不能截断原回执恢复。只有没有原回执的新请求读取当前权威依据。Admin明细先按game scope筛requirement，支付/退款各自返回完整历史，不以最新摘要替代旧事实。

0067保持原opening/提现/分佣规则，保证金CAPTURE/REFUND不增加钱包revision；runtime撤销表级和旧列级宽权限，再授精确写列，信用事件/对账记录只追加。该语义仍须在合法order-finance资源完成真实组合验证，纯测试或DDL静态核验不替代PG锁等待和账平证据。

真实汇聚提交/回调未开放。开启信用能力不启用真实支付、短信、实名或云信，受控结果记录仍受既有test/fake能力和资源范围约束。正式schema应用、既有65/draft结构采用、跨金融revision和关键F3 UI验收是独立门槛。
