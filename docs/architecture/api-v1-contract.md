# API v1 契约基线

API v1 使用以下稳定约定；具体端点以代码生成的 OpenAPI 为准。

## 范围与边界

- 第一个真实业务接口使用 `/api/v1/...`；`/api/health` 继续是独立 liveness 探针，不参与业务版本或 readiness 语义。
- NestJS 业务层只依赖 JSON、HTTP header 和服务端校验，不依赖 Cookie、DOM、Next.js Server Actions 或小程序运行时。
- 订单业务仍未完整实现，尚未创建订单、资金、数据库幂等表或 provider 调用。认证与管理员操作权限已由 Admin 安全/BFF 入口提供，不经过本文件的 probe controller。
- OpenAPI 与运行时校验在 `apps/api/test/api-contract.test.ts` 的隔离 Nest app 中验证；该 probe controller 不在生产 `AppModule` 注册，不能作为生产测试写路由。
- probe 的严格请求 schema 使用显式 ApiBody 声明；DTO 本身不会自动禁止所有未知字段。首个真实业务 controller 必须声明对应约束并验证其实际生成 schema，不得把测试示例通过当成业务文档自动一致。

## 管理安全入口

- 管理端安全写入使用 `/api/v1/admin/security/...`，Web 只经 Admin BFF `/api/bff/admin/...` 转发；BFF 不暴露 bearer token。恢复用户账号要求有效 `user.account.restore` 动态操作权限，服务端只允许 `DEACTIVATED -> ACTIVE`，不恢复旧会话/验证凭据，也不恢复 `CANCELLED`。
- `GET /users/restore-candidates` 只返回搜索命中的用户账号、显示名称和 `DEACTIVATED` 状态；`POST /users/restore` 与关键审计同事务。`POST /admins/force-logout` 仅 Boss 可用，撤销目标管理员全部会话及未完成登录挑战，不改变账号状态，并要求现有密码 + TOTP 再认证。
- 管理员（含 Boss）会话固定 7 天且关闭自动刷新；PIN 锁屏不延长绝对到期时间。审计查询是只读、分页和按授权对象范围过滤的白名单入口，敏感字段由服务端裁剪。
- 当前管理员个人工作台布局经 Admin BFF `GET/PUT /api/bff/admin/workspace/layout` 读写，归属由会话决定，不接受客户端指定其他管理员。配置只含并发版本、组件 ID、12 列网格坐标 x/y 与宽高 w/h（`layoutVersion: 2`）和白名单时间选项；坐标/尺寸按组件目录的最小尺寸与网格边界校验。历史 `order + sm/md/lg` 配置（`layoutVersion: 1` 或无格式版本）在读写两侧按确定规则转换，并发版本语义不变；旧版本保存返回 `CONFLICT`。锁定会话拒绝读写。这不是通用配置中心。

## JSON 类型

### ID

ID 以 opaque 字符串传输，允许 `A-Za-z0-9` 开头，后续使用 `A-Za-z0-9._:-`，最长 128 个字符。客户端和服务端都不得把 ID 当数字解释；例如 `1e3` 可以作为字符串 ID 通过校验，但不是指数数值。空白、超长值或任意对象均拒绝。

### 金额

当前契约示例固定使用：

```json
{
  "currency": "CNY",
  "unit": "yuan",
  "amount": "123.45",
  "scale": 2
}
```

`amount` 是不使用浮点的十进制字符串，必须有两位小数；`currency`、`unit` 和 `scale` 一起明确币种、单位和精度。服务端业务接入其他币种前必须为该币种另定单位与精度，不能只放宽正则。

### 时间

当前支持的 RFC 3339 子集为 `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)`，年份为 0001–9999，fraction 最多 9 位；日期按真实月长和闰年校验，时分秒分别限制为 00–23、00–59、00–59，offset 小时/分钟限制为 00–23/00–59。没有时区的本地时间、`2026-02-30` 这类不存在日期和任意数字时间戳均拒绝。

### 分页

请求使用可选 `cursor` 和 `limit`；`limit` 范围为 1–100，默认 20。响应返回 `items`、`nextCursor` 和实际 `limit`。真实业务接入时必须定义稳定排序及 cursor 的失效/过期语义；不能用页码漂移替代稳定 cursor。

## 错误与 requestId

