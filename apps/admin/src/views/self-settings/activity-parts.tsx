import { useMemo, useState } from "react";

import {
  CheckIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  KeyRoundIcon,
  MonitorSmartphoneIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UserCogIcon,
  CircleHelpIcon,
} from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import {
  activityActionLabel,
  activityActorPhrase,
  activityDetailPhrases,
  activityFilterLabel,
  activityOutcomeLabel,
  type ActivityEvent,
} from "./model";
import { cn } from "@/lib/utils";

export type ActivityCategory = "login" | "twoFactor" | "session" | "account" | "protection" | "other";

export const ACTIVITY_CATEGORY_LABEL: Record<ActivityCategory, string> = {
  login: "登录与密码",
  twoFactor: "二次验证",
  session: "会话与PIN",
  account: "账号状态与权限",
  protection: "登录防护",
  other: "其他",
};

const CATEGORY_ORDER: ActivityCategory[] = ["login", "twoFactor", "session", "account", "protection", "other"];

const CATEGORY_ICON: Record<ActivityCategory, typeof KeyRoundIcon> = {
  login: KeyRoundIcon,
  twoFactor: ShieldCheckIcon,
  session: MonitorSmartphoneIcon,
  account: UserCogIcon,
  protection: ShieldAlertIcon,
  other: CircleHelpIcon,
};

/** 纯函数：按动作名归类；未知动作归入“其他”，不猜测含义。 */
export function activityCategory(action: string): ActivityCategory {
  const a = action.toLowerCase();
  if (a.includes("auth.failure") || a.includes("lockout") || a.includes("pin.locked")) return "protection";
  if (a.includes("two_factor") || a.includes("backup_codes") || a.includes("totp")) return "twoFactor";
  if (a.includes("session") || a.includes(".pin.")) return "session";
  if (a.includes("password") || a.includes("recovery") || a.includes("login") || a.includes("enrollment")) return "login";
  if (a.includes("frozen") || a.includes("permission") || a.includes("game_scope") || a.includes("account") || a.includes("bootstrap")) return "account";
  return "other";
}

export function groupActionsByCategory(actions: string[]): Array<{ category: ActivityCategory; actions: string[] }> {
  const map = new Map<ActivityCategory, string[]>();
  for (const action of actions) {
    const c = activityCategory(action);
    map.set(c, [...(map.get(c) ?? []), action]);
  }
  return CATEGORY_ORDER.filter((c) => map.has(c)).map((category) => ({ category, actions: map.get(category)! }));
}

const dayFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** 纯函数：按北京时间自然日分组，保持原有顺序。 */
export function groupEventsByBeijingDay(events: ActivityEvent[]): Array<{ day: string; events: ActivityEvent[] }> {
  const groups: Array<{ day: string; events: ActivityEvent[] }> = [];
  for (const event of events) {
    const date = event.occurredAt ? new Date(event.occurredAt) : null;
    const day = date && !Number.isNaN(date.getTime()) ? dayFormatter.format(date) : "时间未知";
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}

function beijingTime(value: string | null): string {
  if (!value) return "--:--:--";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "--:--:--" : timeFormatter.format(d);
}

export function ActionFilterCombobox({
  actions,
  value,
  onChange,
  disabled,
}: {
  actions: string[];
  value: string;
  onChange: (action: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupActionsByCategory(actions), [actions]);
  const select = (next: string) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label="事件类型筛选" className="h-9 w-full justify-between sm:w-72">
            <span className="truncate">{value ? activityFilterLabel(value) : "全部事件类型"}</span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索事件类型…" />
          <CommandList className="max-h-72 overflow-y-auto">
            <CommandEmpty>没有匹配的事件类型</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all 全部" onSelect={() => select("")}>
                <CheckIcon className={cn("size-4", value ? "opacity-0" : "opacity-100")} />
                全部事件类型
              </CommandItem>
            </CommandGroup>
            {groups.map((group) => (
              <CommandGroup key={group.category} heading={ACTIVITY_CATEGORY_LABEL[group.category]}>
                {group.actions.map((action) => (
                  <CommandItem key={action} value={`${action} ${activityFilterLabel(action)}`} onSelect={() => select(action)}>
                    <CheckIcon className={cn("size-4", value === action ? "opacity-100" : "opacity-0")} />
                    {activityFilterLabel(action)}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CopyRequestId({ requestId }: { requestId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="复制请求编号"
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={() => {
              void navigator.clipboard?.writeText(requestId).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </button>
        }
      />
      <TooltipContent>
        <span className="font-mono text-[11px]">{copied ? "已复制" : `请求编号 ${requestId}`}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function ActivityTimeline({ events, dimmed }: { events: ActivityEvent[]; dimmed?: boolean }) {
  const days = groupEventsByBeijingDay(events);
  return (
    <TooltipProvider>
      <div className={cn("space-y-5", dimmed && "opacity-60")}>
        {days.map((group) => (
          <section key={group.day} aria-label={group.day}>
            <h3 className="text-muted-foreground mb-2 text-xs font-medium">{group.day}</h3>
            <ol className="divide-border bg-surface-raised/40 divide-y rounded-xl border border-border">
              {group.events.map((event) => {
                const label = activityActionLabel(event.action);
                const outcome = activityOutcomeLabel(event.outcome);
                const details = activityDetailPhrases(event.details);
                const category = activityCategory(event.action);
                const Icon = CATEGORY_ICON[category];
                const failed = event.outcome === "FAILURE";
                return (
                  <li key={event.eventId} className="flex items-start gap-3 px-4 py-3">
                    <span
                      className={cn(
                        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted",
                        failed ? "text-destructive" : "text-muted-foreground",
                      )}
                      title={ACTIVITY_CATEGORY_LABEL[category]}
                    >
                      <Icon className="size-3.5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground" title={event.action}>{label ?? "未识别的事件"}</span>
                        <Badge variant="outline" className="text-[11px] font-normal">
                          {activityActorPhrase(event.actorKind, event.actorRef, event.action)}
                        </Badge>
                      </div>
                      {event.reason || details.length > 0 ? (
                        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs [overflow-wrap:anywhere]">
                          {[event.reason ? `原因：${event.reason}` : null, ...details].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs">
                      <span className={cn("inline-flex items-center gap-1", failed ? "text-destructive" : "text-muted-foreground")}>
                        <span className={cn("size-1.5 rounded-full", failed ? "bg-destructive" : "bg-emerald-500")} aria-hidden />
                        {outcome ?? `未识别：${event.outcome}`}
                      </span>
                      <time className="text-muted-foreground font-mono tabular-nums" dateTime={event.occurredAt ?? undefined} title="北京时间">
                        {beijingTime(event.occurredAt)}
                      </time>
                      {event.requestId ? <CopyRequestId requestId={event.requestId} /> : <span className="w-[22px]" />}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </TooltipProvider>
  );
}
