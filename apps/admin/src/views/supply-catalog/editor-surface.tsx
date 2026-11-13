import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { XIcon } from "lucide-react";

import type { AdminCatalogResponse, CatalogMediaOption, CatalogSkin } from "../../api";
import { StatusMessage } from "../../components/ui-elements";
import { ownerKinds, skinDisplayNameChanged } from "../catalog-skin-fields";
import { SkinMetadataFields } from "./skin-metadata-fields";
import { ownerText, OBJECT_LABEL, type CatalogFirearmOwner, type CatalogKind } from "./model";
import { CellSelect, type EditOptions } from "./catalog-table";
import { Field, type EditorState, type WritePhase } from "./editor-fields";

export function CatalogEditorSurface({
  detailOpen, editor, requestClose, detailSurfaceKind, detailFocusTarget, error, success, writePhase, catalog, firearms,
  editOptions, setEditor, mediaPickerOpen, mediaPickerPurpose, mediaOptions, mediaOptionsLoading, mediaOptionsError,
  mediaNextCursor, mediaRetryCursor, unbindMedia, dismissMediaPicker, pickMedia, loadMediaOptionsPage, openMediaPicker,
  setDetailOpen, saveEditor, storageBlocked,
}: {
  detailOpen: boolean;
  editor: EditorState | null;
  requestClose: () => void;
  detailSurfaceKind: CatalogKind | null;
  detailFocusTarget: () => HTMLElement | undefined;
  error: string | undefined;
  success: string | undefined;
  writePhase: WritePhase;
  catalog: AdminCatalogResponse | null;
  firearms: CatalogFirearmOwner[] | null;
  editOptions: EditOptions;
  setEditor: Dispatch<SetStateAction<EditorState | null>>;
  mediaPickerOpen: boolean;
  mediaPickerPurpose: "SKIN_MEDIA" | "ITEM_MEDIA" | null;
  mediaOptions: CatalogMediaOption[];
  mediaOptionsLoading: boolean;
  mediaOptionsError: string | undefined;
  mediaNextCursor: string | null;
  mediaRetryCursor: string | null;
  unbindMedia: () => void;
  dismissMediaPicker: () => void;
  pickMedia: (mediaId: string) => void;
  loadMediaOptionsPage: (cursor: string | null) => Promise<void> | void;
  openMediaPicker: () => void;
  setDetailOpen: Dispatch<SetStateAction<boolean>>;
  saveEditor: () => void;
  storageBlocked: boolean;
}) {
  const editorKindLabel = editor ? OBJECT_LABEL[editor.kind] : "";
  const skinEditing = editor?.kind === "skins";
  const displayNameChanged = skinEditing && !editor.confirm && skinDisplayNameChanged(editor.values, editor.original as CatalogSkin | undefined);
  const skinSurface = detailSurfaceKind === "skins";
  const EditorSurface = skinSurface ? Dialog : Sheet;
  const EditorContent = skinSurface ? DialogContent : SheetContent;
  const EditorHeader = skinSurface ? DialogHeader : SheetHeader;
  const EditorTitle = skinSurface ? DialogTitle : SheetTitle;
  const EditorDescription = skinSurface ? DialogDescription : SheetDescription;
  const EditorFooter = skinSurface ? DialogFooter : SheetFooter;
  return (
    <EditorSurface open={detailOpen && Boolean(editor)} onOpenChange={(open) => { if (!open) requestClose(); }}>
      <EditorContent className={skinSurface ? "flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-3xl" : "w-full! sm:max-w-[560px]! gap-0"} showCloseButton={false} finalFocus={detailFocusTarget}>
        <EditorHeader className={skinSurface ? "shrink-0 border-b border-border p-4 pr-14" : "shrink-0 border-b border-border pr-14"}>
          <EditorTitle>{editor?.confirm ? `确认${editorKindLabel}身份` : editor?.kind === "items" ? "计费物品图片" : editor?.kind === "skins" ? "编辑皮肤词条" : editor?.kind === "skin-owners" ? "所属对象身份与证据" : `${editorKindLabel}维护说明`}</EditorTitle>
          <EditorDescription>{editor?.kind === "skins" ? "修改展示资料；稳定编号与所属身份保持不变，保存后更新目录。" : editor?.kind === "items" ? "选择已审核且可公开的物品图片；保存后才更新绑定。" : editor?.kind === "skin-owners" ? "按证据核实稳定归属，既有身份不能通过改名替换。" : "名称、状态和排序在表格内维护；稳定编号保持不变。"}</EditorDescription>
          <Button type="button" variant="ghost" size="icon" aria-label="关闭详细信息" className="absolute right-3 top-3" onClick={requestClose}><XIcon /></Button>
          {editor?.values.name ? <p className="pt-2 text-sm font-medium break-words">{editor.values.name}</p> : null}
        </EditorHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <StatusMessage themeAware error={error} success={success} />
        {editor ? (
          <fieldset disabled={["saving", "unknown", "readback"].includes(writePhase)} className="min-w-0 space-y-4">
            {editor.kind === "skins" && !editor.confirm ? (
              <section className="space-y-3" aria-label="皮肤展示资料">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
                  <h3 className="text-sm font-semibold">展示资料</h3>
                  <span className="text-xs text-muted-foreground">稳定编号：{editor.values.code}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {(editor.original as CatalogSkin | undefined)?.namingState === "VERIFIED" ? <Field label="皮肤本名" hint="填写外观名称，所属对象前缀保持不变；改名需补充证据。"><Input aria-label="皮肤本名" disabled={writePhase !== "idle"} value={editor.values.baseName ?? ""} onChange={event => setEditor({ ...editor, values: { ...editor.values, baseName: event.target.value } })} /></Field> : <Field label="展示名称"><Input aria-label="名称" disabled={writePhase !== "idle"} value={editor.values.name ?? ""} onChange={event => setEditor({ ...editor, values: { ...editor.values, name: event.target.value } })} /></Field>}
                  <Field label="排序" hint="数值越小越靠前。"><Input aria-label="排序" disabled={writePhase !== "idle"} inputMode="numeric" value={editor.values.sortOrder ?? "0"} onChange={event => setEditor({ ...editor, values: { ...editor.values, sortOrder: event.target.value } })} /></Field>
                  <Field label="表单展示"><CellSelect label="表单展示" disabled={writePhase !== "idle"} value={editor.values.formVisible ?? "false"} items={editOptions.boolItems} onValueChange={value => setEditor({ ...editor, values: { ...editor.values, formVisible: value } })} /></Field>
                  <Field label="词条状态"><CellSelect label="词条状态" disabled={writePhase !== "idle"} value={editor.values.enabled ?? "false"} items={editOptions.boolItems.map(item => ({...item,label:item.value === "true" ? "启用" : "停用"}))} onValueChange={value => setEditor({ ...editor, values: { ...editor.values, enabled: value } })} /></Field>
                </div>
                {(editor.original as CatalogSkin | undefined)?.namingState === "VERIFIED" ? <p className="text-xs text-muted-foreground">当前展示：{(editor.original as CatalogSkin).name} · 所属：{ownerText((editor.original as CatalogSkin).ownerRef ?? null, catalog?.owners ?? [], firearms)}。本次不修改所属关系。</p> : null}
                {displayNameChanged ? <div className="rounded-md bg-muted p-3 text-xs"><strong>同一词条名称修正</strong><p className="mt-1">本名：{(editor.original as CatalogSkin).baseName} → {editor.values.baseName || "未填写"}。保存时核实原身份，旧展示名称保留为别名。</p></div> : null}
              </section>
            ) : null}

            {editor.confirm || (editor.kind === "skin-owners" && !editor.id) ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={editor.kind === "skins" ? "皮肤类型" : "所属对象类型"}>
                  <CellSelect label={editor.kind === "skins" ? "皮肤类型" : "所属对象类型"} value={editor.values.ownerKind ?? "AGENT"} items={editOptions.kindItems} onValueChange={(value) => setEditor({ ...editor, values: { ...editor.values, ownerKind: value, ownerId: "" } })} />
                </Field>
                {editor.kind === "skins" ? (
                  <>
                    {catalog?.game.code === "delta" && editor.values.ownerKind === "MELEE_TYPE" ? <p className="self-center text-xs text-muted-foreground">近战外观独立维护，无需选择所属对象。</p> : <Field label="所属对象" hint="按稳定ID选择；分类不是所属对象。">
                      <CellSelect
                        label="所属对象"
                        disabled={editor.values.ownerKind === "FIREARM" && firearms === null}
                        value={editor.values.ownerId ?? ""}
                        items={[{ value: "", label: editor.values.ownerKind === "MELEE_TYPE" ? "不指定所属对象" : "请选择已读取对象" }, ...(editor.values.ownerKind === "FIREARM" ? firearms ?? [] : (catalog?.owners ?? []).filter(o => o.kind === editor.values.ownerKind)).map(o => ({ value: o.id, label: `${o.name}${o.enabled ? "" : "（停用）"}` }))]}
                        onValueChange={(value) => setEditor({ ...editor, values: { ...editor.values, ownerId: value } })}
                      />
                    </Field>}
                    <Field label="皮肤本名"><Input value={editor.values.baseName ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, baseName: event.target.value } })} className="h-9 text-xs" /></Field>
                    {editor.values.ownerKind === "FIREARM" ? (
                      <div className="sm:col-span-2">
                        {firearms === null ? <StatusMessage themeAware error="枪械归属资料暂时无法读取，请稍后重试或联系管理员。" /> : firearms.length === 0 ? <p className="text-xs text-muted-foreground">当前游戏尚无枪械所属对象，请先维护枪械目录。</p> : <p className="text-xs text-muted-foreground">枪械归属来自当前受权目录，保存稳定对象编号。</p>}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
            {editor.kind === "skins" ? (
              <Field label="别名（每行一个）">
                <Textarea value={editor.values.aliases ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, aliases: event.target.value } })} className="min-h-20 text-xs" />
              </Field>
            ) : null}
            {editor.kind === "skins" && !editor.confirm ? <SkinMetadataFields skin={editor.original as CatalogSkin | undefined} values={editor.values} rarities={editOptions.rarityItems} onChange={(key, value) => setEditor(current => current ? { ...current, values: { ...current.values, [key]: value } } : current)} /> : null}
            {editor.kind === "skins" ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">当前主来源：{(editor.original as CatalogSkin)?.sourceNamespace ?? "命名空间未核"} / {(editor.original as CatalogSkin)?.sourceField ?? "无"} / {(editor.original as CatalogSkin)?.sourceToken ?? "无"}</p>
                <div className="flex items-center gap-2 text-xs">
                  <Checkbox id="catalog-source-attach" aria-label="主动填写已核主来源" disabled={writePhase !== "idle" || Boolean((editor.original as CatalogSkin)?.sourceNamespace)} checked={editor.values.changeSource === "true"} onCheckedChange={(checked) => setEditor({ ...editor, values: { ...editor.values, changeSource: String(checked) } })} />
                  <label htmlFor="catalog-source-attach">{editor.id ? "主动挂接主来源（普通保存不回传来源）" : "填写已核主来源（可选）"}</label>
                </div>
                {editor.values.changeSource === "true" ? (
                  <div className="grid grid-cols-1 gap-3">
                    <Field label="来源命名空间"><Input value={editor.values.sourceNamespace ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceNamespace: event.target.value } })} className="h-9 text-xs" /></Field>
                    <Field label="来源字段"><Input readOnly={Boolean((editor.original as CatalogSkin)?.sourceField)} value={editor.values.sourceField ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceField: event.target.value } })} className="h-9 text-xs" /></Field>
                    <Field label="原始来源值" hint="保留原文，不拆分或拼接。"><Input readOnly={Boolean((editor.original as CatalogSkin)?.sourceToken)} value={editor.values.sourceToken ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceToken: event.target.value } })} className="h-9 text-xs" /></Field>
                  </div>
                ) : null}
              </div>
            ) : null}
            {editor.kind === "skins" || editor.kind === "skin-owners" ? (
              <Field label="操作原因"><Input value={editor.values.reason ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, reason: event.target.value } })} className="h-9 text-xs" /></Field>
            ) : null}
            {editor.confirm || displayNameChanged || (editor.kind === "skins" && editor.id && editor.values.changeSource === "true") || (editor.kind === "skin-owners" && !editor.id) ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><Field label="证据链接（每行一条，最多8条）"><Textarea value={editor.values.evidenceUrls ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, evidenceUrls: event.target.value } })} className="min-h-20 text-xs" /></Field></div>
                <div className="sm:col-span-2"><Field label="证据核对日期" hint="已自动填充今日日期"><Input type="date" value={editor.values.observedAt ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, observedAt: event.target.value } })} className="h-9 text-xs" /></Field></div>
                <label className="hidden" aria-hidden="true">
                  <span>适用地区</span>
                  <Input aria-label="适用地区" value={editor.values.region ?? "中国大陆"} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, region: event.target.value } })} className="h-9 text-xs" />
                </label>
                <div className="sm:col-span-2"><Field label="证据说明" hint="说明所属关系及旧名称映射；核对日期用于本次各条链接。"><Textarea value={editor.values.note ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, note: event.target.value } })} className="min-h-20 text-xs" /></Field></div>
              </div>
            ) : null}
            {(editor.kind === "items" || editor.kind === "skins") && editor.id ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold">{editor.kind === "skins" ? "皮肤图片" : "物品图片"}</h4>
                  {editor.values.mediaId ? <Button type="button" size="sm" variant="outline" onClick={unbindMedia}>解除绑定</Button> : null}
                </div>
                <p className="text-xs text-muted-foreground">目录页只绑定本平台已审核且允许公开的衍生图，不上传字节；上传在素材审核。</p>
                {editor.values.mediaId ? (
                  <div className="flex items-center gap-3">
                    <span className="relative">
                      <img src={`/api/v1/supply/media/${editor.values.mediaId}/content`} alt="当前绑定图片" className={editor.kind === "skins" && editor.values.ownerKind === "AGENT" ? "h-56 w-36 rounded border border-border object-contain" : "h-28 w-48 rounded border border-border object-contain"} loading="lazy"
                        onLoad={(event) => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
                        onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }} />
                      <span data-fallback className="hidden text-xs text-muted-foreground">图片加载失败或已不可公开展示。</span>
                    </span>
                    <span className="font-mono text-xs text-muted-foreground truncate">{editor.values.mediaId}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">当前未绑定图片；公开目录将不投影任何图片。</p>
                )}
                {mediaPickerOpen ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">候选已按游戏与用途过滤：{mediaPickerPurpose}、已审核且允许公开。</span>
                      <Button type="button" size="sm" variant="ghost" onClick={dismissMediaPicker}>关闭</Button>
                    </div>
                    <StatusMessage themeAware error={mediaOptionsError} />
                    {mediaOptionsLoading && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">加载候选图片…</p> : null}
                    {!mediaOptionsLoading && !mediaOptionsError && mediaOptions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">没有可绑定图片；请先在素材审核上传并审核公开 {mediaPickerPurpose} 素材。</p>
                    ) : null}
                    {mediaOptions.length > 0 ? (
                      <>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {mediaOptions.map((option) => (
                            <Button type="button" variant="outline" key={option.id} className="h-auto flex-col gap-0 overflow-hidden rounded-md p-0 text-left" onClick={() => pickMedia(option.id)}>
                              <span className="relative block">
                                <img src={`/api/v1/supply/media/${option.id}/content`} alt={`候选 ${option.id}`} className="h-24 w-full object-contain" loading="lazy"
                                  onLoad={(event) => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
                                  onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }} />
                                <span data-fallback className="absolute inset-0 hidden grid place-items-center bg-surface text-xs text-muted-foreground">预览不可用</span>
                              </span>
                              <span className="block truncate px-1.5 py-1 font-mono text-xs text-muted-foreground">{option.id.slice(0, 18)}… · {option.width}×{option.height}</span>
                            </Button>
                          ))}
                        </div>
                        <div className="flex justify-end gap-2">
                          {mediaNextCursor && !mediaOptionsError ? <Button type="button" size="sm" variant="outline" disabled={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaNextCursor)}>加载更多</Button> : null}
                          {mediaOptionsError ? <Button type="button" size="sm" variant="outline" disabled={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaRetryCursor)}>重试</Button> : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <Button type="button" size="sm" variant="outline" onClick={openMediaPicker}>绑定图片</Button>
                )}
              </div>
            ) : null}
          </fieldset>
        ) : null}
        </div>
        <EditorFooter className={skinEditing ? "shrink-0 flex-row flex-wrap justify-end gap-2 border-t border-border p-4" : "shrink-0 flex-row flex-wrap justify-end gap-2 border-t border-border"}>
          {!skinSurface ? <Button type="button" size="sm" variant="ghost" onClick={() => setDetailOpen(false)}>返回行内编辑</Button> : null}
          <Button type="button" size="sm" disabled={writePhase !== "idle" || storageBlocked} onClick={() => saveEditor()}>{writePhase === "saving" ? "保存中…" : "保存"}</Button>
          <Button type="button" size="sm" variant="outline" onClick={requestClose}>{["saving", "unknown", "readback"].includes(writePhase) ? "关闭编辑（稍后核对原结果）" : "取消"}</Button>
        </EditorFooter>
      </EditorContent>
    </EditorSurface>
  );
}
