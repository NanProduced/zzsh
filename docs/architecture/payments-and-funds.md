# 支付与资金领域规格

业务规则与资金真值集中在 API。Web、原生客户端、小程序经各自 BFF 调用同一合同；浏览器不直连汇聚，不决定价格、付款成功、退款到账或提现资格。本文是总入口；[结算确认](settlement-confirmation.md)、[分销与本地提现](distribution-and-withdrawal.md)、[本地提现作用域](local-native-withdrawal.md)、[旧单续办](legacy-trade-continuation.md)分别保留专项规则。

收款、退款、银行卡代付适配已实现，只有完成对应商户、产品、协议、身份和运行装配后才可使用。默认关闭是当前准入边界，不是永久产品限制。源码、离线测试、本地受控账务、供应商验证、银行到账与真实迁移是不同验收层次。

## 1. 业务对象与来源

| 对象 | 唯一含义与关联 |
| --- | --- |
| 原生订单 | 冻结双方、账号、报价与条款；订单号不是渠道流水。付款后由真人客服履约，建群或首响不等于开租。 |
| 收款请求 | `payment_request` 持久保存原商户单号、稳定商户、金额及原请求映射；同订单重试取原请求，不换号绕过 UNKNOWN。 |
| 渠道尝试/观察/证据 | 保留每次派发、查询、通知、验签与绑定判断；观察可追加，旧失败、冲突和 UNKNOWN 不覆盖。 |
| 付款确认 | `payment_confirmation` 的 `APPLIED` 是本站唯一接纳；`REVIEW_REQUIRED` 是需要复核的原款，不是可重复消费的付款。 |
| 结算与应退责任 | 正常过账、异常收款责任、未开租终止责任分别建模；无正常 posting 不代表无应退责任。 |
| 退款意图/提现意图 | 冻结原款或原目标、政策、预算与幂等身份；意图建立不代表已经提交供应商。 |
| 经济根/事件/分录 | 唯一来源、不可变事件及平衡分录决定本站账务；页面状态不创造余额。 |

资金防重使用渠道、稳定商户身份、渠道流水组成的经济身份；profile、密钥版本轮换不产生第二笔资金。产品、原商户号和流水同时参与相应绑定，不能跨收款/退款/代付混查。订单号、旧支付号、退款号、提现批次号及渠道流水分别保存。

`LOCAL_CONTROLLED`/`CONTROLLED_TEST` 是本地受控来源；`SYNTHETIC_PROTOCOL` 是离线协议证据。二者不能改名为真实 JOINPAY 款。已保存的供应商终态仍须分列其可信依据、本站接纳/核销及银行到账；没有相应依据时返回 null/UNKNOWN。

## 2. 收款与订单状态

用户支付读取分为三层：`paymentAction` 是当前可执行的受信支付动作，`request` 是渠道请求进度，`payment` 是本站接纳事实。同步下单返回支付参数不等于付款；渠道报告成功也不等于本站已接纳。

| 请求状态 | 语义 |
| --- | --- |
| `SUBMITTING`、`UNKNOWN` | 派发中或结果未确定；保留原号、原体、原键，不能直接转失败重建。 |
| `ACTION_READY`、`PROCESSING_UNCONFIRMED` | 已取得支付参数或渠道仍处理中；支付动作还须通过 URL/host 等安全门禁。 |
| `REJECTED_BY_CHANNEL` | 取得本操作可识别的拒绝依据；不能用超时或无响应代替。 |
| `CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE` | 成功证据待本站唯一接纳。 |
| `ACCEPTED`、`REVIEW_REQUIRED` | 本站已接纳或转复核的请求终态；迟到的同步响应不能使其降级。 |

回调和主动查单都按原商户、原号、金额、币种及协议 profile 核验，合法事实经 `confirmOrderPayment` 唯一接纳。重复通知不重复记钱；同资金键不同事实为冲突，同订单额外流水保留独立复核记录。取消/超时后的迟到付款不复活订单或占用。

