import {
  AlertCircleIcon,
  CheckIcon,
  LaptopIcon,
  MoonIcon,
  RotateCcwIcon,
  ShieldIcon,
  SunIcon,
} from "lucide-react";

import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Theme, ThemeMode } from "../api";
import { getSystemTheme, type ThemeStorageStatus } from "../lib/theme";

type SettingsViewProps = {
  theme: Theme;
  themeMode: ThemeMode;
  onSelectThemeMode: (mode: ThemeMode) => void;
  onResetTheme: () => void;
  themeStorageError?: boolean;
  themeStorageStatus?: ThemeStorageStatus;
  urlTheme?: Theme | null;
  onExitPreview?: () => void;
  onOpenPath: (path: string, title?: string) => void;
};

export function SettingsView({
  theme,
  themeMode,
  onSelectThemeMode,
  onResetTheme,
  themeStorageError = false,
  themeStorageStatus = "saved",
  urlTheme = null,
  onExitPreview,
  onOpenPath,
}: SettingsViewProps) {
  const systemTheme = getSystemTheme();
  const systemIsDark = systemTheme === "dark";

  const modeOptions: Array<{
    id: ThemeMode;
    label: string;
    icon: typeof SunIcon;
    description?: string;
  }> = [
    { id: "light", label: "浅色", icon: SunIcon },
    { id: "dark", label: "深色", icon: MoonIcon },
    {
      id: "system",
      label: "跟随系统",
      icon: LaptopIcon,
      description: `当前系统为${systemIsDark ? "深色" : "浅色"}`,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4 sm:p-6 lg:p-8">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b pb-5">
        <div>
          <div className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase mb-1">
            设置 · 外观
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">外观与偏好</h1>
          <p className="text-muted-foreground text-sm mt-1">
            管理当前浏览器中的控制台外观与显示偏好。选择即时生效。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onResetTheme}
            className="text-xs gap-1.5"
            aria-label="恢复外观默认值"
          >
            <RotateCcwIcon className="size-3.5" />
            <span>恢复外观默认值</span>
          </Button>
        </div>
      </div>

      {/* Temporary Preview Banner */}
      {urlTheme && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-600 dark:text-amber-400">
          <div className="flex items-center gap-2">
            <AlertCircleIcon className="size-4 shrink-0 text-amber-500" />
            <span>
              当前正在<strong>临时预览{urlTheme === "dark" ? "深色" : "浅色"}主题</strong>（未保存到当前浏览器）。当前已保存的偏好为：<strong>{themeMode === "system" ? "跟随系统" : themeMode === "dark" ? "深色" : "浅色"}</strong>。
            </span>
          </div>
          {onExitPreview && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExitPreview}
              className="h-7 text-xs border-amber-500/30 hover:bg-amber-500/20 shrink-0 self-start sm:self-auto"
            >
              结束临时预览
            </Button>
          )}
        </div>
      )}

      {/* Main Grid: Controls on Left, Preview on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Theme Mode Selection & Scope */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-6">
          <div>
            <h2 className="text-base font-semibold text-foreground">主题模式</h2>
            <p className="text-muted-foreground text-xs mt-0.5">
              选择浅色、深色或跟随操作系统深浅偏好自动切换。
            </p>
          </div>

          {/* Mode Option Cards via Base UI RadioGroup */}
          <RadioGroup
            value={themeMode}
            onValueChange={(val) => onSelectThemeMode(val as ThemeMode)}
            aria-label="主题模式选项"
            className="grid grid-cols-1 sm:grid-cols-3 gap-3.5"
          >
            {modeOptions.map((option) => {
              const isSelected = themeMode === option.id;
              const isPreviewingThis = urlTheme === option.id;
              const Icon = option.icon;

              return (
                <Radio.Root
                  key={option.id}
                  value={option.id}
                  aria-label={option.label}
                  className={cn(
                    "group relative flex flex-col justify-between rounded-xl border p-3.5 text-left transition-all cursor-pointer select-none",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    isSelected
                      ? "border-foreground bg-surface-raised shadow-sm"
                      : "border-border/80 bg-surface/50 hover:border-border hover:bg-surface-raised/60"
                  )}
                >
                  {/* Miniature Illustration Mockup */}
                  <div className="mb-3 overflow-hidden rounded-lg border border-border/70 shadow-xs">
                    {option.id === "light" && (
                      <div className="h-20 bg-slate-100 p-2 flex flex-col justify-between">
                        <div className="flex items-center gap-1">
                          <div className="size-1.5 rounded-full bg-slate-300" />
                          <div className="size-1.5 rounded-full bg-slate-300" />
                          <div className="size-1.5 rounded-full bg-slate-300" />
                          <div className="ml-2 h-1.5 w-10 rounded-full bg-slate-300/80" />
                        </div>
                        <div className="space-y-1.5">
                          <div className="h-2 w-3/4 rounded-full bg-slate-300" />
                          <div className="h-2 w-1/2 rounded-full bg-slate-200" />
                        </div>
                        <div className="h-2 w-full rounded bg-slate-800" />
                      </div>
                    )}

                    {option.id === "dark" && (
                      <div className="h-20 bg-[#111317] p-2 flex flex-col justify-between">
                        <div className="flex items-center gap-1">
                          <div className="size-1.5 rounded-full bg-slate-700" />
                          <div className="size-1.5 rounded-full bg-slate-700" />
                          <div className="size-1.5 rounded-full bg-slate-700" />
                          <div className="ml-2 h-1.5 w-10 rounded-full bg-slate-700/80" />
                        </div>
                        <div className="space-y-1.5">
                          <div className="h-2 w-3/4 rounded-full bg-slate-600" />
                          <div className="h-2 w-1/2 rounded-full bg-slate-700" />
                        </div>
                        <div className="h-2 w-full rounded bg-slate-200" />
                      </div>
                    )}

                    {option.id === "system" && (
                      <div className="relative h-20 overflow-hidden flex flex-col justify-between">
                        {/* Diagonal split representation */}
                        <div className="absolute inset-0 bg-slate-100 [clip-path:polygon(0_0,100%_0,0_100%)] p-2">
                          <div className="flex items-center gap-1">
                            <div className="size-1.5 rounded-full bg-slate-300" />
                            <div className="size-1.5 rounded-full bg-slate-300" />
                            <div className="ml-1 h-1.5 w-8 rounded-full bg-slate-300/80" />
                          </div>
                          <div className="mt-2 h-2 w-1/2 rounded-full bg-slate-300" />
                        </div>
                        <div className="absolute inset-0 bg-[#111317] [clip-path:polygon(100%_0,100%_100%,0_100%)] p-2 flex flex-col justify-end items-end">
                          <div className="h-2 w-1/2 rounded-full bg-slate-600 mb-1" />
                          <div className="h-2 w-3/4 rounded bg-slate-200" />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Card Title & Icon */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground group-hover:text-foreground" />
                      <span className="text-sm font-medium text-foreground">{option.label}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isPreviewingThis && (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 border border-amber-500/20">
                          临时预览中
                        </span>
                      )}
                      {isSelected && (
                        <div className="flex size-4 items-center justify-center rounded-full bg-foreground text-background">
                          <CheckIcon className="size-3 stroke-[2.5]" />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Dynamic Note for System Option */}
                  {option.description && (
                    <div className="mt-1 text-[11px] text-muted-foreground font-sans">
                      {option.description}
                    </div>
                  )}
                </Radio.Root>
              );
            })}
          </RadioGroup>

          {/* Scope and Save Feedback */}
          <div className="rounded-lg border border-border/70 bg-surface/30 p-3.5 space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                保存范围：<strong className="text-foreground font-medium">仅保存在当前浏览器</strong>。同一浏览器中不同管理账号共用；登录前也沿用该站点主题。
              </span>
              <div className="shrink-0">
                {urlTheme ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500 border border-amber-500/20 font-medium">
                    <AlertCircleIcon className="size-3" />
                    临时预览中（未保存到当前浏览器）
                  </span>
                ) : themeStorageError ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500 border border-amber-500/20 font-medium">
                    已临时应用，无法保存在此浏览器
                  </span>
                ) : themeStorageStatus === "default" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground border border-border/50 font-medium">
                    默认偏好（未在此浏览器保存修改）
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-medium">
                    <CheckIcon className="size-3" />
                    已保存到当前浏览器
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Account Security Quick Navigation */}
          <div className="rounded-xl border border-border bg-surface-raised/40 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldIcon className="size-4 text-muted-foreground" />
                <span>账号安全与认证设置</span>
              </div>
              <p className="text-xs text-muted-foreground max-w-md">
                修改登录密码、配置快捷 PIN 码、双因素认证 (TOTP)、闲置自动锁定及紧急会话恢复。
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenPath("/account", "账号安全")}
              className="shrink-0 text-xs gap-1.5"
            >
              <span>前往账号安全页</span>
            </Button>
          </div>
        </div>

        {/* Right Column: Live Interface Preview */}
        <div className="lg:col-span-5 xl:col-span-4 space-y-3">
          <div className="flex items-center justify-between text-xs font-mono uppercase tracking-wider text-muted-foreground">
            <span>界面预览</span>
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-foreground font-sans">
              当前渲染：{theme === "dark" ? "深色" : "浅色"}
            </span>
          </div>

          {/* Miniature Shell Mockup Reflecting Active Theme Tokens */}
          <div className="overflow-hidden rounded-xl border border-border bg-background shadow-md">
            {/* Window Topbar */}
            <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-2">
              <div className="flex items-center gap-1.5">
                <div className="size-2 rounded-full bg-destructive/70" />
                <div className="size-2 rounded-full bg-amber-500/70" />
                <div className="size-2 rounded-full bg-emerald-500/70" />
              </div>
              <div className="text-[10px] font-mono tracking-wider text-muted-foreground">
                ZZSH · CONSOLE
              </div>
              <div className="w-8" />
            </div>

            {/* Window Content Layout */}
            <div className="flex h-64 overflow-hidden">
              {/* Mini Sidebar */}
              <div className="w-16 sm:w-20 border-r border-border bg-surface-soft p-2 space-y-2 shrink-0">
                <div className="h-2 w-10 rounded bg-muted-foreground/30" />
                <div className="mt-3 space-y-1.5">
                  <div className="h-1.5 w-12 rounded bg-muted-foreground/20" />
                  <div className="h-1.5 w-10 rounded bg-muted-foreground/20" />
                  <div className="h-1.5 w-8 rounded bg-muted-foreground/20" />
                </div>
                <div className="mt-4 pt-3 border-t border-border space-y-1.5">
                  <div className="h-1.5 w-9 rounded bg-muted-foreground/20" />
                  <div className="h-1.5 w-11 rounded bg-muted-foreground/20" />
                </div>
              </div>

              {/* Mini Main Content Area */}
              <div className="flex-1 p-3 bg-background flex flex-col justify-between overflow-hidden">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="h-3 w-20 rounded bg-foreground/70" />
                    <div className="h-2.5 w-10 rounded bg-muted" />
                  </div>
                  {/* Sample Card Skeleton */}
                  <div className="rounded-md border border-border bg-surface-raised p-2 space-y-1.5">
                    <div className="h-2 w-16 rounded bg-muted-foreground/50" />
                    <div className="h-1.5 w-28 rounded bg-muted-foreground/30" />
                    <div className="mt-1 flex items-center justify-between pt-1 border-t border-border/40">
                      <div className="h-1.5 w-12 rounded bg-muted-foreground/30" />
                      <div className="h-2 w-5 rounded-full bg-primary/40" />
                    </div>
                  </div>
                  {/* Sample Table Rows Skeleton */}
                  <div className="rounded-md border border-border/60 p-1.5 space-y-1">
                    <div className="h-1.5 w-full rounded bg-muted/70" />
                    <div className="h-1.5 w-4/5 rounded bg-muted/50" />
                    <div className="h-1.5 w-3/5 rounded bg-muted/40" />
                  </div>
                </div>

                {/* Mini Preview Status Footer */}
                <div className="pt-2 border-t border-border flex items-center justify-between text-[9px] font-mono text-muted-foreground">
                  <span>模式：{themeMode === "system" ? "跟随系统" : themeMode === "dark" ? "深色" : "浅色"}</span>
                  <span className="font-sans text-[9px] text-foreground font-medium">
                    {theme === "dark" ? "Dark Theme" : "Light Theme"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
