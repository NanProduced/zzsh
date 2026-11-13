import { useEffect, useState } from 'react';
import { CalendarDaysIcon, ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DateSelector, type DateSelectorValue } from '@/components/reui/date-selector';
import { useIsMobile } from '@/hooks/use-mobile';
import { ListToolbarEnumSelect } from '@/components/admin-list';
import { STATUS_LABEL, type Filters } from './user-directory-data';

const TIER_OPTIONS: [string, string][] = [['PENDING', '等级待核'], ['STANDARD', '普通会员'], ['SILVER', '银卡会员'], ['GOLD', '金卡会员'], ['PLATINUM', '铂金会员'], ['DIAMOND', '钻石会员'], ['BLACK_GOLD', '黑金会员']];
const ENTITLEMENT_OPTIONS: [string, string][] = [['ANY', '有有效礼遇'], ['FRIEND', '挚友礼遇'], ['PRESTIGE', '尊享礼遇'], ['NONE', '无有效礼遇']];
const RISK_OPTIONS: [string, string][] = [['FLAGGED', '高危'], ['NOT_FLAGGED', '非高危']];

const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * 注册日期区间：起始日含当日，结束日含当日；只改草稿，查询时才提交。
 * 区间选完直接回到草稿，不再多一层“确定→查询”。
 */
