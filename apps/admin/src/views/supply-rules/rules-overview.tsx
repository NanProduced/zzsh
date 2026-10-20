import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { formatDate, type RulesResponse } from "../../api";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button, buttonVariants } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import {
  asHaffV2, boundText, centsYuan, compatTierCount, haffCount, makeupShare, num, payoutRef, perMillion,
  agreementDiff, priceDiff, safeBoxLabel, spread, standardItemRows, termDiff, unitLabel, unitYuan, yuan, type RuleDiffRow,
} from "./rules-model";
import { baseline, changes, validate, editContext, SKIN_LABELS, type ChangeRow, type EditValues } from "./rules-edit";
import { TrialWindow } from "./rules-trial-window";
import { RULES_RELEASE_OPERATION, type useRulesWrite } from "./rules-write";

type Option = { value: string; label: string };

function Pick({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (v: string) => void; options: Option[]; disabled?: boolean }) {
  return (
    <label className="block min-w-0 space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <SupplySelect label={label} value={value} onValueChange={onChange} options={value === "" ? [{ value: "", label: options.length ? "请选择" : "暂无可选项" }, ...options] : options} disabled={disabled || options.length === 0} />
    </label>
  );
}

function ScrollTable({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs text-muted-foreground sm:hidden">左右滑动查看完整表格</p>
      <div className="overflow-x-auto [&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted-foreground [&_td]:text-sm" role="region" aria-label={label} tabIndex={0}>{children}</div>
    </div>
  );
}

