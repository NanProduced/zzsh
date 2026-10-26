# API v1 契约基线

以下是共享API约定；具体业务端点以对应模块契约及实际注册路由为准。OpenAPI探针验证格式约束，不代表所有业务路由均已生成完整文档。

## 范围与边界

- 业务接口使用 `/api/v1/...`，个人确认及新版建单使用显式 `/api/v2/...`；`/api/health` 继续是独立 liveness 探针，不参与业务版本或 readiness 语义。
- NestJS 业务层只依赖 JSON、HTTP header 和服务端校验，不依赖 Cookie、DOM、Next.js Server Actions 或小程序运行时。
- 已提供待支付订单、个人确认/v2建单、原子占用，以及隔离受控付款与开租/结算账务；没有面向客户端的付款成功注入接口，真实支付、退款和提现渠道未接入。认证与管理员操作权限已由 Admin 安全/BFF 入口提供，不经过本文件的 probe controller。
- OpenAPI 与运行时校验在 `apps/api/test/api-contract.test.ts` 的隔离 Nest app 中验证；该 probe controller 不在生产 `AppModule` 注册，不能作为生产测试写路由。
- probe 的严格请求 schema 使用显式 ApiBody 声明；DTO 本身不会自动禁止所有未知字段。业务 controller 必须声明对应约束并验证其实际生成 schema，不得把测试示例通过当成业务文档自动一致。

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

契约探针中的未知字段不会原样进入 `details.path`；顶层、金额对象和分页对象分别只返回固定的 `body`、`amount`、`page` 路径，最多返回 8 条安全问题。

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
- 皮肤身份：新建为停用且不展示的PENDING，写请求绑定expectedCatalogRevision。显式confirmIdentity及同游戏ownerRef/baseName形成VERIFIED规范名称；ownerKind为AGENT/FIREARM/MELEE_TYPE，已确认近战可以显式MELEE_TYPE+ownerRef:null，不虚构具体刀型。VERIFIED改名必须重确认结构身份，LEGACY/PENDING直接改名须reason并保留旧名alias。LEGACY重新启用前须确认身份，来源namespace/field/token不得覆盖已冻结身份。受控旧目录机械规范化另见[历史映射](legacy-data-mapping.md)，不新增HTTP入口。源码合同不代表真实目录、数据库或浏览器验收完成。
- 皮肤字段：写入支持`rarityEvidence:null|{schema:"skin-rarity-evidence-v1",basis:"PLATFORM_REFERENCE"|"OFFICIAL",sourceName,references}`、`isCollectible:boolean|null`、`defaultState:"UNKNOWN"|"DEFAULT"|"NON_DEFAULT"`及`mediaSource:null|{schema:"skin-media-source-v1",kind:"PORTRAIT_CARD"|"MODEL_IMAGE"|"PROMO_POSTER",sourceName,url}`。证据references沿用HTTPS/date/region/note校验，素材来源URL也须无凭据HTTPS；来源类型不等于官方已核。新建或换绑品质须同游戏启用品质及显式证据；同值旧缺证据/停用品质可在无关编辑中保留，清品质同时清证据，换图或撤图不继承旧图片来源。Admin返回完整证据/来源和ownerKind，ownerRef仅在真实所属ID存在时构造；公开摘要只返回rarityBasis/isCollectible/defaultState及可选的`mediaKind:null|"PORTRAIT_CARD"|"MODEL_IMAGE"|"PROMO_POSTER"`，不暴露完整证据或来源URL。公开目录、legacy实时摘要及当前草稿可读现目录mediaKind；新报价/展示presentation单独冻结该字段，旧native或冻结快照缺失时保持缺失，不查现目录回填，不扩展旧legacy_display_snapshot schema。
- 皮肤目录分页：catalog/publishing-catalog接受`q/categoryId/rarityCode/ownerId/limit/cursor`，limit默认20、范围1–100；cursor绑定游戏、catalogRevision和q/categoryId/rarityCode/ownerId，改筛选或目录变更后旧游标409。ownerId是同游戏实际干员/枪械/近战所属ID；响应owners来自完整可见目录，categories.ownerKind包含可见子分类引用，仅唯一已知类型返回值，混合/未知/空为null。公开皮肤mediaId仍须同游戏、完整可见分类树及平台审核公开衍生图门禁；旧冻结快照不补写新增摘要字段。
- 素材选项：`GET /supply/games/{gameId}/media-options?purpose=ITEM_MEDIA&limit=&cursor=`（管理 BFF `/api/bff/admin/supply/...` 同理）返回可绑定候选，服务端只返回同游戏、PLATFORM_CATALOG、对应用途、APPROVED、PUBLIC_DISPLAY 且有公开衍生图的资产（id/mime/width/height/byteSize，不含私有字段与存储键），要求 `supply.catalog.manage` 与游戏 scope，不要求 `supply.review.read`。客户端不能凭素材 id 提升未审核/私有/异游戏素材；缺操作权限返回403，超出游戏范围或对象不可见返回404。分页沿用 /media/reviews 约定：`limit` 1–100 默认 20，响应 `{items, nextCursor, limit}`，按 `updated_at DESC, id DESC` 稳定排序，cursor 绑定 gameId/purpose/limit，过滤或翻页参数不一致时 409。选择器的预览/绑定图一律走公共衍生图 `GET /api/v1/supply/media/{id}/content`（校验 APPROVED+PUBLIC_DISPLAY+PLATFORM_CATALOG），不触碰私有原图接口；撤销公开后该路径 404。
- 规则：价格/租期/协议可编辑草稿并封存；明细写入锁定 OLD/NEW 父版本，不能将封存明细移入草稿。版本归属不可更换，已引用物品的单位/数量语义须新建词条。release 不可修改。
- 生效：`POST /api/v1/admin/supply/releases` 携带 `expectedGeneration`（十进制字符串，未生效为 `"0"`）；Boss 在 game 锁内执行 CAS，过期确认返回409，同 key 重放不增加release。管理端显示确认代次。
- 计价：`POST /quote-preview` 返回受权管理员内部投影。SPREAD/PERCENT 按精确十进制比例计算，费率范围 `[0,1)`；每行双边金额各舍入一次到分，平台金额为两者差额。HAFF 精确分子/分母随快照保留，展示单位价不能替代精确比例重算。`tenantDepositCents`、`publisherBailRequirementCents` 只接受整数分字符串；缺参为null。日档参与已配置币价条件及租期推算，无每日保底收费。
- 推荐押金：本人原生DRAFT通过`GET /api/v1/supply/accounts/{id}/deposit-recommendation`读取，金额由生效fundingPolicy计算，客户端不提交或计算skinFacts。成功响应带recommendationSchema、账号/版本/release/price版本及inputs；v2在原声明输入外包含`skinFacts={schema:"deposit-skin-facts-v1",gameId,listingVersionId,catalogRevision,skins:[{skinId,ownerKind,rarityCode}]}`，空集也显式提供。未配置或事实不足返回available:false，不回退0；v1冻结政策与旧响应兼容，v2类型/品质、覆盖、取整与显式采用见[表单合同](supply-form-contract.md)。
- 本人未确认草稿可在version附`draftSkinSummary={source:"CURRENT_DRAFT_SELECTION",catalogRevision,items,withheld}`；仅NATIVE+DRAFT+contentHash=null，按当前公开目录门禁投影已选项，空集明确返回，withheld只计当前不可展示项。仅owner私有读使用，不替换冻结presentation、不扩公开读或证明上架；客户端新增字段可选，展示为“草稿已选皮肤”。
- 内容摘要：白名单 payload 先规范化再计算 SHA-256；人类文本 NFC/LF，ID/code原样，整数十进制、比例去尾零、单位价8位/元金额2位、业务时间UTC六位微秒（超精度拒绝），可选值null，集合按业务键排序且拒绝重复/未知字段。带声明的预览回显同一 `contentPayload` 与报价，规则JSON和协议正文先规范化再保存；申报版本持久化与接受见下方发布契约。hash不包含自身、审核状态或审计时间。
- 审计：统一写接点保存稳定对象类型/ID、版本或目录代次、变更前后白名单快照、原因和结果；价目明细、租期选项、媒体绑定变化包含在快照中。协议正文以digest引用，凭证只记录素材引用，不复制上传Token或原图；审计失败回滚业务。
- 媒体：upload-intents → `PUT /media/uploads/{intentId}`（`x-upload-token`）。Sharp完整解码JPEG/PNG/WebP，限制10MiB、单边8192、4000万像素、单帧、处理超时10秒；公开衍生图重新编码并清理元数据，原始字节单独保留供私有审核/证据读取。平台目录/内容媒体需审核通过；用户ACCOUNT_DISPLAY按技术READY、审核状态PENDING或APPROVED及有效发布绑定提供公开衍生图，不要求人工预审。旧资产无衍生图须重新上传。对象写入在数据库事务外分两阶段执行：先用短事务复核当前权限与归属（已撤权请求零对象写入）并把原始/衍生对象写入内容寻址存储（每次写入前登记候选键，结果未知也可追溯），再在幂等事务内锁定意图、复核单次消费与权限并原子落库；对象写入成功但事务失败时保留对象并记录孤儿候选日志，不在请求路径自动删除，重复内容按哈希去重。存储默认本地 `uploads/`，可用 `MEDIA_STORAGE=oss` 显式切换到已授权开发OSS（zzsh-dev / `zzsh-rebuild/dev/` 前缀，服务端凭据来自进程环境，独立于PROVIDER_MODE；适配器已通过开发Bucket合成图片直连验证）。切换后端不迁移历史对象，无逐对象后端定位：需先复制并逐键核验或保持 `local`。撤销公开同事务清除目录绑定，旧公共URL返回404，响应 `Cache-Control: public, max-age=0, must-revalidate`；生产CDN、公开域名与浏览器直传未启用，不把永久公开URL当权限控制。
- 保证金核定：管理 `GET/POST /api/v1/admin/supply/accounts/{id}/guarantee-proof`（同源BFF为 `/api/bff/admin/supply/...`）复用正式政策、声明与最新proof。读取需 `supply.guarantee.read` 和游戏范围；写入另需 `supply.guarantee.verify`，撤销需 `supply.guarantee.revoke`。POST绑定四个expected版本、status、evidenceRef/evidenceDigest和reason，追加不可变proof并审计；NOT_REQUIRED使用当前context返回的政策依据，不由旧payIs或未知金额推断豁免。SATISFIED核定材料也不是渠道到账通知。
- 媒体接口不代表真实交易能力。正式资金政策/依据reader与保证金核定API已接入，完整配置/披露及真实资金渠道仍有缺口；订单与受控账务边界见下文及[结算合同](settlement-confirmation.md)。

