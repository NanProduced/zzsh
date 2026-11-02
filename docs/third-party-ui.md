# 第三方前端来源

管理端持续反馈统一复用 `components/ui/alert.tsx`，由 [ReUI Alert](https://reui.io/docs/components/base/alert) 的 MIT 组件适配；保留 Alert、AlertTitle、AlertDescription、AlertAction 四部件及旧 danger 别名。StatusMessage、SettingsNotice共用该入口，不另建反馈引擎。正常说明用status，风险/结果待核用warning，明确失败用destructive；已核拒绝不显示为成功。可关闭提示只影响展示，原请求责任和业务门禁由调用方保留。高敏确认继续使用项目现有Dialog，未新增依赖。

管理平台新增及优化页面优先复用已有成熟组件，缺口按需采用 [ReUI](https://reui.io/docs) 与 [shadcn/ui](https://ui.shadcn.com/docs/components)，沿当前 Base UI、主题及工作区浮层实现适配。专用能力允许采用其他来源。ReUI 公共仓库的组件示例、primitives 与 hooks 按其 [MIT 许可范围](https://reui.io/legal/license)使用并保留声明，Pro blocks/templates 不混作免费源码；采用时逐件登记出处和改造范围。此处记录选型原则，不代表所有候选已经进入正式产品；4291 展示候选仅供参考。

站内客服的接口、配置及未验收边界见[客服接入说明](architecture/customer-support.md)。

用户端 Header 滚动收缩适配自 Aceternity Resizable Navbar，Footer 适配自 SmoothUI footer-1。实际组件位于 `apps/web/src/components/layout/`；源码出处、改造范围及 SmoothUI MIT 原文见 [第三方说明](../apps/web/src/components/layout/THIRD_PARTY_NOTICES.md)。Aceternity 使用独立站点许可，不统一归为 MIT。两者复用已有 Motion，手机导航保留 Radix 抽屉，不安装整套上游站点或复制演示社交链接。

管理端认证外壳与粒子效果适配自 [Devl](https://github.com/sean-brydon/devl.dev)，对应 login/onboarding registry；源码位于 apps/admin/src/components/devl/，图像位于 apps/admin/src/assets/devl/。这是当前页面实际使用的实现，未作为演示副本保留。

Devl 当前公开源码未查到明确许可证。本地保存来源不表示获得 MIT 或生产分发许可；发布前须确认作者授权。不要将上游整个仓库或其本机工具配置复制入项目。

管理端工作区壳适配自 [PaceUI Free Dashboard](https://github.com/paceui/shadcn-nextjs-free-dashboard)，核查版本 `f5ee228a5e9120f9c4ed0b59bf55290d75b28aa1`，MIT 许可原文在 `apps/admin/src/vendor/paceui/LICENSE`，复制与改造清单见 `apps/admin/src/vendor/paceui/COPYING.md`。未引入上游 Next 工程、Pro 外链、医院/销售示例或假营收数据。

OTP 动效组件位于 components/smoothui/，基于 input-otp 与 motion；准确依赖版本和包许可证见 package-lock.json 及安装包。该组件的上游文件出处及许可还需在公开发布前核实，不推断所有组件统一许可。

二维码使用 qrcode.react，在浏览器本地生成。Logo 为 Owner 提供的项目物料，见 assets/brand/README.md。未使用的模板演示页、备用图和旧粒子组件已移出应用源码。

管理工作台改为三套固定编排，公共组件位于 `apps/admin/src/components/dashboard/`，底层继续复用 PaceUI 壳、Base UI 与现有 Card/Table/Badge；不引入 GridStack 或自由布局。页头构图参考 [devl Dashboard Header](https://devl.dev/blocks/dashboard-header)，未复制其coss等第三方组件；业务数据与空/未知由本仓处理。新图表通过唯一 `apps/admin/src/components/ui/chart.tsx` 使用Recharts 3.8.0，实际选择采用 [EvilCharts固定MIT源码](https://github.com/legions-developer/evilcharts/tree/4c2dd7c9bae780703244265c9a4b509d40c055ad) 的context、Area/Bar渐变核心、tooltip及legend映射；原文许可和逐文件/功能适配表在 [EvilCharts采用记录](../apps/admin/src/vendor/evilcharts/COPYING.md)。仅保留当前所需primitive，复用house Button与主题，没有整套compound、随机示例数据、第二引擎或Pro资源。现有工作台、分销趋势及客服统计等存量图表已统一迁入该基座，全站图表收敛至单一 ChartContainer 与 EvilCharts recharts-core 测量闭环。Dashboardblocks/ReUI Pro整页未引入。

用户端咨询浮层使用 @radix-ui/react-popover 1.1.23（MIT），复用现有Radix Dialog与Lucide；仅新增Popover基础依赖，未新增动画框架。联系方式为可配置的公开展示数据，当前占位不生成二维码。

用户端与管理端客服工作台的消息滚动行为使用 shadcn 官方 [@shadcn/react](https://github.com/shadcn-ui/ui/tree/main/packages/react) 0.3.1（MIT）的 `message-scroller` headless primitive；消息气泡、商品上下文和品牌样式由本仓库维护。未引入 AI Elements、assistant-ui 等绑定 AI 运行时的聊天套件。

图片/视频查看器使用 yet-another-react-lightbox 3.33.0（MIT，React 19 peer 兼容），仅按需加载 Zoom、Video、Fullscreen 三个插件；宿主的消息列表不挂载完整查看器。媒体原始宽高、文件大小与消息元数据仍由本仓库的受限消息投影提供，小源素材只做展示层投影（不重写服务端事实），图片保留缩放/拖动/全屏，视频保留原生播放/进度/音量/全屏控件。未引入第二套图片或视频播放器。

真实 NIM Web Core 使用 `nim-web-sdk-ng` 10.9.30（npm 元数据声明 ISC；包内未发现独立 LICENSE 文件），适配层位于 `apps/web/src/lib/nim-web-client.ts`：仅动态加载 V2 SDK，固定关闭云端会话并使用本地会话服务，登录状态由应用生命周期隔离层管理。适配层已接入动态 Token、登录/登出、断线状态、销毁闭环及文字消息收发与历史；咨询对端与消息作用域由服务端咨询接口下发，客户端不能自行指定。默认 `YUNXIN_ENABLED=false` 时不装配 provider、不签发 IM 凭据、不发起外部调用。远端结果未知时按失败关闭处理：消息作用域进入人工核验，不自动重建、不盲目重试，界面不冒充已结束或已撤权；真实云信通信与远端撤权仍未验收。

管理端命令面板位于 `apps/admin/src/components/ui/command.tsx` 与 `workspace/page-search.tsx`，结构和视觉参考 ReUI 的 [Command with groups](https://reui.io/components/command/c-command-3) 与 [Recent and favorites](https://reui.io/components/command/c-command-8) 免费组件示例；未引入其整站或 Pro 模板。实际交互使用 `cmdk` 1.1.1（包内 MIT 许可，准确版本见锁文件）和本仓 Base UI Dialog；`cmdk` 包含 Radix 传递依赖，但此处不使用 `Command.Dialog` 挂载另一套弹窗。权限、工作区激活、会话内历史与搜索排序为本项目逻辑，未引入收藏或服务端全文搜索。
