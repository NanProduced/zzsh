# 用户供给表单数据契约

## 定价兼容 API（PC-1）

`haff-ratio-v1` 的声明、报价和内容摘要保持原结构。`haff-ratio-v2` 仅使用 SPREAD；现有价格版本保存 `compatibility.ordinary` 与 `compatibility.fast` 的 `spreadDelta` 和四档 `discounts`（STANDARD/VIP/SVIP/DISCOUNT_USER）。custom 共用 ordinary 参数。`compatibility.modes` 保存三种模式的 enabled；custom/fast 的 min/max 为 `{base:"C"|"ABSOLUTE",value:"精确十进制文本"}`。无生产默认参数。

新声明在既有 `attributes.rentalPricing` 保存 `{rentalMode:"ordinary"|"custom"|"fast",ownerRatioB?:"十进制文本"}`，`pricingOptionCode` 留空。ordinary 禁止提交 B，由服务端计算 C；custom/fast 必须提交范围内 B，空区间、缺值和非法分母拒绝，不夹值。C 由安全箱/体力/负重/日耗基础规则计算，未加入模式增量或皮肤加价。草稿、quote、payload 使用结构版本 2，模式及 B/P/V/C/tier 随冻结报价参与 hash、协议接受与发布事实；修改需重新报价确认。克隆旧版本不改写历史内容。

固定资源 `price_line.customerTier` 支持四档；同一物品的 owner 单价、单位数量与计价种类跨 tier 一致。缺某档价目不能回退。每行先按分 HALF_UP，再求两侧差额；六级子弹的60发/组沿既有单位合同；保险卡现有DAY实现与已确认按张规则的差异见下文，不作为新计价依据。

价格草稿全量保存时，原规则或请求规则为 v2 的每一行必须显式包含 `customerTier`；缺失返回400且不改变规则、revision、价目或成功审计。仅v1保留省略tier表示STANDARD的兼容。当前Admin编辑器将v2或多档价目逐档只读展示，关闭保存、封存和旧版演算；v1编辑不变。

发布与管理试算接口均由服务端指定 STANDARD，不接受客户端 tier。个人确认从服务端会员资格读取实际档位，缺对应价目不回退；DISCOUNT_USER 不引入免押。公开投影只含租客金额和 rentalMode，不含 owner 内价、平台利润或 pricingInputs。publishing-options 对 v2 返回 pricingSchema/rentalModes（只含启停与范围），不暴露 P/V。现有发布 UI 尚未提供 v2 模式编辑控件，不能将接口能力视为浏览器验收。

旧 v1 建单路径和成功幂等重放保持；新 v2 报价在旧建单入口返回 409 `PRICING_SCHEMA_UNSUPPORTED`。会员资格、个人确认凭据及新版建单已实现，见[个人确认合同](personal-confirmation.md)。正式声明、封存资金政策与保证金依据reader及核定API已接入；配置页面、推荐/披露接线、证明到期最终边界及独立包赔条款管理仍有缺口，缺依赖继续拒绝，不代表正式交易闭环已可用。

用户端发布页已接入现有供给API。API负责报价、资格和对象范围，前端按下列分组自由跳转，不建立另一套发布状态机；草稿、版本和生命周期仍以服务端为准。号主侧推荐押金由 `GET /accounts/{id}/deposit-recommendation` 按当前版本申报与正式 fundingPolicy 计算；成功时返回 `accountId/accountRevision/versionId/versionRevision/ruleReleaseId/priceVersionId` 与本次计算使用的规范化输入字段对象（`safeBoxCode/vitality/bear/dive/skinIds`），客户端必须与发起请求时的保存快照逐项比对，不匹配即标记过期且不提供采用；未配置政策或输入不足时返回 `available:false` 及原因，不返回猜测值。是否采用由号主决定，不会自动覆盖申报。Delta `attributes.full_payout_declaration` 可随号主声明保存为 `{schema:"full-payout-declaration-v1",selected:boolean}`，并参与现有内容 hash 与发布事实（历史审核流程保留真实决定）；字段缺省时继续省略，不改写旧 v1 hash。发布 UI 已提供普通/全额包赔申报控件（不自动勾选，最低金额以政策为准）；确认/账务的受控 test/fake 接线不代表正式配置或生产资金能力。

