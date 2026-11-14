"use client";

import { type RefObject } from "react";
import { Copy, Info } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { formatDateTime } from "./im-support-format";
import type { ReadCopyDraft, ReadCopySettings, ReadCopyStatusInfo } from "./im-support-settings-read-copy";

export function AssistantReadCopyPanel({
  readCopyError, readCopyUnknown, readCopyConflict, readCopyReadFailed, readCopy, readCopyNotice,
  readCopyReadDenied, readCopyLoading, reloadReadCopy, readCopyDraft, readCopyToggleDisabled, updateReadCopy,
  readCopyOriginValidation, readCopyFormDisabled, readCopyReceiverBlocked, readCopyCallbackInput, readCopyCallbackUrl,
  readCopyBusy, copyReadCopyCallback, readCopyCallbackDirty, readCopyCopyNotice, canConfigureIntegration,
  readCopyConfirmDiscard, setReadCopyConfirmDiscard, requestReadCopyReload, readCopyCanRetry, readCopyCanSave, saveReadCopy, readCopyStatus, readCopyDirty,
}: {
  readCopyError: string;
  readCopyUnknown: boolean;
  readCopyConflict: boolean;
  readCopyReadFailed: boolean;
  readCopy: ReadCopySettings | null;
  readCopyNotice: string;
  readCopyReadDenied: boolean;
  readCopyLoading: boolean;
  reloadReadCopy: () => void;
  readCopyDraft: ReadCopyDraft | null;
  readCopyToggleDisabled: boolean;
  updateReadCopy: (patch: Partial<Pick<ReadCopyDraft, "enabled" | "publicOrigin">>) => void;
  readCopyOriginValidation: string;
  readCopyFormDisabled: boolean;
  readCopyReceiverBlocked: boolean;
  readCopyCallbackInput: RefObject<HTMLInputElement | null>;
  readCopyCallbackUrl: string;
  readCopyBusy: boolean;
  copyReadCopyCallback: () => Promise<void>;
  readCopyCallbackDirty: boolean;
  readCopyCopyNotice: string;
  canConfigureIntegration: boolean;
  readCopyConfirmDiscard: boolean;
  setReadCopyConfirmDiscard: (value: boolean) => void;
  requestReadCopyReload: () => void;
  readCopyCanRetry: boolean;
  readCopyCanSave: boolean;
  saveReadCopy: () => Promise<void>;
  readCopyStatus: ReadCopyStatusInfo | null;
  readCopyDirty: boolean;
}) {
  return <div className="im-assistant-integration">
            {readCopyError ? <p role="alert" className={`im-assistant-alert ${readCopyUnknown || readCopyConflict ? "" : "text-destructive"}`}>{readCopyError}</p> : null}
            {readCopyReadFailed && readCopy ? <p className="im-assistant-help">上次读取的设置，可能已变化；请刷新核对。</p> : null}
            {readCopyNotice ? <p role="status" className="im-assistant-alert">{readCopyNotice}</p> : null}
            {readCopyReadDenied ? <Card><CardHeader><CardTitle>无法查看同步设置</CardTitle></CardHeader><CardContent className="im-assistant-fields">
              {readCopyUnknown ? <p role="alert">此前保存结果尚未确认，恢复权限后请刷新核对。</p> : null}
              <div><Button variant="outline" disabled={readCopyLoading} onClick={reloadReadCopy}>{readCopyLoading ? "正在刷新…" : "刷新"}</Button></div>
            </CardContent></Card> : readCopyLoading && !readCopy ? <Card><CardContent className="im-assistant-loading"><Skeleton className="h-40 w-full" /><span>正在读取同步设置…</span></CardContent></Card> : readCopy ? <>
              <div className="im-assistant-integration-grid">
                <Card>
                  <CardHeader><CardTitle>阅读状态同步</CardTitle><CardDescription>将用户的阅读进度同步到客服会话。</CardDescription></CardHeader>
                  <CardContent className="im-assistant-fields">
                    <label className="im-assistant-check">
                      <Checkbox checked={readCopyDraft?.enabled ?? false} disabled={readCopyToggleDisabled} onCheckedChange={(checked) => updateReadCopy({ enabled: checked === true })} />
                      <span><b>开启阅读状态同步</b></span>
                    </label>
                    <Field label="服务域名" error={readCopyOriginValidation || undefined} hint="请向技术人员获取 HTTPS 域名；尚未部署时可保持关闭。">
                      <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={readCopyDraft?.publicOrigin ?? ""} disabled={readCopyFormDisabled} placeholder="https://im-dev.example.com" onChange={(event) => updateReadCopy({ publicOrigin: event.target.value })} />
                    </Field>
                    {readCopyReceiverBlocked ? <p role="alert" className="text-sm text-destructive">同步服务尚未部署，暂时无法开启。</p> : null}
                    <div className="im-assistant-field">
                      <label className="im-assistant-label" htmlFor="read-copy-callback">云信回调地址</label>
                      <div className="im-assistant-copy-row">
                        <Input ref={readCopyCallbackInput} id="read-copy-callback" readOnly value={readCopyCallbackUrl} placeholder="保存服务域名后生成" onClick={(event) => event.currentTarget.select()} />
                        <Button variant="outline" size="sm" disabled={!readCopyCallbackUrl || readCopyBusy} onClick={() => void copyReadCopyCallback()}><Copy aria-hidden="true" />复制</Button>
                      </div>
                      <p className="im-assistant-help">开启并保存后，将此地址填入云信后台。</p>
                      {readCopyCallbackDirty ? <p className="im-assistant-note">域名尚未保存，此处仍为原地址。</p> : null}
                      {readCopyCopyNotice ? <p role="status" className="im-assistant-note">{readCopyCopyNotice}</p> : null}
                    </div>
                    {!canConfigureIntegration ? <p className="im-assistant-help">你可以查看设置，修改需要“配置客服消息接入”权限。</p> : null}
                    {readCopyConfirmDiscard ? <div className="im-assistant-discard" role="alert"><span>刷新会放弃未保存的修改。</span><Button size="sm" variant="destructive" disabled={readCopyBusy || readCopyLoading} onClick={reloadReadCopy}>确认放弃</Button><Button size="sm" variant="outline" disabled={readCopyBusy} onClick={() => setReadCopyConfirmDiscard(false)}>取消</Button></div> : null}
                  </CardContent>
                  <CardFooter className="im-assistant-savebar">
                    <div className="im-assistant-save-actions">
                      {readCopyConflict ? <Button disabled={readCopyBusy || readCopyLoading} onClick={requestReadCopyReload}>刷新</Button> : <Button disabled={readCopyUnknown ? !readCopyCanRetry : !readCopyCanSave} onClick={() => void saveReadCopy()}>{readCopyBusy ? "正在保存…" : readCopyUnknown ? "重试保存" : "保存设置"}</Button>}
                      {readCopyConflict ? null : <Button variant="outline" disabled={readCopyBusy || readCopyLoading} onClick={requestReadCopyReload}>刷新</Button>}
                    </div>
                    <span className="im-assistant-save-note">{readCopyConflict ? "设置已变化，请刷新核对" : readCopyUnknown ? "保存结果待确认" : readCopyDirty ? "有未保存的修改" : readCopy.updatedAt ? `已保存 · ${formatDateTime(readCopy.updatedAt)}` : "尚未保存"}</span>
                  </CardFooter>
                </Card>
                <div className="im-assistant-side">
                  <Card>
                    <CardHeader><div className="im-assistant-card-head"><CardTitle>同步状态</CardTitle>{readCopyStatus ? <Badge variant={readCopyStatus.variant}>{readCopyStatus.label}</Badge> : null}</div></CardHeader>
                    <CardContent>
                      <p className="im-assistant-help">{readCopyStatus?.description}</p>
                      <dl className="im-assistant-facts">
                        <div><dt>最近地址验证</dt><dd>{readCopy.lastVerifiedAt ? formatDateTime(readCopy.lastVerifiedAt) : "尚无"}</dd></div>
                        <div><dt>最近阅读通知</dt><dd>{readCopy.lastEventAt ? formatDateTime(readCopy.lastEventAt) : "尚无"}</dd></div>
                      </dl>
                    </CardContent>
                  </Card>
                  <details className="im-assistant-integration-help">
                    <summary><Info size={15} aria-hidden="true" />配置说明</summary>
                    <ol className="im-assistant-steps">
                      <li>请技术人员部署云信通知接收服务，并提供公网 HTTPS 域名。</li>
                      <li>在本页填写服务域名，开启并保存后复制回调地址。</li>
                      <li>在云信开发 App → 消息抄送中填写地址，选择“会话已读回执”（85）。</li>
                    </ol>
                    <p className="im-assistant-note">收到地址验证，只说明云信曾访问过该地址；收到阅读通知，也不代表全部消息都已同步。</p>
                  </details>
                </div>
              </div>
            </> : <Card><CardHeader><CardTitle>无法读取同步设置</CardTitle><CardDescription>{readCopyError || "请稍后刷新重试。"}</CardDescription></CardHeader><CardContent className="im-assistant-fields">{readCopyUnknown ? <p role="alert">此前保存结果尚未确认，请刷新核对。</p> : null}<div><Button variant="outline" disabled={readCopyLoading} onClick={reloadReadCopy}>刷新</Button></div></CardContent></Card>}
  </div>;
}