订单 `CANCELLED` 不统一解释为未付款：普通未付取消没有实付事实；合法 `PRESTART_TERMINATED` 保留原 `APPLIED`、实付金额和付款时间。订单状态、退款进度和银行到账不能相互替代。

## 3. 退款责任与结果

| basis | 原责任与命令边界 |
| --- | --- |
| `POSTING` | 从已完成订单的不可变结算 posting 取净应退责任；支持部分/累计分配，不能超过原款及剩余责任。正常结算即时到期，提前结算按 posting 保存的到期时点执行，不由客户端重启期限。 |
| `REVIEW_CONFIRMATION` | 已核实的迟到/额外原款，经受权人员复核后全额原笔退；不造正常结算或分佣冲回。缺可信原款、错绑或争议继续复核。 |
| `PRESTART_TERMINATION` | 已付未正式开租：租客或号主申请，合法客服核实未交付/使用、无争议；在原锁链内重核原款、无正式开租/过账/待决调整/资金分佣后，取消订单并记录全额应退责任。 |

未开租终止不伪造 `COMPLETED`、开租或正常 posting。冻结分佣依据不是资金计提；若已出现需要核对的真实资金佣金，拒绝自动终止并转复核。租客原订单押金包含在原付款及应退核算中；号主上架保证金是另一业务，独立真实收退不在本范围。

退款责任、意图分配、渠道终态和本站核销分开：

- 意图状态为 `READY / SUBMITTING / UNKNOWN / PROCESSING / REVIEW_REQUIRED / SUCCEEDED / FAILED`；预算为 `ALLOCATED / CONSUMED / RELEASED`。
- 已分配合计包含已核销的 `CONSUMED`；`remainingCents` 表示尚未分配责任，不是未到账金额。失败释放后可按明确命令重试，但原责任/经济根不重复建立。
- 首派只沿原商户号、原款和原目标；同原商户号对应多个不同流水、而退款协议无法指定原流水时，返回 `ORIGINAL_ORDER_NO_AMBIGUOUS`，不猜选、不转账替代原路退款。
- 首派前在共同锁内重核歧义；阻断不领取 lease、不取钥、不外呼，也不释放原预算。已派发的 QUERY/NOTIFY 继续按原退款号恢复。
- 渠道成功证据与本地核销在原意图/预算/唯一流水上核对；审计或账务失败必须回滚。保存证据未重验时不能升级为“银行到账”。

`firstSubmit=DISPATCHED` 只证明有过提交尝试。未开租退款的 `completedLocallyAt` 只在完整责任全额本地核销后产生；IM 归档消费者不能使用取消时间代替，也不能以该时点宣称银行到账。

## 4. 余额、分销与提现

可用余额只计已接纳来源的可用账本桶，不是资产总额或全局可提现额。待结佣金、提现预留、退款应付、号主保证金分别展示；来源覆盖不完整或存在追偿时保持未知/阻断，不补零。

付款事务冻结分销政策、关系和资格；真正佣金按不可变结算 posting 及原冻结依据计提、成熟和入账。[分销专项](distribution-and-withdrawal.md)维护计算基数与 HALF_UP 规则，不能把订单总支付额、冻结估算或历史观察当新的佣金。旧已结/已覆盖收益不再计提，未清追偿阻断新提现，不阻断合法原回执恢复。

银行卡绑定保存加密资料和安全掩码；用户声明不等于银行归属验证。提现必须核当前可信实名/成年状态、服务端有效政策、业务日配额、资金覆盖/余额、原目标及商户产品。申请冻结当时的目标；之后换卡不能改变旧申请的去向。