### 独立包赔条款与原操作恢复

管理目录响应新增firearmOwners，仅含同游戏/同scope的id/code/name/enabled，不含改枪码、别名或私图，不产生gunsmith写权限。规则维护者可读取管理游戏索引，不必为索引取得目录或改枪码维护权。

- 包赔正文独立于普通agreement：POST /api/v1/admin/supply/full-payout-terms-drafts 输入gameId/policyRef/policyVersion/disclosureVersion/title/body；PUT /full-payout-terms-drafts/{id} 输入expectedRevision和至少一个title/body/disclosureVersion；POST /full-payout-terms-drafts/{id}/seal 输入expectedRevision。均需supply.rules.edit、游戏scope及原事务幂等/审计。稳定身份/引用不可改，SEALED正文不可改或删除。创建初始revision为0，后续严格递增。
- GET /full-payout-terms/{id}读取授权范围内单版正文；管理GET /games/{id}/rules增加fullPayoutTermsVersions摘要。资金政策新封存时在同一UPDATE绑定真实条款ID/digest/披露版本，生效核该绑定；旧封存价格不补绑，不按后来新增的同名正文追认。必须引用同游戏已封存版本；不向现行fundingPolicy严格schema追加digest字段。普通协议换版不自动改价格/保证金，不覆盖旧订单hash。
- 公共GET /api/v1/supply/games/{id}/full-payout-terms可用releaseId绑定当前发布，返回releaseId/fullPayoutTerms（版本、正文、digest、披露版本），不返回资金内部参数。无适用资金政策时terms为null，不生成默认正文。正文不自动改变已确认8%等计算规则，生效仍由Boss审核规则发布。
- 选择包赔的号主accept-rules和租客个人确认/首次建单显式提交fullPayoutTermsAcceptance={termsVersionId,termsDigest,disclosureVersion}。服务端匹配实际适用版本，缺项/错版拒绝；未选不接受该字段。号主接受记录与新订单实际资金依据绑定digest；正文永久保留，旧资料不补签/不重算。
- GET /api/v1/admin/supply/operation-result?operation=...&resourceId=...&fingerprint=...（同源Admin BFF同路径）携带原Idempotency-Key，只恢复已列入白名单的目录、规则、平台目录媒体操作。resourceId必须与原幂等作用域一致（创建规则/意图时省略，目录词条创建使用gameId），不接受principalId/realm或任意操作。当前身份、原主体、操作/key/指纹及游戏scope均校验。
- fingerprint沿既有UTF-8 SHA256(JSON.stringify([operation,resourceId??null,原请求JSON??null]))，保留原JSON字段表示。文件PUT沿既有`{intentId,token,contentHash:fingerprintRequest("bytes",intentId,文件base64)}`指纹合同；初次提交时计算并只保留最终指纹，不能持久化token/文件，也不能靠重传恢复。
- 原记录存在返回receipt=RECORDED、responseStatus及必要白名单结果，不回吐整份缓存body、上传token/私证/金额。无原记录返回UNRESOLVED，可能仍在途，不能判未受理或发新key；回读401/403/404/5xx也不能作为原写失败。ACK后展示读取失败与未收到ACK分别保留。该GET不执行原业务写，请求有记录不代表文件公开或资金到账。

