import { useCallback, useEffect, useState } from "react";
import { FileText, Plus, RefreshCw, Save, ShieldCheck } from "lucide-react";

import { adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Badge } from "../components/ui/badge";
import { Button, StatusMessage } from "../components/ui-elements";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { ContentSelect } from "./content-resource-fields";

type DocType = "PLATFORM_TERMS" | "PLATFORM_PRIVACY";
type LegalVersion = {
  id: string; docType: DocType; title: string; body: string; digest: string;
  status: "DRAFT" | "SEALED"; revision: string; effectiveAt: string | null;
  sealedAt: string | null; createdAt: string;
};

const DOC_LABELS: Record<DocType, string> = { PLATFORM_TERMS: "平台服务协议", PLATFORM_PRIVACY: "用户隐私政策" };

function isoText(value: string | null): string {
  return value ? value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "—";
}

/**
 * Platform legal-document maintenance: draft, edit, seal. Sealed rows are
 * immutable; a correction is a new draft and a new seal.
 */
export function LegalDocumentsPanel({ snapshot }: { snapshot: Extract<SessionSnapshot, { authenticated: true }> }) {
  const canEdit = hasPermission(snapshot, "content.platform.edit");
  const canPublish = hasPermission(snapshot, "content.platform.publish");
  const [docType, setDocType] = useState<DocType>("PLATFORM_TERMS");
  const [versions, setVersions] = useState<LegalVersion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [revision, setRevision] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<"load" | "create" | "save" | "seal" | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const selected = versions.find(version => version.id === selectedId) ?? null;
  const dirty = creating || Boolean(selected && (title !== selected.title || body !== selected.body || effectiveAt !== (selected.effectiveAt?.slice(0, 16) ?? "")));
  const load = useCallback(async (nextDocType = docType, keepId?: string) => {
    setBusy("load"); setError(undefined);
    try {
      const result = await adminRequest<{ versions: LegalVersion[] }>(`/legal-documents?docType=${encodeURIComponent(nextDocType)}`);
      setVersions(result.versions);
      const target = result.versions.find(version => version.id === keepId) ?? result.versions[0] ?? null;
      setSelectedId(target?.id ?? "");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(null);
    }
  }, [docType]);

  useEffect(() => { void load(docType); }, [docType, load]);
  useEffect(() => {
    if (creating) return;
    setTitle(selected?.title ?? "");
    setBody(selected?.body ?? "");
    setEffectiveAt(selected?.effectiveAt ? selected.effectiveAt.slice(0, 16) : "");
    setRevision(selected?.revision ?? "");
    setError(undefined);
  }, [selected?.id, selected?.revision, creating]);

  const create = () => {
    if (!canEdit) return;
    setCreating(true); setSelectedId(""); setTitle(""); setBody(""); setEffectiveAt(""); setRevision(""); setError(undefined); setMessage(undefined);
  };

  const save = async () => {
    if (!canEdit || !creating && (!selected || selected.status !== "DRAFT")) return;
    if (!title.trim() || !body.trim()) { setError("请先填写标题和正文。"); return; }
    setBusy("save"); setError(undefined); setMessage(undefined);
    try {
      const at = effectiveAt === (selected?.effectiveAt?.slice(0, 16) ?? "") ? selected?.effectiveAt ?? null : effectiveAt ? `${effectiveAt}:00.000Z` : null;
      const saved = creating
        ? await adminRequest<LegalVersion>("/legal-documents/drafts", { docType, title, body, effectiveAt: at }, "POST")
        : await adminRequest<LegalVersion>(`/legal-documents/drafts/${encodeURIComponent(selected!.id)}`, { expectedRevision: revision, title, body, effectiveAt: at }, "PUT");
      setCreating(false);
      setMessage("草稿已保存。");
      await load(docType, saved.id);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(null);
    }
  };

  const seal = async () => {
    if (!canPublish || !selected || selected.status !== "DRAFT" || dirty) return;
    setBusy("seal"); setError(undefined); setMessage(undefined);
    try {
      await adminRequest<LegalVersion>(`/legal-documents/drafts/${encodeURIComponent(selected.id)}/seal`, { expectedRevision: revision }, "POST");
      setMessage("文书已封存并按生效时间对外提供；封存后不可原地修改。");
      await load(docType, selected.id);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(null);
    }
  };

  return <section className="section-panel content-list-panel">
    <div className="content-heading">
      <div><h3 className="text-base font-semibold flex items-center gap-2"><FileText size={17} aria-hidden="true" />平台法律文书</h3><p className="mt-1 text-sm text-muted-foreground">服务协议与隐私政策草稿、封存与生效；封存版本不可改，修正必须新建草稿。</p></div>
      <div className="content-heading-meta">
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null || creating} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新</Button>
        <Button type="button" size="sm" disabled={!canEdit || busy !== null || creating} onClick={create}><Plus size={14} aria-hidden="true" />新建草稿</Button>
      </div>
    </div>
    <div className="content-toolbar">
      <label className="content-inline-field"><span>文书</span><ContentSelect ariaLabel="法律文书类型" value={docType} disabled={busy !== null || creating} onChange={value => { setDocType(value as DocType); setSelectedId(""); setMessage(undefined); }} options={(Object.keys(DOC_LABELS) as DocType[]).map(value => ({ value, label: DOC_LABELS[value] }))} className="min-w-44" /></label>
      <label className="content-inline-field"><span>版本</span><ContentSelect ariaLabel="法律文书版本" value={selectedId} disabled={busy !== null || creating || versions.length === 0} onChange={value => { setSelectedId(value); setMessage(undefined); }} options={versions.map(version => ({ value: version.id, label: `${version.status === "SEALED" ? "已封存" : "草稿"} · 修订 ${version.revision} · ${version.id}` }))} className="min-w-72" /></label>
    </div>
    <StatusMessage error={error} success={message} className="mt-3" />
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="section-panel">
        <h4 className="text-sm font-semibold">版本记录</h4>
        {versions.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">{busy === "load" ? "加载中…" : "暂无版本。"}</p> : <div className="table-wrap mt-3"><table className="data-table"><thead><tr><th>状态</th><th>标题</th><th>生效</th><th /></tr></thead><tbody>{versions.map(version => <tr key={version.id}>
          <td><Badge variant={version.status === "SEALED" ? "success" : "warning"}>{version.status === "SEALED" ? "已封存" : "草稿"}</Badge></td>
          <td><span className="block max-w-56 truncate">{version.title}</span><span className="block text-[11px] text-muted-foreground">{version.id} · 修订 {version.revision}</span></td>
          <td className="text-[11px]">{isoText(version.effectiveAt)}</td>
          <td><Button type="button" size="sm" variant="secondary" disabled={busy !== null || creating} onClick={() => setSelectedId(version.id)}>编辑</Button></td>
        </tr>)}</tbody></table></div>}
      </div>
      <div className="section-panel">
        {selected || creating ? <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">正文</h4><Badge variant={selected?.status === "SEALED" ? "success" : "warning"}>{selected?.status === "SEALED" ? `已封存 · ${isoText(selected.sealedAt)}` : "草稿"}</Badge></div>
          <div className="mt-3 grid gap-3">
            <Field label="标题"><Input value={title} maxLength={160} disabled={!canEdit || !creating && selected?.status !== "DRAFT" || busy !== null} onChange={event => setTitle(event.target.value)} /></Field>
            <Field label="生效时间（UTC，可留空，封存时按当前时间）"><Input type="datetime-local" value={effectiveAt} disabled={!canEdit || !creating && selected?.status !== "DRAFT" || busy !== null} onChange={event => setEffectiveAt(event.target.value)} /></Field>
            <Field label="正文（纯文本，最多 20000 字节）"><Textarea className="min-h-80 font-mono text-xs" value={body} disabled={!canEdit || !creating && selected?.status !== "DRAFT" || busy !== null} onChange={event => setBody(event.target.value)} /></Field>
            <p className="text-[11px] text-muted-foreground">摘要 {selected?.digest.slice(0, 16) ?? "尚未保存"}… · 封存后正文、版本和生效时间均不可原地修改。</p>
            {creating || selected?.status === "DRAFT" ? <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!canEdit || busy !== null} onClick={() => void save()}><Save size={14} aria-hidden="true" />{busy === "save" ? "保存中…" : "保存草稿"}</Button>
              <Button type="button" variant="secondary" disabled={!canPublish || busy !== null || dirty || creating} onClick={() => void seal()}><ShieldCheck size={14} aria-hidden="true" />{busy === "seal" ? "封存中…" : "封存并生效"}</Button>{creating ? <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => setCreating(false)}>取消新建</Button> : dirty ? <span className="text-xs text-muted-foreground">请先保存，再封存。</span> : null}
            </div> : <p className="text-xs text-muted-foreground">该版本已封存，不能编辑；如需修正请新建草稿。</p>}
          </div>
        </> : <p className="text-xs text-muted-foreground">选择或新建一个版本后查看正文。</p>}
      </div>
    </div>
  </section>;
}
