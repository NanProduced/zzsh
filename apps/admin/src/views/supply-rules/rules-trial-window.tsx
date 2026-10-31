import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CalculatorIcon, ChevronDownIcon, HelpCircleIcon, ReceiptTextIcon, RotateCcwIcon, TrendingDownIcon, TrendingUpIcon, XIcon } from "lucide-react";
import { adminRequest, friendlyError, type RulesResponse } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import { baseline, editContext, validate, type EditValues } from "./rules-edit";
import { REASON_TEXT, haffCount, num, safeBoxLabel, unitLabel, yuan } from "./rules-model";
import { SupplySelect } from "../../components/supply/supply-select";
import { activePriceDraft, pendingSealedPrice, priceDiff } from "./publish-flow";
import { clampTrialPosition, roundTrialAmount, trialDeposit, trialEstimate, validateTrialAccount, type TrialAccount, type TrialRow } from "./rules-trial-model";

type Amount = { amount: string } | null | undefined;
type Quote = { lines: { itemId: string; quantity: string; buyerAmount: Amount; ownerAmount?: Amount }[]; termSeconds: string; ownerHaffRatio?: string };
type Preview = { quotable: boolean; quote?: Quote; reasonCodes?: string[] };
type ServerResult = { signature: string; status: "idle" | "busy" } | { signature: string; status: "ok"; result: Preview } | { signature: string; status: "error"; message: string };
const amt = (amount: Amount) => (amount ? num(amount.amount) : null);
const sum = (rows: TrialRow[], key: "tenant" | "owner") =>
  rows.length
    ? rows.reduce<number | null>((total, row) => (total === null || row[key] === null ? null : roundTrialAmount(total + row[key]!)), 0)
    : null;

