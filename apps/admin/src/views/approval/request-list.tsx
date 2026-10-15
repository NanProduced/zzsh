import { useMemo, useState } from "react";

import { Button } from "../../components/ui-elements";
import { InlineStatus } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { formatDate } from "../../api";
import {
  actionFor, APPROVAL_ACTION_NAMES, businessProgress, businessTitleOf, candidateAvailabilityLabel,
  personLabel, statusView, type RequestSummary,
} from "./contract";
import { FieldLabel } from "./atoms";

const ALL = "all";

/**
 * 待我处理 / 我的申请共用的六列表格。
 *
 * 服务端只提供 mine/pending 的游标分页，没有业务类型、状态、时间或关键词筛选合同，
 * 所以这里的筛选是**本页过滤**并明确标注范围；服务端全集筛选作为缺口登记给 Master，
 * 不用前端过滤冒充全集，也不放无受权接口的统计卡。
 */
export function RequestList({
  items, busy, emptyNote, onOpen,
}: {
  items: RequestSummary[];
  busy: boolean;
  emptyNote: string;
  onOpen: (requestId: string, title: string) => void;
}) {
  const [business, setBusiness] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [keyword, setKeyword] = useState("");

  const businessOptions = useMemo(() => {
    const titles = [...new Set(items.map((item) => businessTitleOf(item)))].sort();
    return [{ value: ALL, label: "全部业务" }, ...titles.map((title) => ({ value: title, label: title }))];
  }, [items]);

  const statusOptions = useMemo(() => {
    const values = [...new Set(items.map((item) => item.status).filter(Boolean))].sort();
    return [{ value: ALL, label: "全部状态" }, ...values.map((value) => ({ value, label: statusView(value).label }))];
  }, [items]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return items.filter((item) => {
      if (business !== ALL && businessTitleOf(item) !== business) return false;
      if (status !== ALL && item.status !== status) return false;
      if (!needle) return true;
      return [item.summary, item.requestId, item.requester?.name, item.requester?.displayUsername, item.requester?.username]
        .some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
    });
  }, [items, business, status, keyword]);

  const filterActive = business !== ALL || status !== ALL || keyword.trim() !== "";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="block min-w-0">
          <FieldLabel>业务类型</FieldLabel>
          <Select value={business} onValueChange={(value) => setBusiness(value ?? ALL)} items={businessOptions}>
            <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
            <SelectContent>
              {businessOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="block min-w-0">
          <FieldLabel>审批状态</FieldLabel>
          <Select value={status} onValueChange={(value) => setStatus(value ?? ALL)} items={statusOptions}>
            <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="block min-w-0">
          <FieldLabel>关键词（摘要 / 编号 / 申请人）</FieldLabel>
          <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} className="h-9" placeholder="输入即在当前页内过滤" />
        </label>
        <div className="flex items-end">
          <Button
            type="button" size="sm" variant="secondary" disabled={!filterActive}
            onClick={() => { setBusiness(ALL); setStatus(ALL); setKeyword(""); }}
          >
            重置过滤
          </Button>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {filterActive
          ? `仅筛选当前页：命中 ${filtered.length} / 当前页 ${items.length} 行。`
          : `当前页 ${items.length} 行。`}
        按条件查全集与统计暂未接入，需要时联系管理员。
      </p>

      {busy ? <p className="text-xs text-muted-foreground">正在读取…</p> : null}

      <div className="table-wrap">
        <table className="data-table min-w-[860px]">
          <caption className="sr-only">审批申请列表</caption>
          <thead>
            <tr>
              <th scope="col">业务事项</th>
              <th scope="col">申请人</th>
              <th scope="col">审批状态</th>
              <th scope="col">业务进度</th>
              <th scope="col">申请时间</th>
              <th scope="col" className="w-32">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const status = statusView(item.status);
              const progress = businessProgress(item.business);
              const actionable = APPROVAL_ACTION_NAMES.some((name) => actionFor(item.actions, name)?.allowed === true);
              const availability = candidateAvailabilityLabel(item.candidateAvailability);
              return (
                <tr key={item.requestId}>
                  <td className="min-w-0">
                    <span className="block text-sm font-medium break-words">{businessTitleOf(item)}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed break-words text-muted-foreground">{item.summary}</span>
                    <span className="mt-0.5 block font-mono text-[11px] break-all text-muted-foreground">{item.requestId}</span>
                    {availability ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{availability}</span> : null}
                  </td>
                  <td className="whitespace-nowrap">{personLabel(item.requester)}</td>
                  <td>
                    <InlineStatus tone={status.tone}>{status.label}</InlineStatus>
                    {item.statusReason ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{item.statusReason}</span> : null}
                  </td>
                  <td>
                    <InlineStatus tone={progress.tone}>{progress.label}</InlineStatus>
                    {progress.detail ? <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{progress.detail}</span> : null}
                  </td>
                  <td className="whitespace-nowrap">
                    {formatDate(item.createdAt)}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">有效期至 {formatDate(item.expiresAt)}</span>
                  </td>
                  <td>
                    <Button type="button" size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => onOpen(item.requestId, businessTitleOf(item))}>
                      {actionable ? "查看并处理" : "查看"}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!busy && items.length === 0 ? <p className="text-xs text-muted-foreground">{emptyNote}</p> : null}
      {!busy && items.length > 0 && filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">当前页没有符合过滤条件的申请；过滤只作用于本页，换页或重置后重新查看。</p>
      ) : null}
    </div>
  );
}
