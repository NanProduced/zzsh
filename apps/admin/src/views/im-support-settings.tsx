"use client";

/**
 * 洲洲助手设置入口。欢迎消息、场景目录和阅读状态同步在同目录面板；保存与脏状态仍在这里。
 */
import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { friendlyError } from "../api";
import { Button } from "../components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import type { SupportManagementRequest } from "./im-support-management";
import "./im-support-settings.css";
import { GROUPS, WELCOME_FIELDS, type FieldKey, type SceneGroup } from "./im-support-settings-scenes";
import { errorStatus, readCopyDraftOf, readCopyOriginError, readCopyReadError, readCopyStatusInfo, type ReadCopyDraft, type ReadCopyPayload, type ReadCopySettings } from "./im-support-settings-read-copy";
import { AssistantWelcomePanel, invalidReasonFor, type Settings } from "./im-support-settings-welcome";
import { AssistantReadCopyPanel } from "./im-support-settings-integration";
import { AssistantSceneCatalog } from "./im-support-settings-catalog";

export function SupportAssistantSettings({ active, request, canConfigure, canConfigureIntegration = false, demo = false, onDirtyChange, onWriteLockChange }: { active: boolean; request: SupportManagementRequest; canConfigure: boolean; canConfigureIntegration?: boolean; demo?: boolean; onDirtyChange?: (dirty: boolean) => void; onWriteLockChange?: (locked: boolean) => void }) {
  const [group, setGroup] = useState<SceneGroup>("welcome");
  const [previewKey, setPreviewKey] = useState<FieldKey>("serviceMessage");
  const sectionRef = useRef<HTMLElement | null>(null);
  const flight = useRef(false);
  const [saved, setSaved] = useState<Settings | null>(null), [draft, setDraft] = useState<Settings | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0), operation = useRef(""), loaded = useRef(-1);
  const [readCopy, setReadCopy] = useState<ReadCopySettings | null>(null);
  const [readCopyDraft, setReadCopyDraft] = useState<ReadCopyDraft | null>(null);
  const [readCopyLoading, setReadCopyLoading] = useState(true);
  const [readCopyBusy, setReadCopyBusy] = useState(false);
  const [readCopyError, setReadCopyError] = useState("");
  const [readCopyNotice, setReadCopyNotice] = useState("");
  const [readCopyReload, setReadCopyReload] = useState(0);
  const [readCopyUnknown, setReadCopyUnknown] = useState(false);
  const [readCopyConflict, setReadCopyConflict] = useState(false);
  const [readCopyWriteDenied, setReadCopyWriteDenied] = useState(false);
  const [readCopyReadDenied, setReadCopyReadDenied] = useState(false);
  const [readCopyReadFailed, setReadCopyReadFailed] = useState(false);
  const [readCopyConfirmDiscard, setReadCopyConfirmDiscard] = useState(false);
  const [readCopyCopyNotice, setReadCopyCopyNotice] = useState("");
  const readCopyLoaded = useRef(-1);
  const readCopyFlight = useRef(false);
  const readCopyReadGeneration = useRef(0);
  const readCopyOperation = useRef("");
  const readCopyPending = useRef<ReadCopyPayload | null>(null);
  const readCopyCallbackInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!active || demo || loaded.current === reload) return;
    let current = true;
    setLoading(true); setError("");
    void request<Settings>("/im/support-settings").then((value) => {
      if (current) { setSaved(value); setDraft(value); operation.current = ""; loaded.current = reload; }
    }).catch((reason) => { if (current) setError(friendlyError(reason)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, request, reload, demo]);

  useEffect(() => {
    if (!active || demo || group !== "integration" || readCopyLoaded.current === readCopyReload) return;
    let current = true;
    const generation = ++readCopyReadGeneration.current;
    setReadCopyLoading(true); setReadCopyError("");
    setReadCopyReadDenied(false); setReadCopyReadFailed(false);
    void request<ReadCopySettings>("/im/read-copy-settings").then((value) => {
      if (!current || readCopyReadGeneration.current !== generation) return;
      setReadCopy(value); setReadCopyDraft(readCopyDraftOf(value));
      readCopyOperation.current = ""; readCopyPending.current = null;
      setReadCopyUnknown(false); setReadCopyConflict(false); setReadCopyWriteDenied(false);
      setReadCopyReadDenied(false); setReadCopyReadFailed(false); setReadCopyCopyNotice(""); readCopyLoaded.current = readCopyReload;
    }).catch((reason) => {
      if (!current || readCopyReadGeneration.current !== generation) return;
      const status = errorStatus(reason);
      if (status === 403 || status === 401 || status === 423) {
        // A denied read is terminal for the current projection; invalidate older reads and keep any unknown write intent.
        readCopyReadGeneration.current += 1;
        setReadCopyReadDenied(true); setReadCopyReadFailed(false);
        setReadCopy(null); setReadCopyDraft(null);
        setReadCopyNotice(""); setReadCopyCopyNotice(""); setReadCopyConfirmDiscard(false);
        setReadCopyError(status === 403
          ? "你没有查看同步设置的权限。"
          : friendlyError(reason));
        setReadCopyLoading(false);
        return;
      }
      setReadCopyError(readCopyReadError(reason)); setReadCopyReadFailed(true);
    }).finally(() => {
      if (current && readCopyReadGeneration.current === generation) setReadCopyLoading(false);
    });
    return () => { current = false; };
  }, [active, demo, group, request, readCopyReload]);

  const dirty = Boolean(saved && draft && (saved.serviceMessage !== draft.serviceMessage || saved.complaintMessage !== draft.complaintMessage));
  const readCopyDirty = Boolean(readCopy && readCopyDraft && (readCopy.enabled !== readCopyDraft.enabled || (readCopy.publicOrigin ?? "") !== readCopyDraft.publicOrigin.trim()));
  const readCopyOriginValidation = readCopyDraft ? readCopyOriginError(readCopyDraft.publicOrigin, readCopyDraft.enabled) : "";
  const readCopyReceiverBlocked = Boolean(readCopyDraft?.enabled && readCopy && !readCopy.receiverReady);
  const readCopyInvalid = Boolean(readCopyOriginValidation || readCopyReceiverBlocked);
  const readCopyFormDisabled = !canConfigureIntegration || readCopyLoading || readCopyBusy || readCopyUnknown || readCopyConflict || readCopyWriteDenied || readCopyReadDenied || readCopyReadFailed;
  const readCopyToggleDisabled = readCopyFormDisabled || Boolean(readCopy && !readCopy.receiverReady && !readCopyDraft?.enabled);
  const readCopyCanSave = canConfigureIntegration && !readCopyFormDisabled && !readCopyInvalid && readCopyDirty && !readCopyConfirmDiscard;
  const readCopyCanRetry = canConfigureIntegration && readCopyUnknown && !readCopyReadFailed && !readCopyReadDenied && !readCopyBusy && !readCopyLoading && !readCopyConflict && !readCopyConfirmDiscard;
  const readCopyWriteLocked = readCopyBusy || readCopyUnknown;
  const readCopyStatus = readCopy ? readCopyStatusInfo(readCopy) : null;
  const readCopyCallbackUrl = readCopy?.callbackUrl ?? "";
  const readCopyCallbackDirty = Boolean(readCopy && readCopyDraft && (readCopy.publicOrigin ?? "") !== readCopyDraft.publicOrigin.trim());
  const pageDirty = dirty || busy || readCopyDirty || readCopyBusy || readCopyUnknown || readCopyConflict;
  useEffect(() => { if (sectionRef.current) sectionRef.current.scrollTop = 0; }, [group]);
  useEffect(() => { onDirtyChange?.(pageDirty); }, [pageDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { onWriteLockChange?.(readCopyWriteLocked); }, [readCopyWriteLocked, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);

  const invalidReason = draft ? WELCOME_FIELDS.map((scene) => invalidReasonFor(draft[scene.field])).find(Boolean) ?? "" : "";
  const invalid = Boolean(invalidReason);

  const edit = (key: FieldKey, value: string) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    operation.current = "";
    setNotice("");
  };

  const reloadSettings = () => {
    if (flight.current) return;
    setConfirmDiscard(false); setNotice(""); setError("");
    setReload((value) => value + 1);
  };

  const updateReadCopy = (patch: Partial<Pick<ReadCopyDraft, "enabled" | "publicOrigin">>) => {
    setReadCopyDraft((current) => current ? { ...current, ...patch } : current);
    readCopyOperation.current = ""; readCopyPending.current = null;
    setReadCopyNotice(""); setReadCopyCopyNotice("");
  };

  const reloadReadCopy = () => {
    if (readCopyFlight.current || readCopyBusy || readCopyLoading) return;
    setReadCopyConfirmDiscard(false); setReadCopyNotice(""); setReadCopyError(""); setReadCopyCopyNotice("");
    setReadCopyReload((value) => value + 1);
  };

  const requestReadCopyReload = () => {
    if (readCopyBusy || readCopyLoading) return;
    if (readCopyDirty || readCopyUnknown || readCopyConflict) { setReadCopyConfirmDiscard(true); return; }
    reloadReadCopy();
  };

  async function saveReadCopy() {
    if (!readCopyDraft || readCopyBusy || readCopyLoading || readCopyFlight.current || !canConfigureIntegration || readCopyConflict || readCopyReadDenied || readCopyReadFailed || readCopyWriteDenied || readCopyConfirmDiscard || readCopyInvalid) return;
    readCopyReadGeneration.current += 1;
    readCopyFlight.current = true;
    onWriteLockChange?.(true);
    const payload = readCopyUnknown && readCopyPending.current ? readCopyPending.current : {
      version: readCopyDraft.version,
      enabled: readCopyDraft.enabled,
      publicOrigin: readCopyDraft.publicOrigin.trim() || null,
      operationId: readCopyOperation.current ||= crypto.randomUUID().replaceAll("-", ""),
    };
    readCopyPending.current = payload;
    setReadCopyBusy(true); setReadCopyError(""); setReadCopyNotice("");
    try {
      const value = await request<ReadCopySettings>("/im/read-copy-settings", payload, "PUT");
      setReadCopy(value); setReadCopyDraft(readCopyDraftOf(value));
      readCopyOperation.current = ""; readCopyPending.current = null;
      setReadCopyUnknown(false); setReadCopyConflict(false); setReadCopyWriteDenied(false);
      setReadCopyReadDenied(false); setReadCopyReadFailed(false);
      setReadCopyNotice("同步设置已保存。");
    } catch (reason) {
      const status = errorStatus(reason);
      if (status === 409) {
        setReadCopyConflict(true);
        setReadCopyError("设置或服务状态已变化，请刷新后核对；草稿已保留。");
      } else if (status === 403) {
        setReadCopyWriteDenied(true);
        setReadCopyError("你没有修改阅读状态同步的权限。");
      } else if (status === 404) {
        setReadCopyReadFailed(true);
        setReadCopyError("同步服务尚未部署，设置未保存。");
      } else if (status === 400) {
        setReadCopyError("保存内容未通过服务端校验，请检查公网域名。");
      } else if (status === 0 || status === undefined || status >= 500) {
        setReadCopyUnknown(true);
        setReadCopyError("保存结果尚未确认，请重试保存或刷新核对。");
      } else {
        setReadCopyError(friendlyError(reason));
      }
    } finally {
      readCopyFlight.current = false; setReadCopyBusy(false);
    }
  }

  async function copyReadCopyCallback() {
    if (!readCopyCallbackUrl) return;
    try {
      await navigator.clipboard.writeText(readCopyCallbackUrl);
      setReadCopyCopyNotice("已复制回调地址。");
    } catch {
      readCopyCallbackInput.current?.focus(); readCopyCallbackInput.current?.select();
      setReadCopyCopyNotice("无法自动复制，请手动选择复制。");
    }
  }

  async function save() {
    if (!draft || busy || flight.current || !canConfigure || invalid) return;
    flight.current = true;
    operation.current ||= crypto.randomUUID().replaceAll("-", "");
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await request<Settings>("/im/support-settings", { version: draft.version, serviceMessage: draft.serviceMessage, complaintMessage: draft.complaintMessage, operationId: operation.current }, "PUT");
      setSaved(value); setDraft(value);
      setNotice("已保存。仅对之后新建的咨询轮次生效，不会重发历史消息。");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      flight.current = false; setBusy(false);
    }
  }

  if (demo) return <section className="im-assistant-settings"><Card><CardHeader><CardTitle>洲洲助手设置</CardTitle><CardDescription>演示模式不修改全局自动消息。</CardDescription></CardHeader></Card></section>;
  return <section className="im-assistant-settings" aria-labelledby="assistant-settings-title" ref={sectionRef}>
    <div className="im-assistant-inner">
      <header className="im-assistant-head">
        <span className="im-assistant-avatar"><Bot aria-hidden="true" /></span>
        <div className="im-assistant-heading">
          <h2 id="assistant-settings-title">洲洲助手设置</h2>
        </div>
      </header>
      <div className="im-assistant-layout">
        <nav className="im-assistant-nav" aria-label="自动消息场景">
          {GROUPS.map((item) => <Button key={item.id} data-group={item.id} disabled={readCopyBusy} variant={group === item.id ? "secondary" : "ghost"} className="im-assistant-scene" aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>
            <item.icon aria-hidden="true" />
            <span><strong>{item.title}</strong><small>{item.hint}</small></span>
          </Button>)}
        </nav>
        <main className="im-assistant-main">
          {group === "welcome" ? <AssistantWelcomePanel
            error={error}
            notice={notice}
            loading={loading}
            draft={draft}
            canConfigure={canConfigure}
            busy={busy}
            invalid={invalid}
            invalidReason={invalidReason}
            dirty={dirty}
            saved={saved}
            previewKey={previewKey}
            confirmDiscard={confirmDiscard}
            edit={edit}
            setPreviewKey={setPreviewKey}
            save={save}
            setConfirmDiscard={setConfirmDiscard}
            reloadSettings={reloadSettings}
          /> : group === "integration" ? <AssistantReadCopyPanel
            readCopyError={readCopyError}
            readCopyUnknown={readCopyUnknown}
            readCopyConflict={readCopyConflict}
            readCopyReadFailed={readCopyReadFailed}
            readCopy={readCopy}
            readCopyNotice={readCopyNotice}
            readCopyReadDenied={readCopyReadDenied}
            readCopyLoading={readCopyLoading}
            reloadReadCopy={reloadReadCopy}
            readCopyDraft={readCopyDraft}
            readCopyToggleDisabled={readCopyToggleDisabled}
            updateReadCopy={updateReadCopy}
            readCopyOriginValidation={readCopyOriginValidation}
            readCopyFormDisabled={readCopyFormDisabled}
            readCopyReceiverBlocked={readCopyReceiverBlocked}
            readCopyCallbackInput={readCopyCallbackInput}
            readCopyCallbackUrl={readCopyCallbackUrl}
            readCopyBusy={readCopyBusy}
            copyReadCopyCallback={copyReadCopyCallback}
            readCopyCallbackDirty={readCopyCallbackDirty}
            readCopyCopyNotice={readCopyCopyNotice}
            canConfigureIntegration={canConfigureIntegration}
            readCopyConfirmDiscard={readCopyConfirmDiscard}
            setReadCopyConfirmDiscard={setReadCopyConfirmDiscard}
            requestReadCopyReload={requestReadCopyReload}
            readCopyCanRetry={readCopyCanRetry}
            readCopyCanSave={readCopyCanSave}
            saveReadCopy={saveReadCopy}
            readCopyStatus={readCopyStatus}
            readCopyDirty={readCopyDirty}
          /> : <AssistantSceneCatalog group={group} />}
        </main>
      </div>
    </div>
  </section>;
}
