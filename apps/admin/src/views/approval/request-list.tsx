import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Badge, InlineStatus } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import {
  OPERATION_TITLES, operationLevel, personLabel, requestStatusView, requestSummaryLine,
  type RequestSummary, type RiskLevel,
} from "./contract";
import { EmptyNote, FieldLabel, formatApprovalDate as formatDate, ReadingNote } from "./atoms";

const ALL = "all";

export type ListScope = "pending" | "involved" | "all";
export type ListFilter = {
  operationCode: string;
  status: string;
  requester: string;
  timeFrom: string;
  timeTo: string;
};

export const EMPTY_FILTER: ListFilter = { operationCode: "", status: "", requester: "", timeFrom: "", timeTo: "" };

const SCOPE_LABELS: Record<ListScope, string> = {
  pending: "待我处理",
  involved: "与我相关",
  all: "全部申请",
};

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: ALL, label: "全部状态" },
  { value: "PENDING", label: "待审批" },
  { value: "APPROVED", label: "已生效" },
  { value: "REJECTED", label: "已驳回" },
  { value: "CANCELLED", label: "已撤回" },
];

const LEVEL_VARIANT: Record<RiskLevel, "destructive" | "warning" | "outline"> = {
  高: "destructive", 中: "warning", 低: "outline",
};

function titleOf(item: RequestSummary): string {
  return OPERATION_TITLES[item.operationCode] ?? item.business?.businessTitle ?? "审批申请";
}

/**
 * 统一列表：一张表，服务端按范围/类型/状态/申请人/时间筛选（统一接口）。
 * 每行写清申请人与一行人话摘要，右侧显示级别，只保留阅读与办理所需的信息。
 */
export function RequestList({
  items, busy, emptyNote, onOpen, scope, onScopeChange, canSeeAll, filters, onFiltersChange,
}: {
  items: RequestSummary[];
  busy: boolean;
  emptyNote: string;
  onOpen: (requestId: string, title: string) => void;
  scope: ListScope;
  onScopeChange: (scope: ListScope) => void;
  canSeeAll: boolean;
  filters: ListFilter;
  onFiltersChange: (filters: ListFilter) => void;
}) {
  const [draft, setDraft] = useState<ListFilter>(filters);
  useEffect(() => { setDraft(filters); }, [filters]);

  const typeOptions = [
    { value: ALL, label: "全部类型" },
    ...Object.entries(OPERATION_TITLES).map(([value, label]) => ({ value, label })),
  ];
  const scopeOptions: Array<{ value: ListScope; label: string }> = [
    { value: "pending", label: SCOPE_LABELS.pending },
    { value: "involved", label: SCOPE_LABELS.involved },
    ...(canSeeAll ? [{ value: "all" as ListScope, label: SCOPE_LABELS.all }] : []),
  ];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onFiltersChange({
      operationCode: draft.operationCode === ALL ? "" : draft.operationCode,
      status: draft.status,
      requester: draft.requester.trim(),
      timeFrom: draft.timeFrom,
      timeTo: draft.timeTo,
    });
  };
  const reset = () => {
    setDraft(EMPTY_FILTER);
    onFiltersChange(EMPTY_FILTER);
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" noValidate>
        <label className="block min-w-0">
          <FieldLabel>查看范围</FieldLabel>
          <Select value={scope} items={scopeOptions} onValueChange={(value) => { if (value) onScopeChange(value as ListScope); }}>
            <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
            <SelectContent>
              {scopeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="block min-w-0">
          <FieldLabel>类型</FieldLabel>
          <Select value={draft.operationCode || ALL} items={typeOptions} onValueChange={(value) => setDraft({ ...draft, operationCode: value ?? ALL })}>
            <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
            <SelectContent>
              {typeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="block min-w-0">
          <FieldLabel>状态</FieldLabel>
          <Select value={draft.status || ALL} items={STATUS_OPTIONS} onValueChange={(value) => setDraft({ ...draft, status: value === ALL ? "" : value ?? "" })}>
            <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="block min-w-0">
          <FieldLabel>申请人</FieldLabel>
          <Input value={draft.requester} onChange={(event) => setDraft({ ...draft, requester: event.target.value })} className="h-9" placeholder="姓名或账号" />
        </label>
        <label className="block min-w-0">
          <FieldLabel>提交起始日期</FieldLabel>
          <Input type="date" value={draft.timeFrom} onChange={(event) => setDraft({ ...draft, timeFrom: event.target.value })} className="h-9" />
        </label>
        <label className="block min-w-0">
          <FieldLabel>提交截止日期</FieldLabel>
          <Input type="date" value={draft.timeTo} onChange={(event) => setDraft({ ...draft, timeTo: event.target.value })} className="h-9" />
        </label>
        <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-3">
          <Button type="submit" size="sm" loading={busy}>查询</Button>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={reset}>重置条件</Button>
        </div>
      </form>

      {busy ? <ReadingNote /> : null}

      <div className="table-wrap">
        <table className="data-table min-w-[860px]">
          <caption className="sr-only">审批申请列表</caption>
          <thead>
            <tr>
              <th scope="col">业务事项</th>
              <th scope="col">申请人</th>
              <th scope="col">当前状态</th>
              <th scope="col">申请时间</th>
              <th scope="col" className="text-right">级别</th>
              <th scope="col" className="w-28">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const status = requestStatusView({ status: item.status, operationCode: item.operationCode, business: item.business });
              const level = operationLevel(item.operationCode);
              return (
                <tr key={item.requestId} className="transition-colors hover:bg-foreground/[0.03] focus-within:bg-foreground/[0.03]">
                  <td className="min-w-0">
                    <span className="block text-sm font-medium break-words">{titleOf(item)}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed break-words text-muted-foreground">{requestSummaryLine(item)}</span>
                  </td>
                  <td className="whitespace-nowrap">{personLabel(item.requester)}</td>
                  <td>
                    <InlineStatus tone={status.tone}>{status.label}</InlineStatus>
                    {item.statusReason ? <span className="mt-0.5 block text-xs text-muted-foreground">{item.statusReason}</span> : null}
                  </td>
                  <td className="whitespace-nowrap">{formatDate(item.createdAt)}</td>
                  <td className="text-right"><Badge variant={LEVEL_VARIANT[level]}>{level}</Badge></td>
                  <td>
                    <Button type="button" size="sm" variant="secondary" className="whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring/60" aria-label={`查看：${titleOf(item)}`} onClick={() => onOpen(item.requestId, titleOf(item))}>查看</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!busy && items.length === 0 ? <EmptyNote title={emptyNote} /> : null}
      <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
        {SCOPE_LABELS[scope]}：当前页 {items.length} 条。可按类型、状态、申请人、时间缩小范围；翻页见下方。
      </p>
    </div>
  );
}
