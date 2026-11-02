/*! Selectively adapted from EvilCharts, Copyright (c) 2026 Gurbinder, MIT. See LICENSE and COPYING.md. */
import * as React from "react";
import { Area, Bar, Tooltip } from "recharts";
import { Button } from "../../components/ui/button";

export type ChartConfig = Record<string, { label: string; color: string }>;
export const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);
export function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error("Chart primitives must be used inside ChartContainer");
  return context;
}

/** Upstream payload indirection preserves labels for named series and nested payloads. */
export function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const nested = "payload" in payload && typeof payload.payload === "object" && payload.payload !== null ? payload.payload : undefined;
  let configKey = key;
  if (key in payload && typeof payload[key as keyof typeof payload] === "string") configKey = payload[key as keyof typeof payload] as string;
  else if (nested && key in nested && typeof nested[key as keyof typeof nested] === "string") configKey = nested[key as keyof typeof nested] as string;
  return configKey in config ? config[configKey] : config[key];
}

function ColorGradient({ id, color }: { id: string; color: string }) {
  return <linearGradient id={`${id}-colors`} x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={color} /><stop offset="100%" stopColor={color} /></linearGradient>;
}

/** The upstream area's horizontal color paint and vertical opacity mask are retained. */
export function ChartArea({ dataKey, ...props }: Omit<React.ComponentProps<typeof Area>, "dataKey" | "fill" | "stroke" | "connectNulls" | "isAnimationActive"> & { dataKey: string }) {
  const { config } = useChart(), id = `evil-area-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`, color = config[dataKey]?.color;
  if (!color) return null;
  return <>
    <Area type="monotone" dot={false} activeDot={{ r: 3 }} strokeWidth={2} {...props} dataKey={dataKey} stroke={`url(#${id}-colors)`} fill={`url(#${id}-gradient)`} fillOpacity={0.8} connectNulls={false} isAnimationActive={false} />
    <defs>
      <ColorGradient id={id} color={color} />
      <linearGradient id={`${id}-vertical-fade`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="white" stopOpacity={0.28} /><stop offset="100%" stopColor="white" stopOpacity={0} /></linearGradient>
      <mask id={`${id}-gradient-mask`}><rect width="100%" height="100%" fill={`url(#${id}-vertical-fade)`} /></mask>
      <pattern id={`${id}-gradient`} patternUnits="userSpaceOnUse" width="100%" height="100%"><rect width="100%" height="100%" fill={`url(#${id}-colors)`} mask={`url(#${id}-gradient-mask)`} /></pattern>
    </defs>
  </>;
}

/** The upstream per-series scoped color gradient and static Recharts bar core are retained. */
export function ChartBar({ dataKey, ...props }: Omit<React.ComponentProps<typeof Bar>, "dataKey" | "fill" | "isAnimationActive"> & { dataKey: string }) {
  const { config } = useChart(), id = `evil-bar-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`, color = config[dataKey]?.color;
  if (!color) return null;
  return <><Bar radius={[3, 3, 0, 0]} maxBarSize={28} {...props} dataKey={dataKey} fill={`url(#${id}-colors)`} isAnimationActive={false} /><defs><ColorGradient id={id} color={color} /></defs></>;
}

type TooltipItem = { dataKey?: string | number; name?: string | number; type?: string; payload?: unknown };
export function ChartTooltipContent({ active, payload, label, formatValue }: { active?: boolean; label?: string | number; payload?: readonly TooltipItem[]; formatValue: (point: Record<string, unknown>, dataKey: string) => React.ReactNode }) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip" role="status" aria-live="polite">
    <p className="font-medium">{String(label ?? "")}</p>
    {payload.filter(item => item.type !== "none").map((item, index) => {
      const key = String(item.dataKey ?? item.name ?? ""), series = getPayloadConfigFromPayload(config, item, key);
      const point = item.payload && typeof item.payload === "object" ? item.payload as Record<string, unknown> : {};
      return <div key={`${key}-${index}`} className="chart-tooltip-row"><span className="chart-legend-indicator" style={{ background: series?.color }} aria-hidden="true" /><span className="text-muted-foreground">{series?.label ?? item.name}</span><strong className="tabular-nums">{formatValue(point, key)}</strong></div>;
    })}
  </div>;
}

export function ChartTooltip(props: React.ComponentProps<typeof Tooltip>) {
  return <Tooltip {...props} animationDuration={0} wrapperStyle={{ ...props.wrapperStyle, pointerEvents: "none" }} />;
}

export type ChartLegendItem = { dataKey: string; type?: string; disabled?: boolean; disabledReason?: string };
/** Upstream config/payload label mapping, with house buttons replacing clickable divs. */
export function ChartLegendContent({ payload, selected, onSelect, label = "图例" }: { payload: readonly ChartLegendItem[]; selected: string | null; onSelect?: (key: string) => void; label?: string }) {
  const { config } = useChart();
  return <div className="chart-legend" role="group" aria-label={label}>{payload.filter(item => item.type !== "none").map(item => {
    const series = getPayloadConfigFromPayload(config, item, item.dataKey), active = selected === item.dataKey;
    const content = <><span className="chart-legend-indicator" style={{ background: series?.color }} aria-hidden="true" />{series?.label}</>;
    return onSelect ? <Button key={item.dataKey} type="button" variant={active ? "secondary" : "ghost"} size="sm" disabled={item.disabled} aria-pressed={active} aria-label={item.disabledReason ? `${series?.label}：${item.disabledReason}` : series?.label} onClick={() => onSelect(item.dataKey)}>{content}</Button> : <span key={item.dataKey} className="chart-legend-label">{content}</span>;
  })}</div>;
}
