import { Fragment, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SupplySelect } from "@/components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckIcon, CopyIcon } from "lucide-react";

import {
  COLUMN_SETS,
  IDENTITY_LABEL,
  OBJECT_EMPTY_HINT,
  OBJECT_LABEL,
  type CatalogKind,
  type CatalogRow,
} from "./model";

export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied("idle"), 1600);
  };
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className="font-mono truncate max-w-36">{code}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`复制稳定 code ${code}`} onClick={() => void copy()}>
        {copied === "done" ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
      {copied === "done" ? <span>已复制</span> : null}
      {copied === "failed" ? <span>复制失败，请手动选择</span> : null}
    </span>
  );
}

function StateBadge({ on, onLabel, offLabel, field }: { on: boolean; onLabel: string; offLabel: string; field?: "enabled" | "formVisible" }) {
  if (on) {
    return (
      <Badge
        variant="secondary"
        className={field === "formVisible" ? "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20 text-xs font-medium" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-xs font-medium"}
      >
        {onLabel}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground/80 border-border/60 text-xs font-normal">
      {offLabel}
    </Badge>
  );
}

function NamingStateBadge({ state }: { state: string }) {
  if (state === "VERIFIED") {
    return (
      <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-xs font-medium">
        已核实
      </Badge>
    );
  }
  if (state === "PENDING") {
    return (
      <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 text-xs font-semibold">
        待核实
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground/80 border-border/60 text-xs">
      {IDENTITY_LABEL[state as keyof typeof IDENTITY_LABEL] ?? state}
    </Badge>
  );
}

export function CellSelect({
  label,
  value,
  items,
  onValueChange,
  disabled,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <SupplySelect label={label} value={value} options={items} disabled={disabled} onValueChange={onValueChange} className="h-8 text-xs" />
  );
}

export function CellInput({
  label,
  value,
  onValueChange,
  type = "text",
  disabled,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  type?: "text" | "number";
  disabled?: boolean;
}) {
  return (
    <Input
      aria-label={label}
      type={type}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
      className="h-8 w-full text-xs"
    />
  );
}

export type EditOptions = {
  categoryItems: Array<{ value: string; label: string }>;
  rarityItems: Array<{ value: string; label: string }>;
  kindItems: Array<{ value: string; label: string }>;
  unitItems: Array<{ value: string; label: string }>;
  boolItems: Array<{ value: string; label: string }>;
  valueKindItems: Array<{ value: string; label: string }>;
  expiryKindItems: Array<{ value: string; label: string }>;
  nameDisabled?: boolean;
};

export function CatalogObjectTable({
  kind,
  rows,
  query,
  filterActive = false,
  busy,
  contractReady,
  onEdit,
  onConfirm,
  onToggle,
  onDetail,
  toggleReason,
  onCreate,
  createReason,
  prerequisiteAction,
  onClearQuery,
  renderCell,
  editingId,
  editingIsNew,
  editValues,
  onEditValue,
  onSaveRow,
  onCancelRow,
  onDetailRow,
  pendingWrite = false,
  showReason = false,
  editOptions,
}: {
  kind: CatalogKind;
  rows: CatalogRow[];
  query: string;
  filterActive?: boolean;
  busy: boolean;
  contractReady: boolean;
  onEdit: (row: CatalogRow) => void;
  onConfirm?: (row: CatalogRow) => void;
  onToggle: (row: CatalogRow, field: "enabled" | "formVisible") => void;
  onDetail: (row: CatalogRow, sourceAction?: "detail-mobile") => void;
  toggleReason?: (row: CatalogRow, field: "enabled" | "formVisible") => string | undefined;
  onCreate: () => void;
  createReason?: string;
  prerequisiteAction?: { label: string; onClick: () => void };
  onClearQuery?: () => void;
  renderCell: (row: CatalogRow, key: string) => React.ReactNode;
  editingId?: string;
  editingIsNew?: boolean;
  editValues?: Record<string, string>;
  onEditValue?: (key: string, value: string) => void;
  onSaveRow?: () => void;
  onCancelRow?: () => void;
  onDetailRow?: () => void;
  pendingWrite?: boolean;
  showReason?: boolean;
  editOptions?: EditOptions;
}) {
  const columns = COLUMN_SETS[kind];
  const searching = query.trim().length > 0 || filterActive;
  const editing = Boolean(editValues);

  const editControl = (key: string): React.ReactNode => {
    const values = editValues!;
    const KEY_MAP: Record<string, string> = { parentPath: "parentId", categoryPath: "categoryId", kind: "ownerKind" };
    const set = (value: string) => onEditValue?.(KEY_MAP[key] ?? key, value);
    if (key === "name") return <CellInput label="名称" value={values.name ?? ""} disabled={busy || editOptions?.nameDisabled} onValueChange={set} />;
    if (key === "unit") return <CellSelect label="单位" value={values.unit ?? ""} items={editOptions!.unitItems} disabled={busy} onValueChange={set} />;
    if (key === "valueKind") return <CellSelect label="值类型" value={values.valueKind ?? ""} items={editOptions!.valueKindItems} disabled={busy} onValueChange={set} />;
    if (key === "expiryKind") return <CellSelect label="有效类型" value={values.expiryKind ?? ""} items={editOptions!.expiryKindItems} disabled={busy} onValueChange={set} />;
    if (key === "required" || key === "enabled" || key === "formVisible")
      return (
        <CellSelect
          label={key === "required" ? "发布必填配置" : key === "enabled" ? "启用" : "表单展示"}
          value={values[key] ?? "false"}
          items={editOptions!.boolItems}
          disabled={busy}
          onValueChange={set}
        />
      );
    if (key === "sortOrder" || key === "quantityScale")
      return <CellInput label={key === "sortOrder" ? "排序" : "数量精度"} type="number" value={values[key] ?? "0"} disabled={busy} onValueChange={set} />;
    if (key === "parentPath" || key === "categoryPath")
      return (
        <CellSelect
          label={key === "parentPath" ? "父分类" : "分类"}
          value={key === "parentPath" ? values.parentId ?? "" : values.categoryId ?? ""}
          items={editOptions!.categoryItems}
          disabled={busy}
          onValueChange={set}
        />
      );
    if (key === "rarityCode") return <CellSelect label="品质" value={values.rarityCode ?? ""} items={editOptions!.rarityItems} disabled={busy} onValueChange={set} />;
    if (key === "kind") return <CellSelect label="所属对象类型" value={values.ownerKind ?? "AGENT"} items={editOptions!.kindItems} disabled={busy} onValueChange={set} />;
    return null;
  };

  const nameCell = (row: CatalogRow | null) => {
    if (editing && editValues && (row === null || row.id === editingId)) {
      return (
        <div className="space-y-1">
          {row === null ? <CellInput label="稳定 code" value={editValues.code ?? ""} onValueChange={(value) => onEditValue?.("code", value)} /> : <CopyCode code={String(row.code ?? row.id)} />}
          {editControl("name")}
        </div>
      );
    }
    if (!row) return null;
    return (
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground break-words">{String(row.name ?? "未提供名称")}</p>
        {Array.isArray(row.aliases) && row.aliases.length > 0 ? (
          <p className="text-[11px] text-muted-foreground break-words">别名：{row.aliases.map((alias) => String(alias)).join("；")}</p>
        ) : null}
        <CopyCode code={String(row.code ?? row.id)} />
        <div className="flex flex-wrap items-center gap-1.5 md:hidden">
          <Badge variant="outline">{row.enabled === true ? "启用" : row.enabled === false ? "停用" : "状态未提供"}</Badge>
          {kind === "skins" ? <Badge variant={row.namingState === "PENDING" ? "warning" : "outline"}>{IDENTITY_LABEL[row.namingState as keyof typeof IDENTITY_LABEL] ?? "身份未提供"}</Badge> : null}
          <Button type="button" variant="link" size="xs" className="h-8 px-0" data-catalog-action="detail-mobile" disabled={busy || editing} aria-label={`查看详情 ${String(row.name ?? "词条")}`} onClick={event => { event.stopPropagation(); onDetail(row, "detail-mobile"); }}>查看详情</Button>
        </div>
      </div>
    );
  };

  const actionsCell = (row: CatalogRow | null) => {
    if (editing && (row === null || row.id === editingId)) {
      return (
        <span className="inline-flex flex-wrap justify-end gap-1.5">
          <Button type="button" size="sm" disabled={busy} onClick={() => onSaveRow?.()}>
            保存
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onCancelRow?.()}>
            {pendingWrite ? "关闭编辑（稍后核对原结果）" : "取消"}
          </Button>
          <Button type="button" size="sm" variant="ghost" data-catalog-action="detail" onClick={() => onDetailRow?.()}>
            详情
          </Button>
        </span>
      );
    }
    if (!row) return null;
    return (
      <span className="inline-flex flex-wrap justify-end gap-1.5">
        <Button type="button" variant="outline" size="sm" data-catalog-action="edit" disabled={busy || !contractReady || editing} onClick={() => onEdit(row)}>
          编辑
        </Button>
        {"enabled" in row ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || !contractReady || editing || Boolean(toggleReason?.(row, "enabled"))}
            title={toggleReason?.(row, "enabled")}
            onClick={() => onToggle(row, "enabled")}
          >
            {row.enabled ? "停用" : "启用"}
          </Button>
        ) : null}
        {onConfirm && row.namingState && row.namingState !== "VERIFIED" ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-8 gap-1 px-2.5 text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-amber-950 dark:text-black shadow-xs"
            disabled={busy || !contractReady || editing}
            onClick={() => onConfirm(row)}
          >
            确认身份
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" data-catalog-action="detail" disabled={busy || !contractReady || editing} onClick={() => onDetail(row)}>
          详情
        </Button>
      </span>
    );
  };

  const editCellClass = (row: CatalogRow | null) => (editing && (row === null || row.id === editingId) ? "bg-muted/40 whitespace-normal" : undefined);

  const phantomRow =
    editingIsNew && editValues ? (
      <Fragment>
        <TableRow data-editing="new" data-catalog-row-id="">
          <TableCell className={editCellClass(null)}>{nameCell(null)}</TableCell>
          {columns.map((column) => (
            <TableCell key={column.key} className={editCellClass(null)}>
              {editControl(column.key) ?? <span className="text-[11px] text-muted-foreground">保存后生成</span>}
            </TableCell>
          ))}
          <TableCell className={`${editCellClass(null)} text-right`}>{actionsCell(null)}</TableCell>
        </TableRow>
        {showReason ? (
          <TableRow>
            <TableCell colSpan={columns.length + 2} className="bg-muted/40 whitespace-normal">
              <div className="flex flex-wrap items-center gap-2">
                <CellInput label="操作原因" value={editValues.reason ?? ""} disabled={busy} onValueChange={(value) => onEditValue?.("reason", value)} />
                <span className="text-[11px] text-muted-foreground">皮肤与所属对象的每次写操作都需要原因，随本次提交记录。</span>
              </div>
            </TableCell>
          </TableRow>
        ) : null}
      </Fragment>
    ) : null;

  const emptyBody = (
    <TableRow>
      <TableCell colSpan={columns.length + 2} className="py-8">
        <div className="space-y-2 text-xs text-muted-foreground">
          <p className="text-sm font-medium text-foreground">{!contractReady ? "目录合同未接入" : searching ? "没有匹配的条目" : `暂无${OBJECT_LABEL[kind]}`}</p>
          {contractReady ? <p>{searching ? query.trim() ? `已加载内容中无匹配：${query.trim()}。搜索只覆盖当前已加载目录，不代表全库不存在。` : "当前身份筛选下没有匹配条目；筛选仅覆盖已加载目录。" : OBJECT_EMPTY_HINT[kind]}</p> : null}
          {searching ? <Button type="button" size="sm" variant="outline" onClick={onClearQuery}>{filterActive ? "清除筛选" : "清除搜索"}</Button> : (
            createReason ? (
              <div className="space-y-2"><p>{createReason}</p>{prerequisiteAction ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={prerequisiteAction.onClick}>{prerequisiteAction.label}</Button> : null}</div>
            ) : (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCreate}>
                新增{OBJECT_LABEL[kind]}
              </Button>
            )
          )}
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <div data-catalog-kind={kind} className="min-w-0 overflow-hidden rounded-lg border border-border">
      <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground md:hidden">左右滑动查看完整字段与操作；也可点「查看详情」。</p>
      <Table className="min-w-[660px]">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-44">名称</TableHead>
            {columns.map((column) => (
              <TableHead key={column.key}>{column.label}</TableHead>
            ))}
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && !phantomRow ? (
            emptyBody
          ) : (
            <>
              {phantomRow}
              {rows.map((row) => (
                <Fragment key={row.id}>
                <TableRow data-catalog-row-id={row.id} data-editing={row.id === editingId ? "true" : undefined}>
                  <TableCell className={editCellClass(row)}>{nameCell(row)}</TableCell>
                  {columns.map((column) => (
                    <TableCell key={column.key} className={editCellClass(row)}>
                      {row.id === editingId && editValues && column.key !== "media" ? (
                        editControl(column.key) ?? (column.key === "appearance" ? <Button type="button" variant="link" size="sm" disabled={busy} onClick={() => onDetailRow?.()}>详情维护</Button> : <span className="text-[11px] text-muted-foreground">创建后不可改</span>)
                      ) : column.key === "enabled" || column.key === "formVisible" ? (
                        <StateBadge on={Boolean(row[column.key])} onLabel={column.key === "enabled" ? "启用" : "展示"} offLabel={column.key === "enabled" ? "停用" : "隐藏"} field={column.key} />
                      ) : column.key === "namingState" ? (
                        <NamingStateBadge state={String(row.namingState ?? "")} />
                      ) : (
                        renderCell(row, column.key)
                      )}
                    </TableCell>
                  ))}
                  <TableCell className={`${editCellClass(row)} text-right`}>{actionsCell(row)}</TableCell>
                </TableRow>
                {row.id === editingId && showReason && editValues ? (
                  <TableRow>
                    <TableCell colSpan={columns.length + 2} className="bg-muted/40 whitespace-normal">
                      <div className="flex flex-wrap items-center gap-2">
                        <CellInput label="操作原因" value={editValues.reason ?? ""} disabled={busy} onValueChange={(value) => onEditValue?.("reason", value)} />
                        <span className="text-[11px] text-muted-foreground">皮肤与所属对象的每次写操作都需要原因，随本次提交记录。</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              ))}
            </>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
