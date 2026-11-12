import { useEffect, useRef, useState } from "react";
import { validateResource, type FooterResource } from "@zzsh/content";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ContentMediaField, ContentText } from "./content-resource-fields";
import { contentMediaChoiceIssue } from "./content-media-editor";
import type { ContentEditorProps } from "./content-resource-editor";
import type { ResourceVersion } from "./content-resources-model";

export function ContentFooterEditor(props: ContentEditorProps) {
  const initial = props.detail.draft?.payload ?? props.detail.published?.payload ?? props.detail.baseline ?? props.detail.current.payload ?? props.detail.editorSource?.version.payload;
  if (!initial || initial.kind !== "footer") return <StatusMessage error="未能读取页脚配置，请返回列表重试。" />;
  return <FooterEditor {...props} initial={initial} />;
}

function FooterEditor({ detail, initial, canEdit, canPublish, canUpload, canReview, locked, busy, pending, operationError, success, onWrite, onClose, onRecover, onDirtyChange }: ContentEditorProps & { initial: FooterResource }) {
  const [model, setModel] = useState(initial), [restore, setRestore] = useState<ResourceVersion | null>(null), [withdraw, setWithdraw] = useState(false);
  const headingRef = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(model) !== JSON.stringify(initial);
  useEffect(() => { onDirtyChange(dirty || locked); }, [dirty, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  let invalid = "";
  try { validateResource(detail.key, model); } catch (error) { invalid = error instanceof Error ? error.message : "请检查页脚配置。"; }
  const patch = (value: Partial<FooterResource>) => setModel(current => ({ ...current, ...value }));
  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <DialogContent size="lg" initialFocus={headingRef} className="content-picture-picker-dialog" showCloseButton={!locked} closeLabel="关闭页脚配置">
      <DialogHeader ref={headingRef} tabIndex={-1} className="outline-none">
        <DialogTitle>{canEdit ? "编辑网站页脚" : "网站页脚"}</DialogTitle>
        <DialogDescription>保存为草稿，发布后用户站才会更新。平台动态、协议和客服入口固定保留。</DialogDescription>
      </DialogHeader>
      <div className="content-picture-picker-body space-y-5">
        <p className="text-sm text-muted-foreground">{detail.published ? `线上 v${detail.published.sequence}` : detail.current.state === "withdrawn" ? "线上已撤回" : "当前使用内置配置"}{detail.draft ? ` · 草稿 v${detail.draft.sequence} 未发布` : ""}</p>
        <StatusMessage error={operationError || invalid} success={success} />
        <fieldset disabled={!canEdit || locked} className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <ContentText label="版权主体（留空隐藏）" value={model.copyright} max={120} onChange={copyright => patch({ copyright })} />
            <ContentText label="ICP备案号（留空隐藏）" value={model.icp} max={40} onChange={icp => patch({ icp })} />
            <ContentText label="公安备案地区（如：浙）" value={model.policeRegion} max={6} onChange={policeRegion => patch({ policeRegion })} />
            <ContentText label="公安备案 14 位编号" value={model.policeCode} max={14} onChange={policeCode => patch({ policeCode })} />
            <ContentText label="营业执照链接（可选）" value={model.licenseUrl ?? ""} max={500} onChange={licenseUrl => patch({ licenseUrl: licenseUrl || null })} />
          </div>
          <p className="text-sm text-muted-foreground">链接使用站内路径或 HTTPS 地址。备案链接由系统指向官方站点；公安地址由编号生成。</p>
          {(["help", "support"] as const).map(group => <div key={group} className="space-y-3"><h4 className="text-sm font-semibold">{group === "help" ? "使用帮助" : "服务支持"}</h4>{model[group].map((link, index) => <div key={index} className="grid items-end gap-3 md:grid-cols-[1fr_2fr_auto]"><ContentText label={`链接 ${index + 1} 文字`} value={link.label} max={40} onChange={label => patch({ [group]: model[group].map((row, i) => i === index ? { ...row, label } : row) })} /><ContentText label={`链接 ${index + 1} 地址`} value={link.href} max={500} onChange={href => patch({ [group]: model[group].map((row, i) => i === index ? { ...row, href } : row) })} /><Button type="button" variant="ghost" onClick={() => patch({ [group]: model[group].filter((_, i) => i !== index) })}>移除</Button></div>)}<Button type="button" size="sm" variant="secondary" disabled={model[group].length >= 8} onClick={() => patch({ [group]: [...model[group], { label: "", href: "" }] })}>添加链接</Button></div>)}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={model.complaint} onChange={event => patch({ complaint: event.target.checked })} />显示投诉建议入口</label>
          <div className="space-y-4"><h4 className="text-sm font-semibold">社交渠道</h4><p className="text-sm text-muted-foreground">只显示已配置的渠道；每项至少填写链接或选择二维码。二维码须为已审核的公开素材。</p>{model.socials.map((social, index) => <div key={index} className="space-y-3 rounded-lg border border-border p-4"><div className="grid gap-4 md:grid-cols-2"><ContentText label={`渠道 ${index + 1} 名称`} value={social.label} max={40} onChange={label => patch({ socials: model.socials.map((row, i) => i === index ? { ...row, label } : row) })} /><ContentText label={`渠道 ${index + 1} 链接（可选）`} value={social.href ?? ""} max={500} onChange={href => patch({ socials: model.socials.map((row, i) => i === index ? { ...row, href: href || null } : row) })} /></div><ContentMediaField label="二维码（可选）" value={social.qrMediaId} onChange={qrMediaId => patch({ socials: model.socials.map((row, i) => i === index ? { ...row, qrMediaId } : row) })} hint="至少 256 × 256，接近 1:1；保留完整白边。" disabled={!canEdit || locked} canUpload={canUpload} canReview={canReview} definition={detail.definition} validateOption={option => contentMediaChoiceIssue(detail.definition, option)} />{social.qrMediaId ? <Button type="button" size="sm" variant="ghost" onClick={() => patch({ socials: model.socials.map((row, i) => i === index ? { ...row, qrMediaId: null } : row) })}>移除二维码</Button> : null}<Button type="button" size="sm" variant="ghost" onClick={() => patch({ socials: model.socials.filter((_, i) => i !== index) })}>移除渠道</Button></div>)}<Button type="button" size="sm" variant="secondary" disabled={model.socials.length >= 6} onClick={() => patch({ socials: [...model.socials, { label: "", href: null, qrMediaId: null }] })}>添加渠道</Button></div>
        </fieldset>
        {detail.versions.length ? <details className="text-sm"><summary>版本历史</summary><div className="mt-3 space-y-2">{detail.versions.filter(row => row.state !== "DRAFT").map(version => <div key={version.id} className="flex items-center gap-3"><span>v{version.sequence} · {version.state === "PUBLISHED" ? "线上" : "历史"}</span>{canEdit ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setRestore(version)}>恢复为草稿</Button> : null}</div>)}{detail.published && canPublish ? <Button type="button" variant="danger" size="sm" disabled={locked || dirty} onClick={() => setWithdraw(true)}>撤回线上版本</Button> : null}</div></details> : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={locked} onClick={onClose}>关闭</Button>
        {pending && !busy && onRecover ? <Button type="button" onClick={onRecover}>核对原操作结果</Button> : <>
          {canEdit ? <Button type="button" variant="secondary" disabled={locked || !dirty || Boolean(invalid)} onClick={() => void onWrite("content.resource.draft.save", { payload: validateResource(detail.key, model) })}>保存草稿</Button> : null}
          {canPublish ? <Button type="button" disabled={locked || dirty || !detail.draft || Boolean(invalid)} onClick={() => void onWrite("content.resource.publish", { versionId: detail.draft!.id, expectedRevision: detail.item!.revision })}>发布页脚</Button> : null}
        </>}
      </DialogFooter>
    </DialogContent>
    <Dialog open={Boolean(restore)} onOpenChange={open => { if (!open) setRestore(null); }}><DialogContent role="alertdialog"><DialogTitle>恢复为新草稿？</DialogTitle><DialogDescription>当前未保存修改会丢失，已保存草稿会保留为历史。恢复后需要重新发布。</DialogDescription><DialogFooter><Button type="button" variant="secondary" onClick={() => setRestore(null)}>取消</Button><Button type="button" disabled={locked} onClick={() => { const version = restore; setRestore(null); if (version) void onWrite("content.resource.draft.restore", { sourceVersionId: version.id, expectedRevision: detail.item!.revision }); }}>恢复为草稿</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={withdraw} onOpenChange={setWithdraw}><DialogContent role="alertdialog"><DialogTitle>撤回线上页脚配置？</DialogTitle><DialogDescription>用户站将隐藏可配置内容，固定入口仍然保留。</DialogDescription><DialogFooter><Button type="button" variant="secondary" onClick={() => setWithdraw(false)}>取消</Button><Button type="button" variant="danger" disabled={locked} onClick={() => { setWithdraw(false); void onWrite("content.resource.withdraw", { versionId: detail.published!.id, expectedRevision: detail.item!.revision }); }}>确认撤回</Button></DialogFooter></DialogContent></Dialog>
  </Dialog>;
}