独立条款schema、接受列及订单最终DB检查需要对应增量迁移。列表/详情显式READ用途使用无行锁的信用保证金投影；发布/确认/建单默认WRITE并保持锁内重核。应用签发及首次插单前重核最新有效proof/主体/版本；最终INSERT守卫还须用DB时钟核验。SQL源码或离线mock不代表这些数据库守卫已运行。

## 供给发布与审核（M3-C）

核心前缀 `/api/v1/supply`，用户Cookie BFF为 `/api/bff/user/supply`（只适配传输，不重算业务）。管理审核核心前缀 `/api/v1/admin/supply/listing-reviews`，Admin BFF为 `/api/bff/admin/supply/listing-reviews`。

| 核心接口 | 输入/结果 |
|---|---|
| GET /games/{gameId}/publishing-options | 生效release/generation、租期选项、允许的安全箱/计价选项代码、封存协议正文及digest；不含收价和抽成参数 |
| POST /accounts | `{gameId}`；创建本人账号档案，不同时创建草稿。随后GET读取版本，再以当前expectedRevision调用POST /accounts/{id}/drafts |
| GET /me/accounts、GET /accounts/{id} | 本人供给、草稿/当前版本、OwnerQuote、对应版本的协议正文、审核原因与blockers；详情可用versionId读取同档案历史，历史不可作为当前可租版本。号主读取的`declaration.mediaBindings`在既有`assetId/position/purpose/byteHash`上增加只读`reviewState`（`PENDING\|APPROVED\|REJECTED\|QUARANTINED\|UNAVAILABLE`）、`publicDisplayEligible`与`publiclyReadable`。前者只表示素材当前具备 ACCOUNT_DISPLAY+技术READY+审核状态PENDING或APPROVED+PUBLIC_DISPLAY+公开衍生键；`publiclyReadable`表示`GET /listings/{accountId}/media/{assetId}`此刻会放行：须账号当前可公开（未暂停/未受限/规则有效/当前版本具有有效发布事实且媒体就绪）且该图绑定在当前公开版本 payload 中。私有凭证、草稿独有图、撤权或暂停后均为 false。不由账号版本 APPROVED 推断。写入草稿仍只接受`assetId/position`，多带只读字段返回400。裁剪回`DraftInput`时只保留`assetId/position`。缺失或不可解析的绑定返回`UNAVAILABLE`且不让整份详情500。 |
| POST /accounts/{id}/drafts | expectedRevision；首次草稿或从已处理版本复制新草稿。审核中先撤回，切换为草稿立即阻止旧版接单，不改写owner_paused |
| PUT /accounts/{id}/draft | expectedRevision及title/description/attributes/termOptionCode/pricingOptionCode/inventory/skins/entitlements/mediaBindings；库存为整数基础单位文本或null，媒体只提交assetId/position，不接收价格/号主ID/digest/byteHash |
| POST /accounts/{id}/quote | expectedRevision；从持久化草稿、当前封存规则、目录和媒体记录生成并保存唯一规范化payload/hash；未知数量、条件、有效期不补零 |
| POST /accounts/{id}/accept-rules、/submit | expectedRevision、versionId、releaseId、contentHash；接受和提交必须匹配已保存报价及当前release |
| POST /accounts/{id}/withdraw | expectedRevision、versionId、可选reason；只撤回确切待审版本 |
| POST /accounts/{id}/pause、/resume | expectedRevision及可选reason；恢复另核有效发布事实、规则、身份、保证金资格、占用和媒体，不能解除客服限制 |
| GET /listings、GET /listings/{id} | 无登录墙的PublicQuote白名单；以下为未指定queryVersion的v1合同，v2见[组合筛选合同](listing-query.md)。list支持可选`q`（NFC+trim，空白视为未传，最长120，NUL拒绝；服务端参数化`ILIKE`且`%/_/\\`按字面量）、gameId、itemId/minQuantity、重复skinId+skinMatch=ANY/ALL、limit1–100和cursor。游标绑定规范化后的`q`及其他过滤，更换条件后旧游标400，不混页。`q`只在当前可租候选池匹配标题/公开号，不搜索内部用户ID、登录资料或私人说明；精确编号`GET /listings/lookup?number=&gameId=`可查仍获准公开的暂不可租资料，详见[账号可见性与编号](account-visibility.md)。原生编号须装配独立账号序列与约束后在创建事务中持久赋值，不借订单号；旧号按可信冻结来源保留。详情在既有quote/attributes上增加`attributes.safe_box_code`、`safeBox{code,displayName}`（已知稳定code从受控映射返回中文名称，未知code的displayName为null；attributeDisplay保留UNCONFIRMED及issueCode，缺值不猜测）和`termOption{code,displayName,dailyConsumption{quantity,unit=HAFF_BASE}}`，数据取自该公开版本绑定的封存release/term_option，不用当前运营草稿改写；缺字段为null，不默认0。`quote.termSeconds`仍为权威租期；每日消耗只用于租期推算，不是每日保底。不可公开统一404。 |
| GET /listings/{id}/media/{assetId} | 仅当前可公开版本绑定且技术/公开资格有效的ACCOUNT_DISPLAY衍生图，no-store；下架、暂停、限制或规则过期后404 |
| 管理 GET /listing-reviews、/{accountId} | 按state/after/limit读取显式scope队列，nextCursor接后续after；详情含前版对比与审核/重复线索，不用内部ID作为主要人工入口 |
| 管理 GET /listing-reviews?queryVersion=3 | 跨资料状态账号供给读取；view=all/changes/restricted/paused/orders，queryKind=account/legacy/owner/nickname/order、q、gameId、limit（1–50）、cursor。号主昵称多候选，业务编号/旧来源编号/稳定ID分别保留；无新编号时不落库伪造。游标HMAC绑定管理员/会话/权限/游戏scope/完整查询；旧ID游标、绑定或签名不符409回首页。列表无全局总计。order线索/视图另需order.read。 |
| 管理 GET /listing-reviews/{accountId}?queryVersion=3 | 独立对象读取，versionId限同账号历史；返回contractVersion/contextKey、当前资料与历史/前版、supervision的权威公开/新单/阻断与主要原因、对象相关限制事件、按独立权限裁剪的号主/订单目标。公开读取复用原生及旧来源只读合同，旧来源公开不等原生接单许可；缺资料/原事件/图片不补造证据。历史版本只读，当前业务事实仍单列。 |
| 管理 POST /listing-reviews/{accountId}/decide | expectedRevision、versionId、releaseId、contentHash、APPROVE/REJECT、具体reason；审核/撤回竞争只接受一次有效处理 |
| 管理 POST /listing-reviews/{accountId}/restriction、/duplicates | 限制使用restricted+reason；重复线索使用relatedAccountId/evidenceRef/result/reason；均带expectedRevision，重复仅人工记录，不自动处置 |

