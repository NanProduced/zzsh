# 内容管理

内容管理维护帮助文章、流程说明、用户页面固定位置图片和网站页脚配置。报价、资格、租期参数、协议接受记录及历史订单快照仍由原业务模块提供。普通图片与二维码位置只更换媒体引用，文字、链接与布局由用户端维护；页脚链接和备案为下述独立配置。账号截图、私有凭证和客服聊天图不进入运营素材选择器。

## 资源与页面

管理端将帮助中心、平台动态、固定文书、展示位和素材库作为独立工作台页面，路径分别为 `/content/help`、`/content/updates`、`/content/legal`、`/content/pages` 和 `/content/media`。原 `/content` 地址继续支持既有入口。业务协议配置沿用“规则与价目”。

| 资源 | 稳定标识 | 用户侧 |
|---|---|---|
| 帮助手册 | `guide:<slug>`，保留原24篇地址，可新增 | `/help`、`/help/<slug>`；分类、搜索、目录、相关文章 |
| 上架说明 | `PUBLISH_NOTICE`、`PUBLISH_SAFE_BOX`、`PUBLISH_RESOURCES`、`PUBLISH_TERM` | 阅读弹窗、字段帮助、租期说明 |
| 租号费用说明 | `RENTAL_FEES` | 账号详情费用提示 |
| 联系二维码 | `FOLLOW`、`MARKET_PLAYER_GROUP`、`MARKET_COOPERATION`、`ESCORT` | 关注弹层、市场联系卡、护航咨询 |
| 网站页脚 | `FOOTER` | 全站链接、备案与社交渠道；独立于工具条 `FOLLOW` |
| 海报 | `MARKET_DELTA_BANNER` | 三角洲市场横幅 |
| 首页图片位置 | `HOME_HERO`，固定 `delta/protection/accounts` | 首页桌面图与可选手机图 |
| 公告与资讯 | 原 `ANNOUNCEMENT`、`NEWS` | 独立 `/updates` 与详情；首页平台动态、相关业务提醒；保留游戏范围和历史 |

固定位置使用 `placement:<标识>`。品牌标识、会员卡面、联系卡背景和流程背景继续随设计代码维护。无有效二维码时不生成替代码，站内客服继续走 IM。物品媒体沿原目录 API 和审核体系消费，保留冻结名称、单位、数量与报价，未匹配或撤权时使用现有设计图标。

页脚的帮助/支持链接、版权主体、备案编号、可选营业执照链接、投诉入口及社交链接/二维码由平台内容权限维护并按资源版本发布。链接只接受站内绝对路径或完整 HTTPS 地址；ICP备案固定链接至工信部，公安备案地址由14位编号生成。客服、平台动态和现行服务/隐私协议入口固定保留。初始社交渠道为空，ICP备案与公安备案使用已核实的默认值；已发布的空配置或撤回不会复活默认值。页面首次读取失败时使用内置配置，已有本次会话成功读取的页脚在后续暂时失败时保留。二维码沿用内容媒体审核及公开资格，撤权后不显示。旧资源列表不返回新页脚类型，Web 全局内容提供器通过现有资源详情端点单独读取；新版 Admin 平台列表显式传 `includeFooter=1`，其分页游标绑定该选项，兼容旧版客户端。

## 正文与共享边界

`guide`、`notice` 的正文使用 `{format:'plate',schemaVersion:1,document,mediaIds,anchorAliases?}`。公告与资讯的版本 payload 是 Plate 文档，草稿写请求通过 `document` 提交。API 校验对应文档类型，重新提取媒体、纯文本和章节目录。`anchorAliases` 保留旧锚点到新章节的映射。

默认帮助文章由确认清单校验后入库，保留原地址。帮助中心公开读取只取已发布快照。目录以服务端帮助树为准，文章移动保留原 slug。空分组和只含草稿的分组不进入公开目录。

## 平台动态与帮助首页

帮助中心只收操作、费用、安全与常见问题；永久指南沿对应帮助分类维护。平台动态独立于帮助中心，不新增顶部一级导航；页脚常驻入口。原 `/help/updates` 和文章地址重定向至 `/updates` 与同 ID 详情。帮助与动态首屏插画是固定品牌设计资源，随项目发布，正文与检索仍来自内容 API。

`content_version.update_settings` 与标题、摘要、正文、封面一起构成不可变发布快照，保存草稿不改线上版本。正文插图引用由 API 解析并重新核验。`visibleFrom` 控制定时可见，未到时间的内容不进入列表或详情。

