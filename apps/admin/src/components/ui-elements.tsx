import { useState, forwardRef, type InputHTMLAttributes, type ButtonHTMLAttributes } from "react";
import { Icons } from "./icons";

export function StatusMessage({
  error,
  success,
  className = "",
}: {
  error?: string;
  success?: string;
  className?: string;
}) {
  if (!error && !success) return null;
  const isError = Boolean(error);

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live="polite"
      className={`flex items-start gap-2.5 p-3 rounded-md text-xs leading-relaxed transition-all ${
        isError
          ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
          : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
      } ${className}`}
    >
      <span className="shrink-0 mt-0.5">
        {isError ? (
          <Icons.AlertCircle size={15} className="text-rose-400" />
        ) : (
          <Icons.CheckCircle2 size={15} className="text-emerald-400" />
        )}
      </span>
      <span className="flex-1 break-words">{error ?? success}</span>
    </div>
  );
}

export function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: "dark" | "light";
  onToggle: () => void;
}) {
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
        tabIndex={-1}
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "隐藏密码" : "显示密码"}
        className="absolute right-2.5 p-1 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none"
      >
        {show ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
      </button>
    </div>
  );
});

PasswordInput.displayName = "PasswordInput";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    loading?: boolean;
    size?: "sm" | "md" | "lg";
  }
>(({ children, variant = "primary", loading = false, size = "md", className = "", disabled, ...props }, ref) => {
  const sizeClasses = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 text-sm",
    lg: "h-11 px-5 text-sm",
  }[size];

  const variantClasses = {
    primary:
      "bg-foreground text-background font-medium hover:opacity-90 active:scale-[0.99] transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-ring",
    secondary:
      "bg-surface-raised text-foreground border border-border hover:bg-border/40 active:scale-[0.99] transition-all focus-visible:ring-2 focus-visible:ring-ring",
    ghost:
      "text-muted-foreground hover:text-foreground hover:bg-surface-raised transition-colors focus-visible:ring-2 focus-visible:ring-ring",
    danger:
      "bg-rose-600 text-white font-medium hover:bg-rose-700 active:scale-[0.99] transition-all focus-visible:ring-2 focus-visible:ring-rose-500",
  }[variant];

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`relative inline-flex items-center justify-center gap-2 rounded-md font-medium select-none disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none ${sizeClasses} ${variantClasses} ${className}`}
      {...props}
    >
      {loading ? (
        <>
          <Icons.RefreshCw size={15} className="animate-spin" />
          <span>处理中…</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

Button.displayName = "Button";
