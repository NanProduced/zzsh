import {
  WalletIcon,
  BadgeDollarSignIcon,
  BoxesIcon,
  CalculatorIcon,
  CrosshairIcon,
  ClipboardCheckIcon,
  CrownIcon,
  FileSignatureIcon,
  ImageIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  MessagesSquareIcon,
  NetworkIcon,
  NewspaperIcon,
  PackageIcon,
  PaletteIcon,
  ScaleIcon,
  ShoppingBagIcon,
  ScrollTextIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  UserCheckIcon,
  UserRoundCogIcon,
  UsersRoundIcon,
  VaultIcon,
  type LucideIcon,
} from "lucide-react";

import type { NavPermission, WorkspaceRouteKind } from "./tab-model";

export type WorkspaceMenuItem = {
  label: string;
  isTitle?: boolean;
  icon?: LucideIcon;
  path?: string;
  kind?: WorkspaceRouteKind;
  items?: WorkspaceMenuItem[];
};

export function workspaceMenuItems(nav: NavPermission): WorkspaceMenuItem[] {
  const has = (code: string) => nav.permissions.includes(code);
  const items: WorkspaceMenuItem[] = [
    { label: "工作区", isTitle: true },
    { label: "工作台", icon: LayoutDashboardIcon, path: "/workbench", kind: "workbench" },
  ];

  if (has("im.support.read") || nav.isBoss) {
    items.push({ label: "客户服务", isTitle: true }, { label: "客服工作台", icon: MessagesSquareIcon, path: "/support", kind: "support" });
  }

  const membershipOps = nav.isBoss || ["membership.policy.draft", "membership.policy.publish", "membership.growth.read.summary"].some(has)
    || has("approval.request.create") && has("membership.entitlement.request");
  const distributionOps = nav.isBoss || ["order.read", "personal.distribution.policy.read", "personal.distribution.policy.manage"].some(has);
  if (membershipOps || distributionOps) items.push({ label: "会员运营", isTitle: true });
  if (membershipOps) items.push({ label: "会员与礼遇", icon: CrownIcon, path: "/membership-growth", kind: "membership-growth" });
  if (distributionOps) items.push({ label: "分销管理", icon: NetworkIcon, path: "/distribution-policy", kind: "distribution-policy" });

  const system: WorkspaceMenuItem[] = [];
  if (has("admin.account.read") || nav.isBoss) {
    system.push({ label: "管理员管理", icon: UserRoundCogIcon, path: "/admins", kind: "admins" });
  }
  if (has("admin.role.read") || has("admin.permission.read")) {
    system.push({ label: "角色权限", icon: KeyRoundIcon, path: "/roles", kind: "roles" });
  }
  if (system.length > 0) {
    items.push({ label: "系统与安全", isTitle: true }, ...system);
  }

  const supply: WorkspaceMenuItem[] = [];
  if (has("supply.catalog.manage") || nav.isBoss) {
    supply.push({ label: "目录维护", icon: BoxesIcon, path: "/supply/catalog", kind: "catalog" });
  }
  if (has("supply.review.read") || nav.isBoss) {
    supply.push({ label: "账号供给", icon: UserCheckIcon, path: "/supply/reviews", kind: "listing-review" });
    supply.push({ label: "平台素材审核", icon: ImageIcon, path: "/supply/media", kind: "media-review" });
  }
  if (supply.length > 0) {
    items.push({ label: "供给与目录", isTitle: true }, ...supply);
  }
  const delta: WorkspaceMenuItem[] = [];
  if (has("supply.rules.edit") || nav.isBoss) {
    const r = (label: string, icon: LucideIcon, section: string) => ({ label, icon, path: `/supply/rules?section=${section}`, kind: "rules" as const });
    items.push(
      { label: "供给与规则", isTitle: true },
      r("规则总览", SlidersHorizontalIcon, "overview"),
      r("押金规则", VaultIcon, "deposit"),
      r("结算与退赔", ScaleIcon, "settlement"),
      r("出租协议", FileSignatureIcon, "agreement"),
    );
    delta.push(
      r("租赁定价", BadgeDollarSignIcon, "pricing"),
      r("物资价目", PackageIcon, "items"),
      r("皮肤推荐押金", PaletteIcon, "skin"),
    );
  }
  // 改枪码目录归到游戏分组；路由仍是 /supply/gunsmith。
  if (has("supply.gunsmith.manage") || nav.isBoss) {
    delta.push({ label: "改枪码目录", icon: CrosshairIcon, path: "/supply/gunsmith", kind: "gunsmith" });
  }
  if (delta.length > 0) {
    items.push({ label: "三角洲行动", isTitle: true }, ...delta);
  }

  const content: WorkspaceMenuItem[] = [];
  if (has("content.platform.read") || has("content.read") || nav.isBoss) {
    content.push({ label: "内容管理", icon: NewspaperIcon, path: "/content", kind: "content" });
  }
  if (content.length > 0) {
    items.push({ label: "运营内容", isTitle: true }, ...content);
  }

  if (has("finance.read") || has("finance.document.read")) {
    items.push({ label: "资金", isTitle: true }, { label: "资金查找", icon: WalletIcon, path: "/finance", kind: "finance-lookup" });
    if (has("finance.read")) items.push({ label: "期间核对", icon: CalculatorIcon, path: "/finance/period", kind: "finance-period" });
  }
  if (has("order.read") || nav.isBoss) {
    items.push({ label: "交易", isTitle: true }, { label: "订单", icon: ShoppingBagIcon, path: "/orders", kind: "orders" });
  }

  const users: WorkspaceMenuItem[] = [];
  if (has("user.directory.read")) users.push({ label: "用户管理", icon: UsersRoundIcon, path: "/users", kind: "users" });
  if (users.length > 0) {
    items.push({ label: "用户与会员", isTitle: true }, ...users);
  }

  const audit: WorkspaceMenuItem[] = [];
  if (["approval.request.read", "approval.request.approve", "approval.template.read", "approval.audit.read"].some(has)) {
    audit.push({ label: "审批中心", icon: ClipboardCheckIcon, path: "/approvals", kind: "approvals" });
  }
  if (has("admin.audit.read")) {
    audit.push({ label: "账号与权限审计", icon: ScrollTextIcon, path: "/audit", kind: "audit" });
  }
  if (audit.length > 0) {
    items.push({ label: "审批与审计", isTitle: true }, ...audit);
  }

  items.push({ label: "个人", isTitle: true }, { label: "账号安全", icon: ShieldIcon, path: "/settings?section=security", kind: "settings" });
  return items;
}

