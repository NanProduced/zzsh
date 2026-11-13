# 上帝文件排查总结（2026-11-13）

静态扫描，未改业务代码。行数是当日 `git ls-files` 的物理行。排除 `node_modules`、`dist`、`.next`、`build`、`migrations`、`drizzle`、`generated`、`*.gen.ts`、`*.spec.ts`、`*.test.ts`。没有扫到独立的 OpenAPI 生成客户端。`apps/api/test/*-checks.ts` 和 `apps/api/src/database/business-migrations.ts` 不在排除规则里，记为超标但不是上帝文件。

超标 197 个：`.tsx` > 350 行，`.css` / `.scss` > 300 行，`.ts` > 400 行。其中 P0 共 7 个，P1 为单域过胖或样式堆积，其余为 P2。P2 包括静态字典、类型目录、检查脚本、第三方壳、迁移登记和单域读模型，不因行数拆分，也不进入底部台账。

## 结论

本仓库几乎没有经典的 `*.controller.ts` / `*.service.ts`。业务在函数模块里，路由是 `*-routes.ts` 或模块内的分发函数。上帝文件有两类：一个模块里叠了多个子域，或一个组件里有几十处 `useState` / `useEffect`。

用户站页面本身不胖。`apps/web/src/app` 里只有 `login/page.tsx` 写了 `'use client'`，且未超过 350 行。上架页 `apps/web/src/app/publish/page.tsx` 是服务端薄页，体积在它引用的客户端组件里。样式是平铺选择器，不是三层以上的 SCSS 嵌套；样式问题是体积和 `!important`。

拆分时原路径继续导出原有函数和组件。调用方的 import、Props、HTTP 路径，以及写函数上的 `PoolClient` 事务边界保持不变。不新造只转发的 Service 或 Hook。`settlement-record.ts` 是一条结算状态机，可以按阶段分文件，不能拆成多个各自提交的服务。样式跟着组件边界以后再切。

## P0

| 子项目 | 文件 | 行数 | 症状 | 拆分方向 |
|---|---|---:|---|---|
| API | `apps/api/src/im/consultation.ts` | 4823 | 咨询轮次、在线、连接租约、转接、评价、云信群作用域恢复在同一模块。作用域恢复大约从 1135 行到 2320 行 | 解析、作用域恢复、在线、轮次四块搬出，原文件 re-export。`MessageScopeRecoveryLifecycle` 的注册点不改 |
| Web | `apps/web/src/components/supply/publish-form.tsx` | 4699 | 首行 `'use client'`。`PublishForm` 从 900 行到文件末尾。`useState` 69 处、`useEffect` 27 处。账号、资产、媒体、条款、报价、协议弹窗、皮肤目录在同一组件 | 先搬纯函数，再搬地区选择、媒体网格、协议弹窗，最后搬目录、媒体、报价三个 hook。四个 Props 不变。写入意图和 401/409 语义最后搬 |
| Admin | `apps/admin/src/views/im-support-view.tsx` | 3432 | `ImSupportView` 从 460 行到文件末尾。`useState` 约 70 处、`useEffect` 36 处。队列、聊天、在线、转接、结束本轮、订单搜索在同一组件 | 与用户端共用消息映射。在线、队列、聊天面板、转接弹窗、结束弹窗拆出。订单队列留在已有的 `im-support-orders.tsx`。现有 Props 不变 |
| Web | `apps/web/src/components/support/customer-support-workspace.tsx` | 2979 | 首行 `'use client'`。`CustomerSupportWorkspace` 从 592 行起。`useState` 42 处、`useEffect` 21 处。`messageFromNim`、图片解码、历史分页与管理端各写一份 | 映射进 `packages/im-client`。本文件只留壳，线程列表和输入区外移。不与管理端合成一个组件 |
| API | `apps/api/src/supply/publishing.ts` | 2233 | 草稿、报价、收入试算、公开列表投影、审核与上下架在同一模块，约 64 个函数 | 草稿、报价、公开读、审核四个文件。写函数仍接收调用方的 `PoolClient`。先搬公开读，再搬报价，最后搬草稿和审核 |
| Admin | `apps/admin/src/views/admin-directory-view.tsx` | 2080 | `useState` 47 处、`useEffect` 10 处。目录列表和多种命令状态在一个视图 | 排在前五个文件之后。命令对话框按 `security-self/command-dialogs.tsx` 的方式移出列表 |
| Web | `apps/web/src/components/order/order-trade-actions.tsx` | 1465 | 真实支付、本地沙箱、演示收银台、结算确认共文件。文件内 `useState` 53 处、`useEffect` 28 处。`PaymentAction` 大约从 601 行到 1190 行 | 按已有导出组件拆成支付、沙箱、演示收银台、结算四个文件，原文件 re-export。`stageFacts` 仍以服务端 `stage` 为准 |

