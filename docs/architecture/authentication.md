# 认证与账号安全

用户和管理员使用独立 Better Auth realm、schema、secret 及 Cookie 前缀。Admin BFF 位于 API 同进程，Web BFF 位于 Next.js；BFF 响应不暴露原始会话 token。Cookie 写请求校验 Origin，直接 API 与 BFF 复用管理员门禁。

- 两个同级 Boss，无第三个默认 root。新管理员登录名由 sequence 分配 ZZ 编号，允许跳号，不复用；内部关系 ID 和可编辑显示名称独立。
- 首次临时密码登录后必须修改密码，再完成 TOTP 绑定与激活。同密码被拒绝，改密强制撤销旧会话。旧兼容账号未批量重编号。
- 普通管理员由获授权账号创建，使用一次性临时密码；创建入口不能创建、删除、降级或替换 Boss。离职使用冻结，不提供常规物理删除。
- 有效操作权限为有效角色权限并集，加个人允许，减个人明确禁止；禁止优先。角色配置修改对关联账号立即生效。Boss 身份仍由现有受控机制维护，并拥有全部已登记操作权限。
- 创建账号、配置角色、授予权限、冻结/解冻分别校验权限；不能通过创建账号或编辑角色授予超出自身可委派范围的权限。对象范围与敏感字段另行校验，未确认的客服数据范围不默认为全量。
- 管理员（含 Boss）会话固定7天，用户会话固定30天；没有管理员会话时长配置入口或配置表。关闭自动刷新，且 PIN 锁屏只改变服务端锁态、不延长绝对到期时间。管理员冻结即时撤销会话；Boss 可独立强制撤销其他管理员的全部设备会话和未完成登录挑战，目标账号状态不变，后续登录仍需密码与2FA。
- 备份码可替代 TOTP，每码单用，重生成使旧码失效。绑定二维码在本地渲染。
- 普通恢复由目标本人持有恢复凭据，Boss只确认申请；恢复撤销旧凭据及会话。服务器灾备 CLI 当前仅允许隔离 test/fake，不能视为生产恢复工具已验收。
- 关键安全写入与审计同事务；通知 outbox 支持重试、租约与过期写回拒绝，外部投递为至少一次。

管理员目录、预设角色和个人允许/禁止已实现；页面隐藏不能替代服务端拒绝。当前管理员个人工作台布局由会话归属保存，跨设备读取同一配置，旧版本保存冲突，不形成配置中心。持有 `user.account.restore` 动态操作权限的管理员可将用户账号从 `DEACTIVATED` 恢复为 `ACTIVE`；该权限沿用既有角色、个人允许/禁止和委派目录，个人 `DENY` 优先，不固定绑定 Boss。恢复不会恢复旧会话/验证凭据，不可恢复 `CANCELLED`，也不覆盖既有实名/年龄结果。当前仅实现已冻结的最小审批 slice，审批同意与执行结果分离；不把它扩展为通用工作流平台或将待审批动作自动放行。限流为有界单进程实现，多实例/生产反向代理和通知渠道须另验。

## 用户认证规则（Owner已确认）

