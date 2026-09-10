# 第三方前端来源

管理端认证外壳与粒子效果适配自 [Devl](https://github.com/sean-brydon/devl.dev)，对应 login/onboarding registry；源码位于 apps/admin/src/components/devl/，图像位于 apps/admin/src/assets/devl/。这是当前页面实际使用的实现，未作为演示副本保留。

Devl 当前公开源码未查到明确许可证。本地保存来源不表示获得 MIT 或生产分发许可；发布前须确认作者授权。不要将上游整个仓库或其本机工具配置复制入项目。

OTP 动效组件位于 components/smoothui/，基于 input-otp 与 motion；准确依赖版本和包许可证见 package-lock.json 及安装包。该组件的上游文件出处及许可还需在公开发布前核实，不推断所有组件统一许可。

二维码使用 qrcode.react，在浏览器本地生成。Logo 为 Owner 提供的项目物料，见 assets/brand/README.md。未使用的模板演示页、备用图和旧粒子组件已移出应用源码。
