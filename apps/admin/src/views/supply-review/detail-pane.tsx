import type { ReactNode } from "react";

import { formatDate } from "../../api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SupplySelect } from "@/components/supply/supply-select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  attributeFacts,
  formatAmount,
  formatTermDays,
  inventoryRows,
  historicalAttributeFacts,
  historicalReadSummary,
  historicalResourceText,
  isHistorical,
  mediaCanQuarantine,
  mediaCanRestore,
  mediaContentUrl,
  mediaEligibleLabel,
  mediaPurposeLabel,
  mediaReadableLabel,
  mediaReviewLabel,
  publicationSourceLabel,
  quantityText,
  reviewStateLabel,
  skinsText,
  type Detail,
  type LegacyHistoricalRead,
  type MediaBinding,
  type QueueItem,
  type ZoomTarget,
} from "./model";

function StateBadge({ state }: { state: string }) {
  const variant = state === "SUBMITTED" || state === "IMPORTED_UNVERIFIED" ? "warning" : state === "REJECTED" ? "destructive" : "secondary";
  return <Badge variant={variant}>{reviewStateLabel(state)}</Badge>;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-6 w-2/5 animate-pulse rounded bg-muted" />
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-16 animate-pulse rounded-lg bg-muted" />
      <div className="h-40 animate-pulse rounded-lg bg-muted" />
      <div className="h-56 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

function MediaCard({
  binding,
  index,
  total,
  canReviewMedia,
  readOnly,
  busy,
  reasonReady,
  onZoom,
  onQuarantine,
  onRestore,
}: {
  binding: MediaBinding;
  index: number;
  total: number;
  canReviewMedia: boolean;
  readOnly: boolean;
  busy: boolean;
  reasonReady: boolean;
  onZoom: (target: ZoomTarget, trigger?: HTMLElement) => void;
  onQuarantine: (assetId: string) => void;
  onRestore: (assetId: string) => void;
}) {
  const evidence = binding.purpose !== "ACCOUNT_DISPLAY";
  const label = mediaPurposeLabel(binding);
  const caption = evidence ? `${label} · 仅审核可见,始终不公开` : label;
  const quarantined = binding.reviewState === "QUARANTINED";
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-card">
      <Button variant="ghost"
        type="button"
        aria-label={`放大核对 ${caption} ${index + 1}`}
        className="block h-auto w-full rounded-none p-0 focus-visible:ring-inset"
        onClick={event =>
          onZoom({
            src: mediaContentUrl(binding.assetId),
            alt: `${caption} ${index + 1}`,
            caption: `${caption} · ${index + 1} / ${total}`,
          }, event.currentTarget)
        }
      >
        <img
          src={mediaContentUrl(binding.assetId)}
          alt={`${caption} ${index + 1}`}
          loading="lazy"
          className="aspect-[4/3] w-full bg-surface-raised object-contain"
        />
      </Button>
      <figcaption className="space-y-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={evidence ? "text-warning" : ""}>{caption} · {index + 1}</span>
          <span className="text-foreground">放大核对</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={quarantined ? "destructive" : "secondary"}>
            {mediaReviewLabel(binding)}
          </Badge>
          <Badge variant="outline">{mediaEligibleLabel(binding)}</Badge>
          <Badge variant="outline">{mediaReadableLabel(binding)}</Badge>
        </div>
        {!evidence && canReviewMedia && !readOnly && (mediaCanQuarantine(binding) || mediaCanRestore(binding)) ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {mediaCanQuarantine(binding) ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                title="填写原因并确认后才会隔离"
                onClick={() => onQuarantine(binding.assetId)}
              >
                隔离展示图…
              </Button>
            ) : null}
            {mediaCanRestore(binding) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                title="填写原因并确认恢复，技术资格由服务端核验"
                onClick={() => onRestore(binding.assetId)}
              >
                恢复展示…
              </Button>
            ) : null}
          </div>
        ) : null}
        {!evidence && canReviewMedia && !readOnly && quarantined ? (
          <p className="text-xs">恢复前提为技术就绪;不满足时服务端会返回明确错误,需重新上传校验。</p>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function SupplyDetailPane({
  detail,
  historicalRead,
  loading,
  versionId,
  onSelectVersion,
  canDuplicate,
  canReviewMedia,
  queueItems,
  related,
  onRelatedChange,
  busy,
  reasonReady,
  onRecordDuplicate,
  onQuarantine,
  onRestore,
  onZoom,
  releaseGeneration,
  onRefresh,
  refreshing,
  tab, onTabChange, actions,
}: {
  detail?: Detail;
  historicalRead?: LegacyHistoricalRead | null;
  loading: boolean;
  versionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
  canDuplicate: boolean;
  canReviewMedia: boolean;
  queueItems: QueueItem[];
  related: string;
  onRelatedChange: (value: string) => void;
  busy: boolean;
  reasonReady: boolean;
  onRecordDuplicate: () => void;
  onQuarantine: (assetId: string) => void;
  onRestore: (assetId: string) => void;
  onZoom: (target: ZoomTarget, trigger?: HTMLElement) => void;
  releaseGeneration: string | null;
  onRefresh: () => void;
  refreshing: boolean;
  tab: "data" | "media" | "history";
  onTabChange: (tab: "data" | "media" | "history") => void;
  actions?: ReactNode;
}) {
  if (!detail) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-16 text-center text-sm text-muted-foreground">
        {loading ? (
          <div className="w-full max-w-md">
            <DetailSkeleton />
          </div>
        ) : (
          <div>
            <p>选择左侧一个账号,查看发布状态、详情与事后操作。</p>
            <p className="mt-2 text-xs">队列保留视图与游标;j/k 移动,Enter 打开。</p>
          </div>
        )}
      </div>
    );
  }

  const version = detail.version;
  const previous = detail.previousDeclaration;
  const historical = isHistorical(detail);
  const facts = attributeFacts(version);
  const rows = inventoryRows(version, previous, detail.previousPresentation?.items);
  const media = version.declaration.mediaBindings;
  const publication = version.publication;
  const directPublish = version.reviewState === "PUBLISHED";

  return (
    <Tabs value={tab} onValueChange={value => onTabChange(value as "data" | "media" | "history")} className="supervision-detail-body min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold">{version.declaration.title || "未命名资料"}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>
              {detail.ownerName} · {version.sequence ? `第 ${version.sequence} 版` : ""}
            </span>
            <StateBadge state={version.reviewState} />
          </p>

        </div>
        <div className="flex flex-wrap gap-2">{actions}<Button variant="outline" size="sm" onClick={onRefresh} aria-busy={refreshing || undefined} disabled={loading || refreshing}>
          {refreshing ? "读取中…" : "刷新详情"}
        </Button></div>
      </header>

      {historical ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-soft-warning px-3 py-2 text-xs text-warning">
          <span>正在查看历史版本(只读)。事后操作只对当前版本开放。</span>
          <Button size="sm" variant="outline" onClick={() => onSelectVersion(null)}>
            回到当前版本
          </Button>
        </div>
      ) : null}

      <TabsList aria-label="账号详情分组" className="mt-4 overflow-x-auto gap-5 [&>button]:shrink-0 [&>button]:px-1">
        {([["data", "账号资料"], ["media", "图片与凭证"], ["history", "历史与记录"]] as const).map(([key, label]) => <TabsTrigger key={key} value={key} id={`supervision-tab-${key}`}>{label}</TabsTrigger>)}
      </TabsList>
      <TabsContent value="data" keepMounted id="supervision-panel-data" aria-labelledby="supervision-tab-data" hidden={tab !== "data"} className="supervision-sections min-w-0">
      {historicalRead ? <Section title="历史来源资料">
        <p>{historicalReadSummary(historicalRead)}</p>
        {historicalRead.display?.state === "KNOWN" && historicalRead.display.facts?.attributes && Array.isArray(historicalRead.display.facts.resources) ? <>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{historicalAttributeFacts(historicalRead).map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">{historicalRead.display.facts.resources.map(resource => <li key={resource.code}>{resource.name}：{historicalResourceText(resource)}</li>)}</ul>
          <p className="text-xs text-muted-foreground">来源记录更新于 {formatDate(historicalRead.display.facts.sourceUpdatedAt)}。历史显示量不替代本版申报或当前可租资格。</p>
        </> : <p role={historicalRead.display?.state === "KNOWN" ? "alert" : "status"}>{historicalRead.display?.state === "KNOWN" ? "历史扩展资料返回不完整，请重试读取。" : "历史扩展资料尚待接入，未提供的资源数量不能按零处理。"}</p>}
        <p className="text-sm">历史租金 {historicalRead.historicalQuote.haffRentYuan} 元 · 历史物资金额 {historicalRead.historicalQuote.goodsYuan} 元 · 历史押金 {historicalRead.historicalQuote.depositYuan} 元</p>
        <p className="text-xs text-muted-foreground">以上为来源金额记录，不是当前报价、可用余额、保证金到账或退款结果。</p>
      </Section> : null}
      <Section title={previous ? "资料与变化" : "申报说明"}>
        {previous ? (
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <div className="border-l border-border pl-4">
              <p className="text-xs font-medium text-muted-foreground">上一版本的说明</p>
              <p className="mt-1.5 whitespace-pre-wrap text-muted-foreground">
                {previous.title}
                <br />
                {previous.description || "未填写补充说明"}
              </p>
            </div>
            <div className="border-l border-border pl-4">
              <p className="text-xs font-medium text-muted-foreground">当前版本的说明</p>
              <p className="mt-1.5 whitespace-pre-wrap">
                {version.declaration.title}
                <br />
                {version.declaration.description || "未填写补充说明"}
              </p>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {version.declaration.description || "未填写补充说明"}
          </p>
        )}
      </Section>

      <Section title="申报属性">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-xs text-muted-foreground">{fact.label}</dt>
              <dd className={`mt-0.5 ${fact.unconfirmed ? "text-warning" : ""}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="资源数量">
        <div className="overflow-x-auto">
          <Table className="w-full text-left text-sm">
            <TableHeader className="bg-surface-raised">
              <TableRow>
                <TableHead scope="col" className="px-4 py-2.5 font-medium">物品</TableHead>
                {previous && <TableHead scope="col" className="px-4 py-2.5 font-medium">上一版</TableHead>}
                <TableHead scope="col" className="px-4 py-2.5 font-medium">{previous ? "当前版本" : "申报数量"}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow className="border-t border-border">
                  <TableCell className="px-4 py-3 text-muted-foreground" colSpan={previous ? 3 : 2}>
                    未申报资源数量。
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => (
                <TableRow key={row.itemId} className={`border-t border-border ${previous && row.changed ? "bg-muted/30" : ""}`}>
                  <TableCell className="px-4 py-3 whitespace-normal">
                    {row.name}
                    <span className="mt-1 block text-xs text-muted-foreground">单位:{row.unit}</span>
                  </TableCell>
                  {previous && <TableCell className="px-4 py-3 tabular-nums text-muted-foreground">{row.previous}</TableCell>}
                  <TableCell className="px-4 py-3 tabular-nums">
                    {row.current}
                    {previous && row.changed ? (
                      <span className="ml-2 rounded border border-border px-1 text-xs text-foreground">已变化</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-sm text-muted-foreground">皮肤:{skinsText(version)}</p>
        {version.declaration.entitlements.length ? (
          <ul className="space-y-2 text-sm">
            {version.declaration.entitlements.map((entitlement) => (
              <li key={entitlement.entitlementId}>
                {version.presentation.entitlements?.find((item) => item.id === entitlement.entitlementId)?.name ?? "历史权益"}:
                {typeof entitlement.value === "boolean"
                  ? entitlement.value
                    ? "已声明持有"
                    : "未持有"
                  : String(entitlement.value ?? "未知")}{" "}
                ·{" "}
                {entitlement.expiresAt
                  ? `到期 ${new Date(entitlement.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
                  : "未声明到期时间"}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">
          旧来源租金、物品费、押金与比例只作受限证据,不等同于当前服务端报价;未映射的复杂权益不按 0 处理。
        </p>
      </Section>

      <Collapsible className="supervision-quote"><CollapsibleTrigger render={<Button variant="ghost" className="justify-start px-0"/>}>查看报价、租期与发布事实</CollapsibleTrigger><CollapsibleContent keepMounted className="mt-3 space-y-3 data-[closed]:hidden">
      <dl className="grid gap-x-8 gap-y-3 rounded-lg border border-border bg-card px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">发布来源</dt>
          <dd className="mt-0.5 text-sm">{publication ? publicationSourceLabel(publication.source) : "无发布事实"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">发布时间</dt>
          <dd className="mt-0.5 text-sm">{publication ? formatDate(publication.publishedAt) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">资料版本资源报价</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums">
            {version.quote ? `¥${formatAmount(version.quote.resourceTotal.amount)}` : "尚无有效报价"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">规则版本</dt>
          <dd
            className="mt-0.5 text-sm"
            title={releaseGeneration ? undefined : "规则代际需要 supply.rules.edit 权限查看"}
          >
            {releaseGeneration ? `第 ${releaseGeneration} 代` : version.releaseId ?? "未提供"}
          </dd>
        </div>
      </dl>
      {version.quote ? (
        <p className="text-xs text-muted-foreground">
          来自第 {version.sequence} 版资料保存的报价；非按当前规则重新试算，租客档位口径未提供。租期 {formatTermDays(version.quote.termSeconds)} · 每日消耗 {quantityText(version.termOption?.dailyConsumption?.quantity)}；不等同已成立订单的冻结价
        </p>
      ) : null}

      </CollapsibleContent></Collapsible>
      </TabsContent>
      <TabsContent value="media" keepMounted id="supervision-panel-media" aria-labelledby="supervision-tab-media" hidden={tab !== "media"} className="supervision-sections min-w-0">
      <Section title="账号图片">
        {media.length === 0 ? (
          <p className="text-sm text-muted-foreground">本版本未绑定图片。</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {media.map((binding, index) => (
              <MediaCard
                key={binding.assetId}
                binding={binding}
                index={index}
                total={media.length}
                canReviewMedia={canReviewMedia}
                readOnly={historical}
                busy={busy}
                reasonReady={reasonReady}
                onZoom={onZoom}
                onQuarantine={onQuarantine}
                onRestore={onRestore}
              />
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          隔离展示图会立即阻断该账号的公开展示与新订单;已成立订单与快照不变。恢复需技术就绪并记录操作人与原因。
        </p>
      </Section>

      </TabsContent>
      <TabsContent value="history" keepMounted id="supervision-panel-history" aria-labelledby="supervision-tab-history" hidden={tab !== "history"} className="supervision-sections min-w-0">
      {canDuplicate && !historical ? (
        <Section title="疑似重复线索">
          <p className="text-sm text-muted-foreground">仅记录人工判断,不自动退回、合并账号或改变归属。</p>
          {detail.duplicateHints.map((hint) => (
            <p key={hint.id} className="text-sm">
              {hint.result === "DISTINCT" ? "已判断为不同账号" : hint.result === "POSSIBLE_SAME" ? "可能为同一账号" : "待核对"}:
              {hint.reason}
            </p>
          ))}
          <label className="block space-y-2 text-sm">
            关联队列中的另一个账号
            <SupplySelect label="关联队列中的另一个账号" value={related} onValueChange={onRelatedChange} disabled={busy} options={[{ value: "", label: "请选择同游戏账号" }, ...queueItems.filter(item => item.id !== detail.account.id && item.game_id === detail.account.game_id).map(item => ({ value: item.id, label: (item.title || "未命名资料") + " · " + item.owner_name }))]}/>

          </label>
          {media.length === 0 ? (
            <p className="text-xs text-muted-foreground">记录线索需要至少一张账号图片作为证据。</p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !related || media.length === 0}
            onClick={onRecordDuplicate}
          >
            记录关联线索
          </Button>
        </Section>
      ) : null}

      <Section
        title="历史与审核记录"
        aside={
          detail.history && detail.history.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {detail.history.map((entry) => (
                <Button variant="ghost"
                  key={entry.id}
                  type="button"
                  aria-pressed={versionId === entry.id}
                  onClick={() => onSelectVersion(entry.id)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    versionId === entry.id
                      ? "border-foreground bg-foreground font-medium text-background"
                      : "border-border bg-surface-raised text-muted-foreground hover:text-foreground"
                  }`}
                >
                  第 {entry.sequence} 版 · {reviewStateLabel(entry.review_state)}
                </Button>
              ))}
            </div>
          ) : null
        }
      >
        {directPublish ? (
          <p className="text-sm text-muted-foreground">
            直发账号无人工预审记录；发布来源与时间可在“账号资料”的报价与发布事实中查看。
          </p>
        ) : null}
        {detail.decisions.length === 0 && !directPublish ? (
          <p className="text-sm text-muted-foreground">尚无审核决定。</p>
        ) : null}
        {detail.decisions.length > 0 ? (
          <ol className="space-y-0">
            {detail.decisions.map((decision) => (
              <li key={decision.id} className="relative ml-1.5 border-l border-border pb-4 pl-5 last:pb-0">
                <span
                  className={`absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full ${
                    decision.decision === "APPROVE" ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                />
                <p className="text-sm font-medium">
                  {decision.decision === "APPROVE" ? "通过(历史人工审核)" : "退回"} · {decision.reviewer_name}
                </p>
                <p className="text-xs text-muted-foreground">{formatDate(decision.decided_at)}</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{decision.reason}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </Section>
      </TabsContent>
    </Tabs>
  );
}
