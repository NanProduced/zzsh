/**
 * ReUI Base UI Date Selector (free registry primitive), vendored 2026-10-20.
 * Source: https://reui.io/r/date-selector.json — MIT notice: https://reui.io/legal/license
 *
 * Adapted to this app: the upstream demo depends on an app-local `IconPlaceholder`
 * and on a `cn` package path that do not exist here, so the icons come from the
 * already-installed lucide-react and the class helper from @/lib/utils. The
 * registry's month/quarter/half-year/year period tabs are not needed for a
 * registration-date range filter, so only the day period is enabled; the range
 * operator, the Chinese labels and the Monday-first week are kept.
 */
"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { addMonths, format, isBefore, isSameMonth, subMonths } from "date-fns"
import type { DateRange, DayButton } from "react-day-picker"
import { zhCN } from "react-day-picker/locale"
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar, CalendarDayButton } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { beijingCalendarDate } from "@/workspace/beijing-time"

// Calendar uses local Date objects; anchor their calendar day to Beijing.
const calendarToday = () => new Date(`${beijingCalendarDate()}T00:00:00`)

export type DateSelectorPeriodType = "day" | "month" | "quarter" | "half-year" | "year"
export type DateSelectorFilterType = "is" | "before" | "after" | "between"

export interface DateSelectorValue {
  period: DateSelectorPeriodType
  operator: DateSelectorFilterType
  startDate?: Date
  endDate?: Date
}

export interface DateSelectorI18nConfig {
  filterTypes: { is: string; before: string; after: string; between: string }
  months: string[]
  monthsShort: string[]
  weekdaysShort: string[]
  placeholder: string
  rangePlaceholder: string
  today: string
}

export const DEFAULT_DATE_SELECTOR_I18N: DateSelectorI18nConfig = {
  filterTypes: { is: "当天", before: "之前", after: "之后", between: "区间" },
  months: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  monthsShort: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  weekdaysShort: ["日", "一", "二", "三", "四", "五", "六"],
  placeholder: "选择日期…",
  rangePlaceholder: "选择日期区间…",
  today: "回到今天",
}

export function formatDateValue(
  value: DateSelectorValue,
  i18n: DateSelectorI18nConfig = DEFAULT_DATE_SELECTOR_I18N,
  dayDateFormat = "yyyy-MM-dd"
): string {
  const { startDate, endDate } = value
  if (startDate && endDate) return `${format(startDate, dayDateFormat)} 至 ${format(endDate, dayDateFormat)}`
  if (startDate) return format(startDate, dayDateFormat)
  return ""
}

/** Where a calendar month sits against today's month. */
function getMonthPosition(month: Date | undefined) {
  const today = calendarToday()
  if (!month || isSameMonth(month, today)) return "current"
  return month > today ? "future" : "past"
}

export interface UseDateSelectorOptions {
  value?: DateSelectorValue
  onChange?: (value: DateSelectorValue) => void
  defaultFilterType?: DateSelectorFilterType
  presetMode?: DateSelectorFilterType
  allowRange?: boolean
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
}

export function useDateSelector({
  value,
  onChange,
  defaultFilterType = "is",
  presetMode,
  allowRange = true,
  weekStartsOn,
}: UseDateSelectorOptions) {
  // The selection is fully controlled: onChange fires only on a user action, never on mount.
  const [calendarMonth, setCalendarMonth] = useState<Date>(value?.startDate ?? calendarToday())
  const [hoverDate, setHoverDate] = useState<Date | undefined>()

  const filterType = presetMode ?? value?.operator ?? defaultFilterType
  const selectedDate = value?.startDate
  const selectedEndDate = value?.endDate

  const emit = useRef(onChange)
  emit.current = onChange

  const currentValue = useMemo<DateSelectorValue>(
    () => ({
      period: "day",
      operator: filterType,
      startDate: selectedDate,
      endDate: selectedEndDate,
    }),
    [filterType, selectedDate, selectedEndDate]
  )

  const clearSelection = useCallback(() => {
    emit.current?.({ period: "day", operator: filterType, startDate: undefined, endDate: undefined })
  }, [filterType])

  const handleDayClick = useCallback(
    (day: Date) => {
      if (filterType === "between" && allowRange) {
        if (!selectedDate || selectedEndDate) {
          emit.current?.({ period: "day", operator: filterType, startDate: day, endDate: undefined })
        } else if (isBefore(day, selectedDate)) {
          emit.current?.({ period: "day", operator: filterType, startDate: day, endDate: selectedDate })
        } else {
          emit.current?.({ period: "day", operator: filterType, startDate: selectedDate, endDate: day })
        }
      } else {
        emit.current?.({ period: "day", operator: filterType, startDate: day, endDate: undefined })
      }
    },
    [filterType, allowRange, selectedDate, selectedEndDate]
  )

  const handleFilterTypeChange = useCallback(
    (type: DateSelectorFilterType) => {
      if (presetMode !== undefined) return
      emit.current?.({ period: "day", operator: type, startDate: undefined, endDate: undefined })
    },
    [presetMode]
  )

  return {
    filterType,
    selectedDate,
    selectedEndDate,
    calendarMonth,
    hoverDate,
    currentValue,
    allowRange,
    weekStartsOn,
    setCalendarMonth,
    setHoverDate,
    setFilterType: handleFilterTypeChange,
    clearSelection,
    handleDayClick,
  }
}