- `homePopup` 默认关闭，仅平台公告可启用，发布须有平台发布权限。首页候选只取已发布、已到可见时间且未过有效期的最新一条；浏览器按公告 ID 与发布版本在本地记住关闭状态，存储不可用时仅在当前页面内记住。常规公开列表与详情不增加此字段，`surface=home-popup` 候选投影才返回该字段；详情按不可变版本核对。旧管理端无法解析已启用的新字段，启用前须先升级管理端。
- `tickerEnabled/tickerFrom/tickerUntil` 控制首页曝光；启用须有结束时间。游戏资讯的首页曝光也要求 `content.platform.publish`，游戏发布权限不能扩大到首页。
- `pinned/pinnedUntil` 仅限公告，独立于轮播；同一时刻最多3条有效置顶，发布事务用共享锁约束并发。列表默认发布时间倒序，有效置顶在前。
- `validUntil` 过期后同时退出曝光、置顶和业务提醒，正文仍留历史列表；只撤回才停止公共读取。接口返回服务端 `asOf`，前端据此更新时效。
- `noticeKind=maintenance|rule-change` 要求 `effectiveAt`、`impact` 和至少一项 `surfaces`（`publish/rental/orders`）；业务页按范围独立读取，不依赖首页轮播。提示说明不改变报价或交易规则真值。
- 列表分类、页码放 URL，详情返回携带校验后的原列表地址；会话内保存滚动位置。轮播支持暂停，悬停或聚焦时暂停；无可播内容时整块轮播不显示。

正文的权威来源是版本 payload。搜索和预览从同一份文档派生，公告/资讯的 `body` 是纯文本投影，维持原 20000 字节上限。Plate 编辑器按帮助、平台动态、紧凑说明、固定文书或内部文档的预设提供块级能力。未知、未核验和撤权素材不能发布。

| 共享入口 | 职责 |
|---|---|
| `@zzsh/content` | 稳定资源类型、位置、同步结构校验与媒体清单读取 |
| `@zzsh/content/plate` | Plate 校验、媒体与纯文本提取、目录与摘要 |
| `@zzsh/ui/plate-document`、`@zzsh/ui/plate-document.css` | Admin 预览与 Web 共用的 Plate 只读正文及排版 |

Plate 编辑器仅在管理编辑面加载。用户站以共享只读组件渲染正文，页面导航和数据读取留在各端。表格在自身容器滚动，图片保持比例。图片可保存替代文字和图注，两者分别渲染，各限 500 字符。

单份完整资源 JSON 的 UTF-8 上限为 200000 字节，标题 200 字符、摘要 500 字符，媒体清单最多 300 项。紧凑说明发布时限 1200 字符。完整表格、代码和插图放帮助手册。

## 版本、权限与恢复

复用 `zzsh_content.content_item/content_version`，类型新增 `RESOURCE`、唯一 `resource_key` 与版本 `payload`；公共 envelope 仍为 `content-resource.v1`。发布版本冻结正文格式、元数据和媒体引用，不能原地修改。

- 保存草稿不替换公开结果。帮助和场景说明从已初始化或后来发布的版本读取。固定展示位仍按各位置的默认策略呈现。
- 资源的 `expectedRevision` 是内容项 revision，保存、创建后续草稿、显式恢复、发布和撤回均推进它。原公告/资讯的草稿和发布仍使用版本 revision，撤回沿内容项 revision。
- 公共资源返回 `version:{id,sequence,publishedAt}|null`、同版 `payload` 和资格过滤后的媒体 URL；不返回草稿、操作者、内部审核信息或私有存储键。未发布内置内容的 version 为 null。页面更新日期优先取发布事实，冻结 payload 的日期不被读取过程改写。
- 历史详情要求同对象及同范围读取权限。显式恢复先以 CAS 将当前已保存草稿归档为 `SUPERSEDED`，再复制所选快照建立新草稿。
- `content.help.read` 允许读已发布帮助。运营通过 `content.help.publish` 发布、撤回和恢复帮助文章，`content.updates.publish` 管平台公告与资讯的发布及下线。游戏资讯和首页曝光继续按各自业务权限判定。
- 帮助文章删除进入 30 天回收站，旧地址显示下线提示。恢复时以删除前的发布状态恢复线上正文，已有草稿继续保留。
- 编辑、发布、范围和对象授权均在服务端执行。写入、幂等回执和审计同事务；发布锁定所引用媒体并重新解析当前草稿，诊断旧指纹不能替代本次校验。
- 请求结果未知时固定原操作、对象、key、指纹及草稿版本，先核对回执并回读。无回执仍是未知状态，不能换新键当作新操作发布；成功回执重放不会再创建版本。

