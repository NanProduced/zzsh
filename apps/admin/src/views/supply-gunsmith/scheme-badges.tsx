import type { AdminGunsmithCode } from "../../api";
import { Badge } from "../../components/ui/badge";
import { modeLabel } from "./model";

export function renderModeBadge(modeCode: AdminGunsmithCode["modeCode"]) {
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
}

export function renderStatusBadge(statusCode: AdminGunsmithCode["status"]) {
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
}