## 直接发布与公开事实（PUB-1/2）

账号版本保留原六种生命周期状态并增加 `PUBLISHED`。号主在报价、规则接受、资格、占用和媒体技术校验均通过后，`submit` 在同一事务内切换当前版本、写入唯一不可变的 `listing_publication` 事实并返回发布结果，不调用管理员 `decide`，也不生成管理员审核人或审核时间。发布事实绑定 `accountId`、`versionId`、`ownerUserId`、`gameId`、`ruleReleaseId`、`contentHash`、真实来源/操作者和数据库 `publishedAt`；来源为 `OWNER_DIRECT` 时版本必须为 `PUBLISHED`，号主操作者非空且与账号所有者一致。

历史公开版本只有能逐项匹配真实 `APPROVE` decision 的版本，才以 `LEGACY_APPROVED` 写入发布事实并继续保留 `APPROVED`、原审核人、原决定时间、hash 和 release。`SUBMITTED`、`REJECTED`、`IMPORTED_UNVERIFIED` 不因迁移或查询自动公开。暂停、运营限制、媒体隔离及恢复使用现有状态/审计，不新增发布事实，也不改变原 `publishedAt`；正文改版须重新报价、接受规则并发布新版本。

公开列表、详情、个人确认与建单只接受两种有效组合：`PUBLISHED + OWNER_DIRECT` 或 `APPROVED + LEGACY_APPROVED`，并按入口继续核身份、实名/成年、保证金、规则/hash和占用；个人确认与建单另核租客会员及锁内验证。`ACCOUNT_DISPLAY` 仅要求服务端技术校验、所有权/用途绑定和公开衍生文件完整；`ACCOUNT_EVIDENCE` 始终私有，草稿、非当前绑定和隔离媒体不可由公开读取路径获取。技术合格不等于人工内容审核通过。

| 分组 | 数据/写入 | 校验与恢复 |
|---|---|---|
| basics | 不要求号主输入标题或游戏内ID；description为可选公开备注，受控attributes与安全箱/等级按目录申报 | title保留内部兼容，允许为空；展示端为空时从当前版本资源和状态派生摘要。未知保留null，不默认0 |
| inventory | publishing-catalog.items的稳定itemId及HAFF_BASE/ROUND/PIECE/DAY数量文本 | inputScale=0；必填填数量或0，空值留草稿且不发送为库存行；未定价blockers阻止提交，不补价格 |
| skins | 可见分类树、q/categoryId/rarityCode、分页多选skinId | 搜索仅筛皮肤；未选择为未申报，不自动加价 |
| entitlements | 目录valueKind/expiryKind、声明值及已知到期时间 | 限时未知不形成承诺；报价失败定位entitlements |
| media | 账号展示图及处罚公示图均使用ACCOUNT_DISPLAY；其他已有ACCOUNT_EVIDENCE继续私有 | 绑定带assetId/position及可选category（SHOWCASE/PENALTY）。分类保存于当前版本attributes.media_categories并参与已有内容哈希，不改素材source_note；省略该键不改变旧声明的字节合同。公开媒体集合以封存payload为准，处罚图不能作为封面或替代必需展示图。SavedDeclaration附带用途/byteHash及只读公开状态；公开路由仍检查归属、版本、暂停/隔离及衍生文件 |
| rules | 当前租期/计价选项、权威OwnerQuote、对应封存协议正文 | quote→accept-rules→submit，确认绑定versionId/releaseId/contentHash和expectedRevision |

草稿创建/复制、保存、报价、接受/提交、撤回、暂停/恢复、我的账号和收藏已提供用户API调用封装。草稿允许不完整，提交后正文不可改；退回/撤回后新草稿。我的账号包含历史/审核原因与逐资产媒体状态；权限或资格不满足由blockers解释，公开收藏失效只显示通用不可用状态。公开列表`q`只搜标题，由服务端过滤全量结果；公开详情的安全箱/租期/每日消耗来自当前有效发布版本快照，缺值为null，不能写成“号主未申报”。

错误按稳定HTTP/code处理，不匹配服务端中文：400/413保留输入并按error.details[].path定位分组；401接登录并保留任务上下文；404显示不可用；403不绕过权限；409必须读取最新状态并重新确认，不能换key自动覆盖。网络结果未知的重试复用原key/body；supply-client不自动重试。未定位到字段的错误落在form层。

