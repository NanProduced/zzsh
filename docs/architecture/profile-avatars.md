# 个人头像

用户与管理员均可选择四个预审默认头像，或上传自定义头像。默认头像选中即生效；自定义头像上传后进入审核，审核期间继续显示当前头像，拒绝、隔离、撤回或上传失败都不改变当前头像。头像不是客服/Boss 身份认证，也不改变登录、角色、实名或认证策略。

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
| `/api/v1/profile/avatar/upload-intents` | POST | 创建头像上传意图；body `{mime, size}`，需 `Idempotency-Key`。 |
| `/api/v1/profile/avatar/uploads/:intentId` | PUT | 上传字节；`X-Upload-Token` 与 `Idempotency-Key`。成功提交待审，不改变当前头像。 |
| `/api/v1/profile/avatar/preview` | GET | 本人待审衍生图，私有 `no-store`。 |
| `/api/v1/profile/avatar/operation-result` | GET | 按原幂等键、预设和期望版本查询默认选择写回执。 |
| `/api/v1/admin/profile-avatar` | GET | 管理员本人头像状态；另有 `/default`、`/upload-intents`、`/uploads/:id`、`/preview`、`/operation-result` 同形状入口。 |
| `/api/v1/admin/profile-avatars` | GET | 头像审核队列；需要 `profile.avatar.review`。 |
| `/api/v1/admin/profile-avatars/:assetId/content` | GET | 审核用原图，私有 `no-store`。 |
| `/api/v1/admin/profile-avatars/:assetId/review` | POST | 通过/拒绝/隔离；body `{decision, reason?, expectedRevision?}`。 |
| `/api/v1/admin/profile-avatars/:assetId/withdraw` | POST | 撤回已通过头像的公开读取；body `{reason, expectedRevision?}`。 |
| `/api/v1/profile/avatars/presets/:presetId/:version/content` | GET | 公开默认头像衍生图。 |
| `/api/v1/profile/avatars/:realm/:subjectId/:version` | GET | 公开当前头像；版本必须等于 `current_version`，旧地址返回 404。 |

Web 侧经 `/api/v1/profile/...` 同源路由转发；管理站经 `/api/bff/admin/profile/avatar...` 与 `/api/bff/admin/profile-avatars...`。公开图片路径由两端同源代理读取，不直连 OSS。

## 状态与并发

- 所有头像写接口在服务端重做身份、主体归属、realm、`purpose` 和对象归属检查；客户端不能提交任意图片 URL、`gameId` 或 `accountId`。
- 默认选择与审核使用 `expectedRevision` CAS；并发或跨设备版本不符返回 409，页面应重新读取。
- `pending_asset_id` 只指向该主体最新提交。上传 A 后上传 B、切换默认头像或跨设备改变选择，都会使 A 的晚到审核只记录结果而不覆盖当前头像。
- 审核通过且仍是最新提交时，当前绑定、公开版本、`zzsh_auth_user.user.image`/`zzsh_auth_admin.user.image` 和审计在同一事务更新。
- 当前头像被拒绝、隔离或撤回时，回到该主体持久化的 `default_preset_id`，并推进 `current_version`；旧公开地址随即失效。审核拒绝/隔离的待审图不会公开。
- 公开读取同时检查当前绑定、审核状态、`PUBLIC_DISPLAY`、`technical_state='READY'`、公开衍生图键和 `image` 字段一致性；不满足时 404。对象缺失记录固定字段日志，不静默改回 local。
- `image` 保存同源 API 相对路径 `/api/v1/profile/avatars/<realm>/<id>/<version>`。`packages`/客服读取如只接受 `http(s)` 外链，需在 IM 合入时适配；`image` 有值不代表云信资料已更新，也不代表云信头像缓存已刷新。

## 迁移与初始化

- 正式前向迁移：`apps/api/migrations/business/0124_profile_avatars.sql`，journal 追加 `0124_profile_avatars`；0000–0123 和既有 CRLF 例外不改。
- 默认对象初始化/核验：`npm run profile:avatar-presets -w @zzsh/api -- check`（只读）或 `-- upload`（缺失时写入内容寻址对象）。命令输出逐 preset 的 storageKey、SHA、尺寸、字节数和状态；失败退出码 1。未初始化、对象缺失或上传失败不得称头像已上线。
- 既有空头像回填候选：`apps/api/migrations/candidates/profile-avatars/dry-run.sql` 与 `backfill.sql`；后者默认 `ROLLBACK`，需在批准窗口核对数量后改为 `COMMIT`。