function DateSelectorFilterToggle({
  value,
  onChange,
  showBetween,
  presetMode,
  i18n,
  className,
}: {
  value: DateSelectorFilterType
  onChange: (value: DateSelectorFilterType) => void
  showBetween: boolean
  presetMode?: DateSelectorFilterType
  i18n: DateSelectorI18nConfig
  className?: string
}) {
  const isDisabled = presetMode !== undefined
  const options: [DateSelectorFilterType, string][] = [
    ["is", i18n.filterTypes.is],
    ["before", i18n.filterTypes.before],
    ["after", i18n.filterTypes.after],
    ...(showBetween ? ([["between", i18n.filterTypes.between]] as [DateSelectorFilterType, string][]) : []),
  ]
  return (
    <div role="group" aria-label="日期筛选方式" className={cn("ud-date-operator", className)}>
      {options.map(([key, label]) => (
        <Button
          key={key}
          type="button"
          size="xs"
          variant={value === key ? "secondary" : "ghost"}
          aria-pressed={value === key}
          disabled={isDisabled}
          onClick={() => onChange(key)}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}

function DateSelectorDayPicker({
  currentMonth,
  selectedDate,
  selectedEndDate,
  onDayClick,
  isRange,
  onDayHover,
  hoverDate,
  showTwoMonths = true,
  weekStartsOn,
  i18n,
  className,
}: {
  currentMonth: Date
  selectedDate?: Date
  selectedEndDate?: Date
  onDayClick: (day: Date) => void
  isRange: boolean
  onDayHover?: (day: Date | undefined) => void
  hoverDate?: Date
  showTwoMonths?: boolean
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
  i18n: DateSelectorI18nConfig
  className?: string
}) {
  const isMobile = useIsMobile()

  const selected: Date | DateRange | undefined = isRange
    ? selectedDate && selectedEndDate
      ? { from: selectedDate, to: selectedEndDate }
      : selectedDate
        ? { from: selectedDate, to: hoverDate || selectedDate }
        : undefined
    : selectedDate

  const handleSelect = (_selection: Date | DateRange | undefined, triggerDate: Date) => onDayClick(triggerDate)

  const CustomDayButton = useCallback(
    (props: React.ComponentProps<typeof DayButton>) => (
      <CalendarDayButton
        {...props}
        onMouseEnter={() => {
          if (isRange && onDayHover && props.day) onDayHover(props.day.date)
        }}
        onMouseLeave={() => {
          if (isRange && onDayHover) onDayHover(undefined)
        }}
      />
    ),
    [isRange, onDayHover]
  )

  const formatters = useMemo(
    () => ({
      formatWeekdayName: (date: Date) => i18n.weekdaysShort[date.getDay()] ?? "",
      formatCaption: (date: Date) => `${i18n.months[date.getMonth()]} ${date.getFullYear()}`,
    }),
    [i18n]
  )

  const common = {
    month: currentMonth,
    numberOfMonths: isMobile ? 1 : showTwoMonths ? 2 : 1,
    showOutsideDays: true,
    weekStartsOn,
    formatters,
    locale: zhCN,
    today: calendarToday(),
    className: "ud-date-grid",
    classNames: { months: "ud-date-months", month: "ud-date-month", nav: "hidden" },
    components: { DayButton: CustomDayButton },
  }

  return (
    <div className={cn("ud-date-calendar", className)}>
      {isRange ? (
        <Calendar
          key="range"
          {...common}
          mode="range"
          selected={selected as DateRange | undefined}
          onSelect={handleSelect as (value: DateRange | undefined) => void}
        />
      ) : (
        <Calendar
          key="single"
          {...common}
          mode="single"
          selected={selected as Date | undefined}
          onSelect={handleSelect as (value: Date | undefined) => void}
        />
      )}
    </div>
  )
}

/** 快捷范围：只给真正用得上的几档，标签与实际范围一一对应。 */
export interface DateSelectorPreset {
  label: string
  /** Days counted back from today, inclusive; 0 means today only. */
  days: number
}

export interface DateSelectorProps {
  value?: DateSelectorValue
  onChange?: (value: DateSelectorValue) => void
  allowRange?: boolean
  defaultFilterType?: DateSelectorFilterType
  presetMode?: DateSelectorFilterType
  showInput?: boolean
  showTwoMonths?: boolean
  label?: string
  className?: string
  i18n?: Partial<DateSelectorI18nConfig>
  dayDateFormat?: string
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
  presets?: DateSelectorPreset[]
}

export function DateSelector({
  value,
  onChange,
  allowRange = true,
  defaultFilterType = "is",
  presetMode,
  showInput = true,
  showTwoMonths = true,
  label,
  className,
  i18n: i18nOverride,
  dayDateFormat = "yyyy-MM-dd",
  weekStartsOn = 1,
  presets,
}: DateSelectorProps) {
  const mergedI18n = useMemo(() => ({ ...DEFAULT_DATE_SELECTOR_I18N, ...i18nOverride }), [i18nOverride])
  const selector = useDateSelector({ value, onChange, defaultFilterType, presetMode, allowRange, weekStartsOn })
  const { filterType, selectedDate, selectedEndDate, calendarMonth, hoverDate, currentValue, setCalendarMonth, setHoverDate, setFilterType, clearSelection, handleDayClick } = selector

  const displayValue = formatDateValue(currentValue, mergedI18n, dayDateFormat)
  const monthPosition = getMonthPosition(calendarMonth)

  return (
    <div className={cn("ud-date-selector", className)}>
      {label ? <span className="ud-date-label">{label}</span> : null}
      <DateSelectorFilterToggle
        value={filterType}
        onChange={setFilterType}
        showBetween={allowRange}
        presetMode={presetMode}
        i18n={mergedI18n}
      />
      {showInput ? (
        <div className="ud-date-input">
          <Input
            type="text"
            readOnly
            value={displayValue}
            placeholder={filterType === "between" ? mergedI18n.rangePlaceholder : mergedI18n.placeholder}
            aria-label={filterType === "between" ? mergedI18n.rangePlaceholder : mergedI18n.placeholder}
          />
          {displayValue ? (
            <Button type="button" variant="ghost" size="icon-xs" className="ud-date-clear" aria-label="清空日期" onClick={clearSelection}>
              <XIcon className="size-3" aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
      {presets?.length ? (
        <div className="ud-date-presets" role="group" aria-label="快捷日期范围">
          {presets.map(preset => (
            <Button
              key={preset.label}
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                const end = calendarToday()
                const start = new Date(end.getTime())
                start.setDate(start.getDate() - Math.max(0, preset.days - 1))
                onChange?.({ period: "day", operator: "between", startDate: start, endDate: end })
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="ud-date-nav">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="上一个月" onClick={() => setCalendarMonth(subMonths(calendarMonth, 1))}>
          <ChevronLeftIcon className="size-4" aria-hidden />
        </Button>
        <span className="ud-date-caption" aria-live="polite">
          {mergedI18n.months[calendarMonth.getMonth()]} {calendarMonth.getFullYear()}
        </span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="下一个月" onClick={() => setCalendarMonth(addMonths(calendarMonth, 1))}>
          <ChevronRightIcon className="size-4" aria-hidden />
        </Button>
        {monthPosition !== "current" ? (
          <Button type="button" variant="ghost" size="xs" className="ud-date-today" onClick={() => setCalendarMonth(calendarToday())}>
            {mergedI18n.today}
          </Button>
        ) : null}
      </div>
      <DateSelectorDayPicker
        currentMonth={calendarMonth}
        selectedDate={selectedDate}
        selectedEndDate={selectedEndDate}
        onDayClick={handleDayClick}
        isRange={filterType === "between" && allowRange}
        onDayHover={setHoverDate}
        hoverDate={hoverDate}
        showTwoMonths={showTwoMonths}
        weekStartsOn={weekStartsOn}
        i18n={mergedI18n}
      />
    </div>
  )
}
