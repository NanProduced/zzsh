import type { ReactNode } from "react";

import { formatDate } from "../../api";
import { Button } from "../../components/ui-elements";
import {
  attributeFacts,
  availabilityText,
  effectiveRentable,
  blockerLabel,
  formatAmount,
  formatTermDays,
  inventoryRows,
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
  type MediaBinding,
  type QueueItem,
  type ZoomTarget,
} from "./model";

const fieldClass =
  "w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function stateBadgeClass(state: string): string {
  if (state === "PUBLISHED") return "border-border text-muted-foreground";
  if (state === "APPROVED") return "border-border text-muted-foreground";
  if (state === "SUBMITTED" || state === "IMPORTED_UNVERIFIED") return "border-border text-warning";
  if (state === "REJECTED") return "border-border text-danger";
  return "border-border text-muted-foreground";
}

function StateBadge({ state }: { state: string }) {
  return (
    <span className={`inline-flex rounded border px-1.5 py-0.5 text-xs ${stateBadgeClass(state)}`}>
      {reviewStateLabel(state)}
    </span>
  );
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
  onZoom: (target: ZoomTarget) => void;
  onQuarantine: (assetId: string) => void;
  onRestore: (assetId: string) => void;
}) {
  const evidence = binding.purpose !== "ACCOUNT_DISPLAY";
  const label = mediaPurposeLabel(binding);
  const caption = evidence ? `${label} · 仅审核可见,始终不公开` : label;
  const quarantined = binding.reviewState === "QUARANTINED";
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        aria-label={`放大核对 ${caption} ${index + 1}`}
        className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() =>
          onZoom({
            src: mediaContentUrl(binding.assetId),
            alt: `${caption} ${index + 1}`,
            caption: `${caption} · ${index + 1} / ${total}`,
          })
        }
      >
        <img
          src={mediaContentUrl(binding.assetId)}
          alt={`${caption} ${index + 1}`}
          loading="lazy"
          className="aspect-[4/3] w-full bg-surface-raised object-contain"
        />
      </button>
      <figcaption className="space-y-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={evidence ? "text-warning" : ""}>{caption} · {index + 1}</span>
          <span className="text-foreground">放大核对</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded border border-border px-1 py-0.5 ${quarantined ? "text-danger" : ""}`}>
            {mediaReviewLabel(binding)}
          </span>
          <span className="rounded border border-border px-1 py-0.5">{mediaEligibleLabel(binding)}</span>
          <span className="rounded border border-border px-1 py-0.5">{mediaReadableLabel(binding)}</span>
        </div>
        {!evidence && canReviewMedia && !readOnly && (mediaCanQuarantine(binding) || mediaCanRestore(binding)) ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {mediaCanQuarantine(binding) ? (
              <Button
                size="sm"
                variant="danger"
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
                variant="secondary"
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
  onZoom: (target: ZoomTarget) => void;
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
    <div className="supervision-detail-body">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-semibold">{version.declaration.title || "未命名资料"}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>
              {detail.ownerName} · {version.sequence ? `第 ${version.sequence} 版` : ""}
            </span>
            <StateBadge state={version.reviewState} />
          </p>
          <p className={`mt-4 text-sm font-medium ${effectiveRentable(detail) ? "text-success" : "text-warning"}`} role="status">
            {effectiveRentable(detail) ? availabilityText(detail) : `当前不可租 · ${availabilityText(detail).replace("当前不可租(存在阻塞项)", "存在阻塞项")}`}
          </p>
          {detail.account.staff_restricted && detail.account.restriction_reason ? (
            <p className="mt-2 text-xs text-danger">限制原因:{detail.account.restriction_reason}</p>
          ) : null}
          {detail.blockers.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="当前阻塞项">
              {detail.blockers.filter(code => !(code === "OWNER_PAUSED" && detail.account.owner_paused) && !(code === "STAFF_RESTRICTED" && detail.account.staff_restricted) && code !== "HISTORICAL_VERSION").map((code) => (
                <li key={code} className="rounded border border-border px-1.5 py-0.5 text-xs text-warning">
                  {blockerLabel(code)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">{actions}<Button variant="secondary" size="sm" onClick={onRefresh} loading={refreshing} disabled={loading}>
          刷新详情
        </Button></div>
      </header>

      {historical ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-soft-warning px-3 py-2 text-xs text-warning">
          <span>正在查看历史版本(只读)。事后操作只对当前版本开放。</span>
          <Button size="sm" variant="secondary" onClick={() => onSelectVersion(null)}>
            回到当前版本
          </Button>
        </div>
      ) : null}

      <div className="supervision-detail-tabs" role="tablist" aria-label="账号详情分组" onKeyDown={event => {
        const keys = ["data", "media", "history"] as const;
        const index = keys.indexOf(tab);
        const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
        if (next < 0 || event.nativeEvent.isComposing) return;
        event.preventDefault(); onTabChange(keys[next]!);
        event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
      }}>
        {([ ["data", "账号资料"], ["media", "图片与凭证"], ["history", "历史与记录"] ] as const).map(([key, label]) => <button key={key} type="button" role="tab" id={`supervision-tab-${key}`} aria-controls={`supervision-panel-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onClick={() => onTabChange(key)}>{label}</button>)}
      </div>
      <div role="tabpanel" id="supervision-panel-data" aria-labelledby="supervision-tab-data" hidden={tab !== "data"} className="supervision-sections">
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
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-raised">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">物品</th>
                {previous && <th scope="col" className="px-4 py-2.5 font-medium">上一版</th>}
                <th scope="col" className="px-4 py-2.5 font-medium">{previous ? "当前版本" : "申报数量"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr className="border-t border-border">
                  <td className="px-4 py-3 text-muted-foreground" colSpan={previous ? 3 : 2}>
                    未申报资源数量。
                  </td>
                </tr>
              ) : null}
              {rows.map((row) => (
                <tr key={row.itemId} className={`border-t border-border ${previous && row.changed ? "bg-muted/30" : ""}`}>
                  <td className="px-4 py-3">
                    {row.name}
                    <span className="mt-1 block text-xs text-muted-foreground">单位:{row.unit}</span>
                  </td>
                  {previous && <td className="px-4 py-3 tabular-nums text-muted-foreground">{row.previous}</td>}
                  <td className="px-4 py-3 tabular-nums">
                    {row.current}
                    {previous && row.changed ? (
                      <span className="ml-2 rounded border border-border px-1 text-xs text-foreground">已变化</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

      <details className="supervision-quote"><summary>查看报价、租期与发布事实</summary>
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
          <dt className="text-xs text-muted-foreground">租客资源报价</dt>
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
            {releaseGeneration ? `第 ${releaseGeneration} 代` : version.releaseId ? "已绑定" : "未绑定"}
          </dd>
        </div>
      </dl>
      {version.quote ? (
        <p className="-mt-4 text-xs text-muted-foreground">
          租期 {formatTermDays(version.quote.termSeconds)} · 每日消耗 {quantityText(version.termOption?.dailyConsumption?.quantity)} · 当前公开价不等同已成立订单的冻结价
        </p>
      ) : null}

      </details>
      </div>
      <div role="tabpanel" id="supervision-panel-media" aria-labelledby="supervision-tab-media" hidden={tab !== "media"} className="supervision-sections">
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

      </div>
      <div role="tabpanel" id="supervision-panel-history" aria-labelledby="supervision-tab-history" hidden={tab !== "history"} className="supervision-sections">
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
            <select className={fieldClass} value={related} onChange={(event) => onRelatedChange(event.target.value)}>
              <option value="">请选择同游戏账号</option>
              {queueItems
                .filter((item) => item.id !== detail.account.id && item.game_id === detail.account.game_id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title || "未命名资料"} · {item.owner_name}
                  </option>
                ))}
            </select>
          </label>
          {media.length === 0 ? (
            <p className="text-xs text-muted-foreground">记录线索需要至少一张账号图片作为证据。</p>
          ) : null}
          <Button
            variant="secondary"
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
                <button
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
                </button>
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
      </div>
    </div>
  );
}
