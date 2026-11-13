/**
 * 上架实现已按「草稿 / 报价 / 审核 / 公开读」拆成多个模块，共享底座在 publishing-internals。
 * 既有的源码级断言检查的是 SQL 文本、写入前置守卫与调用顺序；这里按固定顺序把实现文件
 * 合并成与拆分前单文件等价的源码视图，使断言无需改写即可继续约束同一批实现代码。
 * 断言正则、片段与计数本身保持不变，不应因拆分而放宽。
 * 注意：基于 indexOf 的片段切片依赖函数在合并视图里的相对位置。当前顺序保证
 * publicationBlockers→assertEditable 相邻、submitListing→withdrawListing 相邻、
 * withdrawListing 仍在 reviewListing 之前（因此 review 切片仍取到文件末尾）。
 * 后续若在模块之间移动函数，须逐一核对这些切片仍切到原函数体，因为它们不会可靠地失败。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PUBLISHING_SOURCES = [
  "src/supply/publishing.ts",
  "src/supply/publishing-internals.ts",
  "src/supply/publishing-drafts.ts",
  "src/supply/publishing-quote.ts",
  "src/supply/publishing-review.ts",
  "src/supply/publishing-public.ts",
] as const;

/** publishing.ts 门面及其拆出模块的合并源码。 */
export function readPublishingSource(): string {
  return PUBLISHING_SOURCES.map((file) => readFileSync(resolve(file), "utf8")).join("\n");
}