- 匿名无版本档案统一404。公共详情、图片和整页列表在REPEATABLE READ READ ONLY事务中读取同一快照，不取用户/游戏/档案/版本的排他行锁。撤权提交后建立的新快照拒绝访问；已开始的读取可按其先前一致快照完成，响应保持no-store。
- 发布写回执保留原版本、修订及结果；首次和缓存重放发送前均按当前内部报价权限投影报价字段，不重新执行业务或刷新成另一版本，不改写原缓存。
- 全部写入带Idempotency-Key，重放仍检查当前身份、权限和对象范围。管理审核须supply.review.read，决定、限制、重复另需supply.review.decide、supply.restrict、supply.duplicate.review；内部双边报价另需supply.quote.internal.read。未配置scope不放行。
- 号主submit在门禁通过后写入不可变OWNER_DIRECT发布事实，版本置PUBLISHED，不伪造管理员APPROVE。历史APPROVED必须匹配真实LEGACY_APPROVED发布依据；详情见[直接发布合同](supply-form-contract.md)。
- listing_version.schema_version保留旧1，含rentalPricing的新声明/报价使用2；attributes采用受控字段，安全箱条件保存为safe_box_code。未知值可留草稿；报价/提交必须满足已配置规则，不允许把空等级变成0。提交后内容/明细不可改，撤回或驳回后创建新版本；规则变化需新报价/接受并形成有效发布事实，不自动继承历史通过。
- 用户行锁协调身份变化与发布事务，占用由订单表派生。默认SupplyGateReader读取当前正式政策及最新有效保证金依据，缺失或不匹配为UNKNOWN；测试替代reader仅限显式test/fake能力。HTTP不能自行声明已付款/未占用，正式核定依据也不等于真实资金到账。
- ACCOUNT_EVIDENCE始终为私有证据；ACCOUNT_DISPLAY单独申报并执行技术/公开资格校验，绑定需同号主/档案/游戏；仍可由有权管理员审核或隔离。用户素材不能经无条件的/media/{id}/content公开；原始证据保持私有。未传purpose时仍兼容M3-B私有凭证及原幂等指纹。
  - 管理`POST /media/{assetId}/review`及`/visibility`对USER_SUPPLY/ACCOUNT_DISPLAY的新意图都要求`accountContext={accountId,accountRevision,versionId,assetRevision,byteHash}`及2–500字原因。账号→媒体锁内校验原号主、当前版本、仍绑定图片、两种修订及字节摘要；错账号/用途404，缺上下文或版本/绑定改变409重新核对。这是旧客户端写合同收紧：原媒体页转精确来源账号/图片核对；未绑定当前版本的图保留只读与待补合法处置边界，不能自动改其他图。平台目录/内容素材及私有凭证保持原合同。已成功旧key重放仍先核当前权限/scope再返回原回执，不重新执行或因旧CAS变更再写。
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
  有度推断；当前枪械独立于 skin 和 billable_item。
- 未来客户端使用同一稳定 ID/分页/错误契约。Web 页面只是 BFF 消费者，不能把
  DOM、Cookie 或 Server Action 变成改枪码或游戏业务模型。

## M4-A 订单与账号占用基础

核心前缀 `/api/v1/orders`（用户 Cookie BFF `/api/bff/user/orders`，Web Next BFF `/api/orders` 白名单代理，均只适配传输）；管理查询 `/api/v1/admin/orders`（Admin BFF `/api/bff/admin/orders`）。订单事实存于 `zzsh_order.rental_order`（迁移 `0030_m4_order_reservation`），金额以 numeric 分存真值，接口仍按 CNY/yuan/scale=2 十进制字符串。

