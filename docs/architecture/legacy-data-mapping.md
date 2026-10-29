# 旧数据转换与字段映射

规则版 `1.3.2`（2026-10-19，明确附加皮肤持有集合的共同读取优先级）；2026-10-20补齐皮肤目录字段说明，持有转换规则未变。本页记录当前转换语义及双端消费边界；规则存在、批次已执行、真实接口/页面已验收分别核定。旧行为与新政策差异见[业务对照](legacy-business-behavior-diff.md)，不以页面展示成功代替迁移对账。

## 共同约束

资金领域的来源/目标/覆盖、期初余额与历史观察、旧退款/佣金责任承接矩阵见[支付与资金领域规格](payments-and-funds.md#7-新旧资金承接矩阵)。下表保留源列与稳定规则ID；转换代码、实际批次采用和渠道到账分别验收。

- 物理MySQL列、提取JSON别名、派生证据分列。无法确证的源列保留待核，不由camelCase属性猜旧列；下表没有列出的字段仍须沿所属域提取/转换合同核对，不能直接丢弃。
- 源ID按字符串保留，主外键通过`(source_system, source_entity, legacy_id)`与已核主体映射解析；多态订单再保留来源类型，不能按相同数字ID连接。重复、缺失或错误映射隔离。
- 元金额按十进制文本精确转整数分，账务不用浮点。单价保原精度，经正式报价/计算后再按对应合同落分；不得用`Number*100`、预先截两位或隐式舍入掩盖误差。DTO沿精确CNY金额合同。
- 原Unix秒、null/零时间与目标UTC时点分别记录；新合同支持微秒的地方不降为毫秒。展示时区不改变原生效时间，不以导入日重启期限。
- 合法零、合法空、缺源、隔离、未授权、失败及渠道UNKNOWN保持区别。源行摘要、文件SHA、映射/展示摘要及结果摘要对应不同对象，不能互换或为对齐而覆盖原件。

## 源字段到目标及页面

规则ID保持稳定；表内目标未写schema时沿该行明确的域前缀。读取均经API及BFF，客户端不重算业务规则。

| 规则ID | MySQL源字段及转换 | PostgreSQL目标与双端消费 |
| --- | --- | --- |
| IO-ID-01/02 | `la_user.id/mobile/nickname/is_delete/is_disable`；确定性`legacyOwnerUserId`映射，删除优先CANCELLED、停用→FROZEN（0103 前为DEACTIVATED）。旧实名事实不冒充新渠道核验，未知年龄不补成年。 | `zzsh_auth_user."user"`、`zzsh_iam.user_identity_state`及迁移审计；本人身份接口→账户/安全页，Admin用户目录。源口令及旧token不进入公开DTO。 |
| IO-ID-04/05 | `la_system_auth_admin/role/perm/menu`的人员、角色、菜单关系保来源；旧菜单ID不直接成为新权限。 | 管理realm独立；`zzsh_iam.admin_user_role/admin_role_permission/admin_user_permission`及`zzsh_supply.admin_supply_scope`按受审映射。Admin导航或按钮可见不构成授权，旧人员提取不等于已建新身份/授权。 |
| SUP-SOURCE-001/002 | `la_rental_accounts.id/user_id/game_id`核目标关联；同一13列原行重算原12列投影及含`is_full_payout`的摘要，flag只接受原0/1。 | `zzsh_supply.rental_account`、`legacy_supply_map`及不可变read/display snapshot；包赔声明另写`listing_version.attributes`，不伪造号主接受。用户列表/详情/上架与Admin监管复用同源绑定。 |
| SUP-QTY-004/005 | `haff`的恢复M数量×1000000一次；`level6_bullet_num`原组数×60一次；AWM/Barrett保发数，甲/盔/咖啡保件数。已归一化base输入不能再乘。 | `zzsh_supply.legacy_listing_display_snapshot.snapshot.resources`、正式`inventory_line(version_id,item_id).quantity`绑定`billable_item`单位；卡片/详情/上架与Admin目录/价格。旧订单实际消耗另走订单合同。 |
| SUP-QTY-006 | `top_insure_card_num`新旧均为天；保原数，不换张、不乘租期。 | `billable_item.code=df_billable_top_insure_card,unit=DAY`及库存；报价每1天、结算按确认天数差。错误PIECE身份不得用于新交易，历史引用不按现目录追改。 |
| SUP-ATTR-007/008 | `insure_lv/grading_lv/login_way/vit_lv/bear_lv/dive_lv/character_lv/secret_kd`按显式枚举/精度映射；`processing_time_start/end`转可证时段，未知不补全天；风险与公开属性分开。 | display snapshot及正式`listing_version.attributes`；`publishing-options`与公共attributeDisplay→详情/上架，Admin监管/目录。真实箱码不能被测试box-a/b代替；后台风险事实不外泄。 |
| SUP-MODE-009/PRICE-011/TERM-012 | `ratio_type`映ordinary/custom/fast；custom/fast的B只取已证`base_bot`，不反推。历史`price_tenant/extra_goods_total_price_tenant/deposit_amount/rental_days`保原义，不造当前价。 | 当前价须由`zzsh_supply.price_version/price_line`、`term_option`和受审release/政策构成；`saveListingDraft→quoteListing→确认/建单`消费。Web显示服务器报价；Admin规则与双边价。旧四档计价枚举不是新会员产品。 |
| SUP-DISPLAY-018 | 历史快照中已冻结的哈夫币base数量与该行租金可作展示折算；用整数精确计算、沿既有HALF_UP显示万/元，零租金或缺数量保持未知。 | `historicalQuote.haffRent`只供HAFF_BASE行的展示参考，不用物资合计/押金，不代表已取回原`base_bot`或`ownerRatioB`。不写回源快照/历史单价，不参与报价或结算。当前承接输入未提供逐项物资价，不能外推原MySQL不存在该事实；后续补源仍须证明有效时点，不能拿现行价或合计分摊。 |
| SUP-CATALOG-013/MEDIA-017 | `la_dict_type/la_dict_data`保资源/皮肤字典身份；`knife_skin/agent_skin/weapon_skin/gold_skin`是持有声明，不等于新skinId。原图URL/path不证明目标asset字节或归属。 | `zzsh_supply.billable_item/skin/listing_skin`分别保存字典和持有关系；媒体须另核sourceRef→`media_asset`→`listing_media`。无图不造URL，私有凭证不作封面；ECS文件迁OSS与数据库字段转换分别验收，发布媒体门禁仍有效。 |
| SUP-SKIN-019 | 旧红皮/金皮分组只留来源对照，不推导类型或品质。类型使用已核ownerKind，三角洲近战作为独立外观，不创建刀型父级；品质取同游戏字典并区分官方/平台参考依据，未知保持null。典藏与默认状态独立，不自动加价。目录配图不证明账号持有，持有仍须来源声明→skinId映射。 | 复用`skin.owner_kind/owner_id/firearm_id/rarity_code`及`skin_owner/firearm/skin_rarity`，新增品质证据、典藏、默认状态和图片来源。公开摘要为`ownerKind/rarityCode/rarityName/rarityBasis/isCollectible/defaultState`；新报价冻结本次摘要，旧冻结快照不补写缺失字段。新/改绑品质须启用品质及显式证据，无关编辑可保留旧停用品质或缺证据值。公开图片仍核同游戏、审核、衍生图及分类祖先；展示与推荐政策不改写历史资金事实。 |
| SUP-VIS-014 / SUP-NUM-015 v2 | `status/is_delete/update_time`保冻结来源租态；`no`只作为内部旧号alias，保前导零。公开查看、当前可租、本人本次可交易分开。 | `rental_account.display_no`新发`ZZYYYYMMDDNNNNNN`；`zzsh_supply.account_display_no_counter`按数据库上海日期原子计数，经`next_dated_account_display_no()`与账号同事务持久分配。旧已发AC仅兼容读取/重放，不清号；缺新增能力拒绝新发。旧账号先公开准入集合，其余首次准入时发，原生仍创建时发。用户不回退旧alias，Admin可内部解析，发号不提升资格，见[可见性与编号](account-visibility.md)。 |
| IO-ORD-01…08 | `la_order.id/order_sn/accounts_id/sale_user_id/user_id`及金额、状态、原时间分别核绑定；`order_sn`原单号与账号canonical号独立。 | `zzsh_order.legacy_order_read_snapshot`保存来源、双方、金额和时间；不伪造原生付款。统一列表/历史详情与Admin订单读按角色授权；不可读账号不泄旧号/当前私有标题，见[用户旧单](user-legacy-orders.md)。 |
| IO-CONT-01…07 | 原订单实耗参数、退款/暂扣及多态分销来源按原规则和证据计算；calc provenance、输入与结果血缘分列。 | `zzsh_order.legacy_continuation_evidence/version`及head，结果不覆盖原快照；续办命令绑定同版计划/身份/权限，处置delta不清既有金额，版本/责任/CAS/幂等/审计同事务，见[旧单续办](legacy-trade-continuation.md)。 |
| IO-LIAB-18/01/06/61 | 完成未退、暂扣、已没收、存在退款源记录分别核定；`is_settle`和退款记录不等于新渠道成功。 | `zzsh_order.legacy_order_duty`：前两类净退款PENDING；暂扣不是号主没收款；既有没收为不可重复支付的LEGACY_RECORDS终态；退款记录类只审计、无duty。订单完成、责任建立、财账入账、渠道到账分别展示。 |
| IO-COM-162/208 | 在途佣金由真实confirm终定金额与成熟时点；完成父单用原终金额及完成/成熟证据。原`la_distribution_order`比例/金额/受益人不由新政策反推。 | `zzsh_order.legacy_order_duty/admission`；COMPLETED_AT只加原7天一次，MATURES_AT直接用，切换日不重起。原已结/作废不重付；后台财账权威写SETTLED，不因收益页出现记录称已到账。 |
| GF-GROWTH-003 / GF-CANCEL-004 / GF-CORRECTION-005 / GF-COVERAGE-006 | 已确认租费、物资实耗、合法补足才计成长；押金/收益/佣金等排除。`expend_pay_money`是物资预收，未履约全额退款三链闭合且无实耗测量才作零消费排除。 | `zzsh_iam.membership_growth_contribution`及不可变`membership_growth_legacy_coverage`；按经济源有效更正合并，整数分汇总后换积分。本人`membership-growth[/consumption]`→会员中心累计/90天，Admin同主体依据；缺完整覆盖不补0，见[成长合同](membership-growth.md)。 |
| GF-MEMBER-002 / GF-CREDIT-007 | 旧四档人工资格不自动变新成长等级或礼遇；初始信用100是新政策，不从旧等级/余额折算。 | 新等级按成长，`zzsh_iam.membership_entitlement`独立审批/期限/范围；`zzsh_credit.user_credit_state/credit_event`沿既有初始化runner，保留已有档案。会员/信用/保证金各自事实独立，见[信用与保证金](credit-guarantee.md)。 |
| GF-HISTORY-008/OPENING-009 | `la_log_earnings.change_amount/left_amount/action`分别为变动元额/历史余额/方向；提取`amount/leftAmount`是别名。`la_user.earnings`受审映可用期初，`money`不相加。 | `zzsh_order.personal_finance_observation`与coverage保观察；`finance_opening_basis/finance_economic_root/finance_covered_event/finance_observation_admission`核期初覆盖；实际账务走event/ledger。Web钱包/收益、Admin财务读取overlay，历史观察不再次入账。 |
| GF-WITHDRAW-010/DISTRIBUTION-011 | `la_withdraw_apply`金额/费用/旧状态/时间保原；`la_distribution`资格、邀请关系与6级比例保原文本，旧FLOAT不经parseFloat近似。 | 提现仅历史观察、不再扣款，渠道UNKNOWN；新分销政策/资格/关系与历史佣金分别准入。Web本人条款/收益/提现与Admin分销/财务不把旧状态当新渠道成功，用户不获全局比例表。 |

后补皮肤持有采用规则 `SUP-SKIN-020`：服务端受信上下文绑定封存四列、来源截点、来源与目标摘要、映射规则及目录版本，写入前重算完整集合，并核对实际账号和观察版本。附加事实保存在 `zzsh_supply.legacy_skin_holding`，不修改不可变观察的子表；合法空集合覆盖旧关联，缺列、歧义或未核词条保持未知。同观察版本存在附加持有事实时，公开详情、ANY/ALL筛选与新草稿继承共同采用该完整集合（含合法空）；不存在时才回退原listing_skin，原生版本仍读取自身关系。新草稿后续按正常声明合同编辑；目录配图仍不证明持有。数据库约束和运行权限须随对应迁移部署，不能只更新读取代码。

既有9项来源歧义（影锋、AUG-气象感应、K416-命运、M4棱镜攻势、M7棱镜攻势、QBZ95-王牌之剑、SCAR-电玩、Vctor-冲锋枪-美杜莎、腾龙-气象感应）继续按`SOURCE_AMBIGUOUS`阻止持有准入。`buildLegacySkinIndex/mapLegacySkinHolding`优先保留该来源规则；目录后来VERIFIED、补图或修名都不能自动解除歧义，跨字段同名仍是不同source tuple。

受控旧目录身份确认经`confirmLegacySkinIdentity`服务入口：本地已审artifact引用、SHA和`legacyCatalogRecordDigest`绑定code、原source tuple及owner/baseName。三角洲独立近战必须显式传`ownerRef:null`、`ownerKind:"MELEE_TYPE"`和纯baseName；record包含`ownerId:null`，displayName即baseName，不查询、创建或重新启用刀型父级。`importLegacySkinOwner`拒绝三角洲MELEE_TYPE父级导入；其他游戏MELEE_TYPE及AGENT/FIREARM同游戏所属约束保持。旧父级封包不得改算、重签或静默解释为独立模型；历史读取、原封包恢复与新写准入分别处理。

机械改名沿同一入口的显式normalization：记录再绑定`previousBaseName`，要求VERIFIED、所属不变、旧base逐字匹配和预期catalogRevision。版本检查/CAS及审计在调用方原事务内完成，仅改名称/基础名/aliases并保留旧name及全部aliases，不改所属、来源、可见状态、历史观察、持有映射或冻结旧快照。审计失败须随调用方事务回滚；源码支持不等于实际转换或真实数据库验收，也不将本地差集称为官方命名证明。

## 旧公共内容（CONTENT-HISTORY-020）

`la_article` 的 `cid/title/intro/summary/content/image/is_show/is_delete` 与 `la_article_category` 的名称、启停和删除状态分别保留来源关系；正文按原字节及摘要封存，不能截断，也不能把 HTML 当代码执行。文章已删除、文章隐藏、分类隐藏和未观察到正文分别记录，不能混为当前合法空。

新帮助中心以受控的现行规则内容为来源，旧提现、费率、分销、履约、安全及免责文章不自动成为新订单条款。旧帮助分类也不直接改成原生公告或资讯类型。需要承接的正文须逐项核对用途及现行规则，经正常内容草稿、发布和媒体审核链处理；未核内容按具体原因隔离并保留原件，不计为已迁入或已公开。关联新的帮助路由仅是规则对照，不代表旧正文或分类已写入 PostgreSQL。

## 变更与验收对照

每次转换变更记录稳定规则ID、前后版本、真实源表/列及单位、原因/裁定、目标表、DTO/BFF和双端消费者；明确受影响集合、需重派生/补迁/不可变更正的范围。只有布局或文案变动时明确“转换规则未变”，不能顺手重算旧金额或修改源快照。

实际批次保留其原输入/源SHA与截止点、规则版本、源码/构建、目标资源/结构、对象集合、权限、key/body指纹、执行与验收回执；已冻结原件及UNKNOWN不覆盖。新规则不能追认成旧批已采用，更正也不通过换key掩盖未知提交。

按领域分别对账：源总量＝已映射＋隔离＋未处理；行数、经济责任、金额与单位另核。接口/页面还须核列表/详情一致、本人/他人边界、未知与合法空、正常写回/原键重放/异体冲突。目录存在、样本通过、代码或离线断言均不等于全量迁移、真实锁/并发或渠道验收。
