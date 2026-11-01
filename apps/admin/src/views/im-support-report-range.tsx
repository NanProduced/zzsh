"use client";

/**
 * 客服统计/我的接待共用的轻量时间范围选择。
 *
 * 快捷区间以服务端 serverNow 的北京日期为锚点；默认“今日”不向请求写入浏览器日期。
 * 自定义区间复用 ReUI DateSelector，最终合法性仍由服务端复核。
 */
import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, CircleHelp } from "lucide-react";
import { Button } from "../components/ui/button";
import { DateSelector, type DateSelectorValue } from "../components/reui/date-selector";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { beijingCalendarDate } from "../workspace/beijing-time";
import type { SupportReportPeriod } from "./im-support-management-model";

export const SUPPORT_REPORT_MAX_DAYS = 366;

export type SupportReportRange = { dateFrom: string; dateTo: string };
export type SupportRangePreset = "today" | "7d" | "month" | "lastMonth" | "30d" | "year" | "custom";
export type SupportRangeSelection = { preset: SupportRangePreset; range: SupportReportRange | null };

const DAY_MS = 86_400_000;
const PRESETS: Array<{ key: Exclude<SupportRangePreset, "custom">; label: string }> = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近 7 天" },
  { key: "month", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "30d", label: "近 30 天" },
  { key: "year", label: "本年" },
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isSupportDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dayMs(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

export function addSupportDays(value: string, days: number): string {
  return new Date(dayMs(value) + days * DAY_MS).toISOString().slice(0, 10);
}

export function supportRangeDays(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;
}

export function localDay(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function anchorDateOf(serverNow: string | null | undefined): string | null {
  if (!serverNow) return null;
  const parsed = new Date(serverNow);
  return Number.isFinite(parsed.getTime()) ? beijingCalendarDate(parsed) : null;
}

export function presetRange(preset: Exclude<SupportRangePreset, "custom">, anchor: string): SupportReportRange {
  if (preset === "today") return { dateFrom: anchor, dateTo: anchor };
  if (preset === "7d") return { dateFrom: addSupportDays(anchor, -6), dateTo: anchor };
  if (preset === "30d") return { dateFrom: addSupportDays(anchor, -29), dateTo: anchor };
  if (preset === "year") return { dateFrom: `${anchor.slice(0, 4)}-01-01`, dateTo: anchor };
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  if (preset === "month") return { dateFrom: `${year}-${pad(month)}-01`, dateTo: anchor };
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const previousYear = previous.getUTCFullYear();
  const previousMonth = previous.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(previousYear, previousMonth, 0)).getUTCDate();
  return { dateFrom: `${previousYear}-${pad(previousMonth)}-01`, dateTo: `${previousYear}-${pad(previousMonth)}-${pad(lastDay)}` };
}

export function validateSupportRange(dateFrom: string, dateTo: string): { ok: true } | { ok: false; error: string } {
  if (!dateFrom || !dateTo) return { ok: false, error: "请选择完整的起止日期" };
  if (!isSupportDay(dateFrom) || !isSupportDay(dateTo)) return { ok: false, error: "日期格式无效" };
  if (dateFrom > dateTo) return { ok: false, error: "开始日期不能晚于结束日期" };
  if (supportRangeDays(dateFrom, dateTo) > SUPPORT_REPORT_MAX_DAYS) return { ok: false, error: "区间最多 366 天" };
  return { ok: true };
}

export function resolveSupportRange(selection: SupportRangeSelection, anchor: string | null): { range: SupportReportRange | null; query: string; error?: string } {
  if (selection.preset === "custom") {
    if (!selection.range) return { range: null, query: "", error: "请选择完整的起止日期" };
    const checked = validateSupportRange(selection.range.dateFrom, selection.range.dateTo);
    if (!checked.ok) return { range: selection.range, query: "", error: checked.error };
    return { range: selection.range, query: `?dateFrom=${selection.range.dateFrom}&dateTo=${selection.range.dateTo}` };
  }
  if (selection.preset === "today") {
    return { range: anchor ? { dateFrom: anchor, dateTo: anchor } : null, query: "" };
  }
  if (!anchor) return { range: selection.range, query: "", error: "等待服务器时间后再选择范围" };
  const range = presetRange(selection.preset, anchor);
  const checked = validateSupportRange(range.dateFrom, range.dateTo);
  if (!checked.ok) return { range, query: "", error: checked.error };
  return { range, query: `?dateFrom=${range.dateFrom}&dateTo=${range.dateTo}` };
}

export function sameSupportRange(left: SupportReportRange | null | undefined, right: SupportReportRange | null | undefined): boolean {
  return !!left && !!right && left.dateFrom === right.dateFrom && left.dateTo === right.dateTo;
}

export function periodRange(period: SupportReportPeriod | null | undefined): SupportReportRange | null {
  return period ? { dateFrom: period.dateFrom, dateTo: period.dateTo } : null;
}

export function rangeLabel(range: SupportReportRange | null, anchor: string | null): string {
  if (!range) return "选择时间范围";
  const days = supportRangeDays(range.dateFrom, range.dateTo);
  if (days === 1) return range.dateFrom === anchor ? `${range.dateFrom}（今日）` : range.dateFrom;
  return `${range.dateFrom} 至 ${range.dateTo} · ${days} 天`;
}

export function rangeScopeWord(range: SupportReportRange | null, anchor: string | null): string {
  return range && anchor && range.dateFrom === anchor && range.dateTo === anchor ? "今日" : "期间";
}

export function SupportInfoHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger
      render={<button type="button" aria-label={label} className="im-support-info-hint" onClick={() => setOpen(true)} onBlur={() => setOpen(false)} />}
    >
      <CircleHelp size={13} aria-hidden />
    </TooltipTrigger>
    <TooltipContent className="max-w-72">{children}</TooltipContent>
  </Tooltip>;
}