错误统一为：未知字段不会原样进入 `details.path`；顶层、金额对象和分页对象分别只返回固定的 `body`、`amount`、`page` 路径，最多返回 8 条安全问题。

错误统一为：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Request validation failed",
    "requestId": "req_contract_001",
    "details": [
      { "path": "amount.amount", "code": "INVALID_FIELD" }
    ]
  }
}
```

机器流程只匹配稳定 `code`，不匹配中文或其他展示文案。`X-Request-Id` 可由调用方提供，但必须符合安全 token 格式；缺失或非法时由服务端生成新的 `req_...` 值，并在响应 header 与错误 body 中保持一致。未知异常只返回 `INTERNAL_ERROR` 和 requestId，不返回堆栈、原始异常、凭据或原始输入。

当前保留的错误码包括 `INVALID_ARGUMENT`、`MISSING_IDEMPOTENCY_KEY`、`IDEMPOTENCY_KEY_REUSED`、`UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`、`RATE_LIMITED` 和 `INTERNAL_ERROR`。401/403/404/409/429 使用各自稳定码和固定安全文案，不映射为 `INVALID_ARGUMENT`。业务模块可以增加稳定码，但不能复用已有码表达不同语义。

## 幂等键

有副作用的业务请求必须带 `Idempotency-Key`。服务端按“已验证主体 + operation + resourceId（如有）”形成作用域，客户端不能通过 `userId` 或任意 `X-User-*` header 冒充主体。供给模块已将幂等记录、业务与审计同事务持久化；作用域含 realm，同 key 先串行化，再核当前权限及对象范围，包含缓存命中与唯一键竞争回读：

| 条件 | 契约结果 |
|---|---|
| 作用域或 key 不存在历史记录 | 执行一次，记为 `new` |
| 同一作用域、同一 key、请求 fingerprint 相同 | 返回原结果，记为 `replay` |
| 同一作用域、同一 key、fingerprint 不同 | 拒绝并返回 HTTP 409 / `IDEMPOTENCY_KEY_REUSED` |
| 不同作用域使用同一 key | 视为另一请求，不能互相重放 |

供给 fingerprint 由服务端对 operation、resourceId 和请求 JSON 计算；同 key 的字段表示须一致，内容摘要另按语义规范化。支付、退款等业务接入时仍须将该契约与事务、持久化记录、超时和回调事实联合设计。

## 供给基础（M3-B）

- 管理端入口 `/api/v1/admin/supply/...` 经 Admin BFF `/api/bff/admin/supply/...` 转发；用户材料入口 `/api/v1/supply/...` 使用用户 realm。写操作要求 `Idempotency-Key`，重放返回原结果，异体同 key 返回 409。管理权限：`supply.catalog.manage`、`supply.rules.edit`、`supply.rules.activate`（仅 Boss）、`supply.review.read`、`supply.review.decide`、`supply.quote.internal.read`；除 Boss 外必须存在 `admin_supply_scope` 游戏范围。
- 目录：`GET /api/v1/supply/games/{gameId}/catalog` 为公共白名单并绑定 `catalogRevision` 游标；管理端目录、游戏、物品/分类/皮肤/稀有度/权益维护均在管理端前缀下。稳定 code 创建后不可改名，词条只停用不物理删除；旧来源字段以受限原文保留，未知值不默认成有效词条。计费物品（items）更新接受 `mediaId` 绑定经审核公开的 ITEM_MEDIA 资产，`mediaId: null` 解绑，撤销公开同事务清除绑定；公开目录 items 仅在资产 APPROVED+PUBLIC_DISPLAY 时投影 `mediaId`，与皮肤 mediaId 投影规则一致。
- 素材选项：`GET /supply/games/{gameId}/media-options?purpose=ITEM_MEDIA&limit=&cursor=`（管理 BFF `/api/bff/admin/supply/...` 同理）返回可绑定候选，服务端只返回同游戏、PLATFORM_CATALOG、对应用途、APPROVED、PUBLIC_DISPLAY 且有公开衍生图的资产（id/mime/width/height/byteSize，不含私有字段与存储键），要求 `supply.catalog.manage` 与游戏 scope，不要求 `supply.review.read`。客户端不能凭素材 id 提升未审核/私有/异游戏素材；无权限时 404。分页沿用 /media/reviews 约定：`limit` 1–100 默认 20，响应 `{items, nextCursor, limit}`，按 `updated_at DESC, id DESC` 稳定排序，cursor 绑定 gameId/purpose/limit，过滤或翻页参数不一致时 409。选择器的预览/绑定图一律走公共衍生图 `GET /api/v1/supply/media/{id}/content`（校验 APPROVED+PUBLIC_DISPLAY+PLATFORM_CATALOG），不触碰私有原图接口；撤销公开后该路径 404。
- 规则：价格/租期/协议可编辑草稿并封存；明细写入锁定 OLD/NEW 父版本，不能将封存明细移入草稿。版本归属不可更换，已引用物品的单位/数量语义须新建词条。release 不可修改。
- 生效：`POST /api/v1/admin/supply/releases` 携带 `expectedGeneration`（十进制字符串，未生效为 `"0"`）；Boss 在 game 锁内执行 CAS，过期确认返回409，同 key 重放不增加release。管理端显示确认代次。
- 计价：`POST /quote-preview` 返回受权管理员内部投影。SPREAD/PERCENT 按精确十进制比例计算，费率范围 `[0,1)`；每行双边金额各舍入一次到分，平台金额为两者差额。HAFF 精确分子/分母随快照保留，展示单位价不能替代精确比例重算。`tenantDepositCents`、`publisherBailRequirementCents` 只接受整数分字符串；缺参为null。日档参与已配置币价条件及租期推算，无每日保底收费。
- 内容摘要：白名单 payload 先规范化再计算 SHA-256；人类文本 NFC/LF，ID/code原样，整数十进制、比例去尾零、单位价8位/元金额2位、业务时间UTC六位微秒（超精度拒绝），可选值null，集合按业务键排序且拒绝重复/未知字段。带声明的预览回显同一 `contentPayload` 与报价，规则JSON和协议正文先规范化再保存；申报版本持久化与接受见下方发布契约。hash不包含自身、审核状态或审计时间。
- 审计：统一写接点保存稳定对象类型/ID、版本或目录代次、变更前后白名单快照、原因和结果；价目明细、租期选项、媒体绑定变化包含在快照中。协议正文以digest引用，凭证只记录素材引用，不复制上传Token或原图；审计失败回滚业务。
- 媒体：upload-intents → `PUT /media/uploads/{intentId}`（`x-upload-token`）。Sharp完整解码JPEG/PNG/WebP，限制10MiB、单边8192、4000万像素、单帧、处理超时10秒；公开衍生图重新编码并清理元数据，原始字节单独保留供私有审核/证据读取。公开仅返回审核通过的衍生图，旧资产无衍生图须重新上传。对象写入在数据库事务外分两阶段执行：先用短事务复核当前权限与归属（已撤权请求零对象写入）并把原始/衍生对象写入内容寻址存储（每次写入前登记候选键，结果未知也可追溯），再在幂等事务内锁定意图、复核单次消费与权限并原子落库；对象写入成功但事务失败时保留对象并记录孤儿候选日志，不在请求路径自动删除，重复内容按哈希去重。存储默认本地 `uploads/`，可用 `MEDIA_STORAGE=oss` 显式切换到已授权开发OSS（zzsh-dev / `zzsh-rebuild/dev/` 前缀，服务端凭据来自进程环境，独立于PROVIDER_MODE；适配器已通过开发Bucket合成图片直连验证）。切换后端不迁移历史对象，无逐对象后端定位：需先复制并逐键核验或保持 `local`。撤销公开同事务清除目录绑定，旧公共URL返回404，响应 `Cache-Control: public, max-age=0, must-revalidate`；生产CDN、公开域名与浏览器直传未启用，不把永久公开URL当权限控制。
- 本轮不连接真实云资源；规则真实参数、包赔与押金策略、M4 订单占用与 M6 交付仍为后续范围。

## 供给发布与审核（M3-C）

核心前缀 `/api/v1/supply`，用户Cookie BFF为 `/api/bff/user/supply`（只适配传输，不重算业务）。管理审核核心前缀 `/api/v1/admin/supply/listing-reviews`，Admin BFF为 `/api/bff/admin/supply/listing-reviews`。

| 核心接口 | 输入/结果 |
|---|---|
| GET /games/{gameId}/publishing-options | 生效release/generation、租期选项、允许的安全箱/计价选项代码、封存协议正文及digest；不含收价和抽成参数 |
| GET /me/accounts、GET /accounts/{id} | 本人供给、草稿/当前版本、OwnerQuote、对应版本的协议正文、审核原因与blockers；详情可用versionId读取同档案历史，历史不可作为当前可租版本。号主读取的`declaration.mediaBindings`在既有`assetId/position/purpose/byteHash`上增加只读`reviewState`（`PENDING\|APPROVED\|REJECTED\|UNAVAILABLE`）、`publicDisplayEligible`与`publiclyReadable`。前者只表示素材当前具备 ACCOUNT_DISPLAY+APPROVED+PUBLIC_DISPLAY+公开衍生键；`publiclyReadable`表示`GET /listings/{accountId}/media/{assetId}`此刻会放行：须账号当前可公开（未暂停/未受限/规则有效/当前版本已审核且媒体就绪）且该图绑定在当前公开版本 payload 中。私有凭证、草稿独有图、撤权或暂停后均为 false。不由账号版本 APPROVED 推断。写入草稿仍只接受`assetId/position`，多带只读字段返回400。裁剪回`DraftInput`时只保留`assetId/position`。缺失或不可解析的绑定返回`UNAVAILABLE`且不让整份详情500。 |
| POST /accounts/{id}/drafts | expectedRevision；首次草稿或从已处理版本复制新草稿。审核中先撤回，切换为草稿立即阻止旧版接单，不改写owner_paused |
| PUT /accounts/{id}/draft | expectedRevision及title/description/attributes/termOptionCode/pricingOptionCode/inventory/skins/entitlements/mediaBindings；库存为整数基础单位文本或null，媒体只提交assetId/position，不接收价格/号主ID/digest/byteHash |
| POST /accounts/{id}/quote | expectedRevision；从持久化草稿、当前封存规则、目录和媒体记录生成并保存唯一规范化payload/hash；未知数量、条件、有效期不补零 |
| POST /accounts/{id}/accept-rules、/submit | expectedRevision、versionId、releaseId、contentHash；接受和提交必须匹配已保存报价及当前release |
| POST /accounts/{id}/withdraw | expectedRevision、versionId、可选reason；只撤回确切待审版本 |
| POST /accounts/{id}/pause、/resume | expectedRevision及可选reason；恢复另核审核、规则、身份、保证金资格、占用和媒体，不能解除客服限制 |
| GET /listings、GET /listings/{id} | 无登录墙的PublicQuote白名单；list支持可选`q`（NFC+trim，空白视为未传，最长120，NUL拒绝；服务端参数化`ILIKE`且`%/_/\\`按字面量）、gameId、itemId/minQuantity、重复skinId+skinMatch=ANY/ALL、limit1–100和cursor。游标绑定规范化后的`q`及其他过滤，更换条件后旧游标400，不混页。`q`只匹配当前可公开版本标题；`rental_account.display_no`从未写入，本轮不搜索编号，也不搜索内部用户ID、登录资料或私人说明。详情在既有quote/attributes上增加`attributes.safe_box_code`、`safeBox{code,displayName}`（现无安全箱名称目录，`displayName`为null）和`termOption{code,displayName,dailyConsumption{quantity,unit=HAFF_BASE}}`，数据取自该公开版本绑定的封存release/term_option，不用当前运营草稿改写；缺字段为null，不默认0。`quote.termSeconds`仍为权威租期；每日消耗只用于租期推算，不是每日保底。不可公开统一404。 |
| GET /listings/{id}/media/{assetId} | 仅当前可公开版本绑定、已审核ACCOUNT_DISPLAY的衍生图，no-store；下架、暂停、限制或规则过期后404 |
| 管理 GET /listing-reviews、/{accountId} | 按state/after/limit读取显式scope队列，nextCursor接后续after；详情含前版对比与审核/重复线索，不用内部ID作为主要人工入口 |
| 管理 POST /listing-reviews/{accountId}/decide | expectedRevision、versionId、releaseId、contentHash、APPROVE/REJECT、具体reason；审核/撤回竞争只接受一次有效处理 |
| 管理 POST /listing-reviews/{accountId}/restriction、/duplicates | 限制使用restricted+reason；重复线索使用relatedAccountId/evidenceRef/result/reason；均带expectedRevision，重复仅人工记录，不自动处置 |

- 匿名无版本档案统一404。公共详情、图片和整页列表在REPEATABLE READ READ ONLY事务中读取同一快照，不取用户/游戏/档案/版本的排他行锁。撤权提交后建立的新快照拒绝访问；已开始的读取可按其先前一致快照完成，响应保持no-store。
- 发布写回执保留原版本、修订及结果；首次和缓存重放发送前均按当前内部报价权限投影报价字段，不重新执行业务或刷新成另一版本，不改写原缓存。
- 全部写入带Idempotency-Key，重放仍检查当前身份、权限和对象范围。管理审核须supply.review.read，决定、限制、重复另需supply.review.decide、supply.restrict、supply.duplicate.review；内部双边报价另需supply.quote.internal.read。未配置scope不放行。
- listing_version.schema_version=1约束草稿属性及展示快照；attributes采用受控字段，安全箱条件保存为safe_box_code。未知值可留草稿；报价/提交必须满足已配置规则，不允许把空等级变成0。提交后内容/明细不可改，撤回或驳回后创建新版本；规则变化需新报价/接受及审核，不自动继承历史通过。
- M2用户行锁协调身份变化与发布事务；保证金/占用消费SupplyGateReader的明确结果，未接入默认UNKNOWN。仅服务端testSupplyGateReader与已启用test/fake能力允许正向fixture，HTTP请求不能提供已付款/未占用。M4原子占号、M5真实保证金尚未实现，不据本地fixture宣称不超卖或资金到账。
- ACCOUNT_EVIDENCE始终为私有证据；ACCOUNT_DISPLAY单独申报、审核，绑定需同号主/档案/游戏。用户素材不能经无条件的/media/{id}/content公开；原始证据保持私有。未传purpose时仍兼容M3-B私有凭证及原幂等指纹。
- 业务、接受、审核与审计同事务。审计保存版本/release/hash、前后状态、库存值和声明摘要/证据引用，不复制原始凭证。legacy_supply_map仅提供受控观察兼容入口，无生产导入命令；旧状态/未知单位不生成报价或审核通过。

## 游戏服务支持与改枪码（M3E）

游戏元数据、目录数据和已实现业务不是同一层。**game_service_operation** 只记录
代码已知的业务组合当前是否启用；代码中的支持清单仍是准入真值。当前唯一支持
组合是 **delta + ACCOUNT_RENTAL** 和 **delta + GUNSMITH**。创建一条 game、启用 game、
存在规则或存在目录条目，都不能使未知组合进入交易或公开服务。

- GET /api/v1/supply/games 只返回已启用且可公开的账号租赁游戏；
  GET /api/v1/supply/games/{gameId}/publishing-options、目录、列表和详情均
  要求 ACCOUNT_RENTAL 的代码支持、游戏启用和服务启用。
- GET /api/v1/supply/gunsmith/games、GET /gunsmith/games/{gameId}/firearms
  和 GET /gunsmith/firearms/{firearmId}/codes 要求 GUNSMITH 三项门禁；
  公共 DTO 不返回来源、revision 或内部状态，改枪码是原始不透明文本，复制不
  代表游戏内导入成功。
- 管理端使用 supply.gunsmith.manage 维护固定类型 firearm 下的分类、枪械、别名、
  已审核 FIREARM_MEDIA 绑定和一枪多码关系。code 创建后不可改名；写操作带
  Idempotency-Key，实体更新带 expectedRevision，均写审计。GUNSMITH 关闭时仍
  允许已支持 Delta 的目录准备和历史维护，公共入口保持不可见；未知游戏即使有
  目录也不能创建枪械/改枪码，启用服务返回 UNSUPPORTED_GAME_SERVICE。
- firearm 只引用同游戏 firearm_classification、已审核公开的 FIREARM_MEDIA 和
  同游戏 gunsmith_code。分类是受控目录数据，不是可由后台创建新实体类型或任意
  JSON 字段的配置系统。枪械、皮肤、计费物品的关系不可通过名称、皮肤分类或稀
  有度推断；本轮不把枪械加入 skin 或 billable_item。
- 未来客户端使用同一稳定 ID/分页/错误契约。Web 页面只是 BFF 消费者，不能把
  DOM、Cookie 或 Server Action 变成改枪码或游戏业务模型。

## 验证入口

```powershell
npm test -w @zzsh/api
npm run typecheck
```

测试会创建只监听 loopback 临时端口的隔离 Nest app，检查 OpenAPI 的请求/响应示例、header、resourceId pattern/maxLength、integer limit、错误码 enum、`additionalProperties:false` 以及运行时拒绝和安全错误兜底；不会连接数据库或第三方服务。`npm run check` 还包含明确隔离的本地 PostgreSQL 回归，资源规则见开发说明。

## M3-D 用户数据接入

- `GET /api/v1/supply/games` 返回已启用且有生效规则的游戏；`GET /games/{id}/publishing-catalog` 为号主选择投影。只列当前STANDARD价目覆盖的启用物品，搜索仅筛皮肤，不隐藏数量输入；分类祖先不可见时皮肤不返回。`inputScale=0`表示当前只接整数基础单位，`ready/blockers`明确未生效规则或必填物品未定价，不能填假价格补齐。目录不返回收价、抽成、来源原文或私有媒体引用。
- `publishing-options`补充允许的vitalityLevels/bearLevels，沿用服务器封存协议和选项代码；不公布内部比例映射。
- `PUT /api/v1/supply/favorites/{accountId}`：已认证本人、`Idempotency-Key`、`{saved:boolean}`，稳定供给ID，不使用版本ID。首次添加只接受当前公开供给；取消及既有收藏保持本人隔离。缓存只存`accountId/saved`原操作回执，重放不改动当前状态、不重复成功审计。
- `GET /api/v1/supply/me/favorites?limit=&cursor=`：本人分页；AVAILABLE只含当前PublicListing，UNAVAILABLE为通用“暂不可用、收藏已保留”及null listing，不泄漏原价格、私有原因或资料。游标绑定本人及精确保存时间/ID。
- Nest用户BFF仍为`/api/bff/user/supply`，透传查询串（含`q`、既有gameId/item/skin/cursor）和只读新字段，不自行搜索、重算租期或推断媒体审核状态。Next用户BFF新增`/api/supply/*`，仅允许已实现用户接口、筛选用户Cookie，保留幂等键/受限上传Token；JSON输入64KiB、图片10MiB，输出及读取时间有界。媒体URL仅作本地路径适配，金额原样传输；认证代理共用既有Cookie及有界读取工具，认证规则不变。`GET /listings` 的`q`走查询串，路径白名单无需为搜索新增段。
- 用户调用DTO和错误恢复位于apps/web/src/lib/supply-types.ts、supply-client.ts；分组接入见[供给表单契约](supply-form-contract.md)。这部分是数据接口，正式市场/详情/发布页面及游客收藏合并仍待UI基线整合。

## 内容后台：公告、资讯与固定槽位轮播（M3 内容分片）

核心前缀 `/api/v1/content`（公共）与 `/api/v1/admin/content`（管理）；Admin BFF `/api/bff/admin/content/...` 只适配传输。写操作要求 `Idempotency-Key`，业务、审计与幂等记录同事务，审计失败回滚；`revision` 是并发令牌，过期确认返回 409，同 key 重放返回原结果、异体同 key 409。

- 模型在 `zzsh_content` schema（迁移 `0024_m3_content_foundation`）：`content_item`（稳定 ID、`type`=`ANNOUNCEMENT|NEWS`、`game_id` 可空、`sort_order`、条目 `revision`）与 `content_version`（`DRAFT|PUBLISHED|SUPERSEDED|WITHDRAWN`、title/summary/body/cover_media_id、草稿 `revision`、`published_at`）。每条目最多一个草稿与一个线上版本：发布把草稿转为 PUBLISHED、旧线上版本转 SUPERSEDED；撤回把线上版本转 WITHDRAWN。编辑已发布内容必须 `POST /items/{id}/draft` 复制新草稿，不能原地修改线上正文；无任何版本时列表以 `latest` 显示最后版本。正文为 NFC 规范化纯文本（LF 换行，≤20000 字节，拒绝控制字符），不执行 HTML、不提供自由页面或插件能力。发布动作要求随幂等记录持久化（迁移 `0025_m3_content_idempotency_publish_flag`），见下条。
- 平台公告只允许平台级；资讯可平台级或绑定单个游戏。平台级内容（公告、平台资讯、轮播、平台内容素材）使用 `content.platform.read/edit/publish`；游戏资讯使用 `content.read/edit/publish` 并检查该游戏 `admin_supply_scope`；无权或跨范围统一 404。游戏内容权限不能修改平台公告或全站轮播，平台权限也不能修改游戏级资讯。
- 轮播权限按影响公开展示的动作区分：创建或编辑未启用草稿只需 `content.platform.edit`；创建即 `enabled=true`、启用、停用、以及修改已启用条目的图片/无障碍文本/标题/说明/跳转/排序/起止时间必须另有 `content.platform.publish`。判断在事务内锁定条目后按实际状态进行（并发启用不能靠旧状态规避）；幂等重放在复核当前授权之外，还必须满足原操作记录的发布要求（`idempotency_record.publish_required`），停用或线上字段修改成功后即使用户随后被撤销发布权限、条目状态已改变，重放也不会降级放行；被拒绝的请求不产生公共变化、成功审计或幂等回执。
- 管理：`GET /items?scope=platform|game&gameId=&type=&limit=&cursor=`、`GET /items/{id}`（含 draft/published/latest 与版本历史）、`POST /items`、`PUT /items/{id}/draft`（`versionId`+`expectedRevision`+字段；服务端不自行选择草稿，过期或已替换版本返回 409/404，缺 `versionId` 返回 400）、`POST /items/{id}/draft`、`POST /items/{id}/publish`（versionId+expectedRevision）、`POST /items/{id}/withdraw`（versionId+条目 expectedRevision）、`PUT /items/{id}`（排序）；`GET/POST /carousel`、`PUT /carousel/{id}`（槽位仅 `HOME_HERO`，启停、排序、起止时间、跳转与无障碍说明）；`POST /media/upload-intents`（purpose=`CONTENT_MEDIA`，无 gameId）、`PUT /media/uploads/{intentId}`、`POST /media/{id}/review`、`POST /media/{id}/visibility`、`GET /media`、`GET /media-options`、`GET /media/{id}/content`（私有原图，要求 `content.platform.read`）。
- 公共：`GET /items`（只返回当前 PUBLISHED；排序 `sort_order DESC, published_at DESC, id DESC`；游标保留数据库微秒精度并绑定 type/gameId/limit，过滤不一致 409）、`GET /items/{id}`、`GET /carousel?slot=HOME_HERO`（enabled、服务端 UTC 时间窗内：开始包含、结束不包含、素材已审核公开）、`GET /media/{id}/content`（仅 CONTENT_MEDIA 的 APPROVED+PUBLIC_DISPLAY 公开衍生图）。公共 DTO 不包含 revision、操作人员身份、私有存储键或内部备注；封面素材撤权后 `coverMediaId` 返回 null 而正文保留，轮播素材撤权后条目整体不返回。公共内容响应 `no-store`，内容媒体响应 `public, max-age=0, must-revalidate`。
- 轮播 `linkUrl` 只允许站内相对路径：必须以 `/` 开头，首段为 `accounts|publish|account|help` 或路径就是 `/`，拒绝 `//`、反斜杠、`..`、控制字符与任何 scheme（`javascript:` 等）；数据库仅兜底校验以 `/` 开头。未实现的订单、支付、客服动作不能作为轮播落点。
- 平台内容素材复用既有媒体两阶段上传、审核与公开衍生图机制，不复制上传系统：`media_asset/media_upload_intent` 的 `game_id` 可空，新增 `ownership_kind=PLATFORM_CONTENT` 与 `purpose=CONTENT_MEDIA`；目录/用户媒体的游戏 scope 校验与私有凭证语义不变。运行时角色对内容表只有 SELECT/INSERT/UPDATE，没有 DELETE/TRUNCATE。

## 公共目录与上传反馈补充

- 公开账号详情的 `game` 为服务器确认的 `{id, code, name}`，缺少可靠数据时为 `null`；客户端不得按来源 URL 推断游戏。旧客户端可忽略这一新增字段。
- 用户与管理端上传意图共用 10 MiB（10485760 字节）上限，仅接收 PNG、JPEG、WebP。声明大小或格式错误返回 `400 INVALID_ARGUMENT`，`details[].path` 为 `size` 或 `mime`；超限信息包含声明字节数和上限。实际上传仍执行服务端字节、格式与图片安全检查，客户端前置提示不构成授权或校验替代。