固定图片位置只走媒体草稿保存入口，通用 payload 写入口不能改 contact/banner/carousel，首次创建也不能注入固定资源文案。页脚是独立的结构化资源，使用通用草稿保存入口；历史保留旧字段用于兼容，不作为普通固定图片位置的用户页面文案配置源。

HOME_HERO 新草稿按代码的3个位置建立，只继承相同位置 ID 的媒体；旧随机 ID 不猜映射，原记录与未映射媒体仍保留在历史。旧位置草稿可以显式恢复为固定模板后再更换图片，不能添加、删除或重排位置。资源草稿建立后旧轮播写入口返回冲突；首次发布前原公共 `/carousel` 读取仍工作，之后兼容返回当前获准展示的图片及可选手机图。

## API 与读取

公共入口 `/api/v1/content`，Web 经 `/api/content` 代理；管理入口 `/api/bff/admin/content`。BFF 只适配传输，不直连业务库或重做权限判断。

| 方法 / 路径（相对管理入口） | 请求与含义 |
|---|---|
| `GET /resources?scope=platform&kind=guide&limit=5` | 资源列表；返回 `{items,nextCursor,limit}`，游标绑定范围、过滤和 limit；game 范围另传 gameId |
| `GET /resources/:key` | 当前发布、草稿、最近版本元数据与默认基线 |
| `GET /help-tree` | 当前可读的分组和文章，包括标题、图标、层级、顺序与发布状态；`withdrawn` 标识有撤回版本，`publicOrigin` 为用户站公开 Origin，供管理端打开已发布文章 |
| `POST /help-tree/articles` | `{parentId,title,slug?}`，同一事务创建文章草稿与目录节点 |
| `POST /help-tree/folders`、`PATCH /help-tree/:id`、`POST /help-tree/:id/move` | 创建分组、修改分组及图标、移动或排序节点 |
| `DELETE /help-tree/:id`、`GET /help-tree/trash`、`POST /help-tree/trash/:batchId/restore` | 删除入回收站、读取和恢复 |
| `GET /resources/:key/versions/:id` | `{version,media}`，原格式完整快照及当前安全媒体 URL |
| `POST /resources/:key/draft` | 无现存草稿时从内置内容、当前版本或 `sourceVersionId` 建草稿；新手册可提供 payload 及 gameId，内置范围不可改 |
| `PUT /resources/:key/draft` | `{versionId,expectedRevision,payload}`，保存手册/流程正文草稿 |
| `DELETE /resources/:key/draft` | `{versionId,expectedRevision}`，仅丢弃已有线上版本的手册草稿。删除该工作副本并推进并发修订；保留线上快照和其他历史 |
| `PUT /resources/:key/media-draft` | `{versionId,expectedRevision,media}`，只更换固定位置图片 |
| `POST /resources/:key/restore` | `{sourceVersionId,expectedRevision}`，保留当前已保存草稿后恢复新稿 |
| `POST /resources/:key/publish`、`/withdraw` | `{versionId,expectedRevision}`，发布或撤回 |
| `GET /operation-result` | 原 `Idempotency-Key` header 加 `operation/resourceId/fingerprint`；新游戏手册另带原 gameId |
| `GET /storage`、`GET /storage/check` | 存储配置状态与一张已获准公开的样本读取，不上传测试对象 |

媒体字段为闭集：contact 仅 `{qrMediaId:string|null}`；banner 仅 `{mediaId:string|null,mobileMediaId:string|null}`；carousel 仅 `{slides:[{id,mediaId:string|null,mobileMediaId:string|null}]}`，位置集合及顺序必须与固定草稿相同。夹带标题、说明、链接、启用、排序、排期等字段返回400。清空图片不暗改历史 enabled；页面按有效媒体引用决定显示。

管理端「图片素材」集中管理供文章与用户站引用的公开图片。「用户站展示」按页面位置更换图片。选图窗口可上传新图，或在浏览器调整尺寸和取景后上传副本；原素材及其引用不变。副本仍走同一上传与审核权限，页面图片只有发布草稿后才会更新。

写入使用 `Idempotency-Key`；资源保存和恢复返回更新后的 `ResourceDetail`。回执 operation 包含 `content.resource.draft.create`、`content.resource.draft.save`、`content.resource.media-draft.save`、`content.resource.draft.restore`、`content.resource.draft.discard`、`content.resource.publish`、`content.resource.withdraw`。

公共 `/resources` 与详情沿用同一资源标识，只给公开结果。资源列表默认及上限均为5，请求6/10返回400；旧 `/items` 分页不变。Web BFF JSON 响应上限仍为2MiB，不通过扩大全站响应限额解决资源分页。

