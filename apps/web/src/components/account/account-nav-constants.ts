import {
  ClipboardList,
  CreditCard,
  Crown,
  FileText,
  House,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
} from "lucide-react";
import type { OrderSearchFilters } from "@/lib/order-client";

export const accountSectionLabels = {
  membership: "会员中心",
  rentals: "租入订单",
  leased: "出租订单",
  rented: "我的账号",
  accounts: "我的账号",
  credit: "信用与保证金",
  identity: "实名认证",
  favorites: "我的收藏",
  security: "账号安全",
  wallet: "我的钱包",
  invite: "邀请与佣金",
} as const;

export type AccountSection = keyof typeof accountSectionLabels;
export type AccountView = "overview" | AccountSection;

export type NavItem = {
  section: AccountView;
  label: string;
  icon: typeof FileText;
  badge?: string;
};

export type NavGroup = { title?: string; items: NavItem[] };

// 分组按 Owner 裁定：顶部三项（总览/会员中心/我的收藏）不再加“常用”标题；“资产与收益”取代旧的“资产与信用”。
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { section: "overview", label: "总览", icon: House },
      { section: "membership", label: "会员中心", icon: Crown },
      { section: "favorites", label: "我的收藏", icon: Star },
    ],
  },
  {
    title: "租赁管理",
    items: [
      { section: "rentals", label: "租入订单", icon: FileText },
      { section: "leased", label: "出租订单", icon: House },
      { section: "accounts", label: "我的账号", icon: ClipboardList },
    ],
  },
  {
    title: "资产与收益",
    items: [
      { section: "wallet", label: "我的钱包", icon: CreditCard },
      { section: "credit", label: "信用与保证金", icon: ShieldCheck },
      { section: "invite", label: "邀请与佣金", icon: Sparkles },
    ],
  },
  {
    title: "账号设置",
    items: [
      { section: "identity", label: "实名认证", icon: ShieldCheck },
      { section: "security", label: "账号安全", icon: Shield },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** 面包屑第三段用的当前页面名称：以导航项标签为准，未知回落“总览”。 */
export function accountViewTitle(view: AccountView): string {
  if (view === "rented") return accountSectionLabels.accounts;
  return NAV_ITEMS.find((item) => item.section === view)?.label ?? "总览";
}

export type AccountLocation = { view: AccountView; accountId?: string; orderId?: string; status?: string; source?: string; orderFilters?: OrderSearchFilters };

/** web.account.unsupported: a view outside the known sections is reported, never silently mapped to another business page. */
export function isKnownAccountView(view: string): boolean {
  return view === "" || view === "overview" || Object.hasOwn(accountSectionLabels, view);
}

export function resolveAccountView(view: string): AccountView {
  if (Object.hasOwn(accountSectionLabels, view)) return view as AccountSection;
  return "overview";
}

export function accountSectionHref(section: AccountView, current: AccountLocation): string {
  const query = new URLSearchParams();
  query.set("view", section);
  const sameOrder = (section === "rentals" || section === "leased") && current.view === section;
  const sameAccountSection = (section === "accounts" || section === "rented") && (current.view === "accounts" || current.view === "rented");
  if ((sameAccountSection || sameOrder) && current.accountId) query.set("accountId", current.accountId);
  if ((sameOrder || sameAccountSection) && current.status) query.set("status", current.status);
  else if (sameAccountSection && current.view !== section) query.set("status", current.view === "rented" ? "RENTED" : "ALL");
  if (sameOrder && current.orderId) { query.set("orderId", current.orderId); if (current.source === 'legacy') query.set('source', 'legacy'); }
  if (sameOrder) for (const key of ['orderNo','createdFrom','createdTo','stage'] as const) if (current.orderFilters?.[key]) query.set(key, current.orderFilters[key]!);
  return `/account?${query.toString()}`;
}

export function isAuthenticationFailure(error: { status: number; code?: string }): boolean {
  return error.status === 401 || error.code === "UNAUTHENTICATED";
}
