import type { CatalogSkin } from "../../api";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { SupplySelect } from "../../components/supply/supply-select";
import { defaultStates, rarityBases, SKIN_SOURCE_NAME_MAX_LENGTH } from "../catalog-skin-fields";

type Option = { value: string; label: string };
export function SkinMetadataFields({ skin, values, rarities, onChange }: { skin?: CatalogSkin; values: Record<string, string>; rarities: Option[]; onChange: (key: string, value: string) => void }) {
  const select = (key: string, label: string, options: Option[]) => <label className="block space-y-1 text-xs"><span className="text-muted-foreground">{label}</span><SupplySelect label={label} value={values[key] ?? ""} options={options} onValueChange={value => onChange(key, value)} /></label>;
  const input = (key: string, label: string, type = "text") => <label className="block space-y-1 text-xs"><span className="text-muted-foreground">{label}</span><Input type={type} value={values[key] ?? ""} onChange={event => onChange(key, event.target.value)} /></label>;
  const quality = (key: string, value: string) => { onChange("changeRarityEvidence", "true"); onChange(key, value); };
  return <>
    <section className="space-y-3" aria-label="品质与属性">
      <h3 className="text-sm font-semibold">品质与属性</h3>
      <p className="text-xs text-muted-foreground">品质依据与身份核实分开记录。平台参考可用于展示；默认和典藏属性不自动增加押金。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {select("rarityCode", "品质", rarities)}
        <label className="block space-y-1 text-xs"><span className="text-muted-foreground">品质依据</span><SupplySelect label="品质依据" value={values.rarityBasis ?? ""} options={[{ value: "", label: "尚无依据" }, ...Object.entries(rarityBases).map(([value, label]) => ({ value, label }))]} onValueChange={value => quality("rarityBasis", value)} /></label>
        <label className="block space-y-1 text-xs"><span className="text-muted-foreground">品质来源名称</span><Input maxLength={SKIN_SOURCE_NAME_MAX_LENGTH} value={values.raritySourceName ?? ""} onChange={event => quality("raritySourceName", event.target.value)} /></label>
        <label className="block space-y-1 text-xs"><span className="text-muted-foreground">品质核对日期</span><Input type="date" value={values.rarityObservedAt ?? ""} onChange={event => quality("rarityObservedAt", event.target.value)} /></label>
      </div>
      <label className="block space-y-1 text-xs"><span className="text-muted-foreground">品质证据链接（每行一条）</span><Textarea value={values.rarityEvidenceUrls ?? ""} onChange={event => quality("rarityEvidenceUrls", event.target.value)} /></label>
      <label className="block space-y-1 text-xs"><span className="text-muted-foreground">品质依据说明</span><Textarea value={values.rarityNote ?? ""} onChange={event => quality("rarityNote", event.target.value)} /></label>
      {skin?.rarityCode && !skin.rarityEvidence ? <p className="text-xs text-muted-foreground">现有品质没有独立来源记录；无关编辑保留原值，重新标注时须补充依据。</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {select("isCollectible", "典藏属性", [{ value: "unknown", label: "待确认" }, { value: "true", label: "典藏" }, { value: "false", label: "非典藏" }])}
        {select("defaultState", "默认属性", Object.entries(defaultStates).map(([value, label]) => ({ value, label })))}
      </div>
    </section>
    <section className="space-y-3 border-t border-border pt-4" aria-label="图片来源记录">
      <h3 className="text-sm font-semibold">图片来源记录</h3>
      <p className="text-xs text-muted-foreground">来源地址用于追溯，页面图片仍由已审核的平台素材提供。</p>
      {!skin || !values.mediaId ? <p className="text-xs text-muted-foreground">请先保存词条并绑定平台图片，再记录图片来源；解除绑定会清空旧图来源。</p> : null}
      {skin?.mediaSource ? <p className="break-words text-xs">当前：{skin.mediaSource.sourceName} · <a className="underline underline-offset-4" href={skin.mediaSource.url} target="_blank" rel="noreferrer">查看来源</a></p> : <p className="text-xs text-muted-foreground">来源记录尚未提供</p>}
      {select("changeMediaSource", "更新图片来源", [{ value: "false", label: "保留当前记录" }, { value: "true", label: "填写本次来源" }])}
      {values.changeMediaSource === "true" ? <div className="space-y-3">
        {select("mediaSourceKind", "图片构图", [{ value: "PORTRAIT_CARD", label: "统一竖卡" }, { value: "MODEL_IMAGE", label: "横向模型图" }, { value: "PROMO_POSTER", label: "宣传海报" }])}
        <label className="block space-y-1 text-xs"><span className="text-muted-foreground">图片来源名称</span><Input maxLength={SKIN_SOURCE_NAME_MAX_LENGTH} value={values.mediaSourceName ?? ""} onChange={event => onChange("mediaSourceName", event.target.value)} /></label>
        {input("mediaSourceUrl", "图片来源地址", "url")}
      </div> : null}
    </section>
  </>;
}
