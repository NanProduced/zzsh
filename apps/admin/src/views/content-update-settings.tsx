import { BeijingInstantField } from "@/components/beijing-datetime-field";
import { updateVisibility, type UpdateSettings } from '@zzsh/content/updates';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { ContentSelect } from './content-resource-fields';
import { contentTime } from './content-resources-model';

export type ExposureFact = { label: string; tone: 'info' | 'success' | 'warning' | 'secondary' };
const SURFACE_LABEL: Record<UpdateSettings['surfaces'][number], string> = { publish: '上架出租', rental: '账号详情与租号确认', orders: '订单详情' };

/** 列表与编辑器共用：只根据已保存的线上快照解释当前曝光，不把草稿设置说成已生效。 */
export function updateExposureFacts(settings: UpdateSettings | undefined, now = Date.now()): ExposureFact[] {
  if (!settings) return [];
  const facts: ExposureFact[] = [];
  let visibility: ReturnType<typeof updateVisibility>;
  try { visibility = updateVisibility(settings, now); } catch { return facts; }
  if (settings.pinned && !visibility.expired) {
    if (visibility.pinned) facts.push({ label: `置顶中${settings.pinnedUntil ? ` · 至 ${contentTime(settings.pinnedUntil)}` : ''}`, tone: 'success' });
    else if (!settings.pinnedUntil || !Number.isFinite(Date.parse(settings.pinnedUntil))) facts.push({ label: '置顶未生效（缺结束时间）', tone: 'warning' });
    else facts.push({ label: `置顶已结束 · ${contentTime(settings.pinnedUntil)}`, tone: 'secondary' });
  }
  if (settings.tickerEnabled) {
    if (visibility.ticker) facts.push({ label: `首页轮播中${settings.tickerUntil ? ` · 至 ${contentTime(settings.tickerUntil)}` : ''}`, tone: 'success' });
    else if (!visibility.expired && settings.tickerFrom && now < Date.parse(settings.tickerFrom)) facts.push({ label: `轮播待开始 · ${contentTime(settings.tickerFrom)}`, tone: 'info' });
    else if (!visibility.expired) facts.push({ label: settings.tickerUntil ? '轮播已结束' : '轮播未生效（缺结束时间）', tone: 'warning' });
  }
  if (visibility.expired) facts.push({ label: `已过有效期 · ${contentTime(settings.validUntil)}`, tone: 'warning' });
  if (visibility.reminder) facts.push({ label: `业务提醒：${settings.surfaces.map(value => SURFACE_LABEL[value]).join(' / ')}`, tone: 'info' });
  return facts;
}

export function ContentUpdateSettings({ value, onChange, disabled, announcement }: { value: UpdateSettings; onChange: (value: UpdateSettings) => void; disabled: boolean; announcement: boolean }) {
  const patch = (field: Partial<UpdateSettings>) => { if (!disabled) onChange({ ...value, ...field }); };
  const date = (label: string, key: 'tickerFrom' | 'tickerUntil' | 'pinnedUntil' | 'validUntil' | 'effectiveAt') => {
    const local = value[key] ? new Date(Date.parse(value[key]!) + 8 * 3600_000).toISOString().slice(0, 16) : '';
    const change = (event: { currentTarget: HTMLInputElement }) => {
      const text = event.currentTarget.value;
      if (text === local) return;
      patch({ [key]: text ? new Date(`${text}+08:00`).toISOString() : null });
    };
    void change;
    return <div className="content-settings-field"><BeijingInstantField label={label} value={value[key]} disabled={disabled} onChange={(iso) => patch({ [key]: iso })} /></div>;
  };

  return <fieldset disabled={disabled} className="content-settings">
    <p className="content-settings-note">所有时间按北京时间（UTC+8）填写，随草稿保存；发布后才影响用户页面。</p>
    <section className="content-settings-group">
      <div><h4>首页平台动态轮播</h4><p>启用必须填写结束时间；游戏内容还需平台发布权限才能首页曝光。</p></div>
      <label className="content-check"><Checkbox disabled={disabled} id="ticker-enabled" checked={value.tickerEnabled} onCheckedChange={checked => patch({ tickerEnabled: checked === true })} />在首页平台动态轮播展示</label>
      <div className="content-settings-dates">{date('轮播开始时间（可选）', 'tickerFrom')}{date('轮播结束时间', 'tickerUntil')}</div>
    </section>
    <section className="content-settings-group">
      <div><h4>公告置顶</h4>{announcement ? <p>重要公告固定在平台动态顶部，与轮播互相独立。同一时刻最多 3 条有效置顶。</p> : <p>资讯不提供置顶。</p>}</div>
      {announcement ? <><label className="content-check"><Checkbox disabled={disabled} id="pinned-enabled" checked={value.pinned} onCheckedChange={checked => patch({ pinned: checked === true })} />重要公告置顶（最多同时3条）</label>{date('置顶结束时间', 'pinnedUntil')}</> : null}
    </section>
    <section className="content-settings-group">
      <div><h4>内容有效期</h4><p>过期后退出曝光、置顶及业务提醒；正文仍保留。</p></div>
      {date('内容有效期结束时间（可选）', 'validUntil')}
    </section>
    {announcement ? <section className="content-settings-group">
      <div><h4>业务提醒</h4><p>只传达公告，不改变报价、资格或订单条款。</p></div>
      <label className="content-settings-field"><span>公告性质</span><ContentSelect disabled={disabled} ariaLabel="公告性质" value={value.noticeKind} onChange={next => patch({ noticeKind: next as UpdateSettings['noticeKind'] })} options={[{ value: 'general', label: '一般公告' }, { value: 'maintenance', label: '维护提醒' }, { value: 'rule-change', label: '交易规则调整' }]} /></label>
      <div className="content-settings-dates">{date('生效时间', 'effectiveAt')}<label className="content-settings-field"><span>影响范围</span><Input value={value.impact} maxLength={500} onChange={event => patch({ impact: event.target.value })} placeholder="说明受影响的服务、游戏或用户" /></label></div>
      <fieldset className="content-settings-surfaces"><legend>同时展示提醒的业务页面</legend><div>{([['publish', '上架出租'], ['rental', '账号详情与租号确认'], ['orders', '订单详情']] as const).map(([key, label]) => <label key={key} className="content-check"><Checkbox disabled={disabled} id={`surface-${key}`} checked={value.surfaces.includes(key)} onCheckedChange={checked => patch({ surfaces: checked === true ? [...value.surfaces, key] : value.surfaces.filter(x => x !== key) })} />{label}</label>)}</div></fieldset>
      <p className="content-settings-note">维护和交易规则调整必须填写生效时间、影响范围及至少一个提醒页面。</p>
    </section> : null}
  </fieldset>;
}
