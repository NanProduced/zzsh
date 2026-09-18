import { useCallback, useEffect, useState } from "react";
import {
  AdminApiError,
  adminRequest,
  friendlyError,
  hasPermission,
  type SessionSnapshot,
} from "../api";
import { Button, StatusMessage } from "../components/ui-elements";
type QueueItem = {
  id: string;
  game_id: string;
  title: string | null;
  owner_name: string;
  game_name: string;
  review_state: string;
  sequence: string;
  owner_paused: boolean;
  staff_restricted: boolean;
};
type Declaration = {
  attributes: Record<string, unknown>;
  title: string;
  description: string | null;
  inventory: Array<{
    itemId: string;
    quantity: string | null;
  }>;
  skins: string[];
  entitlements: Array<{
    entitlementId: string;
    value: unknown;
    expiresAt: string | null;
  }>;
  mediaBindings: Array<{
    assetId: string;
    purpose: string;
    position: number;
  }>;
};
type CodeDisplay = {
  code: string;
  displayName: string | null;
  mappingStatus: "CONFIRMED" | "UNCONFIRMED";
  issueCode: string | null;
};
type AttributeDisplay = {
  safeBox: CodeDisplay | null;
  grading: CodeDisplay | null;
  loginMethod: CodeDisplay | null;
  serviceWindow: {
    startMinute: number;
    endMinute: number;
    displayName: string;
  } | null;
};
type Detail = {
  account: {
    id: string;
    game_id: string;
    revision: string;
    owner_paused: boolean;
    staff_restricted: boolean;
    restriction_reason: string | null;
  };
  ownerName: string;
  version: {
    id: string;
    sequence: string;
    reviewState: string;
    releaseId: string | null;
    contentHash: string | null;
    safeBox?: { code: string; displayName: string | null } | null;
    termOption?: { code: string; displayName: string | null; dailyConsumption: { quantity: string; unit: "HAFF_BASE" } | null } | null;
    attributeDisplay?: AttributeDisplay;
    declaration: Declaration;
    presentation: {
      items?: Array<{
        id: string;
        name: string;
        unit: string;
      }>;
      skins?: Array<{
        id: string;
        name: string;
        categoryCode?: string;
        categoryName?: string;
      }>;
      entitlements?: Array<{
        id: string;
        name: string;
      }>;
    };
    quote: {
      resourceTotal: {
        amount: string;
      };
      termSeconds: string;
    } | null;
  };
  previousDeclaration: Declaration | null;
  previousPresentation?: {
    items?: Array<{
      id: string;
      name: string;
    }>;
    skins?: Array<{
      id: string;
      name: string;
    }>;
  };
  decisions: Array<{
    id: string;
    decision: string;
    reason: string;
    reviewer_name: string;
    decided_at: string;
  }>;
  duplicateHints: Array<{
    id: string;
    result: string;
    reason: string;
  }>;
  blockers: string[];
  available: boolean;
};
const states: Record<string, string> = {
  SUBMITTED: "待审核",
  APPROVED: "已通过",
  REJECTED: "已退回",
  WITHDRAWN: "已撤回",
  DRAFT: "草稿",
  IMPORTED_UNVERIFIED: "历史待核实",
};
const fieldClass =
  "w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const failMessage = (error: unknown) =>
  error instanceof AdminApiError && error.status === 409
    ? "这份资料或规则已变化，请刷新详情后重新核对。"
    : friendlyError(error);
