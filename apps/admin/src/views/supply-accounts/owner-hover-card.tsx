import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import { Phone, ExternalLink } from "lucide-react";
import type { SupplyOwnerSummary } from "../supply-review/model";

/**
 * 号主信息卡：资料只来自当前行的受权投影（ownerLink / ownerSummary）。
 * 没有下钻授权时保持不可点并说明原因，不隐式去读全目录或回显原始手机号。
 */
export function OwnerHoverCard({
  ownerName,
  ownerId,
  summary,
  canOpen,
  onOpenOwner,
}: {
  ownerName: string;
  ownerId?: string;
  summary?: SupplyOwnerSummary | null;
  canOpen?: boolean;
  onOpenOwner?: () => void;
}) {
  const initial = (summary?.name ?? ownerName).slice(0, 1) || "用";
  const trigger = (
    <Button
      type="button"
      variant="link"
      size="xs"
      onClick={(e) => {
        e.stopPropagation();
        if (canOpen) onOpenOwner?.();
      }}
      aria-disabled={!canOpen}
      className={"h-auto p-0 inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline outline-none" + (canOpen ? " cursor-pointer" : " cursor-default opacity-80 no-underline hover:no-underline")}
    >
      @{ownerName}
    </Button>
  );
  return (
    <HoverCard>
      <HoverCardTrigger render={trigger} />
      <HoverCardContent className="w-64 p-3 bg-popover border border-border shadow-xl rounded-lg">
        <div className="flex items-start gap-3">
          <Avatar size="default" className="size-9 border border-border">
            {summary?.image ? <AvatarImage src={summary.image} alt="" /> : null}
            <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
              {initial}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm text-foreground truncate">{summary?.name ?? ownerName}</span>
              <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted/60">号主</span>
            </div>
            {ownerId && (
              <p className="text-[11px] text-muted-foreground font-mono truncate">
                ID: {ownerId}
              </p>
            )}
            {summary?.maskedPhone ? (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
                <Phone className="size-3 text-muted-foreground" aria-hidden="true" />
                {summary.maskedPhone}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">脱敏联系方式未提供</p>
            )}
            {canOpen && onOpenOwner ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => onOpenOwner()}
                className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline font-medium pt-1.5 border-t border-border w-full text-left h-auto p-0"
              >
                <span>查看号主资料</span>
                <ExternalLink className="size-3" />
              </Button>
            ) : (
              <p className="mt-2 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
                当前身份没有号主目录读取授权或该行未开放下钻，未读取用户资料。
              </p>
            )}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