| 核心接口 | 输入/结果 |
|---|---|
| POST /api/v1/orders | `Idempotency-Key` + `{accountId, versionId, releaseId}`（确认令牌，仅三字段）。服务端按序锁双方 user（单条 `ORDER BY id ... FOR UPDATE`）→ game → account，复核当前版本/release、全量可租 blocker、租客 VERIFIED+ADULT、非号主本人、押金 CONFIGURED，同一事务内原子占用（部分唯一索引兜底）并写审计与幂等记录。返回 RenterOrder（PENDING_PAYMENT、holdUntil、PublicQuote 投影） |
| POST /api/v1/orders/{id}/cancel | `Idempotency-Key` + 可选 `{reason}`（自由文本仅入审计，订单列只存枚举）。本人待支付单可取消（含已过期未清扫），CAS 单次转换 |
| GET /api/v1/orders | `party=renter|owner`（默认 renter）、status/accountId/limit/cursor；按 party 投影，游标绑定主体与筛选，不一致 409 |
| GET /api/v1/orders/{id} | 按归属投影（renter/owner 否则 404）；会话与活性在事务内复核 |
| GET /api/v1/admin/orders(/+id) | 要求 `order.read` 动态权限 + 该游戏 `admin_supply_scope`（Boss 豁免 scope）；平台金额仅另有 `supply.quote.internal.read` 时投影 |

- 状态为 `PENDING_PAYMENT`/`PAID`/`CANCELLED`/`COMPLETED`；占用集合为待付+已付。INSERT只允许待付，待付可转取消/已付；PAID仅在受控结算过账满足数据库守卫时转COMPLETED并释放占用。快照与hold_until不可改。PAID只表示本地收款事实已接纳，不表示真实到账、建群、交付或开租；PAID/COMPLETED的paymentOpen/cancelOpen为false并返回paidAt，未知状态不得默认放行。paymentOpen只是订单状态能力标志，不证明真实支付入口已开放。
- 已有订单查询在有履约意图时追加 `fulfillmentAssignment={state,waitingReason,assignedAt,teamReady}`；当前state为WAITING/ASSIGNED，waitingReason可为NO_ELIGIBLE_STAFF，teamReady按teamState是否READY投影。本地分配不改变付款或占用，不向无归属者开放订单信息；群接入与真实渠道边界见[客服说明](customer-support.md)。
- 金额四要素分开：租金（快照 resourceTotal）、押金（快照 tenantDeposit）、总应付（派生）。`depositPolicy=UNCONFIGURED` 一律拒绝 409 `DEPOSIT_UNCONFIGURED`；未配置不是免押金，权威零押金必须是显式配置值。新增稳定码 `OCCUPIED`/`RULE_CHANGED`/`VERSION_CHANGED`/`DEPOSIT_UNCONFIGURED`（均 409）。
- 创建与重放分开授权：首次创建要求交易资格；命中幂等记录只复核请求人会话/活性/归属，不因号主停用、供给占用/下架、规则变化而重复执行创建条件，也不泄露他人幂等响应。读/取消要求会话+活性+归属，不要求交易资格。
- 占用时间只认数据库时钟，`hold_until` 创建即冻结不可续期。到期不改变事实状态（DTO 派生 `expiredAwaitingCancel`、`paymentOpen=false`，文案“已过期，取消处理中”）；清扫器按 (hold_until,id) 升序、批上限逐单事务取消（CAS 同 id+status+hold_until），lock_timeout 跳过不占批预算使持续被锁的队首不饥饿后续，行级失败经 onResult 可观察；worker 由显式校验过的配置对象启动（无环境变量兜底），先于业务连接池结束而停止并等待在途批次。
- 占用事实只由订单表派生（无订单即 FREE），保证金资格仍走既有 SupplyGateReader seam（UNKNOWN 不放行）；占用中禁止建/存草稿、恢复上架、提交/通过新版本，暂停不受占用限制，取消后重新评估。占用账号离开默认可租列表；已获准公开的详情/精确编号/收藏可读并返回不可建单状态，普通下架同样保留只读详情。封禁/归档/失去公开资格仍隐藏；第三方订单资料不进入public DTO，订单卡继续走有归属授权的订单接口。注销义务检查纳入占用订单（双方视角）。
- 无 HTTP/BFF 付款成功注入端点。0036 增加可信收款事实及同事务 PAID/唯一 WAITING 意图；当前仅有明确 test/fake、资源和合成订单 allowlist 的进程内受控来源，未接真实支付渠道。同流水重放比较不可变绑定，冲突保留原事实并审计；不同流水重复收款、金额/币种/订单号不符及迟到款保留 REVIEW_REQUIRED。锁内 DB 时钟到期则按 TIMEOUT 取消待付，不复活旧单或抢新占用；已付不被旧取消/清扫释放。正式政策、号主声明和保证金依据reader已接入；依赖未就绪仍拒绝，配置页面、证明到期最终边界及真实渠道尚未完成，不能据隔离fixture判定完整生产交易可用。

### 管理端账号与混合来源订单读取

- 账号详情的 `publicBasis` 只表达同一次公开读取的版本、`releaseId`、资料与报价；当前私有草稿另行选择，不能补进旧对外版本。管理端查看对外版时只读；审核和图片处置须明确切到当前资料，并继续校验服务端原有对象、版本、修订及图片绑定。
- 管理订单列表和混合详情可带 `prepaymentBreakdown`：哈夫币租金和物资预付只取原单冻结租客行或原历史金额，保留资源合计/押金/总预付原语义。`COMPLETE/PARTIAL/UNKNOWN` 与合法零分开，缺依据不按当前报价、折扣或结算金额补算。
- 原生订单可带同一只读快照的 `progress`，区分开租、当前结束分类/版本、双方确认、客服复核、有效批准及已过账。按已授权页内窄ID批读，沿现有结算判定，不锁业务行或触发命令；可选关系缺失/无读取权仅在保存点恢复确认后降为未知，恢复失败和其它错误继续失败。旧单沿原来源阶段，不以缺原生记录推断未开租或未支付。
- 双方基础摘要仅在实际 `user.directory.read` 权限下对本页关联ID去重批读，输出名称、头像和脱敏手机号；订单/对象/游戏及财务字段授权仍独立，不为预览加载用户完整业务资料。
- 财务凭证的 `platformContribution` 只投影已核原生过账收据中的平台分量，仍需资金凭证读权限和订单对象范围；它不是净利润、渠道到账或当前报价。普通订单读取不据应付减号主价推算该金额，旧单/凭证不符/缺原件保持未知。

## 管理端用户目录读取

