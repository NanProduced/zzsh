# 第三方前端来源

管理端认证外壳与粒子效果适配自 [Devl](https://github.com/sean-brydon/devl.dev)，对应 login/onboarding registry；源码位于 apps/admin/src/components/devl/，图像位于 apps/admin/src/assets/devl/。这是当前页面实际使用的实现，未作为演示副本保留。

Devl 当前公开源码未查到明确许可证。本地保存来源不表示获得 MIT 或生产分发许可；发布前须确认作者授权。不要将上游整个仓库或其本机工具配置复制入项目。

管理端工作区壳适配自 [PaceUI Free Dashboard](https://github.com/paceui/shadcn-nextjs-free-dashboard)，核查版本 `f5ee228a5e9120f9c4ed0b59bf55290d75b28aa1`，MIT 许可原文在 `apps/admin/src/vendor/paceui/LICENSE`，复制与改造清单见 `apps/admin/src/vendor/paceui/COPYING.md`。未引入上游 Next 工程、Pro 外链、医院/销售示例或假营收数据。

OTP 动效组件位于 components/smoothui/，基于 input-otp 与 motion；准确依赖版本和包许可证见 package-lock.json 及安装包。该组件的上游文件出处及许可还需在公开发布前核实，不推断所有组件统一许可。

二维码使用 qrcode.react，在浏览器本地生成。Logo 为 Owner 提供的项目物料，见 assets/brand/README.md。未使用的模板演示页、备用图和旧粒子组件已移出应用源码。

工作台拖拽与缩放使用 [GridStack](https://github.com/gridstack/gridstack.js) 13.2.0（MIT），通过随包 React 包装器渲染。GridStack负责布局，组件内容由React管理；具体版本固定在依赖与锁文件中。
