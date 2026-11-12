# 媒体存储与环境准备

图片媒体由 API 的 `MediaStorage` 承接，服务端通过 `MEDIA_STORAGE=local|oss` 选择一个后端。账号展示/审核图片、保证金图片证据、游戏/皮肤/枪械/物资目录图和平台内容素材共用该后端；原图和清理元数据后的公开衍生图分别按 SHA256 保存。仅支持 JPEG、PNG、WebP，单张最多 10 MiB。固定品牌、字体和页面插画随应用部署；IM 附件走其独立链路，协议正文、资金导出和数据库备份不属于本媒体服务。

## 账号图片直传和私有衍生图

`OSS_ACCOUNT_MEDIA_DIRECT=1` 启用账号图片的 `OSS_POST` 上传能力，默认关闭。API 继续支持原有中继上传，上传意图只允许使用创建时选择的方式。展示截图、处罚截图和审核证据均保留所选文件的原始字节；公开展示另生成缩放及水印衍生图。其他业务媒体沿用各自入口。

- `GET /api/v1/supply/games/:gameId/publishing-options` 在启用时返回 `accountMediaTransport: "OSS_POST"`。`POST /api/v1/supply/media/upload-intents` 接受 `transport: "OSS_POST"`，验证账号归属和声明后返回限时 `ossUpload` 表单，绑定 `<prefix>private/account-upload/<intentId>`、实际声明大小和 MIME。客户端按返回字段构造 multipart 表单，最后附文件，向 OSS HTTPS 域名 POST。有效期沿用上传意图的 10 分钟。
- `POST /api/v1/supply/media/uploads/:intentId/complete` 沿用写幂等键，提交 `{ uploadToken, contentHash }`，其中 `contentHash` 是实际上传文件的十六进制 SHA-256。API 按当前身份与账号权限从 OSS 读取暂存字节，完整解码并重新核对大小、MIME 和 SHA-256。原图及中继兼容衍生图沿用现有内容寻址键。若 `MEDIA_STORAGE=oss` 使用同地域内网 Endpoint，这些校验读写发生在内网，用户上传流量直达 OSS。
- 新直传的展示图由 OSS 原生缩放并应用当前水印规则，同桶转存到 `<prefix>private/account-variants/<生成ID>/{640,1920}.webp`。API 读回核对格式、尺寸、解码和 SHA-256，与媒体资产一并记录成功的两个规格。原有中继图片路径仍使用原兼容衍生图，私有变体保留作为投放源。
- `/system` 的「账号图片水印」由 Boss 管理，支持启用、Logo、角落、相对大小、不透明度和边距。Logo 选择已审核公开的 PNG 运营素材。OSS 可用时，可输入符合展示条件的账号素材编号，通过短签名预览两个规格的实际 OSS 处理结果。规则修改应用于以后生成的变体。
- 用户原图 `/api/v1/supply/media/:id/access` 和管理端 `/api/v1/admin/supply/media/:id/content` 接受 `?delivery=direct`。通过当前会话、业务对象及角色权限校验后，账号原图返回 307 和仅该对象的 120 秒 OSS GET 签名。未选择直读的调用方仍收到现有二进制响应。签名过期前仍可用，权限变化会阻止再次签发。

