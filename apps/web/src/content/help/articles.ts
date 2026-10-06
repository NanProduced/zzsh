import type { HelpArticle } from "./types.ts";

// 帮助中心首版内容清单（受控静态内容源，唯一来源）。
// 事实依据：docs/architecture/ 已确认规则文档；旧站文章仅作来源对照，旧规则不套用于新平台订单。
// 未实现的渠道时效、手续费、分销比例等一律不作承诺；公共文章没有订单上下文，统一指向平台客服。

export const helpArticles: readonly HelpArticle[] = [
  {
    id: "R01",
    slug: "rental-getting-started",
    title: "第一次租号，从哪里开始？",
    summary: "从选号到起租的完整流程：浏览无需登录，下单前核对费用与条件，支付后由平台客服在每单独立群协助交付。",
    category: "rental",
    audience: ["renter"],
    keywords: ["租号", "怎么租", "流程", "下单", "支付", "客服", "开始租用", "租号流程", "新人"],
    updatedAt: "2026-10-06",
    related: ["rental-check-before-order", "rental-confirm-and-return", "issue-during-rental"],
    contactCta: true,
    sections: [
      {
        id: "steps",
        title: "租号的基本流程",
        blocks: [
          { type: "list", ordered: true, items: [
            "在账号列表浏览公开账号，按游戏、资源和费用筛选；浏览和查看详情不需要登录。",
            "选定账号后登录并完成下单确认，页面会展示按你本人情况计算的报价与费用明细。",
            "完成支付后，平台客服会为这一笔订单建立独立的履约群，买家、号主和客服都在群内。",
            "在群内配合完成账号交付，双方确认交付内容后正式起租。",
          ] },
        ],
      },
      {
        id: "after-payment",
        title: "支付之后会发生什么",
        blocks: [
          { type: "paragraph", text: "付款成功后订单进入客服分配：分配成功即自动建立本单专属群，不需要再次点击或联系。" },
          { type: "callout", tone: "info", text: "付款成功、进入群聊、确认交付、开始计费是四件不同的事。只有双方确认交付后才开始正式租用计时。" },
          { type: "paragraph", text: "暂时没有可分配的客服时，订单会进入待匹配队列并提醒主管处理，不会虚构客服，也不会因此提前开始计费。" },
        ],
      },
      {
        id: "notes",
        title: "需要知道的边界",
        blocks: [
          { type: "list", items: [
            "交易动作（下单、支付）需要登录，并完成平台要求的身份核验。",
            "履约由真人客服在群内协助，平台不提供自动上号或自动交付。",
            "订单群的沟通、提醒和已读状态都不等于结算确认或资金指令，一切以订单页面的状态为准。",
          ] },
        ],
      },
      {
        id: "next",
        title: "下一步",
        blocks: [
          { type: "paragraph", text: "下单前建议先阅读「下单前需要核对哪些信息」；租用中遇到问题直接在订单群联系客服。" },
        ],
      },
    ],
  },
  {
    id: "R02",
    slug: "rental-check-before-order",
    title: "下单前需要核对哪些信息？",
    summary: "核对账号资源、费用构成、押金与租期说明，确认页面报价是按你本人情况计算的结果。",
    category: "rental",
    audience: ["renter"],
    keywords: ["核对", "账号信息", "库存", "哈夫币", "哈弗币", "皮肤", "押金", "租期", "报价", "下单前"],
    updatedAt: "2026-10-06",
    related: ["rental-getting-started", "fees-overview", "membership-benefits"],
    sections: [
      {
        id: "answer",
        title: "先核对这三类信息",
        blocks: [
          { type: "list", ordered: true, items: [
            "资源：哈夫币数量、指定物资库存、皮肤、安全箱等账号资源，以详情页当前展示为准。",
            "费用：资源费用、押金和租期说明分别列明；哈夫币与物资按账号现有全量库存计价，不是按你预计的使用量。",
            "本人条件：你的会员档位会影响押金减免与资源价格，最终金额以下单确认页的本人报价为准。",
          ] },
        ],
      },
      {
        id: "pricing",
        title: "报价是怎样算出来的",
        blocks: [
          { type: "paragraph", text: "价格由服务端按平台维护的计价规则计算，下单确认时冻结本单价格与规则版本。公开列表与详情展示的是标准报价，你的最终应付以登录后的下单确认页为准。" },
          { type: "callout", tone: "info", text: "页面没有展示的字段表示未申报或暂未知，不等于零；对任何一项有疑问，先咨询平台客服再下单。" },
        ],
      },
    ],
  },
  {
    id: "R05",
    slug: "rental-confirm-and-return",
    title: "开始租用和归还数量怎样确认？",
    summary: "开租前双方确认同一版期初清单，结束时按确认的期末数量计算实耗；消耗与金额都由系统按冻结价格生成明细。",
    category: "rental",
    audience: ["renter", "owner"],
    keywords: ["开租", "期初", "期末", "归还", "确认", "消耗", "起租", "验号", "交付"],
    updatedAt: "2026-10-06",
    related: ["rental-getting-started", "fees-settlement", "fees-early-end"],
    sections: [
      {
        id: "open",
        title: "正式开租以双方确认为准",
        blocks: [
          { type: "paragraph", text: "客服会先提交本单期初数量清单，清单必须与订单冻结的资源报价一致；买卖双方确认同一版期初清单后才正式开租。" },
          { type: "callout", tone: "info", text: "付款、进群发消息都不等于开租；期初清单与订单不一致时不会开租，先在群内核实差异。" },
        ],
      },
      {
        id: "return",
        title: "结束时怎样计算消耗",
        blocks: [
          { type: "list", items: [
            "任一方可以填写归还（期末）数量发起结束，另一方在订单页确认或拒绝；客服也可以代为登记、修改后重新发起。",
            "哈夫币消耗按双方确认的期初与期末净差计算；物品按确认的期初数量减期末剩余数量计算实耗。",
            "未消耗的物品按下单时冻结的价格从预付款中退回，正常结束时押金全额应退。",
          ] },
        ],
      },
      {
        id: "exceptions",
        title: "异常情况不会自动结算",
        blocks: [
          { type: "paragraph", text: "数量未知、期末大于期初等异常不会按正常值裁剪过账，会交由客服与运营核实处理。发现数量不对时不要确认，直接在群内提出。" },
        ],
      },
    ],
  },
  {
    id: "R04",
    slug: "rental-not-started",
    title: "接号信息不符，或还没开始使用怎么办？",
    summary: "尚未正式开租的订单可以申请结束：无争议且无其他调整时全额应退；接号差异由平台调整流程处理，不私自协商。",
    category: "rental",
    audience: ["renter"],
    keywords: ["信息不符", "接号", "还没用", "取消", "未开租", "退单", "差异", "补款"],
    updatedAt: "2026-10-06",
    related: ["rental-getting-started", "issue-during-rental", "fees-refund-status"],
    contactCta: true,
    sections: [
      {
        id: "answer",
        title: "未开租可以结束，不自动扣费",
        blocks: [
          { type: "paragraph", text: "订单已付款但尚未正式开租时，任一方都可以发起结束申请，由受权客服核实交付与使用情况后办理。" },
          { type: "callout", tone: "info", text: "无争议且没有其他受审调整时全额应退，不会自动收取包赔费或提前补足；但「应退」不代表支付渠道已经到账。" },
        ],
      },
      {
        id: "mismatch",
        title: "接号信息与订单不一致",
        blocks: [
          { type: "paragraph", text: "实际账号与订单内容存在差异时，在订单群内说明，由平台调整申请承载：双方确认、负责客服审核、必要补款完成后才生效，原订单和每次变更都会保留记录。" },
          { type: "paragraph", text: "不要私下与对方协商转账或线下处理，所有调整以订单页面和群内客服确认为准。" },
        ],
      },
    ],
  },
  {
    id: "P01",
    slug: "publish-prepare",
    title: "上架前需要准备什么？",
    summary: "盘点全量库存、准备展示图与公示材料、了解押金与保证金要求，并先做好游戏账号的安全设置。",
    category: "publish",
    audience: ["owner"],
    keywords: ["上架", "出租", "发布", "准备", "库存", "截图", "凭证", "押金", "保证金", "封禁"],
    updatedAt: "2026-10-06",
    related: ["publish-pricing-modes", "publish-account-safety", "fees-overview"],
    sections: [
      {
        id: "inventory",
        title: "盘点账号资源",
        blocks: [
          { type: "paragraph", text: "哈夫币与指定物资按账号现有全量库存申报，不是预计会被使用的数量；皮肤按分类选择申报；安全箱、体力、负重等信息会影响计价。申报数量是结算期初核对的基础，请如实填写。" },
        ],
      },
      {
        id: "media",
        title: "准备展示与公示图片",
        blocks: [
          { type: "list", items: [
            "账号展示图：用于公开详情页向租客展示账号，通过技术校验后才会展示。",
            "处罚公示图：按平台要求提供，用于向租客公示，不要把应公示的内容当作仅内部可见材料处理。",
          ] },
          { type: "paragraph", text: "上架备注对租客公开可见；账号历史封禁等情况按平台要求如实申报并公示，隐瞒会影响后续纠纷处理。" },
        ],
      },
      {
        id: "deposit",
        title: "了解押金与保证金",
        blocks: [
          { type: "list", items: [
            "账号基础押金由号主设定，平台提供推荐值与上限；选择包赔保障的账号基础押金最低为 300 元。",
            "号主保证金按出租账号逐个核定，不能用其他账号的缴款证明本账号资格。",
          ] },
        ],
      },
      {
        id: "submit",
        title: "提交前你会看到什么",
        blocks: [
          { type: "paragraph", text: "提交前会看到本次报价与对应的规则条款，核对并同意后上架；核价、资格与图片技术校验都通过后直接发布，不需要等待人工预审。报价、规则版本与内容摘要在确认时冻结，之后修改资料需要重新报价确认。" },
        ],
      },
    ],
  },
  {
    id: "P02",
    slug: "publish-pricing-modes",
    title: "普通、自定义、极速上架有什么区别？",
    summary: "三种方式使用同一套上架表单，区别只在价格比例的约束；具体金额以提交前服务端报价为准。",
    category: "publish",
    audience: ["owner"],
    keywords: ["普通", "自定义", "极速", "比例", "定价", "上架方式", "价格"],
    updatedAt: "2026-10-06",
    related: ["publish-prepare", "fees-overview"],
    sections: [
      {
        id: "answer",
        title: "同一表单，不同价格约束",
        blocks: [
          { type: "list", items: [
            "普通：价格比例按平台计价规则计算。",
            "自定义：在平台允许的范围内自行设定比例，超出范围无法提交。",
            "极速：从极速入口进入时使用该模式给定的比例类型约束，适合希望按平台既定方式快速上架的号主。",
          ] },
          { type: "paragraph", text: "三种方式填写的账号资料与图片要求相同，不存在三套上架条件。" },
        ],
      },
      {
        id: "quote",
        title: "金额以报价页为准",
        blocks: [
          { type: "paragraph", text: "每种方式的具体金额与比例在提交前由服务端按当前规则版本计算并展示，你确认后才冻结生效；规则更新后，受影响的上架需要重新报价和确认，历史已确认内容不会被覆盖。" },
        ],
      },
    ],
  },
  {
    id: "P06",
    slug: "publish-account-safety",
    title: "出租前后怎样保护游戏账号？",
    summary: "开启游戏侧设备锁等防护、出租结束后及时改密；游戏安全功能的入口以腾讯游戏安全中心当前页面为准。",
    category: "publish",
    audience: ["owner"],
    game: "三角洲行动",
    keywords: ["设备锁", "账号安全", "改密码", "游戏安全", "登录保护", "人脸验证", "洗号"],
    updatedAt: "2026-10-06",
    related: ["publish-prepare", "account-realname-vs-face", "issue-during-rental"],
    sections: [
      {
        id: "device-lock",
        title: "建议开启设备锁",
        blocks: [
          { type: "paragraph", text: "设备锁是游戏侧的「新设备必须验证」开关。一般路径：微信关注「腾讯游戏安全中心」公众号 → 自助服务 → 设备管理 → 找到《三角洲行动》，确认设备锁处于开启状态，并将信任设备清零。" },
          { type: "callout", tone: "warning", text: "以上是游戏侧功能的一般说明，具体入口与名称以腾讯游戏安全中心当前页面为准；平台无法代替你操作游戏账号设置。" },
        ],
      },
      {
        id: "more",
        title: "可以叠加的防护",
        blocks: [
          { type: "list", items: [
            "登录保护：开启后即使密码泄露，登录也需要额外验证。",
            "游戏内人脸验证：高风险登录时强制人脸识别。",
            "在网吧等公共设备登录后，及时在设备管理中删除该设备记录。",
          ] },
        ],
      },
      {
        id: "after-rental",
        title: "出租结束后",
        blocks: [
          { type: "paragraph", text: "租赁结束后请及时修改游戏账号密码；平台账号的密码与会话管理见账号与安全分类。" },
        ],
      },
    ],
  },
  {
    id: "F01",
    slug: "fees-overview",
    title: "租金、物资费和押金分别是什么？",
    summary: "预付总额由哈夫币金额、全量物品金额和租客押金组成；押金与号主保证金、包赔费分别记录，互不混用。",
    category: "fees",
    audience: ["renter", "owner"],
    keywords: ["费用", "租金", "物资费", "押金", "保证金", "预付", "费用构成", "哈夫币", "哈弗币"],
    updatedAt: "2026-10-06",
    related: ["fees-early-end", "fees-refund-status", "membership-benefits"],
    sections: [
      {
        id: "composition",
        title: "预付总额的构成",
        blocks: [
          { type: "paragraph", text: "租客预付总额由哈夫币金额、全量物品金额和实际租客押金组成，哈夫币与物品保留独立明细，按下单时冻结的买家、号主双边价格结算。" },
          { type: "list", items: [
            "资源费用：按账号全量库存预付，结算时按实际消耗计算，未消耗的物品按冻结价格退回。",
            "租客押金：号主为账号设定的基础押金，平台提供推荐值与上限；正常结束时全额应退，押金不参与资源费用抽成。",
          ] },
        ],
      },
      {
        id: "deposit-kinds",
        title: "几种容易混淆的资金",
        blocks: [
          { type: "table", columns: ["名称", "谁缴纳", "用途"], rows: [
            ["租客押金", "租客（VIP/SVIP 会员免押）", "保障租用期间的约定责任，正常结束全额应退"],
            ["号主保证金", "号主", "按出租账号核定的发布资格要求，与租客押金无关"],
            ["包赔费用", "按结算责任确定承担方", "选择包赔保障的订单在结算时计提，单独记录"],
          ] },
        ],
      },
      {
        id: "notes",
        title: "注意",
        blocks: [
          { type: "paragraph", text: "库存减少不会自动降低押金；具体金额以下单确认页冻结的报价为准，帮助说明不改变订单金额。" },
        ],
      },
    ],
  },
  {
    id: "F03",
    slug: "fees-early-end",
    title: "提前结束如何计算费用？",
    summary: "按哈夫币净消耗比例分段计算补足：达到 70% 视为正常结算不收补足；物品只按实耗计费，责任归属决定费用由谁承担。",
    category: "fees",
    audience: ["renter", "owner"],
    keywords: ["提前结束", "提前结算", "补足", "70%", "消耗比例", "中途结算", "提前退"],
    updatedAt: "2026-10-06",
    related: ["fees-settlement", "fees-refund-status", "protection-coverage"],
    contactCta: true,
    sections: [
      {
        id: "answer",
        title: "先看结论",
        blocks: [
          { type: "paragraph", text: "哈夫币净消耗比例达到本单 70% 时按正常结算，不产生提前补足；低于 70% 且属于租客自愿提前的，按分段规则产生哈夫补足。物品不参与比例判定，只按实际消耗计费，未消耗部分退回。" },
          { type: "callout", tone: "info", text: "补足只在正常交付并正式开租后适用；未正式开租就结束的订单不自动收取补足或包赔费。" },
        ],
      },
      {
        id: "formula",
        title: "补足怎样分段计算",
        blocks: [
          { type: "paragraph", text: "记 c 为哈夫币净消耗比例（双方确认的哈夫净消耗 ÷ 本单全量哈夫净量），F 为本单全量哈夫币价差（买家价减号主价）。" },
          { type: "table", columns: ["净消耗比例 c", "提前补足"], rows: [
            ["c ≤ 50%", "F × (1 − c)"],
            ["50% < c < 70%", "2.5 × F × (0.7 − c)"],
            ["c ≥ 70%", "0，按正常结算"],
          ] },
          { type: "paragraph", text: "曲线连续递减，不按整数档位跳扣；号主按实际消耗侧金额结算。具体金额以结算单明细为准。" },
        ],
      },
      {
        id: "responsibility",
        title: "费用由谁承担",
        blocks: [
          { type: "list", items: [
            "租客自愿提前（非号主或账号原因）：补足由租客承担；已选包赔的，包赔费按全量哈夫与物品计算，与补足分列。",
            "号主要求提前或账号原因导致无法继续：不自动向租客收取补足，也不转嫁包赔费。",
            "谁先发起结束不等于谁承担责任，责任由客服按事实分类；提前结算在双方确认后还须客服复核同一版本才生效。",
          ] },
        ],
      },
      {
        id: "changed-rule",
        title: "与旧平台说明的区别",
        blocks: [
          { type: "callout", tone: "warning", text: "旧平台帮助中「消耗金额小于总金额 70% 时禁止自行结算」等说法属于旧规则。新平台订单按本文的比例与流程处理；旧平台创建的订单仍适用其下单时的旧规则，两者不混用。" },
        ],
      },
    ],
  },
  {
    id: "F04",
    slug: "fees-settlement",
    title: "怎样确认结算，金额有异议怎么办？",
    summary: "双方确认同一版结算明细：正常结算确认后自动生效，提前结算还需客服复核；任何修改都会使旧确认失效。",
    category: "fees",
    audience: ["renter", "owner"],
    keywords: ["结算", "确认结算", "结算明细", "异议", "复核", "人工调整", "收益"],
    updatedAt: "2026-10-06",
    related: ["fees-early-end", "fees-refund-status", "withdraw-status"],
    sections: [
      {
        id: "how",
        title: "结算怎样生效",
        blocks: [
          { type: "list", ordered: true, items: [
            "系统按双方确认的数量与下单时冻结的价格生成结算明细，双方确认同一版本。",
            "正常结算：双方同版确认后自动生效，不需要客服审核。",
            "提前结算：双方确认后，还须受权客服复核同一版本才生效。",
          ] },
          { type: "callout", tone: "info", text: "任何改变消耗、金额或费用承担方的修改都会使已有的确认和复核失效，需要重新确认；旧版本保留为历史记录。" },
        ],
      },
      {
        id: "dispute",
        title: "对金额有异议",
        blocks: [
          { type: "paragraph", text: "先不要确认，在订单群内提出异议。人工金额调整必须写明原因与证据，经运营审核后由双方再次确认；争议无法协商时由受权方按规则裁定。" },
        ],
      },
      {
        id: "after",
        title: "生效之后",
        blocks: [
          { type: "list", items: [
            "号主收入在结算生效时进入可用余额，可立即申请提现，不用等租客退款完成。",
            "租客剩余款自动发起原路退款：正常结算生效即发起；不足 70% 的提前结算在复核生效满 7 天后发起。",
            "「应退」是平台的退款责任记录，不代表支付渠道已经到账，到账时间见退款状态说明。",
          ] },
        ],
      },
    ],
  },
  {
    id: "F05",
    slug: "fees-refund-status",
    title: "显示应退款，为什么还没到账？",
    summary: "应退表示平台已确认退款责任；退款需经支付渠道处理，受理与到账分别记录，提前结算有 7 天等待期。",
    category: "fees",
    audience: ["renter"],
    keywords: ["退款", "应退", "到账", "没到账", "退款进度", "退押金", "原路退回"],
    updatedAt: "2026-10-06",
    related: ["fees-settlement", "fees-early-end", "withdraw-status"],
    contactCta: true,
    sections: [
      {
        id: "answer",
        title: "先给结论",
        blocks: [
          { type: "paragraph", text: "「应退」表示平台已确认应退金额并生成退款责任，不代表支付渠道已经到账。退款按原路退回付款渠道，渠道处理完成后才到账。" },
        ],
      },
      {
        id: "timeline",
        title: "退款的时间线",
        blocks: [
          { type: "list", ordered: true, items: [
            "结算生效后，正常结算自动发起原路退款。",
            "不足 70% 的提前结算，在客服复核通过、结算生效满 7 天后自动发起。",
            "退款发起后由支付渠道处理，平台分别记录受理与到账结果。",
          ] },
        ],
      },
      {
        id: "states",
        title: "常见状态怎么理解",
        blocks: [
          { type: "table", columns: ["状态", "含义"], rows: [
            ["待发起", "已确认应退，退款尚未执行（可能仍在提前结算的 7 天等待期，也可能尚未发起处理）"],
            ["处理中", "已发起退款，等待支付渠道返回结果"],
            ["结果待确认", "渠道暂未返回明确结果，平台核实中；不会因此重复退款"],
          ] },
          { type: "paragraph", text: "退款即使失败，也仍是平台的退款责任，平台会继续处理或重新发起；它不会转成你的可提现余额，退款只按原路退回付款渠道。" },
        ],
      },
      {
        id: "help",
        title: "长时间未到账怎么办",
        blocks: [
          { type: "paragraph", text: "请保留订单编号，通过站内联系平台客服，说明订单与退款情况，由客服核实当前处理进度。" },
        ],
      },
    ],
  },
  {
    id: "F06",
    slug: "withdraw-status",
    title: "提现什么时候到账，失败后怎么办？",
    summary: "可用余额可立即申请提现，不设人工审核；确认未出款且钱包显示资金已释放后，才能按当前可用额度重新申请。",
    category: "fees",
    audience: ["owner"],
    keywords: ["提现", "出款", "到账", "提现失败", "余额", "钱包", "释放"],
    updatedAt: "2026-10-06",
    related: ["fees-settlement", "fees-refund-status"],
    contactCta: true,
    sections: [
      {
        id: "answer",
        title: "先给结论",
        blocks: [
          { type: "paragraph", text: "结算生效后号主收入进入可用余额，可立即申请提现，平台不设人工提现审核；仍会执行身份、余额与防重复出款校验。到账时间取决于出款渠道的实际处理，平台按渠道结果记账。" },
          { type: "callout", tone: "info", text: "提现是余额出款，与租客「退款未到账」是两条不同的资金链路，不要按同一种状态理解。" },
        ],
      },
      {
        id: "failure",
        title: "提现失败怎么办",
        blocks: [
          { type: "paragraph", text: "「失败」本身不代表资金已经回到可用余额。请按顺序确认：" },
          { type: "list", ordered: true, items: [
            "先确认这笔提现确实没有出款（以渠道与平台记录为准，不只看页面状态文字）。",
            "再确认钱包流水显示该笔资金已释放、可用余额已经恢复。",
            "两项都确认后，才可以按当前可用额度重新申请。",
          ] },
          { type: "callout", tone: "warning", text: "结果未知或释放记录待核时，不要重新申请，避免重复出款；请保留记录并联系平台客服继续核实。" },
        ],
      },
      {
        id: "notes",
        title: "其他说明",
        blocks: [
          { type: "paragraph", text: "具体渠道的到账时效与可能产生的渠道费用以实际渠道规则为准；平台不作超出渠道能力的承诺。" },
        ],
      },
    ],
  },
];

