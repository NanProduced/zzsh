import { useEffect, useRef, useState } from "react";
import { adminRequest, friendlyError, type PriceVersionRecord, type RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SupplySelect } from "../../components/supply/supply-select";
import { REASON_TEXT, asHaffV2, num, yuan } from "./rules-model";
import { boundText } from "./rental-modes";
import { bindingMatches, draftTrialRequest, type DraftTrialBinding, type DraftTrialInput } from "./rental-mode-trial";

type Amount = { amount: string } | null | undefined;
type Preview = { quotable: boolean; reasonCodes?: string[]; binding?: DraftTrialBinding; quote?: { lines: { itemId: string; buyerAmount: Amount; ownerAmount?: Amount }[]; termSeconds: string; ownerHaffRatio?: string; buyerHaffRatio?: string } };
type State = { signature: string; status: "busy" } | { signature: string; status: "ok"; result: Preview } | { signature: string; status: "error"; message: string };

/** 选中极速草稿的服务端正式试算；输入或草稿修订变化后旧结果立即失效，须重新试算。 */
export function DraftFastTrial({ rules, version, dirty }: { rules: RulesResponse; version: PriceVersionRecord | undefined; dirty: boolean }) {
  const haff = asHaffV2(version?.haffRule);
  const terms = rules.termOptions.filter((o) => o.versionId === rules.release?.termVersionId);
  const [input, setInput] = useState<DraftTrialInput>(() => ({ ownerRatioB: "", haffM: "100", box: Object.keys(haff?.baseBySafeBox ?? {}).at(-1) ?? "", vit: Object.keys(haff?.vitalityDeltaByLevel ?? {})[0] ?? "", bear: Object.keys(haff?.bearDeltaByLevel ?? {})[0] ?? "", term: terms[0]?.code ?? "" }));
  const [state, setState] = useState<State | null>(null);
  const seq = useRef(0);
  const req = draftTrialRequest(rules, version, input);
  const signature = req.ok ? req.signature : "";
  useEffect(() => { ++seq.current; setState(null); }, [signature, dirty]);
  const run = async () => {
    if (!req.ok || dirty) return;
    const id = ++seq.current; setState({ signature, status: "busy" });
    try { const result = await adminRequest<Preview>("/supply/quote-preview", req.body, "POST"); if (id === seq.current) setState({ signature, status: "ok", result }); }
    catch (failure) { if (id === seq.current) setState({ signature, status: "error", message: friendlyError(failure) }); }
  };
  const current = state && state.signature === signature && !dirty ? state : null;
  const ok = current?.status === "ok" ? current.result : undefined;
  const stale = ok && req.ok && !bindingMatches(ok.binding, req.expected);
  const fast = haff?.compatibility.modes.fast;
  const sum = (k: "buyerAmount" | "ownerAmount") => ok?.quote ? ok.quote.lines.reduce<number | null>((t, l) => { const v = num(l[k]?.amount); return t === null || v === null ? null : t + v; }, 0) : null;
  const errs = req.ok ? {} : req.errors;
  const sel = (key: "box" | "vit" | "bear", label: string, map: Record<string, string> | undefined) => <label className="min-w-0 space-y-1 text-xs"><span className="text-muted-foreground">{label}</span>
    <SupplySelect label={label} value={input[key]} options={Object.keys(map ?? {}).map((v) => ({ value: v, label: v }))} onValueChange={(v) => setInput((p) => ({ ...p, [key]: v }))} />{errs[key] ? <p className="text-[11px] text-destructive">{errs[key]}</p> : null}</label>;
  return <fieldset className="space-y-3 rounded-lg border border-border p-3" aria-label="极速草稿正式试算"><legend className="px-1 text-sm font-semibold">极速草稿正式试算</legend>
    <p className="text-xs text-muted-foreground">按所选草稿（{version ? `${version.id} · 修订 ${version.revision}` : "未选择"}）、极速模式与号主比例 B 由服务端计算；草稿极速范围：下限 {boundText(fast?.min)}，上限 {boundText(fast?.max)}。改任何输入或草稿后需重新试算。</p>
    {dirty ? <p role="status" className="text-xs text-amber-600">草稿有未保存修改：先保存，试算只针对已保存修订。</p> : null}
    {errs.version ? <p role="status" className="text-xs text-muted-foreground">{errs.version}</p> : null}
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="min-w-0 space-y-1 text-xs"><span className="text-muted-foreground">号主比例 B</span><Input aria-label="试算号主比例 B" inputMode="decimal" value={input.ownerRatioB} aria-invalid={Boolean(errs.ownerRatioB)} onChange={(e) => setInput((p) => ({ ...p, ownerRatioB: e.target.value.trim() }))} />{errs.ownerRatioB ? <p className="text-[11px] text-destructive">{errs.ownerRatioB}</p> : null}</label>
      <label className="min-w-0 space-y-1 text-xs"><span className="text-muted-foreground">哈夫币（M）</span><Input aria-label="试算哈夫币" inputMode="decimal" value={input.haffM} aria-invalid={Boolean(errs.haffM)} onChange={(e) => setInput((p) => ({ ...p, haffM: e.target.value.trim() }))} />{errs.haffM ? <p className="text-[11px] text-destructive">{errs.haffM}</p> : null}</label>
      <label className="min-w-0 space-y-1 text-xs"><span className="text-muted-foreground">消耗档</span><SupplySelect label="试算消耗档" value={input.term} options={terms.map((o) => ({ value: o.code, label: o.code }))} onValueChange={(v) => setInput((p) => ({ ...p, term: v }))} />{errs.term ? <p className="text-[11px] text-destructive">{errs.term}</p> : null}</label>
      {sel("box", "保险箱", haff?.baseBySafeBox)}{sel("vit", "体力等级", haff?.vitalityDeltaByLevel)}{sel("bear", "负重等级", haff?.bearDeltaByLevel)}
    </div>
    <Button type="button" variant="outline" disabled={!req.ok || dirty || current?.status === "busy"} onClick={() => void run()}>试算极速草稿</Button>
    {current?.status === "busy" ? <p role="status" aria-busy="true" className="text-xs">计算中…</p> : null}
    {current?.status === "error" ? <p role="alert" className="text-xs text-destructive">试算失败：{current.message}</p> : null}
    {stale ? <p role="alert" className="text-xs text-destructive">服务端回执与当前草稿修订/模式/B/库存不一致，结果作废；请刷新后重试。</p> : null}
    {ok && !stale && !ok.quotable ? <p role="status" className="text-xs">无法报价：{(ok.reasonCodes ?? []).map((c) => REASON_TEXT[c] ?? c).join("、") || "原因未提供"}（B 低于下限或超出上限时同样不可报价）</p> : null}
    {ok && !stale && ok.quotable && ok.quote ? <div role="status" aria-label="极速试算结果" className="rounded-md bg-muted px-3 py-2 text-xs tabular-nums">
      <p>号主比例 {ok.quote.ownerHaffRatio ?? "未返回"} · 租客比例 {ok.quote.buyerHaffRatio ?? "未返回"} · 可租 {num(ok.quote.termSeconds) ? Math.ceil(num(ok.quote.termSeconds)! / 86400) : "—"} 天</p>
      <p>租客资源金额 {sum("buyerAmount") === null ? "未返回" : yuan(sum("buyerAmount")!)} · 号主金额（扣费前） {sum("ownerAmount") === null ? "未返回" : yuan(sum("ownerAmount")!)}</p>
      <p className="text-muted-foreground">绑定：{ok.binding?.priceVersionId} · 修订 {ok.binding?.priceVersionRevision} · {ok.binding?.rentalMode} · B={ok.binding?.ownerRatioB}；会员统一总价折扣不在此试算。</p>
    </div> : null}
  </fieldset>;
}