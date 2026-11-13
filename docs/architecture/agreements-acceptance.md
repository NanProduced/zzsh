# 协议、规则披露与接受

本页记录当前协议与交易规则的**契约边界**，不包含正式对外法律文本。正式文本是否发布以数据库中的封存版本为准。

## 文书来源

| 文书 | 存储 | 版本规则 |
|---|---|---|
| 平台服务协议 / 用户隐私政策 | `zzsh_content.legal_document_version` | `DRAFT → SEALED`；封存后不可原地修改；按 `effective_at` 取当前版本。该表不替代 CMS：平台文书无游戏范围，但需要封存/生效/摘要接受语义 |
| 出租协议 | `zzsh_supply.agreement_version` | Plate 草稿/封存，绑定 `rule_release`。历史纯文本版本保留原摘要 |
| 全额包赔条款 | `zzsh_supply.full_payout_terms_version` | Plate 草稿/封存，价格版本通过 `policyRef / policyVersion / disclosureVersion` 引用。历史纯文本版本保留原摘要 |
| 提前结算告知 | `zzsh_content.legal_document_version` | Plate 编辑、审批、封存。新规则组合保存已生效告知的版本和摘要 |
| 帮助与公告 | `zzsh_content` 既有 CMS | 不可变发布版本；帮助文章不替代交易现场协议 |

不接受客户端提交正文、金额、版本或“已同意”布尔作为授权依据。服务端只用已封存/已生效版本、本人身份、对象归属和同一事务内的动作记录。

## 服务端接受

- 统一接受台账：`zzsh_content.document_acceptance`（本人、文书类型、版本、摘要、适用对象、来源、服务端时间）。同键重复请求由唯一约束幂等；台账不可更新/删除。
- 业务接受同时保存在不可变订单快照或结算审计中；历史前缀明确未安装台账时可沿该业务证明执行，不补造台账行。平台登录/注册接受不使用此兼容路径；台账存在但写入失败必须传播失败并回滚业务事务，不能忽略权限或存储错误。
- 登录/注册：手机号注册/登录在创建会话的同一事务写入平台服务协议与隐私政策接受；统一密码登录入口将引用透传给同一手机号认证事务。会话与两份接受全部提交后才发Cookie；接受存储失败不遗留已提交会话。平台文书尚未封存时保留旧输入兼容（注册仍要求 `acceptedTerms`）；两份文书只发布一份时失败关闭，版本变化须重新确认。
- 出租：既有 `zzsh_supply.rule_acceptance` 绑定号主、账号、发布版本、release 与内容摘要；不收窄。
- 租用：`POST /api/v2/orders` 必须携带与订单快照 `ruleRefs.agreementVersionId/agreementDigest` 一致的 `agreementAcceptance`；建单事务写入 `RENTAL_AGREEMENT` 接受。选择全额包赔时同事务写入 `FULL_PAYOUT_TERMS` 接受，版本/摘要取自已校验的包赔条款。
- 个人报价预览返回发布版本实际适用的包赔条款及 Plate 正文。签名确认返回冻结的出租协议正文，客户端按 `agreementAcceptance` 核对版本与摘要后确认。Plate 正文加载期间或失败时暂停对应确认。
- 提前结算：新单从上架冻结的规则组合取得告知，订单快照 `agreementAcceptanceSchema=2` 只保存告知版本与摘要。提前结束申请及提前结算确认时，按该引用读取已封存正文并校验摘要。核验失败暂停确认。审计记录确认主体、时间、文书版本与摘要，以及本次申请标识或结算版本及哈希。既有 `agreementAcceptanceSchema=1` 订单继续核验原快照正文和摘要。迁入旧平台订单保留来源已有的事实。
- 已存在且无告知绑定的规则组合保留原记录。新的上架交易启用前须先发布告知并创建包含该告知的规则组合。新的规则组合对既有上架冻结依据无追溯效力。

## 接口

| 接口 | 用途 |
|---|---|
| `GET /api/v1/legal-documents/current` | 两份平台文书当前版本的摘要（无正文） |
| `GET /api/v1/legal-documents/terms`、`/privacy` | 公开阅读；可用`?version=...`读取已生效历史封存版本，不能读取草稿/未来版本；无当前版本返回`PENDING` |
| `POST /api/v1/admin/legal-documents/drafts` | Admin 新建草稿（`content.platform.edit`） |
| `PUT /api/v1/admin/legal-documents/drafts/{id}` | 修改草稿，要求 `expectedRevision` |
| `POST /api/v1/admin/legal-documents/drafts/{id}/seal` | 封存并设置生效时间（`content.platform.publish`） |
| `GET /api/v1/admin/legal-documents?docType=...` | Admin 版本列表 |

用户端读取 `apps/web/src/app/legal/[doc]`；登录表单经 `/api/legal-documents/current` 读取当前版本引用。Admin 在内容管理的「协议与告知」维护文书正文，在「规则与价目」安排规则组合生效。

## 迁移与发布

- 文书台账与 Plate 结构由 0112、0206 和 0220 等正式迁移安装。发布前核对目标库迁移账和运行角色权限。
- 先应用迁移再启用平台文书封存；旧库无该表时不得假设已有接受记录。
- 正式平台服务协议/隐私政策正文须由 Owner 审阅后创建草稿、封存并设置生效时间；过程草稿与未核事实不进入公开页。
- 已封存文书修正：新建草稿 → 审阅 → 封存 → 新版本生效；不修改历史接受或订单快照。
- 首次对外发布须安排两份平台文书同批生效；仅一份生效时登录/注册失败关闭。不得将单文书封存操作当作无中断的成对发布流程。
