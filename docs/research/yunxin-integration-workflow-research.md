# 洲洲商行新平台与网易云信 IM 集成能力及运营工作流优化调研报告

> 调研类型：只读、证据化调研
> 调研日期：2026-09-09
> 官方文档访问日期：2026-09-09
> 目标文件：E:/zzsh/zzsh/docs/research/yunxin-integration-workflow-research.md

## 1. 执行摘要

### 1.1 两个待决策问题

**Q79：群生命周期**

- [CODE_CONFIRMED] 旧平台在账号保证金/账号入库付款回调中创建云信群，并把群 ID 保存到 RentalAccounts.teamId；买家付款回调没有创建新群，而是邀请买家和客服进入该已有群，并将同一个群 ID 写入订单。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/PayServiceImpl.java:528-603、:605-672；字段证据：E:/zzsh/analysis/front/source/com/mdd/common/entity/RentalAccounts.java:21-91、E:/zzsh/analysis/front/source/com/mdd/common/entity/Order.java:26-124。
- [INFERRED] 这种数据模型和调用时序更接近“账号级群被订单复用”，但不能据此证明线上所有账号都曾成功建群、也不能证明多订单并发复用一定发生。
- [RECOMMENDATION] 新平台首期优先采用“每个订单一个独立高级群”，群与订单建立一对一唯一映射；账号与号主的长期关系可以另行保留为平台关系或受控单聊，不让买家继承前任买家的群历史。
- [OWNER_DECISION_REQUIRED] 最终仍需 Owner 在“每单独立群”和“账号长期复用群”之间确认。报告推荐的是风险较低、审计边界较清晰的每单独立群，不替 Owner 作最终决定。

**Q80：聊天记录保存与审计**

