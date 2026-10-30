import { useEffect, useState } from "react";

import { adminRequest, friendlyError, type FullPayoutTermsRecord } from "../../api";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { SupplySelect } from "../../components/supply/supply-select";

type TermsDetail = FullPayoutTermsRecord & { body: string };

export function FullPayoutTermsPanel({ gameId, versions, canEdit, onReload }: {
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
      setMessage("包赔条款草稿已创建。");
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
      setMessage("包赔条款草稿已保存。");
      await onReload();
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(null); }
  };

  const seal = async () => {
    if (!canEdit || !detail || detail.status !== "DRAFT") return;
    setBusy("seal"); setError(undefined); setMessage(undefined);
    try {
      await adminRequest(`/supply/full-payout-terms-drafts/${encodeURIComponent(detail.id)}/seal`, { expectedRevision: revision }, "POST");
      setMessage("包赔条款已封存；已有价格版本引用不受影响，封存正文不可原地修改。");
      await onReload();
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(null); }
  };

  return <section className="section-panel">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold">全额包赔条款</h3><p className="mt-1 text-xs text-muted-foreground">独立不可变版本；价格版本通过 policyRef / policyVersion / disclosureVersion 引用。费率与承担方沿用已确认规则，不在本页另建费率真值。</p></div>
      <Button type="button" size="sm" disabled={!canEdit || !gameId || busy !== null} onClick={() => setCreating(value => !value)}>{creating ? "收起新建" : "新建条款草稿"}</Button>
    </div>
    {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
    {message ? <p className="mt-3 text-xs text-muted-foreground" role="status">{message}</p> : null}
    {creating ? <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <Field label="条款引用 policyRef"><Input value={policyRef} disabled={busy !== null} onChange={event => setPolicyRef(event.target.value)} /></Field>
      <Field label="条款版本 policyVersion"><Input value={policyVersion} disabled={busy !== null} onChange={event => setPolicyVersion(event.target.value)} /></Field>
      <Field label="披露版本 disclosureVersion"><Input value={newDisclosure} disabled={busy !== null} onChange={event => setNewDisclosure(event.target.value)} /></Field>
      <Field label="标题"><Input value={newTitle} disabled={busy !== null} onChange={event => setNewTitle(event.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="正文（纯文本，最多 20000 字节）"><Textarea className="min-h-40" value={newBody} disabled={busy !== null} onChange={event => setNewBody(event.target.value)} /></Field></div>
      <div className="sm:col-span-2"><Button type="button" disabled={!canEdit || busy !== null} onClick={() => void create()}>{busy === "create" ? "创建中…" : "创建包赔条款草稿"}</Button></div>
    </div> : null}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <div className="w-full sm:w-96"><SupplySelect label="包赔条款版本" value={selectedId} onValueChange={setSelectedId} options={versions.map(version => ({ value: version.id, label: `${version.title} · ${version.status === "SEALED" ? "已封存" : "草稿"} · 修订 ${version.revision}` }))} disabled={busy !== null || versions.length === 0} /></div>
    </div>
    {detail ? <div className="mt-4 grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>引用 {detail.policyRef} · {detail.policyVersion} · 披露 {detail.disclosureVersion} · 摘要 {detail.digest.slice(0, 16)}…</span><span>{detail.status === "SEALED" ? `已封存 · ${detail.sealedAt ?? ""}` : "草稿"}</span></div>
      <Field label="标题"><Input value={title} disabled={detail.status !== "DRAFT" || busy !== null} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label="披露版本"><Input value={disclosureVersion} disabled={detail.status !== "DRAFT" || busy !== null} onChange={event => setDisclosureVersion(event.target.value)} /></Field>
      <Field label="正文（纯文本）"><Textarea className="min-h-40" value={body} disabled={detail.status !== "DRAFT" || busy !== null} onChange={event => setBody(event.target.value)} /></Field>
      {detail.status === "DRAFT" ? <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canEdit || busy !== null} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</Button>
        <Button type="button" variant="secondary" disabled={!canEdit || busy !== null} onClick={() => void seal()}>{busy === "seal" ? "封存中…" : "封存条款"}</Button>
      </div> : <p className="text-xs text-muted-foreground">已封存，不能原地修改；修正请新建草稿。</p>}
    </div> : <p className="mt-4 text-xs text-muted-foreground">{versions.length === 0 ? "当前游戏还没有包赔条款版本。" : "选择版本查看正文。"}</p>}
  </section>;
}