- 用户主体是稳定、唯一的 `userId`；昵称可修改且不唯一，不参与登录或账户归并。手机号、邮箱及后续微信均关联同一主体，绑定或更换认证方式不改变订单、余额、会员等归属。用户端取消用户名注册/登录及账号名逻辑；历史用户名只作来源追溯，管理员的 ZZ 登录名与 TOTP 不变。
- 新用户必须通过手机号验证码验证并同意协议，随后直接注册并登录，不强制设置密码。密码为可选的便捷登录方式，设置后使用手机号＋密码；不开放邮箱独立注册或用户名＋密码登录，不为无密码账户补造随机密码。
- 可选绑定并验证邮箱，用于找回密码和后续资讯。已有已验证手机号和邮箱时，用户可任选一种独立重置密码；未验证邮箱或内部占位邮箱不得用于恢复。安全邮件与资讯订阅用途分开，资讯订阅默认值及投递规则另定。邮箱绑定不等于开放邮箱＋密码登录。
- 手机号换绑支持“旧手机号验证码＋新手机号验证码”或“已绑定验证邮箱验证码＋新手机号验证码”。新号码已被另一账户占用时拒绝，不静默合并；原号码不可再登录本账户，`userId` 和业务关联不变。两种旧渠道都不可用时进入独立人工恢复流程，其核验合同另定，不能由客服直接绕过归属确认。
- 后续支持微信扫码：复用外部 provider 与用户主体的绑定模型，保持手机号注册前提；微信未打通前不开放扫码入口。不同应用下的外部标识映射、绑定/解绑、冲突与迁移须在接入时专门验收，不凭昵称或相同邮箱自动合并用户。
- 允许多设备同时登录。账号安全页提供当前会话及其他有效会话、客户端/系统/浏览器、登录与到期时间等可核实信息，并支持退出指定会话、其他设备或全部设备。原始 token 不返回页面；会话有效不代表设备正在在线，地区信息无可靠依据则显示未知，地图不是首期认证前置。
- 在已登录且完成再次身份验证后修改密码、换绑手机号或变更找回邮箱，成功时撤销其他旧会话并换发当前会话。未登录状态下找回密码则撤销全部旧会话，再重新登录。普通登录不触发互踢，安全操作的会话撤销由服务端执行，不能只清前端缓存。
- 旧密码首次成功验证后透明升级，不强制用户更换；升级前后同一密码字符串都须可登录。已有凭据校验不套用新设置密码的长度/字符政策，不自行截断、补字符或修改输入来冒充兼容。新设置及重置密码至少12位，前后端规则必须一致；管理员密码政策不因本次用户规则变更而放宽。

当前已有 `user`、`account`、`session` 和 `verification` 结构；外部凭据按 `(providerId, accountId)` 唯一并归属 `userId`。优先复用，不另建平行用户系统。手机号和邮箱目前存放在用户表，邮箱非空约束下的内部占位地址不是用户真实绑定邮箱。用户与管理员共用schema定义生成器但分realm/schema，移除用户用户名功能不能误删管理员认证依赖。

## 用户认证当前实现

用户身份状态由服务端返回账号状态、实名状态、年龄状态、provider 和受保护操作资格；资格结果不代表交易已执行。实名校验只接受服务端规定的身份字段，客户端不能提交 scenario、年龄或验证结果来选择成年人结果。未接入真实 provider 时，默认 fake 结果为 `UNKNOWN`，用户端只显示暂不可用说明，不采集真实证件或提供生产 mock 入口。注销在服务端事务内检查未完成事项，`PENDING` 与无法确认分别返回可理解的冲突/服务不可用反馈；管理员离开仍走冻结。

用户端仅开放手机号验证码注册/登录及手机号密码登录。Web经同源`/api/auth/user` BFF；`sign-in/identifier`仅接受手机号和kind=phone，username/email注册或登录及SDK通用手机换绑/重置路径在直接API和BFF均关闭。注册须验证5分钟内验证码并同意协议，无密码用户不创建credential；已迁移号码进入原userId，未解决的来源手机号冲突拒绝自动新建。发送冷却60秒，最多3次错误；用途、目标和主体分别绑定。昵称仅更新name，新输入1–64 Unicode码点、可重复；旧昵称不截断。

手机号密码登录保留输入字符串，新设置/恢复规则12–128位不套用登录。标准限流与正文校验先于凭据读取。已识别旧注册/改密算法为`md5(password+salt)`（legacy-md5-v1），v0仅按既有兼容边界保留，未知版本拒绝校验且不丢弃材料。成功后在同一PG事务内锁定用户与credential、使用Better Auth现有哈希接口升级、清旧列、写审计并创建SDK会话；任一步失败整体回滚。现代哈希沿用当前SDK算法；客户端与业务入口不trim、截断或变换密码。升级后原密码继续有效，冻结/停用/注销账号不能借兼容入口建立会话。

账号安全概况、昵称、再次验证、密码、邮箱、手机和会话接口均在用户realm。`security/challenge/send`与`verify`复用verification保存带版本证明；证明绑定userId、原session、现有安全版本、用途、准确目标、有效期和消费状态。邮箱绑定/更换须先验证现有身份再验证目标；手机换绑按上述两条路径。占位邮箱或未验证邮箱不能恢复，联系方式占用拒绝且不合并账号。恢复发码公开响应不枚举账号或其他渠道。

