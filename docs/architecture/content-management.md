# 内容管理

内容管理维护帮助文章、流程说明和用户页面固定位置的图片。报价、资格、租期参数、协议接受记录及历史订单快照仍由原业务模块提供。图片与二维码只更换媒体引用；标题、说明、联系标识、alt、按钮文字、链接与页面布局由用户端代码维护。账号截图、私有凭证和客服聊天图不进入运营素材选择器。

## 资源与页面

管理端 `/content` 分为规则与手册、页面展示、公告与资讯、运营素材。业务协议配置入口沿用原“规则与价目”，不复制业务规则。

| 资源 | 稳定标识 | 用户侧 |
|---|---|---|
| 帮助手册 | `guide:<slug>`，保留原24篇地址，可新增 | `/help`、`/help/<slug>`；分类、搜索、目录、相关文章 |
| 上架说明 | `PUBLISH_NOTICE`、`PUBLISH_SAFE_BOX`、`PUBLISH_RESOURCES`、`PUBLISH_TERM` | 阅读弹窗、字段帮助、租期说明 |
| 租号说明 | `RENTAL_PROCESS`、`RENTAL_FEES` | 账号详情流程、费用提示 |
| 联系二维码 | `FOLLOW`、`MARKET_PLAYER_GROUP`、`MARKET_COOPERATION`、`ESCORT` | 关注弹层、市场联系卡、护航咨询 |
| 海报 | `MARKET_DELTA_BANNER` | 三角洲市场横幅 |
| 首页图片位置 | `HOME_HERO`，固定 `delta/protection/accounts` | 首页桌面图与可选手机图 |
| 公告与资讯 | 原 `ANNOUNCEMENT`、`NEWS` | 独立 `/updates` 与详情；首页平台动态、相关业务提醒；保留游戏范围和历史 |

固定位置使用 `placement:<标识>`。品牌标识、会员卡面、联系卡背景和流程背景继续随设计代码维护。无有效二维码时不生成替代码，站内客服继续走 IM。物品媒体沿原目录 API 和审核体系消费，保留冻结名称、单位、数量与报价，未匹配或撤权时使用现有设计图标。

## 正文与共享边界

`guide`、`notice` 的正文采用互斥格式，其余业务元数据沿原契约：

- 旧 blocks：`{sections}`，或显式 `{format:'blocks',schemaVersion:1,sections}`。
- Markdown：`{format:'markdown',schemaVersion:1,markdown,mediaIds,anchorAliases?}`；不能同时携带 `sections`。`mediaIds` 由 API 保存时从同一 AST 重算，客户端清单不作为真值。`anchorAliases` 为旧章节锚点到新标题 ID 的兼容映射。

内置24篇帮助正文以 Markdown 提供，地址和业务含义保持。数据库已有 blocks 历史仍按原格式读取，不批量改写；旧公告/资讯按默认 `plain` 格式逐字阅读，新文章显式选择 `markdown`，不把旧正文无标记重解释成 Markdown。

## 平台动态与帮助首页

帮助中心只收操作、费用、安全与常见问题；永久指南沿对应帮助分类维护。平台动态独立于帮助中心，不新增顶部一级导航；页脚常驻入口。原 `/help/updates` 和文章地址重定向至 `/updates` 与同 ID 详情。帮助与动态首屏插画是固定品牌设计资源，随项目发布，正文与检索仍来自内容 API。

`content_version.update_settings` 与标题、摘要、正文、封面一起构成不可变发布快照，保存草稿不改线上版本。正文插图引用由 API 解析并重新核验；旧纯文本可显式转换，新稿与历史稿始终按各自格式读取。

- `tickerEnabled/tickerFrom/tickerUntil` 控制首页曝光；启用须有结束时间。游戏资讯的首页曝光也要求 `content.platform.publish`，游戏发布权限不能扩大到首页。
- `pinned/pinnedUntil` 仅限公告，独立于轮播；同一时刻最多3条有效置顶，发布事务用共享锁约束并发。列表默认发布时间倒序，有效置顶在前。
- `validUntil` 过期后同时退出曝光、置顶和业务提醒，正文仍留历史列表；只撤回才停止公共读取。接口返回服务端 `asOf`，前端据此更新时效。
- `noticeKind=maintenance|rule-change` 要求 `effectiveAt`、`impact` 和至少一项 `surfaces`（`publish/rental/orders`）；业务页按范围独立读取，不依赖首页轮播。提示说明不改变报价或交易规则真值。
- 列表分类、页码放 URL，详情返回携带校验后的原列表地址；会话内保存滚动位置。轮播支持暂停，悬停或聚焦时暂停；无可播内容只保留查看全部。

