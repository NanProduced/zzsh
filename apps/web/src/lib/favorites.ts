import { SupplyRequestError } from "./supply-client.ts";

export function favoriteFailureText(error: unknown, saved: boolean): string {
  if (error instanceof SupplyRequestError && error.status === 401) return "登录状态已失效，请重新登录后再试。";
  if (error instanceof SupplyRequestError && error.status === 404) return saved ? "该账号当前不可收藏。" : "收藏已失效，无需重复取消。";
  return saved ? "收藏未保存，请重试。" : "取消收藏未完成，请重试。";
}
export function newFavoriteKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return "fav_" + crypto.randomUUID().replaceAll("-", "");
  return "fav_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
