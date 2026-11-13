import { useEffect, useMemo, useState } from "react";
import { Crosshair } from "lucide-react";
import type { AdminGunsmithClassification, AdminGunsmithFirearm } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SupplySelect } from "../../components/supply/supply-select";
import { schemeCounts, type FirearmGroup } from "./model";

export function FirearmPicker({
  groups, classifications, firearm, totalFirearms, firearmQuery, codeCountMap, busy, editing, onFirearmQuery, onSelect, onCatalog,
}: {
  groups: FirearmGroup[];
  classifications: AdminGunsmithClassification[];
  firearm: AdminGunsmithFirearm | null;
  totalFirearms: number;
  firearmQuery: string;
  codeCountMap: Map<string, number>;
  busy: boolean;
  editing: boolean;
  onFirearmQuery: (value: string) => void;
  onSelect: (id: string) => void;
  onCatalog: () => void;
}) {
  const [classification, setClassification] = useState("all");
  const [schemeFilter, setSchemeFilter] = useState<"all" | "has_codes" | "no_codes">("all");

  useEffect(() => {
    if (classification !== "all" && classification !== "unclassified" && !classifications.some(item => item.id === classification)) {
      setClassification("all");
    }
  }, [classification, classifications]);

  const getCodeCount = (f: AdminGunsmithFirearm) => codeCountMap.get(f.id) ?? f.codeCount ?? 0;

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

  const picker = (label: string, value: string, items: { value: string; label: string }[], onChange: (value: string) => void) => (
    <SupplySelect label={label} value={value} options={items} onValueChange={onChange} />
  );
  return (
      <aside className="min-w-0 rounded-xl border border-border/80 bg-card p-4 space-y-3.5 shadow-2xs xl:sticky xl:top-4" aria-label="枪械选择">
        {/* 左侧枪械选择器：拓宽至 21rem，避免小窗拥挤，提高信息清晰度 */}
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
                <span className="text-[11px] text-muted-foreground font-mono">{g.firearms.length}</span>
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
                          {!f.enabled ? <span className="shrink-0 text-[11px] text-muted-foreground">（停用）</span> : null}
                        </span>
                        <span className="shrink-0">
                          {count > 0 ? (
                            <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-mono font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20">
                              {count} 套
                            </Badge>
                          ) : (
                            <span className="text-[11px] text-muted-foreground font-mono px-1">0 套</span>
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
  );
}
