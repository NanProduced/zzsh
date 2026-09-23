# 用户供给表单数据契约

## 定价兼容 API（PC-1）

`haff-ratio-v1` 的声明、报价和内容摘要保持原结构。`haff-ratio-v2` 仅使用 SPREAD；现有价格版本保存 `compatibility.ordinary` 与 `compatibility.fast` 的 `spreadDelta` 和四档 `discounts`（STANDARD/VIP/SVIP/DISCOUNT_USER）。custom 共用 ordinary 参数。`compatibility.modes` 保存三种模式的 enabled；custom/fast 的 min/max 为 `{base:"C"|"ABSOLUTE",value:"精确十进制文本"}`。无生产默认参数。

新声明在既有 `attributes.rentalPricing` 保存 `{rentalMode:"ordinary"|"custom"|"fast",ownerRatioB?:"十进制文本"}`，`pricingOptionCode` 留空。ordinary 禁止提交 B，由服务端计算 C；custom/fast 必须提交范围内 B，空区间、缺值和非法分母拒绝，不夹值。C 由安全箱/体力/负重/日耗基础规则计算，未加入模式增量或皮肤加价。草稿、quote、payload 使用结构版本 2，模式及 B/P/V/C/tier 随冻结报价参与 hash、协议接受和审核；修改需重新报价确认。克隆旧版本不改写历史内容。

固定资源 `price_line.customerTier` 支持四档；同一物品的 owner 单价、单位数量与计价种类跨 tier 一致。缺某档价目不能回退。每行先按分 HALF_UP，再求两侧差额；60 发/组和 DAY 数量沿既有单位合同。

价格草稿全量保存时，原规则或请求规则为 v2 的每一行必须显式包含 `customerTier`；缺失返回400且不改变规则、revision、价目或成功审计。仅v1保留省略tier表示STANDARD的兼容。当前Admin编辑器将v2或多档价目逐档只读展示，关闭保存、封存和旧版演算；v1编辑不变。

发布与管理试算接口均由服务端指定 STANDARD，不接受客户端 tier。其他档位目前仅为纯计算能力；DISCOUNT_USER 不引入免押。公开投影只含租客金额和 rentalMode，不含 owner 内价、平台利润或 pricingInputs。publishing-options 对 v2 返回 pricingSchema/rentalModes（只含启停与范围），不暴露 P/V。现有发布 UI 尚未提供 v2 模式编辑控件，不能将接口能力视为浏览器验收。

旧 v1 建单路径和成功幂等重放保持；新 v2 报价在旧建单入口返回 409 `PRICING_SCHEMA_UNSUPPORTED`。会员权威资格、个人确认凭据及新版建单属于 PC-2，当前没有接通会员交易。

用户端发布页已接入现有供给API。API负责报价、资格和对象范围，前端按下列分组自由跳转，不建立另一套发布状态机；草稿、版本和生命周期仍以服务端为准。Delta `attributes.full_payout_declaration` 可随号主声明保存为 `{schema:"full-payout-declaration-v1",selected:boolean}`，并参与现有内容 hash 与审核决定；字段缺省时继续省略，不改写旧 v1 hash。发布 UI 尚无此控件；确认/账务的受控 test/fake 接线不代表正式配置或生产资金能力。

## 直接发布与公开事实（PUB-1/2）

账号版本保留原六种生命周期状态并增加 `PUBLISHED`。号主在报价、规则接受、资格、占用和媒体技术校验均通过后，`submit` 在同一事务内切换当前版本、写入唯一不可变的 `listing_publication` 事实并返回发布结果，不调用管理员 `decide`，也不生成管理员审核人或审核时间。发布事实绑定 `accountId`、`versionId`、`ownerUserId`、`gameId`、`ruleReleaseId`、`contentHash`、真实来源/操作者和数据库 `publishedAt`；来源为 `OWNER_DIRECT` 时版本必须为 `PUBLISHED`，号主操作者非空且与账号所有者一致。

历史公开版本只有能逐项匹配真实 `APPROVE` decision 的版本，才以 `LEGACY_APPROVED` 写入发布事实并继续保留 `APPROVED`、原审核人、原决定时间、hash 和 release。`SUBMITTED`、`REJECTED`、`IMPORTED_UNVERIFIED` 不因迁移或查询自动公开。暂停、运营限制、媒体隔离及恢复使用现有状态/审计，不新增发布事实，也不改变原 `publishedAt`；正文改版须重新报价、接受规则并发布新版本。

公开列表、详情、个人确认与建单只接受两种有效组合：`PUBLISHED + OWNER_DIRECT` 或 `APPROVED + LEGACY_APPROVED`，并继续执行身份、实名/成年、会员、保证金、规则/hash、占用和锁内重验。`ACCOUNT_DISPLAY` 仅要求服务端技术校验、所有权/用途绑定和公开衍生文件完整；`ACCOUNT_EVIDENCE` 始终私有，草稿、非当前绑定和隔离媒体不可由公开读取路径获取。技术合格不等于人工内容审核通过。

