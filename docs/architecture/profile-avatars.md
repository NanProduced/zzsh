# 个人头像

用户与管理员均可选择四个预审默认头像，或上传自定义头像。默认选项只作预览，点击“使用此头像”后才提交并生效；自定义头像在本地选择、裁剪并预览后按全局上传审核策略处理。默认须人工审核，期间继续显示当前头像；关闭审核时，仅随后完成提交的新头像按系统政策生效，不自动通过已有待审图片。重新开启不撤下已生效图片，人工隔离及撤回仍有效。待审图被拒绝、隔离或上传失败时保留当前头像；已生效的自定义头像被撤回或隔离时退回持久化默认头像。头像不是客服/Boss 身份认证，也不改变登录、角色、实名或认证策略。

用户侧通过头像画面和昵称旁的编辑图标分别打开弹窗。默认页只显示预览、预设与确认动作；审核说明在准备提交自定义头像时提示，失败与未知结果按实际状态展示。

两端复用本地 Canvas 裁剪工具，支持拖动、方向键平移和缩放，输出 512×512 图片；服务端仍按既有格式、字节、像素和解码约束校验。取消未提交选择不改变当前头像；关闭弹窗不撤回已提交审核，结果未知时保留原上传文件和请求标识，不因重开弹窗换键。

用户昵称使用独立弹窗，沿用 1–64 个 Unicode 码点、非空且无控制字符的服务端合同；未修改或输入无效时不能保存，未提交草稿关闭前须确认放弃。保存和结果恢复沿用主体隔离与未知结果保护。管理员可在“设置 → 个人资料”修改本人显示名称，无需审核；沿用 1–120 个 Unicode 码点、非空且无控制字符的合同，保存与 `admin.account.updated` 审计同事务，成功响应返回最新资料。成功提示可跨资料刷新保留，确认不同身份或退出后撤下；提示不替代服务端资料读取。

## 范围与不变量

- 默认头像为 Owner 提供的四个固定资源，存储在仓库 `apps/api/assets/profile-avatars/`，清单见同目录 `manifest.json`。衍生图为 256×256 WebP，原图只作来源追溯，不进入公开读取。
- `profile_avatar` 按 `(realm, subject_id)` 保存当前绑定、默认预设、待审提交、CAS `revision`、公开 `current_version` 和最近审核结果。`realm` 只允许 `user` / `admin`。
- 新注册用户、首次迁入的旧用户、新建管理员在创建事务中随机分配一个默认头像并持久保存。注册/迁移重放、普通登录和页面刷新不会重新抽取；已存在的当前头像不会被后续迁移覆盖。
- 旧平台头像不迁移、不抓取外链。既有空头像的批量回填只提供候选 SQL，不在迁移中自动执行。
- 媒体 `purpose='AVATAR'`，归属仅允许 `USER_AVATAR`（用户本人）和 `ADMIN_AVATAR`（管理员本人），`game_id`/`account_id` 必须为空。其他素材的 actor shape 保持原约束，不因头像放宽。
- Bucket 保持 private。浏览器只通过服务端公开读取接口获得当前合格衍生图；不返回原图、OSS 凭据或签名 URL。

## 接口

| 入口 | 方法 | 说明 |
|---|---|---|
| `/api/v1/profile/avatar` | GET | 用户本人当前头像、四个预设、待审提交和最近审核结果。 |
| `/api/v1/profile/avatar/default` | POST | 选择默认头像；body `{presetId, expectedRevision}`，需 `Idempotency-Key`。 |
| `/api/v1/profile/avatar/upload-intents` | POST | 创建头像上传意图；body `{mime, size, expectedRevision}`，需 `Idempotency-Key`。 |
| `/api/v1/profile/avatar/uploads/:intentId` | PUT | 上传字节；`X-Upload-Token` 与 `Idempotency-Key`。最终回执区分待审与系统政策生效，客户端不能指定批准状态。 |
| `/api/v1/profile/avatar/preview` | GET | 本人待审衍生图，私有 `no-store`。 |
| `/api/v1/profile/avatar/operation-result` | GET | 按原幂等键、预设和期望版本查询默认选择写回执。 |
| `/api/v1/admin/profile-avatar` | GET | 管理员本人头像状态；另有 `/default`、`/upload-intents`、`/uploads/:id`、`/preview`、`/operation-result` 同形状入口。 |
| `/api/v1/admin/profile-avatars` | GET | 头像审核队列；需要 `profile.avatar.review`。 |
| `/api/v1/admin/profile-avatars/policy` | GET / POST | 读取或修改全局审核策略；写入须 `profile.avatar.policy.manage`、原幂等键及期望修订。 |
| `/api/v1/admin/profile-avatars/policy/operation-result` | GET | 用原幂等键及原参数读取策略写入结果；结果未知时不换键重提。 |
| `/api/v1/admin/profile-avatars/:assetId/content` | GET | 审核用原图，私有 `no-store`。 |
| `/api/v1/admin/profile-avatars/:assetId/review` | POST | 通过/拒绝/隔离；body `{decision, reason?, expectedRevision}`。 |
| `/api/v1/admin/profile-avatars/:assetId/withdraw` | POST | 撤回已通过头像的公开读取；body `{reason, expectedRevision}`。 |
| `/api/v1/admin/profile-avatars/operation-result` | POST | 按原幂等键及原审核正文恢复回执，原因不进入 URL。 |
| `/api/v1/profile/avatars/presets/:presetId/:version/content` | GET | 公开默认头像衍生图。 |
| `/api/v1/profile/avatars/:realm/:subjectId/:version` | GET | 公开当前头像；版本必须等于 `current_version`，旧地址返回 404。 |