核心前缀 `/api/v1/admin/users`，Admin经同源 `/api/bff/admin/users` 适配。普通构建直接使用BFF，不启用原型开关。全部查询复用管理员会话与事务内复检；用户主体仅由稳定 `userId` 标识，不按租用/出租经历生成用户类型。

| 核心接口 | 输入/结果与权限 |
|---|---|
| GET /users | `user.directory.read`；`q`匹配稳定ID、旧ID、昵称、用户名/展示用户名；仍支持精确`userId/legacyId`和模糊`identifier`。筛选`accountStatus/source/identityStatus/ageStatus/registeredFrom/registeredTo/limit/cursor`；建档范围和排序均用canonical `user.createdAt`，时间为RFC3339，按(createdAt,id)倒序。cursor模式返回`items/total/nextCursor/limit`，total为同主体可见范围、同过滤的完整数量，不受cursor影响。游标绑定管理员、Boss状态、有效权限/游戏scope签名、全部筛选和limit，不一致409；可选页码模式见下文 |
| POST /users/lookup | 同一只读查询，另需`user.phone.lookup`。手机号仅放JSON正文，允许与上述非敏感筛选一起提交；不改变数据。GET中的phone或搜索参数中的手机号拒绝400。响应只给脱敏手机号，游标仅含查询摘要及排序键，不含原手机号 |
| GET /users/{userId} | `user.directory.read`；规范创建/更新时间、来源三态、账号/实名/年龄状态和脱敏联系方式，附与列表同口径的关系、成长礼遇和信用摘要；技术追溯另按`admin.audit.read`裁剪（Boss全量，非Boss仅本人来源操作）。不投影钱包余额/收益，不在读取时补造资格 |
| GET /users/{userId}/rental-accounts | 另需`supply.rental_account.read`，同时检查owner关联与游戏scope；当前版本、发布记录复用供给发布元组和有效版本判断，发布不等于可租资格 |
| GET /users/{userId}/orders | 另需`order.read` + 游戏/对象范围；`role=renter|owner|any`仅表示该单参与方，另有status/limit/cursor。status支持原单状态及`current`（PENDING_PAYMENT或PAID，属于过滤分组，不是新订单状态）；与目录分角色计数同口径、同新旧来源，过滤先于分页。金额来自冻结订单快照；取消后仍保留paidAt，已付/完成但时间缺失不可推断未付。没有独立供给读取权限时不返回内部accountId/展示号 |
| GET /users/{userId}/audit-events | 另需既有`admin.audit.read`；按用户对象过滤，Boss全量、非Boss仅本人操作；沿用敏感detail裁剪，不新增用户页专用IAM scope |

用户列表可选页码模式：`GET /users?page=1&pageSize=20&contextKey=…`；`page`为1–1000000的十进制正整数，`pageSize`为1–100（默认20）。响应在原字段之外返回`paginationMode:"page"/page/pageSize/contextKey`，`nextCursor=null`、`limit=pageSize`；`total`仍为当前授权及完整筛选后的数量，不能由本页条数推算。任意页可直接读取，不先遍历cursor。页码超出当前结果时返回200、空items及真实total/原请求page，不静默跳到其他页。

`contextKey`绑定主体、有效权限/游戏scope、查询条件及页容量，不绑定页码；可在首次读取任意页时省略，后续翻页带回，不匹配409。它不是授权凭证或跨请求数据快照：每次仍完整授权并重新读取同一事务内的count/本页/摘要，数据变化后total可变。客户端仅在当前查询内存保留该key，不写地址栏、tab/storage或复制链接。

页码模式与`limit/cursor`互斥；重复分页参数、无page但有pageSize/contextKey、非法/空/小数/越界值、未知页码查询字段均400。详情或其业务分区不接受这些新页码参数。未提供新分页参数时继续原cursor模式，保留既有响应形状和cursor签名。

`POST /users/lookup`同样支持页码模式，所有正文查询值仍为字符串；手机号及其分页上下文随正文发送，不进入地址栏。正文和query重复分页键拒绝400，读取另需`user.phone.lookup`；响应不包含明文手机号，公共BFF不补造计数或分页。

列表与详情保留canonical `createdAt/updatedAt/localCreatedAt`内部建档语义。未传新模式的旧调用仍以canonical创建时间返回`registeredAt`和`registeredAtSource=LOCAL`，原created排序、registeredFrom/To和游标保持兼容。

新管理UI对列表、只读手机号lookup body和详情显式传`registrationTime=ORIGINAL`：`registeredAt`为真实注册时间或null，来源为`LEGACY/LOCAL/UNKNOWN`。迁移用户只用最新成功迁移事实，核对来源、实体、providerReference、来源摘要和凭证；原日期必须是合法UTC日期，缺失/错误/未知不回退导入时间或较早事实。原生来源明确时用真实本地注册时间。基础日期属于目录权限，审计原件仍单独裁剪。该模式列表默认`sort=registered_desc`，可选`registered_asc`；未知均在最后，同时间按userId的C序降序。registeredFrom为包含下界，registeredTo为包含上界；registeredBefore为排除上界（自然日范围可传带时区的次日零时），To/Before不可并用。筛选/排序先于分页，total使用同一条件，新模式/方向/边界/授权绑定contextKey和cursor，跨上下文409；非法参数400，域权限不足403。该模式不新增本地建档时间UI维度。

原始时间模式在现有只读事务内关闭JIT并一次计算窄日期事实；保留3秒语句、500ms锁、8秒请求及2个并发读取上限，不更改全局设置或增加并行worker。目录路由使用单次租约的独立读池，现有业务10个连接名额按共享8/目录2分配，避免继承其他领域已复用的backend；该模式仍在确认ROLLBACK后退役自己的连接。其他领域及本人设置仍用共享池，生产连接建立成本需另行验证。旧`sourceCreatedAt/sourceUpdatedAt`仅审计授权后的技术追溯。管理身份状态行缺失返回UNKNOWN；其余按CANCELLED→DEACTIVATED→suspended时RESTRICTED→ACTIVE，不认识的值不默认正常。provider=legacy_mysql_restore表示旧平台用户；provider=none且无冲突来源表示未关联旧平台来源；无法判断则UNKNOWN。

