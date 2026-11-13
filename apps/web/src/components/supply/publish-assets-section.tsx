"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Box, UserRound, Info, X, Trash2, Check } from "lucide-react";
import { Input, IntegerStepper, FormSelect, DateTimePicker } from "../ui/form-controls";
import { CatalogItemArt } from "./catalog-item-art";
import { SkinMediaThumb, SkinMediaPreview, SkinMetadata } from "./skin-media-thumb";
import { InventoryIcon, FieldHelp, SectionCard, FieldError } from "./publish-dialogs";
import { ManagedNoticeText } from "@/components/content/managed-notice";
import { canonicalResourceCode, resourceUnitLabel, isSkinOwnerKind } from "../../lib/listing-filters";
import { beijingInputFromIso } from "../../lib/publish-derive";
import { inventoryPriceHint } from "../../lib/supply-client";
import {
  retiredInsuranceCode,
  INSURANCE_EXPERIENCE_CARD,
  ammoQuantityText,
  formatUnitPrice,
  fieldErrorText,
} from "./publish-form-helpers";
import type {
  DraftInput,
  PublishingCatalog,
  OwnerIncomePreview,
  SkinOwnerKind,
} from "../../lib/supply-types";
import type { SkinQuery } from "./publish-form-types";

export interface PublishAssetsSectionProps {
  hasError: boolean;
  ownerIncomePreviewPending: boolean;
  resourcePreviewState: string | null;
  resourceRows: any[];
  draft: DraftInput;
  ownerPreview: OwnerIncomePreview | null;
  ownerPreviewStale: boolean;
  formDisabled: boolean;
  is3x3SafeBoxSelected: boolean;
  changeInventory: (itemId: string, quantity: string) => void;
  setPendingResourceInputs: Dispatch<SetStateAction<Record<string, string>>>;
  setDraft: (next: DraftInput | ((previous: DraftInput) => DraftInput)) => void;
  missingResourceRows: any[];
  inventoryFieldError: any;
  captureContext: () => any;
  identityStatusRef: MutableRefObject<string>;
  currentContext: (context: any) => boolean;
  requireAmmoReview: () => void;

  skinTypes: Array<{ id: string; name: string }>;
  selectedSkinCountForCategory: (catId: string) => number;
  activeSkinCategory: string;
  clearSkinSearchTimer: () => void;
  setSkinCategory: (id: string) => void;
  setSkinOwner: (id: string) => void;
  loadSkinPage: (query: SkinQuery, append: boolean) => Promise<void>;
  skinFilters: SkinQuery;
  catalog: PublishingCatalog | null;
  skinQuery: string;
  setSkinQuery: (query: string) => void;
  loadingCatalog: boolean;
  gameId: string;
  skinSearchTimerRef: MutableRefObject<number | null>;
  skinFiltersRef: MutableRefObject<SkinQuery>;
  skinOwners: Array<{ id: string; name: string }>;
  skinOwner: string;
  skinRarity: string;
  setSkinRarity: (rarity: string) => void;
  skinName: (id: string) => string;
  skinPagePending: boolean;
  skinPageFailed: "replace" | "append" | null;
  skinQueryRef: MutableRefObject<{ query: SkinQuery }>;
  activeSkinKind?: SkinOwnerKind | null;
  visibleSkinRows: any[];

  selectedEntitlement: (id: string) => any;
  changeEntitlement: (id: string, checked: boolean, value?: string, expiresAt?: string, expiryKind?: "PERMANENT" | "TIMED") => void;
  fieldError: (field: string) => string | undefined;
}