export function SupplyListingReviewView({
  snapshot,
  refreshNonce,
  onDirtyChange,
}: {
  snapshot: Extract<
    SessionSnapshot,
    {
      authenticated: true;
    }
  >;
  refreshNonce: number;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [after, setAfter] = useState(""),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState("SUBMITTED"),
    [items, setItems] = useState<QueueItem[]>([]),
    [selected, setSelected] = useState<string>(),
    [detail, setDetail] = useState<Detail>(),
    [reason, setReason] = useState(""),
    [related, setRelated] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [success, setSuccess] = useState<string>();
  const canDecide = hasPermission(snapshot, "supply.review.decide"),
    canRestrict = hasPermission(snapshot, "supply.restrict"),
    canDuplicate = hasPermission(snapshot, "supply.duplicate.review");
  const loadQueue = useCallback(async () => {
    const r = await adminRequest<{
      items: QueueItem[];
      nextCursor: string | null;
    }>(
      `/supply/listing-reviews?state=${state}&limit=100&after=${encodeURIComponent(after)}`,
    );
    setItems(r.items);
    setNextCursor(r.nextCursor);
  }, [state, after]);
  useEffect(() => {
    void loadQueue().catch((e) => setError(failMessage(e)));
  }, [loadQueue, refreshNonce]);
  useEffect(() => {
    let active = true;
    if (!selected) {
      setDetail(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    void adminRequest<Detail>(`/supply/listing-reviews/${selected}`)
      .then((d) => {
        if (active) setDetail(d);
      })
      .catch((e) => {
        if (active) setError(failMessage(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [selected, refreshNonce]);
  useEffect(() => {
    onDirtyChange(Boolean(reason.trim()));
    return () => onDirtyChange(false);
  }, [reason, onDirtyChange]);
  const refresh = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setDetail(
        await adminRequest<Detail>(`/supply/listing-reviews/${selected}`),
      );
      await loadQueue();
      setError(undefined);
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const act = async (
    action: string,
    values: Record<string, unknown>,
    message: string,
  ) => {
    if (!detail) return;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await adminRequest<Detail>(
        `/supply/listing-reviews/${detail.account.id}/${action}`,
        { expectedRevision: detail.account.revision, reason, ...values },
      );
      setDetail(
        action === "duplicates"
          ? await adminRequest<Detail>(
              `/supply/listing-reviews/${detail.account.id}`,
            )
          : { ...detail, ...result },
      );
      setReason("");
      setSuccess(message);
      await loadQueue();
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const decide = (decision: "APPROVE" | "REJECT") => {
    if (!detail) return;
    void act(
      "decide",
      {
        versionId: detail.version.id,
        releaseId: detail.version.releaseId,
        contentHash: detail.version.contentHash,
        decision,
      },
      decision === "APPROVE"
        ? "审核已通过。号主主动暂停或其他限制仍会保留。"
        : "资料已退回，号主可查看具体原因并重新提交。",
    );
  };
  const version = detail?.version,
    old = detail?.previousDeclaration;
  const nameOf = (id: string) =>
    version?.presentation.items?.find((i) => i.id === id)?.name ??
    detail?.previousPresentation?.items?.find((i) => i.id === id)?.name ??
    "历史物品";
  const codeText = (label: CodeDisplay | null | undefined, raw: unknown) => {
    if (label?.displayName) return label.displayName;
    const code = label?.code ?? (raw === null || raw === undefined || raw === "" ? "" : String(raw));
    return code ? `未确认（代码 ${code}）` : "未申报";
  };
  const quantityText = (value: string | null | undefined) => {
    if (!value || !/^\d+$/.test(value)) return "未确认";
    const amount = BigInt(value);
    const millions = amount / 1_000_000n;
    const remainder = amount % 1_000_000n;
    return remainder === 0n ? `${millions} M 哈夫币` : `${millions}.${remainder.toString().padStart(6, "0").replace(/0+$/, "")} M 哈夫币`;
  };
  const attributeFacts = version
    ? [
        ["安全箱配置", codeText(version.attributeDisplay?.safeBox, version.declaration.attributes.safe_box_code)],
        ["体力等级", version.declaration.attributes.vit_level === null || version.declaration.attributes.vit_level === undefined ? "未申报" : `${version.declaration.attributes.vit_level} 级`],
        ["负重等级", version.declaration.attributes.bear_level === null || version.declaration.attributes.bear_level === undefined ? "未申报" : `${version.declaration.attributes.bear_level} 级`],
        ["潜水等级", version.declaration.attributes.dive_level === null || version.declaration.attributes.dive_level === undefined ? "未申报" : `${version.declaration.attributes.dive_level} 级`],
        ["角色等级", version.declaration.attributes.character_level === null || version.declaration.attributes.character_level === undefined ? "未申报" : `${version.declaration.attributes.character_level} 级`],
        ["段位", codeText(version.attributeDisplay?.grading, version.declaration.attributes.grading_code)],
        ["登录方式", codeText(version.attributeDisplay?.loginMethod, version.declaration.attributes.login_method_code)],
        ["绝密 KD", String(version.declaration.attributes.secret_kd ?? "未申报")],
        ["地区", [version.declaration.attributes.region_province, version.declaration.attributes.region_city].filter((value) => value !== null && value !== undefined && value !== "").join(" · ") || "未申报"],
        ["上号时间", version.attributeDisplay?.serviceWindow?.displayName ?? "未确认"],
        ["租期规则", version.termOption?.displayName ?? (version.termOption ? `未确认（代码 ${version.termOption.code}）` : "未申报")],
        ["每日消耗", quantityText(version.termOption?.dailyConsumption?.quantity)],
      ]
    : [];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">供给审核</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            核对号主本次申报、与上一版的变化和图片资料。通过审核不代表平台已登录游戏验号。
          </p>
        </div>
        <label className="space-y-1 text-sm">
          查看状态
          <select
            aria-label="供给审核状态"
            className={fieldClass}
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setAfter("");
            }}
          >
            {Object.entries(states).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <StatusMessage error={error} success={success} />
      <div className="grid items-start gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside
          aria-label="供给审核队列"
          className="overflow-hidden rounded-lg border border-border"
        >
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            {states[state]} · {items.length} 份
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground">
              当前范围没有{states[state]}的资料。可切换状态查看已处理记录。
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        reason.trim() &&
                        !window.confirm(
                          "切换资料会丢弃尚未提交的理由，继续吗？",
                        )
                      )
                        return;
                      setSelected(item.id);
                      setReason("");
                      setSuccess(undefined);
                    }}
                    aria-pressed={selected === item.id}
                    className={`w-full px-4 py-4 text-left transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected === item.id ? "bg-surface-raised" : ""}`}
                  >
                    <span className="block text-sm font-medium break-words">
                      {item.title || "未命名草稿"}
                    </span>
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {item.owner_name} · {item.game_name} · 第 {item.sequence}{" "}
                      版
                    </span>
                    {item.owner_paused || item.staff_restricted ? (
                      <span className="mt-2 block text-xs">
                        {item.owner_paused ? "号主已暂停" : "客服限制中"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2 border-t border-border p-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={!after}
              onClick={() => setAfter("")}
            >
              回到首页
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!nextCursor}
              onClick={() => setAfter(nextCursor!)}
            >
              下一页
            </Button>
          </div>
        </aside>
        {!detail || !version ? (
          <section
            className="py-16 text-center text-sm text-muted-foreground"
            aria-live="polite"
          >
            {busy ? "正在读取资料…" : "选择一份资料，查看申报变化和审核记录。"}
          </section>
        ) : (
          <article className="min-w-0 space-y-6" aria-busy={busy}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold break-words">
                  {version.declaration.title || "未命名草稿"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {detail.ownerName} · 第 {version.sequence} 版 ·{" "}
                  {states[version.reviewState]}
                </p>
                <p className="mt-2 text-sm">
                  {detail.account.owner_paused
                    ? "号主已暂停接单，审核通过后仍保持暂停。"
                    : detail.account.staff_restricted
                      ? "客服限制中，号主不能自行恢复。"
                      : detail.available
                        ? "当前可公开接单"
                        : "当前暂不接单"}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void refresh()}
                disabled={busy}
              >
                刷新详情
              </Button>
            </div>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">本次资料与变化</h3>
              {!old ? (
                <p className="text-sm text-muted-foreground">
                  首次申报，暂无已通过版本可对比。
                </p>
              ) : null}
              {old ? (
                <div className="grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <p className="font-medium">上次通过的说明</p>
                    <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                      {old.title}
                      <br />
                      {old.description || "未填写补充说明"}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">本次提交的说明</p>
                    <p className="mt-1 whitespace-pre-wrap">
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
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {attributeFacts.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="mt-1">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-raised">
                    <tr>
                      <th className="px-4 py-3 font-medium">物品</th>
                      <th className="px-4 py-3 font-medium">上一版</th>
                      <th className="px-4 py-3 font-medium">本次申报</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...new Set([
                        ...version.declaration.inventory.map((i) => i.itemId),
                        ...(old?.inventory.map((i) => i.itemId) ?? []),
                      ]),
                    ].map((id) => {
                      const item = version.declaration.inventory.find(
                        (i) => i.itemId === id,
                      );
                      const previous = old?.inventory.find(
                        (i) => i.itemId === id,
                      )?.quantity;
                      return (
                        <tr key={id} className="border-t border-border">
                          <td className="px-4 py-3">
                            {nameOf(id)}
                            <span className="mt-1 block text-xs text-muted-foreground">
                              单位：
                              {version.presentation.items?.find(
                                (i) => i.id === id,
                              )?.unit === "HAFF_BASE"
                                ? "哈夫币"
                                : version.presentation.items?.find(
                                      (i) => i.id === id,
                                )?.unit === "ROUND"
                                  ? "发"
                                  : version.presentation.items?.find(
                                        (i) => i.id === id,
                                      )?.unit === "DAY"
                                    ? "天"
                                    : "件"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground tabular-nums">
                            {previous === undefined
                              ? "未申报"
                              : previous === null
                                ? "数量未知"
                                : BigInt(previous).toLocaleString("zh-CN")}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {!item
                              ? "本次未申报"
                              : item.quantity === null
                                ? "数量未知"
                                : BigInt(item.quantity).toLocaleString("zh-CN")}
                            {previous !== undefined &&
                            previous !== item?.quantity ? (
                              <span className="ml-2 text-xs">已变化</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-muted-foreground">
                皮肤：
                {version.presentation.skins?.map((s) => s.categoryName ? `${s.categoryName} · ${s.name}` : s.name).join("、") ||
                  "未申报"}
              </p>
              {version.declaration.entitlements.length ? (
                <ul className="space-y-2 text-sm">
                  {version.declaration.entitlements.map((e) => (
                    <li key={e.entitlementId}>
                      {version.presentation.entitlements?.find(
                        (p) => p.id === e.entitlementId,
                      )?.name ?? "历史权益"}
                      ：
                      {typeof e.value === "boolean"
                        ? e.value
                          ? "已声明持有"
                          : "未持有"
                        : String(e.value ?? "未知")}{" "}
                      ·{" "}
                      {e.expiresAt
                        ? `到期 ${new Date(e.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
                        : "未声明到期时间"}
                    </li>
                  ))}
                </ul>
              ) : null}
              {version.quote ? (
                <p className="text-sm">
                  租客资源报价{" "}
                  <strong className="tabular-nums">
                    ¥{version.quote.resourceTotal.amount}
                  </strong>{" "}
                  · 租期{" "}
                  {(BigInt(version.quote.termSeconds) / 86400n).toString()} 天
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  尚无有效报价，不能提交审核。
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                旧来源租金、物品费、押金与比例只作受限证据，不等同于当前服务端报价；未映射的复杂权益不按 0 处理。
              </p>
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">申报图片</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {version.declaration.mediaBindings.map((m, index) => (
                  <figure key={m.assetId}>
                    <a
                      href={`/api/bff/admin/supply/media/${m.assetId}/content`}
                      target="_blank"
                      rel="noreferrer"
                      className="block overflow-hidden rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <img
                        src={`/api/bff/admin/supply/media/${m.assetId}/content`}
                        alt={`${m.purpose === "ACCOUNT_DISPLAY" ? "展示图" : "私有审核凭证"} ${index + 1}`}
                        className="aspect-[4/3] w-full object-contain bg-surface-raised"
                      />
                    </a>
                    <figcaption className="mt-2 text-xs text-muted-foreground">
                      {m.purpose === "ACCOUNT_DISPLAY"
                        ? "展示图"
                        : "私有审核凭证"}{" "}
                      · {index + 1}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
            <section className="space-y-3 border-t border-border pt-5">
              <h3 className="text-sm font-semibold">处理这份资料</h3>
              <label className="block space-y-2 text-sm">
                <span>处理理由</span>
                <textarea
                  className={`${fieldClass} min-h-24`}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="请写明核对结论，或号主需要补充、修正的内容。"
                />
              </label>
              <div className="flex flex-wrap gap-3">
                {canDecide && version.reviewState === "SUBMITTED" ? (
                  <>
                    <Button
                      onClick={() => decide("APPROVE")}
                      disabled={busy || reason.trim().length < 2}
                    >
                      通过审核
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => decide("REJECT")}
                      disabled={busy || reason.trim().length < 2}
                    >
                      退回补充
                    </Button>
                  </>
                ) : null}
                {canRestrict ? (
                  <Button
                    variant="secondary"
                    disabled={busy || reason.trim().length < 2}
                    onClick={() =>
                      void act(
                        "restriction",
                        { restricted: !detail.account.staff_restricted },
                        detail.account.staff_restricted
                          ? "限制已解除，号主暂停和其他条件保持不变。"
                          : "已限制接单，原资料与记录保留。",
                      )
                    }
                  >
                    {detail.account.staff_restricted ? "解除限制" : "限制接单"}
                  </Button>
                ) : null}
              </div>
            </section>
            {canDuplicate ? (
              <section className="space-y-3 border-t border-border pt-5">
                <h3 className="text-sm font-semibold">疑似重复线索</h3>
                <p className="text-sm text-muted-foreground">
                  仅记录人工判断，不自动退回、合并账号或改变归属。
                </p>
                {detail.duplicateHints.map((h) => (
                  <p key={h.id} className="text-sm">
                    {h.result === "DISTINCT"
                      ? "已判断为不同账号"
                      : h.result === "POSSIBLE_SAME"
                        ? "可能为同一账号"
                        : "待核对"}
                    ：{h.reason}
                  </p>
                ))}
                <label className="block space-y-2 text-sm">
                  关联队列中的另一份资料
                  <select
                    className={fieldClass}
                    value={related}
                    onChange={(e) => setRelated(e.target.value)}
                  >
                    <option value="">请选择同游戏资料</option>
                    {items
                      .filter(
                        (i) =>
                          i.id !== detail.account.id &&
                          i.game_id === detail.account.game_id,
                      )
                      .map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.title || "未命名资料"} · {i.owner_name}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    busy ||
                    !related ||
                    reason.trim().length < 2 ||
                    !version.declaration.mediaBindings.length
                  }
                  onClick={() =>
                    void act(
                      "duplicates",
                      {
                        relatedAccountId: related,
                        result: "POSSIBLE_SAME",
                        evidenceRef:
                          "asset:" +
                          version.declaration.mediaBindings[0]!.assetId,
                      },
                      "线索已记录，供客服继续核对。",
                    )
                  }
                >
                  记录关联线索
                </Button>
              </section>
            ) : null}
            <section className="space-y-3 border-t border-border pt-5">
              <h3 className="text-sm font-semibold">审核记录</h3>
              {detail.decisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">尚无审核决定。</p>
              ) : (
                <ol className="space-y-3">
                  {detail.decisions.map((d) => (
                    <li key={d.id} className="text-sm">
                      <p className="font-medium">
                        {d.decision === "APPROVE" ? "通过" : "退回"} ·{" "}
                        {d.reviewer_name}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {d.reason}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </article>
        )}
      </div>
    </div>
  );
}
