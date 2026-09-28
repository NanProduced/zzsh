# 技术选择

本项目采用 npm workspaces、TypeScript 和模块化单体；生产数据库目标为托管 PostgreSQL。

| 层 | 当前实现 |
|---|---|
| 用户站 | Next.js / React |
| 管理站 | Vite / React / Tailwind CSS |
| API | NestJS，业务规则及授权集中在服务端 |
| 数据访问 | Drizzle + pg；金额使用 PostgreSQL numeric，避免浮点账务真值 |
| 认证 | Better Auth + 官方 Drizzle adapter，用户与管理身份隔离 |
| 本地依赖 | PostgreSQL 16、Redis 7，独立 Compose 项目 |

准确版本以 package-lock.json 为准，Node 基线见 .node-version。共享 packages 仅承载已有实际共享需求。BFF 不直连交易库、不重复业务规则，详见 [多端边界](multi-client-bff.md)。

认证功能包含管理员初始化、密码/TOTP/备份码、冻结、会话 PIN、受控恢复、管理员目录和可配置操作权限。最小审批与审计、正式资金依据读取及受控交易账务基础已实现；完整配置/页面与真实渠道接入仍未闭环。本地受控收款、余额贷项或退款应付款不代表渠道到账。

管理工作区采用 PaceUI 适配壳与 GridStack 可编辑网格，个人布局通过服务端按管理员保存，格式版本与并发版本分离。默认组件仅使用已有受权数据，经营账务图表随业务接口接入。

首期业务为在线选账号、支付后由真人客服通过网易云信履约；不假设自动交付。第三方资金结果、订单状态、交付状态分别建模。

当前 React 为 19.x；此前隔离评估的 `@xkit-yx/im-kit-ui@10.9.11` 存在 React peer 版本不兼容，不能原样作为已验收接入方案，也不能把修改安装包声明当作上游修复。自研客服界面与共享 NIM V2 客户端基础已进入 main，默认关闭；真实 SDK 通信、渠道权限和历史会话迁移仍需独立验收，见[客服接入说明](customer-support.md)。

生产地域、容量、云资源、真实渠道接入与恢复演练尚未验收。订单与资金的目标为 RPO≤5分钟、核心 RTO≤1小时，需独立备份恢复与对账演练验证。
