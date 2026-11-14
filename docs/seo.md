# 用户站 SEO 约定

状态：第一阶段已实现（随切换上线发布）；账号详情与列表的服务端渲染、详情页入 sitemap 属第二阶段，尚未实现。适用范围仅 `apps/web`。

## 环境开关与不可收录表现

- `ZZSH_SEO_INDEXABLE` 严格等于 `1` 时才视为可收录；缺失、空值或其他值一律不可收录。生产配置 `ZZSH_SEO_INDEXABLE=1` 与 `ZZSH_WEB_ORIGIN=https://www.zzsh51.com`；测试环境不配置该开关。模板见 `apps/web/.env.deployment.example`。
- 开关为 `1` 但 `ZZSH_WEB_ORIGIN` 不是合法 `https://` origin 时按不可收录处理，并在服务端日志输出配置错误（`src/lib/seo.ts`）。该情况下不生成可收录的 robots、sitemap 或 canonical。
- 不可收录环境：所有响应带 `X-Robots-Tag: noindex, nofollow`；`robots.txt` 为 `User-agent: *` + `Disallow: /`；`sitemap.xml` 返回 404。
- 可收录环境：`/api/*` 的非图片响应带 `X-Robots-Tag: noindex`；公开图片字节路由 `/api/supply/media/*/content`、`/api/supply/listings/*/media/*`、`/api/supply/listings/*/legacy-images/*` 不加该头。
- 以上响应头与旧站跳转统一在 `apps/web/src/proxy.ts` 实现，不逐个修改 route handler。

## 标题、描述与 canonical

- 全局标题模板 `%s - 洲洲商行`；首页使用绝对标题 `洲洲商行 - 三角洲行动账号租赁平台`，不套模板。页面不得手写品牌后缀。
- `metadataBase` 取 `ZZSH_WEB_ORIGIN`；canonical 为规范域名下的绝对地址并去掉查询参数（`/help?category=` 例外，见下表）。不可收录环境不输出 canonical。
- 默认 OpenGraph：`siteName: 洲洲商行`、`locale: zh_CN`、`type: website`，图片为 `public/brand/zzsh-logo-variant-01.png`（1254×1254 正方形）。
- 首页输出唯一一段 JSON-LD：`WebSite` 与 `Organization`（含绝对地址 logo），仅在可收录环境输出。站点根提供 `/favicon.ico`（48 与 96 两档正方形），`layout.tsx` 的 icons 声明与之一致。
- 首页保持静态预渲染（production-isolation 契约依赖预渲染 HTML）。因此首页的 canonical 与 JSON-LD 在**构建期**读取开关：生产构建必须注入 `ZZSH_SEO_INDEXABLE=1` 与规范 `ZZSH_WEB_ORIGIN`；测试环境构建不注入。robots、sitemap、响应头与其余页面的 canonical 仍在运行时按开关判定。
- 标题与描述文案为草稿，待 Owner 或运营定稿；替换文案不改结构。

## 收录口径

| 页面 | 收录 | canonical |
|---|---|---|
| `/` | 是 | `/` |
| `/accounts`（无筛选，或仅 `game` 且值为默认游戏 `delta`） | 是 | `/accounts` |
| `/accounts?<其他任意参数>` | `noindex, follow` | `/accounts` |
| `/accounts/[id]` | 是 | `/accounts/[id]` |
| `/accounts/[id]?fromOrder=…` 或带 `party=` | `noindex, follow` | `/accounts/[id]` |
| `/publish`（含 `?mode=` 等参数） | 是 | `/publish` |
| `/login`（含 `?returnTo`/`?next` 等参数） | 是 | `/login` |
| `/help` | 是 | `/help` |
| `/help?q=…` | `noindex, follow` | `/help` |
| `/help?category=…`（真实分类） | 是 | 带 `category` 的自身地址 |
| `/help?category=…`（不存在的分类） | `noindex, follow` | `/help` |
| `/help/[slug]`（已发布） | 是 | 自身 |
| `/help/[slug]`（RETIRED） | `noindex` | 不输出 |
| `/updates`、`/updates/[id]` | 是 | 自身（去参数） |
| `/legal/[doc]`（PUBLISHED） | 是 | 去掉 `version` 后的地址 |
| `/legal/[doc]`（PENDING 或读取失败） | `noindex` | 不输出 |
| `/legal/[doc]?version=…` | `noindex` | 同上 |
| `/gunsmith` | 不处理 | 不处理 |
| `/account/*` | `noindex`（`app/account/layout.tsx`） | 不输出 |
| `/access-denied` | `noindex` | 不输出 |

子链候选页 `/`、`/accounts`、`/publish`、`/help`、`/updates`、`/login` 的 title 与 description 互不相同，且服务端首屏 HTML 含可见 `<h1>` 与一句说明正文（`curl -A "Baiduspider"` 可直接看到）。首页 H1 为嵌入式单行导语，不重做首页框架；禁止只给爬虫看的隐藏文字。

