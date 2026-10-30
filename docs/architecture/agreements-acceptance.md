# 协议、规则披露与接受

本页记录当前协议与交易规则的**契约边界**，不包含正式对外法律文本。正式文本是否发布以数据库中的封存版本为准。

## 文书来源

| 文书 | 存储 | 版本规则 |
|---|---|---|
| 平台服务协议 / 用户隐私政策 | `zzsh_content.legal_document_version` | `DRAFT → SEALED`；封存后不可原地修改；按 `effective_at` 取当前版本。该表不替代 CMS：平台文书无游戏范围，但需要封存/生效/摘要接受语义 |
| 出租协议 | `zzsh_supply.agreement_version` | 既有草稿/封存；绑定 `rule_release` |
| 全额包赔条款 | `zzsh_supply.full_payout_terms_version` | 独立草稿/封存；价格版本通过 `policyRef / policyVersion / disclosureVersion` 引用 |
| 帮助与公告 | `zzsh_content` 既有 CMS | 不可变发布版本；帮助文章不替代交易现场协议 |

不接受客户端提交正文、金额、版本或“已同意”布尔作为授权依据。服务端只用已封存/已生效版本、本人身份、对象归属和同一事务内的动作记录。

## 服务端接受

- 统一接受台账：`zzsh_content.document_acceptance`（本人、文书类型、版本、摘要、适用对象、来源、服务端时间）。同键重复请求由唯一约束幂等；台账不可更新/删除。
- 业务接受同时保存在不可变订单快照或结算审计中；历史前缀明确未安装台账时可沿该业务证明执行，不补造台账行。平台登录/注册接受不使用此兼容路径；台账存在但写入失败必须传播失败并回滚业务事务，不能忽略权限或存储错误。
- 登录/注册：手机号注册/登录在创建会话的同一事务写入平台服务协议与隐私政策接受；密码登录在认证成功后由同一请求写入。平台文书尚未封存时保留旧 `acceptedTerms` 行为；两份文书只发布一份时失败关闭。
- 出租：既有 `zzsh_supply.rule_acceptance` 绑定号主、账号、发布版本、release 与内容摘要；不收窄。
- 租用：`POST /api/v2/orders` 必须携带与订单快照 `ruleRefs.agreementVersionId/agreementDigest` 一致的 `agreementAcceptance`；建单事务写入 `RENTAL_AGREEMENT` 接受。选择全额包赔时同事务写入 `FULL_PAYOUT_TERMS` 接受，版本/摘要取自已校验的包赔条款。
- 个人确认响应加性返回签名报价所用的`agreementAcceptance`引用，客户端展示的正文必须与该引用及release一致。
- 提前结算：只有新建单时冻结了 `agreementAcceptanceSchema=1` 与 `earlySettlementDisclosure` 的订单，提前提交/确认才要求 `termsAccepted=true`。说明正文、版本和摘要保存在原订单快照，金额另绑定本次结算哈希；同键不同接受字段不能重放为同一请求。此前已有的v2订单与历史订单保留原合同。该费用披露不代替尚待审阅的完整责任/免责条款。

## 接口

| 接口 | 用途 |
|---|---|
| `GET /api/v1/legal-documents/current` | 两份平台文书当前版本的摘要（无正文） |
| `GET /api/v1/legal-documents/terms`、`/privacy` | 公开阅读；可用`?version=...`读取已生效历史封存版本，不能读取草稿/未来版本；无当前版本返回`PENDING` |
| `POST /api/v1/admin/legal-documents/drafts` | Admin 新建草稿（`content.platform.edit`） |
| `PUT /api/v1/admin/legal-documents/drafts/{id}` | 修改草稿，要求 `expectedRevision` |
| `POST /api/v1/admin/legal-documents/drafts/{id}/seal` | 封存并设置生效时间（`content.platform.publish`） |
| `GET /api/v1/admin/legal-documents?docType=...` | Admin 版本列表 |

用户端读取 `apps/web/src/app/legal/[doc]`；登录表单经 `/api/legal-documents/current` 读取当前版本引用。Admin 维护入口在内容管理的“法律文书”分区；包赔条款在“规则与价目”页维护。

## 迁移与发布

- 正式迁移：`apps/api/migrations/business/0112_legal_documents.sql`，沿0000–0111前向追加。源码登记不表示目标库已经执行；schema与后置ACL均须核验。
- 先应用迁移再启用平台文书封存；旧库无该表时不得假设已有接受记录。
- 正式平台服务协议/隐私政策正文须由 Owner 审阅后创建草稿、封存并设置生效时间；过程草稿与未核事实不进入公开页。
- 已封存文书修正：新建草稿 → 审阅 → 封存 → 新版本生效；不修改历史接受或订单快照。
- 首次对外发布须安排两份平台文书同批生效；仅一份生效时登录/注册失败关闭。不得将单文书封存操作当作无中断的成对发布流程。
