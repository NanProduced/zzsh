import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalize, extractPlate, validatePlateDocument, type PlateDocumentEnvelope } from "@zzsh/content/plate";
import { diffDocumentBlocks } from "@zzsh/content/legal-diff";
import { PlateDocument } from "@zzsh/ui/plate-document";
import "@zzsh/ui/plate-document.css";
import { adminRequest, friendlyError, type AgreementVersionRecord, type FullPayoutTermsRecord, type RulesResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { StatusMessage } from "../components/ui-elements";
import { SupplySelect } from "../components/supply/supply-select";
import { formatBeijingDateTime } from "../workspace/beijing-time";
import { emptyPlateDocument } from "./content-plate";
import { DiffBlocks } from "./legal-document-diff";
import { draftCommand, useRulesWrite } from "./supply-rules/rules-write";

import PlateEditor from "../components/plate/plate-editor-loader";

export type TradeTermKind = "agreement" | "full_payout_terms";
export const TRADE_TERM_LABELS = { agreement: "出租协议", full_payout_terms: "全额包赔条款" } as const;

type Version = AgreementVersionRecord | FullPayoutTermsRecord;
type PayoutDetail = FullPayoutTermsRecord & { body: string; bodyDocument?: PlateDocumentEnvelope | null };
type Detail = AgreementVersionRecord | PayoutDetail;

function isPayoutDetail(detail: Detail | undefined): detail is PayoutDetail {
  return !!detail && "policyRef" in detail;
}
type Form = { title: string; document: PlateDocumentEnvelope; policyRef: string; policyVersion: string; disclosureVersion: string };

function formFrom(detail?: Detail): Form {
  const empty = emptyPlateDocument("legal");
  const document = detail?.bodyDocument ?? (detail ? {
    ...empty,
    value: detail.body.split(/\r\n?|\n/).map((text, index) => /^第[一二三四五六七八九十百零〇\d]+条\s/.test(text)
      ? { type: "h2", id: `clause-${index + 1}`, children: [{ text }] }
      : { type: "p", children: [{ text }] }),
  } : empty);
  return {
    title: detail?.title ?? "", document,
    policyRef: isPayoutDetail(detail) ? detail.policyRef : "",
    policyVersion: "",
    disclosureVersion: isPayoutDetail(detail) ? detail.disclosureVersion : "",
  };
}

function Reading({ detail }: { detail: Pick<Detail, "body" | "bodyDocument"> }) {
  return detail.bodyDocument
    ? <PlateDocument document={detail.bodyDocument} showTableOfContents={false} />
    : <article className="whitespace-pre-wrap break-words text-sm leading-7">{detail.body}</article>;
}

export function TradeTermsPanel({ kind, snapshot, preferredVersion, preferredGame, refreshNonce, onOpenPath, onDirtyChange, onWriteLockChange }: {
  kind: TradeTermKind; snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  preferredVersion?: string; preferredGame?: string; refreshNonce: number; onOpenPath?: (path: string) => void;
  onDirtyChange: (dirty: boolean) => void; onWriteLockChange: (locked: boolean) => void;
}) {
  const agreement = kind === "agreement";
  const label = TRADE_TERM_LABELS[kind];
  const [gameId, setGameId] = useState("");
  const [rules, setRules] = useState<RulesResponse>();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string>();
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail>();
  const [liveDetail, setLiveDetail] = useState<Detail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [compareError, setCompareError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Form>(() => formFrom());
  const [baseline, setBaseline] = useState("");
  const [editingRevision, setEditingRevision] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [mode, setMode] = useState<"read" | "edit" | "compare" | "draft-preview">("read");
  const [creating, setCreating] = useState(false);
  const [sealOpen, setSealOpen] = useState(false);
  const [deferred, setDeferred] = useState<(() => void) | null>(null);
  const readSequence = useRef(0);
  const dirty = (mode === "edit" || mode === "draft-preview") && (creating || canonicalize(form) !== baseline);
  const liveId = agreement ? rules?.release?.agreementVersionId : rules?.currentFullPayoutTermsVersionId;
  const versions: Version[] = agreement ? rules?.agreementVersions ?? [] : rules?.fullPayoutTermsVersions ?? [];
  const selected = versions.find(version => version.id === selectedId);
  const selectedDetail = detail?.id === selectedId && detail.revision === selected?.revision ? detail : undefined;
  const read = useCallback(async (id: string, signal?: AbortSignal) => {
    const sequence = ++readSequence.current;
    const result = await adminRequest<RulesResponse>(`/supply/games/${encodeURIComponent(id)}/rules`, undefined, "GET", {}, signal);
    if (result.game.id !== id) throw new Error("规则响应不属于当前游戏");
    if (sequence !== readSequence.current || signal?.aborted) return undefined;
    setRules(result);
    return result;
  }, []);
  const command = useRulesWrite(snapshot.adminUserId, gameId, () => read(gameId), snapshot.session.id);
  const writable = creating || selectedDetail?.status === "DRAFT" && selectedDetail.id === editingId;
  const legacyDraft = !creating && writable && !selectedDetail?.bodyDocument;
  const invalid = useMemo(() => {
    if (!form.title.trim()) return "请填写标题。";
    const check = validatePlateDocument(form.document, { preset: "legal", mode: "draft" });
    const text = extractPlate(form.document).plainText;
    if (!check.ok || new TextEncoder().encode(text).length > 20_000) return "正文排版无效或超过 20,000 字节。";
    if (!text.trim()) return "请填写正文。";
    if (!agreement && (!form.disclosureVersion.trim() || creating && (!form.policyRef.trim() || !form.policyVersion.trim()))) return "请填写条款编号、条款版本和告知版本。";
    return undefined;
  }, [form, agreement, creating]);

  const blockRefresh = useRef(false);
  blockRefresh.current = dirty || command.locked;
  useEffect(() => {
    if (blockRefresh.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true); setReadError(undefined); setRules(undefined);
    void (async () => {
      const { games } = await adminRequest<{ games: SupplyGame[] }>("/supply/games", undefined, "GET", {}, signal);
      if (signal.aborted) return;
      const game = games.find(item => item.code === "delta" && (!preferredGame || item.id === preferredGame));
      if (!game) throw new Error("当前游戏未开放交易条款管理。");
      setGameId(game.id);
      const fresh = await read(game.id, signal);
      if (!fresh || signal.aborted) return;
      const current = agreement ? fresh.release?.agreementVersionId : fresh.currentFullPayoutTermsVersionId;
      const rows = agreement ? fresh.agreementVersions : fresh.fullPayoutTermsVersions;
      setSelectedId(preferredVersion || current || rows[0]?.id || "");
      setMode("read"); setCreating(false);
    })().catch(failure => { if (!signal.aborted) setReadError(friendlyError(failure)); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agreement, preferredGame, preferredVersion, refreshNonce, attempt, read]);

  useEffect(() => {
    setDetail(undefined); setDetailError(undefined); setDetailLoading(false);
    if (!selected) return;
    if ("body" in selected) { setDetail(selected); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    void adminRequest<Detail>(`/supply/full-payout-terms/${encodeURIComponent(selected.id)}`, undefined, "GET", {}, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.id !== selected.id || result.gameId !== gameId) throw new Error("条款响应与所选版本不一致。");
        setDetail(result);
      })
      .catch(failure => { if (!controller.signal.aborted) setDetailError(friendlyError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, gameId]);

  useEffect(() => {
    setLiveDetail(undefined); setCompareError(undefined);
    if (mode !== "compare" || !liveId || liveId === selectedId) return;
    const base = versions.find(version => version.id === liveId);
    if (base && "body" in base) { setLiveDetail(base); return; }
    if (agreement) { setCompareError("当前生效版本未返回，无法比较。"); return; }
    const controller = new AbortController();
    void adminRequest<Detail>(`/supply/full-payout-terms/${encodeURIComponent(liveId)}`, undefined, "GET", {}, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.id !== liveId || result.gameId !== gameId) throw new Error("生效条款与规则引用不一致。");
        setLiveDetail(result);
      })
      .catch(failure => { if (!controller.signal.aborted) setCompareError(friendlyError(failure)); });
    return () => controller.abort();
  }, [mode, agreement, liveId, selectedId, gameId, rules]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onWriteLockChange(command.locked); }, [command.locked, onWriteLockChange]);
  useEffect(() => () => { onDirtyChange(false); onWriteLockChange(false); }, [onDirtyChange, onWriteLockChange]);

  const guard = (action: () => void) => {
    if (command.locked) return;
    if (dirty) setDeferred(() => action);
    else action();
  };
  const start = (newVersion: boolean) => {
    const next = formFrom(selectedDetail);
    if (!newVersion && isPayoutDetail(selectedDetail)) next.policyVersion = selectedDetail.policyVersion;
    setForm(next); setBaseline(canonicalize(next)); setEditingRevision(newVersion ? undefined : selectedDetail?.revision);
    setEditingId(newVersion ? undefined : selectedDetail?.id);
    setCreating(newVersion); setMode("edit");
  };
  const finish = (result: Awaited<ReturnType<typeof command.write>>) => {
    if (!result?.receipt.id) return;
    const rows = agreement ? result.fresh.agreementVersions : result.fresh.fullPayoutTermsVersions;
    if (!rows.some(row => row.id === result.receipt.id)) return;
    setSelectedId(result.receipt.id);
    setCreating(false); setMode("read");
  };
  const save = async () => {
    if (!gameId || !writable || invalid || command.locked || command.state.kind === "conflict" || (!dirty && !legacyDraft) || (!creating && selectedDetail?.revision !== editingRevision)) return;
    const body = { title: form.title.trim(), bodyDocument: form.document, ...(!agreement ? { disclosureVersion: form.disclosureVersion.trim() } : {}) };
    if (creating) {
      finish(await command.write(draftCommand(gameId, kind, "create", {
        ...body, gameId, ...(!agreement ? { policyRef: form.policyRef.trim(), policyVersion: form.policyVersion.trim() } : {}),
      })));
    } else if (selectedDetail) {
      finish(await command.write(draftCommand(gameId, kind, "update", { ...body, expectedRevision: selectedDetail.revision }, selectedDetail.id)));
    }
  };
  const seal = async () => {
    setSealOpen(false);
    if (selectedDetail?.status !== "DRAFT" || dirty || command.locked) return;
    finish(await command.write(draftCommand(gameId, kind, "seal", { expectedRevision: selectedDetail.revision }, selectedDetail.id)));
  };
  const stateLabel = (version: Version) => version.id === liveId ? "当前生效" : version.status === "DRAFT" ? "草稿"
    : version.sealedAt && (!liveId || rules?.release?.activatedAt && Date.parse(version.sealedAt) > Date.parse(rules.release.activatedAt)) ? "已提交 · 待生效" : "已封存";
  const price = rules?.priceVersions.find(row => row.id === rules.release?.priceVersionId);
  const selectedText = selectedDetail?.body ?? "";
  const editing = mode === "edit" || mode === "draft-preview";
  const changedOnServer = editing && !creating && (!writable || selectedDetail?.revision !== editingRevision);
  const readyToSeal = selectedDetail?.bodyDocument
    ? validatePlateDocument(selectedDetail.bodyDocument, { preset: "legal", mode: "publish" }).ok : false;
  const toRules = () => onOpenPath?.(agreement
    ? `/supply/rules?section=agreement&version=${encodeURIComponent(selectedId)}`
    : "/supply/rules?section=pricing");

  return <div className="fixed-doc-main">
    <header className="fixed-doc-header">
      <div><h2>{label}</h2><p>{rules?.game.name ?? "三角洲行动"} · {creating ? "新草稿" : selected ? stateLabel(selected) : "版本管理"}</p></div>
      <div className="fixed-doc-actions">
        <Button size="sm" variant="ghost" disabled={loading || command.locked} onClick={() => guard(() => setAttempt(value => value + 1))}>重新读取</Button>
        {editing ? <>
          <Button size="sm" variant="secondary" disabled={command.locked} onClick={() => guard(() => { setCreating(false); setMode("read"); })}>退出编辑</Button>
          <Button size="sm" variant="outline" disabled={command.locked} onClick={() => setMode(mode === "edit" ? "draft-preview" : "edit")}>{mode === "edit" ? "用户端预览" : "继续编辑"}</Button>
          <Button size="sm" disabled={Boolean(invalid) || command.locked || command.state.kind === "conflict" || (!dirty && !legacyDraft) || changedOnServer} onClick={() => void save()}>保存草稿</Button>
        </> : rules && !readError ? <>
          {selectedDetail?.status === "DRAFT"
            ? <Button size="sm" variant="secondary" disabled={command.locked} onClick={() => start(false)}>编辑草稿</Button>
            : <Button size="sm" disabled={command.locked || Boolean(selectedId && !selectedDetail)} onClick={() => start(true)}>{selectedDetail ? "基于此版起草" : "起草新版"}</Button>}
          {selectedDetail?.status === "DRAFT" ? <Button size="sm" disabled={command.locked || !readyToSeal} onClick={() => setSealOpen(true)}>{agreement ? "提交待生效" : "提交待引用"}</Button> : null}
        </> : null}
      </div>
    </header>

    {readError || detailError ? <StatusMessage error={readError || detailError} /> : null}
    {command.state.kind === "conflict" || changedOnServer ? <StatusMessage error="版本已被更新。请复制未保存的修改，再重新读取最新版本。" /> : null}
    {command.state.message ? <StatusMessage error={command.state.message} /> : null}
    {command.pending ? <div className="space-y-2">
      <p role="status">正在处理或等待核对原写入结果。</p>
      <Button size="sm" variant="secondary" disabled={command.pending.gameId !== gameId || command.state.kind === "busy" || command.state.kind === "recovering"}
        onClick={() => { const operation = command.pending?.operation; void command.recover().then(result => { if (operation?.startsWith(`supply.rules.${kind}_draft.`)) finish(result); }); }}>核对原写入回执</Button>
    </div> : null}
    {command.state.kind === "done" ? <p role="status">{command.state.operation.endsWith(".seal")
      ? agreement ? "已提交，等待 Boss 确认生效。" : "已提交，等待 Boss 随价格版本引用生效。"
      : "草稿已保存。"}</p> : null}

    {loading ? <p role="status">正在读取游戏交易条款…</p> : null}
    {rules && !loading ? <div className="space-y-4">
      <div className="rounded-lg border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="font-medium">生效关系</p>
            <p className="text-muted-foreground">{liveId ? `当前生效版本 ${versions.find(row => row.id === liveId)?.title ?? liveId}` : "当前没有已生效版本"}
              {liveId && rules.release ? ` · ${formatBeijingDateTime(rules.release.activatedAt)}` : ""}</p>
            <p className="text-muted-foreground">{agreement ? "由 Boss 在规则与价目确认生效。"
              : price ? `由已生效的价格版本引用 · ${price.fundingPolicy?.fullPayoutPolicyVersion ?? price.id}` : "等待价格版本引用后随规则生效。"}</p>
          </div>
          {onOpenPath ? <Button size="sm" variant="outline" disabled={command.locked} onClick={toRules}>查看{agreement ? "规则发布" : "租赁定价"}</Button> : null}
        </div>
      </div>
      {versions.length ? <div className="flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-96"><SupplySelect label="条款版本" value={selectedId} disabled={command.locked}
          onValueChange={id => guard(() => { setSelectedId(id); setCreating(false); setMode("read"); })}
          options={versions.map(version => ({ value: version.id, label: `${version.title} · ${stateLabel(version)}` }))} /></div>
        {selected && selected.id !== liveId && !editing ? <Button size="sm" variant="outline" aria-pressed={mode === "compare"}
          onClick={() => setMode(mode === "compare" ? "read" : "compare")}>{mode === "compare" ? "用户端预览" : "与生效版对比"}</Button> : null}
      </div> : null}
      {detailLoading ? <p role="status">正在读取版本正文…</p> : null}
      {mode === "edit" ? <div className="fixed-doc-body space-y-4">
        <Field label="标题"><Input value={form.title} maxLength={120} disabled={command.locked} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
        {!agreement ? <div className="grid gap-3 sm:grid-cols-3">
          <Field label="条款编号"><Input value={form.policyRef} maxLength={160} disabled={!creating || command.locked} onChange={e => setForm({ ...form, policyRef: e.target.value })} /></Field>
          <Field label="条款版本"><Input value={form.policyVersion} maxLength={160} disabled={!creating || command.locked} onChange={e => setForm({ ...form, policyVersion: e.target.value })} /></Field>
          <Field label="告知版本"><Input value={form.disclosureVersion} maxLength={160} disabled={command.locked} onChange={e => setForm({ ...form, disclosureVersion: e.target.value })} /></Field>
        </div> : null}
        <Suspense fallback={<p role="status">正在加载编辑器…</p>}>
          <PlateEditor preset="legal" value={form.document.value} canvas readOnly={command.locked} onChange={document => setForm(current => ({ ...current, document }))} />
        </Suspense>
        {invalid ? <p className="text-sm text-muted-foreground">{invalid}</p> : null}
      </div> : mode === "draft-preview" ? <div className="fixed-doc-body"><Reading detail={{ body: "", bodyDocument: form.document }} /></div> : selectedDetail ? <div className="fixed-doc-body space-y-3">
        <h3 className="text-lg font-semibold">{selectedDetail.title}</h3>
        {isPayoutDetail(selectedDetail) ? <p className="text-sm text-muted-foreground">条款编号 {selectedDetail.policyRef} · 版本 {selectedDetail.policyVersion} · 告知 {selectedDetail.disclosureVersion}</p> : null}
        {mode === "compare" ? compareError ? <StatusMessage error={compareError} /> : liveId && !liveDetail
          ? <p role="status">正在读取生效版本…</p>
          : <>
            <p className="text-sm text-muted-foreground">下方逐段比较文字。链接、排版和强调以两版正文为准。</p>
            {liveDetail && liveDetail.digest !== selectedDetail.digest && (liveDetail.bodyDocument || selectedDetail.bodyDocument) && liveDetail.body === selectedText
              ? <div className="space-y-4"><p role="status">两版文字一致，文档结构、排版或链接有变化。</p>
                <section><h3>生效版本</h3><Reading detail={liveDetail} /></section>
                <section><h3>所选版本</h3><Reading detail={selectedDetail} /></section>
              </div> : null}
            <DiffBlocks blocks={diffDocumentBlocks(liveDetail?.body ?? "", selectedText)} emptyText="暂无可比较的正文。" />
          </>
          : <Reading detail={selectedDetail} />}
        {selectedDetail.status === "DRAFT" && !readyToSeal ? <p className="text-sm text-muted-foreground">请编辑并保存 Plate 草稿，清除未确认内容后再提交。</p> : null}
      </div> : !detailLoading && !detailError ? <p>{selectedId ? "所请求的版本不在当前游戏的版本列表中。" : "当前游戏还没有这份条款。"}</p> : null}
    </div> : null}

    <Dialog open={sealOpen} onOpenChange={setSealOpen}><DialogContent>
      <DialogTitle>{agreement ? "提交这份出租协议？" : "提交这份包赔条款待引用？"}</DialogTitle>
      <DialogDescription>{agreement ? "提交后该版本封存，由 Boss 在规则与价目确认生效。"
        : "提交后该版本封存，需由 Boss 随价格版本引用后生效。"}</DialogDescription>
      {liveId && liveId !== selectedId ? <Button size="sm" variant="outline" onClick={() => { setSealOpen(false); setMode("compare"); }}>先看正文差异</Button> : null}
      <DialogFooter><Button variant="secondary" onClick={() => setSealOpen(false)}>取消</Button><Button disabled={command.locked} onClick={() => void seal()}>确认提交</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={Boolean(deferred)} onOpenChange={open => { if (!open) setDeferred(null); }}><DialogContent role="alertdialog">
      <DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>继续后将离开当前条款。可返回编辑并先保存草稿。</DialogDescription>
      <DialogFooter><Button variant="secondary" onClick={() => setDeferred(null)}>继续编辑</Button>
        <Button variant="danger" onClick={() => { const action = deferred; setDeferred(null); action?.(); }}>放弃修改并继续</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}