部署时先应用账号媒体业务迁移，并给 API 与用户 Web BFF 配置同一个 `OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN`。该域名应为独立的 OSS HTTPS CNAME，并避免共享应用身份 Cookie。Bucket 保持私有并阻止公共访问，CORS 仅允许所需客户端来源和直传 POST。为暂存前缀配置过期清理，启用 OSS 对象版本控制时同时处理历史版本。真实 OSS 表单、私有签名、转存、预览和客户端域名限制均需在隔离资源验证。 [OSS POST V4 签名](https://help.aliyun.com/en/oss/developer-reference/signature-version-4-recommend) · [转存处理结果](https://help.aliyun.com/zh/oss/user-guide/save-processed-images) · [OSS CNAME](https://help.aliyun.com/zh/oss/user-guide/access-buckets-via-custom-domain-names)

## 新平台账号展示图 CDN

`OSS_ACCOUNT_IMAGE_CDN_MODE` 默认为 `off`。`serve` 需要 OSS 直传处理能力、独立的 `OSS_ACCOUNT_IMAGE_CDN_ORIGIN` 和已应用的投放迁移。`drain` 停止签发公开地址和新增投放，继续删除已投放对象并刷新 CDN。退回 `off` 前先通过投放表确认所有记录已撤下，并核验 CDN 刷新任务完成与旧地址拒绝。切换中应保持所有工作进程的模式、Bucket、前缀和域名一致。

- 投放复用现行账号公开详情与媒体资格。新上传的图使用已核验私有变体，存量已发布资产先核对现有衍生图的 SHA-256 和解码结果再补两个规格。两张成品在同桶复制至 `<prefix>public/listing/<accountId>/<assetId>/<分发版本>/{640,1920}.webp`，实际回读核验成功后才发布。旧 `url` 字段兼容中继，市场列表、详情、编号查询与收藏共用图片投影，优先使用可用的 `coverUrl` 和 `detailUrl`。
- 新发布、换版、下架、素材审核和限制变更触发投放队列。账号暂停继续按原详情资格处理。已撤下的版本不会复用，撤下操作删除回源对象后请求 CDN 按 URL 刷新。刷新任务受理和各节点完成分别核验。在 CDN 为投放目录设 300 秒缓存并开启「忽略源站不缓存标头」，以免浏览器重新验证所用的 `max-age=0` 同时禁用节点缓存。关闭「客户端跟随CDN缓存策略」及「响应过期缓存」。实际冷回源、热缓存和旧 URL 撤回时效须在隔离域名实测。 [CDN 缓存刷新](https://help.aliyun.com/en/cdn/developer-reference/api-cdn-2018-05-10-refreshobjectcaches)
- CDN 回源身份仅授权 `<prefix>public/listing/*` 当前版本的 `GetObject`。使用独立同账号或跨账号回源身份，核对暂存、原图、内部件和对象版本访问均拒绝。默认的一键 OSS 回源授权范围过宽。处理和投放身份需读写所需私有及投放前缀，允许删除投放对象和刷新指定 CDN 域名。 [CDN 回源配置参数](https://help.aliyun.com/zh/cdn/developer-reference/parameters-for-configuring-features-for-domain-names)

旧平台路径图另以 `OSS_ACCOUNT_LEGACY_CDN=1` 启用，须提供审核通过的展示清单文件 `OSS_ACCOUNT_LEGACY_CDN_MANIFEST` 和其文件摘要 `OSS_ACCOUNT_LEGACY_CDN_MANIFEST_SHA256`。清单格式为 `{"schema":"zzsh.legacy-image-cdn.v1","images":[{"path":"accountsImage/20261112/example.png","sha256":"<sha256>","byteSize":123,"mime":"image/png"}]}`。每条必须同时匹配现行账号公开资格、已核来源版本及展示引用，并排除被任一账号引用为处罚图的路径。已迁入源仍保留 `<prefix>legacy/accountsImage/YYYYMMDD/...`，投放前核对实际 SHA-256、大小、MIME、解码和隐私元数据，投放版本使用 `<prefix>public/legacy/<分发版本>/accountsImage/YYYYMMDD/...`。

有已核清单但确认 OSS 尚未上传的路径由业务数据标记「正在迁移中」。正常 CDN 读取和已有该状态的页面不逐图调用 API 探测。格式或校验不符显示不可用，缺少获审清单的历史引用继续使用原授权链路。开启旧图 CDN 时只为回源身份追加 `<prefix>public/legacy/*` 当前版本的 `GetObject`，撤权先删回源再刷新，重新投放使用新版本。其他业务素材及内部文档沿用现有授权链路。

## 配置与查看

OSS 目标使用 `OSS_BUCKET`、`OSS_REGION`、`OSS_ENDPOINT`、`OSS_OBJECT_PREFIX`。服务器进程提供 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`，可选 `ALIBABA_CLOUD_SECURITY_TOKEN`；禁止把凭据写入仓库、页面或浏览器存储。OSS 配置缺失时启动失败，不自动回退本地。对象为 `<prefix><SHA前两位>/<SHA>`，上传显式设置解码验证后的 Content-Type。

管理端“系统与安全 → 系统配置”（`/system`）提供 Boss 专用的只读媒体配置及样本检查；个人设置和内容运营权限不授予部署配置访问权。API 的 `GET /api/v1/admin/system/storage`、`GET /api/v1/admin/system/storage/check` 及对应 Admin BFF 路径要求当前有效、未锁定的 Boss 会话，响应 `no-store`。仅返回后端、目标 Bucket/地域/Endpoint/前缀、凭据类型、上传限制和检查结果，不返回凭据、签名 URL、本地绝对目录或其他进程环境。

“已配置”仅表示适配器装配；检查读取一张已审核公开的内容衍生图并核 SHA256。未检查、无公开样本、读取失败和校验失败分别呈现。检查不上传对象，也不证明私有权限、全量覆盖、上传或 CDN 已验收。原内容运营素材页的只读状态接口保持兼容。

存储目标由部署配置管理，页面不提供在线切换或密钥编辑。现有适配器的 STS 凭据只在启动时读取，没有自动续期；长期使用临时凭据前必须接入刷新机制，不能把一次 Token 注入当作持续可用。

## 公司账号首次部署 OSS/CDN

本节适用于首次给一个环境配置公司账号下的账号图片存储。生产、线上测试和本地测试分别使用独立 Bucket、域名和运行身份；实际名称、负责人和凭据引用由部署记录保管，不把密钥写入仓库。常规版本更新复用当前已生效配置，不重新创建 Bucket、覆盖水印策略或重新初始化已存在的媒体资料。

| 配置项 | 首次部署要求 |
| --- | --- |
| OSS Bucket | 创建与业务部署地域相匹配的专用 Bucket，保持私有并阻止公共访问；业务前缀非空且以 `/` 结尾。确认图片处理能力、容量、对象版本和生命周期规则。 |
| 上传域名 | 为浏览器准备独立的 HTTPS OSS 上传域名，不与应用认证 Cookie 共享作用域；若使用自定义域名，完成 OSS 绑定、DNS 和证书。OSS 默认公网域名能否用于直传和浏览器内联读取须在目标 Bucket 实测。 |
| CDN 域名 | 使用独立的图片加速域名，业务类型为图片小文件。完成域名归属验证、CNAME 和 HTTPS 证书部署；正式证书使用适用于公司业务的证书并安排续期。 |
| 加速区域与备案 | 中国内地或全球加速需要域名备案；仅境外测试可按实际情况选择不含中国内地的区域。公司上线前确认地域、备案及数据出境要求。 |
| 运行身份 | 使用专用 RAM 身份，按实际对象前缀授予上传、读取、图片转存、复制和删除所需的最小权限，并仅对本环境 CDN 域名授予 `cdn:RefreshObjectCaches`。不要使用主账号密钥、`PowerUserAccess` 或账号级 OSS 全权限。 |
| CDN 回源身份 | 使用单独的受限身份，初始仅允许读取 `<prefix>public/listing/*`；不可读取上传暂存、原图、私有变体和内部文档。旧图是否公开另行核准后再授权对应目录。 |
| 水印 | 在管理端“系统配置 → 账号图片水印”选择已审核公开的 PNG Logo，设置位置、大小、透明度和边距；用新上传的合成图核验 640 与 1920 两档。配置只作用于随后生成的变体。 |
| 生命周期与监控 | 为 `<prefix>private/account-upload/` 设置覆盖上传有效期和恢复窗口的清理周期；原图、私有变体及已投放对象不得按同一规则盲删。配置容量、费用、证书到期、投放失败和刷新失败监控。 |

建议按以下顺序配置并验收：

1. 在目标公司账号创建 Bucket 和独立 RAM 运行身份，先以 `OSS_ACCOUNT_IMAGE_CDN_MODE=off` 部署。按服务器所在地选择 OSS Endpoint；同地域 ECS 可使用官方内网 Endpoint，浏览器直传仍使用外网 HTTPS 上传域名。运行身份当前从环境读取 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 及可选 `ALIBABA_CLOUD_SECURITY_TOKEN`；通过受限部署配置注入，当前代码不会自动续期 STS。[官方转存权限说明](https://help.aliyun.com/zh/oss/user-guide/save-processed-images)列有源 Bucket 的 `oss:PostProcessTask`、目标 Bucket 的 `oss:PutBucket` 和目标 Object 的 `oss:PutObject`；对专用 Bucket 按实际调用核验最小范围，勿为排错授予全账号权限。
2. 配置 OSS CORS，明确允许实际用户站的完整 Origin、账号直传所需 POST 及必要请求头；私有直读或其他客户端需要的 GET 等方法按实际调用单独核定。API 和用户 Web BFF 的 `OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN` 必须一致。用合成图片验证浏览器直接向 OSS 上传、服务端完成校验、原图字节及两档水印衍生图读回。 [OSS 跨域配置](https://help.aliyun.com/zh/oss/user-guide/configure-cross-origin-resource-sharing) · [地域与 Endpoint](https://help.aliyun.com/zh/oss/user-guide/regions-and-endpoints)
3. 在 CDN 添加加速域名，以目标 Bucket 的 OSS 公网域名为源站，设置 HTTPS 回源、回源 HOST 和 SNI，部署覆盖加速域名的证书并配置 CNAME。按实际账号权限配置私有 Bucket 回源，避免使用默认全 Bucket 或全账号只读授权；先核实同账号回源角色是否被其他域名共用，共用时不得直接覆盖其策略。使用受限身份后，以合成对象验证公开目录可读、私有目录拒绝。 [添加 CDN 域名](https://help.aliyun.com/zh/cdn/add-a-domain-name) · [私有 Bucket 回源](https://help.aliyun.com/zh/cdn/user-guide/grant-alibaba-cloud-cdn-access-permissions-on-private-oss-buckets)
4. 为 `/<prefix>public/listing/` 设置 300 秒节点缓存、开启“忽略源站不缓存标头”、关闭“客户端跟随 CDN 缓存策略”和“响应过期缓存”。规则按权重生效：具体目录权重应高于根目录；例如根目录设 0 秒、权重 1，公开目录设 300 秒、权重 99。切换前核对现有发布记录、待投放队列及素材来源，确认所有可能自动投放的图片都允许公开；`OSS_ACCOUNT_LEGACY_CDN=0` 不会阻止已经形成新平台发布记录的账号按新图链路投放。范围未确认时保持 `off`，以隔离数据验证。规则和投放范围均确认后，再将所有 API 工作进程的模式一致切至 `serve`。 [缓存规则与优先级](https://help.aliyun.com/zh/cdn/user-guide/configure-the-cdn-cache-expiration-time)
5. 在目标环境用虚构账号走浏览器直传、上架、列表、详情、编号查询和收藏，检查实际请求域名、两个规格和水印。再限制该账号公开，核对投放源对象删除、CDN 刷新任务完成及旧 URL 拒绝；恢复后核对新版本 URL。刷新受理不等于全网完成，需查询任务状态并实测；旧缓存失效时间以渠道结果为准。 [CDN 刷新与预热](https://help.aliyun.com/zh/cdn/user-guide/refresh-and-prefetch-resources)

CDN 回源身份的最小读取策略可按下列形式配置，其中 `<prefix>` 含末尾斜线；该策略不授予应用上传或删除权限。同账号 CDN 回源可能复用账号级角色，必须核实该角色及其他 CDN 域名的实际使用范围；不能隔离时应改用独立受限身份或独立账号，再做正反向访问验证。

```json
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["oss:GetObject"],
    "Resource": ["acs:oss:*:*:<bucket>/<prefix>public/listing/*"]
  }]
}
```

部署参数示例只展示字段名，值由目标环境提供：

```dotenv
MEDIA_STORAGE=oss
OSS_BUCKET=<环境专用Bucket>
OSS_REGION=<Bucket地域，例如oss-cn-hangzhou>
OSS_ENDPOINT=<服务端访问的官方HTTPS Endpoint>
OSS_OBJECT_PREFIX=<环境专用前缀，必须以斜线结尾>/
OSS_ACCOUNT_MEDIA_DIRECT=1
OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN=https://<独立OSS上传域名>
OSS_ACCOUNT_IMAGE_CDN_MODE=off
OSS_ACCOUNT_IMAGE_CDN_ORIGIN=https://<独立CDN图片域名>
OSS_ACCOUNT_LEGACY_CDN=0
```

上述 `off` 是验收前的起始值，公开/私有路径和撤回能力验证通过后才切 `serve`。旧平台图片需按前文准备获审清单、核对迁移后账号公开资格并独立验收，不能因新图成功便自动开启；本节账号图片的直传与 CDN 不代表目录图、内容素材或内部文档图片也已完成同等改造。对象存储、图片处理、CDN 流量和 HTTPS 请求可能分别计费，按公司账号实际价格与配额确认。

## 新环境的初始对象准备

本地开发、团队线上测试和生产使用各自的 Bucket 与运行身份。Bucket/Object 保持 private；原图与衍生图共用后端，不能将整个前缀公开。账号公开展示图在 CDN 投放就绪后由浏览器直接读取 CDN；私有原图先由 API/BFF 校验权限再签发短期 OSS 地址；其他素材按其当前实现读取。测试 ECS 优先与 Bucket 同地域，使用匹配的 HTTPS Endpoint。

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