- [OFFICIAL_CURRENT] 云信公开文档证明了云端历史消息查询、按会话与时间/消息锚点查询、部分 SDK 的云端全文检索、消息抄送，以及消息服务端 ID 返回；全文云端检索需要在控制台开通相应能力，历史、漫游和附件留存期限受产品/套餐/配置影响。证据：[云信 IM API 概览与频控](https://doc.commsease.com/messaging/server-apis)、[历史消息](https://doc.commsease.com/messaging/guide/jg5MjQ4MTM?platform=web)、[MessageLogInterface](https://doc.commsease.com/messaging/api-refer/web/typedoc/Latest/zh/NIM/interfaces/nim_MessageLogInterface.MessageLogInterface.html)、[消息抄送服务概述](https://doc.commsease.com/messaging2/server-apis/jQ4ODE0NTY?platform=server)。
- [OFFICIAL_CURRENT] 公开文档没有在本次可复核材料中证明一个与套餐无关、可作为合规留存凭证的“控制台全量查询/导出并带完整操作审计”能力；客户端 SDK 的本地历史导出/迁移也不等于服务端合规导出。
- [RECOMMENDATION] 不默认同步全部聊天正文。首期至少保存结构化订单/群/成员/客服/交付/结账/云信请求结果，以及消息 ID、时间、会话和证据引用；争议发生时，由受权人员按最小范围提取正文或附件。只有在商务、法务和安全条件书面确认后，才考虑全量消息抄送。
- [OWNER_DECISION_REQUIRED] Owner 需确认平台是否接受“云信留存 + 结构化事件 + 按需证据提取”作为默认审计模式；若需要独立、长期、不可被撤回影响的证据，则必须增加平台侧留存范围。

### 1.2 当前运营问题的结论

- [CODE_CONFIRMED] 网站普通用户修改昵称或头像只更新平台 User 表，没有调用云信用户名片更新。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/UserServiceImpl.java:129-174、:288-299。
- [CODE_CONFIRMED] 注册时平台昵称与云信创建时传入的名称已经可能不同：普通注册将用户名传给云信，但平台昵称写成“用户”加序号；微信登录可能把微信昵称写入平台，但仍以“用户”加序号创建云信账号。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/LoginServiceImpl.java:62-90、:287-346。
- [CODE_CONFIRMED] 群成员昵称又被单独写成“买家”“卖家”“号主”“打手”等角色词，且旧代码没有在平台昵称变化时批量更新活跃群成员昵称。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/PayServiceImpl.java:559-560、:644-650、:738-740；E:/zzsh/analysis/front/source/com/mdd/front/service/impl/UserEmpServiceImpl.java:96-124。
- [OFFICIAL_CURRENT] 云信 SDK 会使用本地缓存；官方明确说明，除本人资料外，不保证其他用户资料实时更新，可通过主动拉取、收到消息、登录同步或资料变更监听刷新。证据：[用户资料](https://doc.commsease.com/messaging2/guide/zYwMzU1NTI?platform=client)，更新时间 2025-11-03。
- [INFERRED] “客服软件仍显示默认名称”的最可能根因按强度排序为：一、平台昵称更新没有触发云信全局资料更新；二、客服在群会话中实际看到的是已被固定为角色词的群成员昵称；三、客户端本地缓存未刷新；四、好友备注或账号名作为其他页面的展示回退。云信没有在公开文档中承诺所有客户端/IM Kit 页面的统一展示优先级，因此最后的具体页面来源仍需用受控验收确认。

### 1.3 最小可行工作流结论

建议把四类状态分开管理：

| 状态域 | 真实含义 | 不能替代 |
|---|---|---|
| payment_status | 付款渠道与本平台支付事实 | 不能代表云信成功或账号已交付 |
| order_status / fulfillment_status | 订单业务阶段、人工交付和收尾检查 | 不能代表第三方接口成功 |
| yunxin_status | 账号、群、成员、消息操作的云信状态 | 不能代表支付成功或人工完成 |
| exception_task | 需要重试或人工处理的异常 | 不能用“忽略异常”伪装成功 |

推荐链路为：

平台资料修改成功 → 写入幂等同步任务 → 更新云信全局用户名片 → 按展示策略更新活跃群成员昵称 → 记录请求、结果和版本 → 失败重试 → 超限进入异常中心 → 定期对账修复漂移。

### 1.4 重要安全发现

- [CODE_CONFIRMED] 旧 YunxinUtil.java 含有凭据承载常量，并在创建账号流程输出 token；本报告不记录任何值。证据：E:/zzsh/analysis/front/source/com/mdd/common/util/YunxinUtil.java:31-42、:147-166。这不是本轮修复范围，但在新平台接入或任何部署前应按 P0 处理。
- [CODE_CONFIRMED] 旧平台把手机号拼接进自动群消息和配置消息。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/PayServiceImpl.java:564-568、:653-663、:746-751；这与本任务冻结的“普通业务表、日志或自动消息不得保存或发送完整手机号”等规则冲突。

## 2. 范围、方法和证据分级

### 2.1 调查范围

本次读取了：

- 新项目：E:/zzsh/zzsh/AGENTS.md、RTK.md、docs/README.md、docs/architecture/technology-decisions.md、docs/architecture/multi-client-bff.md、既有支付对账研究文档；
- 旧平台反编译/归档源码：前台和管理端的云信工具类、用户/登录、支付、订单、客服、辅助任务、群解散定时任务、实体和管理服务；
- 旧 Web/管理端构建产物中的去敏检索线索，重点确认 NIM Web SDK、IM Kit UI、登录和本地缓存痕迹；
- 网易云信官方开发者中心公开文档。官方链接均使用 doc.commsease.com，并记录页面标题、页面显示的更新时间或文档版本。

本次先用 rg 定位 YunxinUtil、yunxin、NIM、IM Kit 和相关调用方，再沿调用方追踪支付、建群、邀请、改名、发消息、踢人、解散和失败处理；没有把工具类的孤立方法或 main() 示例当作线上行为。

### 2.2 证据标签

- [CODE_CONFIRMED]：旧源码/构建产物中直接可复查；
- [OFFICIAL_CURRENT]：网易云信官方当前公开文档直接说明；
- [OWNER_CONFIRMED]：本任务明确冻结或提供的业务事实；
- [INFERRED]：由直接证据推导，但未直接证实；
- [UNKNOWN]：现有材料不足以确认；
- [RECOMMENDATION]：新平台建议；
- [OWNER_DECISION_REQUIRED]：必须由 Owner 决定；
- [NOT_RUN]：本轮按安全限制未运行。

旧平台代码来自反编译/归档材料。代码存在只证明静态路径存在，不证明当时已部署、已开通套餐、已成功调用或所有分支在线上启用。

### 2.3 Owner 已冻结事实

以下直接采用任务提供的业务决策，不再重新论证，均标记为 [OWNER_CONFIRMED]：

- 新平台首期继续使用网易云信；
- 付款事实与云信交付状态分开，云信失败不能回滚真实支付；要自动重试并产生管理平台异常任务；
- 账号交付由客服主导，买家和号主不能绕过客服私下交付；
- 上号方式清单和提示文案由管理平台配置；
- 租赁结束必须完成退出、撤销授权、移除设备或修改密码等收尾检查，无法完成时进入异常流程；
- 普通业务表、日志和自动消息不得保存或发送游戏密码、验证码、完整手机号等敏感信息；
- Q79、Q80 尚未决定。

## 3. 旧平台云信调用链

### 3.1 调用方索引

rg 找到的实际旧代码调用方包括：

- 前台：LoginServiceImpl、PayServiceImpl、OrderServiceImpl、AssistTaskServiceImpl、UserEmpServiceImpl、UserServiceImpl、公共 YunxinUtil；
- 管理端：SystemAuthAdminServiceImpl、OrderManageServiceImpl、AssistTaskServiceImpl、UserServiceImpl、DismissTeamJob、公共 YunxinUtil；
- 管理端构建产物：E:/zzsh/analysis/admin/frontend-clues.txt:1-48 以及对应 dist/assets 线索。

旧 Maven 依赖直接包含 com.netease.nim:yunxin-im-server-sdk，但当前片段没有在该依赖声明处固定版本号，不能据此确定线上 SDK 版本。证据：E:/zzsh/analysis/admin/maven/like-common-1.0.0/pom.xml:236-242；前台同路径的 Maven 文件也存在相同依赖。

- [CODE_CONFIRMED] 在公共工具方法 E:/zzsh/analysis/front/source/com/mdd/common/util/YunxinUtil.java:44-270 及上述业务调用方的已检索范围内，未发现云端历史查询、全文检索、消息抄送、服务端导出或回调注册调用；这只能证明本次检索材料中没有对应调用，不能证明旧线上环境绝对没有外部补偿。

### 3.2 云信账号创建、字段和保存

#### 普通用户

- [CODE_CONFIRMED] 普通账号注册生成平台序号、随机 IM 账号、密码盐和平台邀请码；调用 YunxinUtil.createAccount(imAccount, username)，将云信返回的 accid/token 保存到 User.imAccount/User.imToken；随后给首个角色为 2 的管理员添加好友。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/LoginServiceImpl.java:62-90。
- [CODE_CONFIRMED] 手机登录首次创建账号时以“用户”加序号作为云信名称，并保存返回的 accid/token。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/LoginServiceImpl.java:102-140。
- [CODE_CONFIRMED] 微信登录首次创建账号时，平台可能采用微信昵称和头像作为平台字段，但云信创建仍传入“用户”加序号；因此平台昵称与云信全局 name 在初始时就可能不同。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/LoginServiceImpl.java:287-346。

#### 管理员/客服

- [CODE_CONFIRMED] 管理员创建校验用户名和昵称唯一性，生成平台密码哈希、头像和随机 IM 账号，以管理员昵称创建云信账号，并把云信返回的 accid/token 保存到 SystemAuthAdmin。证据：E:/zzsh/analysis/admin/source/com/mdd/admin/service/impl/SystemAuthAdminServiceImpl.java:163-191；实体字段：E:/zzsh/analysis/admin/source/com/mdd/common/entity/SystemAuthAdmin.java:19-55。
- [CODE_CONFIRMED] 管理端登录先校验平台用户名、密码、禁用状态和验证码，再建立平台登录会话；登录接口返回的是平台会话 token。证据：E:/zzsh/analysis/admin/source/com/mdd/admin/service/impl/SystemLoginServiceImpl.java:70-123。IM accid/token 是管理员资料中的独立字段，不应与平台会话 token 混淆。
- [CODE_CONFIRMED] 管理员在线/离线切换会调用云信全局用户名片更新；在线时写本地昵称，离线时在云信全局名称后追加“已离线”提示。证据：E:/zzsh/analysis/admin/source/com/mdd/admin/service/impl/SystemAuthAdminServiceImpl.java:231-282、:311-337。
- [CODE_CONFIRMED] 普通订单付款后从在线且 role_ids 包含 1 的客服中按 last_take_time 升序选择一名，邀请其入群、加为管理员并写入订单 serviceId；辅助任务从 role_ids 包含 5 的在线客服中选择，离线时回退到该角色的列表。证据：E:/zzsh/analysis/front/source/com/mdd/front/service/impl/PayServiceImpl.java:561-584、:705-712。
- [INFERRED] 这解释了客服软件可能显示“客服昵称 + 离线提示”，但不能证明客户端的每个页面都会立即刷新。

#### 云信工具层

- [CODE_CONFIRMED] YunxinUtil.createAccount 通过服务端 SDK 创建账号并返回云信账号资料；updateUser 通过 V2 用户接口只更新全局 name；该工具没有看到头像更新封装。证据：E:/zzsh/analysis/front/source/com/mdd/common/util/YunxinUtil.java:147-166、:259-270。
- [CODE_CONFIRMED] createTeam 设置群主、初始成员、群名和邀请模式；inviteTeamMembers、kickTeam、addManagerTeam、updateTeamNick、dismissTeam 分别封装入群、踢人、管理员、群成员昵称和解散。证据：E:/zzsh/analysis/front/source/com/mdd/common/util/YunxinUtil.java:44-145、:244-257。
- [CODE_CONFIRMED] sendMessage 使用 V2 会话消息接口发送单聊/群聊文本；addFriends 使用好友添加接口；工具层对异常主要是打印错误、返回 null 或不向上层返回结构化结果。证据：E:/zzsh/analysis/front/source/com/mdd/common/util/YunxinUtil.java:169-226。
- [CODE_CONFIRMED] 旧工具中存在更新群组基本信息的 V2.1 方法，但本次检索到的业务调用链没有证明该方法已被业务流程使用。证据：工具方法 :228-242；调用方索引中实际使用的重点为建群、邀请、成员昵称、消息、踢人和解散。

### 3.3 群创建与订单时序

| 阶段 | 旧代码行为 | 证据 | 证据结论 |
|---|---|---|---|
| 账号保证金/账号入库付款回调 | 创建云信群，初始成员为号主；成功后保存 RentalAccounts.teamId 和编号；将号主群昵称设为“卖家” | PayServiceImpl.java:605-672 | [CODE_CONFIRMED] 群创建发生在该回调，不是买家订单付款回调 |
| 买家付款回调 | 先把订单本地状态设为已支付/待接入，然后邀请买家进入 accounts.teamId，设置买家群昵称，邀请在线客服并添加管理员，发送群消息；之后把 accounts.teamId 写入 Order.teamId | PayServiceImpl.java:528-603 | [CODE_CONFIRMED] 买家付款路径是进入已有群，不是新建群 |
| 辅助任务付款回调 | 为任务创建新群，初始成员为号主，设置“号主”，必要时加入多个客服 | PayServiceImpl.java:691-765 | [CODE_CONFIRMED] 另一类业务采用任务级新群 |
| 订单取消/结账 | 本地订单或任务状态先更新，随后尝试踢人、发送消息或解散群；异常多为打印后继续 | OrderServiceImpl.java:624-882；OrderManageServiceImpl.java:694-713、:858-872 | [CODE_CONFIRMED] 云信操作与业务状态没有形成可靠的统一状态机 |
| 定时解散 | 读取 trade.dismissTeamDay，默认值为 7；查找已完成且未解散订单，调用解散后直接把 isDismiss 写成 1 | E:/zzsh/analysis/admin/source/com/mdd/admin/crontab/DismissTeamJob.java:28-53 | [CODE_CONFIRMED] 旧定时任务存在“云信返回 null 但本地仍可能标记已解散”的风险 |

### 3.4 失败处理

- [CODE_CONFIRMED] 建群、邀请、成员改名和发消息等工具方法主要 catch 后打印；支付回调中的异常通常只输出“云信异常”，随后仍持久化订单、账号或任务本地状态。证据：YunxinUtil.java:44-270；PayServiceImpl.java:559-599、:645-669、:738-758；OrderServiceImpl.java:624-878。
- [CODE_CONFIRMED] 管理端手工解散路径会检查返回对象非空，但没有发现统一重试队列、异常任务、幂等键或云信状态对账。证据：OrderManageServiceImpl.java:858-872；管理端云信调用方索引。
- [UNKNOWN] 未从旧代码证明是否另有未归档的线上任务、人工台账或客服软件规则补偿这些缺口。

## 4. 运营口径与代码时序差异

“下单后建群”是本任务要求核对的运营口径；它不是本报告替 Owner 确认的线上事实。

| 说法 | 代码直接证据 | 结论 |
|---|---|---|
| 下单时创建订单群 | 买家支付 orderCallback 只调用 inviteTeamMembers，没有 createTeam；使用 accounts.teamId | [CODE_CONFIRMED] 若“下单”指买家付款，代码不支持“此时新建群” |
| 账号上架/保证金后已有群 | accountBailCallback 在账号付款回调中 createTeam，并写入 RentalAccounts.teamId | [CODE_CONFIRMED] 代码实际把群创建提前到了账号保证金/入库阶段 |
| 买家付款后看到群 | 买家支付回调邀请买家进入已有 teamId | [CODE_CONFIRMED] “付款后接入群”成立，但不等于“付款后创建群” |
| 每个订单都有自己的群 | Order 有 teamId，但其值来自 RentalAccounts.teamId；RentalAccounts 只有一个 teamId 字段 | [INFERRED] 模型更接近账号级群复用；无法证明线上没有一账号一订单的偶然情况 |
| 群会在结账后关闭 | 结账消息提示若干天后解散，定时任务按订单执行 dismiss | [CODE_CONFIRMED] 存在计划解散；如果一个 teamId 被多个订单复用，可能出现边界冲突 |

因此，正式产品决策前必须把“业务口径中的建群”拆成：创建时间、买家加入时间、客服接入时间、订单与群的唯一关系、关闭时间。不能以口头口径覆盖代码时序，也不能以反编译代码宣称线上全量实际行为。

## 5. 昵称不同步根因分析

### 5.1 四层名称来源

| 层级 | 官方/代码含义 | 旧平台证据 | 当前判断 |
|---|---|---|---|
| 云信全局用户资料 | 用户名片中的 name、icon 等，由云信托管；服务端可更新 | YunxinUtil.java:259-270；官方[用户名片](https://doc.commsease.com/messaging/server-apis/zI0NzYyMDQ?platform=server)，更新时间 2025-11-13 | [OFFICIAL_CURRENT] 有独立更新接口；[CODE_CONFIRMED] 旧普通用户改名没有调用 |
| 群成员昵称 | 某个群内的成员 nick；与全局 name 是不同对象 | PayServiceImpl.java:559-560、:644-650、:738-740；官方[群成员管理](https://doc.commsease.com/messaging-enhanced/guide/zg5Mzg4Mjg?platform=web)，更新时间 2024-03-14 | [CODE_CONFIRMED] 旧代码主动覆盖为角色词；[OFFICIAL_CURRENT] 群主/管理员可按权限修改他人，用户可修改自己的群昵称 |
| 好友备注 alias | 某个操作者对某个好友的关系备注，不是对方全局昵称 | 旧代码只调用 addFriends：YunxinUtil.java:213-226，未见 alias 更新 | [OFFICIAL_CURRENT] 好友关系 API 支持 alias；[CODE_CONFIRMED] 旧调用链没有设置；具体客服页面是否优先展示 alias 为 [UNKNOWN] |
| 客户端本地缓存 | SDK/IM Kit 本地缓存中的资料、群成员和会话状态 | 构建产物出现 localStorage/NIM 登录与本地状态线索：E:/zzsh/analysis/admin/frontend-clues.txt:1-18、:27-48；官方[用户资料](https://doc.commsease.com/messaging2/guide/zYwMzU1NTI?platform=client)，更新时间 2025-11-03 | [OFFICIAL_CURRENT] 官方不保证其他用户资料实时更新；[INFERRED] 缓存是“云端已更新但客服仍看到旧名”的合理解释 |

### 5.2 是否存在统一显示优先级

- [OFFICIAL_CURRENT] 官方文档分别定义了全局用户资料、群成员昵称和好友备注接口，但本次公开文档未给出“所有客户端和所有 IM Kit 页面统一按全局昵称 > 群昵称 > 好友备注 > accid”的通用优先级。
- [INFERRED] 在群消息/群成员列表中，群成员 nick 通常是最接近当前群上下文的展示字段；在联系人/好友页面，alias 可能是该操作者自己的展示字段；未设置或未拉取时才可能回退到全局 name 或 accid。但这不是本次可直接证明的云信全端契约。
- [UNKNOWN] 当前客服软件具体页面究竟读哪个字段、是否对用户资料做二次平台映射、是否在浏览器本地缓存了旧值，必须通过当前版本客户端源码/厂商支持答复或非生产受控验收确认。

### 5.3 最可能根因排序

1. [CODE_CONFIRMED] 普通用户改昵称只写本地 User 表，没有调用 updateUser 或官方 updateUinfo；这是最高强度根因。
2. [CODE_CONFIRMED] 微信新用户的平台昵称可能来自微信，而云信全局 name 使用序号默认名；注册用户也存在平台昵称与云信 name 不一致。
3. [CODE_CONFIRMED] 买家/卖家/号主等群成员昵称是一次性角色覆盖，不是平台昵称同步。
4. [CODE_CONFIRMED] 管理员在线/离线逻辑只更新客服自己的全局云信名称，不会修复普通用户或活跃群成员。
5. [OFFICIAL_CURRENT] 客户端资料缓存不是强实时源，若客户端没有收到更新事件或主动拉取，仍可看到旧值。
6. [UNKNOWN] 好友备注、客服软件二次显示逻辑和具体缓存失效策略尚未被旧代码或公开文档确认。

### 5.4 必须验证的场景

| 场景 | 预期核查点 | 证据状态 |
|---|---|---|
| 入群前改名 | 云信全局资料先更新；入群时群 nick 的初始策略是什么 | [RECOMMENDATION]；需要当前 SDK/套餐验收 |
| 已在一个群中改名 | 全局 name 和该群 member nick 是否分别变化；客服页面刷新条件 | [OFFICIAL_CURRENT] 接口分别存在；显示结果 [UNKNOWN] |
| 同时在多个订单群中改名 | 是否枚举所有活跃 teamId 并逐群改 member nick；关闭群是否不再更新 | [RECOMMENDATION] |
| 云信更新成功但客户端显示旧名 | 是否收到资料/群成员事件；主动拉取、重新登录或清缓存哪个有效 | [OFFICIAL_CURRENT] 缓存可能延迟；具体客户端 [UNKNOWN] |
| 超时、限流、失败 | 使用同一个 RequestId 重试并记录未知结果，不能直接判失败后重复建群 | [OFFICIAL_CURRENT] 支持 RequestId 去重和 416/449 等状态；业务策略 [RECOMMENDATION] |
| 账号合并、注销、封禁 | 平台身份映射、云信账号不可删除、封禁和踢下线处理 | [OFFICIAL_CURRENT] 账号创建后只能封禁不能删除；平台合并策略 [UNKNOWN] |
| 客服改名或重新分配 | 更新客服全局资料；按订单重新加入/移除成员；业务客服归属与云信角色分开 | [CODE_CONFIRMED] 旧平台有在线名称和管理员操作；新策略 [RECOMMENDATION] |

## 6. 昵称同步推荐方案

### 6.1 数据权威

- [RECOMMENDATION] 平台用户昵称、头像和客服业务身份以新平台为业务权威；云信只作为通信资料副本和群上下文展示。
- [RECOMMENDATION] 平台保存 cloud_account_id 与平台 user_id 的稳定映射；不要因改名、更换头像或业务合并而生成新的云信账号。
- [OFFICIAL_CURRENT] 云信服务端用户名片支持更新 name、icon、sign、email、birth、mobile、gender、ex 等字段；本项目只同步非敏感的 name/icon，禁止把密码、验证码和完整手机号作为同步字段。证据：[用户名片](https://doc.commsease.com/messaging/server-apis/zI0NzYyMDQ?platform=server)，更新时间 2025-11-13。

### 6.2 推荐同步链路

1. 平台昵称/头像在本地事务内成功更新。
2. 写入一条带业务对象、字段版本和幂等键的同步任务；不要把同步作为用户请求必须同步完成的单一事务。
3. 服务端调用云信用户资料更新接口，只发送允许字段；为超时重试固定同一 RequestId。
4. 查询或维护平台侧的活跃订单群成员关系；如果群内展示策略要求显示真实昵称，再对每个活跃群调用群成员昵称更新；如果产品决定保留“买家/号主”等角色词，则不要用角色词字段承载用户真实昵称，应由平台 UI 展示角色徽标。
5. 记录操作类型、业务对象、版本、云信 endpoint、RequestId、结果码、耗时、完成时间和最后一次失败原因；不记录 token、AppSecret、消息正文或敏感联系人信息。
6. 对 408、415、449、500、503 等可重试/未知结果进行安全重试；对 416 退避并降低并发；对权限、禁用、参数和不存在等确定性失败进入异常任务。
7. 失败超过阈值进入异常中心，保留人工“重试资料同步”“查询云信资料”“刷新群成员昵称”“关闭任务”的入口。
8. 定期以平台用户资料、活跃群成员资料和云信查询结果做漂移对账；对已关闭群不做无意义修复，对仍有订单的群优先修复。

### 6.3 昵称与角色分离

- [RECOMMENDATION] 不再把“买家”“卖家”“号主”“客服离线提示”写入唯一的群成员昵称字段。推荐保留真实展示名，角色用结构化成员角色和 UI 徽标表示。
- [RECOMMENDATION] 若因客服软件限制必须使用群成员昵称，则明确字段策略：群内 nick 只表示当前订单角色，平台真实昵称显示在管理平台；此时“平台昵称修改后客服群昵称不变”是产品设计而不是同步故障。
- [OFFICIAL_CURRENT] 群主可修改所有成员的群昵称，管理员对普通成员的权限取决于群角色；成员可以修改自己的群昵称。证据：[群成员管理](https://doc.commsease.com/messaging-enhanced/guide/zg5Mzg4Mjg?platform=web)、[群组功能](https://doc.commsease.com/messaging-enhanced/guide/TQ0NTI0MjQ?platform=web)，页面更新时间 2024-03-14。

## 7. 网易云信官方能力矩阵

说明：以下“官方是否支持”只表示当前官方公开文档描述了能力，不表示洲洲商行当前应用已开通、当前套餐包含或线上已启用。矩阵中的“旧代码是否使用”只表示静态调用证据。

矩阵中的链接文字为官方页面标题；所有官方链接均于 2026-09-09 访问。页面显示更新时间的，按页面或检索结果记录；未显示更新时间的页面以当前 Latest 类型文档、API 目录当前页或官方页面本身为准，并在“限制/风险”中保留待确认项。

| 能力 | 官方是否支持 | 接口/SDK | 版本或产品条件 | 旧代码是否使用 | 新系统价值 | 限制/风险 | 证据链接 |
|---|---|---|---|---|---|---|---|
| 创建 IM 账号 | 支持 | 服务端注册账号 | 服务端创建；返回 accid/token；账号 ID 在应用内唯一 | 是，普通用户和管理员均调用 | 建立平台用户与云信账号映射 | 账号创建后不能删除，只能封禁；不能把创建成功当作线上启用证据 | [注册云信 IM 账号](https://doc.commsease.com/messaging/server-apis/DQ3Nzk1MTY?platform=server)，更新时间 2025-11-13 |
| 更新全局用户资料 | 支持 | 服务端用户名片更新；V2 用户更新 | name/icon 等字段有长度限制；需服务端鉴权 | 局部使用，仅 updateUser 更新 name | 解决平台昵称/头像漂移 | 全局资料不等于群成员 nick；客户端缓存可能延迟 | [用户名片](https://doc.commsease.com/messaging/server-apis/zI0NzYyMDQ?platform=server)，更新时间 2025-11-13 |
| token 更新 | 支持 | update/refreshToken；动态/静态 token | 鉴权策略、有效期和客户端登录方式需配置 | 未发现业务调用 | 降低长期 token 风险，支持轮换 | token 不能写日志或发送给客户端以外的第三方；实际策略未确认 | [登录鉴权](https://doc.commsease.com/messaging/server-apis/zE2NzA3Mjc?platform=server)、[API 概览](https://doc.commsease.com/messaging/server-apis)，更新时间 2025-11-13 |
| 禁用/解禁/踢下线 | 支持 | V2 disable、kick；V1 block/unblock | 封禁后仍计入账号总数；可选择踢下线 | 未发现业务调用 | 注销、风控和账号回收的通信侧控制 | 云信账号不可删除；本地数据删除和云信封禁不是同一语义 | [封禁账号](https://doc.commsease.com/messaging2/server-apis/TIxMzI4MjE?platform=server)、[强制账号退出登录](https://doc.commsease.com/messaging2/server-apis/TkwNjgzNTk?platform=server)，更新时间 2025-11-28 |
| 好友、备注、黑名单 | 支持 | friend add/update/get；special relation | alias 为关系方备注；黑名单/免打扰有数量上限 | 只使用 addFriends；未发现 alias/黑名单 | 控制客服与用户的关系和通知 | alias 是操作者视角，不是全局昵称；旧代码未配置 | [查询好友信息](https://doc.commsease.com/messaging2/server-apis/DYwOTk2NjQ?platform=server)、[好友关系管理](https://doc.commsease.com/messaging/server-apis/DQ0MTY1NzI?platform=server)、[黑名单/免打扰](https://doc.commsease.com/messaging/server-apis/jEzNDQ4ODc?platform=server)，更新时间 2025-11-28/2025-11-13 |
| 高级群创建 | 支持 | V2.1 创建群组；旧 V1 create | 高级群/超大群及套餐不同；返回 team_id/tid | 是，旧代码用 V1 createTeam | 支持每单独立群 | 建群频控、每用户群数、重复创建和失败补偿必须设计 | [创建群组](https://doc.commsease.com/messaging2/server-apis/DIwODUwMTE?platform=server)，更新时间 2026-01-12；[API 概览](https://doc.commsease.com/messaging/server-apis) |
| 邀请、移除、解散 | 支持 | add/kick/remove team；事件监听 | 权限取决于群主/管理员和群配置 | 是，invite/kick/dismiss | 订单群成员和关闭流程 | 解散不可逆风险；旧代码常忽略返回结果 | [API 概览](https://doc.commsease.com/messaging/server-apis)、[群组管理](https://doc.commsease.com/messaging-enhanced/guide/DgyMjA4NTA?platform=web)，API 概览更新时间 2025-11-13 |
| 转让群主、管理员、禁言 | 支持 | changeOwner/addManager/removeManager/mute | 高级群角色权限；管理员通常不能操作群主/其他管理员 | 只发现 addManager；未发现转让/禁言 | 客服交接和异常管控 | 角色与平台客服授权不能混为一谈；必须防止过期客服写入 | [API 概览](https://doc.commsease.com/messaging/server-apis)、[群成员管理](https://doc.commsease.com/messaging-enhanced/guide/zg5Mzg4Mjg?platform=web) |
| 全局昵称与群成员昵称 | 分别支持 | updateUinfo；updateTeamNick；SDK updateMemberNick | 群主/管理员及成员自改权限受群配置影响 | 是，且旧代码写角色词 | 解决显示漂移和角色显示 | 公开文档未给统一全端显示优先级 | [用户名片](https://doc.commsease.com/messaging/server-apis/zI0NzYyMDQ?platform=server)、[修改群成员昵称](https://doc.commsease.com/messaging/server-apis/DU0MzE3MjE?platform=server) |
| 群成员数、群数量限制 | 有限制且可扩展 | 群组功能配置/API 频控 | 公开页面列出默认 200 人、最高可配置 5000；每用户创建群默认 500、最高 2000，旧页面存在不同套餐数字 | 未发现限制处理 | 评估每单建群容量和增长 | 页面/套餐数字有版本差异，当前合同上限仍是 UNKNOWN | [开通和配置群组功能](https://doc.commsease.com/messaging2/server-apis/TM3NjgzMjc?platform=server)，更新时间 2025-11-28；[群组功能](https://doc.commsease.com/messaging-enhanced/guide/TQ0NTI0MjQ?platform=web) |
| 文本、图片、文件、自定义消息 | 支持 | 服务端/客户端 sendMessage | 文本、图片、语音、视频、地理位置、文件、提示、自定义；扩展字段和安全通按套餐配置 | 文本群/单聊使用；图片封装存在但未证明业务调用 | 业务通知和客服沟通 | 自动消息不能承载密码、验证码、完整手机号；自定义消息未开安全通时可能不审核 | [发送消息](https://doc.commsease.com/messaging2/server-apis/TEzMDQwODc?platform=server)，更新时间 2026-01-16 |
| 送达、已读回执、撤回 | 部分支持 | send callback、markRead、recall/delete | 群已读需支持套餐/配置且群规模有限；撤回时长可配置，最长公开到 7 天 | 只发送消息；未发现已读/撤回 | 识别客服接入和阅读情况 | 送达/已读不等于人工执行；撤回/删除会削弱取证 | [消息已读回执](https://doc.commsease.com/messaging-uikit/guide/jkyMzE1NDU?platform=android)、[撤回/删除消息](https://doc.commsease.com/messaging2/server-apis/jAwNTEzODQ?platform=server)，更新时间 2025-11-28 |
| 服务端回调/Webhook | 支持 | 第三方回调、消息相关回调 | 需控制台开通/配置；第三方回调与抄送是不同能力 | 未发现 | 实时同步群/成员/消息事件 | API 发送消息不触发第三方回调；公开回调说明提到请求次数/重试有限，需本地幂等 | [回调说明](https://doc.commsease.com/messaging2/server-apis/jI3ODc2ODE?platform=server)，更新时间 2026-05-29；[消息相关回调](https://doc.commsease.com/messaging2/server-apis/TQ5NDQwNDQ?platform=server) |
| 消息抄送 | 支持 | HTTP/HTTPS JSON 抄送 | 需 IM 和消息抄送开通；超时 5 秒；可申请高保障抄送 | 未发现 | 平台结构化审计或选择性正文留存 | 需去重；普通抄送可缓存最近 30 天最高 50 万条；高保障重试需单独开通 | [消息抄送服务概述](https://doc.commsease.com/messaging2/server-apis/jQ4ODE0NTY?platform=server)、[开通和配置消息抄送](https://doc.commsease.com/messaging2/server-apis/jY5MDk1NTQ?platform=server)，更新时间 2025-11-28 |
| 在线状态、多端登录 | 支持 | login/logout/currentLoginClients/online status | 登录策略、应用标识安全和客户端版本需配置 | 客服有平台 onLine 字段；未发现云信在线查询 | 客服池分配和离线接入 | 平台 onLine 不等于云信实时在线；需用服务端查询或事件校正 | [登录及登出 IM](https://doc.commsease.com/messaging2/guide/Dk1MTY4MzA?platform=client)、[API 概览](https://doc.commsease.com/messaging/server-apis) |
| 云端历史、漫游、离线消息 | 支持，但期限受限 | getHistoryMsgs；server query history；消息 option history/roam/persistent | 公开群组页面列出标准版最近 1 年、增值可扩至 3 年；漫游/离线另有限额；消息可关闭存储 | 未发现 | 争议查询和客服补看 | 不能保证永久、不可删除或跨套餐一致；消息可撤回/删除/清空 | [历史消息](https://doc.commsease.com/messaging/guide/jg5MjQ4MTM?platform=web)、[主要功能](https://doc.commsease.com/messaging/concept/TUxMzM5Mjg?platform=client)、[发送消息](https://doc.commsease.com/messaging/server-apis/DQ2NTg4ODE?platform=server) |
| 控制台查询聊天记录 | 当前公开资料不足以确认 | 控制台公开文档主要描述功能配置 | 是否覆盖单聊/群聊、查询权限、导出格式和审计需商务/技术确认 | 未发现 | 运营人工取证 | 不能把控制台存在等同于可审计导出 | [API 概览](https://doc.commsease.com/messaging/server-apis)、[消息抄送配置](https://doc.commsease.com/messaging2/server-apis/jY5MDk1NTQ?platform=server) |
| 服务端查询、全文检索、导出 | 查询/部分全文检索支持；统一服务端导出未证实 | cloud history API；Web msgFtsInServer；客户端本地 export | 全文云端检索需控制台开通；查询通常按会话/时间/锚点分页；SDK 本地导出是迁移能力 | 未发现 | 低成本按需查证 | 全文检索和导出权限、范围、审计、附件打包未确认；本地导出不等于平台留存 | [MessageLogInterface](https://doc.commsease.com/messaging/api-refer/web/typedoc/Latest/zh/NIM/interfaces/nim_MessageLogInterface.MessageLogInterface.html)、[历史消息](https://doc.commsease.com/messaging/guide/jg5MjQ4MTM?platform=web)、[Android 更新日志](https://doc.commsease.com/messaging2/concept/zI4NDQ1NDk?platform=client) |
| 附件保存期限和下载 | 支持 NOS 存储和下载 | NIM attachment/NOS | 公开文档称默认可不失效，也可设置过期；实际套餐、URL、权限需确认 | 旧代码有图片发送封装；未见审计保存 | 支持订单证据附件 | 消息过期/删除后可能失去 URL 线索；下载权限和合规删除需单独设计 | [NOS 存储场景](https://doc.commsease.com/messaging/guide/jIzNjg1MDU?platform=flutter)，更新时间 2024-03-07 |
| 敏感词、内容审核、封禁、举报 | 敏感词/易盾审核/账号封禁支持；举报闭环未确认 | 安全通、客户端本地反垃圾、block/mute/blacklist | 易盾/安全通和自定义策略需申请或控制台开通；Web 端本地反垃圾能力有限 | 未发现；旧代码发送了不应自动发送的联系信息 | 降低违规和敏感信息传播 | 不能代替平台敏感数据禁发规则；举报、申诉、操作审计需自建/确认 | [反垃圾（内容审核）](https://doc.commsease.com/messaging/guide/zc1ODMyMzk)，更新时间 2024-05-27；[封禁账号](https://doc.commsease.com/messaging2/server-apis/TIxMzI4MjE?platform=server) |
| Web、iOS、Android、微信小程序 | 官方 SDK/文档覆盖 | NIM SDK V10、Web/uni-app/小程序及原生 SDK | 各平台版本、能力和 UI Kit 不同；需分别验证 | 旧管理端有 Web SDK/IM Kit 线索；未发现新平台接入 | 保持 Web-first 后扩展多端 | 不可把 Web DOM/Cookie/Server Action 当业务契约；不能在客户端放服务端密钥 | [用户资料](https://doc.commsease.com/messaging2/guide/zYwMzU1NTI?platform=client)、[收发消息](https://doc.commsease.com/messaging2/guide/DYzMjA0Njc?platform=client)、[接入流程](https://doc.commsease.com/messaging/concept/TY1OTU4NDQ?platform=client) |
| API 限流、错误码、重试和 SLA | 限流/错误码/请求去重支持；SLA 未在公开资料确认 | API 概览、状态码、RequestId、SDK 主备域名 | 416 频控并可能封禁一段时间；449 表示需重试；相同 RequestId 在 60 秒内可去重；SLA 需合同 | 未发现重试和统一 RequestId | 防止重复建群和消息 | 旧代码无安全重试；创建超时的重复风险仍需验证 | [API 调用方式](https://doc.commsease.com/messaging/server-apis/jk3MzY2MTI?platform=server)、[状态码/错误码](https://doc.commsease.com/messaging/server-apis/TM5NTk2Mzc?platform=server)、[API 频控](https://doc.commsease.com/messaging/server-apis)，更新时间 2025-11-13 |
| 付费/增值/需单独开通 | 多项需要 | 群容量、历史年限、群已读、全文检索、消息抄送、安全通/易盾等 | 公开文档频繁注明套餐、控制台或商务开通 | 当前材料不能证明已开通 | 形成上线前能力清单 | 文档“支持”不等于当前合同包含；必须取得应用级书面确认 | [开通和配置群组功能](https://doc.commsease.com/messaging2/server-apis/TM3NjgzMjc?platform=server)、[群组功能](https://doc.commsease.com/messaging-enhanced/guide/TQ0NTI0MjQ?platform=web)、[消息抄送概述](https://doc.commsease.com/messaging2/server-apis/jQ4ODE0NTY?platform=server) |

### 7.1 官方文档关键版本与时间登记

| 页面标题 | 页面显示的更新时间/版本 | 本报告用途 |
|---|---|---|
| 云信 IM API 概览与频控 | 2025-11-13 17:11:40 | API 列表、默认频控和控制台配置 |
| 用户名片 | 2025-11-13 17:11:40 | 全局 name/icon 和查询/更新 |
| 注册云信 IM 账号 | 2025-11-13 17:11:40 | accid、token、全局 name/icon |
| 创建群组 | 2026-01-12 14:13:39 | 当前 V2.1 群创建和 team_id |
| 开通和配置群组功能 | 2025-11-28 10:24:27 | 群容量、群数、已读及套餐配置 |
| 用户资料 | 2025-11-03 14:49:59 | 资料缓存、刷新和跨平台 |
| 消息抄送服务概述 | 2025-11-28 10:24:27 | 5 秒超时、去重、缓存、重试开通 |
| 回调说明 | 2026-05-29 11:26:40 | API 消息不触发第三方回调、回调可靠性 |
| 发送消息 | 2026-01-16 10:56:18 | 消息类型、服务端消息 ID、错误码 |
| Android 更新日志 | 10.9.75/10.9.80 条目 | 客户端历史消息导出/全文检索能力边界 |
| MessageLogInterface | Latest 类型文档 | Web 云端历史、全文检索和清除接口 |

以上页面均于 2026-09-09 访问；若页面的产品/套餐限制与合同、控制台实际配置冲突，以应用级书面合同和当前控制台配置为准。

## 8. Q79 群生命周期方案对比

### 8.1 方案表

| 维度 | 方案 A：每个出租账号长期复用一个群 | 方案 B：每个订单独立群 | 方案 C：混合隔离 |
|---|---|---|---|
| 历史消息泄露 | 高；前任买家、后任买家和客服可能共享历史上下文 | 低；订单天然隔离 | 中；账号内部群仍需严格限制，买家群按订单隔离 |
| 成员残留 | 高；买家移除、客服轮换、临时成员容易遗漏 | 低；订单关闭时对该群做完整收尾 | 中；长期账号群只保留号主和受限内部成员 |
| 客服交接 | 简单但上下文混杂 | 需要加入/移除，但边界清晰 | 账号内部交接简单，订单交付仍需独立分配 |
| 昵称管理 | 一个群内角色不断变化，漂移风险高 | 角色与订单一致，容易冻结 | 需维护两套规则 |
| 群数量/频率 | 创建量低 | 创建量高；小群规模通常可控，但必须核对配额和频控 | 中等 |
| 建群失败补偿 | 账号已有群可能继续承接，掩盖异常 | 必须有等待接入/异常任务，付款不回滚 | 需要两条异常路径 |
| 订单、群、账号映射 | 一个账号对应一个群、多个订单共用，争议难定位 | order_id 与 team_id 唯一，审计最清晰 | 账号和订单各自有映射 |
| 旧订单迁移 | 兼容旧模型最容易 | 旧群不能凭空拆分，需标记历史群 | 可让旧订单留在历史账号群，新订单改为独立群 |
| 运营处理成本 | 表面低，异常和争议处理成本高 | 建群/关闭动作更多，但可自动化和可观测 | 最高，培训和权限更复杂 |
| 争议举证 | 需要按时间和成员切片，容易串案 | 直接按订单取群和证据 | 新旧订单证据模型并存 |
| 关闭/归档 | 不能按单关闭，否则可能影响后续订单共用群 | 订单完成、保留期结束后解散或归档 | 订单群按单关闭，账号群长期保留 |

### 8.2 推荐

- [RECOMMENDATION] 采用方案 B：每个订单一个独立高级群，群成员最小化为号主、买家、当前客服和必要的管理角色；创建成功后保存唯一的 order_id ↔ team_id 关系。
- [RECOMMENDATION] 订单群应在本地订单支付事实确认后进入“待建群/待客服接入”，由异步任务创建；建群成功不等于账号交付成功，客服仍要按配置清单人工确认。
- [RECOMMENDATION] 订单群关闭顺序为：完成租赁结束检查 → 平台记录人工结果 → 移除不再需要的成员/限制访问 → 按保留策略解散或标记归档 → 对账确认云信状态。
- [RECOMMENDATION] 对旧账号级 teamId 不做假设性拆分。迁移时保存 legacy_team_id、来源对象、历史订单范围和不确定性；新订单从切换点开始使用新规则。
- [OWNER_DECISION_REQUIRED] 如果 Owner 因客服习惯要求账号长期群，至少应采用方案 C 的隔离约束：买家不得进入长期账号群；长期群只保留号主和受控内部客服；每个订单仍建立独立买家群。

## 9. Q79 推荐与待决策项

### 9.1 正式结论

**推荐：每个订单创建独立云信高级群；最终选择：OWNER_DECISION_REQUIRED。**

推荐原因：

- 降低前任买家历史、成员残留和群消息串单风险；
- 让订单、群、成员、客服转交和争议证据形成一对一边界；
- 让关闭群与租赁结束一一对应，不会因为某个订单结束而误解散后续订单共用群；
- 允许保留平台级账号关系，而不把账号级长期沟通和交易交付混在同一个群里。

上线前必须取得的客观确认：

- 当前应用/套餐的群创建频控、每用户群数量、每群容量；
- 订单峰值建群速率是否需要调额；
- 建群超时重试的 RequestId 行为和重复创建处置；
- 订单完成后解散、历史查询、证据保留的合同边界。

## 10. 聊天记录保留能力

### 10.1 云信能否保存、检索和导出

**保存**

- [OFFICIAL_CURRENT] 普通服务端消息接口默认支持 history、roam、persistent 等存储选项；消息成功响应可返回服务端消息 ID；但发送时可关闭某些存储，且功能需要相应服务/配置。证据：[发送消息](https://doc.commsease.com/messaging/server-apis/DQ2NTg4ODE?platform=server)，更新时间 2025-11-13。
- [OFFICIAL_CURRENT] 公开群组功能页面列出标准版云端历史最近 1 年、增值可扩至 3 年；漫游、离线消息另有按时间和条数限制。证据：[群组功能](https://doc.commsease.com/messaging-enhanced/guide/TQ0NTI0MjQ?platform=web)、[主要功能](https://doc.commsease.com/messaging/concept/TUxMzM5Mjg?platform=client)。
- [UNKNOWN] 当前洲洲商行应用的实际套餐、云端历史年限、消息漫游、群新成员历史可见性和消息级存储选项没有被登录控制台或合同确认。

**检索**

- [OFFICIAL_CURRENT] Web 历史接口支持按会话目标、开始/结束时间、lastMsgId/idServer、方向和分页条数查询；单次限制公开为最多 100 条。证据：[历史消息](https://doc.commsease.com/messaging/guide/jg5MjQ4MTM?platform=web)。
- [OFFICIAL_CURRENT] Web MessageLogInterface 公开了 getHistoryMsgs、msgFtsInServer、msgFtsInServerByTiming；全文云端检索要求在控制台开通“全文云端消息检索”。证据：[MessageLogInterface](https://doc.commsease.com/messaging/api-refer/web/typedoc/Latest/zh/NIM/interfaces/nim_MessageLogInterface.MessageLogInterface.html)。
- [OFFICIAL_CURRENT] 服务端 API 目录包含云端历史消息查询、消息 ID、会话和群相关查询能力，但公开材料没有证明一个不受 SDK/套餐限制的通用批量导出接口。证据：[云信 IM API 概览与频控](https://doc.commsease.com/messaging/server-apis)。

**导出**

- [OFFICIAL_CURRENT] Android 10.9.75 更新记录新增历史消息导出/导入到本地文件的消息迁移能力；iOS/Web SDK 也有本地消息导出或迁移相关接口文档。证据：[Android 更新日志](https://doc.commsease.com/messaging2/concept/zI4NDQ1NDk?platform=client)、[NIM iOS API](https://doc.commsease.com/messaging/api-refer/iOS/doxygen/Latest/zh/index.html)。
- [INFERRED] 客户端本地导出适合用户设备迁移或开发者自建流程，不等于运营人员从云端按订单导出一份有权限、留痕、不可篡改的合规证据包。
- [UNKNOWN] 云信控制台是否支持当前应用按 accid、群 ID、消息 ID、时间范围检索并导出，以及导出操作是否有操作审计，本次公开资料未确认。

### 10.2 查询维度和边界

| 维度 | 官方公开能力 | 结论 |
|---|---|---|
| accid | 用户资料、好友关系、单聊历史和服务端消息 API 使用 accid | [OFFICIAL_CURRENT] 支持作为账号维度；具体后台查询权限 UNKNOWN |
| 群 ID/tid/team_id | 群历史查询、群成员、群消息 API 均使用群 ID | [OFFICIAL_CURRENT] 支持作为群维度 |
| 消息 ID | 发送响应含服务端消息 ID；历史查询支持消息锚点 | [OFFICIAL_CURRENT] 支持引用单条消息；是否能直接导出单条证据 UNKNOWN |
| 时间范围 | 历史接口支持 beginTime/endTime 或等价参数 | [OFFICIAL_CURRENT] 支持分页时间查询 |
| 关键字 | 全文云端检索能力存在，但需开通 | [OFFICIAL_CURRENT] 支持条件成立；当前开通状态 UNKNOWN |
| 附件 | NOS/消息附件有独立存储和下载能力 | [OFFICIAL_CURRENT] 依赖 URL、期限和权限；证据包能否自动打包 UNKNOWN |

### 10.3 撤回、删除、解散对取证的影响

- [OFFICIAL_CURRENT] 云信支持消息撤回/删除，公开 V2.1 文档可配置撤回时长；Web API 还公开清除会话云端历史与漫游记录的接口。证据：[撤回/删除消息](https://doc.commsease.com/messaging2/server-apis/jAwNTEzODQ?platform=server)、[MessageLogInterface](https://doc.commsease.com/messaging/api-refer/web/typedoc/Latest/zh/NIM/interfaces/nim_MessageLogInterface.MessageLogInterface.html)。
- [OFFICIAL_CURRENT] 公开文档说明，消息撤回后部分离线、漫游和历史可用性会受到影响；因此撤回后的消息不应默认视为可恢复的审计证据。证据：[消息撤回](https://doc.commsease.com/messaging/guide/Tg0ODcxOTk?platform=web)。
- [UNKNOWN] 群解散后在当前套餐、当前 SDK/API 和控制台中的历史消息保留、检索和导出行为，本次没有获得明确的官方承诺。
- [RECOMMENDATION] 在任何可能引发争议的订单关闭前，先写入平台结构化证据和必要的受权证据引用；不要把“未来再从群里找”作为唯一计划。

### 10.4 是否适合作为唯一证据源

结论：**不建议把云信留存或控制台作为订单纠纷和内部审计的唯一证据源。**

理由：

- [OFFICIAL_CURRENT] 留存年限、漫游和全文检索受套餐/控制台配置影响；
- [OFFICIAL_CURRENT] 消息可以撤回、删除或清空历史；
- [UNKNOWN] 当前控制台的查询、导出和操作审计能力尚未确认；
- [CODE_CONFIRMED] 旧平台没有保存云信请求结果、成员事件、消息 ID 或订单证据引用；
- [OWNER_CONFIRMED] 群消息不等于人工交付，平台必须区分支付、业务状态、人工结果和第三方结果。

## 11. Q80 推荐与成立条件

### 11.1 推荐方案：结构化事件 + 证据引用，默认不全量同步正文

首期至少保存：

- 订单 ID、出租账号 ID、平台用户 ID、云信 accid；
- 订单群的 team_id/tid、创建时间、成员加入/移除时间和角色；
- 客服分配、转交、离线接入和人工确认记录；
- 云信操作类型、业务幂等键、RequestId、请求时间、结果码、耗时、重试次数和最终状态；
- 交付清单版本、客服确认时间、账号收回/退出/撤销授权等收尾结果；
- 关键消息的服务端消息 ID或客户端消息 ID、会话 ID、发送人、时间、消息类型和证据引用；
- 争议证据包的操作者、理由、范围、导出时间、哈希和访问审计。

上述结构化记录不保存消息正文即可覆盖“谁在什么时候被分配、何时进入群、平台发起了什么操作、云信返回什么结果、客服何时人工确认”等核心审计事实。

### 11.2 “完全不保存聊天正文”成立的必要条件

必须同时满足：

1. 云信当前套餐和合同明确承诺所需历史年限、附件期限、检索条件和可用性；
2. 平台能按订单稳定保存群 ID、成员、消息 ID和关键业务事件；
3. 在争议处理时，受权人员可以在保留期内取得必要正文/附件，并且有权限审计；
4. 云信侧的撤回、删除、清空、解散和封禁行为不会使法务要求的证据无法获取，或平台有独立的证据快照；
5. Owner 和法务接受云信作为外部证据服务的剩余风险；
6. 业务不要求离线全文搜索、自动质检、模型分析或长期合规留存。

当前结论是 [UNKNOWN]，因为第 1、3、4、5 项没有当前合同、控制台和合规方案证据。

### 11.3 “只保存结构化事件和证据引用”

这是本项目的推荐默认方案：

- 订单完成前保存结构化事件；
- 平常不复制全文，不把敏感聊天内容扩大到平台数据库；
- 争议创建后，由有权限的管理员选择最小时间范围和最小消息集合；
- 通过云信检索或受控客服端获取证据，保存加密后的证据快照或可信引用；
- 证据包单独设置保留期、访问审计和脱敏规则；
- 云信查询失败、超期或消息已撤回时，平台应展示“证据不可取得/不完整”，不能伪造完整对话。

### 11.4 “同步全部聊天内容”的代价

仅在明确的法律、风控、质检或运营价值超过风险时考虑：

- 聊天中可能出现密码、验证码、手机号、第三方账号、支付信息和其他个人信息；
- 需要内容加密、密钥管理、字段脱敏、访问分级、删除/更正/导出和跨端权限；
- 需要消息去重、乱序、撤回/编辑、附件下载、断点补偿和抄送积压处理；
- 需要把平台同步结果与云信原始结果区分，不能把同步失败当作消息没有发送；
- 增加泄露面、存储费、索引费、合规责任和数据主体请求成本；
- 旧代码已有自动发送联系信息的风险，全量同步会放大而不是消除该风险。

结论：不把“全量同步”当作默认的安全答案。先做结构化事件与按需证据，再按 Owner 决策扩展。

## 12. 客服工作流优化

### 12.1 资料同步

1. 平台修改用户资料成功后产生同步任务；
2. 更新云信全局资料；
3. 读取平台的活跃订单群成员关系；
4. 根据产品选择更新群成员 nick，或由管理端展示真实昵称、角色徽标；
5. 任务结果可查询、可重试、可人工关闭；
6. 每日/每小时对账发现漂移。

### 12.2 订单群创建与成员加入

1. 支付回调只确认本地支付事实；
2. 订单状态进入“待云信接入”，不直接显示为“已交付”；
3. 创建独立订单群，保存 order_id ↔ team_id；
4. 加入号主、买家和当前客服；
5. 添加管理员或受控运营角色；
6. 每一步记录成员期望状态与实际结果；
7. 任一步失败进入重试/异常任务，付款状态不变。

### 12.3 客服分配、转交和离线处理

- [RECOMMENDATION] 平台根据角色、在岗状态、当前负载、最近接单时间和订单优先级选择客服；云信在线状态只作为辅助信号，不作为唯一分配真值。
- [RECOMMENDATION] 分配成功要同时记录平台客服归属和云信成员/管理员结果；不能因客服进入群就自动把订单标为已接入。
- [RECOMMENDATION] 客服转交采用“新客服加入并确认 → 旧客服移除或降权 → 平台记录转交原因和时间”的顺序。
- [RECOMMENDATION] 无在线客服时，订单进入“等待客服接入”，可发送不含敏感信息的状态通知，并建立人工待办；不把群消息当作实际交付。

### 12.4 交付清单

- 上号方式、操作步骤、提示文案和安全检查全部由管理平台配置；
- 客服在订单中逐项确认人工动作和第三方结果；
- 云信消息只用于通知和沟通，不作为“已登录”“已退出”“授权已撤销”等事实；
- 账号密码、验证码和完整手机号不能写入普通订单、日志、自动消息或证据正文。

### 12.5 结账、账号收回和群关闭

1. 客服或买家发起结账只改变订单业务状态，不直接改变支付事实；
2. 客服按配置清单完成退出登录、撤销授权、移除设备或修改密码等收尾；
3. 平台记录人工确认、失败原因和需要补救的第三方结果；
4. 进入保留期，保存结构化证据；
5. 订单群按独立群策略移除成员/解散；操作失败进入异常，不把本地关闭字段直接当成云信已解散；
6. 对历史订单保留 legacy_team_id 和旧成员风险标记。

### 12.6 管理平台应展示的云信信息

每个订单至少展示：

- 云信账号映射状态：未创建、已创建、更新中、成功、失败、禁用、未知；
- 订单群：待创建、创建中、已创建、成员不齐、已关闭、关闭失败；
- team_id/tid、创建时间、最后对账时间；
- 期望成员与实际成员差异；
- 当前客服、历史客服、最后转交时间；
- 最近云信操作、RequestId、结果码、重试次数、下次重试时间；
- 可执行人工入口：重试、重新查询、补加成员、移除成员、刷新昵称、关闭异常；
- 不展示 token、AppSecret、密码、验证码和未经授权的聊天正文。

## 13. 失败重试、异常中心与可观测性

### 13.1 幂等和重试规则

- [OFFICIAL_CURRENT] 云信 API 调用方式文档说明：同一 AppKey、同一接口、60 秒内使用相同 RequestId 的请求会被服务端视为重复请求并返回先前成功结果；失败状态不缓存。证据：[API 调用方式](https://doc.commsease.com/messaging/server-apis/jk3MzY2MTI?platform=server)，更新时间 2025-11-13。
- [OFFICIAL_CURRENT] 416 表示频率超限，449 表示请求需要重试，408/415/500/503 等表示超时、网络或服务端异常；具体接口还可能返回权限、账号禁用、群不存在和重复操作等错误。证据：[状态码/错误码](https://doc.commsease.com/messaging/server-apis/TM5NTk2Mzc?platform=server)。
- [RECOMMENDATION] 每个本地操作使用业务幂等键，例如“订单 + 操作类型 + 版本”；调用云信时保留同一个 RequestId。对创建群超时先查询/对账，再决定是否新建，避免仅因本地超时而产生第二个群。
- [RECOMMENDATION] 只对幂等资料更新、查询、成员状态修复和带同一 RequestId 的未知结果重试；对建群、发送人工通知等操作先确认云信是否已经成功。
- [RECOMMENDATION] 416 使用退避和并发降低；权限、账号禁用、对象不存在、参数错误进入人工处理，不做无意义重试。

### 13.2 异常任务状态

建议最小状态：

PENDING → RUNNING → SUCCEEDED
PENDING → RUNNING → RETRYABLE → PENDING
PENDING/RUNNING → UNKNOWN → RECONCILE
任意状态 → FAILED_MANUAL

每条异常任务保存：

- 业务对象和操作类型；
- 期望状态、最后已知状态；
- RequestId 和本地幂等键；
- 云信结果码、分类后的错误类型和耗时；
- 重试次数、下次重试时间、人工操作人和原因；
- 不保存响应中的敏感正文、token 或完整个人信息。

### 13.3 回调与抄送

- [OFFICIAL_CURRENT] 第三方回调和消息抄送均需在控制台开通；公开回调说明指出，服务端 API 发送的消息不会触发第三方回调。证据：[回调说明](https://doc.commsease.com/messaging2/server-apis/jI3ODc2ODE?platform=server)。
- [OFFICIAL_CURRENT] 消息抄送要求接收端在 5 秒内响应；网络波动可能导致重复投递，需要去重；公开文档说明普通缓存和高保障重试能力存在不同条件。证据：[消息抄送服务概述](https://doc.commsease.com/messaging2/server-apis/jQ4ODE0NTY?platform=server)。
- [RECOMMENDATION] 平台不要依赖第三方回调来证明所有由平台服务端发送的系统消息；对 API 消息，在本地事件表记录发送请求和结果；若启用抄送，在接收端按消息 ID/客户端 ID/时间和会话组合去重。

### 13.4 指标

建议只记录指标和结构化状态，不记录消息全文：

- 建群成功率、超时率、重复群率；
- 入群/移除/昵称更新成功率；
- 云信未知状态任务数量和最老待处理时长；
- 416、449、403、422、500、503 等错误数量；
- 资料漂移数量、对账修复成功率；
- 客服从付款到接入、从接入到人工交付确认的时长；
- 订单关闭后未收尾、群未关闭、成员残留数量；
- 证据引用失效数量。

## 14. 安全、隐私与合规风险

### 14.1 旧代码风险

- [CODE_CONFIRMED][P0] YunxinUtil.java 中存在凭据承载常量，账号创建流程输出 token；值已刻意不写入本报告。新平台不得复制该模式，并应在任何部署前完成凭据轮换、服务端密钥管理和日志清理。
- [CODE_CONFIRMED][P0] 旧支付回调自动把手机号拼到群消息和配置消息中；与冻结决策冲突。新平台必须改为平台内受权查看、脱敏提示或一次性安全通道，不能以云信群消息传递完整手机号。
- [CODE_CONFIRMED][P1] 旧代码大量只打印“云信异常”，没有结构化结果、重试或人工异常任务；这会把第三方失败误判为本地流程继续成功。
- [OFFICIAL_CURRENT][P1] 云信账号创建后只能封禁不能删除；平台注销、合并和数据主体请求必须设计本地映射、冻结、撤销访问和保留策略。证据：[封禁账号](https://doc.commsease.com/messaging2/server-apis/TIxMzI4MjE?platform=server)。

### 14.2 新平台控制原则

- 服务端保存 AppKey/Secret 和服务端调用权限；客户端只拿到完成 IM 登录所需的短期或受控 token；
- 云信与平台均执行对象归属和操作权限检查，隐藏按钮不能代替鉴权；
- 客服只能处理分配给自己的订单或经授权转交的订单；
- 证据正文按争议范围最小化、加密、分级和审计；
- 任何密码、验证码、完整手机号、第三方登录材料不进入普通业务表、日志、自动消息和默认抄送；
- 对云信账号封禁、群解散、消息删除等不可逆或高风险操作使用二次确认和人工审计；
- 消息、回调、附件和证据下载全部做去重、超时、权限和过期处理。

## 15. Web-first 及 iOS/Android/微信小程序扩展影响

- [OWNER_CONFIRMED] 新平台采用 Web-first，同时必须保持 iOS、Android 和微信小程序可扩展；因此 IM 业务不能依赖 Web DOM、Cookie 或 Server Actions。
- [OFFICIAL_CURRENT] 云信当前用户资料文档列出 Android、iOS、macOS/Windows、Web/uni-app/小程序、Node.js/Electron、鸿蒙和 Flutter 等平台；消息文档也覆盖客户端和服务端。证据：[用户资料](https://doc.commsease.com/messaging2/guide/zYwMzU1NTI?platform=client)、[收发消息](https://doc.commsease.com/messaging2/guide/DYzMjA0Njc?platform=client)。
- [RECOMMENDATION] 新平台 API/BFF 只暴露稳定的业务语义：平台身份、订单、客服分配、群状态、成员角色、消息证据引用和错误状态；各端自行适配登录、缓存、展示和上传。
- [RECOMMENDATION] BFF 不直连交易库、不重复业务规则；支付状态、人工履约、云信状态和异常任务由 API 统一维护。
- [RECOMMENDATION] Web、原生和小程序都不得持有服务端签名密钥；服务端完成账号创建、资料更新、群管理和审计；客户端只接收平台允许展示的字段。
- [UNKNOWN] 新项目当前没有发现已落地的云信业务集成代码；旧管理端构建产物有 NIM Web SDK/IM Kit 线索，但不能证明该构建产物就是当前线上客服软件或当前部署版本。

## 16. P0/P1/P2 实施建议

### P0：上线前必须解决

1. [OWNER_DECISION_REQUIRED] 决定 Q79：默认每单独立群，或接受账号长期群的风险与隔离约束。
2. [RECOMMENDATION] 书面确认当前云信应用的套餐、群数量/频控、历史年限、全文检索、消息抄送、安全通/易盾、附件保留和 SLA。
3. [RECOMMENDATION] 建立 payment、order/fulfillment、yunxin、exception 四类独立状态和 order ↔ team 唯一关系。
4. [RECOMMENDATION] 移除完整手机号等敏感内容的自动消息设计；禁止密码、验证码进入 IM 自动消息。
5. [RECOMMENDATION] 处置旧源码中的凭据暴露和 token 日志风险；轮换与清理不在本次只读报告范围内，但不得带入新平台。
6. [OWNER_DECISION_REQUIRED] 决定 Q80 默认采用结构化事件 + 证据引用，还是因法务/质检需求增加正文同步。

### P1：第一期运营闭环

1. 资料同步 outbox、幂等 RequestId、失败重试和异常中心；
2. 每单建群、成员期望状态、客服分配和转交；
3. 交付/结账/账号收回配置化清单及人工确认；
4. 订单群关闭、历史订单 legacy_team_id 兼容和成员残留对账；
5. 云信状态、错误、RequestId、重试和人工入口；
6. 结构化事件表、消息 ID/证据引用和争议证据最小化提取；
7. 非生产环境的四层名称显示验收：全局 name、群 nick、好友 alias、客户端缓存。

### P2：有明确价值后再做

1. 开通并评估云端全文检索、消息抄送或高保障抄送；
2. 争议证据包的加密归档、哈希、下载审计和法律保全；
3. 客服质检、关键词统计和跨端运营分析；
4. iOS/Android/微信小程序的统一 IM 状态组件和离线补偿；
5. 只有在保留义务和授权明确时，才评估全量聊天正文同步。

## 17. 需要向网易云信商务或技术支持确认的问题

### 套餐、留存和导出

1. 当前应用实际购买的 IM 版本、群功能、历史消息年限、漫游、全文检索、消息抄送、高保障抄送、群已读、安全通/易盾和 NOS 附件策略分别是什么？
2. 高级群在当前合同中的默认/最大成员数、每用户群数、每秒建群与群管理频控是多少？是否按应用、账号、数据中心分别计算？
3. 云端历史是否覆盖单聊和高级群？是否支持按 accid、team_id/tid、服务端消息 ID、客户端消息 ID和时间范围查询？
4. 当前控制台是否能检索和导出单聊/群聊记录？导出是否包括正文、附件、撤回/删除标记、成员事件和服务端消息 ID？操作是否有不可删除的审计日志？
5. 群解散、消息撤回、消息删除、历史清空、账号封禁后，历史消息和附件分别还能否查询、导出和恢复？是否支持法律保全/冻结？

### 名称、权限和客户端一致性

6. 当前 Web 客服软件/IM Kit 在群成员列表、会话标题、联系人、消息气泡和搜索结果中，分别以全局 name、群 member nick、好友 alias 还是 accid 为优先？
7. 服务端 updateUinfo 成功后，Web/PC/原生/小程序的资料事件、缓存刷新和可见延迟有无 SLA？是否必须主动 fetch、重新登录或清本地缓存？
8. 群主、管理员和普通成员在当前群配置下分别能否修改他人的群昵称、自己的群昵称？如何禁止买家覆盖运营设定？
9. 多个活跃群中同时更新一个用户资料，是否有批量接口、推荐频率和最终一致性说明？

### 可靠性、鉴权和迁移

10. RequestId 去重的适用接口、缓存时间和创建群超时后的推荐对账流程是什么？超过 60 秒再次重试如何避免重复建群？
11. 各 API 的 416、417、431、449、500、503 是否有接口级推荐重试表？官方 Java Server SDK 的主备域名、版本支持和维护周期是什么？
12. 第三方回调和消息抄送的真实重试、补发、顺序、去重和审计保证分别是什么？API 发消息不触发回调时，推荐用哪种事件同步方式？
13. 云信账号能否仅封禁、踢下线和清理推送，不能删除的约束是否适用于当前 V10 服务？平台合并/注销时建议如何处理映射？
14. Web、iOS、Android、微信小程序当前推荐 SDK 版本和客服 IM Kit 版本是否一致？昵称/群成员事件在各端的差异是什么？
15. 当前合同中是否有可承诺的可用性、数据恢复、跨地域主备、服务中断通知和客服响应 SLA？

## 18. UNKNOWN、OWNER_DECISION_REQUIRED 与 NOT_RUN

### 18.1 UNKNOWN

- 旧平台反编译代码是否等于当时全部线上代码；
- 旧云信应用当前是否仍使用这些 AppKey、套餐和构建产物；
- 客服软件当前版本在不同页面使用的名称字段及优先级；
- 当前云信应用实际开通的群额度、历史年限、全文检索、消息抄送、安全通/易盾和附件期限；
- 当前控制台是否支持按订单相关维度查询/导出聊天记录和操作审计；
- 群解散、消息撤回、历史清空后，当前套餐是否仍可恢复相关证据；
- 多端客户端的缓存刷新延迟和事件完整性；
- 未在旧调用方中发现但可能存在于外部运营台账的人工补偿；
- 订单并发量、每天建群峰值、实际账号复用率和历史成员残留数量。

### 18.2 OWNER_DECISION_REQUIRED

- Q79 选择每单独立群、账号长期复用群或混合隔离；
- Q80 是否接受云信留存 + 结构化事件 + 按需证据，还是因法务/质检同步正文；
- 是否把真实昵称放入群成员 nick，还是坚持角色 nick + 平台真实昵称；
- 聊天记录和证据包的业务保留期、访问角色与争议触发规则；
- 旧账号级群在迁移期间的人工处置和新旧流程切换日期。

### 18.3 NOT_RUN

- 未登录网易云信控制台；
- 未调用真实云信账号创建、资料更新、建群、拉人、踢人、发消息、历史查询或管理 API；
- 未使用真实 AppKey/AppSecret、token、手机号、聊天内容或真实用户/客服；
- 未运行会连接线上服务的 SDK 示例；
- 未做真实浏览器客服软件名称显示验收；
- 未证明任何旧代码路径已经部署、启用或成功调用；
- 未修改业务代码、配置、FigJam、既有文档；
- 未 commit、merge、push、reset、stash 或 clean。

## 19. 自检结果和工作区改动说明

### 19.1 自检

- [CODE_CONFIRMED] 已先用 rg 建立云信调用方索引，再追踪 PayServiceImpl、LoginServiceImpl、UserServiceImpl、OrderServiceImpl、OrderManageServiceImpl、SystemAuthAdminServiceImpl、DismissTeamJob 和 YunxinUtil 的调用链。
- [OFFICIAL_CURRENT] 官方能力只引用网易云信开发者中心页面；搜索摘要、第三方博客和论坛没有作为最终能力证明。
- [RECOMMENDATION] 方案表明确比较了历史泄露、成员残留、客服交接、额度、失败补偿、映射、迁移、运营成本和举证。
- [RECOMMENDATION] 昵称章节分别覆盖全局昵称、群成员昵称、好友备注和客户端缓存，并明确未发现统一展示优先级。
- [RECOMMENDATION] Q80 明确区分云端保存/查询、控制台能力、服务端 API、客户端本地导出和平台侧证据。
- [RECOMMENDATION] 报告没有写入任何真实凭据、token、手机号、聊天内容或配置值；旧代码中的敏感风险只以类型和行号描述。

### 19.2 工作区改动

本轮唯一允许写入并实际新增的文件是：

- E:/zzsh/zzsh/docs/research/yunxin-integration-workflow-research.md

初始工作区已有的 .gitignore、AGENTS.md、Serena 文件删除、docs/serena.md 修改及 docs/research/ 既有内容均未修改、未清理、未提交。报告不改变任何旧平台证据。

## 附录：关键旧代码复查索引

| 主题 | 文件与行号 |
|---|---|
| 云信工具：建群、邀请、踢人、群昵称、解散 | E:/zzsh/analysis/front/source/com/mdd/common/util/YunxinUtil.java:44-145 |
| 云信工具：创建账号、发消息、好友、全局资料 | E:/zzsh/analysis/front/source/com/mdd/common/util/YunxinUtil.java:147-270 |
| 普通用户注册/微信登录与 IM 字段保存 | E:/zzsh/analysis/front/source/com/mdd/front/service/impl/LoginServiceImpl.java:62-140、:287-346 |
| 普通用户平台昵称/头像编辑 | E:/zzsh/analysis/front/source/com/mdd/front/service/impl/UserServiceImpl.java:129-174、:288-299 |
| 管理员/客服创建、在线/离线名称 | E:/zzsh/analysis/admin/source/com/mdd/admin/service/impl/SystemAuthAdminServiceImpl.java:163-191、:231-282、:311-337 |
| 账号保证金回调建群 | E:/zzsh/analysis/front/source/com/mdd/front/service/impl/PayServiceImpl.java:605-672 |
| 买家支付回调入已有群 | E:/zzsh/analysis/front/source/com/mdd/front/service/impl/PayServiceImpl.java:528-603 |
| 辅助任务建群 | E:/zzsh/analysis/front/source/com/mdd/front/service/impl/PayServiceImpl.java:691-765 |
| 结账/取消/群消息 | E:/zzsh/analysis/front/source/com/mdd/front/service/impl/OrderServiceImpl.java:624-882、E:/zzsh/analysis/admin/source/com/mdd/admin/service/impl/OrderManageServiceImpl.java:694-713 |
| 定时解散 | E:/zzsh/analysis/admin/source/com/mdd/admin/crontab/DismissTeamJob.java:28-53 |
| 订单、账号和群字段 | E:/zzsh/analysis/front/source/com/mdd/common/entity/Order.java:26-124、E:/zzsh/analysis/front/source/com/mdd/common/entity/RentalAccounts.java:21-91 |
