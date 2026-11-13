import { useEffect, useMemo, useState } from "react";
import { renderModeBadge, renderStatusBadge } from "./scheme-badges";
import { SchemeEmpty } from "./scheme-empty";
import { Check, ChevronDown, Clock, Copy, Crosshair, Plus, RefreshCw, Settings2, Wrench } from "lucide-react";
import type { AdminGunsmithAlias, AdminGunsmithClassification, AdminGunsmithCode, AdminGunsmithFirearm } from "../../api";
import { Badge, InlineStatus } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { newCodeDisabledReason, reviewTimeInput, type FirearmGroup } from "./model";

export function SchemePanel({
  groups, classifications, firearm, codes, aliases, codeCountMap, codeQuery, mode, status, busy, editing,
  onCodeQuery, onMode, onStatus, onSelect, onNew, onEdit, onStatusChange, onAlias, onEditAlias, onEditFirearm, onCatalog, onRefresh,
}: {
  groups: FirearmGroup[];
  classifications: AdminGunsmithClassification[];
  firearm: AdminGunsmithFirearm | null;
  codes: AdminGunsmithCode[];
  aliases: AdminGunsmithAlias[];
  codeCountMap: Map<string, number>;
  codeQuery: string;
  mode: string;
  status: string;
  busy: boolean;
  editing: boolean;
  onCodeQuery: (value: string) => void;
  onMode: (value: string) => void;
  onStatus: (value: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (code: AdminGunsmithCode) => void;
  onStatusChange: (code: AdminGunsmithCode) => void;
  onAlias: () => void;
  onEditAlias: (alias: AdminGunsmithAlias) => void;
  onEditFirearm: () => void;
  onCatalog: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();

  useEffect(() => {
    setCopied(undefined);
    setCopiedId(undefined);
  }, [firearm?.id]);

  const getCodeCount = (f: AdminGunsmithFirearm) => codeCountMap.get(f.id) ?? f.codeCount ?? 0;

  // 获取推荐快捷枪械列表（前 6 把供快速开始）
  const quickStartFirearms = useMemo(() => {
    const all = groups.flatMap(g => g.firearms);
    return all.slice(0, 6);
  }, [groups]);

  const copy = async (code: AdminGunsmithCode) => {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(`已复制${firearm?.name ?? ""}改枪码原文`);
      setCopiedId(code.id);
      setTimeout(() => setCopiedId(undefined), 2000);
    } catch {
      setCopied("复制失败，请选中改枪码原文手动复制。");
    }
  };

  const picker = (label: string, value: string, items: { value: string; label: string }[], onChange: (value: string) => void) => (
    <SupplySelect label={label} value={value} options={items} onValueChange={onChange} />
  );

  const copyButton = (code: AdminGunsmithCode) => (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label={`复制改枪码 ${code.id}`}
      className="h-7 shrink-0 gap-1 px-2.5 text-xs transition-colors hover:border-primary/50"
      onClick={() => void copy(code)}
    >
      {copiedId === code.id ? (
        <>
          <Check className="size-3.5 text-emerald-500" />
          <span className="text-emerald-500 font-medium">已复制</span>
        </>
      ) : (
        <>
          <Copy className="size-3.5" />
          复制
        </>
      )}
    </Button>
  );

  const codeActions = (code: AdminGunsmithCode) => (
    <div className="flex justify-end gap-1">
      <Button type="button" variant="ghost" size="sm" disabled={busy || editing} onClick={() => onEdit(code)}>
        编辑
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy || editing}
        className={code.status === "ACTIVE" ? "hover:text-destructive" : ""}
        onClick={() => onStatusChange(code)}
      >
        {code.status === "ACTIVE" ? "撤回" : "恢复"}
      </Button>
    </div>
  );

  return (
      <section className="min-w-0 rounded-xl border border-border/80 bg-card shadow-2xs" aria-label="改枪方案维护">
        {/* 右侧主工作区：当选枪时展示详情；未选枪时展示引导式 Onboarding Hub */}
        {firearm ? (
          <>
            {/* 枪械信息看板 Header */}
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 p-5 bg-muted/15 rounded-t-xl">
              <div className="flex items-start gap-3.5 min-w-0">
                {firearm.mediaId ? (
                  <img
                    src={`/api/v1/supply/media/${firearm.mediaId}/content`}
                    alt={firearm.name}
                    className="h-14 w-20 shrink-0 rounded-lg border border-border object-cover bg-muted/20"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-border/80 bg-muted/30 text-muted-foreground/50">
                    <Crosshair className="size-5" />
                  </div>
                )}
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-bold tracking-tight text-foreground">{firearm.name}</h2>
                    <Badge variant="outline" className="text-xs">
                      {classifications.find(c => c.id === firearm.classificationId)?.name ?? "未分类"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    一把枪可维护多套方案；复制代码原文，在游戏内导入。
                  </p>
                  {!firearm.enabled && <InlineStatus tone="neutral" className="mt-1">枪械已停用</InlineStatus>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy || editing} onClick={onEditFirearm} className="gap-1.5 h-9">
                  <Settings2 className="size-3.5" />
                  编辑枪械
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || editing || Boolean(newCodeDisabledReason(firearm))}
                  onClick={onNew}
                  className="gap-1.5 h-9"
                >
                  <Plus className="size-3.5" />
                  新增改枪码
                </Button>
              </div>
            </div>

            <div className="p-4 sm:p-5 space-y-4">
              {newCodeDisabledReason(firearm) && (
                <p className="text-sm text-muted-foreground">{newCodeDisabledReason(firearm)}</p>
              )}

              <div className="grid gap-2.5 sm:grid-cols-[minmax(12rem,1fr)_9.5rem_8.5rem]">
                <Input
                  aria-label="在当前武器的已加载改枪码中查找"
                  placeholder="查找代码或方案说明"
                  value={codeQuery}
                  onChange={e => onCodeQuery(e.target.value)}
                  className="h-9 text-xs"
                />
                {picker("方案模式筛选", mode, [{ value: "all", label: "全部模式" }, { value: "HAZARD", label: "烽火地带" }, { value: "BATTLEFIELD", label: "全面战场" }, { value: "GENERAL", label: "通用" }, { value: "unmarked", label: "未标注" }], onMode)}
                {picker("方案状态筛选", status, [{ value: "all", label: "全部状态" }, { value: "ACTIVE", label: "已收录" }, { value: "WITHDRAWN", label: "已撤回" }], onStatus)}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground border-b border-border/40 pb-2">
                <span>当前枪械已加载内容 · 匹配 {codes.length} 条 · 收录状态与游戏内可用性分别核对</span>
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table className="[&_tr]:border-border/60">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[45%]">改枪方案 / 原文</TableHead>
                      <TableHead className="w-[15%]">模式</TableHead>
                      <TableHead className="w-[15%]">最近人工复核</TableHead>
                      <TableHead className="w-[12%]">收录状态</TableHead>
                      <TableHead className="w-[13%] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {codes.map(c => (
                      <TableRow key={c.id}>
                        <TableCell className="min-w-60 max-w-xl whitespace-normal py-3.5">
                          <p className="mb-2 text-sm font-medium text-foreground">{c.note || "未填写方案说明"}</p>
                          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
                            <code className="min-w-0 flex-1 select-text break-all tracking-tight leading-relaxed">
                              {c.code}
                            </code>
                            {copyButton(c)}
                          </div>
                        </TableCell>
                        <TableCell>{renderModeBadge(c.modeCode)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground font-mono">
                          <div className="flex items-center gap-1">
                            <Clock className="size-3 text-muted-foreground/60" />
                            <span>{c.lastReviewedAt ? reviewTimeInput(c.lastReviewedAt).replace("T", " ") : "未记录"}</span>
                          </div>
                        </TableCell>
                        <TableCell>{renderStatusBadge(c.status)}</TableCell>
                        <TableCell>{codeActions(c)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-3 md:hidden">
                {codes.map(c => (
                  <article key={c.id} className="rounded-lg border border-border p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 text-sm font-medium">{c.note || "未填写方案说明"}</p>
                      {renderModeBadge(c.modeCode)}
                    </div>
                    <div className="rounded border border-border/60 bg-muted/30 p-2 font-mono text-xs">
                      <code className="block select-text break-all leading-relaxed">{c.code}</code>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground pt-1">
                      <div className="flex items-center gap-2">
                        {renderStatusBadge(c.status)}
                        <span>复核 {c.lastReviewedAt ? reviewTimeInput(c.lastReviewedAt).replace("T", " ") : "未记录"}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {copyButton(c)}
                        {codeActions(c)}
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              {codes.length === 0 && (
                <div className="py-12 text-center space-y-3">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/60">
                    <Wrench className="size-6" />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium">
                      {codeQuery || mode !== "all" || status !== "all" ? "已加载内容中无匹配" : "这把枪还没有改枪方案"}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
                      {codeQuery || mode !== "all" || status !== "all" ? "调整模式、状态或查找条件；不代表全库没有方案。" : "录入代码原文，并填写适用模式与方案说明。"}
                    </p>
                  </div>
                </div>
              )}

              {copied && <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">{copied}</p>}

              <Collapsible className="mt-6 border-t border-border/60 pt-4">
                <CollapsibleTrigger className="group flex min-h-9 w-full items-center justify-between gap-2 rounded-md text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex items-center gap-2">
                    <span>枪械别名与检索</span>
                    <Badge variant="secondary" className="px-1.5 py-0 text-xs font-normal">
                      {aliases.length} 个
                    </Badge>
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <p className="my-2 text-xs text-muted-foreground">用于检索枪械，不是独立改枪方案。</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {aliases.map(a => (
                      <Button
                        key={a.id}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || editing}
                        onClick={() => onEditAlias(a)}
                        className="h-8 gap-1 text-xs"
                      >
                        <span>{a.name}</span>
                        {!a.enabled ? <span className="text-[10px] text-muted-foreground">（停用）</span> : null}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy || editing || !firearm.enabled}
                      onClick={onAlias}
                      className="h-8 gap-1 text-xs text-primary hover:text-primary/90 hover:bg-primary/10"
                    >
                      <Plus className="size-3.5" />
                      新增别名
                    </Button>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </>
        ) : (
          <SchemeEmpty quickStartFirearms={quickStartFirearms} classifications={classifications} getCodeCount={getCodeCount} busy={busy} editing={editing} onCatalog={onCatalog} onSelect={onSelect} />
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground bg-muted/10 rounded-b-xl">
          <span>本页维护内容，玩家端开放状态独立。</span>
          <Button type="button" variant="ghost" size="sm" disabled={busy || editing} onClick={onRefresh} className="gap-1 h-8">
            <RefreshCw className="size-3.5" />
            刷新目录
          </Button>
        </div>
      </section>
  );
}