function RegistrationDateRange({ from, to, onChange, localFiling = false }: { from: string; to: string; onChange: (patch: Partial<Filters>) => void; localFiling?: boolean }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateSelectorValue>({
    period: 'day',
    operator: 'between',
    startDate: from ? new Date(`${from}T00:00:00`) : undefined,
    endDate: to ? new Date(`${to}T00:00:00`) : undefined,
  });
  const [saved, setSaved] = useState({ from, to });

  useEffect(() => { setSaved({ from, to }); }, [from, to]);
  // Opening the popover starts from the applied range, so closing without a complete range keeps it.
  useEffect(() => {
    if (!open) return;
    setDraft({
      period: 'day',
      operator: 'between',
      startDate: saved.from ? new Date(`${saved.from}T00:00:00`) : undefined,
      endDate: saved.to ? new Date(`${saved.to}T00:00:00`) : undefined,
    });
  }, [open, saved.from, saved.to]);

  const label = from || to ? `${from || '不限'} 至 ${to || '不限'}` : '不限';
  return (
    <Field label={localFiling ? "建档日期" : "注册日期"} className="ud-field">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" className="ud-date-trigger" aria-label={localFiling ? "建档日期" : "注册日期"} />}>
          <CalendarDaysIcon size={15} aria-hidden />
          {label}
        </PopoverTrigger>
        <PopoverContent className="ud-date-popover" align="start">
          <DateSelector
            value={draft}
            onChange={next => {
              setDraft(next);
              // A finished range goes back to the draft; an unfinished range is not submitted.
              if (next.startDate && next.endDate) {
                onChange({ from: isoDay(next.startDate), to: isoDay(next.endDate) });
                setOpen(false);
              }
            }}
            presetMode="between"
            allowRange
            showTwoMonths={!mobile}
            dayDateFormat="yyyy-MM-dd"
            presets={[{ label: '近 7 天', days: 7 }, { label: '近 30 天', days: 30 }, { label: '近 90 天', days: 90 }]}
          />
          <div className="ud-date-actions">
            <Button type="button" variant="outline" size="sm" onClick={() => { setDraft({ period: 'day', operator: 'between' }); onChange({ from: '', to: '' }); setOpen(false); }}>清空</Button>
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

const CREDIT_PRESETS = [
  { label: '全部', min: '', max: '' },
  { label: '100 满分', min: '100', max: '100' },
  { label: '≥80 良好', min: '80', max: '100' },
  { label: '60–79 警示', min: '60', max: '79' },
  { label: '<60 低信用', min: '0', max: '59' },
] as const;

/**
 * 信用分区间筛选：预设 0–100 常用业务分段（通常以 10/20 整数扣减）；支持自定义精确区间。
 */
function CreditRangeFilter({
  creditMin,
  creditMax,
  onChange,
}: {
  creditMin: string;
  creditMax: string;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftMin, setDraftMin] = useState(creditMin);
  const [draftMax, setDraftMax] = useState(creditMax);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftMin(creditMin);
    setDraftMax(creditMax);
    setError(null);
  }, [creditMin, creditMax, open]);

  const preset = CREDIT_PRESETS.find(p => p.min === creditMin && p.max === creditMax);
  let label = '全部';
  if (preset && preset.min !== '') label = preset.label;
  else if (creditMin === '100' && creditMax === '100') label = '100 满分';
  else if (creditMin && creditMax) label = `${creditMin}–${creditMax}分`;
  else if (creditMin) label = `≥${creditMin}分`;
  else if (creditMax) label = `≤${creditMax}分`;

  const applyCustom = () => {
    const min = draftMin.trim();
    const max = draftMax.trim();
    if (min && !/^(0|[1-9]\d?|100)$/.test(min)) {
      setError('最低分应为 0–100 整数');
      return;
    }
    if (max && !/^(0|[1-9]\d?|100)$/.test(max)) {
      setError('最高分应为 0–100 整数');
      return;
    }
    if (min && max && Number(min) > Number(max)) {
      setError('最低分不能大于最高分');
      return;
    }
    setError(null);
    onChange({ creditMin: min, creditMax: max });
    setOpen(false);
  };

  const clear = () => {
    setDraftMin('');
    setDraftMax('');
    setError(null);
    onChange({ creditMin: '', creditMax: '' });
    setOpen(false);
  };

  return (
    <Field label="信用分" composite className="ud-field ud-credit-filter">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" className="ud-credit-trigger" aria-label="信用分" />}>
          <span className="truncate">{label}</span>
          <ChevronDownIcon size={14} className="ml-auto opacity-50 shrink-0" aria-hidden />
        </PopoverTrigger>
        <PopoverContent className="ud-credit-popover" align="start">
          <div className="space-y-3">
            <div>
              <span className="text-xs font-medium text-muted-foreground mb-1.5 block">常用分档</span>
              <div className="grid grid-cols-2 gap-1.5">
                {CREDIT_PRESETS.map(p => {
                  const active = p.min === (creditMin || '') && p.max === (creditMax || '');
                  return (
                    <Button
                      key={p.label}
                      type="button"
                      variant={active ? 'default' : 'outline'}
                      size="xs"
                      onClick={() => {
                        onChange({ creditMin: p.min, creditMax: p.max });
                        setOpen(false);
                      }}
                      className="text-xs h-7 justify-start px-2 font-normal"
                    >
                      {p.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="pt-2 border-t border-border">
              <span className="text-xs font-medium text-muted-foreground mb-1.5 block">自定义区间 (0–100)</span>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={10}
                  inputMode="numeric"
                  aria-label="最低信用分"
                  placeholder="最低分"
                  value={draftMin}
                  onChange={e => { setDraftMin(e.target.value); setError(null); }}
                  className="h-8 text-xs tabular-nums"
                />
                <span className="text-muted-foreground" aria-hidden>–</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={10}
                  inputMode="numeric"
                  aria-label="最高信用分"
                  placeholder="最高分"
                  value={draftMax}
                  onChange={e => { setDraftMax(e.target.value); setError(null); }}
                  className="h-8 text-xs tabular-nums"
                />
              </div>
              {error ? <p className="text-[11px] text-destructive mt-1.5" role="alert">{error}</p> : null}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button type="button" variant="ghost" size="xs" onClick={clear} className="text-xs h-7">
                清空
              </Button>
              <Button type="button" size="xs" onClick={applyCustom} className="text-xs h-7">
                确定
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

/** 紧凑业务筛选：桌面一行可换行；窄屏先给状态与日期，其余行内折叠，不再藏进侧边抽屉。 */
export function FilterFields({ filters, change, variant }: { filters: Filters; change: (patch: Partial<Filters>) => void; variant: 'primary' | 'rest' | 'all' }) {
  return (
    <div className="ud-filter-fields">
      {variant !== 'rest' ? (
        <>
          <ListToolbarEnumSelect label="账号状态" value={filters.status} onChange={status => change({ status })} options={Object.entries(STATUS_LABEL).filter(([key]) => key !== 'UNKNOWN')} />
          <RegistrationDateRange from={filters.from} to={filters.to} localFiling={filters.registrationTime === 'LOCAL'} onChange={patch => change({ ...patch, registeredFrom: '', registeredTo: '' })} />
        </>
      ) : null}
      {variant !== 'primary' ? (
        <>
          <ListToolbarEnumSelect label="实名状态" value={filters.identity} onChange={identity => change({ identity })} options={[['VERIFIED', '已实名'], ['UNVERIFIED', '未实名']]} />
          <ListToolbarEnumSelect label="会员等级" value={filters.tier} onChange={tier => change({ tier })} options={TIER_OPTIONS} />
          <ListToolbarEnumSelect label="有效礼遇" value={filters.entitlement} onChange={entitlement => change({ entitlement })} options={ENTITLEMENT_OPTIONS} />
          <CreditRangeFilter creditMin={filters.creditMin} creditMax={filters.creditMax} onChange={change} />
          <ListToolbarEnumSelect label="内部标识" value={filters.risk} onChange={risk => change({ risk })} options={RISK_OPTIONS} />
        </>
      ) : null}
    </div>
  );
}
