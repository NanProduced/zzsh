import { Coins, FolderTree, Gem, ShieldCheck, Sparkles, UserCheck, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { OBJECT_LABEL, OBJECT_ORDER, type CatalogKind } from "./model";

const KIND_ICON: Record<CatalogKind, LucideIcon> = {
  items: Coins,
  categories: FolderTree,
  skins: Sparkles,
  "skin-owners": UserCheck,
  rarities: Gem,
  entitlements: ShieldCheck,
};

const KIND_ICON_COLOR: Record<CatalogKind, string> = {
  items: "text-amber-500 dark:text-amber-400",
  categories: "text-sky-500 dark:text-sky-400",
  skins: "text-violet-500 dark:text-violet-400",
  "skin-owners": "text-indigo-500 dark:text-indigo-400",
  rarities: "text-emerald-500 dark:text-emerald-400",
  entitlements: "text-blue-500 dark:text-blue-400",
};

export function CatalogObjectNav({
  kind,
  counts,
  pending,
  loaded,
  kinds = OBJECT_ORDER,
}: {
  kind: CatalogKind;
  counts: Record<CatalogKind, number>;
  pending: number;
  loaded: boolean;
  kinds?: CatalogKind[];
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <span className="size-1.5 rounded-full bg-primary" />
          <span>目录大类切换</span>
        </div>
        <span className="text-[11px] text-muted-foreground">选择不同大类维护对应的报价资源、外观与属性</span>
      </div>
      <TabsList
        aria-label="目录对象（当前已加载范围）"
        className="flex w-full flex-wrap items-center justify-start gap-2 rounded-xl border border-border/70 bg-muted/30 p-1.5 h-auto border-b-0"
      >
        {kinds.map((entry) => {
          const Icon = KIND_ICON[entry] ?? Coins;
          const iconColor = KIND_ICON_COLOR[entry];
          return (
            <TabsTrigger
              key={entry}
              value={entry}
              className={cn(
                "group relative -mb-0 border-0 border-transparent pb-0 h-11 min-w-[130px] flex-1 sm:flex-none items-center justify-between gap-3 rounded-lg px-3.5 py-2 text-xs font-medium transition-all",
                "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                "data-[active]:border-0 data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm data-[active]:font-semibold ring-1 ring-transparent data-[active]:ring-border/80",
              )}
            >
              <div className="flex items-center gap-2">
                <Icon className={cn("size-4 shrink-0 transition-colors", iconColor)} />
                <span className="tracking-tight">{OBJECT_LABEL[entry]}</span>
              </div>
              <span className="flex items-center gap-1.5 ml-1">
                {entry === "skins" && loaded && pending > 0 ? (
                  <Badge
                    variant="warning"
                    className="px-1.5 py-0 text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  >
                    待核 {pending}
                  </Badge>
                ) : null}
                {loaded ? (
                  <span
                    className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-mono tabular-nums bg-muted group-data-[active]:bg-primary/10 group-data-[active]:text-primary text-muted-foreground transition-colors"
                    title="当前已加载条目数"
                  >
                    {counts[entry]}
                  </span>
                ) : null}
              </span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </div>
  );
}
