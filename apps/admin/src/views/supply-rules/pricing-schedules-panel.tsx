import { useEffect, useRef, useState } from "react";
import { adminRequest, friendlyError, hasPermission, type PricingModel, type PricingSchedules, type RulesResponse, type SchedulePriceOptions, type SessionSnapshot } from "../../api";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { agreementDiff, fixedFeePercent, priceDiff, termDiff } from "./rules-model";
import { beijingLocalToIso, formatBeijing } from "../../lib/audit-labels";
import { isPricingScheduleOperation, pricingSchedulesPath, ruleChangeCommand, ruleChangesPath, type useRulesWrite } from "./rules-write";
import { useMembershipApprovalRequest } from "../membership-benefits-approval";

const modelLabel: Record<PricingModel, string> = { FIXED_FEE: "固定手续费", SPREAD: "价差" };
const modeOptions = [{ value: "price", label: "统一核对规则改动" }, { value: "mode", label: "申请切换计价模式" }];
type RuleChangeRow = { id: string; effectiveAt: string; status: "SCHEDULED" | "EFFECTIVE" | "VOIDED";
  announcementVersionId: string; createdByAdminId: string; voidReason: string | null;
  change: { pricingModel: PricingModel; previousPriceVersionId?: string; previousFundingVersionId?: string; previousTermVersionId?: string; previousAgreementVersionId?: string;
    price?: { version: { id: string } } | null; combination?: { funding: { id: string }; term: { id: string }; agreement: { id: string } } | null } };