`resourceSummary`为`{state:ready,count,publishedCount}`或`{state:denied,permission,reason?}`；count为名下游戏账号档案数，含各生命周期。publishedCount为ACTIVE账号的当前有效发布版本数（账号去重），复用供给域的PUBLISHED/OWNER_DIRECT或APPROVED/LEGACY_APPROVED及完整发布元组；暂停、占用、运营限制不改变发布事实，归档、草稿/待审/撤回及仅有历史只读展示不计入，也不代表当前可租。`GET /users/{userId}/rental-accounts?publication=published`返回完全同口径集合，仍按原limit/cursor分页；该筛选绑定游标，不传时保留全部档案语义。条目新增`publication.currentlyPublished`，原versionPublished保留版本状态语义。`orderSummary`为`{state:ready,currentCount,renterCurrentCount,ownerCurrentCount}`或拒绝态，计数只含PENDING_PAYMENT/PAID，聚合currentCount按参与关系去重，不能将角色之和强当聚合数。数量由各域权限和游戏范围裁剪；非Boss的SELECTED_GAMES为空时，目录和详情保持200，对受影响摘要返回denied+reason=NO_GAME_SCOPE；对应业务分区仍403 NO_GAME_SCOPE。Boss或ALL_GAMES的空gameIds不是无范围。有效范围内的零保持ready:0，无权限/失败不返回数值或内部ID，不当零。当前`lastBusinessActivity={state:not_connected,domains:[ORDER,SUPPLY]}`，不支持活动排序，不能以表更新时间或迁入时间代替事件。

列表与详情增加`membershipSummary`和`creditSummary`，按本页主体批量读取。前者仅`membership.growth.read.summary`可读：`{state:ready,asOfUtc,growth:{knowledge,sourceState,benefitsState,normalTier,effectiveTier,blackGold,grace},entitlements}`，成长/来源/未配置语义复用[会员合同](membership-growth.md)，entitlements为既有读合同的ACTIVE独立礼遇；成长UNKNOWN仍保留有效礼遇。只有detail权限不能取得全局成长摘要；无summary权限为`{state:denied,permission:membership.growth.read.summary}`。信用另需`credit.read`与原信用目标对象范围：`{state:ready,knowledge:KNOWN,score,revision}`或`{state:ready,knowledge:NOT_INITIALIZED,score:null,revision:null}`；拒绝态`{state:denied,permission:credit.read,reason?}`的reason可为NO_GAME_SCOPE或OUT_OF_SCOPE，不泄露评分或修订。读取不初始化信用、不补造100或0。目录权限不代替任何领域权限，不增加客服专用主体范围。

目录读取使用同一REPEATABLE READ READ ONLY事务保持total、页面与领域摘要一致；保留并发2、请求8秒、SQL3秒和锁500毫秒预算，不逐行发起SQL/HTTP读取成长或信用。SQL/证据读取失败返回既有安全错误，不伪造成功摘要；这不替代实际数据规模的性能验证。新增字段为兼容添加，原items/nextCursor/limit、currentCount及所有旧过滤保留；钱包、成长明细和信用事件继续使用各自已授权的独立读接口。

`user.directory.read/user.phone.lookup/supply.rental_account.read`已声明代码校验，正式数据库权限注册迁移仍由维护者分配；未登记时非Boss无法授予，不能用review.read或directory.read代替独立供给读权限。现有账号恢复入口沿用`user.account.restore`与密码/TOTP再认证，不新增写接口。上述合同与本地合成验证不等于旧数据迁移、真实PG或非空历史订单验收完成。

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
- `GET /api/v1/supply/me/favorites?limit=&cursor=`：本人分页；AVAILABLE表示资料可查看，包含有编号和明确状态的已租/待付/普通下架PublicListing，不能据此认定可租；失去公开资格时UNAVAILABLE为通用“暂不可用、收藏已保留”及null listing，不泄漏原价格、私有原因或资料。游标绑定本人及精确保存时间/ID。
- Nest用户BFF仍为`/api/bff/user/supply`，透传查询串（含`q`、既有gameId/item/skin/cursor）和只读新字段，不自行搜索、重算租期或推断媒体审核状态。Next用户BFF新增`/api/supply/*`，仅允许已实现用户接口、筛选用户Cookie，保留幂等键/受限上传Token；JSON输入64KiB、图片10MiB，输出及读取时间有界。媒体URL仅作本地路径适配，金额原样传输；认证代理共用既有Cookie及有界读取工具，认证规则不变。`GET /listings` 的`q`走查询串，路径白名单无需为搜索新增段。
- 用户调用DTO和错误恢复位于apps/web/src/lib/supply-types.ts、supply-client.ts；分组接入见[供给表单契约](supply-form-contract.md)。这部分是数据接口；用户站公开列表/详情与发布页已进入main基线，游客收藏合并与后续交易页仍按当前实现范围验收。

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
- 原生公开账号投影可带 `fullPayoutSelected: true|false|null`，来自版本化号主声明；未声明/旧资料保持未知，不直接把旧包赔flag当新条款接受。明确选中时，租客先读该game/release适用的封存条款，主动勾选后向个人确认和首次建单携带同一`fullPayoutTermsAcceptance`；结果不明时冻结原接受字段、token与key恢复。该公开flag不替代服务端资金/政策校验，未选时不传空接受对象。
- 用户与管理端上传意图共用 10 MiB（10485760 字节）上限，仅接收 PNG、JPEG、WebP。声明大小或格式错误返回 `400 INVALID_ARGUMENT`，`details[].path` 为 `size` 或 `mime`；超限信息包含声明字节数和上限。实际上传仍执行服务端字节、格式与图片安全检查，客户端前置提示不构成授权或校验替代。

### 管理用户列表的业务排序与摘要

ORIGINAL 列表新增 `active_orders_desc`、`balance_asc/desc`、`credit_asc/desc`、`renter_current_asc/desc`、`owner_current_asc/desc`、`published_asc/desc`。管理 UI 显式默认使用活跃订单数降序；同用户参与同单只计一次，权限及游戏范围沿订单摘要；无订单读权限的 UI 默认注册时间降序。API 未传 sort 的旧默认不变。所有排序在完整筛选集合上执行，最终输出保持同序，未知排后，同值按 userId C 序降序。非注册排序不提供游标，使用数字分页；无日期条件时，原始注册时间可在选页后按相同证据规则批量读取。

