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
import { REASON_TEXT, haffCount, num, unitLabel, yuan } from "./rules-model";
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
  if (Math.abs(diff) < 0.005) return <span className="inline-flex items-center text-xs font-medium text-muted-foreground">持平</span>;
  const isUp = diff > 0;
  const isGood = reverse ? !isUp : isUp;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${isGood ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/15 text-rose-600 dark:text-rose-400"}`}>
      {isUp ? <TrendingUpIcon className="size-3" /> : <TrendingDownIcon className="size-3" />}
      {isUp ? "+" : "−"}{yuan(Math.abs(diff)).replace("¥", "")}{unit === "元" ? "" : ` ${unit}`}
    </span>
  );
}

/** Nonmodal comparison workbench; local estimates never replace the server's final quote. */
export function TrialWindow({ rules, seed, onClose }: { rules: RulesResponse; seed?: EditValues; onClose: () => void }) {
  const release = rules.release!, { haff } = editContext(rules), bl = baseline(rules), base = bl.values;
  const [adj, setAdj] = useState<EditValues>(() => ({ ...base, ...(seed ?? {}) }));
  const termOpts = rules.termOptions.filter(option => option.versionId === release.termVersionId);
  const fixed = rules.items.filter(item => item.enabled && item.unit !== "HAFF_BASE");
  const [account, setAccount] = useState<TrialAccount>(() => ({
    haffM: "100",
    box: Object.keys(haff?.baseBySafeBox ?? {}).at(-1) ?? "box-b",
    vit: Object.keys(haff?.vitalityDeltaByLevel ?? {})[0] ?? "0",
    bear: Object.keys(haff?.bearDeltaByLevel ?? {})[0] ?? "0",
    dive: "0",
    term: termOpts[0]?.code ?? "daily-10m",
    items: {}
  }));
  const [parametersOpen, setParametersOpen] = useState(false);
  const validation = validateTrialAccount(rules, account);
  const signature = JSON.stringify([rules.game.id, release.priceVersionId, release.termVersionId, validation.inventory, rules.items.map(item => [item.id, item.enabled]), account]);
  const [server, setServer] = useState<ServerResult>({ signature: "", status: "idle" });
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
    if (!validation.ready) return () => { ++reqId.current; controller.abort(); };
    const timer = setTimeout(() => {
      void adminRequest<Preview>("/supply/quote-preview", {
        priceVersionId: release.priceVersionId, termVersionId: release.termVersionId, accountId: "preview_account",
        conditions: { safeBoxCode: account.box, vitLevel: Number(account.vit), bearLevel: Number(account.bear), termOptionCode: account.term, rentalPricing: { rentalMode: "ordinary" } }, inventory: validation.inventory,
      }, "POST", {}, controller.signal).then(result => { if (!controller.signal.aborted && id === reqId.current) setServer({ signature, status: "ok", result }); }).catch(failure => { if (!controller.signal.aborted && id === reqId.current) setServer({ signature, status: "error", message: friendlyError(failure) }); });
    }, 400);
    return () => { clearTimeout(timer); ++reqId.current; controller.abort(); };
  }, [signature, validation.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = server.signature === signature && validation.ready ? server : { signature, status: "idle" as const };
  const quote = result.status === "ok" && result.result.quotable ? result.result.quote : undefined;

  // 服务端没有返回可报价结果时，该列保持未知：本地估算不能作为服务端失败的回退。
  const left: TrialRow[] = quote
    ? quote.lines.map(line => ({ key: line.itemId, label: `${rules.items.find(item => item.id === line.itemId)?.name ?? line.itemId} × ${rules.items.find(item => item.id === line.itemId)?.unit === "HAFF_BASE" ? haffCount(line.quantity) : line.quantity}`, tenant: amt(line.buyerAmount), owner: amt(line.ownerAmount) }))
    : [];

  const estimate = trialEstimate(rules, adj, account), right = estimate.rows ?? [];
  const seconds = num(quote?.termSeconds), daysCur = seconds !== null && seconds > 0 ? Math.ceil(seconds / 86400) : null;
  const depCur = quote ? trialDeposit(rules, base, account) : null;
  const depAdj = estimate.rows ? trialDeposit(rules, adj, account) : null;
  const keys = [...new Set([...left, ...right].map(row => row.key))];

  const paramKeys = ["haff.spread.ordinary", ...fixed.flatMap(item => [`item.${item.id}.buyer`, `item.${item.id}.owner`])];
  const parameterErrors = validate(bl.fields.filter(field => paramKeys.includes(field.key)), adj);

  const down = (event: ReactPointerEvent<HTMLDivElement>) => { if ((event.target as HTMLElement).closest("button") || (event.target as HTMLElement).closest("input") || (event.target as HTMLElement).closest("select")) return; drag.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y }; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) setPos(constrain({ x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy })); };

  // 关键财务指标汇总
  const leftTenant = sum(left, "tenant"), leftOwner = sum(left, "owner");
  const rightTenant = sum(right, "tenant"), rightOwner = sum(right, "owner");
  const leftPlatform = leftTenant !== null && leftOwner !== null ? leftTenant - leftOwner : null;
  const rightPlatform = rightTenant !== null && rightOwner !== null ? rightTenant - rightOwner : null;
  const leftMarginRate = leftTenant && leftPlatform !== null && leftTenant > 0 ? (leftPlatform / leftTenant) * 100 : null;
  const rightMarginRate = rightTenant && rightPlatform !== null && rightTenant > 0 ? (rightPlatform / rightTenant) * 100 : null;
  const isChanged = adj && Object.keys(adj).some(k => adj[k] !== base[k]);

  return (
    <div ref={pane} role="dialog" aria-modal="false" aria-label="试算一单" className="fixed z-50 flex max-h-[calc(100dvh-20px)] w-[min(1140px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl backdrop-blur-md" style={{ left: pos.x, top: pos.y }}>
      {/* 标题栏 */}
      <div className="flex cursor-move touch-none select-none items-center justify-between border-b border-border bg-muted/40 px-5 py-3" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <CalculatorIcon className="size-4" />
          </span>
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold leading-5">
              比价与价差测算工作台
              <Badge variant="outline" className="text-[11px] font-normal">独立试算</Badge>
            </h3>
            <p className="text-xs text-muted-foreground">左侧调整参数与单价 · 右侧小票实时核算价格与价差 Diff</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {isChanged ? (
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdj({ ...base })}>
              恢复线上参数
            </Button>
          ) : null}
          <Button type="button" size="icon-sm" variant="ghost" aria-label="复位试算窗口" title="复位位置" onClick={reset}><RotateCcwIcon className="size-3.5" /></Button>
          <Button ref={close} type="button" size="icon-sm" variant="ghost" aria-label="关闭试算" onClick={onClose}><XIcon className="size-4" /></Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {/* 双栏布局：左侧参数调整，右侧独立价格 Diff 小票 */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">

          {/* 左侧：专门改各项数值 (7列) */}
          <div className="lg:col-span-7 space-y-4">
            {/* 1. 账号资产条件 */}
            <section className="rounded-lg border border-border bg-card/60 p-4 space-y-3" aria-label="共同账号条件">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">1. 设定账号资产条件</h4>
                  <Tip>输入哈夫币总量与各物资携带数量；用于计算两端总金额与平台价差。</Tip>
                </div>
                <span className="text-[11px] text-muted-foreground">两端共用 · 数量留空即不携带</span>
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <div className="w-52">
                  <Num
                    label="哈夫币（M）"
                    value={account.haffM}
                    placeholder="100"
                    error={validation.errors.haffM}
                    onChange={value => setAccount({ ...account, haffM: value })}
                  />
                </div>
              </div>
              {fixed.length > 0 ? (
                <div className="border-t border-border/60 pt-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">携带物资数量（选填）</p>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {fixed.map(item => (
                      <Num
                        key={item.id}
                        label={`${item.name}（${unitLabel(item.unit, item.code)}）`}
                        value={account.items[item.id] ?? ""}
                        placeholder="0"
                        error={validation.errors[`item.${item.id}`]}
                        onChange={value => setAccount({ ...account, items: { ...account.items, [item.id]: value } })}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </section>

            {/* 2. 模拟规则参数与单价调整 */}
            <Collapsible open={parametersOpen} onOpenChange={setParametersOpen} className="rounded-lg border border-border bg-card/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs font-semibold" />}>
                  <span>规则参数（只调整右侧）</span>
                  <ChevronDownIcon className={`size-3.5 transition-transform duration-200 ${parametersOpen ? "rotate-180" : ""}`} />
                </CollapsibleTrigger>
                <div className="flex items-center gap-2">
                  <Tip>修改比例差或物资单价后，右侧价格小票实时比对测算。</Tip>
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setAdj({ ...base })}>
                    重置
                  </Button>
                </div>
              </div>

              <CollapsibleContent>
                <div className="space-y-4 pt-2 border-t border-border/60">
                  {/* 哈夫币比例差调节 */}
                  <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-semibold">哈夫币平台比例差（普通/自定义）</p>
                          <Tip>租客比例 ＝ 号主比例 − 平台比例差。基准差额为 10；调大比例差增加平台留存。</Tip>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">基准值: {base["haff.spread.ordinary"] || "10"}</p>
                      </div>
                      <div className="w-36">
                        <Num
                          label="比例差（普通/自定义）"
                          value={adj["haff.spread.ordinary"] ?? ""}
                          placeholder={base["haff.spread.ordinary"] || "10"}
                          error={parameterErrors["haff.spread.ordinary"]}
                          changed={adj["haff.spread.ordinary"] !== base["haff.spread.ordinary"]}
                          onChange={value => setAdj(previous => ({ ...previous, "haff.spread.ordinary": value }))}
                        />
                      </div>
                    </div>
                  </div>

                  {/* 各项物资单价与价差调节 */}
                  {fixed.length > 0 ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold">各项物资模拟单价与单件差额</p>
                        <span className="text-[11px] text-muted-foreground">未填则沿用当前基准值</span>
                      </div>
                      <div className="overflow-x-auto rounded-md border border-border">
                        <Table className="text-xs tabular-nums">
                          <TableHeader className="bg-muted/40">
                            <TableRow>
                              <TableHead>物资名称</TableHead>
                              <TableHead>单位</TableHead>
                              <TableHead className="w-28 text-right">模拟租客价 (元)</TableHead>
                              <TableHead className="w-28 text-right">模拟号主价 (元)</TableHead>
                              <TableHead className="text-right font-medium">模拟单件差</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {fixed.map(item => {
                              const buyerKey = `item.${item.id}.buyer`;
                              const ownerKey = `item.${item.id}.owner`;
                              const curBuyer = base[buyerKey] || "";
                              const curOwner = base[ownerKey] || "";
                              const adjBuyer = adj[buyerKey] ?? "";
                              const adjOwner = adj[ownerKey] ?? "";
                              const effectiveBuyer = adjBuyer !== "" ? num(adjBuyer) : num(curBuyer);
                              const effectiveOwner = adjOwner !== "" ? num(adjOwner) : num(curOwner);
                              const spreadVal = effectiveBuyer !== null && effectiveOwner !== null ? effectiveBuyer - effectiveOwner : null;
                              return (
                                <TableRow key={item.id}>
                                  <TableCell className="font-medium whitespace-nowrap">{item.name}</TableCell>
                                  <TableCell className="text-muted-foreground whitespace-nowrap">每{unitLabel(item.unit, item.code)}</TableCell>
                                  <TableCell className="text-right">
                                    <Input
                                      aria-label={`${item.name} 租客单价`}
                                      value={adjBuyer}
                                      placeholder={curBuyer || "0.00"}
                                      inputMode="decimal"
                                      aria-invalid={Boolean(parameterErrors[buyerKey])}
                                      onChange={e => setAdj(prev => ({ ...prev, [buyerKey]: e.target.value.trim() }))}
                                      className={`h-7 w-24 text-right text-xs tabular-nums placeholder:text-muted-foreground/45 ${adjBuyer !== curBuyer ? "border-amber-500 bg-amber-500/10" : ""}`}
                                    />
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <Input
                                      aria-label={`${item.name} 号主单价`}
                                      value={adjOwner}
                                      placeholder={curOwner || "0.00"}
                                      inputMode="decimal"
                                      aria-invalid={Boolean(parameterErrors[ownerKey])}
                                      onChange={e => setAdj(prev => ({ ...prev, [ownerKey]: e.target.value.trim() }))}
                                      className={`h-7 w-24 text-right text-xs tabular-nums placeholder:text-muted-foreground/45 ${adjOwner !== curOwner ? "border-amber-500 bg-amber-500/10" : ""}`}
                                    />
                                  </TableCell>
                                  <TableCell className="text-right font-semibold">
                                    {spreadVal !== null ? (
                                      <span className={spreadVal >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                                        {spreadVal >= 0 ? "+" : "−"}¥{Math.abs(spreadVal).toFixed(2)}
                                      </span>
                                    ) : "—"}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* 右侧：独立价格 Diff 小票组件 (5列) */}
          <div className="lg:col-span-5 flex flex-col">
            <div className="rounded-xl border border-border/80 bg-card p-4 shadow-sm flex flex-col space-y-4">
              {/* 小票头部 */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ReceiptTextIcon className="size-4 text-primary" />
                    <h4 className="text-sm font-semibold tracking-tight">价格测算小票</h4>
                    <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0">实时 Diff</Badge>
                  </div>
                  <div className="text-right text-[11px] text-muted-foreground tabular-nums">
                    {daysCur ? `可租 ${daysCur}天` : "—"} · 押金 {depAdj !== null ? yuan(depAdj) : (depCur !== null ? yuan(depCur) : "未配置")}
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">当前线上规则基准 vs 本地调整模拟比对</p>
              </div>

              {/* Hero 指标看板 (收银总额区) */}
              <div className="grid grid-cols-1 gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-3">
                {/* 租客资源金额（不含押金） */}
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">租客资源金额（不含押金）</span>
                    <p className="text-[11px] text-muted-foreground">基准 {leftTenant === null ? "—" : yuan(leftTenant)}</p>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold tabular-nums">
                      {rightTenant === null ? (leftTenant === null ? "待计算" : yuan(leftTenant)) : yuan(rightTenant)}
                    </span>
                    <DiffBadge before={leftTenant} after={rightTenant} reverse />
                  </div>
                </div>

                <div className="border-t border-border/40" />

                {/* 号主资源金额（扣费前，未结算） */}
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">号主资源金额（扣费前）</span>
                    <p className="text-[11px] text-muted-foreground">基准 {leftOwner === null ? "—" : yuan(leftOwner)}</p>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold tabular-nums">
                      {rightOwner === null ? (leftOwner === null ? "待计算" : yuan(leftOwner)) : yuan(rightOwner)}
                    </span>
                    <DiffBadge before={leftOwner} after={rightOwner} />
                  </div>
                </div>

                <div className="border-t border-border/40" />

                {/* 平台价差（未扣费用，不是净利润） */}
                <div className="flex items-center justify-between rounded-md bg-emerald-500/10 -mx-1.5 px-2 py-1.5 border border-emerald-500/20">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">平台价差（未扣费用）</span>
                      <span className="text-[10px] text-emerald-700/80 dark:text-emerald-300/80 tabular-nums">
                        {rightMarginRate === null ? (leftMarginRate === null ? "—" : `${leftMarginRate.toFixed(1)}%`) : `${rightMarginRate.toFixed(1)}%`}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">基准价差 {leftPlatform === null ? "—" : yuan(leftPlatform)}</p>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">
                      {rightPlatform === null ? (leftPlatform === null ? "待计算" : yuan(rightPlatform)) : yuan(rightPlatform)}
                    </span>
                    <DiffBadge before={leftPlatform} after={rightPlatform} />
                  </div>
                </div>
              </div>

              {/* 小票虚线裁切线 */}
              <div className="border-t border-dashed border-border" />

              {/* 小票细则清单 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
                  <span>细则清单 (按携带数量计)</span>
                  <span>变动差额</span>
                </div>

                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {keys.map((key) => {
                    const a = left.find((row) => row.key === key);
                    const b = right.find((row) => row.key === key);
                    const rowLabel = b?.label ?? a?.label ?? key;
                    const platformA = a && a.tenant !== null && a.owner !== null ? a.tenant - a.owner : null;
                    const platformB = b && b.tenant !== null && b.owner !== null ? b.tenant - b.owner : null;
                    return (
                      <div key={key} className="rounded-md border border-border/40 bg-muted/10 p-2 text-xs">
                        <div className="flex items-center justify-between font-medium">
                          <span>{rowLabel}</span>
                          <DiffBadge before={platformA} after={platformB} />
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>租客: {b?.tenant !== null && b?.tenant !== undefined ? yuan(b.tenant) : (a?.tenant !== null && a?.tenant !== undefined ? yuan(a.tenant) : "—")}</span>
                          <span>号主: {b?.owner !== null && b?.owner !== undefined ? yuan(b.owner) : (a?.owner !== null && a?.owner !== undefined ? yuan(a.owner) : "—")}</span>
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">价差: {platformB !== null ? yuan(platformB) : (platformA !== null ? yuan(platformA) : "—")}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 自动化测试断言容器 & 状态小栏 */}
              <div className="pt-2 border-t border-border/60 space-y-2">
                <div aria-label="当前生效规则" className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground/80">线上基准规则</span>
                    {quote?.ownerHaffRatio ? <Badge variant="outline" className="text-[10px]">号主比例 {quote.ownerHaffRatio}</Badge> : null}
                  </div>
                  {result.status === "busy" ? <p role="status" aria-busy="true" className="text-xs">计算中…</p> : null}
                  {result.status === "error" ? <p role="alert" className="text-[11px] text-destructive">试算失败：{result.message}</p> : null}
                  {result.status === "ok" && !quote ? <p role="status" className="text-xs">无法报价：{(result.result.reasonCodes ?? []).map(code => REASON_TEXT[code] ?? code).join("、") || "原因未提供"}</p> : null}
                  {!validation.ready ? <p role="status" className="text-xs">待计算：请完善共同账号条件。</p> : null}
                  {left.length > 0 ? (
                    <p className="text-[11px] tabular-nums">
                      租客资源金额 {leftTenant === null ? "未配置" : yuan(leftTenant)} · 号主金额（扣费前） {leftOwner === null ? "未配置" : yuan(leftOwner)} · 平台价差 {leftPlatform === null ? "未配置" : yuan(leftPlatform)}
                    </p>
                  ) : validation.ready && result.status !== "busy" ? <p className="text-xs">基准金额未提供：服务端本次没有返回可报价结果，右侧数字为本地模拟，不代表线上基准。</p> : null}
                </div>

                <div aria-label="可调整参数" className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-primary">模拟调整规则</span>
                    {estimate.ratio ? <Badge variant="secondary" className="text-[10px]">号主比例 {estimate.ratio}</Badge> : null}
                  </div>
                  {estimate.rows ? (
                    <p className="text-[11px] tabular-nums">
                      租客资源金额 {rightTenant === null ? "待计算" : yuan(rightTenant)} · 号主金额（扣费前） {rightOwner === null ? "待计算" : yuan(rightOwner)} · 平台价差 {rightPlatform === null ? "待计算" : yuan(rightPlatform)}
                    </p>
                  ) : (
                    <p role="status" className="text-xs">{estimate.message || "待计算：请在下方调整参数"}</p>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