export function PricingSchedulesPanel({ gameId, active, canSchedule, command, snapshot, rules }: {
  gameId: string;
  active: boolean;
  canSchedule: boolean;
  command: ReturnType<typeof useRulesWrite>;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  rules: RulesResponse;
}) {
  const approval = useMembershipApprovalRequest(snapshot, "pricing");
  const canRequest = hasPermission(snapshot, "supply.rules.edit") && hasPermission(snapshot, "approval.request.create");
  const [state, setState] = useState<{ data?: PricingSchedules; error?: string }>({});
  const [refresh, setRefresh] = useState(0);
  const [kind, setKind] = useState<"price" | "mode">(canSchedule ? "price" : "mode");
  const [model, setModel] = useState<PricingModel>("FIXED_FEE");
  const [priceId, setPriceId] = useState("");
  const [optionPages, setOptionPages] = useState<(SchedulePriceOptions & { model: PricingModel })>();
  const [pageAfter, setPageAfter] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string>();
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [announcementId, setAnnouncementId] = useState("");
  const [localTime, setLocalTime] = useState("");
  const [review, setReview] = useState(false);
  const reviewedPayload = useRef<string | null>(null);
  const [timeError, setTimeError] = useState("");
  const [fundingId, setFundingId] = useState("");
  const [termId, setTermId] = useState("");
  const [agreementId, setAgreementId] = useState("");
  const [changes, setChanges] = useState<{ items: RuleChangeRow[]; truncated?: boolean; error?: string }>({ items: [] });
  const [voiding, setVoiding] = useState<{ id: string; reason: string }>();
  const conflictRead = useRef(0);
  const completed = command.state.kind === "done" && (isPricingScheduleOperation(command.state.operation) || command.state.operation.startsWith("supply.rules.rule_change_batch."))
    ? `${command.state.operation}:${command.state.receipt.id}` : undefined;

  useEffect(() => {
    if (!active) return;
    const request = new AbortController();
    setState({});
    void adminRequest<PricingSchedules>(pricingSchedulesPath(gameId), undefined, "GET", {}, request.signal).then(
      data => { if (!request.signal.aborted) setState({ data }); },
      error => { if (!request.signal.aborted) setState({ error: friendlyError(error) }); },
    );
    return () => request.abort();
  }, [active, gameId, refresh, completed]);
  useEffect(() => {
    if (!active) return;
    const request = new AbortController();
    void adminRequest<{ items: RuleChangeRow[]; truncated: boolean }>(ruleChangesPath(gameId), undefined, "GET", {}, request.signal).then(
      result => { if (!request.signal.aborted) setChanges(result); },
      error => { if (!request.signal.aborted) setChanges({ items: [], error: friendlyError(error) }); },
    );
    return () => request.abort();
  }, [active, gameId, refresh, completed]);
  useEffect(() => {
    if (!completed) return;
    setReview(false);
    setPriceId("");
    setAnnouncementId("");
    setLocalTime("");
    setTimeError("");
    setFundingId("");
    setTermId("");
    setAgreementId("");
    setVoiding(undefined);
  }, [completed]);

  const data = state.data;
  const schedules = data?.available ? data : null;
  const blockedByConflict = command.state.kind === "conflict" && refresh <= conflictRead.current;
  const readOptions = active && Boolean(schedules) && (kind === "price" ? canSchedule : canRequest);
  useEffect(() => {
    if (!readOptions) return;
    const request = new AbortController();
    const query = new URLSearchParams({ pricingModel: model, ...(pageAfter ? { cursor: pageAfter } : {}) });
    setLoadingOptions(true);
    setOptionsError(undefined);
    void adminRequest<SchedulePriceOptions>(`/supply/games/${encodeURIComponent(gameId)}/pricing-schedule-price-options?${query}`,
      undefined, "GET", {}, request.signal).then(page => {
      if (request.signal.aborted) return;
      setOptionPages(previous => {
        const items = pageAfter && previous?.model === model ? previous.items : [];
        return { model, items: [...items, ...page.items.filter(item => !items.some(existing => existing.id === item.id))], nextCursor: page.nextCursor };
      });
    }).catch(error => {
      if (!request.signal.aborted) setOptionsError(friendlyError(error));
    }).finally(() => {
      if (!request.signal.aborted) setLoadingOptions(false);
    });
    return () => request.abort();
  }, [readOptions, gameId, model, pageAfter, refresh, optionsRetry]);
  const prices = optionPages?.model === model ? optionPages.items : [];
  const drafts = rules.priceVersions.filter(version => version.status === "DRAFT" &&
    (model === "FIXED_FEE" ? Boolean(version.fixedFeeRates) : version.mode === "SPREAD" && !version.fixedFeeRates));
  const price = [...drafts.map(version => ({ ...version, sealedAt: version.sealedAt ?? "" })), ...prices].find(version => version.id === priceId);
  const release = rules.release;
  const fundingSource = rules.priceVersions.find(version => version.id === (fundingId || release?.priceVersionId));
  const termSource = rules.termVersions.find(version => version.id === (termId || release?.termVersionId));
  const agreementSource = rules.agreementVersions.find(version => version.id === (agreementId || release?.agreementVersionId));
  const ref = (version: { id: string; revision: string }) => ({ id: version.id, revision: version.revision });
  const combinationSelected = Boolean(fundingId || termId || agreementId);
  const early = rules.ruleScheduling?.earlySettlement;
  const combination = combinationSelected && fundingSource && termSource && agreementSource && early ? {
    funding: ref(fundingSource), term: ref(termSource), agreement: ref(agreementSource), earlySettlement: early,
  } : null;
  const rows = [
    ...(price ? priceDiff(rules, rules.newListingPrice?.priceVersionId ?? release?.priceVersionId, price.id) : []),
    ...(combination && release ? priceDiff(rules, release.priceVersionId, combination.funding.id).filter(row => row.group === "押金规则") : []),
    ...(combination && release ? termDiff(rules, release.termVersionId, combination.term.id) : []),
    ...(combination && release ? agreementDiff(rules, release.agreementVersionId, combination.agreement.id) : []),
  ];
  const announcement = schedules?.announcements.find(version => version.id === announcementId);
  const effectiveAt = beijingLocalToIso(localTime);
  const currentModel = schedules?.current?.pricingModel ?? (rules.newListingPrice?.pricingModel === "LEGACY_SPREAD" ? "SPREAD" : null);
  const canSubmit = Boolean(schedules && rules.ruleScheduling?.available && (kind === "price" ? canSchedule &&
    currentModel === model && (price || combination) && (!price || Boolean(schedules.current))
    : canRequest && !approval.busy && approval.pending.state === "absent" &&
    currentModel !== model && price)
    && !command.locked && !blockedByConflict
    && (!price || model === "FIXED_FEE" || schedules.spreadSchedulingEnabled)
    && (!combinationSelected || combination) && announcement && effectiveAt);
  const submit = () => {
    if (!canSubmit || !schedules || !rules.ruleScheduling) return;
    if (Date.parse(effectiveAt) <= Date.parse(schedules.asOf)) {
      setTimeError("请选择晚于当前时间的生效时间。");
      return;
    }
    const payload = { gameId, pricingModel: model, expectedModeGeneration: schedules.modeGeneration,
      expectedReleaseGeneration: rules.ruleScheduling.generation, effectiveAt, announcementVersionId: announcementId,
      ...(price ? { price: { version: ref(price), expectedGeneration: schedules.priceGenerations[model] } } : {}),
      ...(combination ? { combination } : {}) };
    const currentPayload = JSON.stringify(payload);
    if (!review) {
      reviewedPayload.current = currentPayload;
      setTimeError("");
      setReview(true);
      return;
    }
    if (reviewedPayload.current !== currentPayload) {
      setReview(false);
      setTimeError("规则已变化，请重新核对本次改动。");
      return;
    }
    conflictRead.current = refresh;
    setReview(false);
    if (kind === "mode") {
      void approval.submit({
        operationCode: "supply.rules.mode_switch", triggerCondition: "supply.rules.mode_switch.requested", payloadVersion: 1,
        summary: `切换计价模式为${modelLabel[model]}`,
        payload,
      });
      return;
    }
    void command.write(ruleChangeCommand(gameId, payload));
  };
  const reload = async () => {
    setReview(false);
    try {
      const fresh = await command.reloadRules();
      if (fresh?.game.id !== gameId) return;
    } catch (error) {
      setState({ error: friendlyError(error) });
      return;
    }
    setPageAfter(null);
    setOptionPages(undefined);
    setRefresh(n => n + 1);
  };

  return <section className="section-panel space-y-5" aria-label="调价排期">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-base font-semibold">调价排期</h3>
        <p className="mt-1 text-sm text-muted-foreground">价格计划仅用于生效后正式上架的账号。已上架账号和已有订单继续按各自确认的规则计价。</p>
        {data ? <p className="mt-1 text-xs text-muted-foreground">截至北京时间 {formatBeijing(data.asOf)}</p> : null}
      </div>
      <Button type="button" size="sm" variant="outline" disabled={command.locked || (!data && !state.error)} onClick={() => void reload()}>刷新排期</Button>
    </div>
    {state.error ? <p role="alert" className="text-sm text-destructive">排期读取失败。{state.error}</p> : null}
    {!data && !state.error ? <div aria-busy="true"><p className="sr-only">正在读取排期</p><Skeleton className="h-12 w-full" /></div> : null}
    {data?.available === false ? <p role="status" className="text-sm text-muted-foreground">{data.reason === "NOT_INSTALLED" ? "调价排期尚未安装。" : "调价排期配置不完整，暂时不可用。"}</p> : null}
    {schedules ? <>
      <p className="text-sm">当前新上架默认模式 <strong>{schedules.current ? modelLabel[schedules.current.pricingModel] : "尚未设置排期"}</strong>
        {schedules.current ? <span className="ml-2 break-all text-muted-foreground">价目 {schedules.current.priceVersionId}</span> : null}
      </p>
      {schedules.currentPrices.length ? <ul aria-label="当前各模式价目" className="space-y-1 text-sm text-muted-foreground">
        {schedules.currentPrices.map(row => <li key={row.id} className="break-all">{modelLabel[row.pricingModel]}价目 {row.priceVersionId}</li>)}
      </ul> : null}
      <div className="overflow-x-auto rounded-md border border-border">
        <Table aria-label="价格和默认模式计划">
          <TableHeader><TableRow><TableHead>计划</TableHead><TableHead>模式</TableHead><TableHead>价目</TableHead><TableHead>生效时间（北京时间）</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
          <TableBody>
            {!schedules.prices.length && !schedules.modes.length ? <TableRow><TableCell colSpan={5}>暂无排期</TableCell></TableRow> : null}
            {[...schedules.prices, ...schedules.modes].sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt)).map(row => {
              const current = row.id === schedules.current?.id || schedules.currentPrices.some(price => price.id === row.id);
              const future = row.effectiveAt > schedules.asOf;
              return <TableRow key={row.id}>
                <TableCell>{row.priceVersionId ? "价格" : "默认模式"} · 第 {row.generation} 版</TableCell>
                <TableCell>{modelLabel[row.pricingModel]}</TableCell>
                <TableCell className="break-all">{row.priceVersionId ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{formatBeijing(row.effectiveAt)}</TableCell>
                <TableCell>{current ? "当前使用" : future ? "待生效" : "已到生效时间"}{row.source === "SYSTEM_INITIAL" ? " · 系统初始化" : ""}</TableCell>
              </TableRow>;
            })}
          </TableBody>
        </Table>
      </div>
      {schedules.truncated ? <p className="text-sm text-muted-foreground">仅显示最近的 100 条价格计划和 100 条默认模式计划。</p> : null}
      {canSchedule || canRequest ? <form className="space-y-4 border-t border-border pt-4" onSubmit={event => { event.preventDefault(); submit(); }}>
        <h4 className="text-sm font-semibold">新增排期</h4>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="排期类型" composite>
            <SupplySelect label="排期类型" value={!canSchedule && kind === "price" ? "" : kind}
              options={modeOptions.map(option => ({ ...option, disabled: option.value === "price" ? !canSchedule : !canRequest }))} disabled={command.locked || review}
              onValueChange={value => { if (value === "price" || value === "mode") { setKind(value); setPriceId(""); setPageAfter(null); setOptionPages(undefined); } }} />
          </Field>
          <Field label="抽成模式" composite>
            <SupplySelect label="抽成模式" value={model} disabled={command.locked || review}
              options={[{ value: "FIXED_FEE", label: modelLabel.FIXED_FEE }, { value: "SPREAD", label: modelLabel.SPREAD, disabled: !schedules.spreadSchedulingEnabled }]}
              onValueChange={value => { if (value === "SPREAD" || value === "FIXED_FEE") { setModel(value); setPriceId(""); setPageAfter(null); setOptionPages(undefined); setOptionsError(undefined); } }} />
          </Field>
          {readOptions ? <Field label="计价与物资" composite required={kind === "mode"} hint={loadingOptions ? "正在读取价目…" : undefined}>
            <SupplySelect label="计价与物资" value={price ? priceId : ""} disabled={command.locked || review}
              options={[{ value: "", label: "不安排价目改动" },
                ...drafts.map(version => ({ value: version.id, label: `修改中 · ${formatBeijing(version.createdAt)}` })),
                ...prices.map(version => ({ value: version.id, label: `${version.id} · ${formatBeijing(version.sealedAt)}` }))]} onValueChange={setPriceId} />
          </Field> : null}
          {readOptions && (optionsError || (optionPages?.model === model && optionPages.nextCursor)) ? <div className="space-y-2 self-end">
            {optionsError ? <p role="alert" className="text-sm text-destructive">{optionsError}</p> : null}
            <Button type="button" size="sm" variant="outline" disabled={command.locked || review || loadingOptions}
              onClick={() => optionsError ? setOptionsRetry(n => n + 1) : setPageAfter(optionPages!.nextCursor)}>
              {optionsError ? "重试读取价目" : "加载更多封存价目"}
            </Button>
          </div> : null}
          <Field label="押金与包赔" composite>
            <SupplySelect label="押金与包赔" value={fundingId} disabled={command.locked || review}
              options={[{ value: "", label: "沿用当前规则" }, ...rules.priceVersions.filter(version => version.fundingPolicy && version.id !== release?.priceVersionId)
                .map(version => ({ value: version.id, label: `${version.fundingPolicy?.policyVersion} · ${formatBeijing(version.createdAt)}` }))]} onValueChange={setFundingId} />
          </Field>
          <Field label="租期档位" composite>
            <SupplySelect label="租期档位" value={termId} disabled={command.locked || review}
              options={[{ value: "", label: "沿用当前规则" }, ...rules.termVersions.filter(version => version.id !== release?.termVersionId)
                .map(version => ({ value: version.id, label: `${version.status === "DRAFT" ? "修改中" : "已封存"} · ${formatBeijing(version.createdAt)}` }))]} onValueChange={setTermId} />
          </Field>
          <Field label="出租协议" composite>
            <SupplySelect label="出租协议" value={agreementId} disabled={command.locked || review}
              options={[{ value: "", label: "沿用当前协议" }, ...rules.agreementVersions.filter(version => version.id !== release?.agreementVersionId)
                .map(version => ({ value: version.id, label: version.title }))]} onValueChange={setAgreementId} />
          </Field>
          <Field label="调价公告" composite required hint={!schedules.announcements.length ? "请先在「平台动态」发布适用于该游戏的公告，并确认公告已对用户可见。" : schedules.announcementsTruncated ? "仅显示最新 50 条当前可见公告。" : undefined}>
            <SupplySelect label="调价公告" value={announcement ? announcementId : ""} disabled={command.locked || review || !schedules.announcements.length}
              options={[{ value: "", label: "请选择已公开公告", disabled: true }, ...schedules.announcements.map(version => ({ value: version.id, label: `${version.title} · ${formatBeijing(version.publishedAt)}` }))]}
              onValueChange={setAnnouncementId} />
          </Field>
          <Field label="生效时间（北京时间）" required error={timeError || undefined}>
            <Input type="datetime-local" value={localTime} disabled={command.locked || review} required onChange={event => { setLocalTime(event.target.value); setTimeError(""); }} />
          </Field>
        </div>
        {kind === "price" && price?.fixedFeeRates ? <p className="text-sm text-muted-foreground">普通 {fixedFeePercent(price.fixedFeeRates.ordinary)} · 自定义 {fixedFeePercent(price.fixedFeeRates.custom)} · 极速 {fixedFeePercent(price.fixedFeeRates.fast)}</p> : null}
        {kind === "mode" ? <p className="text-sm text-muted-foreground">仅 Boss 可批准。批准后将目标价目和默认计价模式一起排期。</p> : null}
        {kind === "price" && currentModel === "SPREAD" && !schedules.current ? <p className="text-sm text-muted-foreground">历史价差仍随规则组合生效，调整价目请从规则总览安排组合。</p> : null}
        {approval.error ? <p role="alert" className="text-sm text-destructive">{approval.error}</p> : null}
        {approval.pending.state !== "absent" ? <Button type="button" variant="outline" disabled={approval.busy} onClick={() => void approval.recover()}>核对原审批请求</Button> : null}
        {approval.requestId && approval.detailStatus ? <p role="status">已提交审批，申请编号 {approval.requestId}</p> : null}
        {!schedules.spreadSchedulingEnabled ? <p className="text-sm text-muted-foreground">价差排期暂未开放。</p> : null}
        {review ? <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p>请核对公告正文与本次计划。{kind === "mode" ? "审批通过后按计划生效。" : ""}生效时间 {formatBeijing(effectiveAt)}。</p>
          <p className="break-words">{modelLabel[model]} · {priceId} · {announcement?.title}</p>
          {rows.length ? <ul className="space-y-1">{rows.map((row, index) => <li key={index}>{row.label} · {row.before} → {row.after}</li>)}</ul> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!canSubmit}>{kind === "mode" ? "提交审批" : "确认排期"}</Button>
            <Button type="button" variant="ghost" onClick={() => setReview(false)}>返回修改</Button>
          </div>
        </div> : <Button type="submit" disabled={!canSubmit}>核对排期</Button>}
      </form> : <p className="text-sm text-muted-foreground">排期由有规则生效权限的 Boss 提交。</p>}
      <div className="space-y-2 border-t border-border pt-4">
        <h4 className="text-sm font-semibold">整批变更记录</h4>
        {changes.error ? <p role="alert">{changes.error}</p> : null}
        {changes.truncated ? <p className="text-sm text-muted-foreground">显示最新 100 批变更。</p> : null}
        {changes.items.map(change => <div key={change.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{modelLabel[change.change.pricingModel]} · {formatBeijing(change.effectiveAt)} · {change.status === "VOIDED" ? "已作废" : change.status === "EFFECTIVE" ? "已生效" : "待生效"}</span>
          <details className="basis-full"><summary>核对资料</summary>
            <p>操作人 {change.createdByAdminId} · 公告 {schedules.announcements.find(item => item.id === change.announcementVersionId)?.title ?? change.announcementVersionId}</p>
            {change.voidReason ? <p>作废原因 {change.voidReason}</p> : null}
            <ul>{[
              ...priceDiff(rules, change.change.previousPriceVersionId, change.change.price?.version.id),
              ...priceDiff(rules, change.change.previousFundingVersionId, change.change.combination?.funding.id).filter(row => row.group === "押金规则"),
              ...termDiff(rules, change.change.previousTermVersionId, change.change.combination?.term.id),
              ...agreementDiff(rules, change.change.previousAgreementVersionId, change.change.combination?.agreement.id),
            ].map((row, index) => <li key={index}>{row.label} · {row.before} → {row.after}</li>)}</ul>
          </details>
          {canSchedule && change.status === "SCHEDULED" ? <Button type="button" variant="outline" size="sm" disabled={command.locked}
            onClick={() => setVoiding({ id: change.id, reason: "" })}>作废整批</Button> : null}
          {voiding?.id === change.id ? <>
            <Input aria-label="作废原因" maxLength={500} value={voiding.reason} onChange={event => setVoiding({ id: change.id, reason: event.target.value })} />
            <Button type="button" disabled={command.locked || voiding.reason.trim().length < 2}
              onClick={() => void command.write(ruleChangeCommand(gameId, { reason: voiding.reason.trim() }, change.id))}>确认作废</Button>
            <Button type="button" variant="ghost" onClick={() => setVoiding(undefined)}>返回</Button>
          </> : null}
        </div>)}
      </div>
    </> : null}
  </section>;
}
