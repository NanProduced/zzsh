# SUPERSEDED：旧账号图片原逐图媒体方案

Owner 已决定旧图直接使用 `OSS_OBJECT_PREFIX + legacy/ + 原相对路径`，不对旧图生成衍生图、逐图审核或维护 READY。本文及同名 `legacy-account-media-plan.mjs` 仅保留为历史研究，不用于实施；已生成的来源清单只作为来源字段原值的读取输入。新规则与工具见 `legacy-path-media-README.md`。

这组工具只准备来源引用、检查已提供文件和生成导入计划；它们不连接数据库、不上传对象、不创建媒体资产，也不将任何图片标记为 `READY`。输出包含账号来源和图片原路径，必须放在限制访问的目录，不得放入公开 `tmp/`。

## 生成来源引用

在 Windows 上从已封存的 `CAPTURED_READ_ONLY` 来源准备新目录：

```powershell
node scripts/migration/prepare-legacy-account-media.mjs --prepare --source-dir <受限源目录> --receipt-sha <源receipt的SHA256> --out <受限根下的新目录>
```

脚本核验 receipt 和 `accounts.jsonl` 的摘要，在写入前关闭新目录继承并验证只有当前用户、SYSTEM、Administrators 可访问。它保留源账号、号主、字段原值与来源位置，将每个可解析引用记为 `PENDING_IMPORT`、目标账号记为 `UNBOUND`；缺字段、null、空值与无效内容分别记录。CSV 去空和去重时保留首次顺序，`punishment_img_url` 同样可能包含多项，但始终归为私有 `ACCOUNT_EVIDENCE`。身份不合法的源行按行号单列，原始来源仍在封存包中。`receipt.json` 是来源准备回执，不是数据库写入回执。

## 后续样本与查缺

旧服务器位置由 Owner 提供，样本目录保持其日期层级，例如：

```text
sample-root/
  20261103/<原文件名>
  20261102/<原文件名>
```

从来源字段 `accountsImage/20261103/<原文件名>` 仅去除固定的 `accountsImage/` 前缀，即可在样本根内精确匹配；日期来自来源路径，不从账号创建时间推算。路径遍历、外部 URL 和不符合日期/文件名约束的值隔离，不请求网络或跟随链接。原来源只有 basename 时，可以提供受审的全目录相对文件名索引核对；索引只需文件名，不要求下载历史图片。同名多处只有全部对应文件可比且字节一致时才可复用；不同字节或无法比较时隔离。

`legacy-account-media-plan.mjs` 导出 `scanAccountMediaBatch`、`scanAccountMediaReferences`、`planAccountMediaImport` 和 `projectAccountMediaSlots`。扫描对已提供文件计算真实 SHA256、MIME、尺寸与 Sharp 清理元数据后的衍生摘要；找到文件仍是 `PENDING_IMPORT`。带明确原相对路径的引用可产生待审核上传计划；basename 索引和其摘要须由调用方独立确认完整性与来源，函数本身不替代受权审核。后续对象应走现有内容寻址存储，原图与公开衍生图分别读回核验。`planAccountMediaImport` 只返回候选计划，不发请求，也不执行绑定。

真实 `READY` 需要有受审的账号和号主映射、原图及衍生对象读回、真实媒体资产和审计，并在事务中重新核对来源前像及新图片未被覆盖。当前仓库的普通管理媒体上传只允许平台素材，不能代账号上传；管理代迁接缝、权限、数据库约束及公开读取接缝尚未实施。不能把文件名或占位图哈希写成媒体资产，也不能修改冻结版本冒充已绑定。

公开投影只能在服务端确认账号可公开后调用，并且 `verifiedPublicAssetIds` 必须来自服务端的账号归属、用途、技术状态及公开资格检查；不得信任客户端传入的布尔值或集合。处罚图不进入公开投影。未观察、明确空、隔离、待迁、已迁后读取失败各自保留语义，只有明确待迁显示迁移占位。