## robots.txt

可收录环境输出：

```
User-agent: *
Allow: /accounts
Disallow: /account
Sitemap: https://www.zzsh51.com/sitemap.xml
```

**不得写 `Allow: /`**：百度按“从上往下、第一条匹配生效”解析，`Allow: /` 会使 `Disallow: /account` 永远不生效；Google 按最长路径优先。只保留 `Allow: /accounts` 与 `Disallow: /account` 时两种解析结果都正确（`/accounts` 显式放行，避免被 `/account` 前缀命中；其余路径无匹配规则默认允许）。不得写 `Disallow: /api/`（非 CDN 模式图片走 `/api/supply/...`）；登录页等用 noindex 控制，不写 Disallow。

## sitemap.xml

- 仅可收录环境输出；不可收录环境 404。
- 第一阶段包含：`/`、`/accounts`、`/publish`、`/help`、`/updates`、`/login`；全部已发布帮助文章（`loadPublicHelpArticles`）；全部平台动态（`loadPlatformUpdates` 逐页取全）；**仅 PUBLISHED** 的协议 `/legal/terms`、`/legal/privacy`（PENDING 排除）。
- 不包含 `/gunsmith`、`/account/*`、noindex 页面与账号详情页（详情页入 sitemap 属第二阶段）。
- `lastModified` 只取数据源可信时间：帮助文章 `updatedAt`、平台动态 `publishedAt`；静态页与协议不写 `lastModified`，不得用当前时间伪造。
- 任一数据源读取失败时整个 sitemap 返回 5xx，不输出缺项的 200；协议读取返回 UNAVAILABLE 同样视为失败。
- 单个 sitemap 上限 5 万条，接近上限时改 `generateSitemaps` 分片。

## 旧站 URL 跳转（301）

路径级跳转在 `src/proxy.ts` 实现（`next.config` 的 `redirects()` 会保留原查询参数，无法去参）。目标地址一律不带旧参数；状态码一律 301。域名级跳转（裸域→www、http→https）由运维在 Nginx/CDN 处理。

| 旧 URL | 目标 |
|---|---|
| `/home` | `/` |
| `/rent`（任意参数） | `/accounts` |
| `/homeDetail`（任意参数） | `/accounts` |
| `/gun-code` | `/gunsmith` |
| `/individualMenu/postRentNotice?id=14/15/16/17/19` | 复用 `src/content/help/legacy-links.ts` 的 `legacySiteUrlMap` 跳 `/help/{slug}` |
| `/individualMenu/privacy`、`/individualMenu/disclaimer` | 同上表，`/help/terms-and-privacy` |
| `/individualMenu/postRentNotice`（其他 id 或无 id） | `/help` |
| `/individualMenu/officialNotice`、`/individualMenu/gameNews`（任意参数） | `/updates` |
| `/individualMenu/` 下 `personalCenter`、`myWallet`、`withdrawal`、`myCollection`、`attestation`、`distributor`、`taskCenter`、`taskInfo`、`empCenter`、`bindInfo`、`orderDetail`、`accountSetting` | `/account` |
| `/proxy-level`、`/proxy-level/issue`、`/proxy-level/detail` | `/account` |
| `/escort`、`/individualMenu/gamePaly`、`/individualMenu/letterToShareholders`、`/individualMenu/cooperation` | 404，不写规则 |
| 其他未知路径 | 404，Next 默认处理 |

跳转规则不得影响新站现有路由与 `/_next`、`/api`、静态资源。

## 状态码原则

- 跳转一律 301，不用 Next 默认的 308。
- 旧站 301 的 Location 以 `ZZSH_WEB_ORIGIN` 为 base 拼接（反向代理后 `request.url` 可能是内部监听地址）；仅本地未配置该变量时回退请求自身 origin。
- 资源不存在返回真 404；禁止 200 加空页面或统一跳首页。
- 上游读取失败走 5xx 或现有 `error.tsx`；禁止渲染成空列表、空 sitemap 或 200 的“无结果”。

## 上线检查（代码侧清单）

1. 生产**构建**必须注入 `ZZSH_SEO_INDEXABLE=1` 与 `ZZSH_WEB_ORIGIN=https://www.zzsh51.com`：首页保持静态预渲染，其 canonical、JSON-LD 与绝对地址 OG 图片在构建期固定。构建入口见 `docs/operations/initial-deployment-configuration.md`；**测试镜像不得直接提升到生产**。
2. 生产首页 HTML 必须同时包含 `<link rel="canonical" href="https://www.zzsh51.com/">` 与 `application/ld+json`（WebSite + Organization）；缺失即构建未注入变量，禁止上线。
3. 运维确认裸域与 http 均 301 到规范域名；带 `Host: www.zzsh51.com` 与 `X-Forwarded-Proto: https` 抽查旧站跳转，Location 必须为规范域名绝对地址。
4. 生产复跑收录口径、robots、sitemap 与候选页检查（对应验收 A2、A4、A5、A7、A10）。