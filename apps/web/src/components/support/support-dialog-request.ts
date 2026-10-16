"use client";
import type { SupportType } from "@/lib/support-intent";

/**
 * 页面内的客服/投诉入口共用这一个触发方式：发窗口事件，由全局 SupportRail 接住——
 * 先过登录门，再开窗，关闭后焦点回到触发钮。不新增 /support 路由：客服只有一个容器，
 * 就是右侧常驻工具列的弹窗（DESIGN.md：常驻工具含联系客服、投诉建议）。
 *
 * 事件名与 support-rail.tsx 里的监听字符串一致；那边不引入本模块，是为了让 rail 的依赖面
 * 保持原样（既有测试按模块逐个打桩）。改这里务必同步改那边。
 */
export const SUPPORT_OPEN_EVENT = "zzsh:open-support";

export function requestSupportDialog(type: SupportType): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SUPPORT_OPEN_EVENT, { detail: { type } }));
}
