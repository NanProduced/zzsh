# EvilCharts 选择性源码采用

固定来源：[legions-developer/evilcharts](https://github.com/legions-developer/evilcharts/tree/4c2dd7c9bae780703244265c9a4b509d40c055ad)，commit `4c2dd7c9bae780703244265c9a4b509d40c055ad`。MIT，Copyright (c) 2026 Gurbinder；原文见同目录LICENSE。不是仅视觉参考，也没有导入整个registry/Next站点。

| 上游文件 / git blob | 实际采用核心 | 本仓适配 |
|---|---|---|
| `src/registry/ui/recharts-chart.tsx` / `dbbabd84c4927ddd3379d5102e3bac5711fd8748` | ChartContext/useChart、payload配置间接解析、唯一chart作用域 | `recharts-core.tsx`；`components/ui/chart.tsx`单一容器。已有主题token代替多色CSS注入；真实ResizeObserver尺寸代替320px初值，零宽不绘图。 |
| `src/registry/charts/recharts-area-chart.tsx` / `6a9b9332fff8c070419f1a455df32fcbc73fc292` | Area系列、每series唯一ID、横向颜色渐变＋纵向渐隐mask/pattern（304–395、724–783） | `ChartArea`，保留null断点，关闭绘制入场动画；仅调整渐隐可读性。 |
| `src/registry/charts/recharts-bar-chart.tsx` / `170dfc8b9b326558a48725012e3a544940317502` | Bar系列与独立颜色gradient（314–408、825–851） | `ChartBar`，静态series、house圆角，不带CustomBar动效和无用variant。 |
| `src/registry/ui/recharts-tooltip.tsx` / `c8f92095f00ea6762ea7bc0072c07b7f2d9974fa` | payload过滤、config label映射、series指示与逐行内容 | `ChartTooltipContent`；formatter必须接原point，不从number坐标反算金额；去玻璃/多variant，增加键盘读数status。 |
| `src/registry/ui/recharts-legend.tsx` / `45be86f130ef6b6c090c6ad6bb7cc45bac72c688` | payload/config映射和选中series语义 | `ChartLegendContent`；原clickable div改已有Base UI Button，支持disabled原因与aria-pressed。 |

这些series作为Recharts 3自定义子组件实际进入AreaChart/BarChart渲染；这是使用当前3.x核心组合能力，不是给旧页面换颜色。业务金额、权限/UNKNOWN、日期、下钻和精确表格由dashboard层处理；vendor不造数据或猜业务状态。

未引入：brush、background、dot registry、堆叠/百分比、随机loading data、shimmer、glow、入场reveal、付费资源、第二引擎或第二套Button/主题。Motion已在本仓安装，但当前Operate图表无需引入不必要动效；保留静态优先与现有reduced-motion策略。

旧客服/分销图表的全量迁移由独立任务消费这一基座，本次不宣称它们已经全部迁入。明暗、初帧/隐藏恢复/resize及辅助技术的真实浏览器验收分别记录，源码采纳不替代验收。
