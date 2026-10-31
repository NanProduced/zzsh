import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Clock, Copy, Crosshair, Plus, RefreshCw, Settings2, Sparkles, Wrench } from "lucide-react";
import type { AdminGunsmithAlias, AdminGunsmithClassification, AdminGunsmithCode, AdminGunsmithFirearm } from "../../api";
import { Badge, InlineStatus } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { CODE_STATUS_LABEL, CODE_STATUS_TONE, modeLabel, newCodeDisabledReason, reviewTimeInput, schemeCounts, type FirearmGroup } from "./model";

export function GunsmithWorkspace({
  groups,
  classifications,
  firearm,
  codes,
  aliases,
  totalFirearms,
  allCodes = [],
  firearmQuery,
  codeQuery,
  mode,
  status,
  busy,
  editing,
  onFirearmQuery,
  onCodeQuery,
  onMode,
  onStatus,
  onSelect,
  onNew,
  onEdit,
  onStatusChange,
  onAlias,
  onEditAlias,
  onEditFirearm,
  onCatalog,
  onRefresh,
}: {
  groups: FirearmGroup[];
  classifications: AdminGunsmithClassification[];
  firearm: AdminGunsmithFirearm | null;
  codes: AdminGunsmithCode[];
  aliases: AdminGunsmithAlias[];
  totalFirearms: number;
  allCodes?: AdminGunsmithCode[];
  firearmQuery: string;
  codeQuery: string;
  mode: string;
  status: string;
  busy: boolean;
  editing: boolean;
  onFirearmQuery: (v: string) => void;
  onCodeQuery: (v: string) => void;
  onMode: (v: string) => void;
  onStatus: (v: string) => void;
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
  const [classification, setClassification] = useState("all");
  const [schemeFilter, setSchemeFilter] = useState<"all" | "has_codes" | "no_codes">("all");
  const [copied, setCopied] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();

  useEffect(() => {
    if (classification !== "all" && classification !== "unclassified" && !classifications.some(item => item.id === classification)) {
      setClassification("all");
    }
  }, [classification, classifications]);

  useEffect(() => {
    setCopied(undefined);
    setCopiedId(undefined);
  }, [firearm?.id]);

  const codeCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of allCodes) {
      map.set(c.firearmId, (map.get(c.firearmId) ?? 0) + 1);
    }
    return map;
  }, [allCodes]);

  const getCodeCount = (f: AdminGunsmithFirearm) => {
    return codeCountMap.get(f.id) ?? f.codeCount ?? 0;
  };

  const scopedCounts = schemeCounts(groups, f => getCodeCount(f) > 0);

  const visibleGroups = useMemo(() => {
    return groups
      .map(g => {
        let list = g.firearms;
        if (schemeFilter === "has_codes") {
          list = list.filter(f => getCodeCount(f) > 0);
        } else if (schemeFilter === "no_codes") {
          list = list.filter(f => getCodeCount(f) === 0);
        }
        return { ...g, firearms: list };
      })
      .filter(g => (classification === "all" || (g.classification?.id ?? "unclassified") === classification) && g.firearms.length > 0);
  }, [groups, classification, schemeFilter, codeCountMap]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const renderModeBadge = (modeCode: AdminGunsmithCode["modeCode"]) => {
    if (modeCode === "HAZARD") {
      return (
        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
          烽火地带
        </Badge>
      );
    }
    if (modeCode === "BATTLEFIELD") {
      return (
        <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium">
          全面战场
        </Badge>
      );
    }
    if (modeCode === "GENERAL") {
      return (
        <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-400 font-medium">
          通用
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground border-border/80">
        {modeLabel(modeCode)}
      </Badge>
    );
  };

  const renderStatusBadge = (statusCode: AdminGunsmithCode["status"]) => {
    if (statusCode === "ACTIVE") {
      return (
        <Badge variant="outline" className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          已收录
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1.5 border-border/80 bg-muted/40 text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/60" />
        已撤回
      </Badge>
    );
  };

  return (
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[21rem_minmax(0,1fr)] 2xl:grid-cols-[23rem_minmax(0,1fr)]">
      {/* 左侧枪械选择器：拓宽至 21rem，避免小窗拥挤，提高信息清晰度 */}
      <aside className="min-w-0 rounded-xl border border-border/80 bg-card p-4 space-y-3.5 shadow-2xs xl:sticky xl:top-4" aria-label="枪械选择">
        <div className="flex items-center justify-between pb-1 border-b border-border/40">
          <div className="flex items-center gap-2">
            <Crosshair className="size-4 text-primary" />
            <h2 className="text-sm font-semibold tracking-tight">选择枪械</h2>
          </div>
          <span className="text-xs text-muted-foreground font-mono tabular-nums">已加载 {totalFirearms} 把</span>
        </div>
        <Input
          aria-label="在已加载枪械中查找"
          value={firearmQuery}
          onChange={e => onFirearmQuery(e.target.value)}
          placeholder="名称、别名或目录标识"
          className="h-9 text-xs"
        />
        {picker("枪械分类筛选", classification, [{ value: "all", label: "全部分类" }, ...classifications.map(c => ({ value: c.id, label: c.name })), { value: "unclassified", label: "未分类" }], setClassification)}

        <div className="flex rounded-lg bg-muted/50 p-1 text-xs">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`flex-1 rounded-md py-1 px-1.5 text-[11px] h-7 font-medium transition-all ${schemeFilter === "all" ? "bg-background text-foreground shadow-2xs font-semibold hover:bg-background" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setSchemeFilter("all")}
          >
            全部 {scopedCounts.total}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`flex-1 rounded-md py-1 px-1.5 text-[11px] h-7 font-medium transition-all ${schemeFilter === "has_codes" ? "bg-background text-foreground shadow-2xs font-semibold hover:bg-background" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setSchemeFilter("has_codes")}
          >
            有方案 {scopedCounts.withCodes}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`flex-1 rounded-md py-1 px-1.5 text-[11px] h-7 font-medium transition-all ${schemeFilter === "no_codes" ? "bg-background text-foreground shadow-2xs font-semibold hover:bg-background" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setSchemeFilter("no_codes")}
          >
            待录入 {scopedCounts.withoutCodes}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
          {firearmQuery.trim() ? `以上计数为当前查找命中的 ${scopedCounts.total} 把枪（全目录 ${totalFirearms} 把）；零命中表示没有匹配名称，不代表缺改枪码。` : `计数范围为已加载全目录 ${totalFirearms} 把枪。`}
        </p>

        {/* 枪械列表区域：平滑自适应滚动，枪项卡片化 */}
        <div className="hidden max-h-[calc(100vh-17rem)] min-h-[380px] space-y-3.5 overflow-y-auto pr-1 xl:block">
          {visibleGroups.map(g => (
            <div key={g.classification?.id ?? "unclassified"} className="space-y-1.5">
              <div className="flex items-center justify-between px-1.5 py-0.5">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {g.classification?.name ?? "未分类"}
                </p>
                <span className="text-[10px] text-muted-foreground/60 font-mono">{g.firearms.length}</span>
              </div>
              <ul className="space-y-1">
                {g.firearms.map(f => {
                  const count = getCodeCount(f);
                  const isSelected = f.id === firearm?.id;
                  return (
                    <li key={f.id}>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onSelect(f.id)}
                        aria-current={isSelected ? "true" : undefined}
                        className={`group relative flex h-auto min-h-10 w-full items-center justify-between gap-2.5 rounded-lg border px-3 py-2 text-left transition-all ${
                          isSelected
                            ? "border-primary/40 bg-primary/10 font-semibold text-foreground shadow-2xs ring-1 ring-primary/20 before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r before:bg-primary"
                            : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-muted/60 hover:text-foreground font-normal"
                        }`}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-1.5">
                          <span className="truncate text-xs">{f.name}</span>
                          {!f.enabled ? <span className="shrink-0 text-[10px] text-muted-foreground/70">（停用）</span> : null}
                        </span>
                        <span className="shrink-0">
                          {count > 0 ? (
                            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-mono font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20">
                              {count} 套
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/40 font-mono px-1">0</span>
                          )}
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="xl:hidden">
          {picker("选择枪械", firearm?.id ?? "", [{ value: "", label: "请选择枪械" }, ...visibleGroups.flatMap(g => g.firearms.map(f => ({ value: f.id, label: `${f.name}${f.enabled ? "" : "（停用）"}` })))], onSelect)}
        </div>
        {visibleGroups.length === 0 && (
          <div className="mt-4 space-y-2 text-sm rounded-lg border border-dashed border-border/70 p-4 text-center">
            <p className="text-muted-foreground text-xs">{totalFirearms ? "已加载内容中无匹配。" : "当前游戏还没有枪械目录。"}</p>
            <Button type="button" variant="outline" size="sm" disabled={busy || editing} onClick={onCatalog}>
              {totalFirearms ? "管理枪械目录" : "建立枪械目录"}
            </Button>
          </div>
        )}
      </aside>

      {/* 右侧主工作区：当选枪时展示详情；未选枪时展示引导式 Onboarding Hub */}
      <section className="min-w-0 rounded-xl border border-border/80 bg-card shadow-2xs" aria-label="改枪方案维护">
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
                    {firearm.code ? (
                      <Badge variant="secondary" className="font-mono text-[11px] text-muted-foreground">
                        {firearm.code}
                      </Badge>
                    ) : null}
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
                  {!codeQuery && mode === "all" && status === "all" && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || editing || Boolean(newCodeDisabledReason(firearm))}
                      onClick={onNew}
                      className="mt-2"
                    >
                      立即录入首套方案
                    </Button>
                  )}
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
          /* 未选择枪械时的引导工作台（保留所有断言文本，并增加快捷选择卡片） */
          <div className="p-6 sm:p-10 space-y-6">
            <div className="text-center max-w-md mx-auto space-y-3">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Crosshair className="size-7" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">先选择一把枪械</h2>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  选择左侧枪械后，查看和维护它的多套改枪方案。基础目录建档与改枪码录入分开，所有方案保留明确的所属枪械。
                </p>
              </div>
              <div className="pt-1">
                <Button type="button" variant="outline" size="sm" disabled={busy || editing} onClick={onCatalog}>
                  管理枪械目录
                </Button>
              </div>
            </div>

            {/* 快速开始卡片：展示前几个枪械，点击直接切换 */}
            {quickStartFirearms.length > 0 ? (
              <div className="border-t border-border/60 pt-5 space-y-3">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Sparkles className="size-3.5 text-amber-500" />
                  <span>快捷开始 · 点击直接进入该枪维护</span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {quickStartFirearms.map(f => {
                    const count = getCodeCount(f);
                    const classificationName = classifications.find(c => c.id === f.classificationId)?.name ?? "基础武器";
                    return (
                      <Button
                        key={f.id}
                        type="button"
                        variant="outline"
                        onClick={() => onSelect(f.id)}
                        className="group flex h-auto items-center justify-between gap-3 rounded-lg border border-border/80 bg-background/50 p-3 text-left hover:border-primary/40 hover:bg-primary/5 transition-all"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <p className="truncate text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
                            {f.name}
                          </p>
                          <p className="text-[11px] text-muted-foreground">{classificationName}</p>
                        </div>
                        <Badge
                          variant="secondary"
                          className="shrink-0 font-mono text-[10px] tabular-nums"
                        >
                          {count > 0 ? `${count} 套` : "待录入"}
                        </Badge>
                      </Button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground bg-muted/10 rounded-b-xl">
          <span>本页维护内容，玩家端开放状态独立。</span>
          <Button type="button" variant="ghost" size="sm" disabled={busy || editing} onClick={onRefresh} className="gap-1 h-8">
            <RefreshCw className="size-3.5" />
            刷新目录
          </Button>
        </div>
      </section>
    </div>
  );
}
