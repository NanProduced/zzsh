import { useEffect, useRef, useState } from "react";
import { Copy, LineChart, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { adminRequest, friendlyError } from "../api";
import { formatDiscountLabel, parsePayableRatio } from "./membership-entitlement-form";
import { exactPercentTenths, formatCents, formatTenthsPercent, type AdminPricingMode } from "./membership-growth-policy-model";

export type ProfitSimulationContext = {
  schema: "membership-profit-simulation-context.v1";
  gameId: string;
  ruleReleaseId: string;
  priceVersionId: string;
  termVersionId: string;
  enabledModes: AdminPricingMode[];
  basisKind?: "CURRENT_LISTING";
  pricingModel?: string;
  safeBoxes: string[];
  resources: { itemId: string; name: string; unit: string; pricingKind: string }[];
  termOptions: { code: string; dailyConsumption: string }[];
};

export type ProfitSimulationPoint = {
  payableRatio: string;
  payableRentalCents: string;
  discountCents: string;
  ownerIncomeCents: string;
  platformSpreadCents: string;
  ownerFloorSatisfied: boolean;
  spreadRate: { numerator: string; denominator: string } | null;
};

export type ProfitSimulationResult = {
  schema: "membership-profit-simulation.v1";
  baseQuotable: boolean;
  estimateOnly: true;
  calculation: "RENTAL_SPREAD_BEFORE_FEES" | "FIXED_FEE_AFTER_DISCOUNT";
  basis: { gameId: string; ruleReleaseId: string; priceVersionId: string; termVersionId: string };
  baseline: {
    rentalCents: string;
    haffRentalCents: string;
    materialFeesCents: string;
    ownerIncomeCents: string;
    platformSpreadCents: string;
    depositCents: string | null;
    termSeconds: string;
  };
  breakEven: { numerator: string; denominator: string } | null;
  points: ProfitSimulationPoint[];
  disclosure?: string;
  reasonCodes?: string[];
  reasons?: string[];
  excluded?: string[];
};

function formatApiError(err: unknown): string {
  const friendly = friendlyError(err);
  let status: number | undefined;
  let requestId: string | undefined;
  if (err && typeof err === "object") {
    if ("status" in err && typeof (err as any).status === "number") status = (err as any).status;
    if ("requestId" in err && typeof (err as any).requestId === "string") requestId = (err as any).requestId;
  }
  let prefix = "";
  if (status === 400) prefix = "场景或比例参数不合法 (400)：";
  else if (status === 403) prefix = "无权访问试算接口 (403)：需要内部报价与政策操作权限；";
  else if (status === 409) prefix = "规则发布冲突 (409)：价格版本与当前规则发布不匹配；";
  else if (status === 503) prefix = "依据缺失或服务不可用 (503)：";
  else if (status === 404) prefix = "试算端点未找到 (404)：";
  const reqText = requestId ? ` [requestId: ${requestId}]` : "";
  return `${prefix}${friendly || "网络请求失败"}${reqText}`;
}

type SimulationResource = ProfitSimulationContext["resources"][number];
type SimulationLine = { resourceId: string; quantity: string };
type SimulationScenario = { id: string; name: string; lines: SimulationLine[] };
type SimulationDiscount = { id: string; label: string; ratio: string };

function simulationResourceName(resource: SimulationResource): string {
  return resource.name?.trim() || (resource.pricingKind === "HAFF_RATIO" ? "哈夫币" : `物资 #${resource.itemId.slice(-6)}`);
}

function simulationUnit(resource: SimulationResource): string {
  if (resource.pricingKind === "HAFF_RATIO") return "M";
  return resource.unit === "ROUND" ? "发" : resource.unit === "DAY" ? "天" : "件";
}

function ratioTextFromUnits(units: bigint): string {
  const whole = units / 100_000_000n;
  const fraction = (units % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Human discount input ("8折", "8.5折", "原价", or a payable ratio like 0.8) to the API's exact payable ratio. */
export function parseHumanDiscount(value: string): string | null {
  const text = value.trim();
  if (text === "原价" || text === "100%") return "1";
  const payable = parsePayableRatio(text);
  if (payable !== null) return ratioTextFromUnits(payable);
  const match = text.match(/^(\d{1,2})(?:\.(\d{1,4}))?折$/);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const digits = BigInt(match[1]! + fraction);
  const denominator = 10n * 10n ** BigInt(fraction.length);
  const scaled = digits * 100_000_000n;
  if (scaled % denominator !== 0n) return null;
  const units = scaled / denominator;
  return units > 0n && units <= 100_000_000n ? ratioTextFromUnits(units) : null;
}

/** Haff input is expressed in M; convert exact decimal text to the server's raw integer units. */
export function parseHaffMillions(value: string): string | null {
  const text = value.trim().replace(/\s*[Mm]$/, "");
  const match = text.match(/^(\d{1,9})(?:\.(\d{1,6}))?$/);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const raw = BigInt(match[1]!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  return raw > 0n ? raw.toString() : null;
}

function parseItemQuantity(value: string): string | null {
  const text = value.trim();
  return /^[1-9]\d{0,8}$/.test(text) ? text : null;
}

function simulationInventory(context: ProfitSimulationContext, quantities: Record<string, string>) {
  return context.resources
    .filter((resource) => quantities[resource.itemId] !== undefined && /^[1-9]\d*$/.test(quantities[resource.itemId]!))
    .map((resource) => ({ itemId: resource.itemId, quantity: quantities[resource.itemId]! }));
}

function scenarioQuantities(context: ProfitSimulationContext, scenario: SimulationScenario): { quantities: Record<string, string>; error?: string } {
  const quantities: Record<string, string> = {};
  for (const line of scenario.lines) {
    const resource = context.resources.find((entry) => entry.itemId === line.resourceId);
    if (!resource) continue;
    const raw = resource.pricingKind === "HAFF_RATIO" ? parseHaffMillions(line.quantity) : parseItemQuantity(line.quantity);
    if (raw === null) return { quantities, error: `${simulationResourceName(resource)}：请填写大于 0 的${resource.pricingKind === "HAFF_RATIO" ? "M 数量（最多 6 位小数）" : "整数数量"}` };
    quantities[resource.itemId] = raw;
  }
  return { quantities, error: Object.keys(quantities).length ? undefined : "请至少添加一项物资并填写数量" };
}

function scenarioSummary(context: ProfitSimulationContext, scenario: SimulationScenario): string {
  const parts = scenario.lines
    .map((line) => {
      const resource = context.resources.find((entry) => entry.itemId === line.resourceId);
      if (!resource) return "";
      const value = line.quantity.trim() || "待填写";
      return `${simulationResourceName(resource)} ${value}${simulationUnit(resource)}`;
    })
    .filter(Boolean);
  return parts.length ? parts.slice(0, 4).join(" · ") + (parts.length > 4 ? ` · +${parts.length - 4} 项` : "") : "尚未添加物资";
}

function simulationQuoteInput(context: ProfitSimulationContext, quantities: Record<string, string>, options: { mode: AdminPricingMode; safeBoxCode: string; termOptionCode: string; priceVersionId: string }) {
  return {
    priceVersionId: options.priceVersionId,
    termVersionId: context.termVersionId,
    conditions: {
      safeBoxCode: options.safeBoxCode || context.safeBoxes[0] || undefined,
      vitLevel: 6,
      bearLevel: 6,
      termOptionCode: options.termOptionCode || context.termOptions[0]?.code,
      rentalPricing: { rentalMode: options.mode },
    },
    inventory: simulationInventory(context, quantities),
  };
}

export function ProfitSimulationModal({
  open,
  onOpenChange,
  ruleReleaseId,
  priceVersionId,
  enabledModes,
  gameId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleReleaseId: string;
  priceVersionId: string;
  enabledModes: AdminPricingMode[];
  gameId?: string;
}) {
  const [loadingContext, setLoadingContext] = useState(false);
  const [context, setContext] = useState<ProfitSimulationContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [scenarioResults, setScenarioResults] = useState<Array<{ id: string; name: string; summary: string; result?: ProfitSimulationResult; error?: string }>>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<SimulationScenario[]>([]);
  const [discounts, setDiscounts] = useState<SimulationDiscount[]>([{ id: "discount-8", label: "8折", ratio: "0.8" }]);
  const [discountDraft, setDiscountDraft] = useState("9折");
  const [discountError, setDiscountError] = useState<string | null>(null);
  const enabledModesKey = enabledModes.join(",");
  const sceneSeqRef = useRef(1);
  const discountSeqRef = useRef(1);
  const runSeqRef = useRef(0);
  const runControllerRef = useRef<AbortController | null>(null);
  const runKeyRef = useRef<string | null>(null);

  const invalidateSimulation = () => {
    runSeqRef.current += 1;
    runControllerRef.current?.abort();
    runControllerRef.current = null;
    runKeyRef.current = null;
    setScenarioResults([]);
    setSimulating(false);
  };

  useEffect(() => () => {
    runSeqRef.current += 1;
    runControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!gameId && !ruleReleaseId) {
      setContextError("当前未绑定有效的规则发布，无法发起试算。");
      return;
    }
    const controller = new AbortController();
    let active = true;
    invalidateSimulation();
    setLoadingContext(true);
    setContextError(null);
    setInputError(null);
    setDiscountError(null);
    adminRequest<ProfitSimulationContext>(
      `/membership-growth/profit-simulation-context?${gameId ? new URLSearchParams({ gameId }) : new URLSearchParams({ ruleReleaseId, priceVersionId, basis: "current" })}`,
      undefined,
      "GET",
      {},
      controller.signal,
    )
      .then((data) => {
        if (!active || controller.signal.aborted) return;
        setContext(data);
        setScenarios([{ id: `scene-${sceneSeqRef.current++}`, name: "场景 1", lines: [] }]);
        setDiscounts([{ id: "discount-8", label: "8折", ratio: "0.8" }]);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setContextError(formatApiError(err));
      })
      .finally(() => {
        if (active) setLoadingContext(false);
      });
    return () => {
      active = false;
      controller.abort();
      invalidateSimulation();
    };
  }, [open, gameId, ruleReleaseId, priceVersionId, enabledModesKey]);

  const handleConditionChange = (updater: () => void) => {
    invalidateSimulation();
    setInputError(null);
    updater();
  };

  const addScenario = () => {
    if (scenarios.length >= 4) return;
    handleConditionChange(() => setScenarios((previous) => [...previous, { id: `scene-${sceneSeqRef.current++}`, name: `场景 ${previous.length + 1}`, lines: [] }]));
  };

  const duplicateScenario = (scenario: SimulationScenario) => {
    if (scenarios.length >= 4) return;
    handleConditionChange(() => setScenarios((previous) => [...previous, { id: `scene-${sceneSeqRef.current++}`, name: `场景 ${previous.length + 1}`, lines: scenario.lines.map((line) => ({ ...line })) }]));
  };

  const removeScenario = (id: string) => {
    if (scenarios.length <= 1) return;
    handleConditionChange(() => setScenarios((previous) => previous.filter((scenario) => scenario.id !== id)));
  };

  const addLine = (scenarioId: string, resourceId: string) => {
    const resource = context?.resources.find((entry) => entry.itemId === resourceId);
    if (!resource) return;
    handleConditionChange(() => setScenarios((previous) => previous.map((scenario) => scenario.id === scenarioId && !scenario.lines.some((line) => line.resourceId === resourceId)
      ? { ...scenario, lines: [...scenario.lines, { resourceId, quantity: "" }] }
      : scenario)));
  };

  const updateLine = (scenarioId: string, resourceId: string, quantity: string) => {
    handleConditionChange(() => setScenarios((previous) => previous.map((scenario) => scenario.id === scenarioId
      ? { ...scenario, lines: scenario.lines.map((line) => line.resourceId === resourceId ? { ...line, quantity } : line) }
      : scenario)));
  };

  const removeLine = (scenarioId: string, resourceId: string) => {
    handleConditionChange(() => setScenarios((previous) => previous.map((scenario) => scenario.id === scenarioId
      ? { ...scenario, lines: scenario.lines.filter((line) => line.resourceId !== resourceId) }
      : scenario)));
  };

  const addDiscount = () => {
    const ratio = parseHumanDiscount(discountDraft);
    if (ratio === null) { setDiscountError("请输入类似 8折、8.5折 或原价；不支持负数或指数"); return; }
    if (ratio === "1") { setDiscountError("原价已作为基准列显示，无需重复添加"); return; }
    if (discounts.some((discount) => discount.ratio === ratio)) { setDiscountError("该折扣已添加"); return; }
    if (discounts.length >= 5) { setDiscountError("最多添加 5 个折扣列"); return; }
    handleConditionChange(() => setDiscounts((previous) => [...previous, { id: `discount-${discountSeqRef.current++}`, label: /折$/.test(discountDraft.trim()) ? discountDraft.trim() : formatDiscountLabel(ratio), ratio }]));
    setDiscountDraft("");
    setDiscountError(null);
  };

  const handleSimulate = async () => {
    if (!context) return;
    if (!scenarios.some((scenario) => scenario.lines.some((line) => line.quantity.trim()))) {
      setInputError("请至少在一个场景中添加物资并填写数量");
      return;
    }
    invalidateSimulation();
    const runId = runSeqRef.current;
    const controller = new AbortController();
    runControllerRef.current = controller;
    setInputError(null);
    setSimulating(true);
    const contextSnapshot = context;
    const scenarioSnapshot = scenarios.map((scenario) => ({ ...scenario, lines: scenario.lines.map((line) => ({ ...line })) }));
    const discountSnapshot = discounts.map((discount) => ({ ...discount }));
    const defaultCondition = { mode: contextSnapshot.enabledModes[0] ?? "ordinary", safeBoxCode: contextSnapshot.safeBoxes[0] ?? "", termOptionCode: contextSnapshot.termOptions[0]?.code ?? "", priceVersionId: contextSnapshot.priceVersionId };
    const ratios = [...new Set(["1", ...discountSnapshot.map((discount) => discount.ratio)])];
    const inputKey = JSON.stringify([ruleReleaseId, priceVersionId, enabledModes, contextSnapshot.termVersionId, contextSnapshot.safeBoxes, contextSnapshot.termOptions, scenarioSnapshot, discountSnapshot]);
    runKeyRef.current = inputKey;
    const current = () => runSeqRef.current === runId && runKeyRef.current === inputKey && !controller.signal.aborted;
    const rows: Array<{ id: string; name: string; summary: string; result?: ProfitSimulationResult; error?: string }> = [];
    try {
      for (const scenario of scenarioSnapshot) {
        if (!current()) return;
        const summary = scenarioSummary(contextSnapshot, scenario);
        const { quantities, error } = scenarioQuantities(contextSnapshot, scenario);
        if (error) {
          rows.push({ id: scenario.id, name: scenario.name, summary, error });
          setScenarioResults([...rows]);
          continue;
        }
        try {
          const result = await adminRequest<ProfitSimulationResult>("/membership-growth/profit-simulation", {
            ruleReleaseId: contextSnapshot.ruleReleaseId,
            ...(contextSnapshot.basisKind === "CURRENT_LISTING" ? { gameId: contextSnapshot.gameId } : {}),
            quoteInput: simulationQuoteInput(contextSnapshot, quantities, defaultCondition),
            payableRatios: ratios,
          }, undefined, {}, controller.signal);
          if (!current()) return;
          rows.push({ id: scenario.id, name: scenario.name, summary, result });
        } catch (err: unknown) {
          if (!current()) return;
          rows.push({ id: scenario.id, name: scenario.name, summary, error: formatApiError(err) });
        }
        if (!current()) return;
        setScenarioResults([...rows]);
      }
    } finally {
      if (runSeqRef.current === runId) {
        setSimulating(false);
        runControllerRef.current = null;
      }
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) invalidateSimulation();
    onOpenChange(nextOpen);
  };

  const centsOf = (value: string | undefined | null): bigint | null => {
    if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) return null;
    return BigInt(value);
  };
  const pointFor = (result: ProfitSimulationResult, ratio: string): ProfitSimulationPoint | null => {
    const target = parsePayableRatio(ratio);
    if (target === null || result.baseQuotable === false) return null;
    return result.points?.find((point) => parsePayableRatio(point.payableRatio) === target) ?? null;
  };
  const displayRows = scenarioResults.flatMap((row) => {
    if (row.error || !row.result || row.result.baseQuotable === false) {
      return [{ key: `${row.id}:error`, scene: row.name, summary: row.summary, ratio: "—", renter: null, owner: null, platform: null, originalPlatform: null, reduction: null, reductionTenths: null, floor: null, closed: null, missing: row.error ?? row.result?.reasonCodes?.join("；") ?? "无法报价" }];
    }
    const originalPoint = pointFor(row.result, "1");
    const originalPlatform = originalPoint ? centsOf(originalPoint.platformSpreadCents) : null;
    return [{ id: "original", label: "原价", ratio: "1" }, ...discounts.map((discount) => ({ id: discount.id, label: discount.label, ratio: discount.ratio }))].map((discount) => {
      const point = pointFor(row.result!, discount.ratio);
      const renter = point ? centsOf(point.payableRentalCents) : null;
      const owner = point ? centsOf(point.ownerIncomeCents) : null;
      const platform = point ? centsOf(point.platformSpreadCents) : null;
      const reduction = originalPlatform !== null && platform !== null ? originalPlatform - platform : null;
      const reductionTenths = reduction !== null && originalPlatform !== null && originalPlatform !== 0n ? exactPercentTenths(reduction, originalPlatform) : null;
      const closed = renter !== null && owner !== null && platform !== null ? renter === owner + platform : null;
      return {
        key: `${row.id}:${discount.ratio}`,
        scene: row.name,
        summary: row.summary,
        ratio: formatDiscountLabel(discount.ratio),
        renter,
        owner,
        platform,
        originalPlatform,
        reduction,
        reductionTenths,
        floor: point?.ownerFloorSatisfied ?? null,
        closed,
        missing: point ? "" : "响应缺少该折扣点",
      };
    });
  });
  const amountRows = displayRows.filter((row) => row.renter !== null && row.owner !== null && row.platform !== null);
  const riskyRows = amountRows.filter((row) => row.platform !== null && (row.platform < 0n || row.floor === false));
  const openRows = displayRows.filter((row) => row.missing);
  const discountsWithOriginal = [{ id: "original", label: "原价", ratio: "1" }, ...discounts];
  const basisShort = (value: string) => value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="max-h-[90vh] min-w-0 max-w-[calc(100vw-2rem)] overflow-y-auto p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between border-b pb-4">
          <div className="space-y-1">
            <DialogTitle className="text-lg font-bold flex flex-wrap items-center gap-2">
              <LineChart className="size-5 text-primary" />
              <span>三方试算</span>
              <Badge variant="outline" className="text-xs">纯只读</Badge>
              <Badge variant="secondary" className="text-xs">不建单 / 不预留</Badge>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              自定义少量场景与折扣，对照租客租赁费用、号主应得和平台租赁毛利。押金不计入；平台毛利未扣渠道费、分佣和运营成本。
            </DialogDescription>
          </div>
        </div>

        <div className="min-w-0 space-y-4 text-xs">
          {loadingContext ? (
            <div className="space-y-3 p-4 rounded-xl border border-border">
              <div className="text-xs text-muted-foreground">正在读取试算价目与可用物资…</div>
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          ) : contextError ? (
            <Alert variant="warning" role="status">
              <TriangleAlert aria-hidden />
              <AlertTitle>试算依据暂不可用</AlertTitle>
              <AlertDescription><p>{contextError}</p><p>未读取到价目时不生成结果，不以全 0 或旧结果代替。</p></AlertDescription>
            </Alert>
          ) : context ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
                  <div className="space-y-1">
                    <p className="font-semibold text-foreground">本次试算依据</p>
                    <p className="text-xs text-muted-foreground">{context.basisKind === "CURRENT_LISTING" ? "按当前新上架价目试算" : "按会员政策绑定价目试算"}{context.pricingModel === "FIXED_FEE" ? " · 固定手续费" : context.pricingModel?.includes("SPREAD") ? " · 价差" : ""}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">只读假设</Badge>
                </div>
                <details className="rounded-lg border border-border/70 bg-background/60 p-2.5">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground">价目与固定报价条件</summary>
                  <dl className="mt-2 grid gap-1.5 text-[11px] text-muted-foreground sm:grid-cols-2">
                    <div><dt className="inline text-foreground">规则发布：</dt><dd className="inline font-mono">{basisShort(context.ruleReleaseId)}</dd></div>
                    <div><dt className="inline text-foreground">价格版本：</dt><dd className="inline font-mono">{basisShort(context.priceVersionId)}</dd></div>
                    <div><dt className="inline text-foreground">租期版本：</dt><dd className="inline font-mono">{basisShort(context.termVersionId)}</dd></div>
                    <div><dt className="inline text-foreground">固定条件：</dt><dd className="inline">{context.enabledModes[0] ?? "ordinary"} · {context.safeBoxes[0] ?? "未提供"} · {context.termOptions[0]?.code ?? "未提供"}</dd></div>
                  </dl>
                </details>
              </div>

              <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                  <span className="font-semibold text-foreground">对照折扣</span>
                  <span className="text-[11px] text-muted-foreground">原价始终保留；可输入 8折、8.5折</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="font-mono">原价</Badge>
                  {discounts.map((discount) => (
                    <span key={discount.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px]">
                      {discount.label}
                      <button type="button" aria-label={`移除折扣 ${discount.label}`} className="rounded-full text-muted-foreground hover:text-foreground" onClick={() => handleConditionChange(() => setDiscounts((previous) => previous.filter((entry) => entry.id !== discount.id)))}>
                        <X className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <label htmlFor="simulation-discount" className="text-[11px] font-medium text-muted-foreground">添加折扣</label>
                    <div className="flex items-center gap-2">
                      <Input id="simulation-discount" aria-label="添加折扣" value={discountDraft} onChange={(event) => { setDiscountDraft(event.target.value); setDiscountError(null); }} placeholder="如 8折" className="h-9 max-w-40 bg-background text-xs" />
                      <Button type="button" size="sm" variant="outline" className="h-9" onClick={addDiscount}><Plus className="size-3.5 mr-1" aria-hidden />添加</Button>
                    </div>
                  </div>
                  <p className="basis-full text-[11px] text-muted-foreground">输入人类折扣标尺，提交前转换为服务端精确应付比例。</p>
                </div>
                {discountError ? <p className="text-xs text-destructive" role="alert">{discountError}</p> : null}
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">试算场景</span>
                  <Button type="button" size="sm" variant="outline" disabled={scenarios.length >= 4} onClick={addScenario}><Plus className="size-3.5 mr-1" aria-hidden />新增场景</Button>
                </div>
                {scenarios.map((scenario, index) => {
                  const available = context.resources.filter((resource) => !scenario.lines.some((line) => line.resourceId === resource.itemId));
                  return (
                    <div key={scenario.id} className="rounded-xl border border-border bg-card/60 p-3.5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge variant="outline" className="shrink-0 text-[10px]">场景 {index + 1}</Badge>
                          <Input aria-label={`场景 ${index + 1} 名称`} value={scenario.name} onChange={(event) => handleConditionChange(() => setScenarios((previous) => previous.map((entry) => entry.id === scenario.id ? { ...entry, name: event.target.value } : entry)))} className="h-8 min-w-0 max-w-48 bg-background text-xs" />
                        </div>
                        <div className="flex items-center gap-1">
                          <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-[11px]" disabled={scenarios.length >= 4} onClick={() => duplicateScenario(scenario)}><Copy className="size-3 mr-1" aria-hidden />复制</Button>
                          <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-[11px] text-destructive" disabled={scenarios.length <= 1} onClick={() => removeScenario(scenario.id)}><Trash2 className="size-3 mr-1" aria-hidden />删除</Button>
                        </div>
                      </div>
                      {scenario.lines.length ? (
                        <div className="space-y-2">
                          {scenario.lines.map((line) => {
                            const resource = context.resources.find((entry) => entry.itemId === line.resourceId);
                            if (!resource) return null;
                            const unit = simulationUnit(resource);
                            const label = simulationResourceName(resource);
                            return (
                              <div key={line.resourceId} className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-background p-2.5">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs font-medium text-foreground" title={label}>{label}</div>
                                  <div className="text-[10px] text-muted-foreground">{resource.pricingKind === "HAFF_RATIO" ? "按 M 填写，自动换算原始哈夫币数量" : `按${unit}填写整数数量`}</div>
                                </div>
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <Input aria-label={`${scenario.name} ${label} 数量（${unit}）`} inputMode={resource.pricingKind === "HAFF_RATIO" ? "decimal" : "numeric"} value={line.quantity} onChange={(event) => updateLine(scenario.id, line.resourceId, event.target.value)} placeholder={resource.pricingKind === "HAFF_RATIO" ? "如 60" : "如 1"} className="h-8 w-28 bg-card text-right font-mono text-xs" />
                                  <span className="w-6 text-[11px] text-muted-foreground">{unit}</span>
                                </div>
                                <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-[11px]" aria-label={`移除 ${scenario.name} 的 ${label}`} onClick={() => removeLine(scenario.id, line.resourceId)}><X className="size-3" aria-hidden /></Button>
                              </div>
                            );
                          })}
                        </div>
                      ) : <p className="rounded-lg border border-dashed border-border/70 p-3 text-[11px] text-muted-foreground">尚未添加物资；未选择物资不参与本场景。</p>}
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value="" onValueChange={(value) => value && addLine(scenario.id, value)}>
                          <SelectTrigger aria-label={`${scenario.name} 添加物资`} className="h-8 w-full max-w-60 bg-background text-xs"><SelectValue placeholder="添加物资" /></SelectTrigger>
                          <SelectContent>
                            {available.map((resource) => <SelectItem key={resource.itemId} value={resource.itemId}>{simulationResourceName(resource)}（{simulationUnit(resource)}）</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {available.length === 0 ? <span className="text-[11px] text-muted-foreground">可用物资已全部加入</span> : null}
                      </div>
                    </div>
                  );
                })}
                {inputError ? <p className="text-xs text-destructive" role="alert">{inputError}</p> : null}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <p className="text-[11px] text-muted-foreground">每个场景只发一次报价；折扣一次提交，原价作为基准。少量场景串行执行。</p>
                  <Button type="button" className="h-9 px-4" onClick={() => void handleSimulate()} disabled={simulating || !context.resources.length}>{simulating ? "正在试算…" : "开始试算"}</Button>
                </div>
              </div>

              {displayRows.length ? (
                <div className="space-y-3">
                  <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-foreground">{scenarios.length} 个场景 × {discountsWithOriginal.length} 个折扣</p>
                      <Badge variant={riskyRows.length || openRows.length ? "warning" : "success"}>{riskyRows.length ? `${riskyRows.length} 行需注意` : openRows.length ? `${openRows.length} 行待核` : "保底均满足"}</Badge>
                    </div>
                    <p className="text-muted-foreground">三列金额均来自同一次判价响应；租客租赁费用 = 号主应得 + 平台租赁毛利（逐行核对）。{openRows.length ? ` ${openRows.length} 行缺少所需折扣点，未补 0。` : ""}</p>
                  </div>
                  <div className="min-w-0 w-full overflow-x-auto rounded-lg border">
                    <Table className="min-w-[900px] text-xs">
                      <TableHeader>
                        <TableRow>
                          <TableHead>场景 / 物资</TableHead>
                          <TableHead>折扣</TableHead>
                          <TableHead className="text-right">租客租赁费用</TableHead>
                          <TableHead className="text-right">号主应得</TableHead>
                          <TableHead className="text-right">平台租赁毛利</TableHead>
                          <TableHead className="text-right">毛利较原价</TableHead>
                          <TableHead>号主保底</TableHead>
                          <TableHead>金额核对</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {displayRows.map((row) => {
                          const risky = row.platform !== null && (row.platform < 0n || row.floor === false);
                          return (
                            <TableRow key={row.key} className={risky ? "bg-destructive/5" : undefined}>
                              <TableCell>
                                <div className="font-medium text-foreground">{row.scene}</div>
                                <div className="mt-0.5 max-w-72 text-[10px] text-muted-foreground">{row.summary}</div>
                              </TableCell>
                              <TableCell className="font-mono">{row.ratio}</TableCell>
                              <TableCell className="text-right font-mono tabular-nums">{row.renter !== null ? formatCents(row.renter.toString()) : "待核"}</TableCell>
                              <TableCell className="text-right font-mono tabular-nums">{row.owner !== null ? formatCents(row.owner.toString()) : "待核"}</TableCell>
                              <TableCell className={`text-right font-mono tabular-nums ${risky ? "font-semibold text-destructive" : ""}`}>{row.platform !== null ? formatCents(row.platform.toString()) : "待核"}</TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {row.ratio === "原价" ? "—" : row.reduction !== null ? `${row.reduction >= 0n ? "-" : "+"}${formatCents((row.reduction < 0n ? -row.reduction : row.reduction).toString())}${row.reductionTenths !== null ? `（${row.reductionTenths >= 0n ? "-" : "+"}${formatTenthsPercent(row.reductionTenths < 0n ? -row.reductionTenths : row.reductionTenths)}）` : ""}` : "待核"}
                              </TableCell>
                              <TableCell>
                                {row.floor === null ? <span className="text-[11px] text-muted-foreground">待核</span> : row.floor ? <Badge variant="outline" className="border-emerald-300 text-emerald-600">满足</Badge> : <Badge variant="destructive">低于底线</Badge>}
                              </TableCell>
                              <TableCell className="text-[11px]">
                                {row.missing ? <span className="text-destructive">{row.missing}</span> : row.closed === null ? <span className="text-muted-foreground">待核</span> : row.closed ? <span className="text-emerald-600 dark:text-emerald-400">闭合</span> : <span className="text-destructive">差额 {formatCents((row.renter! - row.owner! - row.platform!).toString())}</span>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-[11px] text-muted-foreground">租客租赁费用、号主应得、平台租赁毛利是本次封存价目的 what-if 合计，不是实际订单、结算利润或号主净利润；押金不计入。负毛利只表示试算结果，不能用于实际核价。</p>
                </div>
              ) : simulating ? (
                <p className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground" role="status">正在按场景逐一试算，结果会随完成情况更新…</p>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  添加场景与物资、填写数量和折扣后点击「开始试算」。原价会作为基准与每个折扣同表对照。
                </div>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
