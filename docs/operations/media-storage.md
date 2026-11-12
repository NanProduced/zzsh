# 媒体存储与环境准备

图片媒体由 API 的 `MediaStorage` 承接，服务端通过 `MEDIA_STORAGE=local|oss` 选择一个后端。账号展示/审核图片、保证金图片证据、游戏/皮肤/枪械/物资目录图和平台内容素材共用该后端；原图和清理元数据后的公开衍生图分别按 SHA256 保存。仅支持 JPEG、PNG、WebP，单张最多 10 MiB。固定品牌、字体和页面插画随应用部署；IM 附件走其独立链路，协议正文、资金导出和数据库备份不属于本媒体服务。

## 账号图片直传和私有衍生图

`OSS_ACCOUNT_MEDIA_DIRECT=1` 启用账号图片的 `OSS_POST` 上传能力，默认关闭。API 继续支持原有中继上传，上传意图只允许使用创建时选择的方式。Web 普通展示截图尽量转为长边不超过 1920 px 的 WebP，处罚截图和审核证据保留所选文件的原始字节。其他业务媒体沿用各自入口。

- `GET /api/v1/supply/games/:gameId/publishing-options` 在启用时返回 `accountMediaTransport: "OSS_POST"`。`POST /api/v1/supply/media/upload-intents` 接受 `transport: "OSS_POST"`，验证账号归属和声明后返回限时 `ossUpload` 表单，绑定 `<prefix>private/account-upload/<intentId>`、实际声明大小和 MIME。客户端按返回字段构造 multipart 表单，最后附文件，向 OSS HTTPS 域名 POST。有效期沿用上传意图的 10 分钟。
- `POST /api/v1/supply/media/uploads/:intentId/complete` 沿用写幂等键，提交 `{ uploadToken, contentHash }`，其中 `contentHash` 是实际上传文件的十六进制 SHA-256。API 按当前身份与账号权限从 OSS 读取暂存字节，完整解码并重新核对大小、MIME 和 SHA-256。原图及中继兼容衍生图沿用现有内容寻址键。若 `MEDIA_STORAGE=oss` 使用同地域内网 Endpoint，这些校验读写发生在内网，用户上传流量直达 OSS。
- 新直传的展示图由 OSS 原生缩放并应用当前水印规则，同桶转存到 `<prefix>private/account-variants/<生成ID>/{640,1920}.webp`。API 读回核对格式、尺寸、解码和 SHA-256，与媒体资产一并记录成功的两个规格。原有中继图片路径仍使用原兼容衍生图。两个新规格保持私有，尚未接入公开 CDN。
- `/system` 的「账号图片水印」由 Boss 管理，支持启用、Logo、角落、相对大小、不透明度和边距。Logo 选择已审核公开的 PNG 运营素材。OSS 可用时，可输入符合展示条件的账号素材编号，通过短签名预览两个规格的实际 OSS 处理结果。规则修改应用于以后生成的变体。
- 用户原图 `/api/v1/supply/media/:id/access` 和管理端 `/api/v1/admin/supply/media/:id/content` 接受 `?delivery=direct`。通过当前会话、业务对象及角色权限校验后，账号原图返回 307 和仅该对象的 120 秒 OSS GET 签名。未选择直读的调用方仍收到现有二进制响应。签名过期前仍可用，权限变化会阻止再次签发。

