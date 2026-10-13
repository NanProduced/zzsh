# 用户历史订单只读

GET /api/v1/orders/legacy 提供当前用户的历史租入/出租列表；详情为 /legacy/:id。API BFF 使用 /api/bff/user/orders/legacy，Web BFF 使用 /api/orders/legacy。原生订单入口保持原合同，历史与原生列表分开。

列表参数为 party=renter|owner（默认 renter）、page（默认1）、pageSize（默认20，最大100），可选 status（PENDING_PAYMENT、PAID、CANCELLED、COMPLETED、UNKNOWN）及 accountId。未知/重复字段被拒绝，不接收userId。返回 items/page/pageSize/total；数据库在本人角色筛选后计数与分页，按历史创建时间倒序、null最后、ID倒序。

详情返回order。服务端从正常user session核身份与冻结状态，并按快照owner/renter二次核归属；未认证401，无归属/不存在404，非法查询400。不暴露另一方身份/联系方式、凭据、source_snapshot或审计材料。

DTO保留稳定id、displayNo、source.origin=LEGACY、原状态与历史时间。amounts/payment/legacyAmounts复用精确Money字符串；缺证为null，refundChannelState固定UNKNOWN。已付取消可保留支付事实，历史应退不表示到账。readOnly=true、paymentOpen/cancelOpen=false、continuationCount=0、actions=[]，历史单不开放支付、取消续办、结算、退款或IM操作。

account只返回历史编号和readable；只有当前user仍是关联账号号主，才返回account.id供既有本人账号入口再次鉴权。租客保留编号文本。客户端通过orderApi.listLegacy与legacyDetail读取，不合并两来源各自的一页。
