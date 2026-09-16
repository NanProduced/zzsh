import {
  BoxesIcon,
  CrosshairIcon,
  ClipboardCheckIcon,
  ImageIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  NewspaperIcon,
  ScrollTextIcon,
  ShieldIcon,
  UserRoundCogIcon,
  UserRoundSearchIcon,
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

  const system: WorkspaceMenuItem[] = [];
  if (has("admin.account.read") || nav.isBoss) {
    system.push({ label: "管理员", icon: UserRoundCogIcon, path: "/admins", kind: "admins" });
  }
  if (has("admin.role.read") || has("admin.permission.read")) {
    system.push({ label: "角色权限", icon: KeyRoundIcon, path: "/roles", kind: "roles" });
  }
  if (system.length > 0) {
    items.push({ label: "系统管理", isTitle: true }, ...system);
  }

  const supply: WorkspaceMenuItem[] = [];
  if (has("supply.catalog.manage") || nav.isBoss) {
    supply.push({ label: "目录维护", icon: BoxesIcon, path: "/supply/catalog", kind: "catalog" });
  }
  if (has("supply.gunsmith.manage") || nav.isBoss) {
    supply.push({ label: "改枪码目录", icon: CrosshairIcon, path: "/supply/gunsmith", kind: "gunsmith" });
  }
  if (has("supply.rules.edit") || nav.isBoss) {
    supply.push({ label: "规则与价目", icon: ListChecksIcon, path: "/supply/rules", kind: "rules" });
  }
  if (has("supply.review.read") || nav.isBoss) {
    supply.push({ label: "供给审核", icon: ClipboardCheckIcon, path: "/supply/reviews", kind: "listing-review" });
    supply.push({ label: "平台素材审核", icon: ImageIcon, path: "/supply/media", kind: "media-review" });
  }
  if (supply.length > 0) {
    items.push({ label: "供给与目录", isTitle: true }, ...supply);
  }

  const content: WorkspaceMenuItem[] = [];
  if (has("content.platform.read") || has("content.read") || nav.isBoss) {
    content.push({ label: "内容管理", icon: NewspaperIcon, path: "/content", kind: "content" });
  }
  if (content.length > 0) {
    items.push({ label: "运营内容", isTitle: true }, ...content);
  }

  const users: WorkspaceMenuItem[] = [];
  if (has("user.account.restore")) {
    users.push({ label: "账号恢复", icon: UserRoundSearchIcon, path: "/users/restore", kind: "user-restore" });
  }
  if (users.length > 0) {
    items.push({ label: "用户管理", isTitle: true }, ...users);
  }

  const audit: WorkspaceMenuItem[] = [];
  if (["approval.request.read", "approval.request.approve", "approval.template.read", "approval.audit.read"].some(has)) {
    audit.push({ label: "审批", icon: ClipboardCheckIcon, path: "/approvals", kind: "approvals" });
  }
  if (has("admin.audit.read")) {
    audit.push({ label: "账号与权限审计", icon: ScrollTextIcon, path: "/audit", kind: "audit" });
  }
  if (audit.length > 0) {
    items.push({ label: "审批与审计", isTitle: true }, ...audit);
  }

  items.push({ label: "个人", isTitle: true }, { label: "账号安全", icon: ShieldIcon, path: "/account", kind: "account" });
  return items;
}

export function titleForPath(pathname: string): string {
  if (pathname.startsWith("/admins/")) return "管理员详情";
  if (pathname === "/admins") return "管理员";
  if (pathname.startsWith("/roles/")) return "角色详情";
  if (pathname === "/roles") return "角色权限";
  if (pathname.startsWith("/approvals/")) return "审批详情";
  if (pathname === "/approvals") return "审批与审计";
  if (pathname === "/audit") return "账号与权限审计";
  if (pathname === "/users/restore") return "用户账号恢复";
  if (pathname === "/supply/catalog") return "目录维护";
  if (pathname === "/supply/gunsmith") return "改枪码目录";
  if (pathname === "/supply/rules") return "规则与价目";
  if (pathname === "/supply/reviews") return "供给审核";
  if (pathname === "/supply/media") return "平台素材审核";
  if (pathname === "/content") return "内容管理";
  if (pathname === "/account") return "账号安全";
  if (pathname === "/support") return "客服工作台";
  return "工作台";
}

export type SearchableWorkspacePage = {
  label: string;
  path: string;
  group: string;
};

export function searchableWorkspacePages(nav: NavPermission): SearchableWorkspacePage[] {
  const pages: SearchableWorkspacePage[] = [];
  let group = "";
  for (const item of workspaceMenuItems(nav)) {
    if (item.isTitle) {
      group = item.label;
      continue;
    }
    if (item.path) pages.push({ label: item.label, path: item.path, group });
  }
  return pages;
}

export function filterSearchablePages(pages: SearchableWorkspacePage[], query: string): SearchableWorkspacePage[] {
  const q = query.trim().toLowerCase();
  if (!q) return pages;
  return pages.filter((page) =>
    page.label.toLowerCase().includes(q)
    || page.group.toLowerCase().includes(q)
    || page.path.toLowerCase().includes(q)
  );
}
