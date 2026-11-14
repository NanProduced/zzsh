"use client";

import { Badge } from "../components/ui/badge";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Field } from "../components/ui/field";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "../components/ui/message";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { formatDateTime } from "./im-support-format";
import { WELCOME_FIELDS, type FieldKey } from "./im-support-settings-scenes";

export type Settings = { version: number; serviceMessage: string; complaintMessage: string; updatedAt: string | null };

export function invalidReasonFor(text: string): string | null {
  if (!text.trim()) return "欢迎消息不能为空。";
  if (text.length > 1000) return "每条欢迎消息最多 1000 字。";
  if (new TextEncoder().encode(text).length > 3000) return "每条欢迎消息最多 3000 字节（UTF-8）。";
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]|\$\{|\{\{|\}\}/.test(text)) return "暂不支持变量或控制字符；请直接输入纯文本。";
  return null;
}

function PreviewMessage({ text }: { text: string }) {
  return <>
    <Message align="start" className="im-assistant-preview-message">
      <MessageAvatar className="im-assistant-preview-avatar" aria-hidden="true"><img src="/art/zhouzhou/avatar.webp" alt="" /></MessageAvatar>
      <MessageContent>
        <MessageHeader className="im-assistant-preview-meta"><b>洲洲助手</b><span>平台自动消息</span><span>新轮次开场</span></MessageHeader>
        <Bubble variant="secondary"><BubbleContent className="im-assistant-bubble">{text}</BubbleContent></Bubble>
      </MessageContent>
    </Message>
  </>;
}

export function AssistantWelcomePanel({
  error, notice, loading, draft, canConfigure, busy, invalid, invalidReason, dirty, saved,
  previewKey, confirmDiscard, edit, setPreviewKey, save, setConfirmDiscard, reloadSettings,
}: {
  error: string;
  notice: string;
  loading: boolean;
  draft: Settings | null;
  canConfigure: boolean;
  busy: boolean;
  invalid: boolean;
  invalidReason: string;
  dirty: boolean;
  saved: Settings | null;
  previewKey: FieldKey;
  confirmDiscard: boolean;
  edit: (key: FieldKey, value: string) => void;
  setPreviewKey: (key: FieldKey) => void;
  save: () => Promise<void>;
  setConfirmDiscard: (value: boolean) => void;
  reloadSettings: () => void;
}) {
  const previewText = draft?.[previewKey]?.trim() || "填写欢迎消息后，这里会显示发送效果。";
  return <>
    {error ? <p role="alert" className="im-assistant-alert text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="im-assistant-alert">{notice}</p> : null}
            <div className="im-assistant-welcome-grid">
              <Card className="im-assistant-editor">
                <CardHeader>
                  <div className="im-assistant-card-head">
                    <div><CardTitle>欢迎消息</CardTitle><CardDescription>新一轮咨询建群后发送。保存只影响后续新轮次，不重发历史消息。</CardDescription></div>
                  </div>
                </CardHeader>
                <CardContent className="im-assistant-fields">
                  {loading ? <div aria-label="正在加载助手设置"><Skeleton className="h-36 w-full" /></div> : draft ? WELCOME_FIELDS.map((scene) => <article key={scene.key} className="im-assistant-field">
                    <Field
                      label={<span className="im-assistant-field-label">{scene.label}<Badge variant="outline">可编辑</Badge></span>}
                      hint={`纯文本，1–1000 字；当前 ${draft[scene.field].length} / 1000 字。`}
                    >
                      <Textarea rows={3} maxLength={1000} value={draft[scene.field]} disabled={!canConfigure || busy} onFocus={() => setPreviewKey(scene.field)} onChange={(event) => edit(scene.field, event.target.value)} />
                    </Field>
                    <p className="im-assistant-field-meta"><span>触发：{scene.when}</span><span>发送身份：{scene.sender}</span></p>
                  </article>) : <Button variant="outline" onClick={reloadSettings}>重新加载设置</Button>}
                  {invalid ? <p role="alert" className="text-sm text-destructive">{invalidReason}</p> : null}
                </CardContent>
                <CardFooter className="im-assistant-savebar">
                  <div className="im-assistant-save-actions">
                    <Button disabled={!canConfigure || busy || !dirty || invalid} onClick={() => void save()}>{busy ? "正在保存…" : "保存欢迎消息"}</Button>
                    <Button variant="outline" disabled={busy || loading} onClick={() => dirty ? setConfirmDiscard(true) : reloadSettings()}>重新加载</Button>
                  </div>
                  <span className="im-assistant-save-note">{dirty ? "有未保存的修改" : saved?.updatedAt ? `已保存 · ${formatDateTime(saved.updatedAt)}` : "使用默认欢迎消息"}</span>
                </CardFooter>
              </Card>
                <Card className="im-assistant-preview">
                  <CardHeader>
                    <div className="im-assistant-card-head">
                      <CardTitle>消息预览</CardTitle>
                      <div className="im-assistant-preview-switch" role="group" aria-label="选择预览消息">
                        {WELCOME_FIELDS.map((scene) => <Button key={scene.key} size="sm" variant={previewKey === scene.field ? "secondary" : "ghost"} aria-pressed={previewKey === scene.field} onClick={() => setPreviewKey(scene.field)}>{scene.field === "serviceMessage" ? "普通咨询" : "投诉入口"}</Button>)}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent><PreviewMessage text={previewText} /></CardContent>
                </Card>
            </div>
            {!canConfigure ? <p className="im-assistant-help">当前可以查看；修改需要“配置洲洲助手”权限。</p> : null}
            {confirmDiscard ? <div className="im-assistant-discard" role="alert"><span>重新加载会放弃未保存的欢迎消息。</span><Button size="sm" variant="destructive" disabled={busy} onClick={reloadSettings}>确认放弃</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDiscard(false)}>取消</Button></div> : null}
  </>;
}