export function titleForPath(pathname: string): string {
  if (pathname.startsWith("/admins/")) return "管理员详情";
  if (pathname === "/admins") return "管理员管理";
  if (pathname.startsWith("/roles/")) return "角色详情";
  if (pathname === "/roles") return "角色权限";
  if (pathname.startsWith("/approvals/")) return "审批详情";
  if (pathname === "/approvals") return "审批中心";
  if (pathname === "/audit") return "账号与权限审计";
  if (pathname === "/users") return "用户管理";
  if (pathname.startsWith("/users/")) return "用户详情";
  if (pathname === "/supply/catalog") return "目录维护";
  if (pathname === "/supply/gunsmith") return "改枪码目录";
  if (pathname === "/supply/rules") return "规则与价目";
  if (pathname === "/supply/reviews") return "账号供给";
  if (pathname === "/supply/media") return "平台素材审核";
  if (pathname === "/content") return "内容管理";
  if(pathname==="/finance")return "资金查找";
  if(pathname==="/finance/period")return "期间核对";
  if(pathname.startsWith("/finance/documents/"))return "资金单据";
  if(pathname.startsWith("/finance/users/"))return "用户资金";
  if (pathname.startsWith("/orders/")) return "订单详情";
  if (pathname === "/orders") return "订单";
  if (pathname === "/settings") return "设置";
  if (pathname === "/account") return "账号安全";
  if (pathname === "/support") return "客服工作台";
  if (pathname === "/membership-growth") return "会员与礼遇";
  if (pathname === "/distribution-policy") return "分销管理";
  return "工作台";
}

export type SearchableWorkspacePage = {
  label: string;
  path: string;
  group: string;
  keywords?: string[];
};

export function normalizeSearchString(str: string): string {
  return str
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .trim()
    .toLowerCase();
}