RESOURCE 的权威正文保存在版本 payload；全文搜索文本和预览从 payload/AST 派生，资源接口不把长文复制或截断到旧20000字节 `body` 列，也不放宽公告/资讯的正文上限。恢复复制源快照的兼容字段，已有历史 `body` 不被改写或重新解释成 Markdown。

新正文按整篇 Markdown 编辑，支持 CommonMark/GFM 的标题、段落、列表、引用、表格、链接及平台插图。作者不维护章节 ID 和逐块表单。原始 HTML/JSX、MDX 模块、脚本、样式、iframe 和未支持指令不执行；含阻塞结构的原文可留在草稿，发布时必须转换或处理并重验。引用式链接/图片与内联形式同样检查，代码示例不当作真实媒体或模块。未知、未核验和撤权素材不能发布；诊断包含行、列和处理说明。

| 共享入口 | 职责 |
|---|---|
| `@zzsh/content` | 稳定资源类型、位置、同步结构校验与媒体清单读取 |
| `@zzsh/content/markdown` | 纯 AST 分析、目录与旧正文显式转换，不含 React/Next/Nest |
| `@zzsh/content/markdown/policy` | 渲染所需的标题 ID、链接和媒体引用规则 |
| `@zzsh/content/api-markdown` | API 专用 CJS 原生动态 ESM 桥接，提供 `inspectContentMarkdown`、`convertContentDocument` |
| `@zzsh/ui/content-markdown`、`@zzsh/ui/content-markdown.css` | Admin 预览与 Web 共用的 `MarkdownDocument({markdown,mediaUrls?,compact?})` 和 Typeset 排版 |
| `@zzsh/ui/content-document` | 旧 blocks 读取及通用图片组件，保留兼容 |

UIW 仅在管理编辑面加载，阅读外壳留在用户应用；共享 renderer 不带编辑器、文档导航、Next 服务端读取或 API 桥接。目录和正文共用 `content-` 命名空间及全篇去重规则。表格在自身容器滚动，图片保持比例；正文排版不接管全站布局和控件。

单份完整资源 JSON 的 UTF-8 上限为200000字节，标题200字符、摘要500字符，媒体清单最多300项。旧 blocks 保留50章节、300内容块、表格12列/100行等结构约束。紧凑说明发布时限1200字符且限制为适合小容器的文字、列表和引用；完整表格、代码和插图放帮助手册。旧公告/资讯沿原20000字节正文限制。

## 版本、权限与恢复

复用 `zzsh_content.content_item/content_version`，类型新增 `RESOURCE`、唯一 `resource_key` 与版本 `payload`；公共 envelope 仍为 `content-resource.v1`。发布版本冻结正文格式、元数据和媒体引用，不能原地修改。

- 尚未首次发布的内置资源使用代码默认内容，保存草稿不替换公开结果。首次发布后以发布快照为公开来源；撤回不复活旧默认手册。自定义手册发布前不可公开读取。
- 资源的 `expectedRevision` 是内容项 revision，保存、创建后续草稿、显式恢复、发布和撤回均推进它。原公告/资讯的草稿和发布仍使用版本 revision，撤回沿内容项 revision。
- 公共资源返回 `version:{id,sequence,publishedAt}|null`、同版 `payload` 和资格过滤后的媒体 URL；不返回草稿、操作者、内部审核信息或私有存储键。未发布内置内容的 version 为 null。页面更新日期优先取发布事实，冻结 payload 的日期不被读取过程改写。
- 历史详情要求同对象及同范围读取权限。显式恢复先以 CAS 将当前已保存草稿归档为 `SUPERSEDED`，再复制所选快照建立新草稿，不删除原稿、不直接转换旧 blocks；也可显式复制当前已保存草稿。原格式转换为 Markdown 是另一项需确认、校验结构及可见文字的操作，不以字符串包含判断无损。
- 编辑、发布、范围和对象授权均在服务端执行。写入、幂等回执和审计同事务；发布锁定所引用媒体并重新解析当前草稿，诊断旧指纹不能替代本次校验。
- 请求结果未知时固定原操作、对象、key、指纹及草稿版本，先核对回执并回读。无回执仍是未知状态，不能换新键当作新操作发布；成功回执重放不会再创建版本。

