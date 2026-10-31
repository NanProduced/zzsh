import { useState } from "react";

import { Check, Copy, ExternalLink, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import type { MediaAssetReview, SupplyGame } from "../../api";
import { formatBytes, mediaContentUrl, type ZoomTarget } from "../supply-review/model";
import {
  actionsFor,
  bindingFact,
  objectName,
  OWNERSHIP_LABELS,
  PURPOSE_LABELS,
  revisionFact,
  STATE_LABELS,
  technicalFact,
  timeFull,
  timeShort,
  VISIBILITY_LABELS,
  type MediaAction,
} from "./model";

function StatusRow({ label, value, badge }: { label: string; value: string; badge?: "ok" | "warn" | "danger" | "neutral" }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right">
        {badge ? (
          <Badge variant={badge === "ok" ? "success" : badge === "warn" ? "warning" : badge === "danger" ? "destructive" : "secondary"} className="font-normal text-[11px]">
            {value}
          </Badge>
        ) : (
          <span className="font-medium text-foreground">{value}</span>
        )}
      </dd>
    </div>
  );
}

/**
 * 素材详情：审核状态/当前可见性/技术状态/对象绑定四轴分开。
 * 技术与绑定事实合同未返回时显示未提供，不推定已完成。
 * 动作按归属+用途+状态+权限 fail-closed（封面归目录权限，不依赖审核决定权）。
 * 审核确认由父级承载（完整 assetId+action 锚定，切换面板不丢）。
 */
