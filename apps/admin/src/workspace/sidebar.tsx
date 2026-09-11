import { ChevronsUpDownIcon, LogOutIcon, ShieldIcon } from "lucide-react";

import { BrandLogo } from "../components/brand-logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { SessionSnapshot } from "../api";

import { workspaceMenuItems } from "./nav-config";
import { WorkspaceNavItem } from "./nav-item";
import type { NavPermission } from "./tab-model";

export function WorkspaceSidebar({
  snapshot,
  pathname,
  onNavigate,
  onSignOut,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  pathname: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
}) {
  const { state, isMobile } = useSidebar();
  const showMark = !isMobile && state === "collapsed";
  const nav: NavPermission = { isBoss: snapshot.security.isBoss, permissions: snapshot.permissions };
  const name = snapshot.user.name || snapshot.user.displayUsername || snapshot.user.username || "管理员";
  const account = snapshot.user.displayUsername || snapshot.user.username || "";
  const initial = name.slice(0, 1).toUpperCase();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex-row items-center p-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2">
        <button
          type="button"
          className="flex min-w-0 w-full items-center group-data-[collapsible=icon]:w-auto group-data-[collapsible=icon]:justify-center"
          onClick={() => onNavigate("/workbench")}
          aria-label="返回工作台"
        >
          <BrandLogo
            variant={showMark ? "mark" : "horizontal"}
            height={showMark ? 28 : 36}
            className={showMark ? "brand-logo-mark" : "brand-logo-horizontal"}
          />
        </button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu className="mt-2 mb-2 gap-0.5 px-2">
          {workspaceMenuItems(nav).map((item) => (
            <WorkspaceNavItem key={`${item.label}-${item.path ?? "title"}`} item={item} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="border-t p-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground">
                    <Avatar className="size-8">
                      <AvatarFallback>{initial}</AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{name}</span>
                      <span className="text-muted-foreground truncate text-xs">{account || (snapshot.security.isBoss ? "同级 Boss" : "管理员")}</span>
                    </div>
                    <ChevronsUpDownIcon className="ms-auto size-4" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent className="min-w-56 rounded-lg" side="top" align="start" sideOffset={4}>
                <div className="flex items-center gap-2.5 p-2 text-left text-sm">
                  <Avatar className="size-8">
                    <AvatarFallback>{initial}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{name}</span>
                    <span className="text-muted-foreground truncate text-xs">{snapshot.security.isBoss ? "同级 Boss" : "管理员"}</span>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onNavigate("/account")}>
                  <ShieldIcon />
                  <span>账号安全</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onSignOut}>
                  <LogOutIcon />
                  <span>退出登录</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
