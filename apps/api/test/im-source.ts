/**
 * 咨询实现已按「解析 / 作用域恢复 / 在线 / 轮次」拆成多个模块。
 * 既有的源码级断言检查的是 SQL 文本、事务顺序与调用点；这里按固定顺序把实现文件
 * 合并成与拆分前单文件等价的源码视图，使断言无需改写即可继续约束同一批实现代码。
 * 断言正则、片段与计数本身保持不变，不应因拆分而放宽。
 * 注意：基于 indexOf 的片段切片依赖函数在同一文件内的相对位置；后续若在模块之间
 * 移动函数，须逐一核对这些切片仍切到原函数体，因为它们不会可靠地失败。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONSULTATION_SOURCES = [
  "src/im/consultation.ts",
  "src/im/consultation-internals.ts",
  "src/im/consultation-parsing.ts",
  "src/im/consultation-scope-recovery.ts",
  "src/im/consultation-presence.ts",
  "src/im/consultation-rounds.ts",
] as const;

function readSources(files: readonly string[]): string {
  return files.map((file) => readFileSync(resolve(file), "utf8")).join("\n");
}

/** consultation.ts 及其拆出模块的合并源码。 */
export function readConsultationSource(): string {
  return readSources(CONSULTATION_SOURCES);
}

/** yunxin-routes.ts 源码（本次拆分未改动该文件）。 */
export function readYunxinRoutesSource(): string {
  return readSources(["src/im/yunxin-routes.ts"]);
}

/**
 * support-management.ts 源码。该文件本次未拆分，仅把对 consultation.ts 的
 * type-only 回引改为指向共享基座 consultation-internals.ts，不涉及断言覆盖的代码。
 */
export function readSupportManagementSource(): string {
  return readSources(["src/im/support-management.ts"]);
}
