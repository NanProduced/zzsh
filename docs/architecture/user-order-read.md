# 用户统一订单读取

用户租入/出租页面使用 `GET /api/v1/orders/unified`，API BFF为 `/api/bff/user/orders/unified`，Web BFF为 `/api/orders/unified`。原生列表及详情端点保持兼容；建单结果确认等原生恢复链仍使用原生读取。

## 输入与分页

仅接受party（renter/owner，默认renter）、status（PENDING_PAYMENT/PAID/COMPLETED/CANCELLED/UNKNOWN）、accountId、limit（1–100，默认20）、cursor，拒绝重复字段和客户端userId。身份及活动状态由正式会话与事务内授权确认。

同一SQL语句先按本人/party/状态/账号过滤两类记录，再以创建时间降序、空时间末尾、内部来源降序、ID降序作唯一排序；来源/ID使用C排序。游标绑定主体、party、状态、账号、limit与时间/来源/ID位置，错误或跨范围游标409。返回items、nextCursor、limit，不宣称总数。

## 展示及动作

原生记录沿既有projectOrder；已承接记录沿最小用户投影，不读取或返回对手个人资料、完整source_snapshot和审计材料。DTO保留source.origin用于去重与详情定位，用户界面不渲染来源切换、标签或工程说明。

只读记录保持readOnly=true、paymentOpen=false、cancelOpen=false、actions=[]；原金额/缺值与退款到账UNKNOWN保持。号主列表不能拿租客支付金额替代号主收入。旧详情深链继续可读，返回统一列表并保留业务筛选/账号上下文。

本合同不开放旧在途单续办，不改变交易写接口、幂等及原生UNKNOWN恢复责任。运行环境是否装配须单独核对。
