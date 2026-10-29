# 公开交易统计读取

Web 首页保留累计成交、当前上架与昨日访问的原数据源、单位和未知状态。横栏右侧改为独立内容 API 的「平台动态」轮播；下述 recent 完成事实接口继续保留兼容，其口径不因 UI 调整而改变。

`order/public-trade-activity.ts` 提供 `createTradePublicActivityReaders({pool,gate,bindings})`，供内容聚合入口只读注入。三个方法与内容provider合同一致：count返回`{value,asOf,scope}|null`，recent返回`{items:[{id,game,title,priceLabel}],asOf}|null`，最多20条。来源未核返回null；数据库/schema或绑定错误抛错，不伪装为零或合法空。接线与真实来源验收仍须独立完成。

`TradeActivityBindings`由现有受审导入manifest和测试cohort清单组成，仅供可信启动装配，不接受HTTP输入。资源tuple须实查相等；测试订单/账号/旧ID按明确清单排除，不凭名称判断。旧来源须有完整cutoff、提取SHA、已映射snapshot数量及按`legacy_id:source_digest:binding_digest`的C排序SHA256、隔离数量/集合摘要与原证据引用；实际目标集合不符即未知。它不新增签名、审批、token、导入或逐单授权体系，也不把marker当完整来源证明。

本地联验启动可显式提供`PUBLIC_TRADE_ACTIVITY_BINDINGS_FILE`与`PUBLIC_TRADE_ACTIVITY_BINDINGS_SHA256`：仅test、非production、本机local-compose/55432及`zzsh_test_*`资源可用，文件须位于运行目录`.secrets`的真实路径内、至多8MiB、原字节SHA一致。启动时校验结构及数据库/角色绑定，读取时仍核实际资源和来源覆盖。未配置时不装配统计来源；配置缺项或错误直接拒绝启动，不退回默认数字。该临时文件接线不等于生产配置或真实指标已验收。

累计口径：原生订单COMPLETED、对应settlement_posting和APPLIED付款；现有CONTROLLED付款全部排除，不冒充真实成交。旧订单须已付、有效旧状态或续办head为4；完成时间取原业务完成时间或真正CONFIRM时间，不取导入日期。原生ID和旧来源tuple分别唯一，隔离与test排除写入scope。缺原完成时点或完整来源时不返回总数。

当前上架口径：正式当前发布版本的公共候选，共享PUBLIC_CANDIDATE与STANDARD谓词，随后调用现有完整`readPublicListing`链复核身份、有效规则、接受/媒体、保证金和共同占用。历史LEGACY_READ_ONLY展示不计当前上架。分页扫描完结才返回精确数量；超过10000候选、门禁UNKNOWN返回未知，不能返回已扫描前缀作为近似数。上架读取独立于旧订单coverage。

最近播报是**上述完成事实中、当前仍可正式公开的账号子集**，不是全部历史成交。候选SQL先要求存在该时点的正式发布记录，避免逐单加载不可能公开的历史账号，随后仍执行完整公开守卫。按业务完成时间倒序、来源/稳定ID排序，过滤私有和历史只读账号。标题/游戏来自现有公开投影；价格标“原单租费”，原生取冻结rental_amount，旧单沿既有订单读取的goods_money+expend_pay_money精确相加，不取当前报价、押金、扣留、佣金或号主内价，也不声称最终消费、实际入账或渠道到账。没有可靠金额/安全公开标题不造播报。输出使用匿名稳定hash ID，不含原单号、主体、电话、源快照或内部财务字段。

读事务复用公共列表的REPEATABLE READ/READ ONLY。统计调用显式启用严格读选项，让原先公共门禁内部捕获的真实DB错误继续抛出；普通页面默认行为保持。每桶有自己的asOf，不能当三桶来自同一个跨请求快照。尚须真实PG/性能/覆盖集合与浏览器验证；目前没有批准的实际bindings时，不关闭对应数据验收叶。昨日访问没有合法来源，继续UNAVAILABLE。
