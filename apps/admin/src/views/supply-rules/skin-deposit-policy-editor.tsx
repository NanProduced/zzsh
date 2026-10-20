import { useEffect, useMemo, useState } from "react";
import type { RulesResponse, SkinDepositRule } from "../../api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { draftCommand, type useRulesWrite } from "./rules-write";
import { buildSkinDepositPolicy, skinDepositDraft, skinDepositIssues, skinDepositSaveBody, SKIN_DEPOSIT_TYPES, type SkinDepositDraft } from "./skin-deposit-policy";

export function SkinDepositPolicyEditor({ rules, command, onDirtyChange }: { rules: RulesResponse; command: ReturnType<typeof useRulesWrite>; onDirtyChange: (dirty: boolean) => void }) {
  const drafts = rules.priceVersions.filter(version => version.status === "DRAFT");
  const [id, setId] = useState(drafts[0]?.id ?? "");
  const [sourceId, setSourceId] = useState("");
  const selected = rules.priceVersions.find(version => version.id === id);
  const current = rules.priceVersions.find(version => version.id === rules.release?.priceVersionId);
  const source = rules.priceVersions.find(version => version.id === sourceId && version.fundingPolicy);
  const base = selected?.fundingPolicy ? selected : source ?? (current?.fundingPolicy ? current : rules.priceVersions.find(version => version.status === "SEALED" && version.fundingPolicy));
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
  const locked = command.locked || selected?.status !== "DRAFT";
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) return; const stop = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", stop); return () => window.removeEventListener("beforeunload", stop); }, [dirty]);
  useEffect(() => {
    if (dirty || command.locked) return;
    setDraft(initial); setBaseline(JSON.stringify(initial));
  }, [initial, dirty, command.locked]);
  const choose = (next: string) => {
    const version = rules.priceVersions.find(version => version.id === next);
    const policy = version?.fundingPolicy ?? current?.fundingPolicy ?? base?.fundingPolicy;
    const value = policy ? skinDepositDraft(policy) : null;
    setId(next); setSourceId(""); setDraft(value); setBaseline(JSON.stringify(value)); setNotice(undefined); setError(undefined); setDiscardTo(undefined);
  };
  const create = async () => {
    if (!base?.fundingPolicy || dirty) return;
    const result = await command.write(draftCommand(rules.game.id, "price", "create", { gameId: rules.game.id, mode: base.mode }));
    if (!result) return;
    const next = skinDepositDraft(base.fundingPolicy);
    setSourceId(base.id); setId(result.receipt.id!); setDraft(next); setBaseline(JSON.stringify(next)); setNotice("已创建空价格草稿。保存皮肤押金时会复制下方所示来源的其他价格与资金约束。");
  };
  const save = async () => {
    if (!selected || !base?.fundingPolicy || !draft || locked) return;
    setError(undefined); setNotice(undefined);
    try {
      if (draft.rules.some((row, index) => draft.rules.findIndex(other => other.ownerKind === row.ownerKind && other.rarityCode === row.rarityCode) !== index) || new Set(draft.overrides.map(row => row.skinId)).size !== draft.overrides.length || draft.overrides.some(row => !row.skinId)) throw new Error("匹配行或单词条覆盖重复，或尚未选择词条，请先修正。");
      const policy = buildSkinDepositPolicy(base.fundingPolicy, draft);
      const result = await command.write(draftCommand(rules.game.id, "price", "update", skinDepositSaveBody(rules, selected, base, policy), selected.id));
      if (!result) return;
      setBaseline(JSON.stringify(draft)); setNotice(issues.length ? "待配置草稿已保存；金额补齐前不能封存或生效。" : "皮肤押金草稿已保存；核对并封存后，沿现有版本组合流程生效。");
    } catch (failure) { setError((failure as Error).message); }
  };
  const seal = async () => {
    if (!selected || dirty || issues.length || selected.fundingPolicy?.recommendation.schema !== "deposit-recommendation-v2") return;
    await command.write(draftCommand(rules.game.id, "price", "seal", { expectedRevision: selected.revision }, selected.id));
  };
  const amount = (label: string, value: string, onChange: (value: string) => void) => <Input aria-label={label} inputMode="decimal" value={value} placeholder="待配置" disabled={locked} className="min-w-24 text-right tabular-nums" onChange={event => onChange(event.target.value)} />;
  const updateRow = (index: number, key: "first" | "subsequent", value: string) => setDraft(previous => previous ? { ...previous, rules: previous.rules.map((row, i) => i === index ? { ...row, [key]: value } : row) } : previous);
  return <section id={`skin-deposit-policy-${rules.game.id}`} tabIndex={-1} className="section-panel scroll-mt-20 space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="皮肤推荐押金配置">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">皮肤推荐押金配置</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">按类型与品质设置首件、后续每件加价；典藏不自动加价。旧分组与金额保留在原版本，新版金额由运营填写。</p></div><Button type="button" variant="outline" disabled={command.locked || dirty || !base?.fundingPolicy} onClick={() => void create()}>新建皮肤押金草稿</Button></div>
    {!base?.fundingPolicy ? <p role="status" className="text-sm text-muted-foreground">尚无可复用的资金政策。请先完成原资金约束配置；此处不代填保险箱、属性、保证金或押金上限。</p> : <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1 text-xs"><span className="text-muted-foreground">价格草稿</span><SupplySelect label="皮肤押金价格草稿" className="max-w-full *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate" value={id} options={[{ value: "", label: drafts.length ? "请选择草稿" : "请先新建草稿" }, ...drafts.map(version => ({ value: version.id, label: `${version.id} · 修订 ${version.revision}` }))]} disabled={command.locked} onValueChange={value => dirty ? setDiscardTo(value) : choose(value)} /></label>
        <label className="min-w-0 space-y-1 text-xs"><span className="text-muted-foreground">本次资金政策版本</span><Input aria-label="本次资金政策版本" placeholder="填写新的版本标识" value={draft?.policyVersion ?? ""} disabled={locked} onChange={event => setDraft(previous => previous ? { ...previous, policyVersion: event.target.value } : previous)} /></label>
      </div>
      <p className="text-xs text-muted-foreground">其他资金约束来源：{base.id} · {base.fundingPolicy.policyVersion}。保险箱、角色属性、取整、封顶、号主最低实际押金、保证金、会员与条款沿用该政策。</p>
      {!catalog ? <p role="status" className="text-xs text-muted-foreground">品质与词条选项尚未接入；可填写现有行，补充精确匹配与单词条覆盖需刷新完整目录合同。</p> : <p className="text-xs text-muted-foreground">选项来自目录版本 {catalog.catalogRevision}；新增词条按其类型与品质自动匹配。</p>}
      {draft ? <>
        <p className="text-sm">匹配顺序：单词条覆盖 → 类型＋品质 → 类型兜底。覆盖项不再计入组内首件数量；类型兜底承接未知品质及未单独配置的品质。留空为待配置，填 0 表示明确不加价。</p>
        <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>品质匹配</TableHead><TableHead className="text-right">首件加价（元）</TableHead><TableHead className="text-right">后续每件（元）</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
          {draft.rules.map((row, index) => <TableRow key={`${row.ownerKind}:${row.rarityCode ?? "fallback"}:${index}`}><TableCell>{SKIN_DEPOSIT_TYPES[row.ownerKind]}</TableCell><TableCell>{row.rarityCode === null ? "类型兜底（含未知品质）" : catalog?.rarities.find(rarity => rarity.code === row.rarityCode)?.name ?? row.rarityCode}</TableCell><TableCell>{amount(`第${index + 1}行首件加价`, row.first, value => updateRow(index, "first", value))}</TableCell><TableCell>{amount(`第${index + 1}行后续每件加价`, row.subsequent, value => updateRow(index, "subsequent", value))}</TableCell><TableCell>{row.rarityCode !== null ? <Button type="button" variant="ghost" disabled={locked} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}>移除</Button> : "必配"}</TableCell></TableRow>)}
        </TableBody></Table></div>
        {catalog ? <div className="flex flex-wrap items-end gap-2"><div className="w-40"><SupplySelect label="新增规则类型" value={addKind} options={Object.entries(SKIN_DEPOSIT_TYPES).map(([value, label]) => ({ value, label }))} disabled={locked} onValueChange={value => setAddKind(value as SkinDepositRule["ownerKind"])} /></div><div className="w-52"><SupplySelect label="新增规则品质" value={addRarity} options={[{ value: "", label: "类型兜底（含未知品质）" }, ...catalog.rarities.filter(rarity => rarity.enabled).map(rarity => ({ value: rarity.code, label: rarity.name }))]} disabled={locked} onValueChange={setAddRarity} /></div><Button type="button" variant="outline" disabled={locked || draft.rules.some(row => row.ownerKind === addKind && row.rarityCode === (addRarity || null))} onClick={() => setDraft({ ...draft, rules: [...draft.rules, { ownerKind: addKind, rarityCode: addRarity || null, first: "", subsequent: "" }] })}>添加匹配规则</Button></div> : null}
        <div className="space-y-2 border-t border-border pt-4"><h3 className="text-sm font-semibold">单词条覆盖</h3><p className="text-xs text-muted-foreground">每个选中词条单独计入指定金额，替代其类型与品质规则。</p>
          {draft.overrides.map((row, index) => <div key={index} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_160px_auto]"><SupplySelect label={`第${index + 1}项覆盖词条`} value={row.skinId} options={[{ value: "", label: "请选择词条" }, ...(catalog?.skins ?? []).map(skin => ({ value: skin.id, label: skin.name })), ...(!catalog?.skins.some(skin => skin.id === row.skinId) && row.skinId ? [{ value: row.skinId, label: `${row.skinId}（现目录未提供，保留既有配置）` }] : [])]} disabled={locked || !catalog} onValueChange={value => setDraft({ ...draft, overrides: draft.overrides.map((item, i) => i === index ? { ...item, skinId: value } : item) })} />{amount(`第${index + 1}项词条覆盖金额（元）`, row.amount, value => setDraft({ ...draft, overrides: draft.overrides.map((item, i) => i === index ? { ...item, amount: value } : item) }))}<Button type="button" variant="ghost" disabled={locked} onClick={() => setDraft({ ...draft, overrides: draft.overrides.filter((_, i) => i !== index) })}>移除覆盖</Button></div>)}
          <Button type="button" variant="outline" disabled={locked || !catalog} onClick={() => setDraft({ ...draft, overrides: [...draft.overrides, { skinId: "", amount: "" }] })}>添加单词条覆盖</Button>
        </div>
        {issues.length ? <p role="status" className="text-sm text-muted-foreground">待配置：{issues.join("；")}。可保存草稿，不能封存或生效。</p> : <p role="status" className="text-sm">皮肤加价配置完整；仍需保存、封存并确认生效。</p>}
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={locked || !dirty} onClick={() => void save()}>保存皮肤押金草稿</Button><Button type="button" variant="outline" disabled={locked || dirty || issues.length > 0 || selected?.fundingPolicy?.recommendation.schema !== "deposit-recommendation-v2"} onClick={() => void seal()}>封存此价格版本</Button>{dirty ? <Button type="button" variant="ghost" disabled={command.locked} onClick={() => setDiscardTo(id)}>放弃本次输入</Button> : null}</div>
      </> : null}
    </>}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <Dialog open={discardTo !== undefined} onOpenChange={open => { if (!open) setDiscardTo(undefined); }}><DialogContent closeLabel="保留输入"><DialogHeader><DialogTitle>放弃尚未保存的皮肤押金输入？</DialogTitle><DialogDescription>本地输入会丢弃，已保存的版本保持原状。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDiscardTo(undefined)}>继续编辑</Button><Button type="button" onClick={() => choose(discardTo!)}>放弃并继续</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