export function MediaDetailPanel({
  asset,
  games,
  canDecide,
  canUpload,
  onZoom,
  onOpenPath,
  onAction,
  onNext,
  onClose,
  hasNext = false,
  busy,
  hideHeading = false,
}: {
  asset: MediaAssetReview;
  games: SupplyGame[];
  canDecide: boolean;
  canUpload: boolean;
  onZoom: (target: ZoomTarget) => void;
  onOpenPath?: (path: string) => void;
  onAction: (action: MediaAction) => void;
  onNext?: () => void;
  onClose?: () => void;
  hasNext?: boolean;
  busy: boolean;
  hideHeading?: boolean;
}) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const gameNames = new Map(games.map((game) => [game.id, game.name]));
  const set = actionsFor(asset, { canDecide, canUpload });
  const reviewActions = set.actions.filter((action) => action.kind === "review");
  const visibilityActions = set.actions.filter((action) => action.kind === "visibility");
  const coverActions = set.actions.filter((action) => action.kind === "cover");
  const copy = (value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied("ok");
        setTimeout(() => setCopied("idle"), 1500);
      })
      .catch(() => {
        setCopied("fail");
        setTimeout(() => setCopied("idle"), 1500);
      });
  };

  const getActionVariant = (action: MediaAction) => {
    if (action.kind === "review") {
      if (action.decision === "APPROVE") return "default" as const;
      if (action.decision === "REJECT") return "destructive" as const;
      return "outline" as const;
    }
    if (action.kind === "visibility") return action.visibility === "PUBLIC_DISPLAY" ? "default" as const : "secondary" as const;
    return "secondary" as const;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* 头部标题与收起入口 */}
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-border/60">
        <div className="min-w-0">
          {!hideHeading ? <h4 className="text-sm font-semibold tracking-tight">素材详情</h4> : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{PURPOSE_LABELS[asset.purpose] ?? asset.purpose}</span>
            <span>·</span>
            <span className="font-mono">{asset.width}×{asset.height}</span>
            <span>·</span>
            <span className="font-mono">{asset.mime}</span>
          </div>
        </div>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="收起详情"
            onClick={onClose}
            className="size-7 rounded-md text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      {/* 主体滚动区：单流顺畅滚动，彻底杜绝内部多层滚动嵌套 */}
      <div className="min-h-0 min-w-0 flex-1 space-y-3.5 overflow-y-auto py-3 pr-1">
        {/* 图片预览卡片 */}
        <div className="group relative overflow-hidden rounded-xl border border-border/80 bg-surface-raised shadow-xs">
          <Button
            type="button"
            variant="outline"
            className="block h-auto w-full p-0 border-0 bg-transparent hover:bg-transparent"
            aria-label="放大核对素材"
            onClick={() => onZoom({ src: mediaContentUrl(asset.id), alt: `素材 ${asset.id}`, caption: `${PURPOSE_LABELS[asset.purpose] ?? asset.purpose} · ${STATE_LABELS[asset.reviewState] ?? asset.reviewState} · ${asset.id}` })}
          >
            <img
              src={mediaContentUrl(asset.id)}
              alt={`素材 ${asset.id} 预览`}
              className="max-h-60 w-full rounded-lg object-contain bg-surface-raised p-2"
              loading="lazy"
              onError={(event) => {
                const img = event.currentTarget;
                if (!img.dataset.failed) {
                  img.dataset.failed = "1";
                  img.alt = "图片加载失败，可在放大视图重试";
                }
              }}
            />
          </Button>
          <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-1 text-[11px] text-white/95 backdrop-blur-xs opacity-0 transition-opacity group-hover:opacity-100">
            点击全屏放大核对
          </div>
        </div>

        {/* 标识与哈希属性条 */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground border border-border/60">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="shrink-0 text-muted-foreground/70">素材ID:</span>
            <code className="truncate font-mono text-[10px] text-foreground font-medium">{asset.id}</code>
            <Button type="button" variant="ghost" size="icon-xs" className="h-5 w-5 shrink-0" aria-label="复制素材ID" onClick={() => copy(asset.id)}>
              {copied === "ok" ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            </Button>
            {copied === "ok" ? <span className="text-[10px] text-emerald-500 font-medium">已复制</span> : copied === "fail" ? <span className="text-[10px] text-destructive">复制失败</span> : null}
          </div>
          <div className="flex items-center gap-2 text-[10px] shrink-0 font-mono text-muted-foreground">
            <span>hash {asset.contentHash.slice(0, 8)}…</span>
            <span>·</span>
            <span>{formatBytes(asset.byteSize)}</span>
          </div>
        </div>

        {/* 状态与事实 dl */}
        <dl className="divide-y divide-border/60 rounded-xl border border-border/80 bg-card/60 px-3.5 py-1">
          <StatusRow label="审核状态" value={STATE_LABELS[asset.reviewState] ?? asset.reviewState} badge={asset.reviewState === "APPROVED" ? "ok" : asset.reviewState === "PENDING" ? "warn" : "danger"} />
          <StatusRow label="当前可见性" value={VISIBILITY_LABELS[asset.accessClass] ?? asset.accessClass} badge={asset.accessClass === "PUBLIC_DISPLAY" ? "ok" : "neutral"} />
          <StatusRow label="技术状态" value={technicalFact(asset)} />
          <StatusRow label="对象绑定" value={bindingFact(asset)} />
          <StatusRow label="素材修订" value={revisionFact(asset)} />
        </dl>
        {!asset.technicalState || !asset.binding ? (
          <p className="text-[11px] text-muted-foreground/80 leading-relaxed px-1">
            技术与绑定事实未随队列返回，不推定已完成；能加载图片不代表技术处理通过，公开配置也不单独证明匿名可读。素材版本冲突保护（expectedRevision/409）合同尚未统一，本页不承诺并发覆盖会被拒绝。
          </p>
        ) : null}

        {/* 归属与时间 dl */}
        <dl className="divide-y divide-border/60 rounded-xl border border-border/80 bg-card/60 px-3.5 py-1">
          <StatusRow label="归属" value={OWNERSHIP_LABELS[asset.ownershipKind] ?? asset.ownershipKind} />
          <StatusRow label="对象" value={objectName(asset, gameNames)} />
          <StatusRow label="来源" value={asset.uploadedByRealm === "admin" ? "管理员" : "用户"} />
          <div className="flex items-center justify-between gap-3 py-1.5 text-xs">
            <dt className="shrink-0 text-muted-foreground">上传时间</dt>
            <dd className="min-w-0 text-right">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger render={<span tabIndex={0} className="cursor-default underline decoration-dotted underline-offset-2 font-medium" />}>
                    {timeShort(asset.createdAt)}
                  </TooltipTrigger>
                  <TooltipContent>{timeFull(asset.createdAt)}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </dd>
          </div>
          {asset.reviewReason ? <StatusRow label="审核说明" value={asset.reviewReason} /> : null}
        </dl>
      </div>

      {/* 底部操作区：去除嵌套滚动，按钮视觉加强 */}
      {set.accountDisplayOnly ? (
        <div className="shrink-0 space-y-2 border-t border-border/60 pt-3">
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5">
            <p className="text-xs text-muted-foreground leading-relaxed">{set.note}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-9 w-full whitespace-normal font-medium shadow-2xs"
            disabled={!asset.accountId || !onOpenPath}
            onClick={() => asset.accountId && onOpenPath?.(`/supply/reviews/${encodeURIComponent(asset.accountId)}?context=changes&assetId=${encodeURIComponent(asset.id)}`)}
          >
            <ExternalLink className="size-3.5" /> 进入来源账号核对本图
          </Button>
          {!asset.accountId ? <p className="text-[11px] text-amber-600 dark:text-amber-400">来源账号未提供，请先核对对象关联；不能凭本图处置。</p> : null}
        </div>
      ) : null}

      {!set.accountDisplayOnly && (set.actions.length > 0 || set.note) ? (
        <div className="shrink-0 space-y-2.5 border-t border-border/60 pt-3">
          {set.note ? <p className="text-xs text-muted-foreground">{set.note}</p> : null}
          {reviewActions.length ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">审核决定</p>
              {(() => {
                const primary = reviewActions.find((action) => action.kind === "review" && action.decision === "APPROVE");
                const rest = reviewActions.filter((action) => action !== primary);
                return (
                  <>
                    {primary ? (
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 w-full font-medium bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs"
                        disabled={busy}
                        onClick={() => onAction(primary)}
                      >
                        {primary.label}
                      </Button>
                    ) : null}
                    {rest.length ? (
                      <div className="grid grid-cols-2 gap-2">
                        {rest.map((action) => (
                          <Button
                            key={`${action.kind}-${action.kind === "review" ? action.decision : "x"}`}
                            type="button"
                            size="sm"
                            className="h-9 w-full"
                            variant={getActionVariant(action)}
                            disabled={busy}
                            onClick={() => onAction(action)}
                          >
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          ) : null}
          {visibilityActions.length ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">公开范围</p>
              <div className={visibilityActions.length > 1 ? "grid grid-cols-2 gap-2" : ""}>
                {visibilityActions.map((action) => (
                  <Button
                    key={`${action.kind}-${action.kind === "visibility" ? action.visibility : "x"}`}
                    type="button"
                    size="sm"
                    className="h-9 w-full"
                    variant={getActionVariant(action)}
                    disabled={busy}
                    onClick={() => onAction(action)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          {coverActions.length ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">目录绑定</p>
              {coverActions.map((action) => (
                <Button
                  key={`${action.kind}-cover`}
                  type="button"
                  size="sm"
                  className="h-9 w-full"
                  variant={getActionVariant(action)}
                  disabled={busy}
                  onClick={() => onAction(action)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
          {onNext && hasNext ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-9 w-full font-medium"
              disabled={busy}
              onClick={onNext}
            >
              下一张待审
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
