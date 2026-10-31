import { docStage, DocStatusRow, MutedDetails, versionTime } from "./publish-flow";
import { useEffect, useState } from "react";

import { adminRequest, friendlyError, type FullPayoutTermsRecord } from "../../api";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { RulesMarkdownField } from "./rules-markdown-field";
import { SupplySelect } from "../../components/supply/supply-select";

type TermsDetail = FullPayoutTermsRecord & { body: string };

export function FullPayoutTermsPanel({ gameId, versions, canEdit, isBoss = false, live = null, onReload }: {
  isBoss?: boolean;
  /** 线上价格版本引用的条款编号与版本；条款随价格版本生效。 */
  live?: { ref: string; version: string } | null;
  gameId: string;
  versions: FullPayoutTermsRecord[];
  canEdit: boolean;
  onReload: () => Promise<unknown>;
}) {
  const [selectedId, setSelectedId] = useState(versions[0]?.id ?? "");
  const [detail, setDetail] = useState<TermsDetail | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [disclosureVersion, setDisclosureVersion] = useState("");
  const [revision, setRevision] = useState("");
  const [creating, setCreating] = useState(false);
  const [policyRef, setPolicyRef] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newDisclosure, setNewDisclosure] = useState("");
  const [busy, setBusy] = useState<"create" | "save" | "seal" | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let active = true;
    adminRequest<TermsDetail>(`/supply/full-payout-terms/${encodeURIComponent(selectedId)}`)
      .then(value => {
        if (!active) return;
        setDetail(value); setTitle(value.title); setBody(value.body);
        setDisclosureVersion(value.disclosureVersion); setRevision(value.revision); setError(undefined);
      })
      .catch(failure => { if (active) setError(friendlyError(failure)); });
    return () => { active = false; };
  }, [selectedId]);

  const create = async () => {
    if (!canEdit || !gameId) return;
    setBusy("create"); setError(undefined); setMessage(undefined);
    try {
      const created = await adminRequest<TermsDetail>("/supply/full-payout-terms-drafts", {
        gameId, policyRef, policyVersion, disclosureVersion: newDisclosure, title: newTitle, body: newBody,
      }, "POST");
      setMessage("已新建草稿。");
      setCreating(false); setNewTitle(""); setNewBody(""); setPolicyRef(""); setPolicyVersion(""); setNewDisclosure("");
      await onReload(); setSelectedId(created.id);
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(null); }
  };

  const save = async () => {
    if (!canEdit || !detail || detail.status !== "DRAFT") return;
    setBusy("save"); setError(undefined); setMessage(undefined);
    try {
      await adminRequest(`/supply/full-payout-terms-drafts/${encodeURIComponent(detail.id)}`, {
        expectedRevision: revision, title, body, disclosureVersion,
      }, "PUT");
      setMessage("已保存草稿。");
      await onReload();
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(null); }
  };

  const seal = async () => {
    if (!canEdit || !detail || detail.status !== "DRAFT") return;
    setBusy("seal"); setError(undefined); setMessage(undefined);
    try {
      await adminRequest(`/supply/full-payout-terms-drafts/${encodeURIComponent(detail.id)}/seal`, { expectedRevision: revision }, "POST");
      setMessage("已提交。下次价格发布引用它后生效。");
      await onReload();
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(null); }
  };

  return <section className="section-panel">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold">全额包赔条款</h3><p className="mt-1 max-w-3xl text-xs text-muted-foreground">号主选「全额包赔」时，租客下单前会看到这份条款。提交后不能改，要改就新建草稿。</p></div>
      <Button type="button" size="sm" disabled={!canEdit || !gameId || busy !== null} onClick={() => setCreating(value => !value)}>{creating ? "收起新建" : "新建条款草稿"}</Button>
    </div>
    {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
    {message ? <p className="mt-3 text-xs text-muted-foreground" role="status">{message}</p> : null}
    {creating ? <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <Field label="条款编号"><Input value={policyRef} disabled={busy !== null} onChange={event => setPolicyRef(event.target.value)} /></Field>
      <Field label="条款版本"><Input value={policyVersion} disabled={busy !== null} onChange={event => setPolicyVersion(event.target.value)} /></Field>
      <Field label="告知版本"><Input value={newDisclosure} disabled={busy !== null} onChange={event => setNewDisclosure(event.target.value)} /></Field>
      <Field label="标题"><Input value={newTitle} disabled={busy !== null} onChange={event => setNewTitle(event.target.value)} /></Field>
      <div className="sm:col-span-2"><RulesMarkdownField label="条款正文" hint="支持 Markdown，最多 20000 字节（约 6600 个汉字）" height={360} value={newBody} disabled={busy !== null} onChange={setNewBody} /></div>
      <div className="sm:col-span-2"><Button type="button" disabled={!canEdit || busy !== null} onClick={() => void create()}>{busy === "create" ? "创建中…" : "创建包赔条款草稿"}</Button></div>
    </div> : null}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <div className="w-full sm:w-96"><SupplySelect label="包赔条款版本" value={selectedId} onValueChange={setSelectedId} options={versions.map(version => ({ value: version.id, label: `${version.title} · ${live && version.policyRef === live.ref && version.policyVersion === live.version && version.status === "SEALED" ? "线上" : version.status === "SEALED" ? "已提交" : "草稿"}${versionTime(version) ? " · " + versionTime(version) : ""}` }))} disabled={busy !== null || versions.length === 0} /></div>
    </div>
    {detail ? <div className="mt-4 grid gap-3">
      {(() => { const isLive = !!live && detail.status === "SEALED" && detail.policyRef === live.ref && detail.policyVersion === live.version; const dirty = detail.status === "DRAFT" && (title !== detail.title || body !== detail.body || disclosureVersion !== detail.disclosureVersion); const st = docStage(detail, { dirty, live: isLive, after: null }); return <DocStatusRow stage={st} note={st === "unsaved" ? "有输入还没保存" : st === "draft" ? "草稿，线上还没变" : st === "sealed" ? (isBoss ? "已提交；价格发布时引用它就生效" : "已提交，等 Boss 随价格发布生效") : "线上订单使用这份条款"} />; })()}
      <MutedDetails><p>编号 {detail.policyRef} · 版本 {detail.policyVersion} · 告知 {detail.disclosureVersion}</p></MutedDetails>
      <Field label="标题"><Input value={title} disabled={detail.status !== "DRAFT" || busy !== null} onChange={event => setTitle(event.target.value)} /></Field>
      {detail.status === "DRAFT" ? <Field label="告知版本号"><Input value={disclosureVersion} disabled={busy !== null} onChange={event => setDisclosureVersion(event.target.value)} /></Field> : null}
      <RulesMarkdownField label="条款正文" hint={detail.status === "DRAFT" ? "支持 Markdown" : "已提交，只读"} height={360} value={body} disabled={detail.status !== "DRAFT" || busy !== null} onChange={setBody} />
      {detail.status === "DRAFT" ? <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canEdit || busy !== null} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</Button>
        <Button type="button" variant="secondary" disabled={!canEdit || busy !== null} onClick={() => void seal()}>{busy === "seal" ? "提交中…" : "提交发布"}</Button>
      </div> : null}
    </div> : <p className="mt-4 text-xs text-muted-foreground">{versions.length === 0 ? "当前游戏还没有包赔条款版本。" : "选择版本查看正文。"}</p>}
  </section>;
}
