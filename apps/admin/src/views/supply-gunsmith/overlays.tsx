import type { Dispatch, SetStateAction } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { SupplySelect } from "@/components/supply/supply-select";

import type { AdminGunsmithAlias, AdminGunsmithClassification, AdminGunsmithCode, AdminGunsmithFirearm, CatalogMediaOption } from "../../api";
import { StatusMessage } from "../../components/ui-elements";
import { CellInput, CellSelect, CopyCode } from "../supply-catalog/catalog-table";
import { aliasCount, codeCount, EMPTY_HINT, MODE_ITEMS, type GunsmithEntity } from "./model";
import type { Editor } from "./gunsmith-commands";

const enableItems = [{ value: "true", label: "启用" }, { value: "false", label: "停用" }];

export function GunsmithOverlays({
  editor, setEditor, busy, saving, editorDirty, fieldError, error, firearm, firearms, classifications, aliases, codes,
  setDiscardEditor, discardEditor, saveEditor, statusTarget, setStatusTarget, runWrite, pendingSwitch, setPendingSwitch,
  applySwitch, termsOpen, setTermsOpen, closeMediaPicker, startEditor, mediaPicking, mediaOptions, mediaError, mediaLoading,
  mediaNextCursor, mediaRetryCursor, openMediaPicker, loadMediaPage,
}: {
  editor: Editor | null;
  setEditor: Dispatch<SetStateAction<Editor | null>>;
  busy: boolean;
  saving: boolean;
  editorDirty: boolean;
  fieldError: { key: string; message: string } | null;
  error: string | undefined;
  firearm: AdminGunsmithFirearm | null;
  firearms: AdminGunsmithFirearm[];
  classifications: AdminGunsmithClassification[];
  aliases: AdminGunsmithAlias[];
  codes: AdminGunsmithCode[];
  discardEditor: boolean;
  setDiscardEditor: Dispatch<SetStateAction<boolean>>;
  saveEditor: () => void;
  statusTarget: AdminGunsmithCode | null;
  setStatusTarget: Dispatch<SetStateAction<AdminGunsmithCode | null>>;
  runWrite: (entity: GunsmithEntity, path: string, body: Record<string, unknown>, method: "POST" | "PUT", action: string, key: string) => Promise<void>;
  pendingSwitch: { type: "game" | "firearm"; value: string } | null;
  setPendingSwitch: Dispatch<SetStateAction<{ type: "game" | "firearm"; value: string } | null>>;
  applySwitch: (type: "game" | "firearm", value: string) => void;
  termsOpen: boolean;
  setTermsOpen: Dispatch<SetStateAction<boolean>>;
  closeMediaPicker: () => void;
  startEditor: (next: Editor) => void;
  mediaPicking: boolean;
  mediaOptions: CatalogMediaOption[];
  mediaError: string | undefined;
  mediaLoading: boolean;
  mediaNextCursor: string | null;
  mediaRetryCursor: string | null;
  openMediaPicker: () => void;
  loadMediaPage: (cursor: string | null) => Promise<void> | void;
}) {
  const editing = (entity: GunsmithEntity, id?: string) => editor?.entity === entity && editor?.id === id;
  const editValue = (key: string, fallback = "") => editor?.values[key] ?? fallback;
  const fieldMessage = (key: string) => (fieldError?.key === key ? fieldError.message : undefined);
  const setEditValue = (key: string, value: string) => setEditor((current) => (current ? { ...current, values: { ...current.values, [key]: value } } : current));
  const classificationItems = [{ value: "", label: "未分类" }, ...classifications.map((entry) => ({ value: entry.id, label: entry.name }))];

  const rowSaveCancel = (id?: string) => (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" size="sm" disabled={busy} onClick={saveEditor}>保存</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => { setEditor(null); closeMediaPicker(); }}>{busy ? "关闭（稍后核对）" : "取消"}</Button>
      {id ? <span className="text-[10px] text-muted-foreground">版本 {editor?.revision ?? "未提供"}</span> : null}
    </span>
  );

  const mediaBlock = (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">武器图片</span>
        {editValue("mediaId") ? <Button type="button" size="sm" variant="outline" onClick={() => setEditValue("mediaId", "")}>解除绑定</Button> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">只绑定本平台已审核且允许公开的 FIREARM_MEDIA 衍生图；本页不上传字节，撤权后公开页自动降级为无图。</p>
      {editValue("mediaId") ? (
        <div className="flex items-center gap-3">
          <img src={`/api/v1/supply/media/${editValue("mediaId")}/content`} alt="当前绑定武器图" className="h-16 w-16 rounded border border-border object-cover" loading="lazy" />
          <span className="font-mono text-[11px] break-all text-muted-foreground">{editValue("mediaId")}</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">当前未绑定图片。</p>
      )}
      {mediaPicking ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">候选已按游戏与用途过滤：FIREARM_MEDIA、已审核且允许公开。</span>
            <Button type="button" size="sm" variant="ghost" onClick={closeMediaPicker}>收起候选</Button>
          </div>
          <StatusMessage themeAware error={mediaError} />
          {mediaLoading && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">加载候选图片…</p> : null}
          {!mediaLoading && !mediaError && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">没有可绑定图片；请先在素材审核上传并审核公开 FIREARM_MEDIA 素材。</p> : null}
          {mediaOptions.length > 0 ? (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {mediaOptions.map((option) => (
                  <Button type="button" variant="outline" key={option.id} aria-label={`绑定候选 ${option.id}`} className="h-auto flex-col items-stretch gap-0 overflow-hidden p-0 text-left" onClick={() => { setEditValue("mediaId", option.id); closeMediaPicker(); }}>
                    <img src={`/api/v1/supply/media/${option.id}/content`} alt={`候选 ${option.id}`} className="h-14 w-full object-cover" loading="lazy" />
                    <span className="block truncate px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{option.id.slice(0, 14)}… · {option.width}×{option.height}</span>
                  </Button>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                {mediaNextCursor && !mediaError ? <Button type="button" size="sm" variant="outline" disabled={mediaLoading} onClick={() => void loadMediaPage(mediaNextCursor)}>加载更多</Button> : null}
                {mediaError ? <Button type="button" size="sm" variant="outline" disabled={mediaLoading} onClick={() => void loadMediaPage(mediaRetryCursor)}>重试</Button> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={openMediaPicker}>选择图片</Button>
      )}
    </div>
  );
  return (
    <>
      <Sheet open={Boolean(editor && (editor.entity === "code" || editor.entity === "alias"))} onOpenChange={open => { if (!open && !busy) { if (editorDirty) setDiscardEditor(true); else setEditor(null); } }}>
        <SheetContent showCloseButton={!busy} closeLabel="关闭编辑窗口" className="w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
          <SheetHeader className="border-b"><SheetTitle>{editor?.id ? "编辑" : "新增"}{editor?.entity === "alias" ? "枪械别名" : "改枪码"}</SheetTitle><SheetDescription>所属枪械：{firearms.find(f => f.id === editor?.firearmId)?.name ?? "未提供"}。保存维护内容，不会开启玩家端服务。</SheetDescription></SheetHeader>
          <div className="flex-1 space-y-5 overflow-y-auto p-5">
            {editor?.entity === "code" ? <>
              <Field label="改枪码原文" required hint="支持粘贴游戏导出的完整改枪码文本或短码。" error={fieldMessage("code")}><Textarea value={editValue("code")} disabled={busy} onChange={e => setEditValue("code", e.target.value)} className="min-h-32 font-mono"/></Field>
              <Field label="模式" composite hint="请按方案适用的模式进行标注（如烽火地带、全面战场或通用）。"><SupplySelect label="模式" value={editValue("modeCode")} options={MODE_ITEMS} disabled={busy} onValueChange={v => setEditValue("modeCode", v)}/></Field>
              <Field label="方案说明" hint="例如：低成本腰射、满改红点。说明用于区分同一枪械的不同方案。"><Input value={editValue("note")} disabled={busy} onChange={e => setEditValue("note", e.target.value)}/></Field>
              <Field
                label={
                  <span className="flex items-center justify-between w-full">
                    <span>最近人工复核（北京时间）</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const now = new Date();
                        const beijingTime = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 16);
                        setEditValue("lastReviewedAt", beijingTime);
                      }}
                      className="h-5 px-1 text-[11px] font-normal text-primary hover:underline hover:bg-transparent"
                    >
                      设为当前时间
                    </Button>
                  </span>
                }
                hint="留空表示未记录。填写时间不代表代码已在游戏内验证成功。"
                error={fieldMessage("lastReviewedAt")}
              >
                <Input type="datetime-local" value={editValue("lastReviewedAt")} disabled={busy} onChange={e => setEditValue("lastReviewedAt", e.target.value)}/>
              </Field>
              <p className="text-xs text-muted-foreground">收录状态、玩家端开放状态、游戏内可用性分别核对。</p>
            </> : editor?.entity === "alias" ? <>
              <Field label="别名" required hint="用于查找当前枪械，不是另一条改枪方案。" error={fieldMessage("name")}><Input value={editValue("name")} disabled={busy} onChange={e => setEditValue("name", e.target.value)}/></Field>
              <Field label="语言"><Input value={editValue("locale")} disabled={busy || Boolean(editor?.id)} onChange={e => setEditValue("locale", e.target.value)}/></Field>
              <Field label="启用" composite><SupplySelect label="启用" value={editValue("enabled")} options={enableItems} disabled={busy} onValueChange={v => setEditValue("enabled", v)}/></Field>
              <Field label="排序"><Input type="number" value={editValue("sortOrder")} disabled={busy} onChange={e => setEditValue("sortOrder", e.target.value)}/></Field>
            </> : null}
            <StatusMessage themeAware error={error}/>
          </div>
          <div className="flex justify-end gap-2 border-t p-4"><Button type="button" variant="outline" disabled={busy} onClick={() => editorDirty ? setDiscardEditor(true) : setEditor(null)}>取消</Button><Button type="button" disabled={busy} onClick={saveEditor}>{saving ? "保存中…" : "保存"}</Button></div>
        </SheetContent>
      </Sheet>
      <Dialog open={discardEditor} onOpenChange={setDiscardEditor}><DialogContent closeLabel="关闭窗口"><DialogHeader><DialogTitle>放弃未保存修改？</DialogTitle><DialogDescription>当前输入尚未保存，返回可继续编辑。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDiscardEditor(false)}>保留编辑</Button><Button type="button" variant="destructive" onClick={() => { setDiscardEditor(false); setEditor(null); }}>放弃修改</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={Boolean(statusTarget)} onOpenChange={open => { if (!open && !busy) setStatusTarget(null); }}>
        <DialogContent closeLabel="关闭窗口" showCloseButton={!busy}><DialogHeader><DialogTitle>{statusTarget?.status === "ACTIVE" ? "撤回这套方案？" : "恢复收录这套方案？"}</DialogTitle><DialogDescription>{statusTarget?.status === "ACTIVE" ? "仅撤回当前方案，保留代码原文与历史资料，其他方案不受影响。" : "仅恢复方案收录，不会开启玩家端服务，也不代表游戏导入已验证。"}</DialogDescription></DialogHeader>
          <p className="text-sm font-medium">{firearms.find(f => f.id === statusTarget?.firearmId)?.name ?? "枪械未提供"} · {statusTarget?.note || "未填写方案说明"}</p><code className="select-text break-all text-xs">{statusTarget?.code}</code><StatusMessage themeAware error={error}/>
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setStatusTarget(null)}>取消</Button><Button type="button" disabled={busy} variant={statusTarget?.status === "ACTIVE" ? "destructive" : "default"} onClick={() => { if (!statusTarget) return; const c = statusTarget; void runWrite("code", `/supply/gunsmith/codes/${c.id}/${c.status === "ACTIVE" ? "withdraw" : "restore"}`, { expectedRevision: c.revision }, "POST", c.status === "ACTIVE" ? "撤回改枪码" : "恢复改枪码", `idem_${crypto.randomUUID().replaceAll("-", "")}`).then(() => setStatusTarget(null)); }}>{statusTarget?.status === "ACTIVE" ? "确认撤回" : "确认恢复"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={termsOpen} onOpenChange={(open) => { if (!open) { if (editorDirty) return; setTermsOpen(false); setEditor(null); closeMediaPicker(); } }}>
        <DialogContent closeLabel="关闭窗口" className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>管理基础目录</DialogTitle>
            <DialogDescription>维护枪械分类与基础资料。枪械改名不会改变已关联的皮肤或改枪方案；方案在主工作区维护。</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">武器类型（分类）</h4>
                <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "classification", values: { code: "", name: "", sortOrder: "0", enabled: "true" } })}>新增分类</Button>
              </div>
              <div className="table-wrap">
                <Table>
                  <TableHeader><TableRow><TableHead>分类</TableHead><TableHead>排序</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {editing("classification", undefined) ? (
                      <TableRow data-editing="new">
                        <TableCell className="whitespace-normal"><div className="space-y-1"><CellInput label="稳定 code" value={editValue("code")} disabled={busy} onValueChange={(value) => setEditValue("code", value)} /><CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} /></div></TableCell>
                        <TableCell className="whitespace-normal"><CellInput label="排序" type="number" value={editValue("sortOrder", "0")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} /></TableCell>
                        <TableCell className="whitespace-normal"><CellSelect label="启用" value={editValue("enabled", "true")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} /></TableCell>
                        <TableCell className="text-right">{rowSaveCancel()}</TableCell>
                      </TableRow>
                    ) : null}
                    {classifications.length === 0 && !editing("classification", undefined) ? (
                      <TableRow><TableCell colSpan={4} className="py-5 text-xs text-muted-foreground">{EMPTY_HINT.classification}</TableCell></TableRow>
                    ) : classifications.map((entry) => (
                      <TableRow key={entry.id} data-editing={editing("classification", entry.id) ? "true" : undefined}>
                        <TableCell className="whitespace-normal">{editing("classification", entry.id) ? <div className="space-y-1"><CopyCode code={entry.code} /><CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} /></div> : <div className="space-y-0.5"><span className="text-sm">{entry.name}</span><CopyCode code={entry.code} /></div>}</TableCell>
                        <TableCell className="whitespace-normal">{editing("classification", entry.id) ? <CellInput label="排序" type="number" value={editValue("sortOrder")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} /> : <span className="text-xs">{entry.sortOrder}</span>}</TableCell>
                        <TableCell className="whitespace-normal">{editing("classification", entry.id) ? <CellSelect label="启用" value={editValue("enabled")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} /> : <Badge variant={entry.enabled ? "secondary" : "outline"}>{entry.enabled ? "启用" : "停用"}</Badge>}</TableCell>
                        <TableCell className="text-right">{editing("classification", entry.id) ? rowSaveCancel(entry.id) : <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "classification", id: entry.id, revision: entry.revision, values: { code: entry.code, name: entry.name, sortOrder: String(entry.sortOrder), enabled: String(entry.enabled) } })}>编辑</Button>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">武器</h4>
                <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "firearm", values: { code: "", name: "", classificationId: firearm?.classificationId ?? "", mediaId: "", sortOrder: "0", enabled: "true" } })}>新增武器</Button>
              </div>
              <div className="table-wrap">
                <Table>
                  <TableHeader><TableRow><TableHead>武器</TableHead><TableHead>分类</TableHead><TableHead>别名 / 改枪码</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {editing("firearm", undefined) ? (
                      <TableRow data-editing="new">
                        <TableCell className="whitespace-normal" colSpan={4}>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <CellInput label="稳定 code" value={editValue("code")} disabled={busy} onValueChange={(value) => setEditValue("code", value)} />
                            <CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} />
                            <CellSelect label="分类" value={editValue("classificationId")} items={classificationItems} disabled={busy} onValueChange={(value) => setEditValue("classificationId", value)} />
                            <CellInput label="排序" type="number" value={editValue("sortOrder", "0")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} />
                            <CellSelect label="启用" value={editValue("enabled", "true")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} />
                            <p className="self-end text-[11px] text-muted-foreground">新建武器不绑定图片；保存后再编辑即可绑定。</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{rowSaveCancel()}</TableCell>
                      </TableRow>
                    ) : null}
                    {firearms.length === 0 && !editing("firearm", undefined) ? (
                      <TableRow><TableCell colSpan={5} className="py-5 text-xs text-muted-foreground">{EMPTY_HINT.firearm}</TableCell></TableRow>
                    ) : firearms.map((entry) => (
                      <TableRow key={entry.id} data-editing={editing("firearm", entry.id) ? "true" : undefined}>
                        <TableCell className="whitespace-normal">
                          {editing("firearm", entry.id) ? (
                            <div className="space-y-3">
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <div className="space-y-1"><CopyCode code={entry.code} /><span className="block text-[11px] text-muted-foreground">创建后不可修改</span></div>
                                <CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} />
                                <CellSelect label="分类" value={editValue("classificationId")} items={classificationItems} disabled={busy} onValueChange={(value) => setEditValue("classificationId", value)} />
                                <CellInput label="排序" type="number" value={editValue("sortOrder")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} />
                                <CellSelect label="启用" value={editValue("enabled")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} />
                              </div>
                              {mediaBlock}
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              <span className="text-sm font-medium">{entry.name}</span>
                              <CopyCode code={entry.code} />
                              {entry.mediaId ? <img src={`/api/v1/supply/media/${entry.mediaId}/content`} alt="" className="h-10 w-10 rounded border border-border object-cover" loading="lazy" /> : null}
                            </div>
                          )}
                        </TableCell>
                        {!editing("firearm", entry.id) ? (
                          <>
                            <TableCell className="text-xs">{classifications.find((item) => item.id === entry.classificationId)?.name ?? "未分类"}</TableCell>
                            <TableCell className="text-xs">{aliasCount(aliases, entry.id)} / {codeCount(codes, entry.id)}</TableCell>
                            <TableCell><Badge variant={entry.enabled ? "secondary" : "outline"}>{entry.enabled ? "启用" : "停用"}</Badge></TableCell>
                          </>
                        ) : null}
                        <TableCell className="text-right">{editing("firearm", entry.id) ? rowSaveCancel(entry.id) : <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "firearm", id: entry.id, revision: entry.revision, values: { code: entry.code, name: entry.name, classificationId: entry.classificationId ?? "", mediaId: entry.mediaId ?? "", sortOrder: String(entry.sortOrder), enabled: String(entry.enabled) } })}>编辑</Button>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">停用不删除，历史引用保留；引用影响范围未提供。武器是共享稳定实体，改名不会更换皮肤目录与改枪码引用的 firearm ID。</p>
          </div>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy || editorDirty} onClick={() => { setEditor(null); closeMediaPicker(); setTermsOpen(false); }}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingSwitch)} onOpenChange={(open) => { if (!open) setPendingSwitch(null); }}>
        <DialogContent closeLabel="关闭窗口" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>切换将放弃未保存修改</DialogTitle>
            <DialogDescription>当前编辑内容尚未保存；切换游戏或武器会丢弃这些输入。</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPendingSwitch(null)}>保留编辑</Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => pendingSwitch && applySwitch(pendingSwitch.type, pendingSwitch.value)}>放弃修改并切换</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
