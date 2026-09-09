# 项目文档导航

- [Serena 项目范围](serena.md)：分别激活 admin、api、web，禁止注册 monorepo 根。

- [开发与检查命令](development.md)：三端启动、构建与验证范围。
- [框架验证记录](framework-verification.md)：本地通过项与 NOT_RUN。

- [选型状态](architecture/technology-decisions.md)：明确决定与尚未冻结的组件。
- [多端与 BFF 约束](architecture/multi-client-bff.md)：Web、iOS/Android、小程序的职责边界与兼容要求。
- [仓库结构](architecture/repository-layout.md)：monorepo 边界与开发方式。
- [旧平台证据导航](legacy/README.md)：仓库外报告、反编译代码和原始归档。
- [Figma 看板](design/boards.md)：现状业务图与竞品/选型板。
- [重建开发总计划与 Tracker](planning/rebuild-development-tracker.md)：模块边界、开发顺序、Gate、依赖和当前可执行任务。
- [管理平台与数据分析基础调研](research/admin-platform-data-analysis-research.md)：旧后台主要能力覆盖、岗位工作流、指标候选和分阶段数据要求；已由 Master 复核，非生产数据验收。

新决定和正式设计放在本仓库；旧分析保留原位，避免重复副本和断开的证据引用。旧资料并非随 Git 克隆提供，跨机器需通过受控方式取得。