`consultation.ts` 的邻居已经有 `scope-lease.ts`、`support-dispatch.ts`、`support-presence-policy.ts`、`support-presence-convergence.ts`、`message-receipts.ts`、`yunxin-provider.ts`。新文件只接这些缝之外的剩余块。

上架页没有可再拆的 SEO 数据获取。`PublishVisualBanner` 以后可以作为服务端 `children` 传入，那不是第一步。写失败语义在 `publish-form.tsx` 约 1441 行：目录读取失败不能覆盖未知的业务写入意图。

管理端第 2 行的 `"use client"` 写在 import 之后。管理端是 Vite，这行不是 Next 服务端边界。

两端客服组件权限不同。共享的只有纯映射：`messageFromNim`、历史页合并、图片尺寸解码。结束本轮结果未知时，前端不补一次提交。本地沙箱、演示收银台和真实支付拆文件之后仍然分开渲染。

公开列表投影先于草稿写入搬出 `publishing.ts`。金额继续用现有十进制解析。验证用现有 `apps/api/test/supply-publishing-checks.ts`，不新开套件。

## P1

这些文件大，而且职责已经偏多，但仍是一个业务域，或样式只跟一个功能走。下次改到该文件时再拆，不为此单独立项。

后端里需要单独记住的三条：

- `apps/api/src/auth/approval-audit.ts`（2208 行）是单一审批域，`readRequestById` 大约从 817 行到 1371 行。
- `apps/api/src/order/settlement-record.ts`（2186 行）是结算状态机。过账顺序留在原函数内。
- `apps/api/src/auth/auth-security.ts`（2019 行）是 PIN、冻结、恢复、目录、角色的路由袋。目录路由与 `admin-directory.ts` 重叠，按命令组搬到已有模块即可。

样式里需要单独记住的：

- `account-center.css`（3928 行，64 处 `!important`）混了会员权益、账号壳、面包屑和侧栏。
- `publish-refinement.css`（3159 行，113 处 `!important`）跟上架表单绑在一起，随 `publish-form.tsx` 再切。
- `globals.css`（2953 行）同时放设计令牌、重置、门户首页、按钮和顶栏。

其余 P1 见底部台账的「调研时的处理方向」。

## 台账填写

底部这张表是处理台账。一行一个 P0 或 P1 文件。P2 不列入。

完成情况只填：未处理、进行中、已完成、不处理。处理方式或结果写实际发生的事，例如拆出的文件名、维持原文件的原因，或验证范围。commit 填落地该文件改动的短 hash；一次改动覆盖多行时，各行可以写同一个 hash。没有 commit 就留空。

本文件写入时，全部为未处理。

## 处理台账

