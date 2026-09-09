# 汇聚支付（Joinpay）支付与资金对账专项调研

调研日期：2026-09-08 至 2026-09-09
公开资料访问日期：2026-09-08；开放平台产品/菜单目录最终复核：2026-09-09
适用范围：洲洲商行旧平台证据还原与新管理平台对账方案；不构成汇聚支付合同、清算或财务意见。

## 1. 决策摘要

1. `[CODE_CONFIRMED][INFERRED]` 旧代码直接覆盖汇聚聚合收款（微信 Native、支付宝 Native）、原路退款，以及银行卡“委托付款 Z”单笔代付/查询（`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:27-208`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AutoTransferJob.java:27-59`）；代码存在和默认开关不能证明任一渠道在某一历史时段实际启用。
2. `[OFFICIAL_CURRENT]` 当前公开官方资料支持支付、退款、代付的单笔主动查询，代付批次查询，以及可用/预存账户余额快照；这些能力适合实时状态收敛，不等于全量账单。
3. `[UNKNOWN]` **自动拉取全量账单：暂无法确认。** 公开资料没有给出按日期全量交易/退款/代付账单、对账文件下载、SFTP、手续费/结算账单或账户流水接口；官方产品页只证明商户后台/产品存在明细和对账单能力，未说明取得方式。
4. `[INFERRED]` 推荐顺序为 **A 官方日账单/API 或文件 > B 官方 SFTP > C 商户后台官方导出并上传，始终叠加 D 回调+单笔查询**；未取得 A/B 证明前，以 C+D 建最小可行闭环，不能声称“全自动对账”。
5. `[OWNER_REQUIRED]` 开工自动接入前，Owner 须提供脱敏后的合同产品清单、商户/资金账户角色、后台权限与样例账单，并让汇聚技术支持书面确认账单交付、历史范围、修正机制、退款版本和测试方案。

## 2. 调研范围与安全边界

### 2.1 证据口径

本文只使用以下标签：

- `CODE_CONFIRMED`：归档旧代码直接可见；引用绝对路径和行号，但不外推线上启用情况。
- `OFFICIAL_CURRENT`：汇聚支付当前公开官网、开放平台文章或官方下载包直接支持；记录版本/更新日期和访问日期。
- `OFFICIAL_LEGACY`：当前官方材料仍保留的旧地址/旧样例，或与旧代码相符的历史资料；不能据此保证现商户仍可使用。
- `OWNER_CONFIRMED`：本任务说明中 Owner 明确给出的事实。
- `INFERRED`：由多项证据推导，正文写明推导链。
- `UNKNOWN`：现有材料不足。
- `OWNER_REQUIRED`：必须由 Owner、运营或汇聚商务/技术支持补充。

`[OWNER_CONFIRMED]` 平台开支金额全部经过汇聚支付，且 Joinpay 是外部真实现金流的重要事实来源。该事实不等于“旧代码里的所有产品、渠道和任务均曾在线启用”，也不等于 Joinpay 外部记录可以覆盖内部业务账本。

### 2.2 已执行与未执行

已执行：只读检查旧平台反编译源码、配置键、归档 POM；静态检查后续可行性验证 JAR 的哈希、manifest、包名和类名；只访问汇聚支付公开官网、公开开放平台 JSON、官方 ZIP/PDF/示例；未把后续验证材料当作旧生产证据。

`NOT_RUN`：未读取环境变量或寻找凭据；未展示或使用真实商户号、交易商户号、密钥、回调地址、姓名、银行卡号或签名样本；未登录商户后台；未调用真实支付、查单、退款、代付、余额或资金接口；未执行旧 SDK 的联网代码；未联系外部人员；未启动旧应用；未连接数据库；未修改 FigJam、业务代码或配置；未 commit、merge、push。

文中商户身份统一使用：`MERCHANT_MAIN`（主商户）、`TRADE_WX`（微信报备/交易商户角色）、`TRADE_ALIPAY`（支付宝报备/交易商户角色）、`FUNDS_ACCOUNT`（退款出资账户选择）。这些是分析别名，不是新平台已确认的数据模型。

## 3. 旧平台 Joinpay 接入矩阵

前台 `E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java` 与后台 `E:\zzsh\analysis\admin\source\com\mdd\common\util\HJPayUtils.java` 的 SHA-256 均为 `549B100BCB482CDEC3489CC1EB85DAFEB11504E0681AD329FE35359401717FBD`，归档内容一致；下表以 `front` 路径为主，涉及管理端调用时另列 `admin` 路径。

| 旧代码方法/接口 | 业务用途 | Joinpay 产品候选 | 下游渠道 | 商户身份别名 | 请求/回调 | 本地保存内容 | 调用方 | 启用证据 | 结论等级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `HJPayUtils.unipay` → `/trade/uniPayApi.action`；`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:27-80` | 生成聚合收款二维码/支付结果 | 聚合支付 | `WEIXIN_NATIVE`、`ALIPAY_NATIVE`（支付方式 2/3 映射见同文件 `:27-35`） | `MERCHANT_MAIN` + 按渠道选择 `TRADE_WX`/`TRADE_ALIPAY`（同文件 `:38-66`） | 表单请求；返回验签后仅取 `rc_Result`（同文件 `:68-78`） | HJ 路径保存内部业务单 ID/类型、支付方式、商户支付单号、金额、二维码 URL、创建时间；`E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:306-323` | 订单、账户保证金、助力任务、雇佣关系四种场景；`E:\zzsh\analysis\front\source\com\mdd\front\controller\PayController.java:86-185`，`E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:239-323` | 可达代码路径；默认值/归档配置不是历史运行证据 | `CODE_CONFIRMED`；线上渠道为 `UNKNOWN` |
| `PayController.payNotify`；`E:\zzsh\analysis\front\source\com\mdd\front\controller\PayController.java:190-249` | 聚合收款异步通知 | 聚合支付通知 | 回调携带渠道字段 | 回调携带商户号，但业务处理未绑定校验 | GET 回调；读取平台/银行流水、金额、手续费、结算额、支付/处理时间、渠道等，验签后仅在状态 `100` 时调用内部处理（同文件 `:191-249`） | 只按商户支付单号+业务类型将 `PayOrder.payIs/payTime` 置成功，并驱动业务回调；未保存回调平台流水、银行流水、手续费、结算额；`E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:333-363` | 汇聚通知入口 | 入口存在；无真实回调或生产路由证据 | `CODE_CONFIRMED`；线上为 `UNKNOWN` |
| `HJPayUtils.qureyOrder` → `/trade/queryOrder.action`；`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:82-105` | 单笔收款主动查询 | 聚合支付订单查询 | 未限定 | `MERCHANT_MAIN` | 表单请求/同步响应验签 | 方法只返回响应 JSON；全仓搜索未发现调用方，因而没有持久化链路 | 无调用方 | 仅方法存在 | `CODE_CONFIRMED`；实际使用为 `UNKNOWN` |
| `HJPayUtils.closeOrder` → `/trade/closeOrder.action`；`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:107-129` | 关闭失效支付二维码 | 聚合支付关单（候选） | 由支付渠道入参传入 | `MERCHANT_MAIN` | 表单请求/同步响应验签 | 不保存第三方关单状态 | 新预支付前关闭旧二维码：`E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:306-311`；定时关单：`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\OrderCloseJob.java:57-62` | 调用代码存在；当前公开接口目录无关单项 | `CODE_CONFIRMED`；当前官方支持状态为 `UNKNOWN` |
| `HJPayUtils.refund` → `/trade/refund.action`；`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:131-155` | 全额/部分退款申请 | 聚合支付退款 | 继承原收款渠道 | `MERCHANT_MAIN` + `FUNDS_ACCOUNT` | 表单请求；响应只验签，不判断业务状态、不返回退款平台流水（同文件 `:131-155`） | 多条调用链在方法返回后立即修改本地状态；没有保存汇聚退款流水/最终状态 | 用户保证金/任务/雇佣退款：`E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:394-499,528-545`；售后：`E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\OrderAfterServiceImpl.java:379-460`；管理端取消：`E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\OrderManageServiceImpl.java:620-669`；另有租赁、定时退还调用，见来源索引 | 多个代码调用点；无第三方最终结果证据 | `CODE_CONFIRMED`；实际成功为 `UNKNOWN` |
| `PayController.refundNotify`；`E:\zzsh\analysis\front\source\com\mdd\front\controller\PayController.java:255-286` | 退款异步通知 | 聚合支付退款通知 | 原收款渠道 | 回调携带商户号 | 读取退款流水、状态、时间等字段 | 直接返回 `success`；未验签、未更新退款状态、未保存第三方标识（同文件 `:255-286`） | 汇聚退款通知入口 | 入口存在，但不能形成退款闭环 | `CODE_CONFIRMED` |
| `HJPayUtils.singlePay` → `/payment/pay/singlePay`；`E:\zzsh\analysis\admin\source\com\mdd\common\util\HJPayUtils.java:157-189` | 银行卡提现/代付发起 | 委托付款 Z（请求 `BANK_PAY_DAILY_ORDER`） | 银行卡 | `MERCHANT_MAIN` | JSON 同步请求；`callbackUrl` 为空；响应赋给局部变量后丢弃（同文件 `:157-189`） | 发起后仅将内部提现状态改为处理中 | 自动发起：`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AutoCheckJob.java:23-48`；人工审核后发起：`E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\FinanceWithdrawServiceImpl.java:342-360` | 可达代码；任务是否调度取决于数据库命令配置 | `CODE_CONFIRMED`；历史启用为 `UNKNOWN` |
| `HJPayUtils.singlePayQuery` → `/payment/pay/singlePayQuery`；`E:\zzsh\analysis\admin\source\com\mdd\common\util\HJPayUtils.java:191-208` | 单笔代付结果收敛 | 委托付款 Z 查询 | 银行卡 | `MERCHANT_MAIN` | JSON 同步查询 | 调用方只读取 `data.status/errorDesc`；成功/失败后改本地状态，未保存官方 `platformSerialNo` 或手续费 | 定时查询：`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AutoTransferJob.java:27-59`；人工查询：`E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\FinanceWithdrawServiceImpl.java:168-205,287-310` | 调用代码存在；调度启用和真实返回未知 | `CODE_CONFIRMED`；历史启用为 `UNKNOWN` |
| `PayChangeJob` / `PayWayReturnJob`；`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\PayChangeJob.java:17-35`，`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\PayWayReturnJob.java:15-26` | 达到额度阈值后从汇聚切到乐刷，等待无未支付单后再切回 | 支付服务商路由 | 汇聚/乐刷 | 系统配置 `trade.payWay` | 内部定时任务，无第三方回调 | 只改当前配置，不保存完整历史路由证据 | 动态定时任务系统按数据库命令解析 Bean/方法：`E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\CrontabServiceImpl.java:29-44`，`E:\zzsh\analysis\admin\source\com\mdd\admin\config\quartz\InvokeUtils.java:12-22` | Job 类存在不能证明数据库曾配置/执行 | `CODE_CONFIRMED`；历史切换为 `UNKNOWN` |

### 3.1 哪些业务单生成 `PayOrder`

`[CODE_CONFIRMED]` HJ 路径下，四种场景都会创建 `PayOrder`：普通订单、账户保证金、助力任务、雇佣关系；场景到 `orderType` 的映射见 `E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:248-264`，创建/保存见同文件 `:306-323`。当 `trade.payWay=ls` 且场景为普通订单时走乐刷分支并把乐刷订单号/二维码写在 `Order`，不创建同一条 HJ `PayOrder`；见同文件 `:283-305`。

`[CODE_CONFIRMED]` `PayOrder` 反编译实体只显示 `id/orderId/orderType/payWay/payOrderSn/payMoney/payUrl/payIs/payTime/createTime` 等 Java 字段；见 `E:\zzsh\analysis\front\source\com\mdd\common\entity\PayOrder.java:18-36` 和 `E:\zzsh\analysis\admin\source\com\mdd\common\entity\PayOrder.java:18-36`。这只是代码字段候选，**不是数据库真实表结构、约束、索引或生产数据证明**。

### 3.2 已保存与缺失的第三方标识

| 流程 | 旧代码保存 | 回调/查询其实可见但未落入该链路 | 后果 |
| --- | --- | --- | --- |
| 收款 | 商户支付单号、内部业务 ID/类型、金额、二维码、内部成功时间 | 汇聚平台流水、银行订单/流水、手续费、结算金额、渠道、官方支付/处理时间；字段读取见 `E:\zzsh\analysis\front\source\com\mdd\front\controller\PayController.java:191-235` | `[INFERRED]` 只能以内外商户单号做主要匹配，无法在本地直接核对费用/结算/银行流水 |
| 退款 | 内部退款单号、订单号、退款金额、内部状态/时间；实体字段候选见 `E:\zzsh\analysis\admin\source\com\mdd\common\entity\RefundRecord.java:20-44`、`E:\zzsh\analysis\admin\source\com\mdd\common\entity\RefundLog.java:20-38` | 汇聚退款平台流水、最终状态、完成时间、退款路径/入账账户 | `[INFERRED]` 本地“成功”不能证明第三方完成，且难以处理后续失败/修正 |
| 代付 | 内部提现单号、收款信息、金额/手续费候选、本地状态/时间；实体字段候选见 `E:\zzsh\analysis\admin\source\com\mdd\common\entity\withdraw\WithdrawApply.java:20-76` | 汇聚平台流水号、官方手续费、官方完成时间；旧调用方只读状态和错误说明 | `[INFERRED]` 无法靠旧记录完整勾稽平台代付事实 |

`[CODE_CONFIRMED]` 售后退款链在 `HJPayUtils.refund` 返回（仅代表 HTTP/验签路径未抛错）后，立即把本地退款记录和售后状态标成功；见 `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\OrderAfterServiceImpl.java:442-460`。管理端取消订单也采用同类处理；见 `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\OrderManageServiceImpl.java:642-656`。因此 `[INFERRED]` 旧平台本地成功状态与 Joinpay 最终退款事实存在结构性断链。

`[CODE_CONFIRMED]` 管理端名为 `queryAvailbBalance` 的方法直接返回空 `Map`，未调用 Joinpay；见 `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\FinanceWithdrawServiceImpl.java:275-278`。因此旧代码没有可用的 Joinpay 余额或账户流水采集链；后续可行性 JAR 中有余额类不改变这一旧生产证据结论。

### 3.3 其他支付服务商与代码存在边界

| 代码线索 | 直接证据 | 可下结论 | 不能下结论 |
| --- | --- | --- | --- |
| 乐刷 | `LSPayUtils` 有微信、支付宝、退款等方法；`E:\zzsh\analysis\front\source\com\mdd\common\util\LSPayUtils.java:13-131`。实际预支付切换只在普通订单选择 `zfbPay`，见 `E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:283-305,528-545` | `[CODE_CONFIRMED]` 存在乐刷支付宝收款/退款可达分支与切换任务 | `[UNKNOWN]` 任一时间段实际开关值、交易量、微信乐刷方法是否用过 |
| 微信支付直连 | `WxPayDriver` 含统一下单、退款、企业付款/查询；`E:\zzsh\analysis\front\source\com\mdd\common\plugin\wechat\WxPayDriver.java:52-151`。退款调用见 `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\FinanceRechargerServiceImpl.java:140-181`、`E:\zzsh\analysis\front\source\com\mdd\front\service\impl\OrderServiceImpl.java:1233`；付款查询见 `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\FinanceWithdrawServiceImpl.java:214-273` | `[CODE_CONFIRMED]` 另有直连微信资金路径代码，必须与 Joinpay 分账源识别 | `[UNKNOWN]` 线上是否启用、是否与 Owner 所说“开支全部经过 Joinpay”发生范围差异；需 Owner 定义“开支”口径 |
| 易付通/QXN/SaaS 示例 | 工具类存在，但全仓调用搜索未发现调用方；例如 `E:\zzsh\analysis\admin\source\com\mdd\common\util\YFTUtils.java:21-141`、`E:\zzsh\analysis\admin\source\com\mdd\common\util\QxnUtils.java:47-260`、`E:\zzsh\analysis\admin\source\com\mdd\common\util\SaasApiDemo.java:56-63` | `[CODE_CONFIRMED]` 仅存在适配/示例代码；本文不引用其中配置值 | 不能视为接入、启用或产生资金事实 |

## 4. Joinpay 产品、渠道和商户身份关系

### 4.1 旧代码能够确认的关系

```text
内部业务单
  └─ PayOrder.payOrderSn（商户支付单号）
       └─ MERCHANT_MAIN
            ├─ 聚合支付 / WEIXIN_NATIVE  ── TRADE_WX
            └─ 聚合支付 / ALIPAY_NATIVE ── TRADE_ALIPAY

