import { Search } from "lucide-react";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { ContentField, ContentSelect, ContentText } from "./content-resource-fields";
import { ContentKeywordChips } from "./content-keyword-chips";
import { RESOURCE_CATEGORY_LABEL } from "./content-resources-model";

type SettingsModel = {
  summary: string;
  category: string;
  audience: ("renter" | "owner" | "all")[];
  keywords: string[];
  related: string[];
  contactCta: boolean;
};

export function ContentResourceSettings({
  kind, model, patch, readOnly, inHelpWorkspace, relatedCandidates, relatedQuery, setRelatedQuery, matchedRelated,
}: {
  kind: "guide" | "notice";
  model: SettingsModel;
  patch: (fields: Partial<SettingsModel>) => void;
  readOnly: boolean;
  inHelpWorkspace: boolean;
  relatedCandidates: readonly { slug: string; title: string }[];
  relatedQuery: string;
  setRelatedQuery: (value: string) => void;
  matchedRelated: readonly { slug: string; title: string }[];
}) {
  return (
    <>{kind === "guide" ? <fieldset disabled={readOnly} className="content-settings-panel">
      <div className="content-settings-item">
        <ContentText label="摘要" value={model.summary} onChange={summary => patch({ summary })} max={500} multiline />
        <p className="content-settings-help">在列表和搜索结果中展示的一句话简介，最多 500 字。</p>
      </div>
      {!inHelpWorkspace ? <div className="content-settings-item">
        <ContentField label="所属分类" hint="决定文章在帮助中心的归类。"><ContentSelect ariaLabel="所属分类" value={model.category} onChange={category => patch({ category })} disabled={readOnly} options={Object.entries(RESOURCE_CATEGORY_LABEL).map(([value, label]) => ({ value, label }))} /></ContentField>
      </div> : null}
      <div className="content-settings-item">
        <span className="content-settings-label" id="content-audience-label">适用对象</span>
        <div className="content-settings-audience" role="group" aria-labelledby="content-audience-label">{(["all", "renter", "owner"] as const).map((value, index) => <label key={value} className="content-check"><Checkbox disabled={readOnly} id={`audience-${value}`} checked={model.audience.includes(value)} onCheckedChange={checked => patch({ audience: checked === true ? [...model.audience, value] : model.audience.filter(item => item !== value) })} />{["所有用户", "租客", "号主"][index]}</label>)}</div>
        <p className="content-settings-help">在帮助页标明适用对象；此设置不限制文章访问。</p>
      </div>
      <div className="content-settings-item">
        <ContentField label="搜索关键词" hint="用于帮助中心搜索，每个最多 100 字。"><ContentKeywordChips value={model.keywords} onChange={keywords => patch({ keywords })} disabled={readOnly} max={30} maxLength={100} /></ContentField>
      </div>
      <div className="content-settings-item">
        <div className="content-related-heading"><span className="content-settings-label" id="help-related-label">相关阅读</span>{inHelpWorkspace ? <span className="content-settings-help">已选 {model.related.length} 篇</span> : null}</div>
        <p className="content-settings-help">所选文章会显示在正文末尾。</p>
        {inHelpWorkspace && relatedCandidates.length ? <div className="help-related-search"><Search size={15} aria-hidden="true" /><Input aria-label="搜索相关阅读" type="search" placeholder="搜索文章标题" value={relatedQuery} onChange={event => setRelatedQuery(event.target.value)} /></div> : null}
        <div className="content-related-list" role="group" aria-labelledby="help-related-label">
          {matchedRelated.map(option => <label key={option.slug} className="content-related-row">
            <Checkbox disabled={readOnly} id={`related-${option.slug}`} checked={model.related.includes(option.slug)} onCheckedChange={checked => patch({ related: checked === true ? [...model.related, option.slug] : model.related.filter(item => item !== option.slug) })} />
            <span className="content-related-title">{option.title}</span>
          </label>)}
          {!matchedRelated.length ? <span className="content-related-empty">{relatedCandidates.length ? "未找到匹配的文章。" : "有其他文章后即可添加相关阅读。"}</span> : null}
        </div>
      </div>
      <div className="content-settings-item">
        <label className="content-check"><Checkbox disabled={readOnly} id="guide-contact-cta" checked={model.contactCta} onCheckedChange={checked => patch({ contactCta: checked === true })} />显示联系客服入口</label>
        <p className="content-settings-help">开启后在文章末尾显示联系客服入口，方便用户求助。</p>
      </div>
    </fieldset> : <p className="content-settings-note">这段说明用于固定业务位置；报价、资格和订单条款仍由对应业务模块维护。</p>}</>
  );
}
