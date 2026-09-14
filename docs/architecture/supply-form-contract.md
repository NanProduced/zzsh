# 用户供给表单数据契约

用户端发布页已接入现有供给API。API负责报价、资格和对象范围，前端按下列分组自由跳转，不建立另一套发布状态机；草稿、版本和生命周期仍以服务端为准。

| 分组 | 数据/写入 | 校验与恢复 |
|---|---|---|
| basics | title、description、受控attributes；safe_box_code及允许等级来自publishing-options | 错误path为title/description/attributes；未知保留null，不默认0 |
| inventory | publishing-catalog.items的稳定itemId、基础币/颗/件整数数量文本 | inputScale=0；必填填数量或0，空值留草稿且不发送为库存行；未定价blockers阻止提交，不补价格 |
| skins | 可见分类树、q/categoryId/rarityCode、分页多选skinId | 搜索仅筛皮肤；未选择为未申报，不自动加价 |
| entitlements | 目录valueKind/expiryKind、声明值及已知到期时间 | 限时未知不形成承诺；报价失败定位entitlements |
| media | 明确ACCOUNT_DISPLAY与ACCOUNT_EVIDENCE；上传意图→原始字节上传→assetId绑定 | 写入只带assetId/position；SavedDeclaration额外purpose/byteHash以及只读`reviewState`/`publicDisplayEligible`/`publiclyReadable`；editableDeclaration只裁`assetId/position`。`publicDisplayEligible`是素材公开展示资格；`publiclyReadable`是当前公开路由会放行（含账号未暂停、当前公开版本绑定）。暂停、撤权、草稿独有图或私有凭证为false。不要用版本APPROVED推断已公开 |
| rules | 当前租期/计价选项、权威OwnerQuote、对应封存协议正文 | quote→accept-rules→submit，确认绑定versionId/releaseId/contentHash和expectedRevision |

草稿创建/复制、保存、报价、接受/提交、撤回、暂停/恢复、我的账号和收藏已提供用户API调用封装。草稿允许不完整，提交后正文不可改；退回/撤回后新草稿。我的账号包含历史/审核原因与逐资产媒体状态；权限或资格不满足由blockers解释，公开收藏失效只显示通用不可用状态。公开列表`q`只搜标题，由服务端过滤全量结果；公开详情的安全箱/租期/每日消耗来自当前公开审核版本快照，缺值为null，不能写成“号主未申报”。

错误按稳定HTTP/code处理，不匹配服务端中文：400/413保留输入并按error.details[].path定位分组；401接登录并保留任务上下文；404显示不可用；403不绕过权限；409必须读取最新状态并重新确认，不能换key自动覆盖。网络结果未知的重试复用原key/body；supply-client不自动重试。未定位到字段的错误落在form层。

客户端只显示服务器金额，不据单位展示价重算，也不增加小时费、皮肤收费或收益保底。登录后的游客收藏合并使用逐项幂等收藏接口作为基础；游客存储、失效本地项提示、返回原页面和最终表单交互留在页面接入阶段，不向正式API填入假用户或商品。

发布页不使用无身份区分的sessionStorage草稿：首次保存先创建账号/草稿，刷新通过accountId读取服务端资料；身份切换或迟到响应会丢弃旧上下文。SavedDeclaration提供逐素材reviewState/publicDisplayEligible/publiclyReadable；前端分别展示审核结果、展示资格和当前公开状态，保存只裁剪assetId/position。

publishing-catalog.ready仅表示目录与生效价目配置齐备，不代表本人身份、保证金、占用或审核资格通过；是否能提交/恢复仍以M3-C服务端检查为准。

发布与我的账号、收藏订阅根用户会话；身份未确认时隐藏私有视图并暂停后续写步骤，同用户恢复保留上下文，实际换身份才失效。页面查询、草稿和上传操作代次独立于会话身份代次。Admin对ACCOUNT_DISPLAY可通过并公开，对ACCOUNT_EVIDENCE只允许私有审核；服务端仍执行完整权限与用途校验。
