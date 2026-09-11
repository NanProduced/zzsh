import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { WORKBENCH_TAB_ID, tabFromKeyboard, type WorkspaceTab } from "./tab-model";

export function WorkspaceTabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
}: {
  tabs: WorkspaceTab[];
  activeId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const keyboardFocusPending = useRef(false);
  useEffect(() => {
    if (!keyboardFocusPending.current) return;
    keyboardFocusPending.current = false;
    scroller.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [activeId, tabs]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = tabFromKeyboard(tabs, activeId, event.key);
    if (!action) return;
    event.preventDefault();
    keyboardFocusPending.current = true;
    if (action.type === "activate") onActivate(action.id);
    else onClose(action.id);
  };

  return (
    <div className="workspace-tabs">
      <div
        ref={scroller}
        className="workspace-tabs-list"
        role="tablist"
        aria-label="已打开页面"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-active={active ? "true" : "false"}
              className={cn("workspace-tab group", active && "workspace-tab-active")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="workspace-tab-label"
                onClick={() => onActivate(tab.id)}
                title={tab.title}
              >
                {tab.title}
              </button>
              {tab.closable ? (
                <button
                  type="button"
                  className="workspace-tab-close"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={() => onClose(tab.id)}
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" className="workspace-tabs-overflow" aria-label="标签页操作">
              <ChevronDownIcon className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-48">
          {tabs.map((tab) => (
            <DropdownMenuItem key={tab.id} onClick={() => onActivate(tab.id)}>
              {tab.title}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={activeId === WORKBENCH_TAB_ID} onClick={() => onClose(activeId)}>
            关闭当前
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onCloseOthers(activeId)}>关闭其他</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onCloseRight(activeId)}>关闭右侧</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