固定图片位置只走媒体草稿保存入口，通用 payload 写入口不能改 contact/banner/carousel，首次创建也不能注入固定资源文案。历史保留旧字段用于兼容，不作为用户页面文案配置源。

HOME_HERO 新草稿按代码的3个位置建立，只继承相同位置 ID 的媒体；旧随机 ID 不猜映射，原记录与未映射媒体仍保留在历史。旧位置草稿可以显式恢复为固定模板后再更换图片，不能添加、删除或重排位置。资源草稿建立后旧轮播写入口返回冲突；首次发布前原公共 `/carousel` 读取仍工作，之后兼容返回当前获准展示的图片及可选手机图。

## API 与读取

公共入口 `/api/v1/content`，Web 经 `/api/content` 代理；管理入口 `/api/bff/admin/content`。BFF 只适配传输，不直连业务库或重做权限判断。

| 方法 / 路径（相对管理入口） | 请求与含义 |
|---|---|
| `GET /resources?scope=platform&kind=guide&limit=5` | 资源列表；返回 `{items,nextCursor,limit}`，游标绑定范围、过滤和 limit；game 范围另传 gameId |
| `GET /resources/:key` | 当前发布、草稿、最近版本元数据与默认基线 |
| `GET /resources/:key/versions/:id` | `{version,media}`，原格式完整快照及当前安全媒体 URL |
| `POST /resources/:key/draft` | 无现存草稿时从内置内容、当前版本或 `sourceVersionId` 建草稿；新手册可提供 payload 及 gameId，内置范围不可改 |
| `PUT /resources/:key/draft` | `{versionId,expectedRevision,payload}`，保存手册/流程正文草稿 |
| `PUT /resources/:key/media-draft` | `{versionId,expectedRevision,media}`，只更换固定位置图片 |
| `POST /resources/:key/restore` | `{sourceVersionId,expectedRevision}`，保留当前已保存草稿后恢复新稿 |
| `POST /resources/:key/publish`、`/withdraw` | `{versionId,expectedRevision}`，发布或撤回 |
| `GET /operation-result` | 原 `Idempotency-Key` header 加 `operation/resourceId/fingerprint`；新游戏手册另带原 gameId |
| `GET /storage`、`GET /storage/check` | 存储配置状态与一张已获准公开的样本读取，不上传测试对象 |

媒体字段为闭集：contact 仅 `{qrMediaId:string|null}`；banner 仅 `{mediaId:string|null,mobileMediaId:string|null}`；carousel 仅 `{slides:[{id,mediaId:string|null,mobileMediaId:string|null}]}`，位置集合及顺序必须与固定草稿相同。夹带标题、说明、链接、启用、排序、排期等字段返回400。清空图片不暗改历史 enabled；页面按有效媒体引用决定显示。

写入使用 `Idempotency-Key`；资源保存和恢复返回更新后的 `ResourceDetail`。回执 operation 包含 `content.resource.draft.create`、`content.resource.draft.save`、`content.resource.media-draft.save`、`content.resource.draft.restore`、`content.resource.publish`、`content.resource.withdraw`。

公共 `/resources` 与详情沿用同一资源标识，只给公开结果。资源列表默认及上限均为5，请求6/10返回400；旧 `/items` 分页不变。Web BFF JSON 响应上限仍为2MiB，不通过扩大全站响应限额解决资源分页。

正文读取采用运行时/no-store，搜索匹配当前公开帮助内容，不新增独立索引服务或刷新队列。读取失败与无结果分开呈现；发布不依赖重新构建用户站。移动端经自身 BFF 消费同一格式/版本契约，未知格式不能静默省略关键规则。

## 图片与存储

上传沿原媒体机制：JPEG/PNG/WebP、单帧、≤10MiB、单边≤8192、≤4000万像素，完整解码校验字节与类型；公开衍生图按 EXIF 转正并去除元数据，私有原始证据字节及哈希保持不变。

