import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { BadgeCheckIcon, CheckIcon, ChevronDownIcon, ClipboardCheckIcon, FileTextIcon, Gamepad2Icon, MoreHorizontalIcon, ShoppingBagIcon, UserRoundCogIcon, UserRoundIcon, WalletIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tabFromKeyboard, tabPresentation, tabsRemovedBy, type TabCloseAction, type WorkspaceRouteKind, type WorkspaceTab } from "./tab-model";

const detailIcons: Partial<Record<WorkspaceRouteKind, typeof FileTextIcon>> = {
  "admin-object": UserRoundCogIcon, "role-object": BadgeCheckIcon, "approval-object": ClipboardCheckIcon,
  "user-object": UserRoundIcon, "listing-object": Gamepad2Icon, "resource-object": Gamepad2Icon,
  "order-object": ShoppingBagIcon, "finance-document": FileTextIcon, "finance-user": WalletIcon,
};
const closeActions: { action: TabCloseAction; label: string }[] = [
  { action: "self", label: "关闭标签页" }, { action: "others", label: "关闭其他标签页" },
  { action: "left", label: "关闭左侧标签页" }, { action: "right", label: "关闭右侧标签页" },
];

type TabBarProps = {
  tabs: WorkspaceTab[];
  activeId: string;
  onActivate: (tabId: string) => void;
  onClose: (action: TabCloseAction, tabId: string) => void;
};

function WorkspaceTabItem({ tab, tabs, activeId, onActivate, onClose }: TabBarProps & { tab: WorkspaceTab }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const labelRef = useRef<HTMLButtonElement>(null);
  const active = tab.id === activeId;
  const { type, label, description } = tabPresentation(tab, tabs);
  // Keep the distinguishing end of a long identifier visible when the tab truncates.
  const characters = Array.from(label);
  const tail = type && characters.length > 16 ? characters.slice(-8).join("") : "";
  const Icon = detailIcons[tab.kind];
  const menuKey = (event: KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    setMenuOpen(true);
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} triggerId={menuId}>
      <div
        data-active={active ? "true" : "false"}
        data-detail={type ? "true" : undefined}
        className={cn("workspace-tab group", active && "workspace-tab-active")}
        onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
        onKeyDown={menuKey}
      >
        <Tooltip>
          <TooltipTrigger render={
            <button ref={labelRef} type="button" role="tab" data-tab-id={tab.id} aria-selected={active} aria-label={description}
              tabIndex={active ? 0 : -1} className="workspace-tab-label" onClick={() => onActivate(tab.id)}>
              {Icon ? <Icon className="workspace-tab-icon" aria-hidden="true" /> : null}
              <span className="workspace-tab-text">{tail ? characters.slice(0, -8).join("") : label}</span>
              {tail ? <span className="workspace-tab-tail">{tail}</span> : null}
            </button>
          } />
          <TooltipContent side="bottom">{description}</TooltipContent>
        </Tooltip>
        <DropdownMenuTrigger id={menuId} render={
          <button type="button" className="workspace-tab-more" tabIndex={active ? 0 : -1}
            aria-label={description + "的标签页操作"}>
            <MoreHorizontalIcon className="size-3.5" aria-hidden="true" />
          </button>
        } />
        {tab.closable ? (
          <button type="button" className="workspace-tab-close" tabIndex={active ? 0 : -1}
            aria-label={"关闭 " + description} onClick={() => onClose("self", tab.id)}>
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <DropdownMenuContent align="end" className="w-48" aria-label={description + "的标签页操作"}
        finalFocus={() => labelRef.current ?? document.querySelector<HTMLElement>('.workspace-tab-label[aria-selected="true"]')}>
        {closeActions.map(({ action, label: actionLabel }) => (
          <DropdownMenuItem key={action} disabled={tabsRemovedBy(tabs, action, tab.id).length === 0}
            onClick={() => onClose(action, tab.id)}>{actionLabel}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceTabBar({ tabs, activeId, onActivate, onClose }: TabBarProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const keyboardFocusPending = useRef(false);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const list = scroller.current;
    if (!list) return;
    const revealActive = () => {
      setOverflow(list.scrollWidth > list.clientWidth + 1);
      const button = list.querySelector<HTMLButtonElement>('.workspace-tab-label[aria-selected="true"]');
      const tab = button?.closest<HTMLElement>(".workspace-tab");
      if (!tab) return;
      const bounds = list.getBoundingClientRect();
      const target = tab.getBoundingClientRect();
      if (target.left < bounds.left) list.scrollLeft += target.left - bounds.left;
      else if (target.right > bounds.right) list.scrollLeft += target.right - bounds.right;
    };
    if (keyboardFocusPending.current) {
      keyboardFocusPending.current = false;
      list.querySelector<HTMLButtonElement>('.workspace-tab-label[aria-selected="true"]')?.focus({ preventScroll: true });
    }
    revealActive();
    const observer = new ResizeObserver(revealActive);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeId, tabs]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
    const action = tabFromKeyboard(tabs, event.target.getAttribute("data-tab-id") ?? activeId, event.key);
    if (!action) return;
    event.preventDefault();
    keyboardFocusPending.current = true;
    if (action.type === "activate") onActivate(action.id);
    else onClose("self", action.id);
  };
  const close: TabBarProps["onClose"] = (action, id) => {
    keyboardFocusPending.current = true;
    onClose(action, id);
  };

  return (
    <div className="workspace-tabs">
      <div ref={scroller} className="workspace-tabs-list" role="tablist" aria-label="已打开页面" onKeyDown={onKeyDown}>
        {tabs.map((tab) => <WorkspaceTabItem key={tab.id} tab={tab} tabs={tabs} activeId={activeId} onActivate={onActivate} onClose={close} />)}
      </div>
      {overflow ? <DropdownMenu>
        <DropdownMenuTrigger render={
          <Button variant="ghost" size="icon-sm" className="workspace-tabs-overflow" aria-label="已打开页面">
            <ChevronDownIcon className="size-4" />
          </Button>
        } />
        <DropdownMenuContent align="end" className="w-64" aria-label="已打开页面"
          finalFocus={() => scroller.current?.querySelector<HTMLElement>('.workspace-tab-label[aria-selected="true"]')}>
          {tabs.map((tab) => {
            const { label, description } = tabPresentation(tab, tabs);
            const Icon = detailIcons[tab.kind];
            return <DropdownMenuItem key={tab.id} aria-label={description} title={description} onClick={() => onActivate(tab.id)}>
              {Icon ? <Icon aria-hidden="true" /> : <span className="size-4 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {tab.id === activeId ? <CheckIcon aria-label="当前页面" /> : null}
            </DropdownMenuItem>;
          })}
        </DropdownMenuContent>
      </DropdownMenu> : null}
    </div>
  );
}