| 优先级 | 文件 | 行数 | 调研时的处理方向 | 完成情况 | 处理方式或结果 | commit |
|---|---|---:|---|---|---|---|
| P0 | `apps/api/src/im/consultation.ts` | 4823 | 解析、作用域恢复、在线、轮次四块搬出并 re-export | 已完成 | 拆出 `consultation-internals.ts`(679)/`consultation-parsing.ts`(102)/`consultation-scope-recovery.ts`(1299)/`consultation-presence.ts`(723)/`consultation-rounds.ts`(685)，原文件降至 1710 行并 re-export 全部 82 个原有导出；为消除双向引用按 AST 依赖闭包分层（internals ← 四块 ← core），自动分配链与消息通知并入轮次文件，运行时模块无环。`MessageScopeRecoveryLifecycle` 仍从原路径导出，app.module.ts 注册点与四个禁改文件未动。245 个顶层声明逐条文本等价（零逻辑改动）。测试改读 `test/im-source.ts` 合并实现源，15 处断言文本与计数未放宽。验证：tsc/build 通过，25 个 IM 离线测试与基线逐项一致、零新增失败；真实 PG/浏览器/渠道 NOT_RUN | 5cf6dd29 |
| P0 | `apps/web/src/components/supply/publish-form.tsx` | 4699 | 纯函数、三个 hook、四段表单；Props 不变 | 已完成 | 拆出 `publish-form-types.ts`(166)/`publish-form-helpers.ts`(218)/`publish-dialogs.tsx`(365)/`publish-region-picker.tsx`(119)/`publish-outline-nav.tsx`(53)/`publish-account-section.tsx`(243)/`publish-assets-section.tsx`(244)/`publish-terms-section.tsx`(261)/`publish-rail.tsx`(262)/`publish-dialog-modals.tsx`(147)/`publish-media-section.tsx`(164)，原文件由 4712 行精简至 3378 行；`PublishForm` 组件签名与 Props 保持不变，单向显式 props 传递无多余 Context；保留 `RENTAL_COMPLETED` 源码常量映射与 CSS 媒体查询约束；测试加载器增强支持组件同级 TSX/TS 沙箱动态编译；验证：`npm run typecheck` 0 错误，`node --test apps/web/test/publish-form-behavior.test.mjs` 144/144 单元测试全绿通过 | e912b968 |
| P0 | `apps/admin/src/views/im-support-view.tsx` | 3432 | 在线、队列、聊天、转接、结束弹窗拆出；订单队列留在现有文件 | 已完成 | 拆出 `im-support-view-model.ts`(409 纯类型/消息映射/在线纯函数/常用语/只读读取)、`im-support-presence.tsx`(868 useSupportPresence 状态机+连接生命周期+心跳+租约+运行时栏+暂停/接待弹窗)、`im-support-queue.tsx`(136 统一目录+咨询筛选队列)、`im-support-chat.tsx`(441 聊天主列+时间线+常用语编辑器+详情右栏)、`im-support-round-dialogs.tsx`(66 转交/结束本轮弹窗)，原文件降至 1857 行并 re-export 全部原有公开符号；订单队列仍在 `im-support-orders.tsx`，`ImSupportView` Props 不变。发送/重试/撤回/删除与接待编排留主文件。验证：tsc/build 通过，IM 离线套件 332/333（唯一失败 `narrow order list selection…` 在 HEAD 原版同样失败，属既有基线）；真实浏览器/PG/云信 NOT_RUN |  |
| P0 | `apps/web/src/components/support/customer-support-workspace.tsx` | 2979 | 与管理端共用消息映射；线程列表和输入区外移 | 已完成 | 按本次授权范围只拆线程列表与输入区：新增 `support-thread-list.tsx`(354)/`support-composer.tsx`(371)，原文件 2979→2427 行；`CustomerSupportWorkspace` 与 `messageFromNim` 仍从原路径导出，`support-rail.tsx`、`packages/im-client`、管理端文件未动。消息映射按要求留在原文件、不与管理端去重。线程/消息类型与 `threadKeyOf`/`typeLabel`/`formatTime` 等纯 helper 随列表移出；输入区自持 emoji、拖拽、输入法组合状态，发送/重试/未确认结果/已读上报/身份 generation 全部留在壳里，单向显式 props 无 Context。顺带删除确认无调用者的 `setDraftFor`、`stageOrSendFile`、`removeStagedImage`、`fileInputRef` 与 `WifiOff` 导入。测试钉住的 `dayKeyOf`/`dayLabelOf`/`supportedImageUrl`/`imageOf`/`sendPendingImage`/`retrySend`/`confirmOpening` 源码位置与文本未动。验证：`tsc --noEmit` 0 错误；support-workspace/round-rating/session-visibility/entry-routing/support-directory 120/120，order-trade-components+auth-entry 193/193；production-isolation 2 项失败读的是 `.next` 旧构建 HTML，与本改动无关；真实浏览器/真实 PG/云信 NOT_RUN。拆分后按 Owner 裁定另修三处（4/5 不动）：①连接 error/DISCONNECTED 时统一横幅改显示真实 `error`，无 error 才回退固定文案，AUTH_FAILED/KICKED 文案不变；②`historyLoaded` 布尔表改 `historyStatus` loading/ready/failed，只有 ready 且本轮无用户消息才说“发送第一条消息”，读取中显示“正在读取消息”，失败/未读显示既有“客服尚未接入，可稍后刷新查看”，已读上报门槛仍等价于 ready；重访已 ready 的线程不退回 loading，否则已读门反复开合会把一次可见变成多次 POST（探针实测并修正）；③`composerBlockReason` 第三参改 firstMessagePending。临时探针验证 hang/fail/ok 三态文案后删除。唯一测试改动：`support-workspace-behavior.test.mjs` 第 2218 行断言由 /发送第一条消息后/ 改 /客服尚未接入/（该 fixture 的 /im/token 返回 503，历史根本没读，旧断言钉的是被修掉的行为）；“第一条消息”文案仍由 2361 行真实加载历史的用例覆盖。复跑 313/313 全绿，tsc 0 错误 | 54256229 |
| P0 | `apps/api/src/supply/publishing.ts` | 2233 | 草稿、报价、公开读、审核四文件；事务仍由调用方持有 | 未处理 |  |  |
| P0 | `apps/admin/src/views/admin-directory-view.tsx` | 2080 | 命令对话框移出列表 | 未处理 |  |  |
| P0 | `apps/web/src/components/order/order-trade-actions.tsx` | 1465 | 按已有导出拆支付、沙箱、演示收银台、结算 | 已完成 | 拆出 `order-trade-types.ts`(38)/`order-trade-shared.tsx`(154)/`order-sandbox-action.tsx`(220)/`order-demo-action.tsx`(228)/`order-payment-action.tsx`(931)/`order-settlement-action.tsx`(926)，原文件由 1490 行精简至 71 行并 re-export 全部原有导出；`stageFacts` 严格以服务端 `stage.code` 为准；沙箱与演示收银台明确标记 `[MOCK / DEBUG ONLY - 上线前必须删除]` 注释；优化 `applyOutcome` 取消分支联合签名消除类型断言；`triggerOpenPaidOrderGroup` 开群事件单例防抖；测试加载器增强同目录动态转译；验证：`order-trade-components-behavior` 166 个单测全绿，关联 183 个订单测试通过，tsc 0 错误 | e57665a3 |
| P1 | `apps/api/src/auth/approval-audit.ts` | 2208 | 单域。读路径过胖，改到时再拆 `readRequestById` | 未处理 |  |  |
| P1 | `apps/api/src/order/settlement-record.ts` | 2186 | 结算状态机。可按阶段分文件，不拆成多个提交点 | 未处理 |  |  |
| P1 | `apps/api/src/auth/auth-security.ts` | 2019 | 路由袋。按命令组搬到已有模块，目录与 `admin-directory.ts` 对齐 | 未处理 |  |  |
| P1 | `apps/admin/src/views/membership-growth-view.tsx` | 2313 | 随改动拆成长视图 | 未处理 |  |  |
| P1 | `apps/api/src/im/yunxin-routes.ts` | 1829 | 胖路由，改到时把业务判断留在领域模块 | 未处理 | 本次未拆（其 40 个咨询符号继续经 `consultation.ts` 原路径 re-export 获取，路由与消息段的源码断言保持原样）；路由层厚薄留待下次改到时处理 |  |
| P1 | `apps/web/src/components/supply-workspaces.tsx` | 1795 | 随改动拆供给工作区 | 未处理 |  |  |
| P1 | `apps/api/src/auth/auth-runtime.ts` | 1639 | 运行时装配偏长，改到时按装配步骤分块 | 未处理 |  |  |
| P1 | `apps/api/src/supply/supply-routes.ts` | 1600 | 路由与校验偏厚 | 未处理 |  |  |
| P1 | `apps/web/src/components/market/market-filter-controls.tsx` | 1392 | 筛选副作用随改动拆 | 已完成 | 拆出 `market-filter-types.ts`(37)/`market-select.tsx`(63)/`market-filter-row.tsx`(86)/`market-dimension-filters.tsx`(304)/`market-resource-filters.tsx`(201)/`market-skin-filters.tsx`(222)，原文件降至 549 行并完整 re-export 对外契约；测试沙箱 `loadControls` 适配相对路径动态转译；验证：`account-market-filter-behavior` 27/27, `listing-feed` 16/16 全部通过，tsc 0 错误 | 3f888a3b |
| P1 | `apps/api/src/content/content-routes.ts` | 1376 | 内容胖路由 | 未处理 |  |  |
| P1 | `packages/ui/src/order-team-panel.tsx` | 1359 | 共享订单群面板，随改动拆 | 未处理 |  |  |
| P1 | `apps/web/src/components/account/account-center.tsx` | 1356 | 个人中心壳，随改动拆 | 已完成 | 拆出 `account-nav-constants.ts`(109)/`account-growth-header.tsx`(180)/`account-overview-strip.tsx`(247)/`account-pending-tasks.tsx`(151)/`account-order-cards.tsx`(313)/`account-overview.tsx`(166)，原文件瘦身至 264 行并完整 re-export 全部公开组件与导航常量；独立对齐退还保证金断言；验证：`account-center-behavior` 47/47, `account-module-behavior` 49/49, `membership-center` 16/16, `account-security-ui` 98/98 全部通过，tsc 0 错误 | ea252a4b |
| P1 | `apps/web/src/components/account/account-security-controls.tsx` | 1319 | 安全操作随改动拆 | 未处理 |  |  |
| P1 | `apps/web/src/components/market/listing-detail.tsx` | 1255 | 详情页随改动拆 | 未处理 |  |  |
| P1 | `apps/admin/src/views/im-support-fulfillment.tsx` | 1254 | 履约子视图状态仍多，随客服总台一起收 | 已完成 | 保守拆出 `im-support-fulfillment-model.ts`(纯数量/金额解析、阶段与取消原因文案、持久化键)与 `im-support-cancel-cards.tsx`(SupportUnpaidCancelCard+SupportCancelCard)，原文件降至 937 行；`OrderFulfillmentSection`、`SupportUnpaidCancelCard`、`StageCardAttentionNotice` 仍从原路径导出（`admin-order-chain-view.tsx` 禁改，经 re-export 不变）。履约写意图/在途锁/结果未知收敛逻辑未动。验证：tsc/build 通过，fulfillment/support-cancel/legacy-order-support-display/order-workbench 89/89；真实 PG/渠道 NOT_RUN |  |
| P1 | `apps/api/src/im/support-management.ts` | 1245 | 客服管理读写混在一个模块 | 未处理 | 本次未拆读写；仅随 `consultation.ts` 拆分把第 13 行 type-only 回引改指 `consultation-internals.ts`，消除对聚合壳的源码级回指，报表 SQL 断言未受影响 | 5cf6dd29 |
| P1 | `apps/api/src/auth/user-directory.ts` | 1222 | 用户目录领域，随改动拆 | 未处理 |  |  |
| P1 | `apps/api/src/supply/legacy-observation.ts` | 1221 | 旧供给观察读模型 | 未处理 |  |  |
| P1 | `apps/api/src/auth/membership-growth.ts` | 1217 | 成长领域，随改动拆 | 未处理 |  |  |
| P1 | `apps/api/src/im/yunxin-provider.ts` | 1164 | 云信渠道客户端，协议细节集中 | 未处理 |  |  |
| P1 | `apps/admin/src/views/supply-catalog-view.tsx` | 1164 | 目录视图随改动拆 | 未处理 |  |  |
| P1 | `apps/web/src/components/market/account-market.tsx` | 1125 | 市场列表副作用多，随改动拆 | 已完成 | 拆出 `market-banner.tsx`(23)/`market-error-display.tsx`(34)/`market-toolbar.tsx`(601)，原文件降至 683 行，聚焦于数据流管理与卡片列表，re-export `AccountMarket`；验证：`listing-feed` 16/16, `account-market-filter-behavior` 27/27 全部通过，tsc 0 错误 | 3f888a3b |
| P1 | `apps/api/src/supply/catalog.ts` | 1106 | 目录读写，随改动拆 | 未处理 |  |  |
| P1 | `apps/api/src/credit/credit-guarantee.ts` | 1086 | 保证金领域，随改动拆 | 未处理 |  |  |
| P1 | `apps/web/src/components/order/rental-confirm-panel.tsx` | 1082 | 确认下单面板，随改动拆 | 未处理 |  |  |
| P1 | `apps/admin/src/views/supply-media-review-view.tsx` | 1053 | 媒体审核视图，随改动拆 | 未处理 |  |  |
| P1 | `apps/admin/src/views/membership-benefits-workspace.tsx` | 1032 | 权益工作区，随改动拆 | 未处理 |  |  |
| P1 | `apps/api/src/finance/channel-evidence-read.ts` | 1023 | 渠道证据读模型 | 未处理 |  |  |
| P1 | `apps/api/src/order/order.ts` | 1023 | 订单核心。保持一个入口，避免把锁和状态拆散 | 未处理 |  |  |
| P1 | `apps/api/src/auth/membership-growth-integration.ts` | 1003 | 成长接入面过宽 | 未处理 |  |  |
| P1 | `apps/api/src/im/order-team.ts` | 998 | 订单群模块 | 未处理 |  |  |
| P1 | `apps/admin/src/views/role-config-view.tsx` | 993 | 角色配置视图 | 未处理 |  |  |
| P1 | `apps/admin/src/views/security-self/command-dialogs.tsx` | 990 | 多个安全命令对话框共文件 | 未处理 |  |  |
| P1 | `apps/api/src/docs/docs-store.ts` | 978 | 文档存储 | 未处理 |  |  |
| P1 | `apps/api/src/auth/admin-directory.ts` | 978 | 与 `auth-security.ts` 的目录路由对齐 | 未处理 |  |  |
| P1 | `apps/api/src/content/content.ts` | 976 | 内容领域 | 未处理 |  |  |
| P1 | `apps/admin/src/views/im-support-management-model.ts` | 955 | 客服管理纯视图模型 | 未处理 |  |  |
| P1 | `apps/admin/src/views/content-help-tree.tsx` | 945 | 帮助树编辑与拖拽状态 | 未处理 |  |  |
| P1 | `apps/web/src/components/order/order-detail.tsx` | 943 | 订单详情 | 未处理 |  |  |
| P1 | `apps/api/src/im/order-im-events.ts` | 942 | 订单 IM 事件 | 未处理 |  |  |
| P1 | `apps/web/src/components/account/membership-center.tsx` | 939 | 会员中心 | 未处理 |  |  |
| P1 | `apps/admin/src/views/im-support-management.tsx` | 932 | 客服管理视图 | 未处理 |  |  |
| P1 | `apps/admin/src/views/user-directory/user-directory-list.tsx` | 920 | 用户目录列表 | 未处理 |  |  |
| P1 | `apps/api/src/supply/publishing-routes.ts` | 814 | 上架路由层偏厚 | 未处理 |  |  |
| P1 | `apps/admin/src/main.tsx` | 804 | 应用引导 | 未处理 |  |  |
| P1 | `apps/web/src/components/account/bank-binding-workspace.tsx` | 782 | 绑卡工作区 | 已完成 | 拆出 `bank-binding-types.ts`(90)/`bank-binding-panel.tsx`(224)/`bank-demo-withdrawal-panel.tsx`(215)/`bank-channel-withdrawal-panel.tsx`(303)/`bank-withdrawal-history.tsx`(176)，原文件瘦身至 175 行并保留唯一组件 `BankBindingWorkspace`；清晰隔离演示沙箱提现并标注上线前需移除；验证：`personal-wallet-behavior` 132/132 全部通过，tsc 0 错误 | f67446ec |
| P1 | `apps/admin/src/views/admin-orders-view.tsx` | 762 | 订单列表与列、筛选 | 未处理 |  |  |
| P1 | `apps/api/src/bff/admin-bff.ts` | 756 | 管理 BFF 聚合偏宽 | 未处理 |  |  |
| P1 | `apps/api/src/finance/admin-distribution-dashboard.ts` | 734 | 分销看板读与汇总 | 未处理 |  |  |
| P1 | `apps/admin/src/views/admin-finance-view.tsx` | 723 | 资金看板 | 未处理 |  |  |
| P1 | `apps/admin/src/views/docs/docs-detail.tsx` | 716 | 文档详情 | 未处理 |  |  |
| P1 | `apps/admin/src/views/supply-gunsmith-view.tsx` | 702 | 枪匠视图 | 未处理 |  |  |
| P1 | `apps/admin/src/views/legal-documents-panel.tsx` | 682 | 法律文档面板 | 未处理 |  |  |
| P1 | `apps/admin/src/views/supply-listing-review-view.tsx` | 644 | 上架审核视图 | 未处理 |  |  |
| P1 | `apps/api/src/profile/profile-avatar-routes.ts` | 638 | 头像路由偏厚 | 未处理 |  |  |
| P1 | `apps/api/src/order/channel-payment-store.ts` | 637 | 渠道支付存储 | 未处理 |  |  |
| P1 | `apps/admin/src/workspace/app-shell.tsx` | 587 | 壳层副作用偏多 | 未处理 |  |  |
| P1 | `apps/admin/src/views/content-resource-editor.tsx` | 576 | 内容资源编辑器 | 未处理 |  |  |
| P1 | `apps/admin/src/views/im-support-settings.tsx` | 559 | 客服设置 | 未处理 |  |  |
| P1 | `apps/admin/src/views/content-view.tsx` | 555 | 内容视图 | 未处理 |  |  |
| P1 | `apps/admin/src/views/content-item-editor.tsx` | 512 | 内容条目编辑器 | 未处理 |  |  |
| P1 | `apps/admin/src/views/supply-rules-view.tsx` | 504 | 供给规则视图 | 未处理 |  |  |
| P1 | `apps/admin/src/views/admin-order-chain-view.tsx` | 493 | 订单链视图 | 未处理 |  |  |
| P1 | `apps/web/src/components/support/customer-support-workspace.css` | 479 | 25 处 `!important`，随客服组件再切 | 已完成 | 随组件边界切出 `support-thread-list.css`(45)/`support-composer.css`(58)，原文件 479→387 行；`!important` 本次只搬移不清理。注入顺序按 import 保持 base→thread-list→composer→rating→order-team/message-actions/message-media，媒体查询随对应规则一起搬移并保留原相对位置。脚本逐条比对 (media, selector, property) 的最终生效值：1857 条声明与原文件完全一致。发现两条原本就失效的声明（520px 的 `.support-composer-wrap{padding-inline:10px}` 被后面的 `padding` 简写覆盖；760px 的 `.support-staged-remove{32px}` 被后面的 22px 覆盖），本次按原样保留未修，待裁定。真实浏览器窄屏实看 NOT_RUN。两条死规则已按 Owner 裁定单独修：520px/760px/768px 媒体查询全部移到基础规则之后，`.support-staged-remove` 窄屏由 32px 改 44px（与同一查询里的工具按钮同档）；`.support-composer-wrap` 的 520px `padding-inline:10px` 现在真正生效。脚本复比 1857 条声明，除 `.support-staged-remove` 的 width/height 32→44 外无其他差异 | 54256229 |
| P1 | `apps/admin/src/workspace/account-security-page.tsx` | 451 | 安全命令页状态多 | 未处理 |  |  |
| P1 | `apps/admin/src/views/distribution-dashboard-pages.tsx` | 437 | 多页看板写在一个文件 | 未处理 |  |  |
| P1 | `apps/web/src/components/account/account-center.css` | 3928 | 多族选择器加 64 处 `!important`，随个人中心组件再切 | 维持原样 | 测试第 1465 行静态读取 `account-center.css` 并对 `.membership-card.has-card-art` 计算样式强断言，保持样式文件完整不拆分以确保跨组件选择器和断言稳定 | ea252a4b |
| P1 | `apps/web/src/components/supply/publish-refinement.css` | 3159 | 113 处 `!important`，随上架表单再切 | 维持原样 | 按用户指令跳过 CSS 拆分与清理；测试第 1122 行静态依赖 `.publish-rail[data-tall="true"]` 与 1023px 媒体查询，保持单一完整样式表不拆分 | e912b968 |
| P1 | `apps/web/src/app/globals.css` | 2953 | 令牌、重置、门户、按钮、顶栏分开 | 未处理 |  |  |
| P1 | `apps/web/src/components/market/account-detail.css` | 2496 | 详情样式体积过大 | 未处理 |  |  |
| P1 | `apps/web/src/components/market/market.css` | 1682 | 27 处 `!important` | 维持原样 | 市场列表、抽屉与皮肤面板共享统一类名空间，保持 `market.css` 完整性避免样式加载顺序错乱 | 3f888a3b |