| 位置 | 发布时约束 | 制作建议 |
|---|---|---|
| 联系二维码 | 至少256×256，1:1，容差2% | 512×512 PNG，保留完整白边，核对实际扫描目的地 |
| 市场海报 | 至少810×270，3:1，容差5% | 1620×540，重要内容保留安全区 |
| 首页图片 | 至少920×400，2.3:1，容差5% | 1840×800，按实际手机容器适配 |
| 手册插图、公告封面 | 通用上传限制 | 保持原比例，重要规则同时提供正文 |

位置尺寸约束放在发布入口，不施加于账号凭证等其他用途。引用必须是平台 `CONTENT_MEDIA`，发布时须审核通过、允许公开并存在衍生图；历史引用不免除当前资格检查。公共读取重新核资格，撤权 URL 返回 null；手机图不可用时回退有效桌面图，无运营图时使用代码默认呈现。尺寸通过不代表静区完整、扫码成功或目的地真实。

开发默认 `MEDIA_STORAGE=local`。服务器使用现有 OSS 适配器时设置 `MEDIA_STORAGE=oss`、`OSS_BUCKET`、`OSS_REGION`、`OSS_ENDPOINT`、`OSS_OBJECT_PREFIX`；凭据通过服务器环境提供 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`，可选 `ALIBABA_CLOUD_SECURITY_TOKEN`。模板仅占位值，管理端不收集、展示或修改凭据。

`configured` 只表示适配器已装配；只读检查分别返回未检查、无公开样本、读取通过或读取失败。样本读取不证明上传、审核、桶权限、CDN 或生产链路通过。运营图片进对象存储，数据库保存引用；品牌和固定设计资源留项目中。原图与衍生图共用后端时不得把整个桶/前缀开放为公共 CDN；当前衍生图经 API 检查资格，边缘代理必须重验证，私有路由不得缓存。生产直链、撤权失效、真实 OSS 上传、真实相机扫码与原生客户端渲染需要分别验收。

## 部署与扩展

正式追加迁移为 `0109_content_management`、`0110_content_draft_history_shape`、`0111_platform_updates`。0110 仅允许 `SUPERSEDED + payload非空 + published_at/published_by_admin_id双null` 保存未发布资源草稿历史；0111 增加版本化展示设置及非草稿不可修改约束。它们由来源分支的0105/0106/0107按原SQL字节接入，使用新的追加序号及递增when；保留既有主线前缀。来源预览库仍是分叉链，禁止直接运行合并journal，接纳与保留必须另行核定。部署顺序为迁移、API、Admin、Web；新 API 可读后再切换页面。

`0111_platform_updates.sql` 的已执行SHA-256为 `99c1cd0acad4223fc9bcceacc4cb8348cfb452984ea5af091837a14fa55501f1`，使用CRLF；根 `.gitattributes` 的精确文件例外保留原字节。不得由Git换行规范化或SQL格式化改变其迁移校验值。

Web 服务器设置 `ZZSH_API_ORIGIN` 与 `ZZSH_WEB_ORIGIN`，独立环境 Origin 必须与 API 配置一致；生产不使用本地缺省值。新增手册复用已有正文格式；新增固定位置须登记标识、约束、默认呈现与消费代码，不能只在后台新增一个无用户端绑定的资源。新增语法必须同时补齐 API 校验、编辑预览、各消费端渲染和兼容规则。

内容回归与浏览器保留使用登记的本地资源集 `cms_formal`；旧回归/UI 库继续按主资源登记保留，不接管或重置。可选 `CONTENT_TEST_FIXTURE_OUTPUT` 仅允许在批准的任务私有目录导出 `formal-ui-fixture.json`，保存本套件既有 Boss 的最终登录材料、原 auth secret/Origin 和本次媒体目录，不能输出凭据或另建浏览器 Boss。`CONTENT_TEST_USER_ORIGIN/ADMIN_ORIGIN/API_ORIGIN` 仅接收 loopback origin，默认3100/3101/3102。导出目标及 `formal-ui-media` 已存在或出现 `fixture-ui-retained.json` 后，cms_formal 回归重置在 DB setup 前拒绝；后续快速登录沿[本地测试认证](../local-test-auth.md)，不重置身份或重新随机生成密钥。此支持不改变生产认证及第三方服务验收边界。
