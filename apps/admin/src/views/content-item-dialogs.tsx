import type { Dispatch, SetStateAction } from "react";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { ContentUpdateSettings, type PlateUpdateSettings } from "./content-update-settings";
import { ContentMediaField } from "./content-resource-fields";
import { adminMediaUrl } from "./content-plate";
import { byteLabel, utf8Bytes } from "./content-item-bytes";

type ItemModel = {
  title: string;
  summary: string;
  coverMediaId: string | null;
  updateSettings: PlateUpdateSettings;
  document: PlateDocumentEnvelope;
};
type SettingsDraft = Pick<ItemModel, "summary" | "coverMediaId" | "updateSettings">;

export function ContentItemDialogs(props: {
  insertBodyMedia: boolean;
  setInsertBodyMedia: (open: boolean) => void;
  mediaReadable: boolean;
  readOnly: boolean;
  canUploadMedia: boolean;
  canPublishPlatform: boolean;
  setBodyMedia: Dispatch<SetStateAction<Record<string, string | null>>>;
  insertImage: (mediaId: string) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  canEdit: boolean;
  conflict: boolean;
  draft: unknown;
  settingsDraft: SettingsDraft;
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft>>;
  setModel: Dispatch<SetStateAction<ItemModel>>;
  item: { type: string };
}) {
  const {
    insertBodyMedia, setInsertBodyMedia, mediaReadable, readOnly, canUploadMedia, canPublishPlatform, setBodyMedia, insertImage,
    settingsOpen, setSettingsOpen, canEdit, conflict, draft, settingsDraft, setSettingsDraft, setModel, item,
    } = props;
  return (
    <>
      <Dialog open={insertBodyMedia && mediaReadable} onOpenChange={setInsertBodyMedia}>
        <DialogContent size="md" className="content-picture-picker-dialog">
          <DialogTitle>插入图片</DialogTitle>
          <DialogDescription>图片会插在正文末尾，可拖动调整位置。</DialogDescription>
          <div className="content-picture-picker-body">{insertBodyMedia ? <ContentMediaField pickerOnly label="正文插图" value={null} disabled={readOnly} hint=""
            canUpload={canUploadMedia} canReview={canPublishPlatform} onSelected={image => setBodyMedia(current => ({ ...current, [image.id]: adminMediaUrl(image.id) }))} onChange={id => { if (id) insertImage(id); }} /> : null}</div>
          <DialogFooter><Button type="button" variant="secondary" onClick={() => setInsertBodyMedia(false)}>取消</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent size="md" className="content-management content-updates-settings-dialog">
          <DialogTitle>发布设置</DialogTitle>
          <DialogDescription>{!canEdit ? "当前账号没有编辑权限，仅可查看发布设置。" : conflict ? "草稿版本已变化，请刷新详情后再修改设置。" : !draft ? "当前版本只读，创建或恢复草稿后可修改设置。" : readOnly ? "正在读取或保存，请稍后再修改设置。" : "应用后设置进入当前草稿；保存并发布后才影响用户页面。取消不会应用本次修改。"}</DialogDescription>
          <div className="content-updates-settings-body space-y-4">
              <label className="content-notion-meta-field">
                <span>列表摘要（可选，显示于列表与详情）<span className={utf8Bytes(settingsDraft.summary) > 500 ? "content-byte-over" : "content-byte-count"}>{byteLabel(settingsDraft.summary, 500)}</span></span>
                <Input value={settingsDraft.summary} onChange={(event) => setSettingsDraft((current) => ({ ...current, summary: event.target.value }))} className="h-8 text-xs" disabled={readOnly} placeholder="一句话说明这条动态" />
              </label>
              {mediaReadable ? <ContentMediaField label={item.type === "NEWS" ? "资讯列表封面" : "封面（公告列表不展示）"} hint="选择可公开使用的图片素材。"
                value={settingsDraft.coverMediaId} disabled={readOnly} canUpload={canUploadMedia} canReview={canPublishPlatform}
                buttonLabel={settingsDraft.coverMediaId ? "更换封面" : "选择封面"} allowClear clearLabel="移除封面" emptyLabel="未选择封面"
                onChange={coverMediaId => setSettingsDraft(current => ({ ...current, coverMediaId }))} />
                : settingsDraft.coverMediaId ? <div className="flex flex-wrap items-center gap-2 text-sm"><p className="text-muted-foreground">已设置封面。当前账号无法查看图片素材。</p>
                  <Button type="button" size="sm" variant="ghost" disabled={readOnly} onClick={() => setSettingsDraft(current => ({ ...current, coverMediaId: null }))}>移除封面</Button></div> : null}
              <ContentUpdateSettings value={settingsDraft.updateSettings} onChange={value => setSettingsDraft(current => ({ ...current, updateSettings: value }))} disabled={readOnly} announcement={item.type === 'ANNOUNCEMENT'} />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setSettingsOpen(false)}>{readOnly ? "关闭" : "取消"}</Button>
            {!readOnly ? <Button type="button" disabled={utf8Bytes(settingsDraft.summary) > 500} onClick={() => { setModel(current => ({ ...current, ...settingsDraft })); setSettingsOpen(false); }}>应用到草稿</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ContentItemConfirmDialogs(props: {
  withdrawIntent: unknown;
  cancelWithdraw: () => void;
  busy: boolean;
  reading: boolean;
  canPublish: boolean;
  confirmWithdraw: () => void;
  embedded: boolean;
  leaveIntent: "close" | "reload" | null;
  setLeaveIntent: (value: "close" | "reload" | null) => void;
  confirmLeave: () => void;
}) {
  const { withdrawIntent, cancelWithdraw, busy, reading, canPublish, confirmWithdraw, embedded, leaveIntent, setLeaveIntent, confirmLeave } = props;
  return (
    <>
      <Dialog open={withdrawIntent !== null} onOpenChange={open => { if (!open) cancelWithdraw(); }}>
        <DialogContent showCloseButton={false} role="alertdialog">
          <DialogTitle>下线这条动态？</DialogTitle>
          <DialogDescription>用户侧将不再展示当前版本，版本历史会保留。</DialogDescription>
          <DialogFooter>
            <Button type="button" size="sm" variant="secondary" autoFocus onClick={cancelWithdraw}>取消</Button>
            <Button type="button" size="sm" variant="danger" disabled={busy || reading || !canPublish} onClick={confirmWithdraw}>{embedded ? "确认下线" : "确定撤回"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={leaveIntent !== null} onOpenChange={open => { if (!open) setLeaveIntent(null); }}>
        <DialogContent showCloseButton={false} role="alertdialog">
          <DialogTitle>{leaveIntent === "reload" ? "放弃修改并刷新详情？" : "放弃未保存的修改？"}</DialogTitle>
          <DialogDescription>{leaveIntent === "reload" ? "刷新会读取最新详情并替换当前输入；取消可继续编辑。" : "返回列表会丢弃当前输入；取消可继续编辑。已经发送且结果待核对的请求不会被取消。"}</DialogDescription>
          <DialogFooter>
            <Button type="button" size="sm" variant="secondary" autoFocus onClick={() => setLeaveIntent(null)}>继续编辑</Button>
            <Button type="button" size="sm" variant="danger" disabled={busy || reading} onClick={confirmLeave}>{leaveIntent === "reload" ? "放弃并刷新" : "放弃并返回"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
