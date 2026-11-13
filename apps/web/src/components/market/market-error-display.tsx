import type { PublicListingFilterMetadata, SupplyFieldError } from "@/lib/supply-types";
import type { SupplyRequestError } from "@/lib/supply-client";

export type Directory<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null; error?: SupplyRequestError | null };

export type ResultErrorInfo = { title: string; description: string; kind: "retry" | "adjust" };

export function errorForPath(details: SupplyFieldError[], metadata: PublicListingFilterMetadata | null): string[] {
  return details.map((detail) => {
    const label = metadata?.fields.find((entry) => detail.path.toLowerCase().includes(entry.key.toLowerCase()))?.label;
    return `${label ?? "筛选条件"}：请检查或移除该条件后重试。`;
  }).filter((message, index, all) => all.indexOf(message) === index);
}

export function resultError(
  error: { status: number; code: string; details: SupplyFieldError[]; message?: string } | null,
  metadata: PublicListingFilterMetadata | null,
  exactLookup: boolean
): ResultErrorInfo | null {
  if (!error) return null;
  if (exactLookup) {
    if ([401, 403, 404].includes(error.status)) return { title: "未找到可公开查看的账号", description: "请核对完整编号；也可以清空编号后改用关键词搜索。", kind: "adjust" };
    if (error.status === 400) return { title: "编号格式未被接受", description: "请输入完整账号编号后重试。", kind: "adjust" };
    if (error.status === 409) return { title: "该编号暂无法唯一核定", description: "请确认游戏范围与完整编号后重试。", kind: "retry" };
    if (error.status >= 500) return { title: "编号查询暂不可用", description: "服务暂时无法处理查询，请稍后重试；这不代表账号不存在。", kind: "retry" };
    return { title: "编号查找未完成", description: "请检查连接后重试；这不代表账号不存在。", kind: "retry" };
  }
  if (error.code === "LISTING_URL_TOO_LONG") return { title: "筛选条件过多，未发起请求", description: error.message ?? "请减少部分筛选条件后重试。", kind: "adjust" };
  if (error.status === 400) return { title: "有筛选条件未被接受", description: errorForPath(error.details, metadata).join(" ") || "请检查筛选条件后重试。", kind: "adjust" };
  if (error.status === 409) return { title: "筛选规则刚刚更新", description: "已尝试刷新可用条件；如仍无法读取，请重试。", kind: "retry" };
  if (error.status === 503) return { title: "账号目录暂不可用", description: "服务恢复后可继续浏览，当前筛选条件会保留。", kind: "retry" };
  return { title: "账号列表加载失败", description: "请检查网络连接后重试。", kind: "retry" };
}