function selectorValue(range: SupportReportRange | null): DateSelectorValue {
  return {
    period: "day",
    operator: "between",
    startDate: range ? new Date(`${range.dateFrom}T00:00:00`) : undefined,
    endDate: range ? new Date(`${range.dateTo}T00:00:00`) : undefined,
  };
}

export function SupportReportRangePicker({
  value,
  displayRange,
  anchorDate,
  disabled = false,
  onChange,
}: {
  value: SupportRangeSelection;
  displayRange?: SupportReportRange | null;
  anchorDate: string | null;
  disabled?: boolean;
  onChange: (value: SupportRangeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateSelectorValue>(() => selectorValue(displayRange ?? value.range));
  const [rangeError, setRangeError] = useState("");
  const label = displayRange ? rangeLabel(displayRange, anchorDate) : value.preset === "today" ? "今日" : rangeLabel(value.range, anchorDate);

  useEffect(() => {
    if (!open) return;
    setDraft(selectorValue(displayRange ?? value.range));
    setRangeError("");
  }, [open, displayRange?.dateFrom, displayRange?.dateTo, value.range?.dateFrom, value.range?.dateTo]);

  const applyPreset = (preset: Exclude<SupportRangePreset, "custom">) => {
    if (!anchorDate) return;
    onChange({ preset, range: presetRange(preset, anchorDate) });
    setOpen(false);
  };

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      disabled={disabled}
      render={<Button type="button" variant="outline" size="sm" className="im-support-range-trigger" data-range-trigger aria-label={`统计时间范围：${label}`} />}
    >
      <CalendarDays size={14} aria-hidden />
      <span>{label}</span>
    </PopoverTrigger>
    <PopoverContent className="im-support-range-popover" align="end">
      <div className="im-support-range-presets" role="group" aria-label="快捷时间范围">
        {PRESETS.map((preset) => <Button
          key={preset.key}
          type="button"
          size="xs"
          variant={value.preset === preset.key ? "secondary" : "ghost"}
          data-range-preset={preset.key}
          disabled={!anchorDate}
          onClick={() => applyPreset(preset.key)}
        >{preset.label}</Button>)}
      </div>
      <div className="im-support-range-custom">
        <span>自定义日期</span>
        <DateSelector
          value={draft}
          onChange={(next) => {
            setDraft(next);
            if (!next.startDate || !next.endDate) {
              setRangeError("");
              return;
            }
            const range = { dateFrom: localDay(next.startDate), dateTo: localDay(next.endDate) };
            const checked = validateSupportRange(range.dateFrom, range.dateTo);
            if (!checked.ok) {
              setRangeError(checked.error);
              return;
            }
            setRangeError("");
            onChange({ preset: "custom", range });
            setOpen(false);
          }}
          presetMode="between"
          allowRange
          showInput={false}
          showTwoMonths={false}
          dayDateFormat="yyyy-MM-dd"
        />
      </div>
      {rangeError ? <p className="im-support-range-error" role="alert">{rangeError}</p> : null}
      <p className="im-support-range-hint">北京时间，起止日期均包含，最多 366 天</p>
    </PopoverContent>
  </Popover>;
}
