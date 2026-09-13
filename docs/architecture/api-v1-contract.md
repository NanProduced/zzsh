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
- 目录：`GET /api/v1/supply/games/{gameId}/catalog` 为公共白名单并绑定 `catalogRevision` 游标；管理端目录、游戏、物品/分类/皮肤/稀有度/权益维护均在管理端前缀下。稳定 code 创建后不可改名，词条只停用不物理删除；旧来源字段以受限原文保留，未知值不默认成有效词条。计费物品（items）更新接受 `mediaId` 绑定经审核公开的 ITEM_MEDIA 资产，撤销公开同事务清除绑定；公开目录 items 仅在资产 APPROVED+PUBLIC_DISPLAY 时投影 `mediaId`，与皮肤 mediaId 投影规则一致。
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
| GET /me/accounts、GET /accounts/{id} | 本人供给、草稿/当前版本、OwnerQuote、对应版本的协议正文、审核原因与blockers；详情可用versionId读取同档案历史，历史不可作为当前可租版本 |
| POST /accounts/{id}/drafts | expectedRevision；首次草稿或从已处理版本复制新草稿。审核中先撤回，切换为草稿立即阻止旧版接单，不改写owner_paused |
| PUT /accounts/{id}/draft | expectedRevision及title/description/attributes/termOptionCode/pricingOptionCode/inventory/skins/entitlements/mediaBindings；库存为整数基础单位文本或null，媒体只提交assetId/position，不接收价格/号主ID/digest/byteHash |
| POST /accounts/{id}/quote | expectedRevision；从持久化草稿、当前封存规则、目录和媒体记录生成并保存唯一规范化payload/hash；未知数量、条件、有效期不补零 |
| POST /accounts/{id}/accept-rules、/submit | expectedRevision、versionId、releaseId、contentHash；接受和提交必须匹配已保存报价及当前release |
| POST /accounts/{id}/withdraw | expectedRevision、versionId、可选reason；只撤回确切待审版本 |
| POST /accounts/{id}/pause、/resume | expectedRevision及可选reason；恢复另核审核、规则、身份、保证金资格、占用和媒体，不能解除客服限制 |
| GET /listings、GET /listings/{id} | 无登录墙的PublicQuote白名单；list支持gameId、itemId/minQuantity、重复skinId+skinMatch=ANY/ALL、limit1–100和cursor；不可公开统一404 |
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
- Nest用户BFF仍为`/api/bff/user/supply`。Next用户BFF新增`/api/supply/*`，仅允许已实现用户接口、筛选用户Cookie，保留幂等键/受限上传Token；JSON输入64KiB、图片10MiB，输出及读取时间有界。媒体URL仅作本地路径适配，金额原样传输；认证代理共用既有Cookie及有界读取工具，认证规则不变。
- 用户调用DTO和错误恢复位于apps/web/src/lib/supply-types.ts、supply-client.ts；分组接入见[供给表单契约](supply-form-contract.md)。这部分是数据接口，正式市场/详情/发布页面及游客收藏合并仍待UI基线整合。
