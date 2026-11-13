import { useEffect, useRef, useState } from "react";
import { adminRequest, friendlyError, type PricingModel, type PricingSchedules, type RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { beijingLocalToIso, formatBeijing } from "../../lib/audit-labels";
import { isPricingScheduleOperation, pricingScheduleCommand, pricingSchedulesPath, type useRulesWrite } from "./rules-write";

const modelLabel: Record<PricingModel, string> = { FIXED_FEE: "固定手续费", SPREAD: "价差" };
const modeOptions = [{ value: "price", label: "价格版本" }, { value: "mode", label: "新上架默认抽成模式" }];
function formatRate(value: string) {
  const match = /^0(?:\.(\d{1,8}))?$/.exec(value);
  if (!match) return "待核对";
  const digits = (match[1] ?? "").padEnd(2, "0");
  const fraction = digits.slice(2).replace(/0+$/, "");
  return `${Number(digits.slice(0, 2))}${fraction ? "." + fraction : ""}%`;
}

export function PricingSchedulesPanel({ rules, active, canSchedule, command }: {
  rules: RulesResponse;
  active: boolean;
  canSchedule: boolean;
  command: ReturnType<typeof useRulesWrite>;
}) {
  const { id: gameId } = rules.game;
  const [state, setState] = useState<{ data?: PricingSchedules; error?: string }>({});
  const [refresh, setRefresh] = useState(0);
  const [kind, setKind] = useState<"price" | "mode">("price");
  const [model, setModel] = useState<PricingModel>("FIXED_FEE");
  const [priceId, setPriceId] = useState("");
  const [announcementId, setAnnouncementId] = useState("");
  const [localTime, setLocalTime] = useState("");
  const [review, setReview] = useState(false);
  const [timeError, setTimeError] = useState("");
  const conflictRead = useRef(0);
  const completed = command.state.kind === "done" && isPricingScheduleOperation(command.state.operation) ? command.state.receipt.id : undefined;

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
    if (!completed) return;
    setReview(false);
    setPriceId("");
    setAnnouncementId("");
    setLocalTime("");
    setTimeError("");
  }, [completed]);

  const data = state.data;
  const schedules = data?.available ? data : null;
  const blockedByConflict = command.state.kind === "conflict" && refresh <= conflictRead.current;
  const prices = rules.priceVersions.filter(price => price.gameId === gameId && price.status === "SEALED"
    && price.roundingPolicy === "HALF_UP_CENT_V1" && (model === "FIXED_FEE"
      ? price.mode === "PERCENT" && price.fixedFeeRates && price.haffRule?.schema === "haff-ratio-v3"
      : price.mode === "SPREAD" && !price.fixedFeeRates && price.haffRule?.schema === "haff-ratio-v2"));
  const price = prices.find(version => version.id === priceId);
  const announcement = schedules?.announcements.find(version => version.id === announcementId);
  const effectiveAt = beijingLocalToIso(localTime);
  const canSubmit = Boolean(schedules && canSchedule && !command.locked && !blockedByConflict
    && (model === "FIXED_FEE" || schedules.spreadSchedulingEnabled)
    && announcement && effectiveAt && (kind === "mode" || price));
  const submit = () => {
    if (!canSubmit || !schedules) return;
    if (Date.parse(effectiveAt) <= Date.parse(schedules.asOf)) {
      setTimeError("请选择晚于当前时间的生效时间。");
      return;
    }
    if (!review) { setReview(true); return; }
    conflictRead.current = refresh;
    setReview(false);
    void command.write(pricingScheduleCommand(gameId, kind, {
      pricingModel: model,
      ...(kind === "price" ? { priceVersionId: priceId } : {}),
      expectedGeneration: kind === "price" ? schedules.priceGenerations[model] : schedules.modeGeneration,
      effectiveAt,
      announcementVersionId: announcementId,
    }));
  };
  const reload = () => {
    setReview(false);
    setRefresh(n => n + 1);
  };

  return <section className="section-panel space-y-5" aria-label="调价排期">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-base font-semibold">调价排期</h3>
        <p className="mt-1 text-sm text-muted-foreground">价格计划影响该模式下的新订单。已创建订单沿用原价。</p>
        {data ? <p className="mt-1 text-xs text-muted-foreground">截至北京时间 {formatBeijing(data.asOf)}</p> : null}
      </div>
      <Button type="button" size="sm" variant="outline" disabled={command.locked || (!data && !state.error)} onClick={reload}>刷新排期</Button>
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
      {canSchedule ? <form className="space-y-4 border-t border-border pt-4" onSubmit={event => { event.preventDefault(); submit(); }}>
        <h4 className="text-sm font-semibold">新增排期</h4>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="排期类型" composite>
            <SupplySelect label="排期类型" value={kind} options={modeOptions} disabled={command.locked || review}
              onValueChange={value => { if (value === "price" || value === "mode") setKind(value); }} />
          </Field>
          <Field label="抽成模式" composite>
            <SupplySelect label="抽成模式" value={model} disabled={command.locked || review}
              options={[{ value: "FIXED_FEE", label: modelLabel.FIXED_FEE }, { value: "SPREAD", label: modelLabel.SPREAD, disabled: !schedules.spreadSchedulingEnabled }]}
              onValueChange={value => { if (value === "SPREAD" || value === "FIXED_FEE") { setModel(value); setPriceId(""); } }} />
          </Field>
          {kind === "price" ? <Field label="已封存价目" composite required hint={!prices.length ? "当前模式还没有可选的已封存价目。" : undefined}>
            <SupplySelect label="已封存价目" value={price ? priceId : ""} disabled={command.locked || review || !prices.length}
              options={[{ value: "", label: "请选择价目", disabled: true }, ...prices.map(version => ({ value: version.id, label: `${version.id} · ${formatBeijing(version.sealedAt)}` }))]} onValueChange={setPriceId} />
          </Field> : null}
          <Field label="调价公告" composite required hint={!schedules.announcements.length ? "请先在「平台动态」发布适用于该游戏的公告，并确认公告已对用户可见。" : schedules.announcementsTruncated ? "仅显示最新 50 条当前可见公告。" : undefined}>
            <SupplySelect label="调价公告" value={announcement ? announcementId : ""} disabled={command.locked || review || !schedules.announcements.length}
              options={[{ value: "", label: "请选择已公开公告", disabled: true }, ...schedules.announcements.map(version => ({ value: version.id, label: `${version.title} · ${formatBeijing(version.publishedAt)}` }))]}
              onValueChange={setAnnouncementId} />
          </Field>
          <Field label="生效时间（北京时间）" required error={timeError || undefined}>
            <Input type="datetime-local" value={localTime} disabled={command.locked || review} required onChange={event => { setLocalTime(event.target.value); setTimeError(""); }} />
          </Field>
        </div>
        {kind === "price" && price?.fixedFeeRates ? <p className="text-sm text-muted-foreground">普通 {formatRate(price.fixedFeeRates.ordinary)} · 自定义 {formatRate(price.fixedFeeRates.custom)} · 极速 {formatRate(price.fixedFeeRates.fast)}</p> : null}
        {kind === "mode" ? <p className="text-sm text-muted-foreground">仅影响生效后新上架的账号。目标模式届时须有生效价目。</p> : null}
        {!schedules.spreadSchedulingEnabled ? <p className="text-sm text-muted-foreground">价差排期暂未开放。</p> : null}
        {review ? <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p>请核对公告正文与本次计划。提交后将于 {formatBeijing(effectiveAt)} 自动生效。</p>
          <p className="break-words">{modelLabel[model]}{kind === "price" ? ` · ${priceId}` : " · 新上架默认模式"} · {announcement?.title}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!canSubmit}>确认排期</Button>
            <Button type="button" variant="ghost" onClick={() => setReview(false)}>返回修改</Button>
          </div>
        </div> : <Button type="submit" disabled={!canSubmit}>核对排期</Button>}
      </form> : <p className="text-sm text-muted-foreground">排期由有规则生效权限的 Boss 提交。</p>}
    </> : null}
  </section>;
}