| 提现状态/资金状态 | 语义 |
| --- | --- |
| `RESERVED`、`SUBMITTING`、`PROCESSING`、`UNKNOWN` | 预留或渠道执行中，原资金继续占用，不能因超时释放并再次出款。 |
| `CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE` | 渠道报告成功但本站扣账/接纳尚待完成。 |
| `SUCCEEDED` / `PAYOUT_POSTED` | 已取得并接纳所需终态，本站扣账记录成立；是否银行到账仍按独立证据判断。 |
| `FAILED` / `RELEASE_POSTED` | 已核实可释放条件后解除预留，不以缺响应或旧 lease 释放。 |

申请额 `gross = net + 用户政策手续费`；渠道成本另列，不以政策费推算。最低额、最高额、固定/比例费、日配额、审核方式来自有效版本化政策；本地测试的金额和费率不是正式经营政策。日界/成熟期由服务端确定，过期政策或身份不能凭页面缓存续用。

## 5. API、BFF 与权限

以下为核心接口，错误和金额基础合同见 [API v1](api-v1-contract.md)。用户以当前服务端会话和对象归属授权；Admin 另按操作权限、游戏、订单团队或财务商户范围授权。隐藏按钮不构成权限。

| 方法与 API 路径 | 用途及授权 |
| --- | --- |
| `POST/GET /api/v1/orders/:id/channel-payment-requests` | 本人建收款请求/读本地支付动作及事实；旧 CONTROLLED 路由保持兼容，JOINPAY 旧客户端明确拒绝升级。 |
| `POST /api/v1/orders/:id/channel-payment-requests/query` | 本人按原请求查单，不首派/换号；可信成功可推进唯一接纳。 |
| `GET /api/v1/orders/:id/refunds` | 本人租客读取正常/异常责任及退款事实，不调用 Admin 命令 GET。 |
| `GET /api/v1/orders/:id/prestart-termination`、`GET /api/v1/admin/orders/:id/prestart-termination` | 当事人或有订单范围的 Admin 本地读取；号主不获租客退款金额，Admin 金额按财务读权或合法审核资格裁剪。 |
| `POST /api/v1/orders/:id/prestart-termination/requests` | 当事人申请，带当前版本、原因和幂等键。 |
| `POST /api/v1/admin/orders/:id/prestart-termination/:termId/review` | `order.settlement.write` 与订单/game/team 范围；核准另需明确未使用无争议声明。 |
| `GET/POST /api/v1/admin/orders/:id/refunds` | 已授权结算操作者读取命令上下文/分配正常退款；`finance.read` 不单独授予该接口的命令权限。 |
| `POST /api/v1/admin/orders/:id/refunds/abnormal` | 人工复核指定原 confirmation，只建本地全额原款责任/意图。 |
| `POST /api/v1/admin/orders/:id/prestart-termination/:termId/refund-requests` | 按已核准原责任创建意图，不直接出网；返回 `NOT_SUBMITTED`。 |
| `GET/POST /api/v1/users/me/withdrawal-bank-binding`、`GET .../receipt` | 本人绑卡/读取/原键恢复，写入沿当前版本、幂等和审计。 |
| `GET /api/v1/users/me/channel-withdrawals/options`、`POST .../quote`、`POST ...`、`GET .../:id`、`GET .../receipt` | 本人资格、报价、预留、详情及恢复；创建重核身份、政策、钱包版本、配额和目标。 |
| `GET /api/v1/users/me/withdrawal-history` | 分来源读取历史/受控/原生提现，不能合并不同游标或补造旧目标。 |
| `GET /api/v1/admin/finance/{lookup,period,export,subjects/:id,documents/:ref}` | 既有资金权限与对象范围；账内核对不等于商户期间全量对平。 |
| `GET /api/v1/admin/finance/channel-evidence/{orders/:id,withdrawals/:source/:id,originals/:original}` | 读本地保存的渠道证据，服务端推导商户/对象范围，普通读无外呼。 |
| `GET /api/v1/admin/finance/merchant-accounts/:merchantId` | 明确财务及逐管理员商户范围，读本地 AVAILABLE/COLLECTION 快照，不自动刷新。 |
| `POST /api/v1/admin/joinpay/{collection-requests,refunds,withdrawals}/:id/query-only` | 强制原单 QUERY，不能首次 SUBMIT。收款/退款复用订单结算命令权；提现需 `finance.withdrawal.query` 及财务、原商户范围。 |
| `GET /api/v1/payments/joinpay/notifications`、`GET /api/v1/refunds/joinpay/notifications`、`POST /api/v1/withdrawals/joinpay/notifications` | 显式装配的供应商通知；验签、原号/金额绑定及幂等是认证依据，不信任来源参数自报成功。 |

