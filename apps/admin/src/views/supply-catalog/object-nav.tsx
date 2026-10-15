import { Badge } from "@/components/ui/badge";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";

import { OBJECT_LABEL, OBJECT_ORDER, type CatalogKind } from "./model";

export function CatalogObjectNav({
  kind,
  counts,
  pending,
  loaded,
}: {
  kind: CatalogKind;
  counts: Record<CatalogKind, number>;
  pending: number;
  loaded: boolean;
}) {
  return (
    <TabsList aria-label="目录对象（当前已加载范围）" className="flex w-full flex-wrap items-center justify-start gap-1 rounded-lg border border-border/60 bg-muted/30 p-1.5 h-auto">
      {OBJECT_ORDER.map((entry) => (
        <TabsTrigger
          key={entry}
          value={entry}
          className="h-9 shrink-0 items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-all data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-xs"
        >
          <span>{OBJECT_LABEL[entry]}</span>
          <span className="flex items-center gap-1.5 ml-1">
            {entry === "skins" && loaded && pending > 0 ? (
              <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30">
                待核 {pending}
              </Badge>
            ) : null}
            {loaded ? (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground" title="当前已加载条目数">
                {counts[entry]}
              </Badge>
            ) : null}
          </span>
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