内部退款单 ── 原收款单 + MERCHANT_MAIN + FUNDS_ACCOUNT
内部提现单 ── MERCHANT_MAIN + 委托付款 Z + 银行卡收款方
```

`[CODE_CONFIRMED]` 图中关系来自 `E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:27-66,131-153,157-208`。`qa_TradeMerchantNo` 在当前官方文档中是报备商户号/交易商户角色；旧代码按渠道从系统配置分别读取。YAML 中另有 `hj-config.tradeMerchantNo` 声明（同文件 `:19-25`），但全仓只发现声明、未发现业务使用。

`[CODE_CONFIRMED]` 管理端可分别读取/保存 `wxTradeMerchantNo`、`alTradeMerchantNo`、`payWay`、`fundsAccount`；见 `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\SettingTradeImpl.java:12-40`。这证明角色可独立配置，不证明生产上一定是不同号码或同一法律主体。

### 4.2 配置身份数量的安全结论

`[CODE_CONFIRMED]` 仅比较值的相等关系、不输出值：前台/后台 dev/pro/uat 的 `hj-config` 均声明 `merchantNo/tradeMerchantNo/key/notifyUrl/refundNotifyUrl`，位置分别为 `E:\zzsh\analysis\front\resources\application-dev.yml:93-98`、`application-pro.yml:91-96`、`application-uat.yml:91-96`、`E:\zzsh\analysis\admin\resources\application-dev.yml:95-100`、`application-pro.yml:98-103`、`application-uat.yml:99-104`。归档的非空副本中，`merchantNo` 与 `tradeMerchantNo` 是两个不同的字面标识；UAT 对应身份键为空。dev 与 pro/uat 的五项组合并不完全相同。

`[INFERRED]` 因而只能说归档材料至少出现 `MERCHANT_MAIN` 与一个未使用的 `TRADE_LEGACY` 配置角色，运行时另有 `TRADE_WX`、`TRADE_ALIPAY` 两个可独立配置角色。`[UNKNOWN]` 生产上实际有几个商户号、是否同一签约主体、收款/退款/代付是否共用同一资金账户，以及历史变更时间。

## 5. 官方文档与版本匹配结果

### 5.1 官方当前文档矩阵

| 产品/规则 | 官方当前证据 | 版本/更新信息 | 与旧代码的匹配 | 结论 |
| --- | --- | --- | --- | --- |
| 聚合支付协议 | [协议规则（menuId=44）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=44&isPreview=false)、[签名规则（menuId=56）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=56&isPreview=false) | 页面分别更新 2019-04-28、2018-11-30；访问 2026-09-08 | POST 表单、UTF-8、同步 JSON/异步 GET；商户可选 MD5/RSA。旧代码明确调用 `Md5_Sign.SignByMD5`，见 `E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:60-63,88-94,113-119,141-147` | `[OFFICIAL_CURRENT][CODE_CONFIRMED]` 字段名 `hmac` 不是 HMAC 算法证明；旧代码走 MD5 助手 |
| 聚合支付下单 | [支付接口（menuId=62）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=62&isPreview=false) | 页面更新 2026-08-24；协议字段 `p0_Version=2.6`；访问 2026-09-08 | 当前地址为 `https://trade.joinpay.com/tradeRt/uniPay`，渠道包含 `WEIXIN_NATIVE/ALIPAY_NATIVE`，字段与旧代码高度对应 | `[OFFICIAL_CURRENT]` 产品/协议族匹配；`2.6` 是接口字段，不能当 SDK 或整份文档版本 |
| 聚合支付查询 | [订单查询接口（menuId=63）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=63&isPreview=false) | 页面更新 2025-11-06；协议字段 2.6；访问 2026-09-08 | 当前地址 `tradeRt/queryOrder`；一次按一个商户订单号查询，返回平台/银行流水、手续费、渠道、状态、时间、结算额 | `[OFFICIAL_CURRENT]` 是单笔查询，不是订单列表或账单 |
| 聚合支付退款/退款查询 | [退款接口（menuId=64）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=64&isPreview=false)、[退款查询（menuId=177）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=177&isPreview=false) | 页面分别更新 2026-06-22、2025-07-25，页面字段版本写 2.3；访问 2026-09-08 | 当前地址 `tradeRt/refund/queryRefund`；支持全额、部分及多次退款，退款单号须唯一；查询一次只接收一个退款单号 | `[OFFICIAL_CURRENT]` 能单笔收敛退款；旧代码无退款查询调用 |
| 聚合支付 PDF | 官方下载包内《汇聚支付聚合支付API接口文档V2.6.10》；[官方 Java 下载包](https://file.joinpay.com/group2/M00/AE/48/CgoenGqL6OGABu9cAJsIeVGG07k437.zip) | PDF 标注更新 2026-08、V2.6.10；下载入口页面更新 2026-08-24；访问 2026-09-08 | PDF 退款请求/异步字段写 2.4，而同步返回表一处仍写 2.3；与网页 2.3 不一致 | `[OFFICIAL_CURRENT][UNKNOWN]` 退款实施版本必须让汇聚按商户产品书面确认，不能自行挑版本 |
| 委托付款协议/签名 | [协议规则（menuId=84）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=84&isPreview=false)、[签名规则（menuId=85）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=85&isPreview=false) | 页面更新 2026-08-24、2019-02-12；访问 2026-09-08 | POST JSON、UTF-8、MD5/RSA，与旧 SDK 组串+MD5调用形态相符 | `[OFFICIAL_CURRENT]` 具体商户签名方式仍取决于已开通配置 |
| 单笔/批量委托付款 | [单笔（104）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=104&isPreview=false)、[单笔查询（105）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=105&isPreview=false)、[批量（106）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=106&isPreview=false)、[批量查询（107）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=107&isPreview=false) | 四页均更新 2026-08-24；访问 2026-09-08 | 旧代码的 URL、`BANK_PAY_DAILY_ORDER` 和成功/失败状态与委托付款 Z 对应；“批量查询”按一个已提交批次查，不是按日期获取历史全量 | `[OFFICIAL_CURRENT][INFERRED]` 旧代付产品候选可定为委托付款 Z；合同开通仍待证 |
| 委托付款余额 | [账户查询接口（menuId=108）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=108&isPreview=false)、[附录（109）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=109&isPreview=false) | 页面均更新 2026-08-24；访问 2026-09-08 | 可查可提现余额/结算冻结额，以及预存账户余额、当日入账/未结算/已用/冻结等快照 | `[OFFICIAL_CURRENT]` 是时点余额，不是账户资金流水历史 |
| 委托付款 PDF | 官方下载包内《汇聚支付委托付款API接口文档V1.28》；[官方 Java 下载包](https://file.joinpay.com/group2/M00/0A/8E/Ch4enGqL-A-AWRPpAGIDuODjsOY367.zip) | PDF 标注更新 2023-04、V1.28；公开下载页更新 2026-08-24；访问 2026-09-08 | 文档覆盖单笔、批量、查询和余额；不含日期账单/文件/SFTP接口 | `[OFFICIAL_CURRENT]` PDF 与 2026 网页更新时间不同，须确认现商户适用的合同文档版本 |

### 5.2 当前地址与历史地址不能混用

`[OFFICIAL_LEGACY]` 当前聚合支付官方文章/PDF仍在示例片段中保留 `https://www.joinpay.com/trade/uniPayApi.action`、`queryOrder.action` 等旧地址，而接口定义给出 `https://trade.joinpay.com/tradeRt/...`。旧代码使用 `https://trade.joinpay.com/trade/*.action`（`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:23,66,94,119,147`），只能证明它属于同一历史协议族；不能证明旧地址今天仍受支持，也不能因为官网主定义已换址就宣称旧接口从未存在。

`[UNKNOWN]` 当前公开聚合支付接口目录只有支付、订单查询、退款、退款查询；没有关单条目。旧 `closeOrder.action` 的现行替代、停用日期、迁移方式和幂等语义需汇聚支持确认。

`[CODE_CONFIRMED][OFFICIAL_CURRENT]` 旧退款请求使用大小写为 `p0_version` 的键并填 `2.6`，见 `E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:131-147`；当前网页/PDF使用 `p0_Version`，且版本出现 2.3/2.4 冲突。不能假设参数名大小写无关，也不能直接把旧 2.6 套到当前退款接口；这是一项明确的迁移阻塞。

### 5.3 回调、查询、错误状态与测试边界

- `[OFFICIAL_CURRENT]` 聚合支付通知带商户订单号、平台/银行流水、金额、手续费、渠道、支付/处理时间与结算金额；成功响应停止重发，特定失败会按官方节奏重试，并可在商户后台人工重发。来源：[支付接口（62）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=62&isPreview=false)。这仍是事件通知，不是全量账单。
- `[OFFICIAL_CURRENT]` 退款最终成功/失败才发异步结果，接收方须幂等；同步返回“处理中/系统忙”等未知结果时应主动查询。来源：V2.6.10 PDF 第 44-52 页及[退款查询（177）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=177&isPreview=false)。
- `[OFFICIAL_CURRENT]` 委托付款单笔响应/通知/查询可给出状态、错误、商户订单号、平台流水、金额和手续费；未知/处理中状态必须后续查询，不能当失败重发付款。来源：[单笔委托付款（104）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=104&isPreview=false)、[单笔查询（105）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=105&isPreview=false)、[附录（109）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=109&isPreview=false)。
- `[OFFICIAL_CURRENT]` 聚合支付 V2.6.10 PDF 提供专用测试商户并明确不发生真实收款；本文未记录其任何凭据。委托付款 V1.28 PDF 第 5 页明确写公开接口当时不支持测试账号、需正式账号测试。`[OWNER_REQUIRED]` 新平台不得照搬该做法；须取得汇聚书面批准的沙箱/测试商户、限额、收款人和回滚方案后另行验收。
- `[UNKNOWN]` 当前公开资料未明确证明本项目产品的 IP 白名单、客户端证书、限流、时区、查询留存期或回调保留期；错误信息中出现“请求 IP”不能单独证明白名单制度。

## 6. 账单、交易、退款、代付、手续费与结算能力矩阵

> “实时 API”仅表示公开文档允许针对已知单号/账户发起查询；不表示本轮调用过真实接口。“商户后台导出”只在官方明确到导出格式时才判定可用，能查看不等于能导出。
>
> 本节所有官方链接内容访问于 2026-09-08，公开菜单最终复核于 2026-09-09；对应文章更新日期、协议/PDF版本逐项列在第 5.1 节和第 15.3 节。能力矩阵中的 `UNKNOWN` 不是由搜索缺失反推“不存在”。

| 数据种类 | 实时 API | 批量账单/API | SFTP | 商户后台导出 | 历史范围 | 关键关联字段 | 官方证据 | 可用性结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 收款 | 按一个商户订单号查；回调可实时接收 | 公开目录未见日期列表、日账单或文件下载 API | 未公开 | 官网称商户后台可实时查交易明细，但未公开 CSV/Excel 导出说明 | 未公开 | 商户订单号、平台/银行流水、金额、手续费、渠道、状态、支付/处理时间、结算额 | [订单查询（63）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=63&isPreview=false)、[官网](https://www.joinpay.com/) | **只能单笔查询，不能覆盖整体对账**；全量账单 `UNKNOWN` |
| 部分/全额退款 | 按一个退款单号查；支持一个原单多次退款 | 公开目录未见退款列表/退款账单 | 未公开 | 未公开导出能力 | 未公开 | 原商户订单号、退款订单号、退款平台流水、金额、状态、完成时间、退款方式/入账账户 | [退款（64）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=64&isPreview=false)、[退款查询（177）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=177&isPreview=false) | **只能单笔查询，不能覆盖整体对账**；需先确认 2.3/2.4 版本 |
| 代付/提现 | 单笔查询；通知；可按一个已提交批次查询 | 有“批量付款/批次查询”，但它只覆盖商户已知批次，不是历史全量账单 | 未公开 | 产品页称可在后台操作且可获取对账单，未说明导出格式/接口 | 未公开 | 商户订单/批次号、平台流水、收款账户标识、金额、手续费、状态、错误、完成信息 | [单笔查询（105）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=105&isPreview=false)、[批量查询（107）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=107&isPreview=false)、[委托付款产品页](https://www.joinpay.com/pages/alternativePay.html) | 已知单/批次可自动查询；**不能据此覆盖平台孤儿代付**；全量账单需开通/确认 |
| 手续费 | 收款查询/通知、代付查询含单笔手续费字段 | 未见独立手续费日账单或汇总 API | 未公开 | 未公开 | 未公开 | 商户订单/平台流水、费用金额、费用类型、计费时间、税/调整标识（后四项格式未公开） | [订单查询（63）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=63&isPreview=false)、[单笔查询（105）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=105&isPreview=false) | 单笔费用**可直接自动接入**；整体费用对账为 `UNKNOWN` |
| 结算入账 | 收款结果含单笔结算金额；余额接口含结算冻结/当日未结算快照 | 未见结算批次/入账明细/结算单 API | 未公开 | 未公开 | 未公开 | 收款平台流水、结算金额；结算批次、入账银行流水、结算日期等未公开 | [支付接口（62）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=62&isPreview=false)、[账户查询（108）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=108&isPreview=false) | **公开资料不足，暂不能确认**完整结算对账 |
| 账户资金流水 | 官网称商户后台可查实时账务变动；委托付款产品页称提供账户明细查询 | 公开 API 目录无账户流水列表/文件接口 | 未公开 | 能查看得到证明；可导出及格式未得到证明 | 未公开 | 流水号、收支方向、发生额、余额、业务类型、关联单号、时间等格式未公开 | [官网](https://www.joinpay.com/)、[委托付款产品页](https://www.joinpay.com/pages/alternativePay.html)、[委托付款公开目录](https://b.joinpay.com/apis/public/getMenuTree?apiId=10&isPreview=false) | **公开资料不足，暂不能确认**自动拉取；人工导出也需现场核验 |
| 账户余额 | 可查可提现/冻结余额及预存账户当日快照 | 不适用；快照不是流水 | 不适用 | 后台可见性可合理期待，但公开页未给字段/导出 | 无历史范围承诺 | 账户类型、可用、冻结、当日入账/未结算/已用 | [账户查询（108）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=108&isPreview=false) | **需要开通产品或权限后可直接自动接入**；仅用于控制/核验，不替代流水 |
| 撤销、冲正、后续修正 | 当前公开目录未见独立查询 | 未见修正账单/补单文件规则 | 未公开 | 未公开 | 未公开 | 未公开 | 聚合与委托付款公开菜单：[apiId=6](https://b.joinpay.com/apis/public/getMenuTree?apiId=6&isPreview=false)、[apiId=10](https://b.joinpay.com/apis/public/getMenuTree?apiId=10&isPreview=false) | **公开资料不足，暂不能确认**；必须向汇聚索取规则 |

`[OFFICIAL_CURRENT]` 汇聚“委托付款”产品页明确宣称支持商户后台或 API 的单笔/批量付款，并提供付款订单查询、账户明细查询和对账单获取；但它没有公开传输方式、文件格式、生成时点、历史留存或开通条件。因此本文只把“产品有此业务能力”记为官方事实，不把它提升为“存在可自动调用的账单 API/SFTP”。

## 7. 是否可自动拉取的明确结论

### 7.1 结论分层

- **单笔实时状态：有条件可自动接入。** `[OFFICIAL_CURRENT]` 收款、退款、代付均有按已知商户单号查询；代付还有按已知批次查询，账户有余额快照。条件是相应产品已开通、版本/签名/商户身份已确认。
- **全量现金流账单：暂无法确认。** `[UNKNOWN]` 公开资料没有证明一个接口/文件能枚举 Joinpay 有而内部没有的孤儿流水，也没有证明收款、退款、代付、手续费、结算、账户调账能被同一份账单完整覆盖。
- **商户后台人工导出：产品能力有线索，导出能力未证实。** `[OWNER_REQUIRED]` 必须由有权限的运营在后台只读核验菜单，并提供脱敏样例、字段说明和账期规则；若只能页面查看，C 方案也尚不成立。
- **整体看板/对账系统：有条件可建设。** `[INFERRED]` 内部账本、回调和单笔查询足以做实时估算；只有取得 A/B，或至少经核验的 C，才能把日终数据标为第三方确认。

### 7.2 对五个核心问题的直接回答

1. **是否存在覆盖全量现金流的官方账单能力？** `[OFFICIAL_CURRENT][UNKNOWN]` 委托付款产品页证明存在“对账单获取”这一产品能力，但公开接口目录/PDF没有给出可自动获取方式，也未证明它覆盖聚合收款、退款、手续费、结算和调账全部现金流。因此不能确认“单一全量账单”。
2. **若没有一个接口覆盖全部，应组合哪些数据源？** `[INFERRED]` 聚合支付日账单 + 退款明细 + 委托付款日账单 + 手续费/结算或账户流水文件 + 账户余额快照；内部支付/退款/提现/审批/账务分录并行保留；回调和单笔查询只做实时补充。
3. **哪个数据源适合作为日终主来源？** `[INFERRED]` 首选官方签名/校验可验证的日对账文件或 SFTP 文件；次选商户后台原始导出。页面查询、回调、内部状态和逐单查询都不能单独成为日终主来源。
4. **哪些接口只能用于实时状态收敛？** `[OFFICIAL_CURRENT][INFERRED]` 聚合支付单笔订单查询、退款查询、委托付款单笔/已知批次查询、各类回调和余额查询；它们无法发现未知单号的外部孤儿流水。
5. **能否取得关键匹配字段？** `[OFFICIAL_CURRENT]` 单笔接口/通知可提供商户订单号、平台流水、金额、状态、发生/完成时间，收款还含银行流水、渠道、手续费和结算额，代付含平台流水和手续费；`[UNKNOWN]` 批量账单中是否逐笔稳定提供同样字段、退款/结算/调账字段及格式仍需样例验证。

## 8. 推荐的对账数据源组合

### 8.1 A-D 方案比较

| 方案 | 自动化 | 能否发现外部孤儿流水 | 日终适用性 | 已确认程度 | 主要前置条件/风险 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| A：官方日账单 API 或对账文件自动下载 | 高 | 若文件确为商户/资金账户全量，则能 | 最适合 | `[UNKNOWN]` 公开资料未给接口/文件规范 | 需书面确认产品覆盖、鉴权、下载地址、生成时间、补单/重发、历史范围、文件签名/校验 | **第一优先**；确认后作为日终主源 |
| B：官方 SFTP 账单 | 高 | 同 A，取决于文件覆盖范围 | 很适合 | `[UNKNOWN]` 公开资料未证明存在 | 需账号/密钥托管、IP/主机指纹、目录/命名、晚到/重发协议、灾备 | **第二优先**；若官方只提供 SFTP，效果可等同 A |
| C：商户后台人工导出后上传 | 中/低 | 若导出为全量，则能 | 可作为 MVP 主源 | `[OWNER_REQUIRED]` 官网证明能看明细/获取对账单，未证明可导出 | 需后台权限、双人复核、原文件不改写、固定口径；易漏日/错商户/重复上传 | **立即可验证的兜底**；A/B 未开通时采用 |
| D：回调 + 单笔/已知批次查询 | 实时自动 | 不能；系统不知道的外部流水没有查询键 | 只适合实时收敛和异常补查 | `[OFFICIAL_CURRENT]` | 需产品开通、版本/签名确认；轮询要限速，未知状态不可重发资金指令 | **所有阶段都保留，但绝不替代 A/B/C** |

### 8.2 推荐组合与进入条件

`[INFERRED]` **目标组合：A（或 B）+ D + 内部账本。** 每日按商户主体、产品、资金账户和账务日期取得官方原始文件，完成日终勾稽；回调/主动查询在日内收敛支付、退款和代付状态；内部账本保留审批、业务义务和会计语义。A 与 B 选择官方实际提供且可稳定重取的一种，不需要同时建设两个等价下载通道。

`[INFERRED]` **最小可行组合：经现场核验的 C + D + 内部账本。** 先由有权限运营从商户后台导出原始官方文件并上传；平台做文件哈希、幂等导入、差异工单和审计。待 A/B 获批，只替换“文件取得”步骤，保留同一导入/对账口径。

`[INFERRED]` **若 C 也无法取得：** 只建设内部资金事件、回调/单笔查询和“实时估算”看板；不得把它命名为 Joinpay 全量日终对账，不得显示“已核平”。逐单枚举内部订单虽然能校验已知单，却天然发现不了 Joinpay 有、内部没有的记录。

### 8.3 日终来源的验收门槛

任一 A/B/C 文件在成为日终主源前，应由 Owner/财务/技术共同用脱敏样例确认：

1. `[OWNER_REQUIRED]` 覆盖哪些商户号、产品、渠道和资金账户，是否含零金额/失败/处理中/冲正记录。
2. `[OWNER_REQUIRED]` 收款、退款、代付、手续费、结算、调账分别在哪一文件或记录类型；是否可能跨日、补发或覆盖原文件。
3. `[OWNER_REQUIRED]` 账务日、交易时间和结算日的时区/截点；文件生成时间、最晚到达时间和历史重取范围。
4. `[OWNER_REQUIRED]` 唯一键、平台流水、商户单号、原单号、金额/币种、状态、发生/完成时间、手续费和结算字段的定义。
5. `[OWNER_REQUIRED]` 文件级签名、摘要、压缩/加密、字符集、金额单位、负数/冲正表达和版本号。

## 9. 新平台对账流程与概念数据模型

以下均为 **新平台建议字段候选**，不是旧库真实结构，也不是生产 DDL。

### 9.1 最小流程

```text
回调/单笔查询 ──> 日内 provider event（暂定事实） ─────────────┐
                                                               │
官方日文件/API/SFTP/人工上传 ─> 原件固化 ─> 解析/标准化 ─> 日终匹配
                                                               │
内部支付/退款/提现/审批/分录 ───────────────────────────────────┘
                                      │
                                      ├─ 一致：形成匹配证据
                                      └─ 差异：人工复核 → 更正分录/外部追查
```

1. **取得并固化。** 保存官方原始响应/文件的来源、商户角色、业务日期、取得时间、原文件名、字节数、内容哈希、文件版本；原件只追加、不覆盖。
2. **幂等导入。** 以“来源账户 + 官方文件标识（若有）+ 内容哈希”拒绝重复；同名不同哈希视为新版本/修正版，不静默覆盖。
3. **原样与标准化分离。** 保留原始行/字段，再映射成收款、退款、代付、手续费、结算、账户变动等标准资金事件；解析器版本随导入记录保存。
4. **先强键、后人工。** 优先用商户角色+产品+商户订单号/退款单号/代付单号及平台流水精确匹配；金额+时间只能生成候选，不能自动认定同一笔。
5. **分类型勾稽。** 收款本金、退款、代付本金、手续费、结算分别记账和匹配，不能用一笔“净额”抹平；部分退款允许一笔收款对应多笔退款。
6. **日内与日终分层。** 回调/查询更新实时状态；日文件到达后再给记录加“第三方日终已确认”。文件晚到时展示“待确认”，不沿用上一日结论。
7. **差异工单。** 异常不能自动改平；复核人记录证据、原因、处理动作和更正分录。原始内部/外部记录永久保留。

### 9.2 概念对象与必要字段候选

| 概念对象 | 目的 | 最小字段候选 |
| --- | --- | --- |
| `provider_account` | 明确商户主体、产品和资金账户边界 | provider、环境、`merchant_alias`、签约主体引用、产品、渠道、资金账户类型、生效/失效时间、凭据版本引用（不存明文） |
| `statement_artifact` | 固化一份官方原始文件/响应 | 来源方式 A/B/C、账户、业务日期、官方文件 ID/文件名、取得时间、内容哈希、字节数、版本、原始对象存储引用、导入状态 |
| `statement_row_raw` | 保留可复核的原始行 | artifact、行号、原字段快照（加密/脱敏策略下）、官方记录类型、解析状态、解析错误 |
| `provider_money_event` | 表达 Joinpay 第三方资金事实 | 事件类型、商户/产品/渠道、商户单号、平台/银行流水、原单号、金额/币种、手续费、结算金额、状态、发生/完成/账务日期、原始行引用、版本 |
| `internal_money_event` | 表达内部业务和账务事实 | 业务类型/单号、审批单、付款/退款/提现指令、内部账务分录、金额/币种、期望方向、状态、发生时间、版本 |
| `reconciliation_run` | 记录一次可复现对账 | 范围、数据截止点、规则版本、解析器版本、开始/结束、执行者、各类数量/金额、结果状态 |
| `reconciliation_match` | 保存匹配证据而非覆盖原记录 | run、内部事件、外部事件、匹配规则、置信级别、金额差、状态差、确认人/时间 |
| `reconciliation_exception` | 管理差异生命周期 | 差异类型、金额、优先级、证据引用、负责人、状态、根因、解决方式、复核/关闭人和时间 |
| `adjustment_entry` | 用可审计更正修复内部账务 | 原分录、原因、借贷/收支方向、金额、审批/复核人、外部证据、创建/过账时间；不修改原分录 |

`[INFERRED]` 金额应使用十进制定点/最小货币单位并保存原始文本；不同商户、产品、渠道、币种不得只凭相同商户订单号合并。平台流水存在时可作为外部唯一性候选，但最终唯一键必须用样例账单和官方字段规则验证。

### 9.3 差异分类与动作

| 差异类型 | 判定候选 | 默认动作 |
| --- | --- | --- |
| Joinpay 有、内部没有 | 外部强唯一键无内部候选 | 建孤儿流水工单；核查漏单、跨商户、人工后台操作 |
| 内部成功、Joinpay 没有 | 日终覆盖范围内仍无外部记录 | 保持未确认；主动查单，核查错日/错商户/本地误成功 |
| 金额不一致 | 同强键本金/退款/代付金额不同 | 冻结自动结案；核查单位、部分退款、手续费是否误并入 |
| 状态不一致 | 同强键最终状态冲突 | 以第三方记录作为外部事实，但不覆盖内部账本；人工决定补偿/更正 |
| 重复交易 | 外部平台流水重复，或同业务发生多个有效平台流水 | 区分重复文件与真实重复扣/付；需要时发起人工追款/退款流程 |
| 手续费不一致 | 单笔费用或日汇总与内部预估不同 | 按正式费率/外部明细复核，单独做费用更正分录 |
| 商户/渠道归属不一致 | 单号匹配但商户、产品或渠道不符 | 高风险工单；核查路由配置、历史变更和跨主体记账 |
| 超时未确认 | 超过产品 SLA 仍处理中/账单未到 | 主动查询一次或按受控策略重试；付款未知状态绝不重新发起 |

## 10. 管理平台看板指标

所有金额默认按币种分组；跨币种不得无汇率口径直接相加。实时层以回调/主动查询为估算，日终层以完成导入且通过范围校验的官方账单/文件为确认。下表的“日终”不预设 D+0/D+1，具体生成时点为 `OWNER_REQUIRED`。

| 指标 | 数据源 | 统计口径 | 数据更新时间 | 实时/确认 | 手续费、退款、在途结算口径 |
| --- | --- | --- | --- | --- | --- |
| 当日/期间收款总额 | Joinpay 收款事件；内部支付作对照 | 业务日期内第三方最终成功收款本金总额；按商户/渠道/币种分组 | 回调/查询后实时；文件后重算 | 实时估算 + 日终确认 | 毛额，不扣手续费/退款；在途结算仍计收款 |
| 退款总额 | Joinpay 最终退款事件 | 退款完成日内成功退款本金；部分退款逐笔累计 | 查询/回调后；文件后确认 | 实时估算 + 日终确认 | 不含原收款手续费；跨日归退款完成日并可回溯原单 |
| 代付/提现总额 | Joinpay 委托付款事件 | 最终成功代付本金；失败/处理中不计成功额 | 查询/通知后；文件后确认 | 实时估算 + 日终确认 | 不含代付手续费；处理中单列 |
| 手续费 | 收款/代付费用事件或费用账单 | 官方已确认的各类手续费按费用类型/归属日汇总 | 单笔接口可实时；完整账单后确认 | 单笔估算 + 日终确认（能力待证） | 不与本金净额混记；退款退费规则待官方确认 |
| 结算金额 | 结算单/账户流水；收款 `settleAmount` 作单笔参考 | 实际结算批次入账金额；没有结算单时不得把收款结算额之和冒充银行到账 | 结算文件/流水到达后 | 日终/结算确认 | 区分待结算、冻结和已入账；退款/费用是否轧差按官方文件 |
| 净现金变动 | 首选账户资金流水；次选已确认资金事件 | 账户口径：期间官方资金账户流入减流出；若无账户流水，只展示“业务现金估算”=收款-退款-代付-手续费 | 流水/文件到达后；估算可实时 | 账户流水为确认；公式为估算 | 明示是否含费用；在途结算不等于银行现金变动，不能重复计入 |
| 已匹配金额与匹配率 | `reconciliation_match` + 对账范围内外部事件 | 已强键匹配外部本金 / 范围内可匹配外部本金；费用/结算另报匹配率 | 每次对账运行后 | 日终确认 | 不用净额掩盖退款/费用差异；在途按独立状态 |
| 未匹配笔数与金额 | `reconciliation_exception` | 外部孤儿 + 内部缺外部事实，按方向分别计数/金额 | 实时发现；日终范围闭合后确认 | 实时预警 + 日终确认 | 本金、退款、费用、结算分别展示 |
| 金额不一致 | 匹配结果 | 强键相同但同类资金事件金额不同的笔数/绝对差额 | 每次对账后 | 日终确认 | 手续费不混入本金；部分退款先聚合到退款维度 |
| 状态不一致 | 匹配结果 | 内外最终状态冲突，或一方最终、一方仍处理中 | 查询/对账后 | 实时预警 + 日终确认 | 不以金额净零消除状态差异 |
| 孤儿流水 | 外部账单 vs 内部事件 | Joinpay 有、内部无强键候选 | 文件导入后 | 日终确认 | 按收款/退款/代付/费用/结算分类 |
| 重复流水 | 外部唯一键、文件哈希、内部幂等键 | 区分重复导入、外部重复资金事件、内部重复指令 | 导入/对账时 | 实时阻断 + 日终确认 | 重复文件金额不计两次；真实重复交易保留两笔证据 |
| 超时未确认 | 日内事件 + 产品 SLA 配置 | 超过经官方确认 SLA 仍未知/处理中或账单晚到 | 定时计算 | 实时预警 | 不计入最终成功；不自动重发退款/付款 |
| 待人工复核 | 差异工单 | 未分派、处理中、待复核、待关闭的工单数量/风险金额 | 工单状态变更后 | 实时运营指标 | 按差异类型展示，不参与现金净额 |

### 10.1 筛选与单笔穿透

`[INFERRED]` 看板最小筛选维度：账务/发生日期、商户主体别名、Joinpay 产品、下游渠道、业务类型、币种、实时/日终层、内部/外部状态、差异类型和处理人。

`[INFERRED]` 单笔穿透按权限展示：内部业务单 → 审批/付款或退款指令 → 内部账务分录 → `PayOrder`/提现等迁移来源 → Joinpay 商户单号/平台流水（按角色脱敏）→ 原始文件/行哈希与来源 → 回调/查询证据 → 匹配规则/差异工单/更正分录。禁止从看板直接无审批重发支付、退款或代付。

## 11. 安全、权限、审计和运维要求

1. **凭据与网络权限。** `[OWNER_REQUIRED]` 每个商户/产品独立确认签名方式、密钥/证书、允许来源、IP 白名单和最小 API 权限；密钥只放受控秘密系统，应用日志和数据库不存明文。公开资料未证明 IP/证书要求，实施时不能猜。
2. **日志最小化。** `[CODE_CONFIRMED]` 旧 `HJPayUtils` 在 `E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:64,92,117,145,183,202` 附近记录完整请求/响应，代付请求可能含姓名、账号和签名字段。新平台必须字段级白名单日志、标识符掩码、响应摘要与独立敏感审计；不得复制旧日志方式。
3. **测试环境。** `[CODE_CONFIRMED]` 旧代付在非 `pro` 环境只把金额压到一个小额，但仍组装真实收款信息并指向正式域名；见 `E:\zzsh\analysis\admin\source\com\mdd\common\util\HJPayUtils.java:157-186`。小额不等于沙箱；新平台没有汇聚书面测试方案时必须 fail closed，不能复用这种保护。
4. **回调入口。** 先保存原始字节/规范化参数摘要，再按当前商户版本验签；校验商户、产品、商户单号、币种、金额和状态迁移；业务副作用须幂等。验签失败或金额不符不回写成功。
5. **未知状态。** 超时、网络失败、解析失败和官方处理中统一进入 `UNKNOWN/PENDING_REVIEW`；按已知单号受控查询。资金指令不得因“没收到成功”而自动重发。
6. **原始账单。** 对象存储只追加，保存内容哈希、取得来源和访问审计；下载/上传、解析、匹配、复核、过账权限分离。人工上传至少记录上传者、复核者和来源后台范围。
7. **文件版本与晚到。** 同业务日可接收补发/修正版本，但旧版本不可覆盖；每次重跑绑定输入文件集、解析器和规则版本。只有范围完整、校验通过才标记日终确认。
8. **职责分离。** 付款审批、发起、结果确认、对账复核、更正过账至少形成可审计的角色边界；隐藏按钮不是权限。高风险更正需双人复核。
9. **数据保护。** 银行卡、姓名、证件、密钥、签名、回调原文等按最小必要加密/令牌化；看板默认脱敏；导出带水印、权限和审计，保留期限由合同和合规要求确定，不在本文猜测。
10. **运行审计。** 每次对账记录开始/完成时间、账户/日期范围、输入文件及哈希、数据截止点、解析器/规则版本、匹配/差异数量金额、执行者、复核者和失败原因。
11. **监控。** 分开监控回调验签失败、查询积压、账单晚到、解析错误、余额突变、重复文件、差异 SLA；报警不得包含原始账号、姓名、密钥或完整请求体。

## 12. 旧平台与新方案之间的缺口

| 旧平台证据 | 风险/缺口 | 新平台最低要求 |
| --- | --- | --- |
| 收款回调读到平台/银行流水、手续费、结算额后，只按商户单号把本地状态置成功；`E:\zzsh\analysis\front\source\com\mdd\front\controller\PayController.java:191-249`、`E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java:333-363` | 关键外部证据丢失，金额/商户绑定不充分 | 验签后校验商户/金额/币种，保存外部事实和原始证据；业务副作用幂等 |
| 主动订单查询方法存在但无调用方；`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:82-105` | 丢回调/未知状态不能系统性收敛 | 对已知单号建设受控查询；终态前保留未知状态 |
| 退款方法只验响应签名，调用方随后本地标成功；退款回调直接 `success`；`E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java:131-155`、`E:\zzsh\analysis\front\source\com\mdd\front\controller\PayController.java:255-286`、`E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\OrderAfterServiceImpl.java:442-460` | 本地退款成功可能与第三方结果断链 | 保存退款请求、平台退款流水、查询/回调终态；部分退款一对多；未知不得标成功 |
| 代付发起响应丢弃、回调 URL 为空；查询调用只取状态/错误；`E:\zzsh\analysis\admin\source\com\mdd\common\util\HJPayUtils.java:157-208`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AutoTransferJob.java:27-59` | 平台流水/费用/完成时间缺失；依赖轮询 | 保存发起响应和平台流水；官方允许时接通知；未知状态不重复付款 |
| `PayOrder`/退款/提现实体没有形成统一外部资金事件；相关字段见第 3 节 | 跨业务、跨商户、跨产品难统一对账 | 以独立 provider event + 映射关系保留双方事实，不直接改写旧业务记录 |
| 支付服务商开关只保存当前值，定时任务配置来自数据库；`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\PayChangeJob.java:17-35`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\PayWayReturnJob.java:15-26`、`E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\CrontabServiceImpl.java:29-44` | 无法由源码恢复历史启用区间 | 新路由配置和商户产品关系带生效期/审计；迁移时把历史未知显式标记 |
| 没有看到日账单/SFTP/文件导入或差异闭环调用 | 无法发现外部孤儿、费用/结算/调账差异 | A/B/C 至少落地一种全量日终来源，再建设差异工单和更正分录 |
| 原请求/响应可能完整写日志 | 泄露商户号、签名和收款人信息 | 字段白名单、脱敏、加密与访问审计 |

`[INFERRED]` 旧系统最严重的问题不是“没有接口”，而是第三方终态和资金标识没有成为独立、不可变、可对账的事实。新平台不能简单扩大 `PayOrder` 字段后用 Joinpay 状态覆盖内部状态；必须保留外部事实、内部义务和匹配/更正过程三层。

## 13. `UNKNOWN / OWNER_REQUIRED` 清单

| 编号 | 状态 | 缺口 | 所需输入/确认方 | 未解决时的限制 |
| --- | --- | --- | --- | --- |
| U-01 | `OWNER_REQUIRED` | 当前实际签约主体、`MERCHANT_MAIN/TRADE_WX/TRADE_ALIPAY` 与资金账户映射、生效期 | Owner/财务/运营，脱敏合同附件 | 不能确定对账分区和凭据边界 |
| U-02 | `UNKNOWN` | 微信 Native、支付宝 Native、退款、委托付款 Z 的历史实际启用区间与交易量 | Owner + 商户后台历史报表 | 只能称代码接入候选，不能称线上全量事实 |
| U-03 | `OWNER_REQUIRED` | 当前已开通产品、API 权限、签名方式、密钥/证书版本、IP 权限 | Owner + 汇聚支持 | 不能实施真实接口或回调验收 |
| U-04 | `UNKNOWN` | 日交易/退款/代付/手续费/结算/账户流水账单是否有 API 下载 | 汇聚支持书面答复与接口文档 | 自动拉账单结论保持“暂无法确认” |
| U-05 | `UNKNOWN` | 是否支持 SFTP，目录、文件名、加密、主机指纹、重发规则 | 汇聚支持/SFTP 接入手册 | 不能选择 B |
| U-06 | `OWNER_REQUIRED` | 商户后台是否可导出 CSV/Excel/压缩包、分别覆盖哪些产品/账户 | 有权限运营现场只读核验并提供脱敏样例 | 不能确认 C 可用 |
| U-07 | `UNKNOWN` | 文件生成时间、账务时区、历史留存、最大日期范围、频率/限流 | 汇聚支持/正式账单规范 | 不能制定可靠调度和补数 SLA |
| U-08 | `UNKNOWN` | 补单、冲正、撤销、修正版文件和历史重开机制 | 汇聚支持/账单版本规则 | 不能安全关闭历史差异 |
| U-09 | `UNKNOWN` | 手续费、退款退费、结算轧差、冻结/解冻、调账的逐笔字段与会计日期 | 费率合同 + 账单数据字典 + 样例 | 看板费用/净现金只能估算 |
| U-10 | `UNKNOWN` | 聚合退款应使用 2.3 还是 2.4；旧 2.6 请求与当前协议如何迁移 | 汇聚按商户出具的适用版本矩阵 | 不能安全实现退款 |
| U-11 | `UNKNOWN` | 旧 `closeOrder.action` 当前是否支持、替代地址和终态语义 | 汇聚历史/迁移文档 | 不能迁移关单逻辑 |
| U-12 | `OWNER_REQUIRED` | 委托付款的合规测试/沙箱方案 | 汇聚支持书面授权 + Owner 测试审批 | 不做任何真实代付验收 |
| U-13 | `OWNER_REQUIRED` | Owner 所说“开支全部经过 Joinpay”是否包含直连微信退款/付款代码覆盖的业务 | Owner 定义开支、退款、内部余额、人工付款边界 | 无法确定总体现金流分母 |
| U-14 | `UNKNOWN` | 旧生产数据库中是否持久化了反编译实体之外的 provider 字段/审计表 | 经授权的脱敏 schema/数据字典；本轮不读取生产 | 不把实体字段当真实 DDL，也不能断言历史数据绝对缺失 |

## 14. 向 Joinpay 技术支持索取材料的问题清单

建议 Owner 以“商户主体 + 产品 + 环境”为单位询问，并要求返回正式文档名称、版本/发布日期和适用商户范围：

1. 我方当前分别开通了哪些产品：聚合支付、微信 Native、支付宝 Native、退款、委托付款 P/Z/R、余额/资金账户、结算/对账？各自商户号、报备商户号和资金账户的关系是什么？
2. 旧 `trade/*.action` 与当前 `tradeRt/*` 的迁移表、停用时间和兼容策略是什么？`closeOrder.action` 的现行接口是什么？
3. 对当前商户，聚合退款请求/查询版本到底是 2.3 还是 2.4？请提供一致的请求、同步返回、异步通知和签名文档。
4. 是否提供按账务日获取**全量**聚合收款、退款、委托付款、手续费、结算、账户调账记录的 API？请给接口文档、权限申请、分页/范围/限流和错误重试规则。
5. 是否提供官方对账文件下载 API？文件分别覆盖哪些商户/产品/渠道/资金账户，何时生成，最晚何时稳定，可回溯多久？
6. 是否提供 SFTP？请给主机/端口获取方式、主机指纹验证、账号/密钥轮换、IP 白名单、目录、命名、压缩/加密、字符集、重发/补发手册。
7. 商户后台哪些菜单可导出 CSV/Excel/对账包？各菜单的角色权限、最大日期范围、字段字典和历史留存期是什么？页面查询与导出是否同口径？
8. 请提供每类账单的脱敏样例和数据字典：唯一键、商户订单号、平台/银行流水、原单/退款单、金额单位/币种、手续费、结算额、状态、发生/完成/账务日期、渠道和商户身份。
9. 手续费扣收、退款退费、结算轧差、冻结/解冻、冲正/撤销、人工调账分别在哪份账单，以正负数还是事件类型表达？
10. 原文件是否有签名、摘要、版本号或控制总额？同一账务日修正时是覆盖、增量文件还是新版本？怎样识别最终版本？
11. 回调重试、人工补发、单笔查询的终态定义是什么？未知状态多久后可升级人工处理？哪些错误绝不能重发资金请求？
12. 账户余额接口覆盖哪些账户？是否有账户流水 API/文件，能否返回期初、发生额、期末及关联业务单？
13. 结算明细能否关联到原收款/退款和银行入账流水？结算周期、节假日、在途和冻结如何表达？
14. 当前鉴权支持 MD5/RSA/证书中的哪些方式？各接口是否要求客户端证书、IP 白名单、固定出口、TLS 版本或报文加密？
15. 聚合支付是否有不会产生真实资金的沙箱/测试商户？委托付款是否有正式的测试环境、白名单收款人和限额？若没有，官方推荐的合规验收程序是什么？
16. 商户后台“付款对账单获取”和“账户明细查询”分别是页面、导出、API 还是 SFTP？是否也覆盖聚合支付，而非仅委托付款？

## 15. 来源索引

### 15.1 旧代码与归档证据

| 来源 | 用途/行号 | 证据边界 |
| --- | --- | --- |
| `E:\zzsh\analysis\front\source\com\mdd\common\util\HJPayUtils.java`；`E:\zzsh\analysis\admin\source\com\mdd\common\util\HJPayUtils.java` | 配置/地址 `:19-25`；渠道映射 `:27-35`；收款 `:38-80`；查询 `:82-105`；关单 `:107-129`；退款 `:131-155`；代付/查询 `:157-208`；响应验签 `:214-225` | `[CODE_CONFIRMED]` 两份文件哈希相同；不证明线上启用 |
| `E:\zzsh\analysis\front\source\com\mdd\front\controller\PayController.java` | 预支付场景 `:86-185`；收款通知 `:190-249`；退款通知 `:255-286` | `[CODE_CONFIRMED]` 入口代码，不是实际回调证据 |
| `E:\zzsh\analysis\front\source\com\mdd\front\service\impl\PayServiceImpl.java` | HJ/乐刷预支付 `:239-323`；收款处理 `:333-363`；保证金/雇佣/任务退款 `:394-499`；取消退款 `:528-545` | `[CODE_CONFIRMED]` 业务调用链 |
| `E:\zzsh\analysis\front\source\com\mdd\common\entity\PayOrder.java`、`E:\zzsh\analysis\admin\source\com\mdd\common\entity\PayOrder.java` | `:18-36` | `[CODE_CONFIRMED]` Java 字段候选，不是生产 DDL |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\OrderAfterServiceImpl.java` | 售后退款及本地成功 `:379-460` | `[CODE_CONFIRMED]` 本地/第三方终态断链 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\OrderManageServiceImpl.java` | 管理端取消退款 `:620-669`；预结算收益退款 `:1131-1155` | `[CODE_CONFIRMED]` 多条退款链 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\RentalAccountsServiceImpl.java` | 单个下机/退保证金 `:146-192`；全部下机 `:471-483` | `[CODE_CONFIRMED]` 其他退款调用方 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AccountBailReturnJob.java`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AdvanceOrderSettleJob.java`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\OrderSettleJob.java`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\TaskReturnJob.java` | 分别 `:53-62`、`:47-59`、`:47-59`、`:42-49` | `[CODE_CONFIRMED]` 定时退款调用；任务类存在不等于曾调度 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\AssistTaskServiceImpl.java` | 任务取消退款 `:224-230` | `[CODE_CONFIRMED]` 退款调用方 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AutoCheckJob.java`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\AutoTransferJob.java` | 发起代付 `:23-48`；查询并改状态 `:27-59` | `[CODE_CONFIRMED]` 代付定时调用链 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\FinanceWithdrawServiceImpl.java` | 审核/查询 `:128-205`；直连微信查询 `:214-273`；空余额方法 `:275-278`；HJ 查询 `:287-310`；发起 `:342-360` | `[CODE_CONFIRMED]` 区分 Joinpay 与直连微信路径 |
| `E:\zzsh\analysis\admin\source\com\mdd\common\entity\withdraw\WithdrawApply.java` | `:20-76` | `[CODE_CONFIRMED]` Java 字段候选，不是生产 DDL |
| `E:\zzsh\analysis\admin\source\com\mdd\common\entity\RefundRecord.java`、`E:\zzsh\analysis\admin\source\com\mdd\common\entity\RefundLog.java` | `:20-44`、`:20-38` | `[CODE_CONFIRMED]` Java 字段候选，不是生产 DDL |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\PayChangeJob.java`、`E:\zzsh\analysis\admin\source\com\mdd\admin\crontab\PayWayReturnJob.java` | `:17-35`、`:15-26` | `[CODE_CONFIRMED]` 服务商切换逻辑 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\CrontabServiceImpl.java`、`E:\zzsh\analysis\admin\source\com\mdd\admin\config\quartz\InvokeUtils.java` | `:29-44`、`:12-22` | `[CODE_CONFIRMED]` 调度取决于数据库命令配置 |
| `E:\zzsh\analysis\admin\source\com\mdd\admin\service\impl\SettingTradeImpl.java` | `:12-40` | `[CODE_CONFIRMED]` 渠道商户角色、开关、退款资金账户可独立配置 |
| `E:\zzsh\analysis\front\source\com\mdd\common\util\LSPayUtils.java`、`E:\zzsh\analysis\front\source\com\mdd\common\plugin\wechat\WxPayDriver.java`、`E:\zzsh\analysis\admin\source\com\mdd\common\util\YFTUtils.java`、`E:\zzsh\analysis\admin\source\com\mdd\common\util\QxnUtils.java`、`E:\zzsh\analysis\admin\source\com\mdd\common\util\SaasApiDemo.java` | 分别见 `:13-131`、`:52-151`、`:21-141`、`:47-260`、`:56-63` | `[CODE_CONFIRMED]` 其他服务商/示例边界；未发现调用不等于线上从未使用；不引用示例配置值 |
| `E:\zzsh\analysis\front\maven\like-common-1.0.0\pom.xml`、`E:\zzsh\analysis\admin\maven\like-common-1.0.0\pom.xml` | `:282-285` 声明 `com.joinpay:joinpay-sdk`，归档 POM 未给 version | `[CODE_CONFIRMED]` 只能证明依赖声明，不能确认旧生产 SDK 版本/来源 |
| `E:\zzsh\analysis\front\resources\application-dev.yml`、`E:\zzsh\analysis\front\resources\application-pro.yml`、`E:\zzsh\analysis\front\resources\application-uat.yml`；`E:\zzsh\analysis\admin\resources\application-dev.yml`、`E:\zzsh\analysis\admin\resources\application-pro.yml`、`E:\zzsh\analysis\admin\resources\application-uat.yml` | front 分别 `:93-98`、`:91-96`、`:91-96`；admin 分别 `:95-100`、`:98-103`、`:99-104` | `[CODE_CONFIRMED]` 仅记录键和相等关系；本文不输出敏感值 |

### 15.2 后续可行性 JAR 的静态检查（不是旧生产证据）

`[CODE_CONFIRMED]` `E:\zzsh\analysis\nestjs-feasibility\vendor\joinpay-sdk-1.0.jar` 属于后续可行性验证材料：文件大小 5,891,388 字节，SHA-256 为 `CFF8E683E959959F635CCB4E9695FEF81AA55CEE1C4B062E2A2DB6860BF087A4`。manifest 显示的是包内 Apache Commons HttpClient 3.0 信息，没有给出可采信的 Joinpay SDK 产品版本。静态类名包含 `AccountBalanceQuery/AdvanceQuery/BatchPay/BatchPayQuery/SinglePay/SinglePayQuery`、退款 `Refund/Refund_query`、`TransactionReconciliation` 和聚合查单；本文只执行了列包和 `javap` 静态检查，未运行联网代码。

`[INFERRED]` 这些类名最多是能力线索：它们不证明旧生产系统使用过该 JAR、不证明对应接口仍开放，也不证明商户有权限。当前官方聚合/委托付款 Java demo 只覆盖本文第 5 节列出的公开接口；未以 demo 类名补齐账单能力。

### 15.3 Joinpay 官方当前与历史资料

除另有说明，内容访问日期均为 2026-09-08；开放平台产品/菜单目录于 2026-09-09 最终复核，目录结构未发生变化。

| 官方来源 | 版本/更新日期 | 本文用途 | 等级 |
| --- | --- | --- | --- |
| [Joinpay 官网](https://www.joinpay.com/) | 页面无公开发布日期 | 商户后台可实时查交易明细、账务变动 | `OFFICIAL_CURRENT` |
| [聚合支付产品页](https://www.joinpay.com/pages/aggregatePay.html) | 页面无公开发布日期 | 主流钱包扫码、微信/支付宝等渠道、API 统一下单 | `OFFICIAL_CURRENT` |
| [委托付款产品页](https://www.joinpay.com/pages/alternativePay.html) | 页面无公开发布日期 | 委托付款 P/Z、后台/API 单笔/批量、订单查询、账户明细和对账单获取 | `OFFICIAL_CURRENT` |
| [开放平台产品列表](https://b.joinpay.com/apis/public/listOpenApi?pageNum=1&numPerPage=100) | 聚合产品记录更新 2018-11-22；委托付款产品记录更新 2026-08-24 | 确认公开产品和当前记录时间 | `OFFICIAL_CURRENT` |
| [聚合支付公开菜单](https://b.joinpay.com/apis/public/getMenuTree?apiId=6&isPreview=false) | 访问时菜单 | 公开接口范围：支付、单笔查单、退款、退款查询、下载 | `OFFICIAL_CURRENT` |
| [聚合协议（44）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=44&isPreview=false)、[签名（56）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=56&isPreview=false) | 2019-04-28、2018-11-30 | 传输/字符集、MD5/RSA 规则 | `OFFICIAL_CURRENT` |
| [支付（62）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=62&isPreview=false) | 2026-08-24，协议字段 2.6 | 当前地址、渠道、回调字段/重试 | `OFFICIAL_CURRENT` |
| [订单查询（63）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=63&isPreview=false) | 2025-11-06，协议字段 2.6 | 单笔查询字段和状态 | `OFFICIAL_CURRENT` |
| [退款（64）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=64&isPreview=false)、[退款查询（177）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=177&isPreview=false) | 2026-06-22、2025-07-25；页面字段 2.3 | 全/部分/多次退款、单笔查询/通知 | `OFFICIAL_CURRENT` |
| [聚合支付官方 Java 下载包](https://file.joinpay.com/group2/M00/AE/48/CgoenGqL6OGABu9cAJsIeVGG07k437.zip) | 内含《汇聚支付聚合支付API接口文档V2.6.10》，更新 2026-08 | PDF 全文与官方 demo；ZIP SHA-256 `FA8BBC6B6A76F2C327524872318A06E97220334D6B76AABBD758545CDF9A9A99` | `OFFICIAL_CURRENT`；其中 `.action` 样例按 `OFFICIAL_LEGACY` 使用 |
| [委托付款公开菜单](https://b.joinpay.com/apis/public/getMenuTree?apiId=10&isPreview=false) | 访问时菜单 | 公开接口范围：单笔/批量及查询、余额、下载 | `OFFICIAL_CURRENT` |
| [委托付款协议（84）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=84&isPreview=false)、[签名（85）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=85&isPreview=false) | 2026-08-24、2019-02-12 | JSON、字符集、MD5/RSA | `OFFICIAL_CURRENT` |
| [单笔（104）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=104&isPreview=false)、[单笔查询（105）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=105&isPreview=false)、[批量（106）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=106&isPreview=false)、[批量查询（107）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=107&isPreview=false) | 均更新 2026-08-24 | 委托付款与已知批次查询，不是历史账单 | `OFFICIAL_CURRENT` |
| [账户查询（108）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=108&isPreview=false)、[附录（109）](https://b.joinpay.com/apis/public/getOpenApiArticle?menuId=109&isPreview=false) | 均更新 2026-08-24 | 余额快照、产品代码、状态/未知处理 | `OFFICIAL_CURRENT` |
| [委托付款官方 Java 下载包](https://file.joinpay.com/group2/M00/0A/8E/Ch4enGqL-A-AWRPpAGIDuODjsOY367.zip) | 内含《汇聚支付委托付款API接口文档V1.28》，更新 2023-04 | PDF 全文与官方 demo；ZIP SHA-256 `0AF458905FFBE6FA6DC0F32BA2E079C39D9E1275991C6CE9CB27BBDF4D77A838` | `OFFICIAL_CURRENT`，但适用合同版本需确认 |

### 15.4 公开检索的阴性证据边界

`[UNKNOWN]` 2026-09-08 对 Joinpay 官方域名检索“对账单下载/SFTP/账户流水/交易账单/手续费/结算/关单”，并全文检查上述两份官方 PDF 及当前 Java demo；没有找到公开的日期范围账单、对账文件下载、SFTP、账户流水历史或独立关单接口规范。**这只说明公开资料未覆盖，不说明汇聚没有面向签约商户的非公开能力。** 所有能力结论仍以第 13、14 节要求的合同、后台和技术支持材料为准。