部署时先应用账号媒体业务迁移，并给 API 与用户 Web BFF 配置同一个 `OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN`。该域名应为独立的 OSS HTTPS CNAME，并避免共享应用身份 Cookie。Bucket 保持私有并阻止公共访问，CORS 仅允许所需客户端来源和直传 POST。为暂存前缀配置过期清理，启用 OSS 对象版本控制时同时处理历史版本。真实 OSS 表单、私有签名、转存、预览和客户端域名限制均需在隔离资源验证。 [OSS POST V4 签名](https://help.aliyun.com/en/oss/developer-reference/signature-version-4-recommend) · [转存处理结果](https://help.aliyun.com/zh/oss/user-guide/save-processed-images) · [OSS CNAME](https://help.aliyun.com/zh/oss/user-guide/access-buckets-via-custom-domain-names)

## 用户侧公开图片的目标架构（尚未实施）

公开展示图片计划由浏览器及其他客户端直接从 CDN 读取。当前公开分发仍经 API 中继，账号直传须显式启用并单独验收。

- 服务端先核对身份、上传用途和归属，签发限定对象、大小、有效期的短期上传授权；客户端不得持有长期凭据。上传的原图先放私有待处理区域，服务端验证实际字节、解码及大小等限制后生成安全衍生图，再按业务发布状态开放。跨端客户端分别接入并验证；不以客户端声明的 MIME 或上传成功替代服务端校验。
- 仅验证通过且符合当前发布资格的公开衍生图进入独立公开分发范围；原图、私有凭证和内部文档图片不得因启用 CDN 被公开。现有原图与衍生图共用内容寻址前缀，不能直接将整个现有桶或前缀挂为公开 CDN。
- 公开图片可用 CDN 授权回源私有 OSS，并使用可控的缓存、版本化地址与撤回/失效机制。实际撤回时效、源站限制和费用以上线前配置与实测为准；不承诺能撤回已被用户下载的副本。历史媒体迁移需保留资产引用和映射，完成复制、摘要核对及权限验证后再切换。
- 内部文档及其他私有图片仍须按对象权限单独设计访问路径；不能复用公开 CDN 缓存。现阶段可先使用会话鉴权的 API 中继，日后如采用短期直链，须明确链接有效期内的访问及撤权边界。

## 配置与查看

OSS 目标使用 `OSS_BUCKET`、`OSS_REGION`、`OSS_ENDPOINT`、`OSS_OBJECT_PREFIX`。服务器进程提供 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`，可选 `ALIBABA_CLOUD_SECURITY_TOKEN`；禁止把凭据写入仓库、页面或浏览器存储。OSS 配置缺失时启动失败，不自动回退本地。对象为 `<prefix><SHA前两位>/<SHA>`，上传显式设置解码验证后的 Content-Type。

管理端“系统与安全 → 系统配置”（`/system`）提供 Boss 专用的只读媒体配置及样本检查；个人设置和内容运营权限不授予部署配置访问权。API 的 `GET /api/v1/admin/system/storage`、`GET /api/v1/admin/system/storage/check` 及对应 Admin BFF 路径要求当前有效、未锁定的 Boss 会话，响应 `no-store`。仅返回后端、目标 Bucket/地域/Endpoint/前缀、凭据类型、上传限制和检查结果，不返回凭据、签名 URL、本地绝对目录或其他进程环境。

“已配置”仅表示适配器装配；检查读取一张已审核公开的内容衍生图并核 SHA256。未检查、无公开样本、读取失败和校验失败分别呈现。检查不上传对象，也不证明私有权限、全量覆盖、上传或 CDN 已验收。原内容运营素材页的只读状态接口保持兼容。

存储目标由部署配置管理，页面不提供在线切换或密钥编辑。现有适配器的 STS 凭据只在启动时读取，没有自动续期；长期使用临时凭据前必须接入刷新机制，不能把一次 Token 注入当作持续可用。

## 新环境的初始对象准备

本地开发、团队线上测试和生产使用各自的 Bucket 与运行身份。Bucket/Object 保持 private；原图与衍生图共用后端，不能将整个前缀公开。浏览器沿 API/BFF 地址读取，由服务器检查当前公开资格或私有权限。测试 ECS 优先与 Bucket 同地域，使用匹配的 HTTPS Endpoint。

切换 Bucket 或后端前，按目标数据库的同一数据快照生成引用清单。每项记录 `mediaId`、用途、原图/衍生图、`storageKey`、SHA256、字节数、MIME、审核/访问状态及来源快照标识；按对象键去重，并保留全部业务引用。研究图、探针、无引用保全件和未知图片不自动上传；无法确定的映射单列，不补零或自动审核。

先复制原始字节和既有衍生图，不重新编码；保持业务 ID、哈希和相对对象键不变。上传后读回核验 SHA256、大小和 Content-Type，再切换 API 目标。OSS ETag 不代替 SHA256，已有对象 HEAD 成功也不代表内容或旧 MIME 正确。已存在的同键对象需核验，冲突停止，不覆盖未知数据。

每次初始化保留：代码版本、源/目标数据库快照标识、Bucket/前缀、对象与引用清单及其 SHA256、逐对象上传/复用/失败/读回结果、完整数量与字节数、执行时间、运行身份引用及回退目标。记录不含凭据或签名 URL。复制完成后仍保留源 Bucket 与本地恢复副本，删除由单独清理决定负责。

最后在同版本应用上验证目录/账号/内容显示、正式上传与原键重试、私有原图授权与跨身份拒绝、素材撤回后公开 URL 拒绝、重启后读取及所选凭据的持续可用性。对象复制成功、数据库迁移成功和业务页面验收分别记录。

## 三角洲计费物品初始图

仓库内上架页所用的八张物品图及其 code、单位、尺寸、字节数和 SHA256 记录在 `scripts/migration/catalog-item-media-manifest.json`。在仓库根目录运行 `node scripts/migration/check-catalog-item-media.mjs` 可离线校验原图、完整解码和公开衍生图摘要；它不连接数据库或对象存储。衍生图摘要由当前安装的 Sharp 计算，实际结果以目标服务生成及读回为准。

新环境在业务目录初始化后，按清单核对对应游戏、code、单位和精度，再使用现有管理端素材上传、审核和目录维护流程绑定 `ITEM_MEDIA`；哈夫币无需绑定。保存原图及公开图读回的 SHA256、MIME 和对应资产 ID；既有不同素材先核实，不能因同 code 直接覆盖。目录绑定会递增 `catalogRevision`，依赖该版本的发布准入须重新核验。此清单不替代图片使用权、对象存储、权限与真实页面验收。

## 默认头像对象

四个默认头像是预审、内容寻址的 256×256 WebP 衍生图，清单与对象字节在 `apps/api/assets/profile-avatars/`。它们和其他媒体共用同一个 backend，不需要原图上传：

```bash
npm run profile:avatar-presets -w @zzsh/api -- check
npm run profile:avatar-presets -w @zzsh/api -- upload
```

`check` 只读并逐项校验本地清单 SHA、解码尺寸和对象读回；`upload` 只写入缺失对象，不删除、不覆盖未知同键内容。命令的逐 preset 输出包含 `presetId`、版本、`storageKey`、SHA、MIME、尺寸、字节数、backend 和 `PRESENT/UPLOADED/FAILED`；任一失败退出码为 1。未执行初始化或对象缺失时，默认头像公开读取返回 404，不得把头像称为已上线；配置 OSS 后也不会因为没有对象而回退 local。

头像原图与自定义待审图只走私有审核读取；公开接口只返回已审核且仍为当前绑定的公开衍生图。默认头像对象的初始化不替代私有权限、上传、CDN 和重启后读取验收。
