# 旧账号图片固定路径迁移

旧来源字段中的 `accountsImage/YYYYMMDD/文件名.ext` 原样保存为每账号展示图、处罚图两个数组；对象键为当前 `OSS_OBJECT_PREFIX + legacy/ + 原相对路径`。不重编码原图、不创建 `media_asset`、不逐图回写状态。处罚图只供本人和授权管理员读取。

## 样本准备

样本目录保持 `YYYYMMDD/文件名.ext`，例如 Owner 提供的服务器目录 `/www/wwwroot/zhu_hao_web/uploads/accountsImage/20261103/` 对应本地 `sample-root/20261103/`。压缩包先用 `inspect-legacy-image-archives.py` 逐成员清点，再用 `extract-legacy-image-archives.py` 依据清点回执提取；两者只在 ACL 已收紧的受限目录写逐文件清单，不提取链接、穿越路径或其他日期文件。未选中成员记录在受限清单，不静默忽略。

## 上传与续传

`node scripts/migration/upload-legacy-path-media.mjs` 不带 `--upload` 只显示计划。真实执行需要提供样本根、提取清单及其 SHA256、日期集、API 编译根、预期 bucket/prefix 和新的受限日志目录；OSS 配置与凭据使用已有进程环境。每次最多四个对象并行，按清单读取原字节并核对本地 SHA/MIME，再写固定键。已有同键先 GET 比较字节和 MIME，相同则跳过，不同则记冲突；新对象带 `Content-MD5` 和 `x-oss-forbid-overwrite`，结果不明先记录同一 key 再只读回查，必要时仅重试同一 key。日志目录关闭继承并限制为当前用户、SYSTEM、Administrators。

每个新对象写后 HEAD 核对长度和 MIME；仅对本次普通单 PUT、无 SSE 且符合 MD5 格式并一致的 ETag 作字节校验，其余情况 GET 实际字节。固定抽样覆盖各日期及最大文件，并按路径摘要固定抽样 GET。`verify-legacy-path-upload.mjs` 可用封存的清单和上传日志另起只读复核。SHA/MD5 只用于核对，不参与对象键。

阿里云说明：Bucket 开启或暂停版本控制时禁止覆盖头无效，因此脚本在上传前只读检查桶版本状态，未确认 UNVERSIONED 时停止；批次期间桶版本配置须保持不变。见[官方 PutObject 文档](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)。

## 账号关联和读取

先运行 `node scripts/migration/prepare-legacy-path-source.mjs --prepare --private-root <受限根目录> --source-dir <封签capture目录> --receipt-sha <capture回执SHA256> --out <受限根内新目录>`，从只读封签 capture 生成来源引用及回执；结果只含源字段和路径引用，不读取对象、不创建媒体资产，也不标记 READY。源字段明确为 null/空时保留空路径；字段缺失或路径非法时明确标记，若被选入后续账号计划则停止核查，不能冒充无图。相同封签输入在新目录重放得到相同引用文件摘要，已有输出目录不得覆盖。旧 `prepare-legacy-account-media.mjs` 保持退役。

`prepare-legacy-path-accounts.mjs` 从上述封存来源引用和已审账号计划生成每账号双数组，`load-legacy-path-accounts.mjs --verify` 只离线重算来源和数组；`--apply` 由环境维护者使用登记的 M 角色、有效管理 session、精确数据库身份及受限日志执行。执行前表结构和 R 只读 ACL 由维护者安装；脚本不创建账号，按 `legacy_supply_map` 核对原 sourceDigest 和 owner，重复相同记录安全重放，不同记录报冲突。

读取接口只接受已授权的 accountId、用途和槽位，服务端从表中取原路径并推导对象键；客户端不能提交 OSS 路径。公开展示需继续经过既有公开准入，处罚图只对本人及有 `supply.review.read` 和游戏 scope 的管理员提供。只有源引用明确存在且 OSS 精确返回 `NoSuchKey` 时可显示迁移占位；权限、网络、对象损坏及无源引用使用不可展示占位。
