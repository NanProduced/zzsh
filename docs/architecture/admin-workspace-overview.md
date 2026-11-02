# 管理工作台经营概览

`GET /api/v1/admin/workspace/overview` 与 Admin BFF 的 `/workspace/overview` 共用同一读取。`range=today|7d|30d`，缺省7d；按北京时间自然日开始，到同一只读事务的观察时刻结束。响应版本为 `admin.overview.v1`，含 `observedAt`、`period`、游戏范围、指标和每日趋势，使用 `no-store`，不调用渠道或推进资金状态。

指标逐项授权：用户档案统计需 `user.directory.read` 且全游戏范围；账号统计需 `supply.rental_account.read`；审核队列需 `supply.review.read`；订单统计需 `order.read` 并应用同一游戏范围；聚合收款金额额外要求 `finance.read`。客服统计限定当前云信 App，进行中接待只计本人；全局等待接待需全游戏范围。权限、空游戏范围或未装配时分别返回 `FORBIDDEN`、`NO_GAME_SCOPE`、`UNAVAILABLE` 和 `value:null`，不能显示为0；没有订单读取范围时不返回趋势。

计数与金额均为十进制整数字符串，单位分别为 `COUNT`、`CNY_CENTS`。`usersNew` 是本地建档时间统计，包含导入，不等于旧平台注册；`accountsPublished` 仅统计当前版本 `PUBLISHED`，不保证当前可租。趋势仅含原生订单创建和本站已接纳的付款确认；确认必须是该订单当前引用的 `APPLIED`、CNY 记录。历史订单载入数量单列，不混入新平台经营趋势。本站确认收款、渠道结果、银行到账、收入和利润分别建模，本接口不推导利润或到账。

页面复用现有工作台与受权处理入口。各管理员只看实际权限及范围内的指标和待办，角色称呼不授予额外经营或财务权限。
