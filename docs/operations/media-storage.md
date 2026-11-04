# 媒体存储与环境准备

图片媒体由 API 的 `MediaStorage` 承接，服务端通过 `MEDIA_STORAGE=local|oss` 选择一个后端。账号展示/审核图片、保证金图片证据、游戏/皮肤/枪械/物资目录图和平台内容素材共用该后端；原图和清理元数据后的公开衍生图分别按 SHA256 保存。仅支持 JPEG、PNG、WebP，单张最多 10 MiB。固定品牌、字体和页面插画随应用部署；IM 附件走其独立链路，协议正文、资金导出和数据库备份不属于本媒体服务。

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