export const helpArticlesMore: readonly HelpArticle[] = [
  {
    id: "A01",
    slug: "account-register-login",
    title: "手机号注册、验证码和密码如何登录？",
    summary: "手机号加短信验证码即可注册并登录，密码是可选的便捷方式；昵称不是登录名。",
    category: "account",
    audience: ["all"],
    keywords: ["注册", "登录", "验证码", "手机号", "密码", "昵称"],
    updatedAt: "2026-10-06",
    related: ["account-recovery", "account-realname-vs-face"],
    sections: [
      {
        id: "register",
        title: "注册",
        blocks: [
          { type: "paragraph", text: "输入手机号获取短信验证码，验证并同意协议后即完成注册并直接登录，不要求设置密码。" },
        ],
      },
      {
        id: "login",
        title: "登录方式",
        blocks: [
          { type: "list", items: [
            "手机号 + 短信验证码：任何账号都可以使用。",
            "手机号 + 密码：仅设置过密码的账号可用；新设置或重置的密码至少 12 位。",
          ] },
          { type: "paragraph", text: "昵称可以随时修改，仅用于展示，不参与登录；登录不区分昵称。支持多设备同时登录，可在账号安全页查看并退出其他设备的会话。" },
        ],
      },
      {
        id: "legacy",
        title: "旧平台用户",
        blocks: [
          { type: "paragraph", text: "旧平台注册用户用原手机号接收验证码即可登录原账户，历史订单与资产关系保留；旧密码也可继续用于手机号 + 密码登录，首次成功后会自动完成安全升级，不要求更换密码。" },
        ],
      },
    ],
  },
  {
    id: "A02",
    slug: "account-recovery",
    title: "忘记密码或手机号不能用了怎么办？",
    summary: "用已验证的手机号或邮箱验证码重置密码；换绑手机号需要旧号或已验证邮箱配合；都不可用时走人工恢复。",
    category: "account",
    audience: ["all"],
    keywords: ["忘记密码", "找回密码", "手机号丢了", "换绑", "重置密码", "人工恢复", "邮箱"],
    updatedAt: "2026-10-06",
    related: ["account-register-login"],
    contactCta: true,
    sections: [
      {
        id: "password",
        title: "忘记密码",
        blocks: [
          { type: "paragraph", text: "在登录入口选择找回密码，通过已验证手机号或已绑定邮箱接收验证码后即可重置。重置成功后，其他设备上的旧会话会失效，需要重新登录。" },
          { type: "callout", tone: "info", text: "未绑定或未验证的邮箱不能用于找回密码；先在账号安全页完成邮箱绑定验证，之后才能作为找回渠道。" },
        ],
      },
      {
        id: "phone",
        title: "更换手机号",
        blocks: [
          { type: "list", items: [
            "方式一：旧手机号验证码 + 新手机号验证码。",
            "方式二：已绑定验证邮箱验证码 + 新手机号验证码。",
          ] },
          { type: "paragraph", text: "新号码如果已被其他账户占用会被拒绝，不会合并两个账户；换绑后原号码不能再登录，你的订单、余额等归属不变。" },
        ],
      },
      {
        id: "manual",
        title: "两种渠道都不可用",
        blocks: [
          { type: "paragraph", text: "旧手机号停用且没有可用邮箱时，请联系平台客服进入人工恢复流程。人工恢复需要独立的身份核验，客服不能直接跳过归属确认帮你换绑。" },
        ],
      },
    ],
  },
  {
    id: "A03",
    slug: "account-realname-vs-face",
    title: "平台实名与游戏人脸验证有什么区别？",
    summary: "平台实名用于确认交易资格，游戏人脸是腾讯游戏的安全机制；两者互不相同，租号上号触发人脸时需要号主配合。",
    category: "account",
    audience: ["renter", "owner"],
    game: "三角洲行动",
    keywords: ["实名", "人脸", "人脸识别", "认证", "腾讯", "高危", "异地", "扫码"],
    updatedAt: "2026-10-06",
    related: ["rental-getting-started", "issue-during-rental", "publish-account-safety"],
    contactCta: true,
    sections: [
      {
        id: "difference",
        title: "两种「验证」不是一回事",
        blocks: [
          { type: "table", columns: ["", "平台实名核验", "游戏人脸验证"], rows: [
            ["由谁提供", "洲洲商行平台", "腾讯游戏安全机制"],
            ["用途", "确认账号主体的交易资格（含成年人核验）", "游戏侧判定高风险登录时的身份确认"],
            ["何时出现", "注册、下单等交易环节", "租用期间游戏检测到异常登录环境时"],
          ] },
        ],
      },
      {
        id: "face-tips",
        title: "遇到游戏人脸验证怎么办",
        blocks: [
          { type: "paragraph", text: "游戏人脸二维码的有效期很短（约 10 秒），截图后再扫通常来不及。建议由号主与租客实时配合：一方展示二维码，另一方用另一台设备即时扫码，或通过视频通话对准画面扫码。" },
          { type: "paragraph", text: "出现「高危」「异地」等提示时，按游戏内指引处理；多次无法完成时，在订单群联系客服协商，不要反复尝试导致账号被进一步限制。" },
        ],
      },
      {
        id: "security-note",
        title: "安全提醒",
        blocks: [
          { type: "callout", tone: "warning", text: "平台客服不会在群内索要你的平台登录密码或短信验证码；任何人以「验证」为名索要这些信息都应视为可疑。" },
        ],
      },
    ],
  },
  {
    id: "S01",
    slug: "issue-during-rental",
    title: "租用中无法登录、账号被封或联系不上号主怎么办？",
    summary: "第一时间在本单订单群联系客服并保存证据；未开租可申请结束，已开租由客服按事实核实处理。",
    category: "after-sale",
    audience: ["renter"],
    keywords: ["无法登录", "封号", "封禁", "号主失联", "顶号", "异常", "售后", "上不了号"],
    updatedAt: "2026-10-06",
    related: ["rental-not-started", "protection-coverage", "complaint-guide"],
    contactCta: true,
    sections: [
      {
        id: "answer",
        title: "先在订单群内联系客服",
        blocks: [
          { type: "paragraph", text: "遇到无法登录、封禁、顶号或号主不回应等情况，第一时间在本单订单群说明并保存证据：问题截图、发生时间、具体现象。订单群是平台认可的沟通与处理渠道。" },
          { type: "callout", tone: "warning", text: "不要绕开订单群私下协商转账或「私了」，私下约定不受平台保障，出现纠纷也无法核实。" },
        ],
      },
      {
        id: "by-stage",
        title: "按租用阶段处理",
        blocks: [
          { type: "list", items: [
            "尚未正式开租：任一方可申请结束，无争议且无其他调整时全额应退。",
            "已正式开租：客服核实事实后按规则分类处理；责任与金额由受审流程确定，不按固定扣款表自动执行。",
            "对处理结果有异议：在群内提出，必要时按投诉流程由上级复核。",
          ] },
        ],
      },
    ],
  },
  {
    id: "S02",
    slug: "protection-coverage",
    title: "包赔保障什么，费用由谁承担？",
    summary: "包赔是可选保障，覆盖本次租赁结束后 10 年内由本次租赁导致的封禁等约定损失；费率 8%，承担方按结算责任确定。",
    category: "after-sale",
    audience: ["renter", "owner"],
    keywords: ["包赔", "保障", "赔付", "封禁赔偿", "8%", "保险费"],
    updatedAt: "2026-10-06",
    related: ["fees-early-end", "fees-settlement", "issue-during-rental"],
    sections: [
      {
        id: "scope",
        title: "保障范围",
        blocks: [
          { type: "paragraph", text: "包赔是上架时可选的保障。保障范围为本次租赁结束后 10 年内、由本次租赁导致的封禁等约定损失。实际赔付由客服与号主协商、运营审核处理，应赔金额、入账与实际付款分别记录。" },
        ],
      },
      {
        id: "fee",
        title: "费用与承担方",
        blocks: [
          { type: "paragraph", text: "包赔费率为 8%，基数为号主侧毛金额，不含押金、保证金、平台价差、提前补足和赔款。承担方按结算责任确定：" },
          { type: "table", columns: ["结算情形", "计费基数", "承担方"], rows: [
            ["正常结算", "实耗哈夫币 + 实耗物品", "号主"],
            ["租客自愿提前（非号主或账号原因）", "全量哈夫币 + 全量物品", "租客"],
            ["号主要求提前或账号原因无法继续", "原则上按实耗", "号主"],
            ["未正式开租即取消", "不计包赔费", "—"],
          ] },
          { type: "callout", tone: "info", text: "上架页面展示的是预估说明，不是扣费凭证；实际费用只在结算生效时计提一次，你的订单以下单时接受的包赔条款版本为准。" },
        ],
      },
    ],
  },
  {
    id: "S03",
    slug: "complaint-guide",
    title: "怎样投诉，应该保存哪些证据？",
    summary: "通过常驻「投诉建议」入口提交，投诉由有权限的上级处理，不会交回被投诉客服本人；提前保存订单与群内证据。",
    category: "after-sale",
    audience: ["all"],
    keywords: ["投诉", "举报", "证据", "申诉", "客服投诉"],
    updatedAt: "2026-10-06",
    related: ["issue-during-rental", "anti-fraud-guide"],
    sections: [
      {
        id: "how",
        title: "投诉入口与处理",
        blocks: [
          { type: "paragraph", text: "使用页面常驻工具栏的「投诉建议」入口提交投诉。投诉会交给有相应权限的上级处理，不会交回被投诉的客服本人。" },
        ],
      },
      {
        id: "evidence",
        title: "建议保存的证据",
        blocks: [
          { type: "list", items: [
            "订单编号与相关时间点。",
            "订单群内的聊天记录截图，尤其是对方承诺与实际结果的对比。",
            "涉及金额的，保留金额、支付与退款状态截图。",
          ] },
          { type: "callout", tone: "info", text: "重要约定请在订单群内以文字确认，口头承诺难以核实。" },
        ],
      },
    ],
  },
  {
    id: "S04",
    slug: "anti-fraud-guide",
    title: "怎样识别平台客服和防范私下交易？",
    summary: "平台沟通只在站内进行：平台客服入口与订单群。任何私下加你谈租号、出号或索要验证码的都是高危信号。",
    category: "after-sale",
    audience: ["all"],
    keywords: ["防骗", "诈骗", "私下交易", "假客服", "安全", "QQ", "微信"],
    updatedAt: "2026-10-06",
    related: ["complaint-guide", "issue-during-rental"],
    contactCta: true,
    sections: [
      {
        id: "official",
        title: "平台只通过站内沟通",
        blocks: [
          { type: "list", items: [
            "平台客服：站内「联系客服」入口与你订单专属的履约群。",
            "客服不会用 QQ、微信私下添加你谈订单，不会索要平台密码或短信验证码，也不会要求站外转账或点击不明链接。",
          ] },
        ],
      },
      {
        id: "signals",
        title: "这些情形按高危对待",
        blocks: [
          { type: "list", items: [
            "自称客服或号主，私下联系你租号、出号或「优惠交易」。",
            "要求绕过平台直接转账、扫码付款或提供验证码。",
            "以「保证金解冻」「订单异常」为由要求额外付款。",
          ] },
          { type: "paragraph", text: "拿不准对方身份时，不要操作，先通过站内「联系客服」核实。" },
        ],
      },
    ],
  },
  {
    id: "M01",
    slug: "membership-benefits",
    title: "会员优惠适用于哪些费用？",
    summary: "VIP、SVIP 免租客押金；会员档位影响资源价格，具体以下单确认页的本人报价为准。",
    category: "membership",
    audience: ["renter"],
    keywords: ["会员", "VIP", "SVIP", "免押", "优惠", "折扣"],
    updatedAt: "2026-10-06",
    related: ["fees-overview", "rental-check-before-order"],
    sections: [
      {
        id: "tiers",
        title: "会员档位与费用",
        blocks: [
          { type: "list", items: [
            "租客押金：VIP、SVIP 会员免租客押金；标准用户与优惠用户按账号基础押金正常缴纳。",
            "资源价格：会员档位会影响资源价格，优惠用户保留价格优惠但不免押；具体金额以下单确认页为你计算的本人报价为准。",
          ] },
        ],
      },
      {
        id: "notes",
        title: "注意",
        blocks: [
          { type: "paragraph", text: "会员的有效期、获取方式等以平台当前公示为准；页面没有展示的权益不作承诺。押金减免只影响租客押金，不改变资源费用、包赔费用或号主保证金。" },
          { type: "paragraph", text: "本分类目前只覆盖会员费用说明；邀请关系的绑定与收益规则将随既有合同接入后另行说明，本文不涉及。" },
        ],
      },
    ],
  },
  {
    id: "L01",
    slug: "terms-and-privacy",
    title: "协议与隐私说明",
    summary: "正式用户协议与隐私政策正文正在接入；订单按下单时接受的条款版本处理，历史订单不受后续更新影响。",
    category: "agreement",
    audience: ["all"],
    keywords: ["协议", "隐私", "条款", "用户协议", "服务协议", "版本"],
    updatedAt: "2026-10-06",
    related: ["protection-coverage", "minor-protection"],
    sections: [
      {
        id: "status",
        title: "当前状态",
        blocks: [
          { type: "paragraph", text: "注册流程已包含协议同意环节；正式的用户服务协议与隐私政策正文仍在接入中，接入前平台不会以任何临时文本冒充正式条款。" },
        ],
      },
      {
        id: "order-terms",
        title: "你的订单适用哪一版条款",
        blocks: [
          { type: "paragraph", text: "规则上，订单按你下单时实际接受的协议与包赔条款版本处理，后续条款更新不追溯影响已创建的订单。目前正式条款的独立版本管理与完整查看入口仍在接入，接入完成前平台不会以临时文本补造「已接受」记录。" },
          { type: "callout", tone: "info", text: "帮助中心的文章是对规则的通俗解释，不替代正式协议与条款；正式版本与你的订单适用情况，以接入后的正式文本与订单记录为准。" },
        ],
      },
      {
        id: "legacy",
        title: "旧平台文件",
        blocks: [
          { type: "paragraph", text: "旧平台的隐私保护与免责声明是旧平台的历史文件，不自动作为新平台条款；旧平台创建的订单仍按其下单时的旧条款处理。" },
        ],
      },
    ],
  },
  {
    id: "X01",
    slug: "minor-protection",
    title: "未成年人保护",
    summary: "未成年人禁止在平台消费；交易环节要求成年实名核验。",
    category: "agreement",
    audience: ["all"],
    keywords: ["未成年", "未成年人", "防沉迷", "保护"],
    updatedAt: "2026-10-06",
    related: ["terms-and-privacy"],
    sections: [
      {
        id: "rule",
        title: "平台要求",
        blocks: [
          { type: "list", items: [
            "未成年人禁止在平台租号、出租或进行任何消费。",
            "下单等交易环节要求通过成年实名核验，未完成核验无法交易。",
          ] },
        ],
      },
      {
        id: "guardian",
        title: "家长或监护人",
        blocks: [
          { type: "paragraph", text: "如发现未成年人使用本平台消费，请保留相关信息并联系平台客服处理。" },
        ],
      },
    ],
  },
];
