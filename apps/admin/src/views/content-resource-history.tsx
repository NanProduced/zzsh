import { FileClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { contentTime, type ResourceDetail, type ResourceVersion } from "./content-resources-model";

export function ContentResourceHistoryTable({
  detail, inHelpWorkspace, historyLoading, historyError, readHistory, setRestore, canEdit, locked, canPublish, dirty, setWithdraw,
}: {
  detail: ResourceDetail;
  inHelpWorkspace: boolean;
  historyLoading: boolean;
  historyError?: string;
  readHistory: (version: ResourceVersion) => void;
  setRestore: (version: ResourceVersion) => void;
  canEdit: boolean;
  locked: boolean;
  canPublish: boolean;
  dirty: boolean;
  setWithdraw: (open: boolean) => void;
}) {
  return (
    <><div className="mt-4 space-y-4">{!inHelpWorkspace ? <p className="text-xs text-muted-foreground break-all">{detail.key} · 并发版本 {detail.item?.revision ?? "未创建"}</p> : null}{historyLoading ? <p className="text-sm" role="status">读取历史版本…</p> : null}<StatusMessage error={historyError} /><div className="table-wrap"><table className="data-table"><thead><tr><th>版本</th><th>状态</th><th>发布 / 更新时间</th><th>操作</th></tr></thead><tbody>{detail.versions.map(version => <tr key={version.id}><td>v{version.sequence}</td><td>{{ PUBLISHED: "线上", DRAFT: "草稿", SUPERSEDED: "历史", WITHDRAWN: "已撤回" }[version.state] ?? version.state}</td><td className="text-[11px]"><span className="block">{version.publishedAt ? `发布 ${contentTime(version.publishedAt)}` : "未发布"}</span><span className="block text-muted-foreground">更新 {contentTime(version.updatedAt)}</span></td><td><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={historyLoading} onClick={() => void readHistory(version)}>查看原版本</Button>{version.state !== "DRAFT" && canEdit ? <Button type="button" size="sm" variant="secondary" disabled={locked} onClick={() => setRestore(version)}><FileClock size={13} aria-hidden="true" />恢复为草稿</Button> : null}</div></td></tr>)}</tbody></table></div>{detail.published && canPublish ? <Button type="button" size="sm" variant="danger" disabled={locked || dirty} onClick={() => setWithdraw(true)}>撤回线上版本</Button> : null}</div></>
  );
}
