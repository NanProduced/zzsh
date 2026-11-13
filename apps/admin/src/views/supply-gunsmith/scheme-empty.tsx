import { Crosshair, Sparkles } from "lucide-react";
import type { AdminGunsmithClassification, AdminGunsmithFirearm } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

export function SchemeEmpty({
  quickStartFirearms, classifications, getCodeCount, busy, editing, onCatalog, onSelect,
}: {
  quickStartFirearms: AdminGunsmithFirearm[];
  classifications: AdminGunsmithClassification[];
  getCodeCount: (firearm: AdminGunsmithFirearm) => number;
  busy: boolean;
  editing: boolean;
  onCatalog: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {/* 未选择枪械时的引导工作台（保留所有断言文本，并增加快捷选择卡片） */}
          <div className="p-6 sm:p-10 space-y-6">
            <div className="text-center max-w-md mx-auto space-y-3">
              <div className="space-y-1.5">
                <h2 className="flex items-center justify-center gap-2 text-lg font-semibold tracking-tight text-foreground">
                  <Crosshair className="size-5 text-primary" aria-hidden />
                  先选择一把枪械
                </h2>
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

            {/* 结构化操作流程引导 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-xl mx-auto pt-1 pb-1 text-left">
              <div className="space-y-1">
                <span className="text-xs font-semibold text-primary">① 选择枪械</span>
                <p className="text-xs text-muted-foreground leading-snug">从左侧列表或下方快捷卡片挑选目标武器</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-semibold text-primary">② 录入改枪码</span>
                <p className="text-xs text-muted-foreground leading-snug">粘贴游戏内生成的导出码并设置方案名称</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-semibold text-primary">③ 标注与实测</span>
                <p className="text-xs text-muted-foreground leading-snug">标注推荐模式并在游戏内实测生效后上线</p>
              </div>
            </div>

            {/* 快速开始卡片：展示前几个枪械，点击直接切换 */}
            {quickStartFirearms.length > 0 ? (
              <div className="border-t border-border/60 pt-5 space-y-3 xl:hidden">
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
                          className={`shrink-0 font-mono text-[11px] tabular-nums ${count > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
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
    </>
  );
}
