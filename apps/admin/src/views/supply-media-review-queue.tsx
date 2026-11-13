import { useState, type Dispatch, type SetStateAction } from "react";
import { ChevronRight, RefreshCw, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { MediaAssetReview, MediaReviewPage } from "../api";
import { mediaContentUrl } from "./supply-review/model";
import { isExemptReview, objectName, PURPOSE_LABELS, STATE_LABELS, timeShort, VISIBILITY_LABELS, type ReviewedState, type ReviewTab } from "./supply-media/model";

function Thumb({ asset }: { asset: MediaAssetReview }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative block size-12 shrink-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-xs group-hover:border-primary/40 transition-colors">
      {failed ? <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">加载失败</span> : null}
      <img
        src={mediaContentUrl(asset.id)}
        alt=""
        loading="lazy"
        className="relative size-full object-contain transition-transform duration-200"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

export function MediaReviewQueue({ filterSummary, page, pageItems, reviewScope, setReviewScope, setSelected, reviewableCount, exemptCount, loading, loadQueue, cursorNow, listError, wide, visibleItems, selected, gameNames, tab, setTab, setReviewedState, pageIndex, goPrev, goNext, scopeLabel }: {
  filterSummary: string;
  page: MediaReviewPage | null;
  pageItems: MediaAssetReview[];
  reviewScope: "all" | "reviewable" | "exempt";
  setReviewScope: Dispatch<SetStateAction<"all" | "reviewable" | "exempt">>;
  setSelected: Dispatch<SetStateAction<MediaAssetReview | null>>;
  reviewableCount: number;
  exemptCount: number;
  loading: boolean;
  loadQueue: (cursor?: string, syncSelection?: boolean) => void;
  cursorNow: () => string | undefined;
  listError: string | null;
  wide: boolean;
  visibleItems: MediaAssetReview[];
  selected: MediaAssetReview | null;
  gameNames: Map<string, string>;
  tab: ReviewTab;
  setTab: Dispatch<SetStateAction<ReviewTab>>;
  setReviewedState: Dispatch<SetStateAction<ReviewedState>>;
  pageIndex: number;
  goPrev: () => void;
  goNext: () => void;
  scopeLabel: string;
}) {
  const reviewBadge = (asset: MediaAssetReview) => {
    if (isExemptReview(asset)) {
      return <Badge variant="outline" className="gap-1 font-medium"><span className="size-1.5 rounded-full bg-sky-500" />免审核对</Badge>;
    }
    const variant = asset.reviewState === "APPROVED" ? "success" as const : asset.reviewState === "PENDING" ? "warning" as const : "destructive" as const;
    const dot = asset.reviewState === "APPROVED" ? "bg-emerald-500" : asset.reviewState === "PENDING" ? "bg-amber-500 motion-safe:animate-pulse" : "bg-rose-500";
    return <Badge variant={variant} className="gap-1 font-medium"><span className={`size-1.5 rounded-full ${dot}`} />{STATE_LABELS[asset.reviewState] ?? asset.reviewState}</Badge>;
  };
  const visibilityBadge = (asset: MediaAssetReview) => (
    <Badge variant={asset.accessClass === "PUBLIC_DISPLAY" ? "info" : "secondary"} className="gap-1 font-medium">
      <span className={`size-1.5 rounded-full ${asset.accessClass === "PUBLIC_DISPLAY" ? "bg-sky-500" : "bg-muted-foreground/50"}`} />
      {VISIBILITY_LABELS[asset.accessClass] ?? asset.accessClass}
    </Badge>
  );
  const queueEmptyState = (
    <div className="mx-auto my-6 mt-4 max-w-2xl space-y-3 p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground/80">
        <ShieldAlert className="size-6 text-primary" />
      </div>
      <p className="text-sm font-semibold">
        {filterSummary}：当前筛选下没有{reviewScope === "reviewable" ? "可审核素材" : reviewScope === "exempt" ? "免审核对素材" : "素材"}。
      </p>
      <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
        {tab === "pending"
          ? reviewScope === "exempt"
            ? "账号展示图免发布前预审，请在来源账号核对。"
            : "可切换处理范围、状态或刷新队列。"
          : "可切换状态或刷新队列。"}
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        {reviewScope === "reviewable" && exemptCount > 0 ? <Button type="button" size="sm" variant="secondary" onClick={() => { setReviewScope("exempt"); setSelected(null); }}>查看免审核对</Button> : null}
        {reviewScope === "exempt" && reviewableCount > 0 ? <Button type="button" size="sm" variant="secondary" onClick={() => { setReviewScope("reviewable"); setSelected(null); }}>查看可审核</Button> : null}
        {tab === "pending" ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => { setTab("reviewed"); setReviewedState("APPROVED"); }}>查看已通过</Button>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={() => setTab("pending")}>查看待审核</Button>
        )}
      </div>
    </div>
  );
  return (
        <section className="section-panel min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight">审核队列</h2>
              <span className="text-xs text-muted-foreground">{filterSummary}{page ? ` · 本页 ${pageItems.length} 条` : ""}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {page && pageItems.length > 0 ? (
                <div role="group" aria-label="处理范围" className="flex items-center gap-0.5 rounded-md border border-border/70 p-0.5">
                  {([
                    ["all", `全部 ${pageItems.length}`],
                    ["reviewable", `可审核 ${reviewableCount}`],
                    ["exempt", `免审 ${exemptCount}`],
                  ] as const).map(([value, label]) => (
                    <Button key={value} type="button" size="sm" variant={reviewScope === value ? "secondary" : "ghost"} aria-pressed={reviewScope === value} className="h-7 px-2 text-xs" onClick={() => { setReviewScope(value); setSelected(null); }}>{label}</Button>
                  ))}
                </div>
              ) : null}
              <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={loading} onClick={() => void loadQueue(cursorNow(), true)}>
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />刷新
              </Button>
            </div>
          </div>
          {listError ? (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-destructive">{listError}</p>
              <Button type="button" size="sm" variant="secondary" onClick={() => void loadQueue(cursorNow())}>重新读取</Button>
            </div>
          ) : loading && !page ? (
            <div className="mt-3 space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : page && page.items.length > 0 && visibleItems.length > 0 ? (
            <>
              {wide ? (
                <div className="mt-2 overflow-x-auto">
                  <Table className="min-w-[680px]">
                    <TableHeader>
                      <TableRow className="bg-muted/30">
                        <TableHead className="min-w-[260px]">素材</TableHead>
                        <TableHead className="w-20 whitespace-nowrap">游戏</TableHead>
                        <TableHead className="w-28 whitespace-nowrap">审核状态</TableHead>
                        <TableHead className="w-28 whitespace-nowrap">当前可见性</TableHead>
                        <TableHead className="w-28 whitespace-nowrap">上传时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleItems.map((asset) => (
                        <TableRow
                          key={asset.id}
                          data-selected={selected?.id === asset.id ? "true" : undefined}
                          className={`group transition-colors ${selected?.id === asset.id ? "bg-primary/5 ring-1 ring-inset ring-primary/20" : "hover:bg-muted/40"}`}
                        >
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-auto w-full min-w-0 justify-start gap-2.5 p-0 text-left font-normal hover:bg-transparent"
                              aria-label={`查看素材 ${PURPOSE_LABELS[asset.purpose] ?? asset.purpose} ${timeShort(asset.createdAt)}`}
                              onClick={() => setSelected(asset)}
                            >
                              <Thumb asset={asset} />
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-semibold text-foreground group-hover:text-primary transition-colors">{PURPOSE_LABELS[asset.purpose] ?? asset.purpose}</span>
                                <span className="block truncate text-xs text-muted-foreground">{objectName(asset, gameNames)}</span>
                              </span>
                            </Button>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs font-medium">{gameNames.get(asset.gameId) ?? "游戏名未提供"}</TableCell>
                          <TableCell>{reviewBadge(asset)}</TableCell>
                          <TableCell>{visibilityBadge(asset)}</TableCell>
                          <TableCell>
                            <span className="whitespace-nowrap text-xs text-muted-foreground">{timeShort(asset.createdAt)}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  {visibleItems.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      className="flex w-full items-start gap-3 rounded-lg border border-border/70 bg-card/40 p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`查看素材 ${PURPOSE_LABELS[asset.purpose] ?? asset.purpose} ${timeShort(asset.createdAt)}`}
                      onClick={() => setSelected(asset)}
                    >
                      <Thumb asset={asset} />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-foreground">{PURPOSE_LABELS[asset.purpose] ?? asset.purpose}</span>
                          {reviewBadge(asset)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{objectName(asset, gameNames)}</span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span>{gameNames.get(asset.gameId) ?? "游戏名未提供"}</span>
                          <span>·</span>
                          <span>{timeShort(asset.createdAt)}</span>
                          <span>·</span>
                          {visibilityBadge(asset)}
                        </span>
                      </span>
                      <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">本页 {pageItems.length} 条{reviewScope !== "all" ? ` · ${scopeLabel} ${visibleItems.length} 条` : ""}</span>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="secondary" disabled={pageIndex === 0 || loading} onClick={goPrev}>上一页</Button>
                  <Button type="button" size="sm" variant="secondary" disabled={!page.nextCursor || loading} onClick={goNext}>下一页</Button>
                </div>
              </div>
            </>
          ) : queueEmptyState}
        </section>
  );
}
