# 协议、规则披露与接受

本页记录当前协议与交易规则的**契约边界**，不包含正式对外法律文本。正式文本是否发布以数据库中的封存版本为准。

## 文书来源

| 文书 | 存储 | 版本规则 |
|---|---|---|
| 平台服务协议 / 用户隐私政策 | `zzsh_content.legal_document_version` | `DRAFT → SEALED`；封存后不可原地修改；按 `effective_at` 取当前版本 |
| 出租协议 | `zzsh_supply.agreement_version` | 既有草稿/封存；绑定 `rule_release` |
| 全额包赔条款 | `zzsh_supply.full_payout_terms_version` | 独立草稿/封存；价格版本通过 `policyRef / policyVersion / disclosureVersion` 引用 |
| 帮助与公告 | `zzsh_content` 既有 CMS | 不可变发布版本；帮助文章不替代交易现场协议 |

不接受客户端提交正文、金额、版本或“已同意”布尔作为授权依据。服务端只用已封存/已生效版本、本人身份、对象归属和同一事务内的动作记录。

## 服务端接受

- 统一接受台账：`zzsh_content.document_acceptance`（本人、文书类型、版本、摘要、适用对象、来源、服务端时间）。同键重复请求由唯一约束幂等；台账不可更新/删除。
- 登录/注册：手机号注册/登录在创建会话的同一事务写入平台服务协议与隐私政策接受；密码登录在认证成功后由同一请求写入。平台文书尚未封存时保留旧 `acceptedTerms` 行为；两份文书只发布一份时失败关闭。
- 出租：既有 `zzsh_supply.rule_acceptance` 绑定号主、账号、发布版本、release 与内容摘要；不收窄。
- 租用：`POST /api/v2/orders` 必须携带与订单快照 `ruleRefs.agreementVersionId/agreementDigest` 一致的 `agreementAcceptance`；建单事务写入 `RENTAL_AGREEMENT` 接受。选择全额包赔时同事务写入 `FULL_PAYOUT_TERMS` 接受，版本/摘要取自已校验的包赔条款。
- 提前结算：v2 个人确认创建的订单（`quoteKind=ORDER_CONFIRMATION`）在提交提前结束或双方确认提前结算时必须携带 `termsAccepted=true`；服务端在结算事务写入 `EARLY_SETTLEMENT_OWNER/RENTER` 接受，绑定本次结算预览/版本哈希。旧订单保持原合同，不补造历史接受。

## 接口

| 接口 | 用途 |
|---|---|
| `GET /api/v1/legal-documents/current` | 两份平台文书当前版本的摘要（无正文） |
| `GET /api/v1/legal-documents/terms`、`/privacy` | 公开阅读；无已生效版本时返回 `PENDING`，不返回占位正文 |
| `POST /api/v1/admin/legal-documents/drafts` | Admin 新建草稿（`content.platform.edit`） |
| `PUT /api/v1/admin/legal-documents/drafts/{id}` | 修改草稿，要求 `expectedRevision` |
| `POST /api/v1/admin/legal-documents/drafts/{id}/seal` | 封存并设置生效时间（`content.platform.publish`） |
| `GET /api/v1/admin/legal-documents?docType=...` | Admin 版本列表 |

用户端读取 `apps/web/src/app/legal/[doc]`；登录表单经 `/api/legal-documents/current` 读取当前版本引用。Admin 维护入口在内容管理的“法律文书”分区；包赔条款在“规则与价目”页维护。

## 迁移与发布

- 候选迁移：`apps/api/migrations/business/0112_legal_documents.sql`。编号与 `meta/_journal.json` 由 Root 统一分配；未 journal 的候选不表示已在任何数据库执行。
- 先应用迁移再启用平台文书封存；旧库无该表时不得假设已有接受记录。
- 正式平台服务协议/隐私政策正文须由 Owner 审阅后创建草稿、封存并设置生效时间；过程草稿与未核事实不进入公开页。
- 已封存文书修正：新建草稿 → 审阅 → 封存 → 新版本生效；不修改历史接受或订单快照。