`identityVerified=true|false` 分别匹配当前已实名、未获得有效实名状态，不与精确 `identityStatus` 并用；底层认证状态和缺失状态仍保留。`creditMin/creditMax` 是可选的 0–100 整数闭区间，需要 credit.read 及对象范围，未初始化不能当 0 命中。`membershipTier`、`entitlement`、`creditState`、`riskState` 保持对应投影、领域读权限与 asOf 口径。筛选和排序进入 contextKey，变化后旧上下文 409。

`walletSummary` 为 ready（精确整数分、CNY、asOfUtc）、unknown 或 denied。仅 user.wallet.read、既有 finance.read 或 Boss 可读；可用余额只计 OWNER_AVAILABLE/WALLET_AVAILABLE 净额，不含提现预留等其他科目，覆盖未接纳或账务不一致保留未知。`riskFlag` 是管理端内部显示标识，不联动信用、订单或发布资格；POST `/users/{id}/risk-flag` 另需 user.risk.manage、幂等键、目录对象授权及事务审计，不能从目录读取权限推导写授权。

ORIGINAL 列表通过 `user_registration_fact` 读取最新成功迁移审计的派生事实，避免每次全量解析历史 JSON。0092 先安装审计追加触发器再回填；最新无效日期存 null，乱序追加不能覆盖更新的事实；当前身份来源及绑定仍在每次读取时核对。运行角色对投影只有 SELECT，同事务触发器负责同步，审计原件不改。审计专项离线恢复或修订若绕过追加路径，须在同一维护窗口重建并核对该投影。旧模式和按需审计原文读取保持原合同。


### 渠道退款、提现与商户余额的源码接缝

- 新提现命名空间 `/api/v1/users/me/channel-withdrawals`（用户BFF同名）提供 quote、预留、原key回执和意图读取，复用 `native-withdrawal.v1`；旧 `/withdrawals` 的 LOCAL 行为保留。新请求要求完整受信执行/通知装配，原key恢复先于当前新请求配置。默认没有正式资料时返回不可用，不根据客户端profile、银行目标或finance读权限开放出款。
- 管理订单详情可带 `admin-order-refund-summary.v1` 本地记录摘要，必须先通过订单/游戏对象授权并有资金读权限；缺新关系保持未知。存储终态只标本地状态，不替代终态原件重验、退款核销或银行到账；该摘要不授予退款命令权限。
- 管理GET `/api/{v1/admin|bff/admin}/finance/merchant-accounts/{id}` 需要现有完整资金读权限、显式逐管理员商户范围和准确资源绑定。仅复用本地 AVAILABLE/COLLECTION 摘要，两产品、最近观察与已验快照分别展示；不汇总为总资产、钱包或到账，不取钥或刷新商户。未配置商户范围返回503。
- 退款GET原URI、提现POST原始JSON字节的通知装配均需服务端显式提供受信执行对象；普通配置保持关闭。收妥ACK、本地接纳/记账与银行到账分列。渠道基础与银行资料已登记正式迁移源码，实际目标采用、安装权限及真实渠道运行仍须分别核验；源码存在不表示任一运行库已完成升级。

### 原单查询、管理租赁退款与提现上下文

- 用户 `POST /api/v1/orders/{orderId}/channel-payment-requests/query`（Nest BFF `/api/bff/user/orders/...`，Web `/api/orders/...`）正文为空对象。仅本人原单，按订单定位独立 payreq；`order-payment-request.v1` 回执含 `request:{id,orderId,state}` 与 `query.kind`，不首次派发、换商户号或返回支付参数，沿用查询间隔、预算和租约。此 POST 可在可信 E4 后调用正式付款接纳，产生本地账务、分佣、订单及群效果；普通 GET 仍仅读本地。提交未知返回 `202`、`request.state=UNKNOWN`、`query.kind=UNKNOWN_COMMIT` 并保留实际 payreq ID，按原请求恢复。Web BFF 用同一捕获 Cookie 核对期望主体；客户端核对两种 ID 后再读本地状态，不能据渠道查询文字判定到账。
- 管理 `GET/POST /api/v1/admin/orders/{orderId}/refunds`（BFF `/api/bff/admin/orders/{orderId}/refunds`）均需现有 `order.settlement.write`、管理员事务复检、游戏范围和 `readOrderTeamAccess` 的 `READY/canRead` 订单对象授权；`finance.read` 或同游戏权限均不单独授权退款。POST 要求 `Idempotency-Key` 与 `{amountCents:string,reason?:string,postingId?:string}`：金额为 CNY 正整数字符串分，只从可信 `JOINPAY/APPLIED` 原款和已到期冻结责任分配，歧义时须指定 postingId。返回 `admin-native-refund.v1` 的意图/原退款号、金额、状态、预算及责任，创建与审计同事务；GET 返回 `admin-native-refunds.v1` 的本地意图、冻结/已分配/剩余责任及最近观察。接口不直接提交渠道，本批未交付管理退款页面。
- 关闭新退款或当前 initialProfile 缺失时，既有 store 仍先处理安全的原键重放，新意图继续拒绝。首次创建的 `channel.result=NOT_SUBMITTED` 仅描述创建时；重放为 `UNKNOWN`，当前状态另由 GET 读取，银行到账保持 `UNKNOWN`。COMMIT ACK 未知返回 `503/EVIDENCE_UNAVAILABLE`，保留同键同体恢复，不换键重建。
- 用户 `GET /api/v1/users/me/channel-withdrawals/options`（Nest BFF `/api/bff/user/channel-withdrawals/options`）的 `withdrawal-request-context.v1` 兼容增加 `identity` 和 `quota`；后者含 `used/maxIntents/remaining/windowStart/windowEnd`，缺证据为 null。`canQuote/reasonCodes` 明示身份、成年、政策及 `WITHDRAWAL_QUOTA_UNKNOWN/EXHAUSTED` 等原因；报价/创建仍重核身份、次数、原目标、政策和余额，不补造证明或为消除 503 开启 PAYOUT。旧 CONTROLLED、SYNTHETIC_PROTOCOL、LOCAL_CONTROLLED、本地接纳、渠道成功与银行到账分别表达；源码接入不等于部署、PG 或真实渠道验收。