function Card({ title, note, badges, action, metrics, info, children, wide }: { title: string; note?: ReactNode; badges?: ReactNode; action?: ReactNode; metrics?: ReactNode; info?: ReactNode; children: ReactNode; wide?: boolean }) {
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <section className={`section-panel min-w-0 space-y-4 ${wide ? "lg:col-span-2" : ""}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold leading-6">{title}{badges}</h3>
          {note ? <p className="mt-0.5 text-sm text-muted-foreground">{note}</p> : null}
        </div>
        {action}
      </header>
      {metrics ? <dl className="flex flex-wrap gap-x-8 gap-y-3 border-b border-border pb-4">{metrics}</dl> : null}
      {children}
      {info ? (
        <Collapsible open={infoOpen} onOpenChange={setInfoOpen}>
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground" />}>{infoOpen ? "收起说明" : "规则说明"}</CollapsibleTrigger>
          <CollapsibleContent><div className="mt-2 space-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm leading-6 text-muted-foreground">{info}</div></CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

function Metric({ label, value, unit, sub }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{value}{unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span> : null}</dd>
      {sub ? <dd className="text-xs text-muted-foreground">{sub}</dd> : null}
    </div>
  );
}

function EditCell({ value, before, onChange, error, label, unit, wide }: { value: string; before: string; onChange: (v: string) => void; error?: string; label: string; unit?: string; wide?: boolean }) {
  const changed = value.trim() !== before.trim();
  const errorId = useId();
  return (
    <span className={`inline-flex flex-col items-end gap-0.5 ${wide ? "w-full" : ""}`}>
      <span className="inline-flex items-center gap-1">
        <Input aria-label={label} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} value={value} placeholder={before || "—"} inputMode="decimal" onChange={(e) => onChange(e.target.value)}
          className={`h-8 ${wide ? "w-full" : "w-24"} text-right text-sm tabular-nums placeholder:text-muted-foreground/50 placeholder:font-normal ${changed ? "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/40" : ""} ${error ? "border-destructive" : ""}`} />
        {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
      </span>
      {changed ? <span className="text-xs text-muted-foreground tabular-nums">原 {before || "未配置"}</span> : null}
      {error ? <span id={errorId} className="text-[13px] leading-relaxed text-destructive">{error}</span> : null}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">{children}</p>;
}

function DiffTable({ rows, empty }: { rows: RuleDiffRow[]; empty: string }) {
  if (rows.length === 0) return <Hint>{empty}</Hint>;
  return (
    <ScrollTable label="规则对比">
      <Table>
        <TableHeader><TableRow><TableHead>分组</TableHead><TableHead>项目</TableHead><TableHead className="text-right">现在</TableHead><TableHead className="text-right">调整后</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((r, i) => <TableRow key={i}><TableCell>{r.group}</TableCell><TableCell className="max-w-64 whitespace-normal break-words">{r.label}</TableCell><TableCell className="max-w-80 whitespace-pre-wrap break-words text-right tabular-nums">{r.before}</TableCell><TableCell className="max-w-80 whitespace-pre-wrap break-words text-right font-medium tabular-nums">{r.after}</TableCell></TableRow>)}</TableBody>
      </Table>
    </ScrollTable>
  );
}

/**
 * 规则与价目 · 第一片：只读总览 + 版本条 + 服务端试算 + Boss 确认生效。
 * 价格只读后端返回值，不在页面里写死；每 1M 金额只是按比例换算的显示辅助。
 */
export function RulesOverview({ rules, command, isBoss, canPreview, canEdit = false, onDirtyChange }: { rules: RulesResponse; command: ReturnType<typeof useRulesWrite>; isBoss: boolean; canPreview: boolean; canEdit?: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const bl = useMemo(() => baseline(rules), [rules]);
  const [editing, setEditing] = useState(false);
  const [vals, setVals] = useState<EditValues>(bl.values);
  const [editDialog, setEditDialog] = useState<"none" | "review" | "discard">("none");
  const [notice, setNotice] = useState<string>();
  const [trialOpen, setTrialOpen] = useState(false);
  const changeRows: ChangeRow[] = useMemo(() => (editing ? changes(bl.fields, bl.values, vals) : []), [editing, bl, vals]);
  const errors = useMemo(() => (editing ? validate(bl.fields, vals) : {}), [editing, bl, vals]);
  const dirty = editing && changeRows.length > 0;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !command.locked) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [dirty, command.locked]);
  const startEdit = () => { setVals(bl.values); setNotice(undefined); setEditing(true); };
  const stopEdit = () => { setEditing(false); setVals(bl.values); setEditDialog("none"); };
  const val = (k: string) => (editing && k in vals ? vals[k]! : bl.values[k] ?? "");
  const V = (k: string, display: ReactNode, opts: { unit?: string; wide?: boolean } = {}) => editing && k in bl.values
    ? <EditCell label={bl.fields.find((x) => x.key === k)?.label ?? k} value={vals[k] ?? ""} before={bl.values[k] ?? ""} error={errors[k]} unit={opts.unit} wide={opts.wide} onChange={(v) => setVals((x) => ({ ...x, [k]: v }))} />
    : display;
  const release = rules.release;
  const curPrice = release ? rules.priceVersions.find((v) => v.id === release.priceVersionId) : undefined;
  const curTerm = release ? rules.termVersions.find((v) => v.id === release.termVersionId) : undefined;
  const curAgreement = release ? rules.agreementVersions.find((v) => v.id === release.agreementVersionId) : undefined;
  const latestPrice = rules.priceVersions[0];
  const latestTerm = rules.termVersions[0];
  const latestAgreement = rules.agreementVersions[0];
  const priceChanged = Boolean(latestPrice && latestPrice.id !== curPrice?.id);
  const termChanged = Boolean(latestTerm && latestTerm.id !== curTerm?.id);
  const agreementChanged = Boolean(latestAgreement && latestAgreement.id !== curAgreement?.id);
  const haff = asHaffV2(curPrice?.haffRule);
  const policy = curPrice?.fundingPolicy ?? null;
  const [dialog, setDialog] = useState<"none" | "confirm" | "agreement" | "compare">("none");
  const [compareRows, setCompareRows] = useState<RuleDiffRow[]>([]);
  const [chartOpen, setChartOpen] = useState(false);
  const openCompare = (rows: RuleDiffRow[]) => { setCompareRows(rows); setDialog("compare"); };
  const sealedAfter = (list: { status: string; sealedAt: string | null; id: string }[], currentId?: string) =>
    list.filter((v) => v.status === "SEALED" && v.id !== currentId && (!release || (v.sealedAt ?? "") > release.activatedAt)).length;
  const sealedPending = sealedAfter(rules.priceVersions, curPrice?.id) + sealedAfter(rules.termVersions, curTerm?.id) + sealedAfter(rules.agreementVersions, curAgreement?.id);
  const drafts = [...rules.priceVersions, ...rules.termVersions, ...rules.agreementVersions].filter((v) => v.status === "DRAFT").length;
  const changeBadge = (changed: boolean, rows: () => RuleDiffRow[]) => changed ? (
    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => openCompare(rows())}>
      <Badge variant="warning">有未生效调整</Badge><span className="ml-1 underline-offset-2 hover:underline">查看对比</span>
    </Button>
  ) : null;

  const boxes = haff ? Object.entries(haff.baseBySafeBox) : [];
  const p = haff ? num(haff.compatibility.ordinary.spreadDelta) : null;
  const pf = haff ? num(haff.compatibility.fast.spreadDelta) : null;
  const standardDelta = haff ? num(haff.compatibility.ordinary.discounts.STANDARD) : null;
  const itemRows = curPrice ? standardItemRows(rules, curPrice.id) : [];
  const compatTiers = curPrice ? compatTierCount(rules, curPrice.id) : 0;
  const termOpts = curTerm ? rules.termOptions.filter((o) => o.versionId === curTerm.id) : [];
  const example = boxes.length ? boxes[boxes.length - 1]! : undefined;
  const exampleRatio = example ? num(example[1]) : null;

  return (
    <div className="space-y-4">
      <section className="section-panel" aria-label="当前生效版本"><h2 className="mb-3 text-base font-semibold">当前生效版本 <span className="ml-2 text-xs font-normal text-muted-foreground">以下均为当前生效值</span></h2>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div><p className="text-xs text-muted-foreground">当前生效</p><p className="text-lg font-semibold tabular-nums">{release ? `第 ${release.generation} 版组合` : "尚未生效"}</p></div>
          <div><p className="text-xs text-muted-foreground">生效时间</p><p className="text-lg font-semibold tabular-nums">{release ? formatDate(release.activatedAt) : "—"}</p></div>
          <div className="min-w-0"><p className="text-xs text-muted-foreground">尚未生效的版本</p>
            <p className="text-sm leading-7">{sealedPending ? `${sealedPending} 个已封存，尚未生效` : "无已封存的新版本"}{drafts ? ` · ${drafts} 个草稿` : ""}</p></div>
          <div className="ml-auto flex flex-wrap gap-2">
            {canEdit ? <a className={buttonVariants({ variant: "secondary" })} href={`#skin-deposit-policy-${rules.game.id}`}>配置新版皮肤押金</a> : null}
            {canEdit && release && !editing ? <Button type="button" variant="outline" disabled={command.locked} onClick={startEdit}>编辑规则（仅预览）</Button> : null}
            <Button type="button" variant="outline" disabled={!canPreview || !release} title={!canPreview ? "当前账号没有内部试算权限" : undefined} onClick={() => setTrialOpen(true)}>试算一单</Button>
            {isBoss && !editing ? <Button type="button" disabled={command.locked && command.pending?.operation !== RULES_RELEASE_OPERATION} onClick={() => setDialog("confirm")}>选择版本并确认生效</Button> : null}
          </div>
        </div>
        <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">按「价格 + 租期 + 出租协议」组合生效；封存后由 Boss 选择并确认生效。</p>
        <p className="mt-2 text-sm text-muted-foreground">整页编辑与试算可预览调整；审批接口尚未接入，本轮修改不能保存。</p>
        {editing ? <Alert role="note" className="mt-2"><AlertDescription><p>本地预览中：改过的输入会高亮并显示原值。确认修改只展示差异，暂不能保存或提交审批；当前生效规则不变。</p></AlertDescription></Alert> : null}
        {notice ? <p role="status" className="mt-2 rounded-md bg-muted px-3 py-2 text-xs">{notice}</p> : null}
      </section>

      {!release ? <section className="section-panel"><Hint>还没有生效的规则。请联系平台管理员配置初始生效规则，封存后由 Boss 选择并确认生效。</Hint></section> : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card wide title="哈夫币计价规则" note="平台按比例差计算租客比例与金额；比例＝1 元换多少万哈夫币，比例越小单价越高"
              metrics={haff && curPrice?.mode === "SPREAD" && p !== null ? (<>
                <Metric label="平台比例差 · 普通/自定义" value={val("haff.spread.ordinary") || p} />
                <Metric label="平台比例差 · 快速" value={val("haff.spread.fast") || pf || "—"} />
                <Metric label="参考平台价差" value={perMillion(50) !== null && perMillion(50 - (num(val("haff.spread.ordinary")) ?? p) + (standardDelta ?? 0)) !== null ? yuan(perMillion(50 - (num(val("haff.spread.ordinary")) ?? p) + (standardDelta ?? 0))! - perMillion(50)!) : "待计算"} unit="/1M" sub="以常用 50 比例测算" />
                <Metric label="计价模式" value="差价换算（SPREAD）" />
              </>) : undefined}
              info={haff ? (<>
                <p>1. 比例换算关系：比例＝1 元换多少万哈夫币；金额（元/1M）＝ 100 ÷ 比例。比例越小单价越高，比例差是比例上的差额，不是固定金额。</p>
                <p>2. 上架与计价逻辑：保险箱、体力、负重等属性仅在上架环节生成推荐初始比例和可选区间；号主选定最终比例后，计价直接采用该比例与平台比例差，不重复加减。</p>
                <p>3. 换算参考说明：本页展示的元/M 仅辅助运营理解，实际金额由号主上架时确定的具体比例与平台比例差动态计算，不作为全平台统一定价，亦不反写原比例。</p>
                <p>4. 试算入口：若需测算具体账号的租客总支付与平台收益，请点击上方「试算一单」打开比价计算器。</p>
              </>) : undefined}
              badges={changeBadge(priceChanged, () => priceDiff(rules, curPrice?.id, latestPrice?.id).filter((r) => r.group === "哈夫币价格"))}>
              {!haff || curPrice?.mode !== "SPREAD" ? <Hint>当前规则格式暂不支持此表换算，请核对原始配置。</Hint> : (
                <div className="space-y-4">
                  {/* 核心参数：平台比例差 */}
                  <div className="rounded-lg border border-border bg-card p-4 shadow-2xs">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">核心参数：平台比例差</span>
                          <Badge variant="outline">普通/自定义模式适用</Badge>
                          {haff.compatibility.modes.fast.enabled ? <Badge variant="secondary">快速模式: {val("haff.spread.fast") || haff.compatibility.fast.spreadDelta}</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          租客比例 ＝ 号主比例 − 平台比例差{standardDelta ? ` + 普通档调整(${standardDelta})` : ""}；调大比例差，租客支付增加、平台留存收益扩大。
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">当前设定</span>
                        <span className="text-base font-bold tabular-nums">
                          {V("haff.spread.ordinary", haff.compatibility.ordinary.spreadDelta)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 换算参考示例（非固定平台价） */}
                  <div className="rounded-lg border border-border/80 bg-muted/20 p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold">换算参考示例（非固定平台价）</h4>
                      <span className="text-[11px] text-muted-foreground">当前比例差：普通 {val("haff.spread.ordinary") || haff.compatibility.ordinary.spreadDelta} · 辅助测算</span>
                    </div>
                    <ScrollTable label="换算参考示例">
                      <Table className="mt-2">
                        <TableHeader>
                          <TableRow>
                            <TableHead>参考场景 / 号主比例</TableHead>
                            <TableHead className="text-right">租客比例</TableHead>
                            <TableHead className="text-right">号主侧金额（扣费前）</TableHead>
                            <TableHead className="text-right">租客哈夫币金额</TableHead>
                            <TableHead className="text-right">平台价差（元/1M）</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[50, 60, 70].map((sampleRatio) => {
                            const sp = num(val("haff.spread.ordinary")) ?? p ?? 10;
                            const sd = standardDelta ?? 0;
                            const tenantRatio = sampleRatio - sp + sd;
                            const ownerPerM = perMillion(sampleRatio);
                            const tenantPerM = perMillion(tenantRatio > 0 ? tenantRatio : null);
                            const spreadPerM = ownerPerM !== null && tenantPerM !== null ? tenantPerM - ownerPerM : null;
                            return (
                              <TableRow key={sampleRatio}>
                                <TableCell className="font-medium">
                                  比例 {sampleRatio} 万/元 {sampleRatio === 50 ? <span className="text-xs text-muted-foreground">（常用基准）</span> : null}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{tenantRatio > 0 ? tenantRatio : "待计算"}</TableCell>
                                <TableCell className="text-right tabular-nums">{yuan(ownerPerM)}/1M</TableCell>
                                <TableCell className="text-right tabular-nums">{tenantPerM !== null ? `${yuan(tenantPerM)}/1M` : "待计算"}</TableCell>
                                <TableCell className="text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                                  {spreadPerM !== null ? `+${yuan(spreadPerM)}/1M` : "待计算"}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </ScrollTable>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      * 换算示例仅供参考，实际金额由号主上架申报比例与平台比例差动态换算。
                    </p>
                  </div>
                </div>
              )}
            </Card>

            <Card title="物资单价" note="普通租客口径 · 按实际消耗计费（号主价与租客价差额为平台收益）"
              metrics={<><Metric label="计费物资" value={itemRows.length} unit="项" /><Metric label="未配置" value={itemRows.filter((r) => !r.line?.buyerUnitAmount).length} unit="项" /></>}
              info={<><p>开租与结束各确认一次数量，按实际消耗计费。</p><p>显示「未配置」的物品不会按 0 计价，相关报价会提示无法报价。</p>{compatTiers ? <p>另有 {compatTiers} 个会员档位的兼容价格数据，本页不展示也不修改。</p> : null}</>} badges={changeBadge(priceChanged, () => priceDiff(rules, curPrice?.id, latestPrice?.id).filter((r) => r.group === "物品单价"))}>
              {itemRows.length === 0 ? <Hint>该游戏没有按件计费的物品。</Hint> : (
                <ScrollTable label="物品单价表">
                  <Table>
                    <TableHeader><TableRow><TableHead>物品</TableHead><TableHead>计费单位</TableHead><TableHead className="text-right">租客价</TableHead><TableHead className="text-right">号主价</TableHead><TableHead className="text-right">平台价差/单位</TableHead></TableRow></TableHeader>
                    <TableBody>{itemRows.map(({ item, line }) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.name}{!item.enabled ? <Badge variant="unknown" className="ml-1">已停用</Badge> : null}</TableCell>
                        <TableCell>{line?.unitQuantity && line.unitQuantity !== "1" ? `每 ${line.unitQuantity} ${unitLabel(item.unit)}` : `每${unitLabel(item.unit)}`}</TableCell>
                        <TableCell className="text-right tabular-nums">{V(`item.${item.id}.buyer`, unitYuan(line?.buyerUnitAmount), { unit: "元" })}</TableCell>
                        <TableCell className="text-right tabular-nums">{V(`item.${item.id}.owner`, unitYuan(line?.ownerUnitAmount), { unit: "元" })}</TableCell>
                        <TableCell className="text-right tabular-nums">{spread(editing ? val(`item.${item.id}.buyer`) : line?.buyerUnitAmount, editing ? val(`item.${item.id}.owner`) : line?.ownerUnitAmount)}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </ScrollTable>
              )}
            </Card>

            <Card title="押金规则" note="对齐平台基准押金配置 · 系统给出推荐押金，号主填写的金额为最终押金"
              info={policy ? <p>推荐押金＝各项之和，按政策取整单位（{centsYuan(policy.recommendation.parameters.rounding.unitCents)}）向上取整，零值时最低 {centsYuan(policy.recommendation.parameters.rounding.zeroFallbackCents)}，不超过上限；号主可改，但必须满足最低值且不超过上限。</p> : <p>当前生效价格版本未提供资金政策，本节不使用任何默认金额。</p>}
              badges={changeBadge(priceChanged, () => priceDiff(rules, curPrice?.id, latestPrice?.id).filter((r) => r.group === "押金规则"))}>
              {!policy ? <Hint>资金政策未提供：押金上限、普通/包赔最低值、加价项与号主保证金要求均为未提供，不参与本地估算。</Hint> : (
                <>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-border pb-4 sm:grid-cols-4">
                    <div><dt className="text-xs text-muted-foreground">押金上限</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{V("dep.cap", centsYuan(policy.recommendation.parameters.upperLimitCents), { unit: "元" })}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">普通最低</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{centsYuan(policy.ownerDepositRules.normal.minCents)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">选全额包赔时最低</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{centsYuan(policy.ownerDepositRules.fullPayoutSelected.minCents)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">号主保证金</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{policy.guaranteeRequirement.mode === "NOT_REQUIRED" ? "政策不要求" : centsYuan(policy.guaranteeRequirement.requiredCents)}</dd></div>
                  </dl>
                  {editing ? <DepositExample vals={vals} boxes={Object.keys(policy.recommendation.parameters.safeBoxWeightsByCode)} policy={policy} /> : null}
                  <ScrollTable label="推荐押金加价项">
                    <Table>
                      <TableHeader><TableRow><TableHead>加价项</TableHead><TableHead>分类</TableHead><TableHead className="text-right">首件 / 金额</TableHead><TableHead className="text-right">之后每件</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {Object.entries(policy.recommendation.parameters.safeBoxWeightsByCode).map(([code, cents]) => (
                          <TableRow key={`box-${code}`}><TableCell className="font-medium">{safeBoxLabel(code)} 保险箱</TableCell><TableCell className="text-xs text-muted-foreground">保险箱</TableCell><TableCell className="text-right tabular-nums">{V(`dep.box.${code}`, centsYuan(cents), { unit: "元" })}</TableCell><TableCell className="text-right text-muted-foreground">—</TableCell></TableRow>
                        ))}
                        <TableRow><TableCell className="font-medium">7 级体力</TableCell><TableCell className="text-xs text-muted-foreground">角色属性</TableCell><TableCell className="text-right tabular-nums">{V("dep.vit7", centsYuan(policy.recommendation.parameters.vitalityAtLeast7Cents), { unit: "元" })}</TableCell><TableCell className="text-right text-muted-foreground">—</TableCell></TableRow>
                        <TableRow><TableCell className="font-medium">7 级负重</TableCell><TableCell className="text-xs text-muted-foreground">角色属性</TableCell><TableCell className="text-right tabular-nums">{V("dep.bear7", centsYuan(policy.recommendation.parameters.bearAtLeast7Cents), { unit: "元" })}</TableCell><TableCell className="text-right text-muted-foreground">—</TableCell></TableRow>
                        <TableRow><TableCell className="font-medium">3 级潜水</TableCell><TableCell className="text-xs text-muted-foreground">角色属性</TableCell><TableCell className="text-right tabular-nums">{V("dep.dive3", centsYuan(policy.recommendation.parameters.diveAtLeast3Cents), { unit: "元" })}</TableCell><TableCell className="text-right text-muted-foreground">—</TableCell></TableRow>
                        {policy.recommendation.schema === "deposit-recommendation-v2" ? policy.recommendation.parameters.skinRules.map((row, index) => (
                          <TableRow key={`skin-v2-${index}`}><TableCell>{row.ownerKind === "AGENT" ? "干员" : row.ownerKind === "FIREARM" ? "枪械" : "近战外观"}</TableCell><TableCell>{row.rarityCode === null ? "类型兜底（含未知品质）" : rules.depositCatalog?.rarities.find(rarity => rarity.code === row.rarityCode)?.name ?? row.rarityCode}</TableCell><TableCell className="text-right tabular-nums">{row.firstCents === null ? "待配置" : centsYuan(row.firstCents)}</TableCell><TableCell className="text-right tabular-nums">{row.subsequentCents === null ? "待配置" : centsYuan(row.subsequentCents)}</TableCell></TableRow>
                        )) : null}
                        {policy.recommendation.schema === "deposit-recommendation-v2" ? policy.recommendation.parameters.skinOverrides.map(row => <TableRow key={`override-${row.skinId}`}><TableCell>{rules.depositCatalog?.skins.find(skin => skin.id === row.skinId)?.name ?? row.skinId}</TableCell><TableCell>单词条覆盖</TableCell><TableCell className="text-right">{row.amountCents === null ? "待配置" : centsYuan(row.amountCents)}</TableCell><TableCell>—</TableCell></TableRow>) : null}
                      </TableBody>
                    </Table>
                  </ScrollTable>
                  {policy.recommendation.schema === "deposit-recommendation-v1" ? <Collapsible className="mt-4 border-t border-border pt-3">
                    <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-between gap-3 whitespace-normal px-0 text-left" />}>
                      <span><span className="block font-medium">原版本 v1 皮肤加价（只读）</span><span className="mt-1 block text-xs font-normal text-muted-foreground">v2 完成配置并生效前，既有版本口径保留。</span></span><ChevronDownIcon className="size-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-3"><ScrollTable label="原版本 v1 皮肤加价（只读）"><Table>
                      <TableHeader><TableRow><TableHead>原版本分组</TableHead><TableHead className="text-right">首件（元）</TableHead><TableHead className="text-right">后续每件（元）</TableHead></TableRow></TableHeader>
                      <TableBody>{Object.entries(policy.recommendation.parameters.skinWeights).map(([group, weight]) => <TableRow key={group}><TableCell>{SKIN_LABELS[group] ?? group}</TableCell><TableCell className="text-right tabular-nums">{centsYuan(weight.firstCents)}</TableCell><TableCell className="text-right tabular-nums">{centsYuan(weight.subsequentCents)}</TableCell></TableRow>)}</TableBody>
                    </Table></ScrollTable></CollapsibleContent>
                  </Collapsible> : null}
                </>
              )}
            </Card>
          </div>

          <section className="section-panel" aria-label="租期与出租协议引用">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div><h2 className="text-base font-semibold">租期与每日消耗 · 出租协议引用</h2><p className="mt-0.5 text-xs text-muted-foreground">档位与协议按生效版本引用；协议正文在本页只读查看，编辑沿现有版本维护流程。</p></div>
              <div className="flex flex-wrap gap-2">{changeBadge(termChanged, () => termDiff(rules, curTerm?.id, latestTerm?.id))}{changeBadge(agreementChanged, () => agreementDiff(rules, curAgreement?.id, latestAgreement?.id))}</div>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
              <div className="min-w-0">
                {termOpts.length ? (
                  <ScrollTable label="租期档位表">
                    <Table>
                      <TableHeader><TableRow><TableHead>档位</TableHead><TableHead>代码</TableHead><TableHead className="text-right">每日消耗</TableHead><TableHead>租期取整</TableHead></TableRow></TableHeader>
                      <TableBody>{termOpts.map((option) => (
                        <TableRow key={option.code}>
                          <TableCell>{option.name}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{option.code}</TableCell>
                          <TableCell className="text-right tabular-nums">{V(`term.${option.code}.daily`, haffCount(option.dailyConsumption), { unit: "M" })}</TableCell>
                          <TableCell>{option.durationRounding === "CEIL_DAY" ? "按天向上取整" : option.durationRounding}</TableCell>
                        </TableRow>
                      ))}</TableBody>
                    </Table>
                  </ScrollTable>
                ) : <Hint>当前生效租期版本没有档位，或版本内容未随规则读取返回；不显示为 0 档。</Hint>}
                {!curTerm ? <Hint>生效组合未提供租期版本引用。</Hint> : null}
              </div>
              <div className="min-w-0 rounded-lg border border-border bg-card p-4">
                <h3 className="text-sm font-semibold">出租协议引用</h3>
                {curAgreement ? (
                  <>
                    <p className="mt-1 text-sm">{curAgreement.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">版本 {curAgreement.id} · 状态 {curAgreement.status === "SEALED" ? "已封存" : curAgreement.status === "DRAFT" ? "草稿" : curAgreement.status}</p>
                    <p className="mt-1 text-xs text-muted-foreground break-all">正文摘要 {curAgreement.digest ? curAgreement.digest.slice(0, 16) + "…" : "未提供"}</p>
                    {payoutRef(curPrice) ? <p className="mt-2 text-xs text-muted-foreground">全额包赔条款：{payoutRef(curPrice)}</p> : <p className="mt-2 text-xs text-muted-foreground">全额包赔条款引用未提供。</p>}
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setDialog("agreement")}>查看协议正文</Button>
                  </>
                ) : <p className="mt-1 text-sm text-muted-foreground">生效组合未提供出租协议版本，或该版本未随规则读取返回。</p>}
                <p className="mt-2 text-[11px] text-muted-foreground">引用版本变化不会自动改变已冻结订单的原协议依据。</p>
              </div>
            </div>
          </section>

          <SettlementRules />
          <History rules={rules} />
        </>
      )}

      <Dialog open={dialog === "compare"} onOpenChange={(o) => !o && setDialog("none")}>
        <DialogContent closeLabel="关闭窗口" className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader><DialogTitle>未生效调整 · 对比</DialogTitle><DialogDescription>与当前生效值对比最新的版本（草稿或已封存）。只是查看，不会生效。</DialogDescription></DialogHeader>
          <DiffTable rows={compareRows} empty="已提供的业务字段未发现差异；未返回的内容无法比较，版本引用仍有变化。" />
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "agreement"} onOpenChange={(o) => !o && setDialog("none")}>
        <DialogContent closeLabel="关闭窗口" className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>{curAgreement?.title ?? "出租协议"}</DialogTitle><DialogDescription>用户端看到的样子（纯文本，保留换行）。</DialogDescription></DialogHeader>
          <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs">{curAgreement?.body || "（正文为空）"}</div>
        </DialogContent>
      </Dialog>

      {trialOpen && release ? <TrialWindow rules={rules} seed={editing ? vals : undefined} onClose={() => setTrialOpen(false)} /> : null}
      {editing ? (
        <div className="sticky bottom-0 z-30 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur" role="region" aria-label="编辑操作">
          <p className="text-sm"><span className="font-semibold tabular-nums">{changeRows.length}</span> 项修改{Object.keys(errors).length ? <span className="ml-2 text-xs text-destructive">{Object.keys(errors).length} 项需修正</span> : null}<span className="ml-2 text-xs text-muted-foreground">仅预览差异，尚不能保存或提交审批</span></p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => (dirty ? setEditDialog("discard") : stopEdit())}>取消</Button>
            <Button type="button" disabled={!dirty || Object.keys(errors).length > 0} onClick={() => setEditDialog("review")}>确认修改</Button>
          </div>
        </div>
      ) : null}
      <Dialog open={editDialog === "discard"} onOpenChange={(o) => !o && setEditDialog("none")}>
        <DialogContent closeLabel="关闭窗口">
          <DialogHeader><DialogTitle>放弃修改？</DialogTitle><DialogDescription>有 {changeRows.length} 项修改尚未提交，退出编辑后将丢失。</DialogDescription></DialogHeader>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setEditDialog("none")}>继续编辑</Button><Button type="button" variant="destructive" onClick={stopEdit}>放弃修改</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      {editDialog === "review" ? <ReviewDialog rows={changeRows} onClose={() => setEditDialog("none")} /> : null}
      {dialog === "confirm" ? <ConfirmDialog rules={rules} command={command} onClose={() => { setDialog("none"); command.dismissResult(); }} /> : null}
    </div>
  );
}

function SettlementRules() {
  const [open, setOpen] = useState(false);
  const W = 360, H = 140, L = 36, R = 350, T = 18, B = 112;
  const x = (c: number) => L + (R - L) * c, y = (v: number) => B - (B - T) * v;
  const path = Array.from({ length: 101 }, (_, i) => `${i ? "L" : "M"}${x(i / 100).toFixed(1)} ${y(makeupShare(i / 100)).toFixed(1)}`).join("");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="section-panel">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-start px-0 py-2 text-left whitespace-normal" />}>
        {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}<span className="grid min-w-0 gap-1 sm:flex sm:items-center sm:gap-2"><span className="shrink-0 text-base font-semibold">结算与包赔规则说明</span><span className="text-xs text-muted-foreground">平台统一规定，本页不可修改 · 全额包赔服务费 8% · 租客主动提前结束时按消耗比例补差</span></span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h4 className="mb-2 text-xs font-semibold">全额包赔 8% · 谁承担</h4>
            <ScrollTable label="包赔承担方">
              <Table>
                <TableHeader><TableRow><TableHead>怎么结束</TableHead><TableHead>按什么算</TableHead><TableHead className="text-right">谁付</TableHead></TableRow></TableHeader>
                <TableBody>
                  <TableRow><TableCell>正常结束</TableCell><TableCell>号主按实际消耗得到的金额</TableCell><TableCell className="text-right">号主</TableCell></TableRow>
                  <TableRow><TableCell>租客主动提前结束</TableCell><TableCell>号主开租时的全额</TableCell><TableCell className="text-right">租客</TableCell></TableRow>
                  <TableRow><TableCell>号主或账号原因提前结束</TableCell><TableCell>号主按实际消耗得到的金额</TableCell><TableCell className="text-right">号主</TableCell></TableRow>
                  <TableRow><TableCell>开租前取消 / 未选包赔</TableCell><TableCell>—</TableCell><TableCell className="text-right">不收</TableCell></TableRow>
                </TableBody>
              </Table>
            </ScrollTable>
            <p className="mt-2 text-[11px] text-muted-foreground">服务费归平台，单独列出，不算在价差里。</p>
          </div>
          <div className="min-w-0">
            <h4 className="mb-2 text-xs font-semibold">租客主动提前结束 · 补交哈夫币价差</h4>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-md text-foreground" role="img" aria-label="补差比例：消耗0%补100%，50%补50%，60%补25%，70%及以上为0">
              <line x1={L} y1={B} x2={R} y2={B} className="stroke-border" />
              <line x1={L} y1={T} x2={L} y2={B} className="stroke-border" />
              <path d={path} fill="none" stroke="currentColor" strokeWidth={2} />
              {[[0, "100%"], [0.5, "50%"], [0.6, "25%"], [0.7, "0"]].map(([c, t]) => (
                <g key={String(c)}><circle cx={x(c as number)} cy={y(makeupShare(c as number))} r={3} fill="currentColor" /><text x={x(c as number) + 6} y={y(makeupShare(c as number)) - 6} fontSize={10} fill="currentColor">{t}</text></g>
              ))}
              {[0, 0.5, 0.7, 1].map((c) => <text key={c} x={x(c)} y={B + 14} fontSize={10} textAnchor="middle" className="fill-muted-foreground">{c * 100}%</text>)}
              <text x={R} y={B + 26} fontSize={10} textAnchor="end" className="fill-muted-foreground">哈夫币已消耗</text>
            </svg>
            <p className="mt-2 text-[11px] text-muted-foreground">租客主动提前结束时，按消耗比例计算补差；达到 70% 时该项补差为 0。补差＝该单哈夫币价差总额 × 图中比例；号主原因提前结束不补差。</p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function History({ rules }: { rules: RulesResponse }) {
  const [open, setOpen] = useState(false);
  const rows = [
    ...rules.priceVersions.map((v) => ({ kind: "价格", v })),
    ...rules.termVersions.map((v) => ({ kind: "租期", v })),
    ...rules.agreementVersions.map((v) => ({ kind: "出租协议", v })),
  ].sort((a, b) => (b.v.sealedAt ?? b.v.createdAt).localeCompare(a.v.sealedAt ?? a.v.createdAt));
  const inRelease = (id: string) => rules.release && [rules.release.priceVersionId, rules.release.termVersionId, rules.release.agreementVersionId].includes(id);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="section-panel">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-start px-0 py-2 text-left whitespace-normal" />}>
        {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}<span className="text-base font-semibold">版本记录</span><span className="text-xs text-muted-foreground">共 {rows.length} 个版本</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollTable label="版本记录">
          <Table className="mt-3">
            <TableHeader><TableRow><TableHead>类型</TableHead><TableHead>状态</TableHead><TableHead>修订</TableHead><TableHead>创建</TableHead><TableHead>封存</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map(({ kind, v }) => (
              <TableRow key={v.id}><TableCell>{kind}</TableCell>
                <TableCell>{inRelease(v.id) ? <Badge variant="success">当前生效</Badge> : v.status === "SEALED" ? <Badge variant="outline">已封存，尚未生效</Badge> : <Badge variant="secondary">草稿</Badge>}</TableCell>
                <TableCell className="tabular-nums">{v.revision}</TableCell><TableCell>{formatDate(v.createdAt)}</TableCell><TableCell>{v.sealedAt ? formatDate(v.sealedAt) : "—"}</TableCell></TableRow>
            ))}</TableBody>
          </Table>
        </ScrollTable>
        <p className="mt-2 text-[11px] text-muted-foreground">后台暂未提供历次生效组合列表，这里按版本列出。</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DepositExample({ vals, boxes, policy }: { vals: EditValues; boxes: string[]; policy: NonNullable<ReturnType<typeof editContext>["policy"]> }) {
  const unit = num(policy.recommendation.parameters.rounding.unitCents) ?? 0, zeroYuan = (num(policy.recommendation.parameters.rounding.zeroFallbackCents) ?? 0) / 100;
  const box = boxes.find(b => vals[`dep.box.${b}`]);
  const required = [`dep.box.${box}`, "dep.vit7", "dep.bear7", "dep.dive3", "dep.cap"].map(k => num(vals[k]));
  if (!box || required.some(n => n === null || n < 0) || (required[4] ?? 0) <= 0 || unit <= 0) return <Hint>实时示例待计算：所选保险箱、加价项、取整单位与上限须由政策提供且合法，缺项不按 0 参与。</Hint>;
  const cap = required[4]!, sum = required.slice(0, 4).reduce<number>((total, n) => total + n!, 0);
  const yuanUnit = unit / 100;
  const rec = Math.min(sum <= 0 ? zeroYuan : Math.ceil(sum / yuanUnit) * yuanUnit, cap);
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs" aria-live="polite">
      <p className="font-medium">实时示例 · {safeBoxLabel(box)} 保险箱 + 7 级体力 + 7 级负重 + 3 级潜水（不含皮肤）</p>
      <p className="mt-1 tabular-nums">合计 {yuan(sum)} → 向上取整到 {centsYuan(policy.recommendation.parameters.rounding.unitCents)} → 推荐 <b>{yuan(rec)}</b>{sum > cap ? <span className="ml-1 text-amber-900 dark:text-amber-300">（已触顶，按上限 {yuan(cap)}）</span> : null}</p>
      <p className="mt-1 text-muted-foreground">上限同时约束推荐押金与号主填写的押金；号主可改的最低值为普通 {centsYuan(policy.ownerDepositRules.normal.minCents)}、选全额包赔时 {centsYuan(policy.ownerDepositRules.fullPayoutSelected.minCents)}。</p>
    </div>
  );
}

function ReviewDialog({ rows, onClose }: { rows: ChangeRow[]; onClose: () => void }) {
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel="关闭窗口" className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>确认修改 · {rows.length} 项</DialogTitle><DialogDescription>以下为本地修改与当前生效值的对比。审批接口尚未接入，当前不能保存或提交申请。</DialogDescription></DialogHeader>
        {groups.map((g) => (
          <div key={g} className="min-w-0">
            <p className="mb-1 text-sm font-semibold">{g}</p>
            <ScrollTable label={`${g}修改`}>
              <Table><TableHeader><TableRow><TableHead>项目</TableHead><TableHead className="text-right">现在</TableHead><TableHead className="text-right">修改后</TableHead></TableRow></TableHeader>
                <TableBody>{rows.filter((r) => r.group === g).map((r) => <TableRow key={r.key}><TableCell>{r.label}</TableCell><TableCell className="text-right tabular-nums text-muted-foreground">{r.before || "未配置"}{r.unit ? ` ${r.unit}` : ""}</TableCell><TableCell className="text-right font-semibold tabular-nums">{r.after || "未配置"}{r.unit ? ` ${r.unit}` : ""}</TableCell></TableRow>)}</TableBody>
              </Table>
            </ScrollTable>
          </div>
        ))}
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">提交审批将在下一轮接入；本轮不会写入任何数据。未修改的分组沿用当前版本，会员档位兼容价目原样保留。</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>返回编辑</Button>
          <Button type="button" disabled title="审批接口下一轮接入">提交审批（下轮接入）</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({ rules, command, onClose }: { rules: RulesResponse; command: ReturnType<typeof useRulesWrite>; onClose: () => void }) {
  const release = rules.release;
  const sealed = <T extends { status: string }>(list: T[]) => list.filter((v) => v.status === "SEALED");
  const first = (list: { id: string; status: string }[], current?: string) => sealed(list)[0]?.id ?? current ?? "";
  const { state, pending } = command;
  const isRelease = pending?.operation === RULES_RELEASE_OPERATION;
  const [priceId, setPriceId] = useState(() => isRelease ? String(pending.body.priceVersionId) : first(rules.priceVersions, release?.priceVersionId));
  const [termId, setTermId] = useState(() => isRelease ? String(pending.body.termVersionId) : first(rules.termVersions, release?.termVersionId));
  const [agreementId, setAgreementId] = useState(() => isRelease ? String(pending.body.agreementVersionId) : first(rules.agreementVersions, release?.agreementVersionId));
  const label = (v: { revision: string; sealedAt: string | null; id: string }, current?: string, title?: string) => `${title ? title + " · " : ""}修订 ${v.revision} · ${v.sealedAt ? formatDate(v.sealedAt) : ""}${v.id === current ? "（当前生效）" : ""}`;
  const rows = useMemo(() => [
    ...priceDiff(rules, release?.priceVersionId, priceId),
    ...termDiff(rules, release?.termVersionId, termId),
    ...agreementDiff(rules, release?.agreementVersionId, agreementId),
  ], [rules, release, priceId, termId, agreementId]);
  const same = Boolean(release && priceId === release.priceVersionId && termId === release.termVersionId && agreementId === release.agreementVersionId);
  const unchanged = [priceId === release?.priceVersionId ? "价格（哈夫币、物品、押金）" : null, termId === release?.termVersionId ? "租期与每日消耗" : null, agreementId === release?.agreementVersionId ? "出租协议" : null].filter(Boolean);
  const curRef = payoutRef(rules.priceVersions.find((v) => v.id === release?.priceVersionId));
  const nextRef = payoutRef(rules.priceVersions.find((v) => v.id === priceId));
  const activate = () => command.write({ operation: RULES_RELEASE_OPERATION, resourceId: rules.game.id, gameId: rules.game.id, path: "/supply/releases", method: "POST", body: { gameId: rules.game.id, priceVersionId: priceId, termVersionId: termId, agreementVersionId: agreementId, expectedGeneration: release?.generation ?? "0" } });
  const done = state.kind === "done" && state.operation === RULES_RELEASE_OPERATION;
  const busy = state.kind === "busy" || state.kind === "recovering";
  const crossGame = Boolean(pending && pending.gameId !== rules.game.id);
  return (
    <Dialog open disablePointerDismissal onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent closeLabel="关闭窗口" showCloseButton={!busy} className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{done ? "已收到生效回执" : pending ? "核对原生效请求" : "选择版本并确认生效"}</DialogTitle><DialogDescription>只能选择已封存的版本。关闭窗口不会清除原请求或改变规则；审批通过与实际生效属于不同阶段。</DialogDescription></DialogHeader>
        {done ? (
          <div role="status" className="space-y-2 text-sm">
            <p>已收到第 {state.receipt.generation} 版组合的生效回执。生效时间请核对页面当前版本记录。</p>
            <p className="text-sm text-muted-foreground">{state.receipt.affectedCount === undefined ? "原回执未提供受影响账号数量，不按 0 显示。" : <>生效时，本游戏有 <b className="text-foreground">{state.receipt.affectedCount}</b> 个启用中的账号尚未接受新规则，需号主重新确认后才能继续使用新规则。</>}</p>
          </div>
        ) : (
          <>
            {pending ? <p className="rounded-md bg-muted/50 p-3 text-sm">原请求：游戏 {pending.gameId}{isRelease ? ` · 基线第 ${String(pending.body.expectedGeneration)} 版组合` : " · 高级草稿维护"}；保留原 key，不自动重发。{crossGame ? "请切回原游戏后核对。" : ""}</p> : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Pick label="价格版本" value={priceId} onChange={setPriceId} disabled={command.locked} options={sealed(rules.priceVersions).map((v) => ({ value: v.id, label: label(v, release?.priceVersionId) }))} />
              <Pick label="租期版本" value={termId} onChange={setTermId} disabled={command.locked} options={sealed(rules.termVersions).map((v) => ({ value: v.id, label: label(v, release?.termVersionId) }))} />
              <Pick label="出租协议" value={agreementId} onChange={setAgreementId} disabled={command.locked} options={sealed(rules.agreementVersions).map((v) => ({ value: v.id, label: label(v, release?.agreementVersionId, v.title) }))} />
            </div>
            {!crossGame ? <div><p className="mb-2 text-sm font-semibold">改了的规则</p><DiffTable rows={rows} empty={same ? "所选组合与当前生效组合相同，无需生效。" : "已提供的业务字段未发现差异；版本引用将变化。"} /></div> : null}
            <div className="text-xs"><p className="mb-1 font-semibold">沿用不变</p><p className="text-muted-foreground">{unchanged.length ? unchanged.join("、") : "无"}</p></div>
            <div className="text-xs"><p className="mb-1 font-semibold">本次引用的包赔条款</p>
              <p className="text-muted-foreground">{nextRef ?? "所选价格版本未引用包赔条款"} {curRef === nextRef ? <Badge variant="outline">沿用</Badge> : <Badge variant="warning">更换（原：{curRef ?? "无"}）</Badge>} · 条款单独维护，通过本次价格版本引用；正文查看待接入</p></div>
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <p>切换后，依赖旧规则的后续操作需重新确认；具体数量在生效后显示。</p>
              <p className="mt-1 text-muted-foreground">已冻结报价的订单按冻结时的报价结算。</p>
            </div>
            {state.kind === "conflict" ? <p role="alert" className="text-xs text-destructive">规则已被其他人更新（版本冲突）。请关闭后刷新页面，核对当前生效版本再确认。</p> : null}
            {state.kind === "unknown" ? <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">结果未知：{state.message ?? "请求可能已执行。核对原回执前不能重复提交；关闭或刷新仍保留原请求。"}</p> : null}
            {state.kind === "accepted" ? <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{state.message ?? "已收到生效回执，但当前规则尚未完成回读。不能再次提交。"}</p> : null}
            {state.kind === "blocked" || state.kind === "error" ? <p role="alert" className="text-sm text-destructive">{state.kind === "error" ? "请求被明确拒绝：" : ""}{state.message}</p> : null}
            {state.kind === "not_sent" ? <p role="status" className="text-sm text-muted-foreground">{state.message}</p> : null}
          </>
        )}
        <DialogFooter>
          {done ? <Button type="button" onClick={onClose}>完成</Button> : (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{pending ? "关闭（保留原请求）" : "暂不生效"}</Button>
              {pending ? <Button type="button" disabled={busy || crossGame} aria-busy={busy || undefined} onClick={() => void command.recover()}>{busy ? "核对中…" : "核对原回执"}</Button> : <Button type="button" disabled={same || command.locked || state.kind === "conflict" || !priceId || !termId || !agreementId} aria-busy={busy || undefined} onClick={() => void activate()}>{busy ? "生效中…" : "确认生效"}</Button>}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
