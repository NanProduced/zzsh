import { useState, type FormEvent } from "react";
import { adminRequest, friendlyError, type RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { SupplySelect } from "../../components/supply/supply-select";
import { safeBoxLabel } from "./rules-model";

type Amount = { amount: string } | null | undefined;
type Result = { quotable: boolean; reasonCodes?: string[]; quote?: {
  resourceTotal: Amount; ownerTotal: Amount; platformFullProfit: Amount;
} };
const money = (value: Amount) => value ? `¥${value.amount}` : "待核对";

export function FixedFeeTrial({ rules, onClose }: { rules: RulesResponse; onClose: () => void }) {
  const live = rules.priceVersions.find(row => row.id === rules.newListingPrice?.priceVersionId);
  const draft = rules.priceVersions.find(row => row.status === "DRAFT" && row.fixedFeeRates);
  const terms = rules.termOptions.filter(row => row.versionId === rules.release?.termVersionId);
  const haff = rules.items.find(item => item.unit === "HAFF_BASE");
  const items = rules.items.filter(item => item.enabled && item.unit !== "HAFF_BASE");
  const [quantity, setQuantity] = useState("100000000");
  const [box, setBox] = useState(Object.keys(live?.haffRule?.baseBySafeBox ?? {})[0] ?? "");
  const [vit, setVit] = useState(Object.keys(live?.haffRule?.vitalityDeltaByLevel ?? {})[0] ?? "");
  const [bear, setBear] = useState(Object.keys(live?.haffRule?.bearDeltaByLevel ?? {})[0] ?? "");
  const [term, setTerm] = useState(terms[0]?.code ?? "");
  const [inventory, setInventory] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ label: string; result?: Result; error?: string }[]>([]);
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!live || !haff || !rules.release || busy || !/^[1-9]\d{0,23}$/.test(quantity) || !box || !term || !vit || !bear) return;
    const termVersionId = rules.release.termVersionId;
    setBusy(true);
    setResults([]);
    try {
      const selected = [{ label: "当前新上架价目", version: live }, ...(draft ? [{ label: "修改中", version: draft }] : [])];
      setResults(await Promise.all(selected.map(async ({ label, version }) => {
        try {
          const result = await adminRequest<Result>("/supply/quote-preview", {
            priceVersionId: version.id, expectedRevision: version.revision, termVersionId,
            conditions: { safeBoxCode: box, termOptionCode: term, rentalPricing: { rentalMode: "ordinary" },
              vitLevel: Number(vit), bearLevel: Number(bear) },
            inventory: [{ itemId: haff.id, quantity }, ...items.filter(item => inventory[item.id]?.length)
              .map(item => ({ itemId: item.id, quantity: inventory[item.id] }))],
          }, "POST");
          return { label, result };
        } catch (error) { return { label, error: friendlyError(error) }; }
      })));
    } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>固定手续费试算</DialogTitle>
        <DialogDescription>普通出租，按申报全量资源试算。押金、包赔和会员优惠分别核定。</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={event => void run(event)}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="哈夫币数量"><Input required pattern="[1-9][0-9]{0,23}" inputMode="numeric" value={quantity} onChange={event => { setQuantity(event.target.value); setResults([]); }} disabled={busy} /></Field>
          <Field label="保险箱" composite><SupplySelect label="保险箱" value={box} disabled={busy}
            options={Object.keys(live?.haffRule?.baseBySafeBox ?? {}).map(code => ({ value: code, label: safeBoxLabel(code) }))}
            onValueChange={value => { setBox(value); setResults([]); }} /></Field>
          <Field label="每日消耗" composite><SupplySelect label="每日消耗" value={term} disabled={busy}
            options={terms.map(option => ({ value: option.code, label: option.name }))}
            onValueChange={value => { setTerm(value); setResults([]); }} /></Field>
          <Field label="体力等级" composite><SupplySelect label="体力等级" value={vit} disabled={busy}
            options={Object.keys(live?.haffRule?.vitalityDeltaByLevel ?? {}).map(value => ({ value, label: value }))}
            onValueChange={value => { setVit(value); setResults([]); }} /></Field>
          <Field label="负重等级" composite><SupplySelect label="负重等级" value={bear} disabled={busy}
            options={Object.keys(live?.haffRule?.bearDeltaByLevel ?? {}).map(value => ({ value, label: value }))}
            onValueChange={value => { setBear(value); setResults([]); }} /></Field>
        </div>
        <details><summary className="cursor-pointer text-sm">加入物资</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">{items.map(item => <Field key={item.id} label={item.name}>
            <Input inputMode="numeric" pattern="0|[1-9][0-9]{0,23}" value={inventory[item.id] ?? ""} disabled={busy}
              onChange={event => { setInventory({ ...inventory, [item.id]: event.target.value }); setResults([]); }} />
          </Field>)}</div>
        </details>
        <Button type="submit" disabled={busy || !live || !haff || !box || !term || !vit || !bear}>{busy ? "试算中…" : "试算"}</Button>
      </form>
      <div aria-live="polite" className="grid gap-3 sm:grid-cols-2">
        {results.map(({ label, result, error }) => <div key={label} className="space-y-1 rounded-md border border-border p-3 text-sm">
          <h3 className="font-semibold">{label}</h3>
          {result?.quotable && result.quote ? <>
            <p>租客全量资源费 {money(result.quote.resourceTotal)}</p>
            <p>号主预计收入（扣普通手续费后）{money(result.quote.ownerTotal)}</p>
            <p>平台预计普通手续费 {money(result.quote.platformFullProfit)}</p>
          </> : <p role="alert">{error ?? result?.reasonCodes?.join("、") ?? "报价暂不可用"}</p>}
        </div>)}
      </div>
    </DialogContent>
  </Dialog>;
}
