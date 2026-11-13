import { Button } from "@/components/ui/button";
import type { ContentVersionRow } from "../api";
import { contentTime } from "./content-resources-model";

export function ContentItemVersionTable({
  versions, published, canPublish, embedded, busy, onWithdraw,
}: {
  versions: readonly ContentVersionRow[];
  published: { sequence: number } | null | undefined;
  canPublish: boolean;
  embedded: boolean;
  busy: boolean;
  onWithdraw: () => void;
}) {
  const detail = { versions };
  return (
      <details className="mt-5">
        <summary className="text-xs text-muted-foreground cursor-pointer select-none">版本历史（{detail.versions.length}）</summary>
        <div className="table-wrap mt-3">
          <table className="data-table">
            <thead><tr><th>版本</th><th>状态</th><th>标题</th><th>修订</th><th>发布时间</th><th>更新时间</th></tr></thead>
            <tbody>
              {detail.versions.map((version) => (
                <tr key={version.id}>
                  <td className="font-mono text-[11px]">v{version.sequence}</td>
                  <td>{version.state === "PUBLISHED" ? "线上" : version.state === "DRAFT" ? "草稿" : version.state === "SUPERSEDED" ? "历史" : "已撤回"}</td>
                  <td>{version.title || "（无标题）"}</td>
                  <td className="font-mono text-[11px]">{version.revision}</td>
                  <td>{version.publishedAt ? contentTime(version.publishedAt) : "-"}</td>
                  <td className="text-[11px] text-muted-foreground">{contentTime(version.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {published && canPublish && !embedded ? <div className="content-danger-zone"><p>撤回后用户页面不再读取当前线上版本，历史保留。</p><Button type="button" size="sm" variant="danger" loading={busy} onClick={onWithdraw}>撤回线上版本</Button></div> : null}
      </details>
  );
}
