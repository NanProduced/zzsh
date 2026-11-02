import { useState, forwardRef, type InputHTMLAttributes, type ButtonHTMLAttributes } from "react";
import { AlertCircle, CheckCircle2, CheckIcon, Info, LaptopIcon, MoonIcon, SunIcon, TriangleAlert } from "lucide-react";
import { Icons } from "./icons";
import { Alert, AlertDescription } from "./ui/alert";

/**
 * Page-level result / responsibility message. `themeAware` is kept so existing
 * callers keep compiling; theme adaptation now comes from the shared Alert tokens.
 */
export function StatusMessage({
  error,
  success,
  className = "",
  tone,
}: {
  error?: string;
  success?: string;
  className?: string;
  themeAware?: boolean;
  tone?: "warning" | "info";
}) {
  if (!error && !success) return null;
  const variant = tone ?? (error ? "destructive" : "success");
  const Icon = variant === "destructive" ? AlertCircle : variant === "warning" ? TriangleAlert : variant === "info" ? Info : CheckCircle2;

  return (
    <Alert
      variant={variant}
      role={variant === "destructive" || variant === "warning" ? "alert" : "status"}
      data-slot="status-message"
      className={className}
    >
      <Icon aria-hidden="true" />
      <AlertDescription className="text-foreground/85">{error || success}</AlertDescription>
    </Alert>
  );
}

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle({
  theme,
  mode,
  onSelectMode,
  onToggle,
}: {
  theme: "dark" | "light";
  mode?: "light" | "dark" | "system";
  onSelectMode?: (mode: "light" | "dark" | "system") => void;
  onToggle?: () => void;
}) {
  if (onSelectMode) {
    const currentMode = mode ?? (theme === "dark" ? "dark" : "light");
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`主题模式：${currentMode === "light" ? "浅色" : currentMode === "dark" ? "深色" : "跟随系统"}`}
              title={`主题：${currentMode === "light" ? "浅色" : currentMode === "dark" ? "深色" : "跟随系统"}`}
              className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {currentMode === "system" ? (
                <LaptopIcon size={15} />
              ) : theme === "dark" ? (
                <MoonIcon size={15} />
              ) : (
                <SunIcon size={15} />
              )}
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onClick={() => onSelectMode("light")}>
            <SunIcon size={15} />
            <span>浅色</span>
            {currentMode === "light" ? <CheckIcon className="ms-auto size-4" /> : null}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSelectMode("dark")}>
            <MoonIcon size={15} />
            <span>深色</span>
            {currentMode === "dark" ? <CheckIcon className="ms-auto size-4" /> : null}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSelectMode("system")}>
            <LaptopIcon size={15} />
            <span>跟随系统</span>
            {currentMode === "system" ? <CheckIcon className="ms-auto size-4" /> : null}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
      title={theme === "dark" ? "浅色主题" : "深色主题"}
      className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {theme === "dark" ? <Icons.Sun size={15} /> : <Icons.Moon size={15} />}
    </button>
  );
}

export const PasswordInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className = "", ...props }, ref) => {
  const [show, setShow] = useState(false);

  return (
    <div className="relative flex items-center">
      <input
        ref={ref}
        type={show ? "text" : "password"}
        className={`w-full pr-10 ${className}`}
        {...props}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "隐藏密码" : "显示密码"}
        className="absolute right-2.5 rounded p-1 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {show ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
      </button>
    </div>
  );
});

PasswordInput.displayName = "PasswordInput";

export { Button } from "./ui/button";