export const PAGE_SEARCH_KEYWORDS: Record<string, string[]> = {
  "/workbench": ["工作台", "首页", "workbench", "gzt"],
  "/support": ["客服工作台", "客服", "履约", "消息", "im", "support", "kf", "ly"],
  "/distribution-policy": ["分销管理", "分销", "邀请", "政策", "distribution", "fx"],
  "/membership-growth": ["会员与礼遇", "会员成长", "礼遇", "会员", "增长", "策略", "membership", "hy", "cz"],
  "/admins": ["管理员管理", "管理员", "账号", "staff", "admins", "gly", "zh"],
  "/roles": ["角色权限", "角色", "权限", "授权", "roles", "js", "qx"],
  "/supply/catalog": ["目录维护", "商品", "目录", "货架", "皮肤", "catalog", "ml"],
  "/supply/gunsmith": ["改枪码目录", "枪械", "改枪", "配装", "gunsmith", "qx", "pz"],
  "/supply/rules?section=overview": ["规则与价目", "规则总览", "规则", "版本", "生效", "rules", "gz", "bb"],
  "/supply/rules?section=deposit": ["押金规则", "押金", "上限", "deposit", "yj"],
  "/supply/rules?section=settlement": ["结算与退赔", "结算", "退赔", "赔付", "settlement", "js", "tp"],
  "/supply/rules?section=agreement": ["出租协议", "协议", "条款", "全额赔付", "agreement", "xy"],
  "/supply/rules?section=pricing": ["租赁定价", "定价", "价格", "收费", "租赁模式", "租期", "每日消耗", "三角洲", "pricing", "delta", "dj"],
  "/supply/rules?section=items": ["物资价目", "价目", "物资", "价格行", "items", "jm", "wz"],
  "/supply/rules?section=skin": ["皮肤推荐押金", "皮肤", "推荐押金", "skin", "pf"],
  "/supply/reviews": ["账号供给", "供给", "审核", "上架审核", "reviews", "sh", "gj"],
  "/supply/media": ["平台素材审核", "图片审核", "素材", "截图", "图片", "media", "review", "sc", "tp"],
  "/content": ["内容管理", "运营内容", "content", "nr"],
  "/finance": ["资金查找", "资金", "流水", "finance", "zj"],
  "/finance/period": ["期间核对", "对账", "核对", "period", "dz"],
  "/orders": ["订单", "交易", "orders", "dd"],
  "/users": ["用户管理", "用户", "users", "yh"],
  "/approvals": ["审批与审计", "审批", "待办", "工单", "approvals", "sp"],
  "/audit": ["账号与权限审计", "审计", "操作日志", "安全日志", "audit", "sj", "rz"],
  "/settings?section=security": ["账号安全", "个人中心", "安全", "密码", "pin", "account", "gr", "aq"],
  "/settings": ["设置", "外观", "主题", "偏好", "深色", "浅色", "appearance", "theme", "settings", "sz", "wg", "zt"],
};

export function searchableWorkspacePages(nav: NavPermission): SearchableWorkspacePage[] {
  const pages: SearchableWorkspacePage[] = [];
  let group = "";
  for (const item of workspaceMenuItems(nav)) {
    if (item.isTitle) {
      group = item.label;
      continue;
    }
    if (item.path) {
      pages.push({
        label: item.label,
        path: item.path,
        group,
        keywords: PAGE_SEARCH_KEYWORDS[item.path] ?? [],
      });
    }
  }
  pages.push({
    label: "设置",
    path: "/settings",
    group: "个人",
    keywords: PAGE_SEARCH_KEYWORDS["/settings"],
  });
  return pages;
}

export function scorePageMatch(page: SearchableWorkspacePage, query: string): number | null {
  const normQ = normalizeSearchString(query);
  if (!normQ) return 0;
  const tokens = normQ.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  const labelNorm = normalizeSearchString(page.label);
  const groupNorm = normalizeSearchString(page.group);
  const pathNorm = normalizeSearchString(page.path);
  const keywordsNorm = (page.keywords ?? []).map(normalizeSearchString);

  // Multi-token AND logic: every token must match label, group, path or keywords
  const allTokensMatch = tokens.every((token) => {
    return (
      labelNorm.includes(token) ||
      groupNorm.includes(token) ||
      pathNorm.includes(token) ||
      keywordsNorm.some((k) => k.includes(token))
    );
  });

  if (!allTokensMatch) return null;

  // Transparent sorting:
  // 1. Exact match on label or alias
  if (labelNorm === normQ || keywordsNorm.some((k) => k === normQ)) return 1;
  // 2. Prefix match on label
  if (labelNorm.startsWith(normQ)) return 2;
  // 3. Contains in label
  if (labelNorm.includes(normQ)) return 3;
  // 4. Keyword / Alias match
  if (keywordsNorm.some((k) => k.startsWith(normQ) || k.includes(normQ))) return 4;
  // 5. Group match
  if (groupNorm.includes(normQ)) return 5;
  // 6. Multi-token combination match
  return 6;
}

export function filterSearchablePages(pages: SearchableWorkspacePage[], query: string): SearchableWorkspacePage[] {
  const normQ = normalizeSearchString(query);
  if (!normQ) return pages;

  const scored: { page: SearchableWorkspacePage; score: number; index: number }[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const score = scorePageMatch(page, normQ);
    if (score !== null) {
      scored.push({ page, score, index: i });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.index - b.index;
  });

  return scored.map((item) => item.page);
}