客户端只显示服务器金额，不据单位展示价重算，也不增加小时费、皮肤收费或收益保底。登录后的游客收藏合并使用逐项幂等收藏接口作为基础；游客存储、失效本地项提示、返回原页面和最终表单交互留在页面接入阶段，不向正式API填入假用户或商品。

公开资源按稳定code及quote.lines的unit/unitQuantity解释数量：6级子弹存ROUND，按60发计价；旧数据的组数只在导入时乘60一次，展示可同时标组与发。保险卡已确认按仓库卡片张数计费，不按有效天数；当前目录及测试仍有DAY/unitQuantity=1，属于待纠正实现，不能只改前端单位标签冒充已完成。单位纠偏须覆盖目录、价目、筛选、报价及结算输入；旧数据逐来源核定，不把未知DAY数量直接换成张数，不覆盖已冻结快照。目录回填只补展示快照缺失字段，不覆盖已有名称、单位或分类。

新申报的核价与发布要求体力、负重4–7，潜水0–3；草稿可不完整，历史读取仍保留null和原等级。可选体力/负重取有效计价map与4–7的交集。上号时段存Asia/Shanghai分钟及跨日标记，起点0–1439、终点0–1440，拒绝等起止；全天明确0/1440。30分钟是新控件步长，合法历史非半小时值不舍入。数量输入保留原文，非法整数或不能精确换算的M数量不能保存或核价。

新报价在可选`ruleRefs.catalogRevision`中绑定目录版本，并向报价投影提供该值；目录变化使未发布草稿的条款接受与发布失效，需重新核价。缺此绑定的旧草稿报价也需重新核价；已有历史payload不补字段、不重算hash，已发布版本不因这项新增绑定追改。

按张保险卡使用独立稳定身份`top_insure_card_piece`及PIECE/unitQuantity=1，展示“张”仅绑定该身份；旧DAY保持“天”，其他PIECE保持“件”。该新目录及价目需配置后才开放，不能以投影代码代替目录已激活。引用过的物品不能原地变更单位或quantityScale。Barrett消费ROUND基础发数、按每发计价，不套六级子弹的60发换算；coffee复用已有身份，名称来自目录。列表、详情、收藏复用动态资源行，摘要省略的资源须有完整详情入口。管理价格编辑保留四档行，缺价不回退，封存版保持只读。

账号列表及卡片的资源区按动态行完整呈现，Barrett和新卡不因排在原四项之后而被隐藏。已核恢复副本`la_rental_accounts`通过`convertLegacyDeltaInventory`按稳定code/单位/scale绑定目标ID：Barrett按原发数，六级弹组数×60一次；原`top_insure_card_num`在旧界面及费用输入中按天表达，绑定独立`df_billable_top_insure_card`/DAY历史身份，不绑定新按张卡。缺字段、缺目录、同义多ID和单位冲突保持待核状态；旧订单和冻结报价不走账号库存转换。新申报中不再报价的历史行只能由用户明确选择不纳入本次申报，来源观察与历史版本仍保留，新卡仓库张数须重新声明。

旧优惠用户`isDepositFree=3`在商品详情及列表调用VIP固定物品价，押金不清零；恢复初始价目时可据该来源建立显式DISCOUNT_USER行。各档后续独立配置，正式报价仍须精确命中本档，不能以此在缺价时自动回退VIP。

tenantPayableTotal只在该报价投影提供tenantDeposit时由服务端精确相加；公开/号主资源报价可保留两者为null，界面显示待确认，不当免押，也不能仅据此断言正式资金政策未配置。公开报价不是会员个性化订单最终确认金额。Haff比例仅用于展示，取该行原始数量和金额作整数精确舍入；缺行价不使用全部资源费替代。

发布页不使用无身份区分的sessionStorage草稿：首次保存先创建账号/草稿，刷新通过accountId读取服务端资料；身份切换或迟到响应会丢弃旧上下文。SavedDeclaration提供逐素材reviewState/publicDisplayEligible/publiclyReadable；前端分别展示审核结果、展示资格和当前公开状态，保存只裁剪assetId/position。

