# PaceUI Free Dashboard 采用说明

- 来源：https://github.com/paceui/shadcn-nextjs-free-dashboard
- 核查版本：`f5ee228a5e9120f9c4ed0b59bf55290d75b28aa1`
- 许可：MIT，见同目录 `LICENSE`
- 版权：Copyright (c) 2026 PaceUI (https://paceui.com)

本目录只保留许可文件。实际源码已适配到 React/Vite 工作区，不引入上游整个 Next.js 工程。

## 已复制并适配

| 上游路径 | 本仓库路径 | 改造 |
|---|---|---|
| `LICENSE` | `apps/admin/src/vendor/paceui/LICENSE` | 原文保留 |
| `lib/utils.ts` | `apps/admin/src/lib/utils.ts` | 原样 |
| `hooks/use-mobile.ts` | `apps/admin/src/hooks/use-mobile.ts` | 去掉 `"use client"` |
| `components/ui/{avatar,badge,breadcrumb,button,card,collapsible,dialog,dropdown-menu,input,popover,scroll-area,select,separator,sheet,sidebar,skeleton,table,tooltip}.tsx` | `apps/admin/src/components/ui/` | 去掉 `"use client"`；sidebar 折叠 cookie 改为 `zzsh-admin-sidebar` |
| `components/templates/free-dashboard/layouts/{sidebar,topbar,nav-item,index,page-title}` | `apps/admin/src/workspace/` | 去掉 `next/link`、`usePathname`、`next-themes`、Pro 外链、搜索广告、示例账号与 Unsplash 头像；换成洲洲商行 Logo、权限导航与中文文案 |
| `components/templates/free-dashboard/dashboards/sales.tsx` | `workspace/workspace.css` | 采用分区间距与并排内容组合，适配可排序卡片与紧凑业务摘要 |
| `components/blocks/dashboard/table/table-3.tsx` | `workspace/workbench.tsx` 的管理员目录 | 采用 TableHeader / TableBody、头像与双行名称、状态 Badge 结构；替换商品数据为真实权限内管理员，移除营销与导出动作 |
| `components/blocks/dashboard/widget/widget-5.tsx` | `workspace/workbench.tsx` 的账号安全 | 采用图标、名称、右侧状态的紧凑行与底部动作；移除配额、进度与假统计 |

## 未复制

- `app/dashboards/{hospital,logs,sales}` 及对应假数据图表
- 除上表采用范围外的 `components/blocks/`；通知、升级广告、Promo 均未采用
- `components/ui/chart.tsx`（本轮无真实经营数据，不引入 Recharts）
- Pro 预览外链、认证示例页、整站 `next.config.ts` / `app/layout.tsx`

工作区视觉 token 仅作用在 `.workspace-root`，不覆盖登录/引导页。

独立合成视觉材料使用 `stat/stat-2.tsx`，并参考 `chart/chart-3.tsx` 的图表分区；材料不进入产品代码或路由。图表在材料中使用原生 SVG，未引入 Recharts 或复制 Pro 内容。
