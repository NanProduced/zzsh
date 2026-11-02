import * as React from "react";
import { cn } from "../../lib/utils";
import { ChartContext, type ChartConfig } from "../../vendor/evilcharts/recharts-core";

export { ChartArea, ChartBar, ChartTooltip, ChartTooltipContent, ChartLegendContent, getPayloadConfigFromPayload, type ChartConfig } from "../../vendor/evilcharts/recharts-core";
export { AreaChart, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

/** EvilCharts context/container adaptation: real plot width, never a fabricated initial width. */
export function ChartContainer({ config, children, label, legend, emptyState, height = 240, className }: { config: ChartConfig; children: React.ReactElement | null; label: string; legend?: React.ReactNode; emptyState?: React.ReactNode; height?: number; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null), [width, setWidth] = React.useState(0), id = `chart-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(0, Math.floor(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <ChartContext.Provider value={{ config }}><div data-slot="chart" data-chart={id} className={cn("chart-container", className)} role="group" aria-label={label}>
    {legend}
    <div ref={ref} className="chart-plot" style={{ height: children ? height : undefined }} data-chart-width={width}>
      {!children ? emptyState : width > 0 ? React.cloneElement(children as React.ReactElement<{ width?: number; height?: number; accessibilityLayer?: boolean; "aria-label"?: string }>, { width, height, accessibilityLayer: true, "aria-label": label }) : <span className="chart-measuring" role="status">图表将在可见时绘制</span>}
    </div>
  </div></ChartContext.Provider>;
}
