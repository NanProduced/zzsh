# 框架初始化验证

2026-09-08，本机 Windows / Node 24.20.0 / npm 11.19.0。

- PASS：三 workspace TypeScript 检查。
- PASS：API 本地 HTTP 测试，健康响应、未开放交易接口及开发 OpenAPI 契约。
- PASS：Next、Vite、Nest 三端构建。
- PASS：构建产物 smoke，用户站 HTML、后台 JS 资源、API liveness、production 下 docs 返回404；使用临时本地端口，进程自动清理。
- PASS：npm run dev 三端联动；本机3000已占用，项目改用3100/3101/3102，没有结束其他项目进程。
- PASS：本地浏览器实际查看用户站与管理站占位页，检查标题、内容与样式。没有进行真实业务操作。
- PASS：npm audit --omit=dev --registry=https://registry.npmjs.org 报告0项已知漏洞；默认镜像审计端点不支持，故本次指定官方端点。该结果不是完整安全审计。

Next dev 自动生成 apps/web/AGENTS.md 与 CLAUDE.md，提示阅读对应版本的本地文档；不覆盖根目录协作规则。既有用户安装的 .agents/.claude skills 和 skills-lock.json 未修改。

NOT_RUN：生产数据库连接、ORM、迁移、用户身份与权限、支付等第三方、Sentry/PostHog、容器构建、云部署、GitHub远端CI、负载与容量测试。本轮没有提交或推送。