export function PublishAssetsSection({
  hasError,
  ownerIncomePreviewPending,
  resourcePreviewState,
  resourceRows,
  draft,
  ownerPreview,
  ownerPreviewStale,
  formDisabled,
  is3x3SafeBoxSelected,
  changeInventory,
  setPendingResourceInputs,
  setDraft,
  missingResourceRows,
  inventoryFieldError,
  captureContext,
  identityStatusRef,
  currentContext,
  requireAmmoReview,

  skinTypes,
  selectedSkinCountForCategory,
  activeSkinCategory,
  clearSkinSearchTimer,
  setSkinCategory,
  setSkinOwner,
  loadSkinPage,
  skinFilters,
  catalog,
  skinQuery,
  setSkinQuery,
  loadingCatalog,
  gameId,
  skinSearchTimerRef,
  skinFiltersRef,
  skinOwners,
  skinOwner,
  skinRarity,
  setSkinRarity,
  skinName,
  skinPagePending,
  skinPageFailed,
  skinQueryRef,
  activeSkinKind,
  visibleSkinRows,

  selectedEntitlement,
  changeEntitlement,
  fieldError,
}: PublishAssetsSectionProps) {
  return (
    <SectionCard id="assets" title="物资与皮肤" hasError={hasError}>
      <div className="supply-subsection">
        <div className="publish-assets-heading">
          <h3><Box size={20} aria-hidden="true" />物品资源</h3>
          <FieldHelp label="物品资源"><ManagedNoticeText contentKey="placement:PUBLISH_RESOURCES" fallback="物资默认按 0 申报，请将实际拥有的可消耗物资改为真实整数数量；单价按平台当前规则展示。" /></FieldHelp>
          <span className="publish-preview-updating" data-updating={ownerIncomePreviewPending} aria-hidden="true">更新中</span>
        </div>
        {resourcePreviewState ? <p className="publish-resource-read-state publish-resource-preview-status" role="status" aria-live="polite" aria-busy={ownerIncomePreviewPending}><Info size={16} aria-hidden="true" />{resourcePreviewState}</p> : null}
        {resourceRows.length ? <div className="supply-resource-grid" role="list" aria-label="资源库存" aria-busy={ownerIncomePreviewPending}>{resourceRows.map((item) => {
          const itemCode=item.code, key=item.itemId??itemCode!;
          const insuranceExperience=canonicalResourceCode(itemCode)==="df_billable_top_insure_card"||itemCode==="legacy_insurance_day";
          const itemName=canonicalResourceCode(itemCode)==="df_billable_coffee"?"咖啡豆":insuranceExperience?INSURANCE_EXPERIENCE_CARD:item.name;
          const retiredInsurance=retiredInsuranceCode(itemCode);
          const quantity=draft.inventory.find((row: { itemId: string }) => row.itemId === item.itemId)?.quantity ?? item.quantity ?? "";
          const grouped=canonicalResourceCode(itemCode)==="df_billable_level6_bullet";
          const valid=/^(0|[1-9]\d{0,23})$/.test(quantity), remainder=grouped&&valid?BigInt(quantity)%60n:0n;
          const inputValue=grouped&&valid?(BigInt(quantity)/60n).toString():quantity;
          const inputUnit=grouped?"组":resourceUnitLabel(item.unit??"",itemCode);
          const line=item.itemId&&ownerPreview?.lines?ownerPreview.lines.find((row: { itemId: string }) => row.itemId === item.itemId):null;
          const unpriced = item.priced === false || (retiredInsurance && item.priced !== null);
          const unknownPrice = item.priced === null;
          const priceHint = item.itemId ? inventoryPriceHint(unpriced ? { ...item, priced: false } : item) : null;
          const help=grouped?"六级子弹按组填写，每组60发；保存时只换算一次。":insuranceExperience?`按天填写${INSURANCE_EXPERIENCE_CARD}的可用天数。`:null;
          const durabilityRequired = ["df_billable_level6_armor", "df_billable_level6_helmet"].includes(canonicalResourceCode(itemCode) ?? "");
          const fillState = quantity === "" ? "empty" : valid && BigInt(quantity) > 0n ? "filled" : quantity === "0" ? "zero" : "empty";
          return <article className="supply-resource-card" key={key} role="listitem" data-resource-code={itemCode??undefined} data-fill-state={fillState}>
            <div className="supply-resource-card-head">
              <span className="supply-resource-art"><CatalogItemArt mediaId={"mediaId" in item ? item.mediaId : null}><InventoryIcon code={itemCode} /></CatalogItemArt></span>
              <div className="supply-resource-info">
                <div className="supply-resource-name"><label htmlFor={`quantity-${key}`}>{itemName}</label>{help?<FieldHelp label={itemName}>{help}</FieldHelp>:null}</div>
                <div className="publish-owner-rate"><span>单价</span><strong>{unknownPrice && item.itemId ? "待核实" : line?.ownerUnitAmount ? `${formatUnitPrice(line.ownerUnitAmount.amount)} / ${inputUnit}` : !item.itemId || unpriced ? "待配置" : ownerIncomePreviewPending ? "读取中…" : "暂未取得"}</strong>{line ? <FieldHelp label={`${itemName}单价`}>单价按分显示，实际收入以核价和结算为准。</FieldHelp> : null}</div>
              </div>
              {item.required?<span className="supply-resource-required">必填</span>:null}
            </div>
            {!item.itemId ? <small className="publish-resource-state">此项暂存本页。填写后需等待目录配置，整份资料才能保存或核价。</small> : null}
            <div className="publish-resource-input" role={grouped ? "group" : undefined} aria-label={grouped ? `${itemName}数量，单位为组` : undefined} aria-describedby={grouped ? `measure-${key}` : undefined} onBlur={grouped ? event => {
              if (formDisabled || event.currentTarget.contains(event.relatedTarget)) return;
              const editor = event.currentTarget, context = captureContext();
              requestAnimationFrame(() => {
                if (currentContext(context) && identityStatusRef.current === "confirmed" && !editor.contains(document.activeElement)
                  && !document.querySelector(':is([role="dialog"], [role="alertdialog"]):is([data-open], [data-state="open"])')) requireAmmoReview();
              });
            } : undefined}>
              <div className="publish-resource-spec-bar">
                {grouped ? <p id={`measure-${key}`} className="publish-ammo-unit">按组填写 · 1组 = 60发</p> : null}
                {durabilityRequired ? <p className="publish-resource-durability"><Info size={14} aria-hidden="true" />磨损不超过5耐久</p> : null}
              </div>
              {insuranceExperience && is3x3SafeBoxSelected ? (
                <TooltipPrimitive.Provider delayDuration={180}>
                  <TooltipPrimitive.Root>
                    <TooltipPrimitive.Trigger asChild>
                      <span className="publish-resource-disabled-wrapper" tabIndex={0}>
                        <IntegerStepper id={`quantity-${key}`} label={`${itemName}数量`} value={inputValue} unit={inputUnit} max="999999999999999999999999" disabled={true} invalid={quantity!==""&&!valid} onChange={()=>{}} />
                      </span>
                    </TooltipPrimitive.Trigger>
                    <TooltipPrimitive.Portal>
                      <TooltipPrimitive.Content sideOffset={6} className="app-tooltip-content" side="top">
                        已选择顶级安全箱(3*3)，不可与九格保险体验卡同时填写（只能二选一）
                      </TooltipPrimitive.Content>
                    </TooltipPrimitive.Portal>
                  </TooltipPrimitive.Root>
                </TooltipPrimitive.Provider>
              ) : (
                <IntegerStepper id={`quantity-${key}`} label={`${itemName}数量`} value={inputValue} unit={inputUnit} max={grouped?((999999999999999999999999n-remainder)/60n).toString():"999999999999999999999999"} disabled={formDisabled||retiredInsurance} invalid={quantity!==""&&!valid} describedBy={grouped ? `measure-${key}` : undefined} onChange={raw=>{
                  const base=raw===""?"":grouped?(BigInt(raw)*60n+remainder).toString():raw;
                  if(item.itemId)changeInventory(item.itemId,base);else setPendingResourceInputs(previous=>({...previous,[itemCode!]:base}));
                }} />
              )}
              {!(insuranceExperience && is3x3SafeBoxSelected) && !retiredInsurance ? (
                <div className="publish-quick-chips publish-resource-quick-chips">
                  <button type="button" className="publish-quick-chip" data-active={quantity === "0" ? "true" : "false"} disabled={formDisabled} onClick={() => {
                    if (item.itemId) changeInventory(item.itemId, "0");
                    else setPendingResourceInputs((previous) => ({ ...previous, [itemCode!]: "0" }));
                  }}>置0</button>
                  {([1n, 5n] as const).map((delta) => (
                    <button key={delta.toString()} type="button" className="publish-quick-chip" disabled={formDisabled} onClick={() => {
                      const currentGroups = valid && quantity !== "" ? (grouped ? BigInt(quantity) / 60n : BigInt(quantity)) : 0n;
                      const maxGroups = grouped ? (999999999999999999999999n - remainder) / 60n : 999999999999999999999999n;
                      const nextGroups = currentGroups + delta > maxGroups ? maxGroups : currentGroups + delta;
                      const base = grouped ? (nextGroups * 60n + remainder).toString() : nextGroups.toString();
                      if (item.itemId) changeInventory(item.itemId, base);
                      else setPendingResourceInputs((previous) => ({ ...previous, [itemCode!]: base }));
                    }}>{`+${delta.toString()}`}</button>
                  ))}
                </div>
              ) : null}
              {grouped && valid ? <p className="publish-ammo-conversion" aria-live="polite">{ammoQuantityText(quantity)}</p> : null}
            </div>
            {insuranceExperience && is3x3SafeBoxSelected ? <small className="publish-resource-conflict-hint">已选择顶级安全箱(3*3)，不可与九格保险体验卡同时填写</small> : null}
            {retiredInsurance?<small className="publish-resource-state">单位需核对：历史按张申报保留原数量和停用状态，新申报请在上方按天项目填写。</small>:null}
            <div className="publish-resource-subtotal"><span>{ownerPreviewStale&&line?.ownerAmount?"上次预估":"本项预估"}</span><output aria-live="off">{insuranceExperience&&is3x3SafeBoxSelected?"互斥停用":quantity===""?"未填写":!item.itemId?"待资源配置":line?.ownerAmount?`¥ ${line.ownerAmount.amount}`:unpriced||(item.itemId&&ownerPreview&&(!line||!line.ownerUnitAmount))?"价目待配置":unknownPrice?"价目待核实":ownerIncomePreviewPending?"计算中…":"预估暂不可用"}</output></div>
            {!item.itemId ? <small className="publish-resource-state">目录待配置 · 数量暂存本页</small> : null}
            {quantity!==""&&!valid?<FieldError text="请填写非负整数，或留空。"/>:null}
            {priceHint ? <small className="publish-resource-state">{priceHint}</small> : null}
            {unpriced ? <button type="button" className="button quiet" disabled={formDisabled} onClick={()=>setDraft((previous: DraftInput)=>({...previous,inventory:previous.inventory.filter((row: { itemId: string })=>row.itemId!==item.itemId)}))}>不纳入本次申报</button> : null}
          </article>;
        })}</div>:null}
        {missingResourceRows.length?<p className="publish-resource-state">{missingResourceRows.map(item=>item.name).join("、")}的数量暂存本页，配置完成后可保存。</p>:null}
        <FieldError text={inventoryFieldError ? fieldErrorText("inventory", inventoryFieldError.code) : undefined} />
      </div>
      <div className="supply-subsection">
        <div className="publish-assets-heading"><h3><UserRound size={20} aria-hidden="true" />皮肤</h3><FieldHelp label="皮肤">按名称或分类查找，并勾选账号拥有的皮肤。</FieldHelp></div>
        <div className="skin-picker">
          <div className="skin-category-nav" role="group" aria-label="皮肤分类">
            {skinTypes.map((category) => {
              const selectedInCat = selectedSkinCountForCategory(category.id);
              return (
                <button key={category.id} type="button" className={`skin-category-btn${activeSkinCategory === category.id ? " is-active" : ""}`} aria-pressed={activeSkinCategory === category.id} disabled={formDisabled} onClick={() => { clearSkinSearchTimer(); setSkinCategory(category.id); setSkinOwner(""); void loadSkinPage({ ...skinFilters, categoryId: catalog?.skinFilters ? undefined : category.id, ownerKind: catalog?.skinFilters && isSkinOwnerKind(category.id) ? category.id : undefined, ownerId: "" }, false); }}>
                  {category.name}
                  {selectedInCat > 0 ? <span className="skin-category-badge">{selectedInCat}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="skin-search-row">
            <div className="skin-search-control">
              <div className="skin-search-input-wrap">
                <Input
                  className="skin-search-input"
                  type="search"
                  maxLength={80}
                  aria-label="搜索皮肤或所属名称"
                  enterKeyHint="search"
                  value={skinQuery}
                  disabled={formDisabled}
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    setSkinQuery(nextQuery);
                    clearSkinSearchTimer();
                    if (!formDisabled && !loadingCatalog && gameId) {
                      skinSearchTimerRef.current = window.setTimeout(() => {
                        skinSearchTimerRef.current = null;
                        void loadSkinPage({ ...skinFiltersRef.current, q: nextQuery.trim() }, false);
                      }, 300);
                    }
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadSkinPage(skinFilters, false); } }}
                  placeholder="搜索皮肤或所属名称"
                />
                {skinQuery ? (
                  <button
                    type="button"
                    className="skin-search-clear"
                    aria-label="清空搜索关键词"
                    disabled={formDisabled}
                    onClick={() => {
                      clearSkinSearchTimer();
                      setSkinQuery("");
                      void loadSkinPage({ ...skinFilters, q: "" }, false);
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <button type="button" className="button secondary" disabled={formDisabled || loadingCatalog} onClick={() => void loadSkinPage(skinFilters, false)}>查找</button>
            </div>
            {skinOwners.length ? <FormSelect label="皮肤所属" value={skinOwner || "__all__"} disabled={formDisabled} placeholder="全部所属" popupClassName="publish-select-popup" options={[{ value: "__all__", label: "全部所属" }, ...skinOwners.map((owner) => ({ value: owner.id, label: owner.name }))]} onChange={(value) => { const ownerId = value === "__all__" ? "" : value; setSkinOwner(ownerId); void loadSkinPage({ ...skinFilters, ownerId }, false); }} /> : null}
            {catalog?.rarities.length ? <FormSelect label="皮肤品质"
              value={skinRarity || "__all__"}
              disabled={formDisabled}
              placeholder="全部品质"
              popupClassName="publish-select-popup"
              options={[{ value: "__all__", label: "全部品质" }, ...catalog.rarities.map((rarity: { code: string; name: string }) => ({ value: rarity.code, label: rarity.name }))]}
              onChange={(value) => { const rarityCode = value === "__all__" ? "" : value; setSkinRarity(rarityCode); void loadSkinPage({ ...skinFilters, rarityCode }, false); }}
              className="skin-rarity-select"
            /> : null}
          </div>
          {draft.skins.length > 0 ? (
            <div className="skin-selected-box">
              <div className="skin-selected-header">
                <span>已选皮肤（{draft.skins.length}）</span>
                <button type="button" className="button quiet" disabled={formDisabled} onClick={() => setDraft((previous: DraftInput) => ({ ...previous, skins: [] }))}>清空已选</button>
              </div>
              <div className="supply-selected-chips" aria-label="已选皮肤">
                {draft.skins.map((id: string) => (
                  <span key={id} className="supply-chip" data-skin-id={id}>
                    {skinName(id)}
                    <button type="button" className="supply-chip-remove" aria-label={`移除 ${skinName(id)}`} disabled={formDisabled} onClick={() => setDraft((previous: DraftInput) => ({ ...previous, skins: previous.skins.filter((skinId: string) => skinId !== id) }))}>
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {skinPagePending || (!catalog && loadingCatalog) ? <p className="supply-muted" role="status">正在读取皮肤目录，已选皮肤会保留…</p> : null}
          {skinPageFailed ? <div className="skin-picker-error" role="alert"><p>{skinPageFailed === "append" ? "更多皮肤加载失败，已加载内容与已选皮肤会保留。" : "皮肤目录加载失败，已选皮肤会保留。"}</p><button type="button" className="button secondary" disabled={formDisabled || loadingCatalog} onClick={() => void loadSkinPage({ ...skinQueryRef.current.query, ...(skinPageFailed === "append" ? { cursor: catalog?.nextCursor ?? undefined } : {}) }, skinPageFailed === "append")}>重试皮肤目录</button></div> : null}
          {!skinPagePending && skinPageFailed !== "replace" ? (() => {
            const isAgentCategory = activeSkinKind === "AGENT" || skinTypes.find((c) => c.id === activeSkinCategory)?.name?.includes("干员");
            return (
              <div className="skin-choices-grid" aria-label="可选皮肤" data-orientation={isAgentCategory ? "vertical" : "horizontal"}>
                {visibleSkinRows.map((skin) => {
                  const isSelected = draft.skins.includes(skin.id);
                  const isAgentSkin = skin.ownerKind === "AGENT" || (!skin.ownerKind && isAgentCategory);
                  const orientation = isAgentSkin ? "vertical" : "horizontal";
                  return (
                    <article key={skin.id} className={`skin-card${isSelected ? " is-selected" : ""}`} data-skin-id={skin.id} data-owner-kind={skin.ownerKind ?? "UNKNOWN"} data-orientation={orientation}>
                      <label className="skin-card-choice">
                        <div className={`skin-card-thumb-wrap skin-card-thumb-wrap--${orientation}`}>
                          <SkinMediaThumb mediaId={skin.mediaId} ownerKind={skin.ownerKind} />
                          {skin.rarityName?.trim() ? (
                            <span className="skin-card-tag">{skin.rarityName.trim()}</span>
                          ) : null}
                          <span className="skin-card-check" aria-hidden="true"><Check size={12} /></span>
                        </div>
                        <span className="skin-card-copy">
                          <span className="skin-card-name" title={skin.name}>{skin.name}</span>
                          <span className="sr-only"><SkinMetadata skin={skin} className="skin-card-rarity" /></span>
                        </span>
                        <input type="checkbox" checked={isSelected} aria-label={`选择 ${skin.name}`} disabled={formDisabled} onChange={(event) => setDraft((previous: DraftInput) => ({
                          ...previous,
                          skins: event.target.checked ? [...new Set([...previous.skins, skin.id])] : previous.skins.filter((id: string) => id !== skin.id),
                        }))} />
                      </label>
                      <span className="sr-only" aria-hidden="true">
                        <SkinMediaPreview skin={skin} triggerClassName="skin-card-preview"><span>放大</span></SkinMediaPreview>
                      </span>
                    </article>
                  );
                })}
                {catalog && visibleSkinRows.length === 0 ? <p className="skin-picker-empty">没有匹配的皮肤，可更换分类或减少查找条件；已选皮肤会保留。</p> : null}
                {catalog?.nextCursor && !skinPagePending && !skinPageFailed ? (
                  <div className="skin-load-more-wrap">
                    <button
                      type="button"
                      className="button secondary skin-load-more"
                      disabled={formDisabled || loadingCatalog}
                      onClick={() => void loadSkinPage({ ...skinQueryRef.current.query, cursor: catalog.nextCursor ?? undefined }, true)}
                    >
                      {loadingCatalog ? "正在读取…" : "加载更多皮肤"}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })() : null}
        </div>
      </div>
      {catalog?.entitlements.length ? <div className="supply-subsection">
        <h3>权益及有效期</h3>
        <p className="supply-muted">定时权益必须填写到期时间；未知时保持“未知”，不默认永久有效。</p>
        <div className="supply-entitlement-list">{catalog.entitlements.map((item: any) => { const selected = selectedEntitlement(item.id); const numeric = item.valueKind !== "FLAG"; const valueLabel = item.valueKind === "LEVEL" ? "等级" : item.valueKind === "CAPACITY" ? "容量" : "是否拥有"; return <div key={item.id} className="supply-entitlement"><label className="supply-choice"><input type="checkbox" checked={Boolean(selected)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, event.target.checked, numeric ? "" : undefined, undefined, item.expiryKind)} /><span>{item.name}</span><small>{valueLabel}{item.expiryKind === "TIMED" ? " · 定时权益" : " · 长期权益"}</small></label>{selected && numeric ? <label>{valueLabel}<Input inputMode="numeric" value={selected.value === null ? "" : String(selected.value)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, true, event.target.value, selected.expiresAt ?? undefined, item.expiryKind)} placeholder="填写数值" /></label> : null}{selected && item.expiryKind === "TIMED" ? <label>有效期至<DateTimePicker label={`${item.name}有效期至`} value={beijingInputFromIso(selected.expiresAt)} disabled={formDisabled} onChange={(value) => changeEntitlement(item.id, true, numeric ? String(selected.value ?? "") : undefined, value, item.expiryKind)} /> <small>{selected.expiryKnowledge === "UNKNOWN" ? "未知到期时间不能核价。" : "按北京时间填写。"}</small></label> : null}</div>; })}</div>
        <FieldError text={fieldError("entitlements")} />
      </div> : null}
    </SectionCard>
  );
}