Nest 用户 BFF 使用 `/api/bff/user/...`，Admin 使用 `/api/bff/admin/...`；Web 订单代理使用 `/api/orders/...`。客户端传期望主体只能用于防串身份，不能替代同 Cookie 的服务端会话核验。BFF 不连交易库、不重算金额、不保存或向浏览器返回商户钥。

资金 lookup 接受 `finance.read` 或 `finance.document.read`；单据详情要求 `finance.document.read`，期间/导出/主体/商户账户要求 `finance.read`。订单关联还须 `order.read` 及其游戏/对象范围；渠道详情另核服务端逐对象商户范围，财务读权不自动产生通配商户授权。未开租读取的审核资格例外仅用于本单命令上下文，不扩大其他财务读取权。

普通 GET 只读本地业务事实和已保存证据，返回来源、观察/可信时间、覆盖和未知原因。主动同步是可追溯命令，可能发生本站付款接纳、退款核销或提现扣账/释放；不能藏在页面 GET 中。QUERY-only 对从未派发原单返回 `NOT_DISPATCHED`，不是“查询后顺便下单”。

## 6. 金额、时间与恢复不变量

- 金额真值为整数分/numeric，API 的 `*Cents` 是精确整数十进制字符串；元金额按 CNY/unit/scale 合同传两位文本。单价保原精度，只在规定边界精确落分；不得浮点乘100、提前截位或按现政策重算历史。
- 服务端时间为事实依据，持久化与接口明确时区，微秒不无故降为毫秒。渠道无时区原文按已核 profile 解释，不能猜测展示时区；成熟期不因迁入或重试重启。
- 身份/权限与对象复核包含原键重放。相同作用域的同键同体恢复原结果，异体同键409；原键只解决命令重复，不替代渠道流水和经济根的全局防重。
- 锁序按路径而非一个通用锁：退款共同资金键→必要的原商户号锁→用户→原意图；提现用户/钱包版本→原意图→渠道流水；付款接纳复用 dispatch/资金/邀请关系/用户/账号/订单锁链，正式原号接纳与退款首派共享原号串行点。旧续办按排序当事人/受益人用户→游戏→mapped-order advisory→head/duty取锁，订单锁后不补账号锁；供给/新建单的账号锁链另按该路径执行。不能持后序锁再补前序锁。
- 领取与写回用数据库时钟、owner、lease 版本和有效期；旧 lease 只能保留迟到/STALE 观察，不能覆盖新任务、重复记钱或释放预算。网络执行不长期占用数据库事务。
- 业务、预算、账务、审计和业务幂等回执按领域事务共同提交。COMMIT 响应未知保留 UNKNOWN、原号/原键/原体，独立查持久事实恢复；后续回滚 ACK 或新查询成功不能改写原调用结果。
- 浏览器不能持久保存新资金申请的原请求时阻止首次提交；恢复资料坏损或冲突时禁止换键重建。历史管理员请求按身份/会话隔离，不覆盖另一主体的原请求；按原号 QUERY-only 不因此变成新的资金申请。

## 7. 新旧资金承接矩阵

