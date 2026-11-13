import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import type { ContentResource } from "@zzsh/content";
import { PlateDocument } from "@zzsh/ui/plate-document";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { ContentMediaField } from "./content-resource-fields";
import { contentTime, type ContentOperation, type ResourceDetail, type ResourceVersion } from "./content-resources-model";
import { ContentResourceHistoryTable } from "./content-resource-history";
import { ContentResourceSettings } from "./content-resource-settings";

export function ContentResourceDialogs(props: {
  insertMedia: boolean;
  closeImagePicker: (focusId?: string) => void;
  insertError?: string;
  readOnly: boolean;
  canUpload?: boolean;
  canReview?: boolean;
  insertImage: (mediaId: string) => void;
  inHelpWorkspace: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  editable: boolean;
  kind: "guide" | "notice";
  model: { summary: string; category: string; audience: ("renter" | "owner" | "all")[]; keywords: string[]; related: string[]; contactCta: boolean };
  patch: (fields: Partial<{ summary: string; category: string; audience: ("renter" | "owner" | "all")[]; keywords: string[]; related: string[]; contactCta: boolean }>) => void;
  relatedCandidates: readonly { slug: string; title: string }[];
  relatedQuery: string;
  setRelatedQuery: (value: string) => void;
  matchedRelated: readonly { slug: string; title: string }[];
  saveStatus: ReactNode;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  detail: ResourceDetail;
  historySelection?: string;
  readHistory: (version: ResourceVersion) => void;
  historyLoading: boolean;
  historyError?: string;
  chosenVersion?: ResourceVersion;
  historyDocument: PlateDocumentEnvelope | null;
  history: { payload: ContentResource; media: { id: string; url: string | null }[]; version: ResourceVersion } | null;
  historyProjection: { plainText: string; mediaIds: readonly string[] } | null | undefined;
  historyUrls: Record<string, string>;
  canPublish: boolean;
  dirty: boolean;
  locked: boolean;
  setWithdraw: Dispatch<SetStateAction<boolean>>;
  canEdit: boolean;
  setRestore: Dispatch<SetStateAction<ResourceVersion | null>>;
  preview: boolean;
  canViewHistory: boolean;
  issuesOpen: boolean;
  setIssuesOpen: Dispatch<SetStateAction<boolean>>;
  releaseError?: string;
  releaseReason: string;
  releaseMediaIds: readonly string[];
  issueLocation: (index: number) => ReactNode;
  findMediaBlock: (mediaId: string) => number;
  inspection: { blocking: number; issues: { code: string; message: string; mediaId?: string }[] } | null;
  publishCheck: { ok: boolean; errors: { path: string; message: string }[] };
  checkError?: string;
  checking: boolean;
  setCheckNonce: Dispatch<SetStateAction<number>>;
  setHistory: Dispatch<SetStateAction<{ payload: ContentResource; media: { id: string; url: string | null }[]; version: ResourceVersion } | null>>;
  restore: ResourceVersion | null;
  versionAction: (operation: ContentOperation, body: Record<string, unknown>) => Promise<void>;
  withdraw: boolean;
  discard: boolean;
  setDiscard: Dispatch<SetStateAction<boolean>>;
  discardReason: string;
  canDiscard: boolean;
}) {
  const {
    insertMedia, closeImagePicker, insertError, readOnly, canUpload, canReview, insertImage,
    inHelpWorkspace, settingsOpen, setSettingsOpen, editable, kind, model, patch, relatedCandidates, relatedQuery, setRelatedQuery, matchedRelated, saveStatus,
    historyOpen, setHistoryOpen, detail, historySelection, readHistory, historyLoading, historyError, chosenVersion, historyDocument, history, historyProjection, historyUrls,
    canPublish, dirty, locked, setWithdraw, canEdit, setRestore, preview, canViewHistory,
    issuesOpen, setIssuesOpen, releaseError, releaseReason, releaseMediaIds, issueLocation, findMediaBlock, inspection, publishCheck, checkError, checking, setCheckNonce, setHistory,
    restore, versionAction, withdraw, discard, setDiscard, discardReason, canDiscard,
  } = props;
  return (
    <>
    <Dialog open={insertMedia} onOpenChange={open => { if (!open) closeImagePicker(); }}>
      <DialogContent size="md" className="help-article-dialog" closeLabel="关闭插入图片" finalFocus={false}>
        <DialogHeader className="help-dialog-header">
          <DialogTitle>插入图片</DialogTitle>
          <DialogDescription>所选图片会插在打开菜单的内容块之后。</DialogDescription>
        </DialogHeader>
        <div className="help-dialog-scroll">
          <StatusMessage error={insertError} />
          {insertMedia ? <ContentMediaField pickerOnly label="选择图片" value={null} hint="" disabled={readOnly}
            canUpload={canUpload} canReview={canReview} onChange={id => { if (id) insertImage(id); }} /> : null}
        </div>
        <DialogFooter className="help-dialog-footer"><Button type="button" variant="secondary" onClick={() => closeImagePicker()}>取消</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {inHelpWorkspace ? <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent size="md" className="help-article-dialog help-settings-dialog" closeLabel="关闭文章设置" initialFocus={false}>
        <DialogHeader className="help-dialog-header">
          <DialogTitle>文章设置</DialogTitle>
          <DialogDescription>{editable ? "设置随草稿自动保存。发布后会更新用户侧文章。" : "正在查看当前设置。开始编辑后可修改。"}</DialogDescription>
        </DialogHeader>
        <div className="help-dialog-scroll"><ContentResourceSettings kind={kind} model={model} patch={patch} readOnly={readOnly} inHelpWorkspace={inHelpWorkspace} relatedCandidates={relatedCandidates} relatedQuery={relatedQuery} setRelatedQuery={setRelatedQuery} matchedRelated={matchedRelated} /></div>
        <DialogFooter className="help-dialog-footer help-settings-footer">
          {editable ? saveStatus : null}
          <Button type="button" variant="secondary" onClick={() => setSettingsOpen(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : !preview ? <details className="content-detail-secondary content-doc-settings"><summary>文档设置</summary><ContentResourceSettings kind={kind} model={model} patch={patch} readOnly={readOnly} inHelpWorkspace={inHelpWorkspace} relatedCandidates={relatedCandidates} relatedQuery={relatedQuery} setRelatedQuery={setRelatedQuery} matchedRelated={matchedRelated} /></details> : null}
    {inHelpWorkspace ? <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent size="lg" className="help-article-dialog help-history-dialog" closeLabel="关闭版本历史" initialFocus={false}>
        <DialogHeader className="help-dialog-header">
          <DialogTitle>版本历史</DialogTitle>
          <DialogDescription>选择一条记录查看当时的正文。恢复后可继续编辑草稿。</DialogDescription>
        </DialogHeader>
        {detail.versions.length ? <div className="help-history-layout">
          <ul className="help-history-list" aria-label="文章版本列表">
            {detail.versions.map(version => (
              <li key={version.id}>
                <button type="button" className="help-history-row" aria-pressed={historySelection === version.id} onClick={() => void readHistory(version)}>
                  <span>{version.state === "DRAFT" ? "当前草稿" : version.publishedAt ? `v${version.sequence}` : "旧草稿"}
                    {version.publishedAt ? <span className="help-history-state">{version.state === "PUBLISHED" ? "线上" : version.state === "WITHDRAWN" ? "已撤回" : "历史发布"}</span> : null}
                  </span>
                  <time dateTime={version.publishedAt ?? version.updatedAt}>{contentTime(version.publishedAt ?? version.updatedAt)}</time>
                </button>
              </li>
            ))}
          </ul>
          <div className="help-history-preview" aria-label="版本正文">
            {historyLoading ? <div className="space-y-3" role="status" aria-label="读取版本正文"><Skeleton className="h-7 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>
              : historyError ? <div className="space-y-3"><StatusMessage error={historyError} />{chosenVersion ? <Button type="button" size="sm" variant="secondary" onClick={() => void readHistory(chosenVersion)}>重试</Button> : null}</div>
              : historyDocument && history ? <>
                <h3 className="help-history-title">{history.payload.title}</h3>
                {"summary" in history.payload && history.payload.summary ? <p className="help-preview-summary">{history.payload.summary}</p> : null}
                {historyProjection?.plainText || historyProjection?.mediaIds.length
                  ? <PlateDocument document={historyDocument} mediaUrls={historyUrls} anchorPrefix="help-history-" />
                  : <p className="text-sm text-muted-foreground">此版本的正文为空。</p>}
              </> : null}
          </div>
        </div> : <p className="help-dialog-scroll text-sm text-muted-foreground">保存草稿或发布后，版本会显示在这里。</p>}
        <DialogFooter className="help-dialog-footer">
          {detail.published && canPublish && !dirty ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { setHistoryOpen(false); setWithdraw(true); }}>撤回线上版本</Button> : null}
          {canEdit && historyDocument && history && !["DRAFT", "PUBLISHED"].includes(history.version.state) ? <Button type="button" size="sm" disabled={locked} onClick={() => { setHistoryOpen(false); setRestore(history.version); }}>恢复为草稿</Button> : null}
          <Button type="button" size="sm" variant="secondary" onClick={() => setHistoryOpen(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : canViewHistory && !preview ? <details className="content-detail-secondary"><summary>版本历史</summary><ContentResourceHistoryTable detail={detail} inHelpWorkspace={inHelpWorkspace} historyLoading={historyLoading} historyError={historyError} readHistory={readHistory} setRestore={setRestore} canEdit={canEdit} locked={locked} canPublish={canPublish} dirty={dirty} setWithdraw={setWithdraw} /></details> : null}
    <Dialog open={issuesOpen} onOpenChange={setIssuesOpen}><DialogContent><DialogTitle>发布问题</DialogTitle><DialogDescription>处理后可再次发布；草稿仍会保留。</DialogDescription><p className="text-sm">{releaseError || releaseReason}</p>{releaseMediaIds.map(id => <div key={id} className="text-sm">素材 {id} {issueLocation(findMediaBlock(id))}</div>)}{inspection?.issues.length ? <ul className="space-y-2 text-sm">{inspection.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message} {issue.mediaId ? issueLocation(findMediaBlock(issue.mediaId)) : null}</li>)}</ul> : null}{!publishCheck.ok ? <ul className="space-y-2 text-sm">{publishCheck.errors.slice(0, 5).map(issue => { const match = /^\$\.value\[(\d+)\]/.exec(issue.path); return <li key={`${issue.path}:${issue.message}`}>{issue.message} {match ? issueLocation(Number(match[1])) : issue.path}</li>; })}</ul> : null}{checkError ? <Button type="button" size="sm" variant="secondary" disabled={checking} onClick={() => setCheckNonce(value => value + 1)}>重新检查正文</Button> : null}</DialogContent></Dialog>
    <Dialog open={!inHelpWorkspace && Boolean(history)} onOpenChange={open => { if (!open) setHistory(null); }}><DialogContent size="lg"><DialogTitle>历史版本 v{history?.version.sequence}</DialogTitle><DialogDescription>按此版本原有 plate 文档读取。这里只预览，不更改线上版本。</DialogDescription><div className="max-h-[65vh] overflow-auto p-2">{historyDocument ? <PlateDocument document={historyDocument} mediaUrls={Object.fromEntries(history!.media.filter((row): row is { id: string; url: string } => typeof row.url === "string").map(row => [row.id, row.url]))} /> : <p>此版本不是文档。</p>}</div></DialogContent></Dialog>
    <Dialog open={Boolean(restore)} onOpenChange={open => { if (!open) setRestore(null); }}><DialogContent role="alertdialog"><DialogTitle>将 v{restore?.sequence} 恢复为新草稿？</DialogTitle><DialogDescription>{detail.draft || dirty ? "当前工作副本会被替换，已有草稿保留为历史记录。" : "将复制此版本的正文、元数据和媒体引用。"}保存或恢复草稿不会改变线上内容。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setRestore(null)}>取消</Button><Button type="button" disabled={locked} onClick={() => { const value = restore; setRestore(null); if (value) void versionAction("content.resource.draft.restore", { sourceVersionId: value.id, expectedRevision: detail.item!.revision }); }}>恢复为新草稿</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={withdraw} onOpenChange={setWithdraw}><DialogContent role="alertdialog"><DialogTitle>撤回当前线上内容？</DialogTitle><DialogDescription>用户侧将不再读取此版本；历史保留，恢复后需重新发布。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setWithdraw(false)}>取消</Button><Button type="button" variant="danger" disabled={locked} onClick={() => { setWithdraw(false); void versionAction("content.resource.withdraw", { versionId: detail.published!.id, expectedRevision: detail.item!.revision }); }}>确认撤回</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent role="alertdialog"><DialogTitle>丢弃草稿，回到线上版本？</DialogTitle><DialogDescription>{detail.published ? `丢弃后会回到线上 v${detail.published.sequence}。草稿里的全部修改将永久删除。` : discardReason}</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setDiscard(false)}>继续编辑</Button><Button type="button" variant="danger" disabled={locked || !canDiscard} onClick={() => { setDiscard(false); if (canDiscard && detail.draft && detail.item) void versionAction("content.resource.draft.discard", { versionId: detail.draft.id, expectedRevision: detail.item.revision }); }}>确认丢弃</Button></DialogFooter></DialogContent></Dialog>
    </>
  );
}
