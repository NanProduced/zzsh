import { useMemo, useState, type ReactNode } from "react";
import { CircleAlert, ChevronDownIcon, ChevronRightIcon, Clock, Info, TriangleAlert } from "lucide-react";

import { formatDate, type RulesResponse } from "../../api";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import {
  asHaffV2, boundText, centsYuan, compatTierCount, haffCount, makeupShare, num, payoutRef, perMillion,
  agreementDiff, priceDiff, safeBoxLabel, spread, standardItemRows, termDiff, unitLabel, unitYuan, yuan, type RuleDiffRow,
} from "./rules-model";
import { TrialWindow } from "./rules-trial-window";
import { activePriceDraft, pendingSealedPrice, MutedDetails, priceDiff as draftDiff } from "./publish-flow";
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
      <p className="mb-1 text-[11px] text-muted-foreground sm:hidden">左右滑动查看完整表格</p>
      <div className="overflow-x-auto rounded-md border border-border/60 [&_th]:h-9 [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted-foreground [&_td]:text-sm" role="region" aria-label={label} tabIndex={0}>{children}</div>
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
          {note ? <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{note}</p> : null}
        </div>
        {action}
      </header>
      {metrics ? <dl className="flex flex-wrap gap-x-8 gap-y-3 border-b border-border/60 pb-4">{metrics}</dl> : null}
      {children}
      {info ? (
        <Collapsible open={infoOpen} onOpenChange={setInfoOpen}>
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" />}>{infoOpen ? "收起说明" : "规则说明"}</CollapsibleTrigger>
          <CollapsibleContent><div className="mt-2 space-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{info}</div></CollapsibleContent>
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

function Hint({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">{children}</p>;
}

function renderDiffValue(val: string, isAfter: boolean) {
  if (val === "将移除") {
    return <span className="inline-flex items-center rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">将移除</span>;
  }
  if (val === "更新为新版") {
    return <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">更新为新版</span>;
  }
  if (val.includes("；")) {
    const parts = val.split("；");
    return (
      <div className={`space-y-1 text-left ${isAfter ? "text-foreground font-medium" : "text-muted-foreground"}`}>
        {parts.map((part, idx) => (
          <div key={idx} className="text-xs leading-relaxed">{part.trim()}</div>
        ))}
      </div>
    );
  }
  return <span className={isAfter ? "text-foreground font-medium" : "text-muted-foreground"}>{val}</span>;
}

function DiffTable({ rows, empty }: { rows: RuleDiffRow[]; empty: string }) {
  if (rows.length === 0) return <Hint>{empty}</Hint>;
  return (
    <ScrollTable label="规则对比">
      <Table className="min-w-[560px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">分组</TableHead>
            <TableHead className="w-48">项目</TableHead>
            <TableHead className="w-40 text-right">现在</TableHead>
            <TableHead className="min-w-[160px] text-right">调整后</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="align-top">
                <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground whitespace-nowrap">
                  {r.group}
                </span>
              </TableCell>
              <TableCell className="align-top max-w-64 whitespace-normal break-words">
                <span className="font-medium text-foreground">{r.label}</span>
                {r.detail ? <MutedDetails className="mt-1"><p className="text-xs text-muted-foreground">{r.detail}</p></MutedDetails> : null}
              </TableCell>
              <TableCell className="align-top max-w-80 whitespace-pre-wrap break-words text-right tabular-nums">
                {r.before ? renderDiffValue(r.before, false) : "—"}
              </TableCell>
              <TableCell className="align-top max-w-80 whitespace-pre-wrap break-words text-right tabular-nums">
                {renderDiffValue(r.after, true)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollTable>
  );
}

/**
 * 规则与价目 · 第一片：只读总览 + 版本条 + 服务端试算 + Boss 确认生效。
 * 价格只读后端返回值，不在页面里写死；每 1M 金额只是按比例换算的显示辅助。
 */
export function RulesOverview({ rules, command, isBoss, canPreview, canEdit = false, onOpenSkin, onOpenSettlement }: { rules: RulesResponse; command: ReturnType<typeof useRulesWrite>; isBoss: boolean; canPreview: boolean; canEdit?: boolean; onOpenSkin?: () => void; onOpenSettlement?: () => void }) {
  const [trialOpen, setTrialOpen] = useState(false);
  const V = (_key: string, display: ReactNode, _opts?: { unit?: string; wide?: boolean }) => display;
  const release = rules.release;
  const pendingSkinV2 = pendingSealedPrice(rules)?.fundingPolicy?.recommendation.schema === "deposit-recommendation-v2";
  const liveSkinV2 = rules.priceVersions.find(v => v.id === release?.priceVersionId)?.fundingPolicy?.recommendation.schema === "deposit-recommendation-v2";
  const skinV2Ready = pendingSkinV2 || liveSkinV2;
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
  const inProgress = draftDiff(rules, activePriceDraft(rules)).length > 0;
  const changeBadge = (changed: boolean, rows: () => RuleDiffRow[]) => changed ? (
    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => openCompare(rows())}>
      <Badge variant="warning">有未生效调整</Badge><span className="ml-1 underline-offset-2 hover:underline">查看对比</span>
    </Button>
  ) : null;

  const boxes = haff ? Object.entries(haff.baseBySafeBox) : [];
  const p = haff ? num(haff.compatibility.ordinary.spreadDelta) : null;
  const pf = haff?.compatibility.fast ? num(haff.compatibility.fast.spreadDelta) : null;
  const standardDelta = haff ? num(haff.compatibility.ordinary.discounts.STANDARD) : null;
  const itemRows = curPrice ? standardItemRows(rules, curPrice.id) : [];
  const compatTiers = curPrice ? compatTierCount(rules, curPrice.id) : 0;
  const termOpts = curTerm ? rules.termOptions.filter((o) => o.versionId === curTerm.id) : [];
  const example = boxes.length ? boxes[boxes.length - 1]! : undefined;
  const exampleRatio = example ? num(example[1]) : null;

  return (
    <div className="space-y-4">
      <section className="section-panel" aria-label="当前生效版本"><h2 className="mb-3 text-base font-semibold">当前生效版本</h2>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div><p className="text-xs text-muted-foreground">当前生效</p><p className="text-lg font-semibold tabular-nums">{release ? "已生效" : "尚未生效"}</p></div>
          <div><p className="text-xs text-muted-foreground">生效时间</p><p className="text-lg font-semibold tabular-nums">{release ? formatDate(release.activatedAt) : "—"}</p></div>
          <div className="min-w-0"><p className="text-xs text-muted-foreground">待发布</p>
            <p className="text-sm leading-7">{sealedPending ? `${sealedPending} 个已提交，等 Boss 生效` : inProgress ? "" : "无"}{inProgress ? `${sealedPending ? " · " : ""}1 份价格草稿编辑中` : ""}</p></div>
          <div className="ml-auto flex flex-wrap gap-2">
            {canEdit && !skinV2Ready ? <Button type="button" variant="secondary" onClick={onOpenSkin}>配置新版皮肤押金</Button> : null}
            <Button type="button" variant="outline" disabled={!canPreview || !release} title={!canPreview ? "当前账号没有内部试算权限" : undefined} onClick={() => setTrialOpen(true)}>试算一单</Button>
            {isBoss ? <Button type="button" disabled={command.locked && command.pending?.operation !== RULES_RELEASE_OPERATION} onClick={() => setDialog("confirm")}>选择版本并确认生效</Button> : null}
          </div>
        </div>
                <p className="mt-2 text-sm text-muted-foreground">这里只看线上值和试算；改规则去左侧对应分区。</p>
      </section>

      {!release ? <section className="section-panel"><Hint>还没有生效的规则。请联系平台管理员配置初始生效规则，提交后由 Boss 确认生效。</Hint></section> : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card wide title="哈夫币计价规则" note="平台按比例差计算租客比例与金额；比例＝1 元换多少万哈夫币，比例越小单价越高"
              metrics={haff && curPrice?.mode === "SPREAD" && p !== null ? (<>
                <Metric label="平台比例差 · 普通/自定义" value={haff.compatibility.ordinary.spreadDelta} />
                <Metric label="平台比例差 · 快速" value={haff.compatibility.fast?.spreadDelta || pf || "—"} />
                <Metric label="参考平台价差" value={perMillion(50) !== null && p !== null && perMillion(50 - p + (standardDelta ?? 0)) !== null ? yuan(perMillion(50 - p + (standardDelta ?? 0))! - perMillion(50)!) : "待计算"} unit="/1M" sub="以常用 50 比例测算" />
                <Metric label="计价模式" value="差价换算" />
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
                          {haff.compatibility.modes.fast.enabled && haff.compatibility.fast ? <Badge variant="secondary">快速模式: {haff.compatibility.fast.spreadDelta}</Badge> : null}
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
                      <span className="text-xs text-muted-foreground">当前比例差：普通 {haff.compatibility.ordinary.spreadDelta} · 辅助测算</span>
                    </div>
                    <ScrollTable label="换算参考示例">
                      <Table className="mt-2 min-w-[520px]">
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
                            const sp = p ?? 10;
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
                  <Table className="min-w-[480px]">
                    <TableHeader><TableRow><TableHead>物品</TableHead><TableHead>计费单位</TableHead><TableHead className="text-right">租客价</TableHead><TableHead className="text-right">号主价</TableHead><TableHead className="text-right">平台价差/单位</TableHead></TableRow></TableHeader>
                    <TableBody>{itemRows.map(({ item, line }) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.name}{!item.enabled ? <Badge variant="unknown" className="ml-1">已停用</Badge> : null}</TableCell>
                        <TableCell>{line?.unitQuantity && line.unitQuantity !== "1" ? `每 ${line.unitQuantity} ${unitLabel(item.unit, item.code)}` : `每${unitLabel(item.unit, item.code)}`}</TableCell>
                        <TableCell className="text-right tabular-nums">{V(`item.${item.id}.buyer`, unitYuan(line?.buyerUnitAmount), { unit: "元" })}</TableCell>
                        <TableCell className="text-right tabular-nums">{V(`item.${item.id}.owner`, unitYuan(line?.ownerUnitAmount), { unit: "元" })}</TableCell>
                        <TableCell className="text-right tabular-nums">{spread(line?.buyerUnitAmount, line?.ownerUnitAmount)}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </ScrollTable>
              )}
            </Card>

            <Card title="押金规则" note="系统给推荐押金，号主填的金额为准"
              info={policy ? <p>推荐押金＝各项之和，按政策取整单位（{centsYuan(policy.recommendation.parameters.rounding.unitCents)}）向上取整，零值时最低 {centsYuan(policy.recommendation.parameters.rounding.zeroFallbackCents)}，不超过上限；号主可改，但必须满足最低值且不超过上限。</p> : <p>当前生效价格版本未提供资金政策，本节不使用任何默认金额。</p>}
              badges={changeBadge(priceChanged, () => priceDiff(rules, curPrice?.id, latestPrice?.id).filter((r) => r.group === "押金规则"))}>
              {!policy ? <Hint>资金政策未提供：押金上限、普通/包赔最低值、加价项与号主保证金要求均为未提供，不参与本地估算。</Hint> : (
                <>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-border/60 pb-4 sm:grid-cols-4">
                    <div><dt className="text-xs text-muted-foreground">押金上限</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{V("dep.cap", centsYuan(policy.recommendation.parameters.upperLimitCents), { unit: "元" })}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">普通最低</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{centsYuan(policy.ownerDepositRules.normal.minCents)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">选全额包赔时最低</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{centsYuan(policy.ownerDepositRules.fullPayoutSelected.minCents)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">号主保证金</dt><dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums">{policy.guaranteeRequirement.mode === "NOT_REQUIRED" ? "政策不要求" : centsYuan(policy.guaranteeRequirement.requiredCents)}</dd></div>
                  </dl>

                  <ScrollTable label="推荐押金加价项">
                    <Table className="min-w-[460px]">
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
                  {policy.recommendation.schema === "deposit-recommendation-v1" ? <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">{pendingSkinV2 ? "线上仍是旧皮肤押金规则，待生效版本已更新为新版。" : "线上皮肤押金还是旧规则，去「皮肤推荐押金」配好新版并提交。"}</p> : null}
                </>
              )}
            </Card>
          </div>

          <section className="section-panel" aria-label="租期与出租协议引用">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div><h2 className="text-base font-semibold">租期与每日消耗 · 出租协议引用</h2><p className="mt-0.5 text-xs text-muted-foreground">这里只读；改协议去「出租协议」。</p></div>
              <div className="flex flex-wrap gap-2">{changeBadge(termChanged, () => termDiff(rules, curTerm?.id, latestTerm?.id))}{changeBadge(agreementChanged, () => agreementDiff(rules, curAgreement?.id, latestAgreement?.id))}</div>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
              <div className="min-w-0">
                {termOpts.length ? (
                  <ScrollTable label="租期档位表">
                    <Table className="min-w-[340px]">
                      <TableHeader><TableRow><TableHead>档位</TableHead><TableHead className="text-right">每日消耗</TableHead><TableHead>租期取整</TableHead></TableRow></TableHeader>
                      <TableBody>{termOpts.map((option) => (
                        <TableRow key={option.code}>
                          <TableCell>{termName(option)}</TableCell>
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
                    <p className="mt-2 text-xs text-muted-foreground">全额包赔条款：{payoutName(rules, curPrice) ?? "未设置"}</p>
                    <MutedDetails className="mt-1"><p className="break-all">正文摘要 {curAgreement.digest ? curAgreement.digest.slice(0, 16) + "…" : "未提供"}{payoutRef(curPrice) ? ` · 条款 ${payoutRef(curPrice)}` : ""}</p></MutedDetails>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setDialog("agreement")}>查看协议正文</Button>
                  </>
                ) : <p className="mt-1 text-sm text-muted-foreground">生效组合未提供出租协议版本，或该版本未随规则读取返回。</p>}
                <p className="mt-2 text-[11px] text-muted-foreground">换协议后，已有订单仍按下单时的协议。</p>
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

      {trialOpen && release ? <TrialWindow rules={rules} onClose={() => setTrialOpen(false)} /> : null}
      {dialog === "confirm" ? <ConfirmDialog rules={rules} command={command} onOpenSettlement={onOpenSettlement} onClose={() => { setDialog("none"); command.dismissResult(); }} /> : null}
    </div>
  );
}

export function SettlementRules() {
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
              <Table className="min-w-[360px]">
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

/** 包赔条款显示名：用条款标题，不显示编号。 */
function payoutName(rules: RulesResponse, price: RulesResponse["priceVersions"][number] | undefined): string | null {
  const fp = price?.fundingPolicy;
  if (!fp?.fullPayoutPolicyRef) return null;
  return (rules.fullPayoutTermsVersions ?? []).find(t => t.policyRef === fp.fullPayoutPolicyRef && t.policyVersion === fp.fullPayoutPolicyVersion)?.title ?? "已设置";
}

/** 租期档位名：旧数据的名字是代码（如 legacy_daily_10m）时，换成“每天 10M”。 */
export function termName(option: { name: string; code: string; dailyConsumption: string }): string {
  if (option.name && !/^[a-z0-9_]+$/.test(option.name)) return option.name;
  const m = /daily_(\d+)m$/i.exec(option.code);
  return m ? `每天 ${m[1]}M` : `每天 ${haffCount(option.dailyConsumption)}M`;
}

function History({ rules }: { rules: RulesResponse }) {
  const [open, setOpen] = useState(false);
  const rows = [
    ...rules.priceVersions.map((v) => ({ kind: "价格", v })),
    ...rules.termVersions.map((v) => ({ kind: "租期", v })),
    ...rules.agreementVersions.map((v) => ({ kind: "出租协议", v })),
  ].sort((a, b) => (b.v.sealedAt ?? b.v.createdAt).localeCompare(a.v.sealedAt ?? a.v.createdAt));
  const current = activePriceDraft(rules)?.id;
  const oldDrafts = rows.filter(r => r.v.status === "DRAFT" && r.v.id !== current);
  const main = rows.filter(r => !(r.v.status === "DRAFT" && r.v.id !== current));
  const inRelease = (id: string) => rules.release && [rules.release.priceVersionId, rules.release.termVersionId, rules.release.agreementVersionId].includes(id);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="section-panel">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-start px-0 py-2 text-left whitespace-normal" />}>
        {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}<span className="text-base font-semibold">版本记录</span><span className="text-xs text-muted-foreground">共 {main.length} 个版本</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollTable label="版本记录">
          <Table className="mt-3 min-w-[440px]">
            <TableHeader><TableRow><TableHead>类型</TableHead><TableHead>状态</TableHead><TableHead>创建</TableHead><TableHead>提交</TableHead></TableRow></TableHeader>
            <TableBody>{main.map(({ kind, v }) => (
              <TableRow key={v.id}><TableCell>{kind}</TableCell>
                <TableCell>{inRelease(v.id) ? <Badge variant="success">当前生效</Badge> : v.status === "SEALED" ? <Badge variant="outline">已提交</Badge> : <Badge variant="secondary">草稿</Badge>}</TableCell>
                <TableCell>{formatDate(v.createdAt)}</TableCell><TableCell>{v.sealedAt ? formatDate(v.sealedAt) : "—"}</TableCell></TableRow>
            ))}</TableBody>
          </Table>
        </ScrollTable>
        {oldDrafts.length ? <MutedDetails className="mt-3" label={`历史草稿（${oldDrafts.length}）`}><p className="mt-1 text-muted-foreground">以前没提交的草稿，不会生效，保留备查。</p><ul className="mt-1 divide-y divide-border rounded-md border border-border">{oldDrafts.map(({ kind, v }) => <li key={v.id} className="flex gap-3 px-3 py-1.5"><span className="w-16">{kind}</span><span className="text-muted-foreground">{formatDate(v.createdAt)} 创建</span></li>)}</ul></MutedDetails> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ConfirmDialog({ rules, command, onClose, onOpenSettlement }: { rules: RulesResponse; command: ReturnType<typeof useRulesWrite>; onClose: () => void; onOpenSettlement?: () => void }) {
  const release = rules.release;
  const sealed = <T extends { status: string }>(list: T[]) => list.filter((v) => v.status === "SEALED");
  const first = (list: { id: string; status: string }[], current?: string) => sealed(list)[0]?.id ?? current ?? "";
  const { state, pending } = command;
  const isRelease = pending?.operation === RULES_RELEASE_OPERATION;
  const [priceId, setPriceId] = useState(() => isRelease ? String(pending.body.priceVersionId) : first(rules.priceVersions, release?.priceVersionId));
  const [termId, setTermId] = useState(() => isRelease ? String(pending.body.termVersionId) : first(rules.termVersions, release?.termVersionId));
  const [agreementId, setAgreementId] = useState(() => isRelease ? String(pending.body.agreementVersionId) : first(rules.agreementVersions, release?.agreementVersionId));
  const label = (v: { revision: string; sealedAt: string | null; id: string }, current?: string, title?: string) => `${title ? title + " · " : ""}${v.sealedAt ? formatDate(v.sealedAt) + " 提交" : "草稿"}${v.id === current ? "（当前生效）" : ""}`;
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
        <DialogHeader><DialogTitle>{done ? "已收到生效回执" : pending ? "核对原生效请求" : "选择版本并确认生效"}</DialogTitle><DialogDescription>只能选已提交的版本。关闭窗口不会改变线上规则。</DialogDescription></DialogHeader>
        {done ? (
          <div role="status" className="space-y-2 text-sm">
            <p>已生效，新订单按新规则计算。</p>
            <p className="text-sm text-muted-foreground">{state.receipt.affectedCount === undefined ? "原回执未提供受影响账号数量，不按 0 显示。" : <>生效时，本游戏有 <b className="text-foreground">{state.receipt.affectedCount}</b> 个启用中的账号尚未接受新规则，需号主重新确认后才能继续使用新规则。</>}</p>
          </div>
        ) : (
          <>
            {pending ? <p className="rounded-md bg-muted/50 p-3 text-sm">原请求：游戏 {pending.gameId}{isRelease ? ` · 基线第 ${String(pending.body.expectedGeneration)} 版组合` : " · 高级草稿维护"}；保留原 key，不自动重发。{crossGame ? "请切回原游戏后核对。" : ""}</p> : null}
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/70 bg-card/40 p-3.5 sm:grid-cols-3">
              <Pick label="价格版本" value={priceId} onChange={setPriceId} disabled={command.locked} options={sealed(rules.priceVersions).map((v) => ({ value: v.id, label: label(v, release?.priceVersionId) }))} />
              <Pick label="租期版本" value={termId} onChange={setTermId} disabled={command.locked} options={sealed(rules.termVersions).map((v) => ({ value: v.id, label: label(v, release?.termVersionId) }))} />
              <Pick label="出租协议" value={agreementId} onChange={setAgreementId} disabled={command.locked} options={sealed(rules.agreementVersions).map((v) => ({ value: v.id, label: label(v, release?.agreementVersionId, v.title) }))} />
            </div>
            {!crossGame ? <div><p className="mb-2 text-sm font-semibold">改了的规则</p><DiffTable rows={rows} empty={same ? "所选组合与当前生效组合相同，无需生效。" : "已提供的业务字段未发现差异；版本引用将变化。"} /></div> : null}
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs sm:grid-cols-2">
              <div className="min-w-0">
                <p className="font-semibold text-foreground">沿用不变</p>
                <p className="mt-1 text-muted-foreground">{unchanged.length ? unchanged.join("、") : "无"}</p>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-foreground">本次引用的包赔条款</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                  <span>{payoutName(rules, rules.priceVersions.find((v) => v.id === priceId)) ?? "未设置"}</span>
                  {curRef === nextRef ? <Badge variant="outline" className="text-[11px] font-normal">沿用</Badge> : <Badge variant="warning" className="text-[11px]">更换（原：{payoutName(rules, rules.priceVersions.find((v) => v.id === release?.priceVersionId)) ?? "无"}）</Badge>}
                  {onOpenSettlement ? <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => { onClose(); onOpenSettlement(); }}>查看包赔正文</Button> : null}
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="space-y-0.5">
                <p className="font-medium text-foreground">生效影响说明</p>
                <p>切换后，依赖旧规则的后续操作需重新确认；具体数量在生效后显示。</p>
                <p>已冻结报价的订单按冻结时的报价结算。</p>
              </div>
            </div>
            {state.kind === "conflict" ? <Alert variant="warning" role="alert"><TriangleAlert aria-hidden="true" /><AlertTitle>规则已被其他人更新</AlertTitle><AlertDescription>版本冲突。请关闭后刷新页面，核对当前生效版本再确认。</AlertDescription></Alert> : null}
            {state.kind === "unknown" ? <Alert variant="warning" role="status"><TriangleAlert aria-hidden="true" /><AlertTitle>结果未知</AlertTitle><AlertDescription>{state.message ?? "请求可能已执行。核对原回执前不能重复提交；关闭或刷新仍保留原请求。"}</AlertDescription></Alert> : null}
            {state.kind === "accepted" ? <Alert variant="warning" role="status"><Clock aria-hidden="true" /><AlertTitle>已确认生效，线上规则刷新中</AlertTitle><AlertDescription>{state.message ?? "稍后刷新查看，刷新完成前不要重复提交。"}</AlertDescription></Alert> : null}
            {state.kind === "blocked" ? <Alert variant="warning" role="alert"><TriangleAlert aria-hidden="true" /><AlertTitle>当前条件不允许提交</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
            {state.kind === "error" ? <Alert variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>请求被明确拒绝</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
            {state.kind === "not_sent" ? <Alert variant="info" role="status"><Info aria-hidden="true" /><AlertDescription>{state.message}</AlertDescription></Alert> : null}
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