function Tip({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={100}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex size-4 cursor-help items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground transition-colors" />}>
          <HelpCircleIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Num({
  label,
  value,
  placeholder,
  onChange,
  changed,
  error,
  tip,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  changed?: boolean;
  error?: string;
  tip?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center justify-between gap-1">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
        {tip ? <Tip>{tip}</Tip> : null}
      </div>
      <Input
        id={id}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        inputMode="decimal"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => onChange(event.target.value.trim())}
        className={`h-8 text-sm tabular-nums placeholder:text-muted-foreground/45 placeholder:font-normal ${changed ? "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/30" : ""}`}
      />
      {error ? <p id={`${id}-error`} className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

function DiffBadge({ before, after, reverse = false, unit = "元" }: { before: number | null; after: number | null; reverse?: boolean; unit?: string }) {
  if (before === null || after === null) return <span className="text-xs text-muted-foreground">待计算</span>;
  const diff = after - before;
  if (Math.abs(diff) < 0.005) return <span className="inline-flex items-center text-xs font-medium tabular-nums text-muted-foreground">±0.00{unit === "元" ? "" : ` ${unit}`}</span>;
  const isUp = diff > 0;
  const isGood = reverse ? !isUp : isUp;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${isGood ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/15 text-rose-600 dark:text-rose-400"}`}>
      {isUp ? <TrendingUpIcon className="size-3" /> : <TrendingDownIcon className="size-3" />}
      {isUp ? "+" : "−"}{yuan(Math.abs(diff)).replace("¥", "")}{unit === "元" ? "" : ` ${unit}`}
    </span>
  );
}

/** 试算一单：同一单分别按线上和草稿报价（服务端），差额＝草稿−线上；临时调整只在本窗口生效，标为估算。 */
export function TrialWindow({ rules, seed, onClose }: { rules: RulesResponse; seed?: EditValues; onClose: () => void }) {
  const release = rules.release!, { haff } = editContext(rules);
  const draftCandidate = activePriceDraft(rules);
  const draft = draftCandidate && priceDiff(rules, draftCandidate).length ? draftCandidate : pendingSealedPrice(rules);
  const draftBase = draft ? baseline(rules, draft.id).values : baseline(rules).values, liveBase = baseline(rules).values;
  const bl = baseline(rules, draft?.id);
  const [adj, setAdj] = useState<EditValues>(() => ({ ...draftBase, ...(seed ?? {}) }));
  const termOpts = rules.termOptions.filter(option => option.versionId === release.termVersionId);
  const fixed = rules.items.filter(item => item.enabled && item.unit !== "HAFF_BASE");
  const levels = (map?: Record<string, string>) => Object.keys(map ?? {}).sort((a, b) => Number(a) - Number(b));
  const [account, setAccount] = useState<TrialAccount>(() => ({
    haffM: "100",
    box: Object.keys(haff?.baseBySafeBox ?? {}).at(-1) ?? "box-b",
    vit: levels(haff?.vitalityDeltaByLevel)[0] ?? "0",
    bear: levels(haff?.bearDeltaByLevel)[0] ?? "0",
    dive: "0",
    term: termOpts[0]?.code ?? "daily-10m",
    items: {}
  }));
  const [parametersOpen, setParametersOpen] = useState(false);
  const validation = validateTrialAccount(rules, account);
  const signature = JSON.stringify([rules.game.id, release.priceVersionId, draft?.id, draft?.revision, release.termVersionId, validation.inventory, rules.items.map(item => [item.id, item.enabled]), account]);
  const [server, setServer] = useState<ServerResult>({ signature: "", status: "idle" });
  const [serverDraft, setServerDraft] = useState<ServerResult>({ signature: "", status: "idle" });
  const reqId = useRef(0), pane = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState({ x: 8, y: 8 });
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const constrain = (position: { x: number; y: number }) => {
    const rect = pane.current?.getBoundingClientRect(), view = viewport();
    return clampTrialPosition(position, view, { width: rect?.width || Math.min(1080, view.width - 16), height: rect?.height || Math.min(760, view.height - 16) });
  };
  const reset = () => { const view = viewport(); setPos(constrain({ x: Math.max(8, (view.width - Math.min(1080, view.width - 16)) / 2), y: Math.min(56, Math.max(8, view.height * 0.05)) })); };
  const closeHandler = useRef(onClose); closeHandler.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reset(); close.current?.focus();
    const resize = () => setPos(position => constrain(position));
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && pane.current?.contains(event.target as Node) && !document.querySelector('[data-slot="select-content"][data-open]')) { event.preventDefault(); closeHandler.current(); }
    };
    window.addEventListener("resize", resize); window.addEventListener("keydown", key);
    const observer = new window.ResizeObserver(resize); if (pane.current) observer.observe(pane.current);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); window.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = ++reqId.current, controller = new AbortController();
    setServer({ signature, status: validation.ready ? "busy" : "idle" });
    setServerDraft({ signature, status: validation.ready && draft ? "busy" : "idle" });
    if (!validation.ready) return () => { ++reqId.current; controller.abort(); };
    const ask = (priceVersionId: string, expectedRevision: string | undefined, set: (r: ServerResult) => void) =>
      adminRequest<Preview>("/supply/quote-preview", {
        priceVersionId, ...(expectedRevision ? { expectedRevision } : {}), termVersionId: release.termVersionId, accountId: "preview_account",
        conditions: { safeBoxCode: account.box, vitLevel: Number(account.vit), bearLevel: Number(account.bear), termOptionCode: account.term, rentalPricing: { rentalMode: "ordinary" } }, inventory: validation.inventory,
      }, "POST", {}, controller.signal).then(result => { if (!controller.signal.aborted && id === reqId.current) set({ signature, status: "ok", result }); }).catch(failure => { if (!controller.signal.aborted && id === reqId.current) set({ signature, status: "error", message: friendlyError(failure) }); });
    const timer = setTimeout(() => {
      void ask(release.priceVersionId, undefined, setServer);
      if (draft) void ask(draft.id, draft.status === "DRAFT" ? draft.revision : undefined, setServerDraft);
    }, 400);
    return () => { clearTimeout(timer); ++reqId.current; controller.abort(); };
  }, [signature, validation.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: ServerResult) => (s.signature === signature && validation.ready ? s : { signature, status: "idle" as const });
  const result = pick(server), draftResult = pick(serverDraft);
  const quoteOf = (r: ServerResult) => (r.status === "ok" && r.result.quotable ? r.result.quote : undefined);
  const quote = quoteOf(result), draftQuote = quoteOf(draftResult);
  const rowsOf = (q?: Quote): TrialRow[] => q ? q.lines.map(line => {
    const item = rules.items.find(i => i.id === line.itemId);
    return { key: line.itemId, label: `${item?.name ?? "物资"} × ${item?.unit === "HAFF_BASE" ? haffCount(line.quantity) : line.quantity}`, tenant: amt(line.buyerAmount), owner: amt(line.ownerAmount) };
  }) : [];

  const tweaked = Object.keys(adj).some(k => (adj[k] ?? "") !== (draftBase[k] ?? ""));
  const estimate = trialEstimate(rules, adj, account, draft?.id);
  // 草稿列：没有临时调整时用服务端草稿报价；有临时调整（或没有草稿）时用本地估算，并明确标「估算」。
  const useEstimate = tweaked || !draft;
  const left = rowsOf(quote);
  const right = useEstimate ? (tweaked ? estimate.rows ?? [] : []) : rowsOf(draftQuote);
  const rightLabel = useEstimate ? (tweaked ? "估算" : "草稿") : "草稿";
  const daysOf = (q?: Quote) => { const s = num(q?.termSeconds); return s !== null && s > 0 ? Math.ceil(s / 86400) : null; };
  const daysCur = daysOf(quote), daysAdj = useEstimate ? (tweaked ? estimate.days : null) : daysOf(draftQuote);
  const depCur = validation.ready ? trialDeposit(rules, liveBase, account) : null;
  const depAdj = validation.ready && (draft || tweaked) ? trialDeposit(rules, adj, account, draft?.id) : null;

  const paramKeys = ["haff.spread.ordinary", ...fixed.flatMap(item => [`item.${item.id}.buyer`, `item.${item.id}.owner`])];
  const parameterErrors = validate(bl.fields.filter(field => paramKeys.includes(field.key)), adj);

  const down = (event: ReactPointerEvent<HTMLDivElement>) => { if ((event.target as HTMLElement).closest("button") || (event.target as HTMLElement).closest("input") || (event.target as HTMLElement).closest("select")) return; drag.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y }; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) setPos(constrain({ x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy })); };

  const leftTenant = sum(left, "tenant"), leftOwner = sum(left, "owner");
  const rightTenant = sum(right, "tenant"), rightOwner = sum(right, "owner");
  const leftPlatform = leftTenant !== null && leftOwner !== null ? roundTrialAmount(leftTenant - leftOwner) : null;
  const rightPlatform = rightTenant !== null && rightOwner !== null ? roundTrialAmount(rightTenant - rightOwner) : null;
  const hasRight = right.length > 0;
  const keys = [...new Set([...left, ...right].map(row => row.key))];
  const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : yuan(v));
  const cell = "text-right tabular-nums";
  const Row = ({ label, a, b, bold, reverse, days }: { label: string; a: number | null; b: number | null; bold?: boolean; reverse?: boolean; days?: boolean }) => (
    <TableRow className={bold ? "font-semibold" : ""}>
      <TableCell className="whitespace-nowrap">{label}</TableCell>
      <TableCell className={cell}>{days ? (a === null ? "—" : `${a} 天`) : money(a)}</TableCell>
      <TableCell className={cell}>{hasRight || days ? (days ? (b === null ? "—" : `${b} 天`) : money(b)) : "—"}</TableCell>
      <TableCell className={cell}>{hasRight || (days && b !== null) ? <DiffBadge before={a} after={b} reverse={reverse} unit={days ? "天" : "元"} /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
    </TableRow>
  );
  const status = (r: ServerResult) => r.status === "busy" ? <p role="status" aria-busy="true">计算中…</p>
    : r.status === "error" ? <p role="alert" className="text-destructive">试算失败：{r.message}</p>
    : r.status === "ok" && !quoteOf(r) ? <p role="status">无法报价：{(r.result.reasonCodes ?? []).map(code => REASON_TEXT[code] ?? "条件不满足").join("、") || "原因未提供"}</p> : null;
  const select = (label: string, value: string, options: [string, string][], onChange: (v: string) => void, error?: string) => (
    <label className="min-w-0 space-y-1 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <SupplySelect label={label} value={value} onValueChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} aria-invalid={Boolean(error)} />
      {error ? <span className="block text-[11px] text-destructive">{error}</span> : null}
    </label>
  );

  return (
    <div ref={pane} role="dialog" aria-modal="false" aria-label="试算一单" className="fixed z-50 flex max-h-[calc(100dvh-20px)] w-[min(1140px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl backdrop-blur-md" style={{ left: pos.x, top: pos.y }}>
      <div className="flex cursor-move touch-none select-none items-center justify-between border-b border-border bg-muted/40 px-5 py-3" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary"><CalculatorIcon className="size-4" /></span>
          <div>
            <h3 className="text-base font-semibold leading-5">试算一单</h3>
            <p className="text-xs text-muted-foreground">同一单按线上和草稿各算一遍。只试算，不保存。</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" size="icon-sm" variant="ghost" aria-label="复位试算窗口" title="复位位置" onClick={reset}><RotateCcwIcon className="size-3.5" /></Button>
          <Button ref={close} type="button" size="icon-sm" variant="ghost" aria-label="关闭试算" onClick={onClose}><XIcon className="size-4" /></Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-5">
            <section className="space-y-3 rounded-lg border border-border bg-card/60 p-4" aria-label="共同账号条件">
              <h4 className="text-sm font-semibold">订单条件</h4>
              <div className="grid grid-cols-2 gap-3">
                <Num label="哈夫币（M）" value={account.haffM} placeholder="100" error={validation.errors.haffM} onChange={value => setAccount({ ...account, haffM: value })} />
                {select("保险箱", account.box, Object.keys(haff?.baseBySafeBox ?? {}).map(c => [c, safeBoxLabel(c)]), v => setAccount({ ...account, box: v }), validation.errors.box)}
                {select("体力等级", account.vit, levels(haff?.vitalityDeltaByLevel).map(l => [l, `${l} 级`]), v => setAccount({ ...account, vit: v }), validation.errors.vit)}
                {select("负重等级", account.bear, levels(haff?.bearDeltaByLevel).map(l => [l, `${l} 级`]), v => setAccount({ ...account, bear: v }), validation.errors.bear)}
                {select("潜水等级", account.dive, ["0", "1", "2", "3", "4", "5"].map(l => [l, l === "0" ? "无" : `${l} 级`]), v => setAccount({ ...account, dive: v }), validation.errors.dive)}
                {select("每日消耗档", account.term, termOpts.map(o => [o.code, o.name]), v => setAccount({ ...account, term: v }), validation.errors.term)}
              </div>
              {fixed.length > 0 ? (
                <div className="border-t border-border/60 pt-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">携带物资数量（不带留空）</p>
                  <div className="grid grid-cols-2 gap-2.5">
                    {fixed.map(item => (
                      <Num key={item.id} label={`${item.name}（${unitLabel(item.unit, item.code)}）`} value={account.items[item.id] ?? ""} placeholder="0" error={validation.errors[`item.${item.id}`]} onChange={value => setAccount({ ...account, items: { ...account.items, [item.id]: value } })} />
                    ))}
                  </div>
                </div>
              ) : null}
            </section>

            <Collapsible open={parametersOpen} onOpenChange={setParametersOpen} className="space-y-3 rounded-lg border border-border bg-card/60 p-4">
              <div className="flex items-center justify-between">
                <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs font-semibold" />}>
                  <span>临时调整（估算）</span>
                  <ChevronDownIcon className={`size-3.5 transition-transform duration-200 ${parametersOpen ? "rotate-180" : ""}`} />
                </CollapsibleTrigger>
                {tweaked ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAdj({ ...draftBase })}>还原</Button> : null}
              </div>
              <CollapsibleContent>
                <div className="space-y-3 border-t border-border/60 pt-3">
                  <p className="text-[11px] text-muted-foreground">只改右侧「{draft ? "草稿" : "估算"}」列，不会保存。改了以后该列变为本地估算。</p>
                  <div className="w-40">
                    <Num label="比例差（普通/自定义）" value={adj["haff.spread.ordinary"] ?? ""} placeholder={draftBase["haff.spread.ordinary"] || ""} error={parameterErrors["haff.spread.ordinary"]} changed={adj["haff.spread.ordinary"] !== draftBase["haff.spread.ordinary"]} onChange={value => setAdj(previous => ({ ...previous, "haff.spread.ordinary": value }))} tip={`租客比例 ＝ 号主比例 − 比例差。线上 ${liveBase["haff.spread.ordinary"] || "未设置"}`} />
                  </div>
                  {fixed.length > 0 ? (
                    <div className="overflow-x-auto rounded-md border border-border">
                      <Table className="text-xs tabular-nums">
                        <TableHeader className="bg-muted/40"><TableRow><TableHead>物资</TableHead><TableHead className="text-right">租客价</TableHead><TableHead className="text-right">号主价</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {fixed.map(item => {
                            const buyerKey = `item.${item.id}.buyer`, ownerKey = `item.${item.id}.owner`;
                            const field = (key: string, label: string) => (
                              <Input aria-label={label} value={adj[key] ?? ""} placeholder={draftBase[key] || "0.00"} inputMode="decimal" aria-invalid={Boolean(parameterErrors[key])}
                                onChange={e => { const v = e.target.value.trim(); if (/^\d*(?:\.\d{0,2})?$/.test(v)) setAdj(prev => ({ ...prev, [key]: v })); }}
                                className={`h-7 w-20 text-right text-xs tabular-nums ${(adj[key] ?? "") !== (draftBase[key] ?? "") ? "border-amber-500 bg-amber-500/10" : ""}`} />
                            );
                            return (
                              <TableRow key={item.id}>
                                <TableCell className="whitespace-nowrap">{item.name}<span className="ml-1 text-muted-foreground">/{unitLabel(item.unit, item.code)}</span></TableCell>
                                <TableCell className="text-right">{field(buyerKey, `${item.name} 租客单价`)}</TableCell>
                                <TableCell className="text-right">{field(ownerKey, `${item.name} 号主单价`)}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <div className="space-y-3 rounded-xl border border-border/80 bg-card p-4 shadow-sm lg:col-span-7">
            <div className="flex items-center gap-2">
              <ReceiptTextIcon className="size-4 text-primary" />
              <h4 className="text-sm font-semibold">结果对比</h4>
              {rightLabel === "估算" ? <Badge variant="warning" className="text-[10px]">含临时调整 · 估算</Badge> : null}
            </div>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table className="text-xs">
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead>项目</TableHead>
                    <TableHead className="text-right">线上</TableHead>
                    <TableHead className="text-right">{rightLabel}</TableHead>
                    <TableHead className="text-right">差额</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map(key => {
                    const a = left.find(r => r.key === key), b = right.find(r => r.key === key);
                    return <Row key={key} label={`租客付 · ${(a ?? b)!.label}`} a={a?.tenant ?? null} b={b?.tenant ?? null} reverse />;
                  })}
                  <Row label="租客合计（不含押金）" a={leftTenant} b={rightTenant} bold reverse />
                  <Row label="号主所得（扣费前）" a={leftOwner} b={rightOwner} />
                  <Row label="平台收益" a={leftPlatform} b={rightPlatform} bold />
                  <Row label="可租天数" a={daysCur} b={daysAdj} days />
                  <Row label="推荐押金（按押金规则推算）" a={depCur} b={depAdj} />
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div aria-label="当前生效规则" className="rounded-md bg-muted/30 px-2.5 py-1.5">
                <span className="font-medium text-foreground/80">线上</span>
                {!validation.ready ? <p role="status">待计算：请把订单条件填完整。</p> : status(result)}
                {left.length ? <p className="tabular-nums">租客 {money(leftTenant)} · 号主 {money(leftOwner)} · 平台 {money(leftPlatform)}</p> : null}
              </div>
              <div aria-label="可调整参数" className="rounded-md bg-primary/5 px-2.5 py-1.5">
                <span className="font-medium text-primary">{rightLabel === "估算" ? "估算（本地）" : draft ? "草稿（服务端）" : "草稿"}</span>
                {!validation.ready ? <p role="status">待计算：请把订单条件填完整。</p>
                  : useEstimate ? (tweaked ? (estimate.rows ? <p className="tabular-nums">租客 {money(rightTenant)} · 号主 {money(rightOwner)} · 平台 {money(rightPlatform)}</p> : <p role="status">{estimate.message}</p>) : <p>没有未生效的改动，和线上一样。</p>)
                  : <>{status(draftResult)}{right.length ? <p className="tabular-nums">租客 {money(rightTenant)} · 号主 {money(rightOwner)} · 平台 {money(rightPlatform)}</p> : null}</>}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">差额＝{rightLabel}−线上。押金按押金规则推算，最终以号主填写为准。</p>
          </div>
        </div>
      </div>
    </div>
  );
}