| 分组 | 数据/写入 | 校验与恢复 |
|---|---|---|
| basics | title、description、受控attributes；safe_box_code及允许等级来自publishing-options | 错误path为title/description/attributes；未知保留null，不默认0 |
| inventory | publishing-catalog.items的稳定itemId及HAFF_BASE/ROUND/PIECE/DAY数量文本 | inputScale=0；必填填数量或0，空值留草稿且不发送为库存行；未定价blockers阻止提交，不补价格 |
| skins | 可见分类树、q/categoryId/rarityCode、分页多选skinId | 搜索仅筛皮肤；未选择为未申报，不自动加价 |
| entitlements | 目录valueKind/expiryKind、声明值及已知到期时间 | 限时未知不形成承诺；报价失败定位entitlements |
| media | 明确ACCOUNT_DISPLAY与ACCOUNT_EVIDENCE；上传意图→原始字节上传→assetId绑定 | 写入只带assetId/position；SavedDeclaration额外purpose/byteHash以及只读`reviewState`/`publicDisplayEligible`/`publiclyReadable`；editableDeclaration只裁`assetId/position`。`publicDisplayEligible`是素材公开展示资格；`publiclyReadable`是当前公开路由会放行（含账号未暂停、当前公开版本绑定）。暂停、撤权、草稿独有图或私有凭证为false。不要用版本APPROVED推断已公开 |
| rules | 当前租期/计价选项、权威OwnerQuote、对应封存协议正文 | quote→accept-rules→submit，确认绑定versionId/releaseId/contentHash和expectedRevision |

草稿创建/复制、保存、报价、接受/提交、撤回、暂停/恢复、我的账号和收藏已提供用户API调用封装。草稿允许不完整，提交后正文不可改；退回/撤回后新草稿。我的账号包含历史/审核原因与逐资产媒体状态；权限或资格不满足由blockers解释，公开收藏失效只显示通用不可用状态。公开列表`q`只搜标题，由服务端过滤全量结果；公开详情的安全箱/租期/每日消耗来自当前公开审核版本快照，缺值为null，不能写成“号主未申报”。

错误按稳定HTTP/code处理，不匹配服务端中文：400/413保留输入并按error.details[].path定位分组；401接登录并保留任务上下文；404显示不可用；403不绕过权限；409必须读取最新状态并重新确认，不能换key自动覆盖。网络结果未知的重试复用原key/body；supply-client不自动重试。未定位到字段的错误落在form层。

客户端只显示服务器金额，不据单位展示价重算，也不增加小时费、皮肤收费或收益保底。登录后的游客收藏合并使用逐项幂等收藏接口作为基础；游客存储、失效本地项提示、返回原页面和最终表单交互留在页面接入阶段，不向正式API填入假用户或商品。

公开资源按稳定code及quote.lines的unit/unitQuantity解释数量：6级子弹存ROUND，按60发计价；旧数据的组数只在导入时乘60一次，展示可同时标组与发。顶级保险体验卡使用DAY、unitQuantity=1，不乘账号租期、不由数量推断激活或到期。目录回填只补展示快照缺失字段，不覆盖已有名称、单位或分类。

tenantPayableTotal由服务端将当前resourceTotal与tenantDeposit精确相加；押金未配置时为null，界面显示待确认，不当免押。公开报价不是会员个性化订单最终确认金额。Haff比例仅用于展示，取该行原始数量和金额作整数精确舍入；缺行价不使用全部资源费替代。

发布页不使用无身份区分的sessionStorage草稿：首次保存先创建账号/草稿，刷新通过accountId读取服务端资料；身份切换或迟到响应会丢弃旧上下文。SavedDeclaration提供逐素材reviewState/publicDisplayEligible/publiclyReadable；前端分别展示审核结果、展示资格和当前公开状态，保存只裁剪assetId/position。

publishing-catalog.ready仅表示目录与生效价目配置齐备，不代表本人身份、保证金、占用或审核资格通过；是否能提交/恢复仍以M3-C服务端检查为准。

发布与我的账号、收藏订阅根用户会话；身份未确认时隐藏私有视图并暂停后续写步骤，同用户恢复保留上下文，实际换身份才失效。页面查询、草稿和上传操作代次独立于会话身份代次。Admin仍可按原权限查看和处理媒体；`ACCOUNT_DISPLAY` 的公开资格来自技术校验与有效发布事实，不要求人工预审，`ACCOUNT_EVIDENCE` 只允许私有访问。服务端仍执行完整权限、用途、对象归属和隔离校验。