| 来源 | 目标、金额语义与证据 | 当前边界/隔离处置 |
| --- | --- | --- |
| 新原生订单与可信收款 | 原请求/原商户号→付款确认/唯一资金锚点→冻结结算及责任；租金和租客押金不混为号主保证金。 | 适配、状态/账务和消费者已实现；真实供应商/到账须独立验收。 |
| 旧 `la_order` 与支付记录 | 保留旧业务号、独立支付号、原双方/账号映射、金额/时间、商户产品及流水；旧单读取和续办不伪造原生付款。 | 缺可信商户/原号映射或多态来源有歧义时隔离；旧“成功”不创建新 JOINPAY/APPLIED。 |
| 旧 `la_user.earnings/money` | 经核定截止点的 stored earnings 形成受审期初来源；money 不相加。covered-set、用户映射、原文/digest、批准与账务分别核对。 | 期初不用流水净和重算，不因页面有数字就开放可提现；新证明所需结构未安装时拒绝新输入。 |
| 旧 `la_log_earnings` | 原九字段及历史余额保存为 observation/coverage，不再次入账；日志自身编号不是经济根。 | 补提取 `source_sn/remark/extra` 独立留证，缺字段未知、显式空串/null 保留，不覆盖原观察。 |
| 已结佣金/号主收入日志 | 显式 logBindings 绑定原经济行、受益角色/用户、金额、时点与摘要，连同 sourceProof 封存。 | 不能因普通佣金通过校验而丢弃映射；已含期初的收益不能再生成责任入账。 |
| 旧失败提现退回 | 原申请 gross/fee/net、1002借记和唯一1003/1004退回共同证明；退回用其自身原 log 根。 | 退回不是租赁退款或新收益；1005、缺原款、错用户/金额/时间继续隔离。 |
| 旧续办退款/佣金责任 | 原完整命令/结果、终金额、覆盖排除与成熟期→独立责任/财务终定；合法终零与正额过账分开。 | 已退款记录不等于到账；已入账、已结/作废不再付；暂扣/解除/没收沿旧责任，不重算当前政策。 |
| 旧实名/银行卡/提现状态 | 原身份及历史目标/状态作为来源；新申请需当前可信 producer、受权原目标和有效政策。 | 不自动证明当前成年、银行归属或真实出款成功；换卡不补老申请目标。 |

详细源列、单位与规则 ID 见[字段映射](legacy-data-mapping.md)。转换必须有界、守恒、可重放/隔离，既有余额、原件和 UNKNOWN 不追改。转换规则实现、真实批次采用、全量迁移和双端验收分别核定。

## 8. 装配与验证边界

正式启动装配负责各产品 profile、商户及产品权限、原密钥版本映射、通知地址/方法、可信时间/编码/目标规则、安全支付参数、身份 producer、政策和恢复 worker。关闭新请求不应阻断符合原合同的原键恢复；资料不足时明确不可用，不选择另一协议自动猜测。

数据库安装分两段：正式迁移入口先提交 schema/journal，再在独立事务收敛 runtime ACL。schema 成功但 ACL 失败或提交未知是不同结果；两段核验后才可启用相关运行能力。手装扩展必须逐对象核对采用方案，不能盲跑正式链或补写 journal 伪装已安装。

0106/0107已提供异常原款及未开租终止的正式结构。旧来源证明 SQL 仍为待实库验证的候选，未进入自动迁移；普通无证明旧读取保持原合同，新的 sourceProof 不能绕过缺结构/守卫的拒绝。正式原生/旧库与权限采用情况必须各自验证，不能从源码迁移数量推断。

目前已有完整领域与两端源码、离线验证，以及部分隔离受控 PG 证据；正式退款/提现完整并发/故障矩阵、真实认证三端运行、旧来源证明实库与真实迁移仍须按其范围验收。真实收款、退款、代付、回调和银行到账也须独立验收，公共技术账号仅收款签名验证不能覆盖退款/代付。未取得官方账单/全部流水/清算覆盖资料时，只能声称已核本地或逐单范围，不能声称期间全量对平。
