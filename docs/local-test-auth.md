# 本地业务验收快速登录

日常供给、订单、云信和 UI 验收使用 `npm run local:auth`，自动完成密码和管理员 TOTP，加载真实 Cookie 后直接验证业务。无需手机验证器、重复初始化或重置数据库。认证专项测试仍走完整页面流程；自动登录不能作为登录页面验收证据。

## 每个环境只登记一次

在已登记的本地环境中复用现有测试账号。环境维护者从已有 fixture 凭据文件生成下列格式的私密 JSON，运行 `ensure` 导入。不要将实际密码写进命令参数、聊天或源码。`userId` 必须是对应 realm 的真实账号 ID。

```json
{
  "version": 1,
  "localTest": true,
  "resource": "example_test",
  "actors": {
    "service-a": {
      "realm": "admin",
      "origin": "http://127.0.0.1:4311",
      "userId": "REPLACE_ADMIN_ID",
      "username": "REPLACE_USERNAME",
      "password": "REPLACE_PASSWORD",
      "totp": { "encoding": "base32", "secret": "REPLACE_URI_SECRET" }
    },
    "renter-a": {
      "realm": "user",
      "origin": "http://127.0.0.1:4310",
      "userId": "REPLACE_USER_ID",
      "username": "REPLACE_PHONE",
      "kind": "phone",
      "password": "REPLACE_PASSWORD"
    }
  }
}
```

TOTP 的两种输入必须明确：绑定 `otpauth://` URI 的 `secret` 用 `base32`；Better Auth 解密后的原始字符串或直接加密入库的 fixture 原文用 `utf8`。不能看起来像 Base32 就自行解码。工具按当前 SHA1、6 位、30 秒配置计算，已用 RFC 向量验证。

```powershell
npm run local:auth -- ensure --resource example_test --input C:/absolute/private-profile.json
npm run local:auth -- list --resource example_test
npm run local:auth -- login --resource example_test --actor service-a
npm run local:auth -- login --resource example_test --actor renter-a
```

尚未同步本工具的旧 worktree，直接调用主检出的脚本即可，无须 cherry-pick 或重新安装依赖：

```powershell
node E:/zzsh/zzsh/scripts/local-auth.mjs login --resource supply_experience_catalog --actor admin
node E:/zzsh/zzsh/scripts/local-auth.mjs login --resource supply_experience_catalog --actor browser
```

上面资源是已登记的 432x 供给测试环境：`admin`、`publisher`、`browser`、`stranger` 为四个现有身份。其他环境必须使用自己的资源登记；不能为图方便借用该环境执行写入测试。实时用途、维护者和可用性查看主检出的环境登记。

`ensure` 幂等登记现有账号，不创建数据库、不创建或提升管理员。相同配置重复运行直接复用，不同配置拒绝覆盖；维护者确需更换账号或端口时编辑工具输出的私密 profile，并重新登录。新环境仅首次由其准备脚本创建并激活测试身份、保存凭据，再登记；不要为登录问题重跑整个 seed/reset。

默认凭据集中保存在 **主检出** `apps/api/.secrets/local-auth/<resource>/profile.json`。跨 worktree 调用通过 Git 查找主检出，避免删工作树后丢凭据。每个资源集有独立账号、端口和状态文件。环境创建脚本须保持同一管理员 realm secret：它用于解密 TOTP，不能每次启动随机替换。保留密码、TOTP、数据库与稳定的服务端认证配置；停止服务不得删除这些输入。临时浏览器状态可以删除，环境退役时再一并清理凭据。

## 浏览器直接进入业务页

`login` 输出 `authenticated:true` 及 `storageState` 的绝对路径，不输出 Cookie。有效缓存先经服务端确认身份再复用；过期则自动重新登录。管理员须为 ACTIVE、完成改密和 2FA、会话未锁定。用户登录使用密码，不调用短信。

agent-browser 使用新独立会话，并在第一次打开页面前加载状态：

```powershell
agent-browser --session my-task-admin --state "ABSOLUTE_STORAGE_STATE_PATH" open http://127.0.0.1:4311/support
agent-browser --session my-task-admin snapshot -i
```

已有 Playwright 脚本使用 `browser.newContext({ storageState: absolutePath })`；playwright-cli 可用 `state-load` 加载后再打开业务页。其他浏览器工具若不能导入 Cookie，使用支持状态导入的独立自动化会话，不操作 Owner 已打开的浏览器账户。**同主机 Cookie 不按端口隔离**，每个环境、每个身份使用独立 context/session，不能混装两个人的状态。

人工验收需要验证码时，在本地终端运行（不要将输出收集到日志）：

```powershell
npm run local:auth -- otp --resource example_test --actor service-a --clipboard
```

将剪贴板验证码粘贴到管理端，使用后清空剪贴板；省略 `--clipboard` 会在本地终端显示当前验证码。`local:admin` 是同一命令的别名。`login --fresh` 强制重新通过密码/TOTP；普通业务验收优先复用会话。

## 失败处理

| 结果 | 处理 |
|---|---|
| PROFILE_MISSING | 查环境登记和原 fixture，运行 ensure 导入；不重新创建环境 |
| PASSWORD_HTTP_401 | 核对应账号、密码、端口、API 指向；不暴力重试或重置 Boss |
| TOTP_HTTP_401 | 检查显式编码、绑定是否匹配、系统时间；不每轮重新实现 TOTP 算法 |
| ADMIN_ENROLLMENT_REQUIRED | 该测试账号尚未初始化，维护者只完成该账号改密/绑定/激活并保存最终凭据 |
| ADMIN_SESSION_LOCKED | 认证专项保留锁态；普通业务验收可用 --fresh 创建新会话，不改账号或其他会话 |
| SESSION_IDENTITY_MISMATCH | 端口/账号映射错误，停止使用该状态；不能自动换成 Boss |
| 网络错误 / 503 | 核服务归属与代理；不能重置数据库解决服务未启动 |

工具只有本地 CLI，不安装到前端、不新增免鉴权接口；只连接显式 `http://127.0.0.1:<port>`，拒绝重定向。测试身份保留实际角色和对象权限，不把所有账号变成 Boss。Owner 已授权本地业务验收使用本方法，无须每轮重复申请“跳过手工认证”；生产和认证专项不使用此快捷流程。

验证：`npm run test:local-auth`。真实环境验证结果另记任务 brief，不把 CLI 单元测试当成浏览器或业务链路验收。
