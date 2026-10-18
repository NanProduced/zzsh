import { useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarMenuButton, SidebarMenuItem, SidebarMenuSub } from "@/components/ui/sidebar";

import { activeNavPath, navItemPaths, type NavLocation } from "./nav-path";
import type { WorkspaceMenuItem } from "./nav-config";

export function WorkspaceNavItem({
  item,
  location,
  onNavigate,
}: {
  item: WorkspaceMenuItem;
  location: NavLocation;
  onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // 同一时刻只有一个入口点亮：带 query 的入口优先于同路径的普通入口（例如 /settings?section=security）。
  const activePath = activeNavPath(item.items?.length ? navItemPaths(item.items) : [item.path], location);
  const active = activePath !== null;

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  if (item.isTitle) {
    return (
      <SidebarMenuItem className="text-sidebar-foreground/60 mb-1 px-2 text-xs font-semibold tracking-wide uppercase not-first:mt-4 group-data-[collapsible=icon]:hidden">
        {item.label}
      </SidebarMenuItem>
    );
  }

  if (!item.items) {
    return (
      <SidebarMenuItem className="group/sub-item px-0">
        <SidebarMenuButton
          isActive={active}
          tooltip={item.label}
          className={cn("h-8 px-2.5 py-2", { "font-medium": active })}
          onClick={() => item.path && onNavigate(item.path)}
        >
          {item.icon ? <item.icon /> : null}
          <span className="grow">{item.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/collapsible"
      render={
        <SidebarMenuItem className="px-0.5">
          <CollapsibleTrigger
            render={
              <SidebarMenuButton tooltip={item.label} className={cn("group/sub-item", { "font-medium": active })}>
                {item.icon ? <item.icon /> : null}
                <span>{item.label}</span>
                <ChevronRightIcon className="ms-auto size-4 transition-transform duration-200 group-data-open/menu-item:rotate-90" />
              </SidebarMenuButton>
            }
          />
          <CollapsibleContent>
            <SidebarMenuSub className="group/menu-sub me-0 gap-0.5 ps-2 pe-0">
              {item.items.map((child) => (
                <WorkspaceNavItem key={child.label} item={child} location={location} onNavigate={onNavigate} />
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      }
    />
  );
}
