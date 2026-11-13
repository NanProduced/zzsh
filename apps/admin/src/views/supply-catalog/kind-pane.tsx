import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TabsContent } from "@/components/ui/tabs";
import { ImageIcon } from "lucide-react";

import type { AdminCatalogResponse, CatalogSkin } from "../../api";
import { defaultStates, ownerKinds } from "../catalog-skin-fields";
import { unitText } from "../supply-review/model";
import { CatalogObjectTable, type EditOptions } from "./catalog-table";
import { Field, LabeledSelect, type EditorState, type WritePhase } from "./editor-fields";
import {
  categoryPath,
  EXPIRY_KIND_LABEL,
  IDENTITY_FILTER_ITEMS,
  OBJECT_LABEL,
  ownerText,
  skinOwnerKind,
  skinRarityBasisText,
  UNIT_LABEL,
  VALUE_KIND_LABEL,
  type CatalogFirearmOwner,
  type CatalogKind,
  type CatalogRow,
  type IdentityFilter,
} from "./model";

export function CatalogKindPane({
  kind, contractReady, visibleRows, query, editor, setQuery, typeFilter, setTypeFilter, rarityFilter, setRarityFilter,
  selectableFilter, setSelectableFilter, identityFilter, setIdentityFilter, mediaFilter, setMediaFilter, catalog, firearms,
  createReason, writePhase, storageBlocked, openCreate, saveEditor, requestClose, showDetail, openEdit, setEditor, editOptions,
  requestToggle, toggleReason, requestSwitch, counts,
}: {
  kind: CatalogKind;
  contractReady: boolean;
  visibleRows: CatalogRow[];
  query: string;
  editor: EditorState | null;
  setQuery: Dispatch<SetStateAction<string>>;
  typeFilter: string;
  setTypeFilter: Dispatch<SetStateAction<string>>;
  rarityFilter: string;
  setRarityFilter: Dispatch<SetStateAction<string>>;
  selectableFilter: string;
  setSelectableFilter: Dispatch<SetStateAction<string>>;
  identityFilter: IdentityFilter;
  setIdentityFilter: Dispatch<SetStateAction<IdentityFilter>>;
  mediaFilter: "all" | "with-media" | "without-media";
  setMediaFilter: Dispatch<SetStateAction<"all" | "with-media" | "without-media">>;
  catalog: AdminCatalogResponse;
  setEditor: Dispatch<SetStateAction<EditorState | null>>;
  firearms: CatalogFirearmOwner[] | null;
  createReason: string | undefined;
  writePhase: WritePhase;
  storageBlocked: boolean;
  openCreate: (kind: CatalogKind) => void;
  saveEditor: (event?: React.FormEvent<HTMLFormElement>, continueAdd?: boolean) => void;
  requestClose: () => void;
  showDetail: (kind: CatalogKind, id?: string, sourceAction?: "detail-mobile") => void;
  openEdit: (kind: CatalogKind, record: CatalogRow, confirm?: boolean) => void;
  editOptions: EditOptions;
  requestToggle: (kind: CatalogKind, row: CatalogRow, field: "enabled" | "formVisible") => void;
  toggleReason: (row: CatalogRow, field: "enabled" | "formVisible") => string | undefined;
  requestSwitch: (type: "tab" | "game", value: string) => void;
  counts: Record<CatalogKind, number>;
}) {
  const renderCell = (rowKind: CatalogKind, row: CatalogRow, key: string): React.ReactNode => {
    if (key === "media") {
      const mediaId = typeof row.mediaId === "string" && row.mediaId ? row.mediaId : "";
      if (!mediaId) {
        return (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-md border border-dashed border-border/80 bg-muted/20 text-muted-foreground/60 hover:border-primary/50 hover:bg-muted/50 hover:text-foreground"
            disabled={writePhase !== "idle" || Boolean(editor)}
            title="未绑定图片，点击配置"
            aria-label={`绑定图片 ${String(row.name ?? row.code ?? row.id)}`}
            onClick={() => { openEdit(rowKind, row); showDetail(rowKind, row.id); }}
          >
            <ImageIcon className="size-4" />
          </Button>
        );
      }
      return (
        <Button
          type="button"
          variant="outline"
          className="group relative h-9 w-9 overflow-hidden rounded-md p-0 border-border hover:ring-2 hover:ring-primary/40"
          disabled={writePhase !== "idle" || Boolean(editor)}
          aria-label={`查看或更换已绑定图片 ${String(row.code ?? row.id)}`}
          onClick={() => { openEdit(rowKind, row); showDetail(rowKind, row.id); }}
        >
          <img
            src={`/api/v1/supply/media/${mediaId}/content`}
            alt=""
            className="h-full w-full object-contain rounded transition-transform group-hover:scale-105"
            loading="lazy"
            onLoad={event => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
            onError={(event) => {
              event.currentTarget.style.display = "none";
              event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden");
            }}
          />
          <span data-fallback className="hidden absolute inset-0 grid place-items-center bg-muted text-xs text-muted-foreground">图失效</span>
        </Button>
      );
    }
    if (key === "parentPath") return <span className="text-xs">{categoryPath(row.parentId as string | null, catalog?.categories ?? [])}</span>;
    if (key === "categoryPath") return <span className="text-xs">{categoryPath(row.categoryId as string | null, catalog?.categories ?? [])}</span>;
    if (key === "ownerRef") {
      const kind = skinOwnerKind(row as CatalogSkin);
      if (kind === "MELEE_TYPE" && catalog?.game.code === "delta") return <span className="text-xs">近战外观</span>;
      return <div className="space-y-1 text-xs"><p>{kind ? ownerKinds[kind] : "类型待核"}</p><p className="text-muted-foreground">{ownerText((row.ownerRef as CatalogSkin["ownerRef"]) ?? null, catalog?.owners ?? [], firearms)}</p></div>;
    }
    if (key === "kind") return <span className="text-xs">{ownerKinds[row.kind as keyof typeof ownerKinds] ?? "未提供"}</span>;
    if (key === "rarityCode") {
      const rarity = (catalog?.rarities ?? []).find(entry => entry.code === row.rarityCode);
      return <div className="space-y-1 text-xs"><p>{rarity ? (rarity.enabled ? rarity.name : `${rarity.name}（已停用）`) : row.rarityCode ? String(row.rarityCode) : "品质未知"}</p><p className="text-muted-foreground">{skinRarityBasisText(row as CatalogSkin)}</p></div>;
    }
    if (key === "appearance") return <div className="space-y-1 text-xs"><p>{defaultStates[(row.defaultState as keyof typeof defaultStates) ?? "UNKNOWN"]}</p><p className="text-muted-foreground">{row.isCollectible == null ? "典藏待确认" : row.isCollectible ? "典藏" : "非典藏"}</p></div>;
    if (key === "required") return <span className="text-xs">{row.required ? "必填" : "可选"}</span>;
    if (key === "unit") return <span className="text-xs">{row.unit === "PIECE" ? unitText("PIECE", String(row.code)) : UNIT_LABEL[String(row.unit)] ?? "单位未登记"}</span>;
    if (key === "valueKind") return <span className="text-xs">{VALUE_KIND_LABEL[String(row.valueKind)] ?? "类型未登记"}</span>;
    if (key === "expiryKind") return <span className="text-xs">{EXPIRY_KIND_LABEL[String(row.expiryKind)] ?? "类型未登记"}</span>;
    if (key === "quantityScale") return <span className="text-xs">{Number.isInteger(row.quantityScale) ? row.quantityScale === 0 ? "整数（例 1）" : `最多${row.quantityScale}位小数` : "未提供"}</span>;
    const value = row[key];
    if (value === null || value === undefined || value === "") return <span className="text-xs text-muted-foreground">未提供</span>;
    return <span className="text-xs">{String(value)}</span>;
  };
  return (
              <TabsContent key={kind} value={kind} className="space-y-3.5">
                <h4 data-catalog-list-title={kind} tabIndex={-1} className="sr-only">{OBJECT_LABEL[kind]}</h4>
                {(kind === "skins" || kind === "skin-owners") && !contractReady && visibleRows.length > 0 ? (
                  <p className="text-xs text-destructive">皮肤目录资料暂时无法确认，维护暂不可用；请稍后重试或联系管理员。</p>
                ) : null}
                <div className="flex flex-wrap items-end gap-2.5">
                  <div className="w-full sm:w-auto sm:min-w-60">
                    <Field label="搜索物品或皮肤">
                      <Input value={query} disabled={Boolean(editor)} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full text-xs" placeholder="按名称、稳定编码或别名搜索" />
                    </Field>
                  </div>
                  {kind === "skins" ? (
                    <>
                      <div className="w-36"><LabeledSelect label="类型筛选" value={typeFilter} disabled={Boolean(editor)} items={[{ value: "all", label: "全部类型" }, ...Object.entries(ownerKinds).map(([value, label]) => ({ value, label })), { value: "unknown", label: "类型待核" }]} onValueChange={setTypeFilter} /></div>
                      <div className="w-36"><LabeledSelect label="品质筛选" value={rarityFilter} disabled={Boolean(editor)} items={[{ value: "all", label: "全部品质" }, { value: "unknown", label: "品质未知" }, ...catalog.rarities.map(r => ({ value: r.code, label: r.name }))]} onValueChange={setRarityFilter} /></div>
                      <div className="w-36"><LabeledSelect label="可选状态" value={selectableFilter} disabled={Boolean(editor)} items={[{ value: "all", label: "全部状态" }, { value: "selectable", label: "可选择" }, { value: "unselectable", label: "暂不可选择" }]} onValueChange={setSelectableFilter} /></div>
                      <div className="w-36">
                        <LabeledSelect label="身份状态" value={identityFilter} disabled={Boolean(editor)} items={IDENTITY_FILTER_ITEMS.map((entry) => ({ value: entry.value, label: entry.label }))} onValueChange={(value) => setIdentityFilter(value as IdentityFilter)} />
                      </div>
                      <div className="w-32">
                        <LabeledSelect
                          label="图片状态"
                          value={mediaFilter}
                          disabled={Boolean(editor)}
                          items={[
                            { value: "all", label: "全部图片" },
                            { value: "with-media", label: "已绑定图片" },
                            { value: "without-media", label: "未绑定图片" },
                          ]}
                          onValueChange={(value) => setMediaFilter(value as "all" | "with-media" | "without-media")}
                        />
                      </div>
                    </>
                  ) : null}
                  <div className="ml-auto">
                    <Button type="button" size="sm" className="h-9" disabled={Boolean(editor) || writePhase !== "idle" || Boolean(createReason)} title={createReason} onClick={() => openCreate(kind)}>
                      新增{OBJECT_LABEL[kind]}
                    </Button>
                  </div>
                </div>
                {query.trim() ? <p className="text-xs text-muted-foreground">当前仅在已加载列表中过滤；若全库未找到请确认是否已加载完毕。</p> : null}
                <CatalogObjectTable
                  editingId={kind !== "skins" && editor && editor.id && editor.kind === kind ? editor.id : undefined}
                  editingIsNew={Boolean(editor && !editor.id && editor.kind === kind)}
                  editValues={editor && editor.kind === kind ? editor.values : undefined}
                  onEditValue={(key, value) => setEditor(current => (current ? { ...current, values: { ...current.values, [key]: value } } : current))}
                  onSaveRow={() => saveEditor()}
                  onCancelRow={requestClose}
                  onDetailRow={() => { if (editor) showDetail(editor.kind, editor.id); }}
                  pendingWrite={writePhase !== "idle"}
                  showReason={editor?.kind === "skins" || editor?.kind === "skin-owners"}
                  onDetail={(row, sourceAction) => { openEdit(kind, row); showDetail(kind, row.id, sourceAction); }}
                  editOptions={editOptions}
                  kind={kind}
                  retiredCategories={catalog.game.code === "delta"}
                  rows={visibleRows}
                  query={query}
                  filterActive={kind === "skins" && (identityFilter !== "all" || mediaFilter !== "all" || typeFilter !== "all" || rarityFilter !== "all" || selectableFilter !== "all")}
                  busy={writePhase !== "idle" || storageBlocked}
                  contractReady={kind === "skins" || kind === "skin-owners" ? contractReady : true}
                  onEdit={(row) => { openEdit(kind, row); if (kind === "skins") showDetail(kind, row.id); }}
                  onConfirm={kind === "skins" ? (row) => { openEdit(kind, row, true); showDetail(kind, row.id); } : undefined}
                  onToggle={(row, field) => requestToggle(kind, row, field)}
                  toggleReason={kind === "skins" ? toggleReason : undefined}
                  onCreate={() => openCreate(kind)}
                  createReason={createReason}
                  prerequisiteAction={kind === "skins" && catalog.game.code !== "delta" && contractReady && !catalog.categories.length ? { label: "去维护皮肤分类", onClick: () => requestSwitch("tab", "categories") } : undefined}
                  onClearQuery={() => { setQuery(""); setIdentityFilter("all"); setMediaFilter("all"); setTypeFilter("all"); setRarityFilter("all"); setSelectableFilter("all"); }}
                  renderCell={(row, key) => renderCell(kind, row, key)}
                />
                <p className="text-xs text-muted-foreground">当前已加载 {counts[kind]} 条{query.trim() || (kind === "skins" && (identityFilter !== "all" || mediaFilter !== "all" || typeFilter !== "all" || rarityFilter !== "all" || selectableFilter !== "all")) ? `，匹配 ${visibleRows.length} 条` : ""}。计数仅覆盖本次目录读取。</p>
              </TabsContent>
  );
}
