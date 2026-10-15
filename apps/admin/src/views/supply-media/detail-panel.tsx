import { useState } from "react";

import { Check, Copy, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5 text-xs">
      <span className="font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

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
  reason,
  onReasonChange,
  onZoom,
  onOpenPath,
  onAction,
  busy,
  hideHeading = false,
}: {
  asset: MediaAssetReview;
  games: SupplyGame[];
  canDecide: boolean;
  canUpload: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  onZoom: (target: ZoomTarget) => void;
  onOpenPath?: (path: string) => void;
  onAction: (action: MediaAction) => void;
  busy: boolean;
  hideHeading?: boolean;
}) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const gameNames = new Map(games.map((game) => [game.id, game.name]));
  const set = actionsFor(asset, { canDecide, canUpload });
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
  const needsReasonField = set.actions.some((a) => a.kind === "review" || (a.kind === "visibility" && a.visibility === "PRIVATE_REVIEW"));

  const getActionBtnProps = (action: MediaAction) => {
    if (action.kind === "review") {
      if (action.decision === "APPROVE") return { variant: "default" as const, className: "bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs font-medium" };
      if (action.decision === "REJECT") return { variant: "destructive" as const, className: "shadow-xs font-medium" };
      if (action.decision === "QUARANTINE") return { variant: "outline" as const, className: "border-amber-500/50 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 shadow-xs font-medium" };
    }
    if (action.kind === "visibility") {
      if (action.visibility === "PUBLIC_DISPLAY") return { variant: "default" as const, className: "bg-sky-600 hover:bg-sky-700 text-white shadow-xs font-medium" };
      if (action.visibility === "PRIVATE_REVIEW") return { variant: "secondary" as const, className: "shadow-xs font-medium" };
    }
    return { variant: "default" as const, className: "bg-purple-600 hover:bg-purple-700 text-white shadow-xs font-medium" };
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {!hideHeading ? <h4 className="text-sm font-semibold tracking-tight">素材详情</h4> : null}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">{PURPOSE_LABELS[asset.purpose] ?? asset.purpose}</span>
              <span>·</span>
              <span className="font-mono">{asset.width}×{asset.height}</span>
              <span>·</span>
              <span className="font-mono">{asset.mime}</span>
            </div>
          </div>
        </div>

        <div className="group relative overflow-hidden rounded-lg border border-border/80 bg-surface-raised shadow-xs">
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
              className="max-h-52 w-full rounded object-contain bg-surface-raised p-1"
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
          <div className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-xs opacity-0 transition-opacity group-hover:opacity-100">
            点击全屏核对
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="shrink-0 text-muted-foreground/70">素材ID:</span>
            <code className="truncate font-mono text-[10px] text-foreground font-medium">{asset.id}</code>
            <Button type="button" variant="ghost" size="icon-xs" className="h-5 w-5 shrink-0" aria-label="复制素材ID" onClick={() => copy(asset.id)}>
              {copied === "ok" ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            </Button>
            {copied === "ok" ? <span className="text-[10px] text-emerald-500">已复制</span> : copied === "fail" ? <span className="text-[10px] text-destructive">复制失败</span> : null}
          </div>
          <div className="flex items-center gap-2 text-[10px] shrink-0 font-mono text-muted-foreground">
            <span>hash {asset.contentHash.slice(0, 8)}…</span>
            <span>·</span>
            <span>{formatBytes(asset.byteSize)}</span>
          </div>
        </div>

        <dl className="divide-y divide-border/60 rounded-md border border-border/80 bg-card/50 px-3 py-0.5">
          <StatusRow label="审核状态" value={STATE_LABELS[asset.reviewState] ?? asset.reviewState} badge={asset.reviewState === "APPROVED" ? "ok" : asset.reviewState === "PENDING" ? "warn" : "danger"} />
          <StatusRow label="当前可见性" value={VISIBILITY_LABELS[asset.accessClass] ?? asset.accessClass} badge={asset.accessClass === "PUBLIC_DISPLAY" ? "ok" : "neutral"} />
          <StatusRow label="技术状态" value={technicalFact(asset)} />
          <StatusRow label="对象绑定" value={bindingFact(asset)} />
          <StatusRow label="素材修订" value={revisionFact(asset)} />
        </dl>
        {!asset.technicalState || !asset.binding ? <p className="text-[11px] text-muted-foreground/80 leading-relaxed">技术与绑定事实未随队列返回，不推定已完成；能加载图片不代表技术处理通过，公开配置也不单独证明匿名可读。素材版本冲突保护（expectedRevision/409）合同尚未统一，本页不承诺并发覆盖会被拒绝。</p> : null}

        <dl className="divide-y divide-border/60 rounded-md border border-border/80 bg-card/50 px-3 py-0.5">
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

      {set.accountDisplayOnly ? (
          <div className="max-h-[50%] shrink-0 space-y-2 overflow-y-auto border-t border-border/60 pt-3">
            <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2.5">
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
        <div className="max-h-[50%] shrink-0 space-y-2 overflow-y-auto border-t border-border/60 pt-3">
          {set.note ? <p className="text-xs text-muted-foreground">{set.note}</p> : null}
          {needsReasonField ? (
            <div className="space-y-1">
              <Field label="处置说明（审核按需必填，公开调整可选）">
                <Textarea className="min-h-16 max-h-32 resize-y text-xs" value={reason} onChange={(event) => onReasonChange(event.target.value)} maxLength={500} rows={2} placeholder="请填写本次核对说明" disabled={busy} />
              </Field>
              <p className="text-[11px] text-muted-foreground">驳回、隔离或重新通过需填 2–500 字；公开调整可留空。</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            {set.actions.map((action) => {
              const props = getActionBtnProps(action);
              return (
                <Button
                  key={`${action.kind}-${action.kind === "review" ? action.decision : action.kind === "visibility" ? action.visibility : "cover"}`}
                  type="button"
                  size="sm"
                  className={`h-8.5 px-3 ${props.className}`}
                  variant={props.variant}
                  disabled={busy}
                  onClick={() => onAction(action)}
                >
                  {action.label}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