敏感提交与证明消费、凭据/联系方式、原会话撤销、当前SDK会话换发及审计同事务；换发expiresAt等于原会话expiresAt，不延长30天绝对上限。匿名密码恢复撤销全部会话后要求重新登录。`POST security/operation`只读查询完成回执；completed优先，按相同锁序确认未消费证明过期时才返回expired。未知或写成功后回读失败期间不重复业务POST；仅服务端确认过期未完成后重新验证，或由共享退出流程结束旧身份范围，不宣称原操作失败。明确401使旧私有事实及操作许可失效并重新确认身份。

`GET security/sessions`仅返回本人有效会话opaque ID、当前标识、创建/到期时间及有界UA；不返回token、PIN或精确IP。`POST security/sessions/revoke`、`revoke-others`、`revoke-all`限定本人会话；当前/全部撤销后须确认guest。渠道未配置时发码失败关闭；本地模拟仅受控test/fake，生产拒绝启用。真实短信/邮件投递、微信及人工恢复仍需独立接入验收。

用户会话固定 30 天，Web 只通过 BFF 的 HttpOnly Cookie 持有会话；响应正文不包含原始 token。用户端共享会话模块对 loading、authenticated、guest、error 四态分别呈现，只接受契约的 null 或合法会话；重新确认期间不展示未确认的私人内容，只有确认到不同 userId 才视为身份切换；跨标签事件只触发重新确认，不能代替服务端会话事实。

关键代码位于 apps/api/src/auth/ 与 apps/api/src/bff/。迁移位于 apps/api/migrations/business/；配置及命令见 [开发说明](../development.md)。Admin 的免账号 UI mock 预览已移除，后续使用独立测试账号验收。

用户顶栏、个人快捷面板、发布/我的账号和收藏共享会话来源；业务组件各自隔离对象/请求代次，退出须由服务端确认无会话。日常本地验收复用[测试快速登录](../local-test-auth.md)与既有身份；合成实名结果只是隔离测试事实，不替代历史账号的真实资格核对，不为登录失败重建账号或重置密码。

## 旧用户迁移与首次登录

Owner确认的迁移要求（2026-09-30收敛，以下为上线迁移合同，本地有界验证不等于全量上线迁移）：

- 全量旧注册用户纳入迁移，不限于出租号主或当前抽样账号。保留旧用户ID到新用户ID的稳定映射及账号、订单、资金、会员等关联；手机号用于登录定位，不能代替源用户ID或作为静默合并多个旧用户的依据。
- 正常状态的旧用户可用原手机号收验证码登录，并进入其迁移后的原账户，不要求重新注册，也不能创建一个无历史关系的新账户。旧有冻结、停用、注销等状态按来源与已定规则保留，不自动解除。
- 对旧平台已设置密码且有完整、可识别凭据的用户，支持手机号＋原密码登录原账户；首次成功验证后事务内升级新哈希、清除目标库旧认证哈希并记录审计，不要求用户更换密码。升级成功后同一密码按新校验方式继续使用；输错、限流、网络失败或事务回滚不能消耗一次性登录资格。算法未知或依据不完整时不猜测、不盲试其他账户。
- 验证码登录同样可进入原账户，不强制当场设置或更换密码。旧用户未设置密码的情况保持明确状态，继续验证码登录，后续自愿设置；不补默认密码或随机密码。新设置/重置至少12位，但旧密码与透明升级后的存量密码不能因此被拦截。兼容逻辑是否退役须先核剩余未升级账户及其恢复路径，不能因多数用户已升级就直接删除。
- 复用现有验证码用途隔离、限流、过期、尝试次数、单次消费、会话与密码重置能力。必须单独验收真实短信发送；本地固定码/outbox或随机密码登录不代表旧用户真实登录链路通过。
- 全量验收核对源记录总数、成功映射数、明确隔离待处理数及关系一致性。缺手机号、重复手机号、与目标已有账户冲突不得丢弃记录或自动串号，须有可恢复的冲突处理清单与处理依据。

## 手机号注册与 Web 入口（当前实现）