公共 `/help-tree` 给出已发布文章及其分组。用户站分类列表、目录和上下篇使用同一顺序。`/help?category=…` 可浏览该分组的已发布文章；旧文章 slug 与正文锚点继续可用。

## 内部文档和固定文书

内部文档使用独立管理路径 `/docs`，文档深链在同一工作台标签打开。编辑、读取和评论依服务端对象权限执行。客服可在只读正文选区评论，讨论写入及幂等重放同时要求文档读取和评论权限。

固定文书经 `/api/bff/admin/legal-documents` 管理草稿、预览、版本对比和审批。场景说明随固定文书审批发布。封存版和用户接受记录保留各自的版本与摘要。v2 新建订单从当前已生效的提前结算告知取得版本、正文和摘要并冻结进快照，既有订单继续读取各自的快照。

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

Boss 可在独立“系统配置”（`/system`）查看实际媒体目标与只读样本完整性检查；内容运营页的原状态接口保持兼容。部署及新环境对象准备见[媒体存储](../operations/media-storage.md)，切换目标不自动迁移历史对象。

`configured` 只表示适配器已装配；只读检查分别返回未检查、无公开样本、读取通过或读取失败。样本读取不证明上传、审核、桶权限、CDN 或生产链路通过。运营图片进对象存储，数据库保存引用；品牌和固定设计资源留项目中。原图与衍生图共用后端时不得把整个桶/前缀开放为公共 CDN；当前衍生图经 API 检查资格，边缘代理必须重验证，私有路由不得缓存。生产直链、撤权失效、真实 OSS 上传、真实相机扫码与原生客户端渲染需要分别验收。

## 部署与扩展

Plate 迁移接在云信 `0197`、OSS `0198–0200` 之后。按 journal 依次执行 `0201` 内部文档、`0202` 权限目录、`0203` 角色授权、`0204` 帮助树、`0205` 文档评论、`0206` 协议条款、`0207` 帮助树补全、`0208` 草稿丢弃。部署顺序为数据库迁移、API、Admin、Web。迁移器校验既有版本账前缀，预览库出现分叉时保留原库供核对。旧帮助、页面说明和动态的版本原文、编号与发布状态保留，API 读取时转换为 Plate 展示，后续保存和发布按 Plate 规则校验。

`0111_platform_updates.sql` 的已执行SHA-256为 `99c1cd0acad4223fc9bcceacc4cb8348cfb452984ea5af091837a14fa55501f1`，使用CRLF；根 `.gitattributes` 的精确文件例外保留原字节。不得由Git换行规范化或SQL格式化改变其迁移校验值。

首装完成结构迁移并激活首位 Boss 后，在 API 的 `APP_PROFILE=migration` 配置下执行 `npm run migrate:business -w @zzsh/api -- --bootstrap-content=<Boss管理员ID>`。命令先校验迁移身份和版本账，再在同一事务核对确认清单、初始化 31 条内容及 3 份协议条款。相同种子可重复执行，已有运营内容发生冲突则整笔初始化回滚。已有环境通过协议条款发布审批补齐缺失的生效文书。缺少生效的提前结算告知时，v2 新建单返回 503，订单、接受记录和幂等回执均不写入。

Web 服务器设置 `ZZSH_API_ORIGIN` 与 `ZZSH_WEB_ORIGIN`，独立环境 Origin 必须与 API 配置一致；生产不使用本地缺省值。新增手册复用已有正文格式；新增固定位置须登记标识、约束、默认呈现与消费代码，不能只在后台新增一个无用户端绑定的资源。新增语法必须同时补齐 API 校验、编辑预览、各消费端渲染和兼容规则。

内容回归与浏览器保留使用登记的本地资源集 `cms_formal`；旧回归/UI 库继续按主资源登记保留，不接管或重置。可选 `CONTENT_TEST_FIXTURE_OUTPUT` 仅允许在批准的任务私有目录导出 `formal-ui-fixture.json`，保存本套件既有 Boss 的最终登录材料、原 auth secret/Origin 和本次媒体目录，不能输出凭据或另建浏览器 Boss。`CONTENT_TEST_USER_ORIGIN/ADMIN_ORIGIN/API_ORIGIN` 仅接收 loopback origin，默认3100/3101/3102。导出目标及 `formal-ui-media` 已存在或出现 `fixture-ui-retained.json` 后，cms_formal 回归重置在 DB setup 前拒绝；后续快速登录沿[本地测试认证](../local-test-auth.md)，不重置身份或重新随机生成密钥。此支持不改变生产认证及第三方服务验收边界。