publishing-catalog.ready仅表示目录与生效价目配置齐备，不代表本人身份、保证金、占用或发布资格通过；是否能提交/恢复仍以M3-C服务端检查为准。

号主v2报价可返回`ownerHaffRatio`，直接取冻结`pricingInputs.compatibility.ownerRatioB`，表示每元对应的万哈夫币；公开报价不含该字段，不从已舍入金额反推原比例。客户端预计租期只显示服务端`termSeconds`，不增加可编辑租期或第二套计算。

发布页收入合计为号主侧哈夫与物品的扣费前金额，不包含基础租客押金，不预扣固定8%作净收入。基础押金显示号主当前申报，会员最终押金属于个人报价。发布保证金仅在服务端报价提供明确正金额要求时展示；NOT_REQUIRED/0和缺少金额不会自动增加费用行，后台原资格/UNKNOWN与证明校验仍保留。

封禁截图新增入口仅在`ban_record === true`时显示；未选择或明确无记录时不显示。切换选项不自动删除已有媒体或绑定；已有封禁截图可从保留提示展开管理，原公开/私有用途不变。拖入与选择文件共用输入和写锁检查，隐藏入口不改变服务端媒体资格或对象权限。

上架页进入时展示5秒最低阅读时间的操作须知，可再次查看；阅读仅关闭本地提示，不执行保存、核价、接受规则或发布。交易须知入口复用当前读取的出租协议正文并按纯文本展示，缺正文时禁用入口；阅读不自动接受报价或规则。Owner要求保留旧平台的本人脸、解脸双设备及银行卡提现提示；这些是操作要求，不表示本页已校验真实人脸或完成真实提现渠道接入，不改历史资格或资金命令。须知不引入其他平台的清仓或赔付承诺。站内链接、搜索和游戏切换通过同一应用弹窗确认未保存内容，包含尚未绑定目录的暂存资源；取消保留输入。刷新、关闭标签页等浏览器级离开仍使用`beforeunload`原生保护，不能定制其外观。未确定写入仍按原回执与写锁恢复，弹窗不解除锁。

离开保护还覆盖正在执行的操作与UNKNOWN写入，即使申报刚保存、不再dirty，或身份读取失败而私有表单已隐藏，仍保留通用恢复提示及原生卸载保护；原操作结果未确定前不能通过弹窗放弃并离开。已确认过身份后的guest回读留在本页暂停私有展示，避免自动跳转丢掉原意图；同身份恢复继续原key，实际换用户仍清除旧上下文。提示不显示私有资料，不生成新key或解除写锁。

发布写入发出前，必须在sessionStorage保留主体、游戏、账号、动作、原key及公开申报body；持久化失败阻止新写。网络/5xx不能证明上游未提交，UNKNOWN重挂后仍冻结原请求，同主体显式恢复原key/body；换人不读取或消费，年龄不删除未决责任。确定成功保存最小回执，回读失败与重挂仅GET，不再重发业务写。媒体File及上传token不存储，丢失File时保留原操作责任并说明不能重新上传；已知asset回执的用途和分类不改。

迟到成功回执只更新仍匹配的原主体/游戏/目标/动作/key/body/创建代次记录，不能覆盖其他意图或降级accepted。当前页面的ref、提示、恢复和解锁另须匹配原请求上下文代次及原意图；身份或对象已切换时，旧success/catch/finally不修改当前责任。恢复只消费匹配的原记录；不匹配、跨主体或无File的no-op不能当作恢复成功并解除锁。

绝密KD输入保留原文，负值、非数字、超过100不能保存或核价；合法小数、空值及历史原值不静默截断或清洗。公开详情主图库、缩略图、计数、预览共用非PENALTY集合；处罚图独立公示，全部为处罚图时不冒充普通主图。

发布与我的账号、收藏订阅根用户会话；身份未确认时隐藏私有视图并暂停后续写步骤，同用户恢复保留上下文，实际换身份才失效。页面查询、草稿和上传操作代次独立于会话身份代次。Admin仍可按原权限查看和处理媒体；`ACCOUNT_DISPLAY` 的公开资格来自技术校验与有效发布事实，不要求人工预审，`ACCOUNT_EVIDENCE` 只允许私有访问。服务端仍执行完整权限、用途、对象归属和隔离校验。
