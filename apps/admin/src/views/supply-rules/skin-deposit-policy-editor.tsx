import "./rules-markdown.css";
import { useEffect, useMemo, useState } from "react";
import type { RulesResponse, SkinDepositRule } from "../../api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { draftCommand, type useRulesWrite } from "./rules-write";
import { DraftLine, type EnsureDraft, MONEY2 } from "./step0-editors";
import { buildSkinDepositPolicy, skinDepositDraft, skinDepositIssues, skinDepositSaveBody, SKIN_DEPOSIT_TYPES, type SkinDepositDraft } from "./skin-deposit-policy";

export function SkinDepositPolicyEditor({ rules, command, onDirtyChange, draftId, ensureDraft }: { rules: RulesResponse; command: ReturnType<typeof useRulesWrite>; onDirtyChange: (dirty: boolean) => void; draftId: string; ensureDraft: EnsureDraft }) {
  const id = draftId;
  const selected = rules.priceVersions.find(version => version.id === id);
  const current = rules.priceVersions.find(version => version.id === rules.release?.priceVersionId);
  const base = selected?.fundingPolicy ? selected : (current?.fundingPolicy ? current : rules.priceVersions.find(version => version.status === "SEALED" && version.fundingPolicy));
  const legacyV1 = Boolean(base?.fundingPolicy && base.fundingPolicy.recommendation.schema !== "deposit-recommendation-v2");
  const initial = useMemo(() => base?.fundingPolicy ? skinDepositDraft(base.fundingPolicy) : null, [base]);
  const [draft, setDraft] = useState<SkinDepositDraft | null>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [discardTo, setDiscardTo] = useState<string>();
  const [addKind, setAddKind] = useState<SkinDepositRule["ownerKind"]>("AGENT");
  const [addRarity, setAddRarity] = useState("");
  const dirty = JSON.stringify(draft) !== baseline;
  const issues = draft ? skinDepositIssues(draft) : [];
  const catalog = rules.depositCatalog;
  const locked = command.locked || (selected ? selected.status !== "DRAFT" : false); const sealedView = !!selected && selected.status !== "DRAFT";
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) return; const stop = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", stop); return () => window.removeEventListener("beforeunload", stop); }, [dirty]);
  useEffect(() => {
    if (dirty || command.locked) return;
    setDraft(initial); setBaseline(JSON.stringify(initial));
  }, [initial, dirty, command.locked]);
  const discard = () => { setDraft(initial); setBaseline(JSON.stringify(initial)); setNotice(undefined); setError(undefined); setDiscardTo(undefined); };
  const save = async () => {
    if (!base?.fundingPolicy || !draft || locked) return;
    setError(undefined); setNotice(undefined);
    try {
      if (draft.rules.some((row, index) => draft.rules.findIndex(other => other.ownerKind === row.ownerKind && other.rarityCode === row.rarityCode) !== index) || new Set(draft.overrides.map(row => row.skinId)).size !== draft.overrides.length || draft.overrides.some(row => !row.skinId)) throw new Error("匹配行或单词条覆盖重复，或尚未选择词条，请先修正。");
      const policy = buildSkinDepositPolicy(base.fundingPolicy, draft);
      const t = await ensureDraft(); if (!t) return;
      const result = await command.write(draftCommand(t.rules.game.id, "price", "update", skinDepositSaveBody(t.rules, t.draft, base, policy), t.draft.id));
      if (!result) return;
      setBaseline(JSON.stringify(draft)); setNotice(issues.length ? "已保存草稿。还有金额没填，填完才能提交。" : "已保存草稿。去「待发布修改」提交。");
    } catch (failure) { setError((failure as Error).message); }
  };
  const amount = (label: string, value: string, onChange: (value: string) => void) => <Input aria-label={label} inputMode="decimal" value={value} placeholder="待配置" disabled={locked} className="min-w-24 text-right tabular-nums" onChange={event => { if (MONEY2.test(event.target.value)) onChange(event.target.value); }} />;
  const updateRow = (index: number, key: "first" | "subsequent", value: string) => setDraft(previous => previous ? { ...previous, rules: previous.rules.map((row, i) => i === index ? { ...row, [key]: value } : row) } : previous);
  return <section id={`skin-deposit-policy-${rules.game.id}`} tabIndex={-1} className="section-panel scroll-mt-20 space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="皮肤推荐押金配置">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">皮肤推荐押金</h2><p className="mt-1 text-xs text-muted-foreground">配置皮肤类型与品质的阶梯押金加价规则（首件加价与后续每件加价）。</p></div></div>
    {legacyV1 ? <div role="note" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-950 dark:text-amber-200">线上皮肤押金是旧写法，保存后按下表重新生成。填 0 表示不加价，留空表示还没配。</div> : null}
    {!base?.fundingPolicy ? <p role="status" className="text-sm text-muted-foreground">尚无可复用的资金政策。请先完成原资金约束配置；此处不代填保险箱、属性、保证金或押金上限。</p> : <>
      <div className="grid gap-3 sm:grid-cols-2">
        <DraftLine selected={selected} locked={command.locked} />
        <label className="min-w-0 space-y-1 text-xs"><span className="text-muted-foreground">本次修改的版本名</span><Input aria-label="本次资金政策版本" placeholder="例如 2026-11" value={draft?.policyVersion ?? ""} disabled={locked} onChange={event => setDraft(previous => previous ? { ...previous, policyVersion: event.target.value } : previous)} /></label>
      </div>
      
      {!catalog ? <p role="status" className="text-xs text-muted-foreground">品质和词条列表还没加载，暂时只能改现有行。</p> : null}
      {draft ? <>
        <p className="text-xs text-muted-foreground">规则计算优先级：单项词条覆盖 ＞ 类型与品质加价 ＞ 类型默认兜底（留空＝还没配，填 0＝不加价）。</p>
        <div className="skin-rules-table overflow-x-auto"><Table className="min-w-[600px]"><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>品质匹配</TableHead><TableHead className="text-right">首件加价（元）</TableHead><TableHead className="text-right">后续每件（元）</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {draft.rules.map((row, index) => <TableRow key={`${row.ownerKind}:${row.rarityCode ?? "fallback"}:${index}`}><TableCell>{SKIN_DEPOSIT_TYPES[row.ownerKind]}</TableCell><TableCell>{row.rarityCode === null ? "其它品质（兜底）" : catalog?.rarities.find(rarity => rarity.code === row.rarityCode)?.name ?? row.rarityCode}</TableCell><TableCell>{amount(`第${index + 1}行首件加价`, row.first, value => updateRow(index, "first", value))}</TableCell><TableCell>{amount(`第${index + 1}行后续每件加价`, row.subsequent, value => updateRow(index, "subsequent", value))}</TableCell><TableCell>{row.rarityCode !== null ? <Button type="button" variant="ghost" disabled={locked} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}>移除</Button> : <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground font-normal">必配</span>}</TableCell></TableRow>)}
        </TableBody></Table></div>
        {catalog && !sealedView ? <div className="flex flex-wrap items-end gap-2"><div className="w-40"><SupplySelect label="新增规则类型" value={addKind} options={Object.entries(SKIN_DEPOSIT_TYPES).map(([value, label]) => ({ value, label }))} disabled={locked} onValueChange={value => setAddKind(value as SkinDepositRule["ownerKind"])} /></div><div className="w-52"><SupplySelect label="新增规则品质" value={addRarity} options={[{ value: "", label: "其它品质（兜底）" }, ...catalog.rarities.filter(rarity => rarity.enabled).map(rarity => ({ value: rarity.code, label: rarity.name }))]} disabled={locked} onValueChange={setAddRarity} /></div><Button type="button" variant="outline" disabled={locked || draft.rules.some(row => row.ownerKind === addKind && row.rarityCode === (addRarity || null))} onClick={() => setDraft({ ...draft, rules: [...draft.rules, { ownerKind: addKind, rarityCode: addRarity || null, first: "", subsequent: "" }] })}>添加匹配规则</Button></div> : null}
        <div className="space-y-2 border-t border-border pt-4"><h3 className="text-sm font-semibold">单词条覆盖</h3><p className="text-xs text-muted-foreground">每个选中词条单独计入指定金额，替代其类型与品质规则。</p>
          {draft.overrides.length === 0 ? <p className="rounded-md border border-dashed border-border px-3.5 py-3 text-xs text-muted-foreground">暂无单独覆盖的皮肤词条。如需为指定皮肤设置独立押金金额，可点击下方添加。</p> : null}
          {draft.overrides.map((row, index) => <div key={index} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_160px_auto]"><SupplySelect label={`第${index + 1}项覆盖词条`} value={row.skinId} options={[{ value: "", label: "请选择词条" }, ...(catalog?.skins ?? []).map(skin => ({ value: skin.id, label: skin.name })), ...(!catalog?.skins.some(skin => skin.id === row.skinId) && row.skinId ? [{ value: row.skinId, label: `${row.skinId}（现目录未提供，保留既有配置）` }] : [])]} disabled={locked || !catalog} onValueChange={value => setDraft({ ...draft, overrides: draft.overrides.map((item, i) => i === index ? { ...item, skinId: value } : item) })} />{amount(`第${index + 1}项词条覆盖金额（元）`, row.amount, value => setDraft({ ...draft, overrides: draft.overrides.map((item, i) => i === index ? { ...item, amount: value } : item) }))}<Button type="button" variant="ghost" disabled={locked} onClick={() => setDraft({ ...draft, overrides: draft.overrides.filter((_, i) => i !== index) })}>移除覆盖</Button></div>)}
          {sealedView ? null : <Button type="button" variant="outline" disabled={locked || !catalog} onClick={() => setDraft({ ...draft, overrides: [...draft.overrides, { skinId: "", amount: "" }] })}>添加单词条覆盖</Button>}
        </div>
        {issues.length ? <p role="status" className="text-sm text-muted-foreground">待配置：{issues.join("；")}。可以先保存，填完才能提交。</p> : null}
        {selected && selected.status !== "DRAFT" ? null : <div className="flex flex-wrap gap-2"><Button type="button" disabled={locked || !(dirty || (legacyV1 && selected?.fundingPolicy?.recommendation.schema !== "deposit-recommendation-v2"))} onClick={() => void save()}>保存皮肤押金草稿</Button>{dirty ? <Button type="button" variant="ghost" disabled={command.locked} onClick={() => setDiscardTo(id)}>放弃本次输入</Button> : null}</div>}
      </> : null}
    </>}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <Dialog open={discardTo !== undefined} onOpenChange={open => { if (!open) setDiscardTo(undefined); }}><DialogContent closeLabel="保留输入"><DialogHeader><DialogTitle>放弃尚未保存的皮肤押金输入？</DialogTitle><DialogDescription>本地输入会丢弃，已保存的版本保持原状。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDiscardTo(undefined)}>继续编辑</Button><Button type="button" onClick={discard}>放弃并继续</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