`POST /api/auth/user/phone-registration/send-otp`接收phoneNumber；`POST /phone-registration/complete`接收phoneNumber、6位code、acceptedTerms=true、可选password与loginOrRegister。OTP有效5分钟、最多3错、发送冷却60秒；成功消费和耗尽仍保留冷却。新号不带password即创建无credential用户、UNVERIFIED/UNKNOWN身份和SDK会话，同事务提交。可选新密码须12–128位，验证码/手机号不授予实名、年龄或交易资格。默认纯注册已有号409；loginOrRegister=true使正确验证码进入原userId且不覆盖原密码。结果返回userId、passwordState和passwordSet（能力未知时null）。会话建立失败全部回滚，响应丢失先确认会话；不能重复注册或消费。

当前服务协议/隐私政策正式正文与版本尚未接入，页面明确说明正文未提供；acceptedTerms仅完成本地流程门禁验证，不代表正式协议确认已验收。上线前须提供真实正文、版本及确认合同。

以下路径均相对`/api/auth/user`，Web同源BFF逐项映射、no-store并过滤用户Cookie；POST校验Origin，DTO拒绝额外字段。敏感提交须当前会话及新鲜用途证明；恢复仅持有已验证恢复证明。发码冷却通过cooldownUntil/Retry-After返回。

| 方法 / path | 输入 → 主要输出 |
|---|---|
| GET /get-session | 无 → null或受权user/session投影 |
| POST /phone-registration/send-otp | phoneNumber → status,cooldownUntil |
| POST /phone-registration/complete | phoneNumber,code,acceptedTerms,password?,loginOrRegister? → status,userId,passwordState,passwordSet |
| POST /sign-in/identifier | identifier,password,kind=phone? → status,userId |
| POST /sign-in/phone-number | phoneNumber,password,rememberMe? → status,userId；固定30天 |
| POST /sign-out | 空 → status；随后确认guest |
| GET /security/overview | 无 → userId,nickname,phoneNumber,email|null,passwordState(set/not-set/unavailable) |
| POST /profile/nickname | nickname → status,nickname |
| POST /security/challenge/send | purpose(password/email/phone/recovery),channel(phone/email),stage(current/target)?,target?,contact?,proofId? → status,challengeId,cooldownUntil,expiresAt |
| POST /security/challenge/verify | challengeId,code → status,proofId |
| POST /security/password | proofId,newPassword → status,operationId,action |
| POST /security/email 或 /security/phone | proofId,targetProofId → status,operationId,action；目标取服务端证明 |
| POST /security/recovery/complete | proofId,newPassword → status,operationId,action；撤销全部会话 |
| POST /security/operation | operationId → status(completed/unconfirmed/expired),result,expiresAt；只读 |
| GET /security/sessions | 无 → sessions[{id,isCurrent,createdAt,expiresAt,userAgent|null}] |
| POST /security/sessions/revoke | sessionId → status,currentRevoked |
| POST /security/sessions/revoke-others 或 /security/sessions/revoke-all | 空 → status,currentRevoked |

已登录发码的current阶段验证现有渠道，target阶段必须给父proofId并验证其绑定目标；恢复使用contact且仅current阶段。邮箱/手机更新不接收客户端额外目标字段。400表示无效/过期证明或输入，401需重新确认身份，403拒绝权限/渠道，409为占用或安全事实冲突，429限流，501渠道未配置。写入已接受与结果未知保持独立，后续读取失败不开放重写；缺失回执或403不能冒充expired。

公开页面无需登录；游客点击发布/个人账号入口打开统一认证层，直接访问受保护URL由独立login页面承接。回跳只接受安全站内路径；确认失败不当作游客，关闭或替换意图后不执行旧回调。登录成功以共享服务端会话确认结果为准。

## 本地短信联验

`AUTH_LOCAL_SMS_MOCK=true` 仅允许 loopback、local-compose 的 dev/test、fake 环境，生产模式拒绝启动。默认关闭。启用后用户注册、手机号验证、找回密码使用固定验证码 `888888`，仍须先申请验证码，并执行原有用途、过期、次数、消费与账号校验；不发送真实短信，不影响管理端 TOTP。固定码无法模拟重发后新旧随机码差异，该场景继续使用随机 outbox 的隔离认证测试。
