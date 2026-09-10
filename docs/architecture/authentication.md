# 认证与账号安全

用户和管理员使用独立 Better Auth realm、schema、secret 及 Cookie 前缀。Admin BFF 位于 API 同进程，Web BFF 位于 Next.js；BFF 响应不暴露原始会话 token。Cookie 写请求校验 Origin，直接 API 与 BFF 复用管理员门禁。

- 两个同级 Boss，无第三个默认 root。新管理员登录名由 sequence 分配 ZZ 编号，允许跳号，不复用；内部关系 ID 和可编辑显示名称独立。
- 首次临时密码登录后必须修改密码，再完成 TOTP 绑定与激活。同密码被拒绝，改密强制撤销旧会话。旧兼容账号未批量重编号。
- 管理员会话最长7天，用户30天。管理员 PIN 锁定是服务端会话状态；五次失败后需密码与2FA重新认证。冻结即时撤销会话。
- 备份码可替代 TOTP，每码单用，重生成使旧码失效。绑定二维码在本地渲染。
- 普通恢复由目标本人持有恢复凭据，Boss只确认申请；恢复撤销旧凭据及会话。服务器灾备 CLI 当前仅允许隔离 test/fake，不能视为生产恢复工具已验收。
- 关键安全写入与审计同事务；通知 outbox 支持重试、租约与过期写回拒绝，外部投递为至少一次。

现有管理员目录与恢复确认使用 Boss 限制；完整可配置权限/角色与审批引擎未完成。限流为有界单进程实现，多实例/生产反向代理和通知渠道须另验。

关键代码位于 apps/api/src/auth/ 与 apps/api/src/bff/。迁移位于 apps/api/migrations/business/；配置及命令见 [开发说明](../development.md)。Admin 的免账号 UI mock 预览已移除，后续使用独立测试账号验收。
