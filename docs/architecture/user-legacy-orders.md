# 用户历史订单与统一读取

`GET /api/v1/orders/unified`在服务端对原生与历史订单统一筛选、排序及游标分页，返回items/nextCursor/limit，Web经`/api/orders/unified`读取；客户端不能拼接两种来源各自的一页冒充统一分页。原生订单入口保持原合同。

专用`GET /api/v1/orders/legacy`仍提供当前用户的历史租入/出租列表；详情为`/legacy/:id`。API用户BFF前缀为`/api/bff/user/orders`，Web BFF前缀为`/api/orders`。

专用legacy列表参数为 party=renter|owner（默认 renter）、page（默认1）、pageSize（默认20，最大100），可选 status（PENDING_PAYMENT、PAID、CANCELLED、COMPLETED、UNKNOWN）及 accountId。未知/重复字段被拒绝，不接收userId。返回 items/page/pageSize/total；数据库在本人角色筛选后计数与分页，按历史创建时间倒序、null最后、ID倒序。

详情返回order。服务端从正常user session核身份与冻结状态，并按快照owner/renter二次核归属；未认证401，无归属/不存在404，非法查询400。不暴露另一方身份/联系方式、凭据、source_snapshot或审计材料。

DTO保留稳定id、订单原单号displayNo、source.origin=LEGACY、原状态与历史时间。amounts/payment/legacyAmounts复用精确Money字符串；缺证为null，refundChannelState固定UNKNOWN。legacyAmounts.refund是原单退款金额记录，不是当前净应退或未结责任，也不代表渠道到账；已核责任由续办投影单独读取。已付取消仍保留支付事实。基础历史投影为readOnly=true、paymentOpen/cancelOpen=false、continuationCount=0、actions=[]，不会因读取成功开放业务写入。

订单号与账号号分开。account.displayNo只取已持久分配的canonical号（日期ZZ号及兼容既有AC号），不回退旧账号号或内部ID；只有当前user仍是关联账号号主，基础历史投影才返回account.id、readable=true及真实当前标题。无真实标题时title=null，不把系统占位文案写入该字段。其他主体的readable=false、account.id/displayNo和title为null；历史当事关系不能授予当前私有账号资料权限。公开详情另按[账号可见性](account-visibility.md)核验。

orderFacts只读投影本单冻结资源、实际租赁截止及来源事实。列表、总览和详情无可读真实标题时可显示明确标注的“订单资源”摘要；没有冻结事实则显示资料未提供，不推算租期或补数量。资源数量与单位不重解释（顶级保险卡保持天），该摘要不是当前账号库存、公开资格或新报价。

续办使用独立的`/legacy/:id/continuation`读取与命令接口，另核原来源、当前证据、阶段、身份/对象权限及幂等；基础订单只读DTO不代表续办未实现，也不证明该单已经具备续办条件。详见[旧交易续办与责任边界](legacy-trade-continuation.md)。旧金额、原单号及原始快照保持，不能因账号资料不全而删除或重算订单。