Web 侧经 `/api/v1/profile/...` 同源路由转发；管理站经 `/api/bff/admin/profile/avatar...` 与 `/api/bff/admin/profile-avatars...`。公开图片路径由两端同源代理读取，不直连 OSS。

## 状态与并发

- 所有头像写接口在服务端重做身份、主体归属、realm、`purpose` 和对象归属检查；客户端不能提交任意图片 URL、`gameId` 或 `accountId`。
- 默认选择、上传准备与审核使用必填 `expectedRevision` CAS；无头像行的首次选择/上传准备允许版本 `0`；并发或跨设备版本不符返回 409，页面应重新读取。
- 上传准备以 CAS 保留最新意图并推进版本；上传完成必须匹配该意图。切默认或另一上传准备会取消旧意图，旧 PUT 返回 409，不覆盖后续选择。上传令牌只在首次准备响应返回，不写入幂等回执；准备响应丢失后原键重放返回 `UPLOAD_TOKEN_NOT_RECOVERABLE`，需用户明确重新准备。
- `pending_asset_id` 只指向该主体最新提交。上传 A 后上传 B、切换默认头像或跨设备改变选择，都会使 A 的晚到审核只记录结果而不覆盖当前头像。
- 审核通过且仍是最新提交时，当前绑定、公开版本、`zzsh_auth_user.user.image`/`zzsh_auth_admin.user.image` 和审计在同一事务更新。
- 当前头像被拒绝、隔离或撤回时，回到该主体持久化的 `default_preset_id`，并推进 `current_version`；旧公开地址随即失效。审核拒绝/隔离的待审图不会公开。
- 公开读取同时检查当前绑定、审核状态、`PUBLIC_DISPLAY`、`technical_state='READY'`、公开衍生图键和 `image` 字段一致性；旧版本、失效绑定返回 404，当前媒体不合格时仅可回退该主体默认图。对象缺失记录固定字段日志，不静默改回 local。
- `image` 保存同源 API 相对路径 `/api/v1/profile/avatars/<realm>/<id>/<version>`。`packages`/客服读取如只接受 `http(s)` 外链，需在 IM 合入时适配；`image` 有值不代表云信资料已更新，也不代表云信头像缓存已刷新。

## 迁移与初始化

- 正式前向迁移：`apps/api/migrations/business/0124_profile_avatars.sql`，journal 追加 `0124_profile_avatars`；0000–0123 和既有 CRLF 例外不改。
- 默认对象初始化/核验：`npm run profile:avatar-presets -w @zzsh/api -- check`（只读）或 `-- upload`（缺失时写入内容寻址对象）。命令输出逐 preset 的 storageKey、SHA、尺寸、字节数和状态；失败退出码 1。未初始化、对象缺失或上传失败不得称头像已上线。
- 既有空头像回填候选：`apps/api/migrations/candidates/profile-avatars/dry-run.sql` 与 `backfill.sql`；后者默认 `ROLLBACK`，需在批准窗口核对数量后改为 `COMMIT`。

默认对象CLI的`check`核对内容字节；`upload`仅在存储适配器明确报告对象不存在时写入，已有字节冲突或读取故障停止本轮写入，后续对象记为`NOT_ATTEMPTED`。写入已开始但结果或读回未确认记为`UNKNOWN`，不自动重试。输出的MIME来自已解码源文件，`storedMetadataVerification=NOT_OBSERVED`明确未读回对象头；不能把`PRESENT/UPLOADED`当作OSS Content-Type、private权限、STS持续可用或头像业务已上线的证明。真实OSS需另核HEAD元数据及同版API。

API发布包必须同时携带`dist/`和`assets/profile-avatars/`；默认资源读取相对于API包定位，不依赖本机Temp、E盘或过程目录。回填候选使用UTF-8的SHA256摘要第4字节模4，与读侧UInt32BE模4一致，避免回填前后默认头像变化；候选仍默认ROLLBACK，真实执行另行授权。

部署顺序必须先应用 0124 并初始化四个预设对象；包含审核策略的版本还须先应用0151及对应窄runtime ACL。策略缺表只可安全显示为需审核且不可编辑，不退回环境变量或内存开关；缺少头像基础表时注册/迁入/管理员创建会失败。

审核策略与最终上传在数据库中锁定同一单例并按修订生效，策略修改使用CAS、幂等及审计；只seed管理权限，不自动授予审核员或运营。系统批准保留正政策修订及独立系统审计，不伪造人工审核者。最终上传回执与当前assetId共同确认本次是否生效，提交前读取的策略不作为成功证据；已知上传成功而后续读取失败只恢复读取，传输结果未知继续保留原文件与原键。
