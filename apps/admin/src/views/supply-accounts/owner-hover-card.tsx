import { Button } from "@/components/ui/button";
import { EntityPreviewTrigger, UserPreviewCard, hasUsefulUserPreview } from "@/components/admin-preview";
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
      className={
        "h-auto p-0 inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline outline-none" +
        (canOpen ? " cursor-pointer" : " cursor-default opacity-80 no-underline hover:no-underline")
      }
    >
      @{ownerName}
    </Button>
  );

  if (!hasUsefulUserPreview(summary, ownerName)) return trigger;
  return (
    <EntityPreviewTrigger
      trigger={trigger}
      touchLabel={`预览号主 @${ownerName} 信息`}
      content={
        <UserPreviewCard
          name={summary?.name ?? ownerName}
          userId={ownerId}
          image={summary?.image}
          maskedPhone={summary?.maskedPhone}
          canOpen={canOpen}
          onOpen={onOpenOwner}
          openLabel="查看号主资料"
          deniedReason="暂无法查看号主详情。"
        />
      }
    />
  );
}
