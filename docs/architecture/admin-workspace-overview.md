# 管理工作台经营概览

首页使用 `GET /api/v1/admin/dashboard?range=today|7d|30d`（Admin BFF `/dashboard`），默认30天，响应 `admin.dashboard.v1`。服务端按有效能力派生经营、运营或客服编排，不按角色名称授权。经营和运营均展示确认收款（含押金）、报价预估价差、已结算平台贡献及已付款订单数；运营另含审核、接待等当前待办。无对应金额权限时仍保留指标位置并返回不可读状态，不自动授予运营财务权限。

金额与计数保留精确整数字符串，日期按北京时间。报价预估价差只取合格冻结报价，缺失或格式不符时为部分已知，不能填0；它与已结算贡献不相加，也不称净利润。经营同比只比较可信期间流量，当前待办不生成虚构的历史比较。进入订单明细沿用服务端给定的相同付款确认时间边界。数据读取和出参前授权复核均使用有界只读事务，会话锁定、权限或游戏范围变化时不发送先前数据。

图表统一经 `components/ui/chart.tsx` 使用 Recharts 3.8.0 与选择采用的 EvilCharts MIT 核心；坐标转换不改变原始金额，Tooltip及备用表格显示原值。自由布局及其接口已移除，旧布局表仅保留，不再读写。

## 兼容汇总读取

`GET /api/v1/admin/workspace/overview` 与 Admin BFF 的 `/workspace/overview` 共用同一读取。`range=today|7d|30d`，缺省7d；按北京时间自然日开始，到同一只读事务的观察时刻结束。响应版本为 `admin.overview.v1`，含 `observedAt`、`period`、游戏范围、指标和每日趋势，使用 `no-store`，不调用渠道或推进资金状态。

指标逐项授权：用户档案统计需 `user.directory.read` 且全游戏范围；账号统计需 `supply.rental_account.read`；审核队列需 `supply.review.read`；订单统计需 `order.read` 并应用同一游戏范围；聚合收款金额额外要求 `finance.read`。客服统计限定当前云信 App，进行中接待只计本人；全局等待接待需全游戏范围。权限、空游戏范围或未装配时分别返回 `FORBIDDEN`、`NO_GAME_SCOPE`、`UNAVAILABLE` 和 `value:null`，不能显示为0；没有订单读取范围时不返回趋势。

计数与金额均为十进制整数字符串，单位分别为 `COUNT`、`CNY_CENTS`。`usersNew` 是本地建档时间统计，包含导入，不等于旧平台注册；`accountsPublished` 仅统计当前版本 `PUBLISHED`，不保证当前可租。趋势仅含原生订单创建和本站已接纳的付款确认；确认必须是该订单当前引用的 `APPLIED`、CNY 记录。历史订单载入数量单列，不混入新平台经营趋势。本站确认收款、渠道结果、银行到账、收入和利润分别建模，本接口不推导利润或到账。

上述 `/workspace/overview` 保留为兼容汇总读取，供首页经营指标及现有调用方复用；不恢复自由布局。各管理员只看实际权限及范围内的指标和待办，角色称呼不授予额外经营或财务权限。
