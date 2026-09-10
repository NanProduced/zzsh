import type { ReactNode } from "react";
import { BrandLogo } from "./brand-logo";
import { ThemeToggle } from "./ui-elements";
import { AuthShell, type AuthShellVariant } from "./devl/auth-shell";

type AuthLayoutProps = {
  children: ReactNode;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  variant?: AuthShellVariant;
  forceMobile?: boolean;
};

export function AuthLayout({
  children,
  theme,
  onToggleTheme,
  variant = "welcome",
  forceMobile = false,
}: AuthLayoutProps) {
  const brandTag = (
    <div className="flex items-center gap-2.5">
      <BrandLogo variant="horizontal" height={56} />
      <span className="rounded border border-border/70 bg-surface-raised/80 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground">
        CONSOLE
      </span>
    </div>
  );

  const mobileBrandTag = (
    <div className="flex items-center gap-2">
      <BrandLogo variant="horizontal" height={40} />
      <span className="rounded border border-border/70 bg-surface-raised/80 px-1 py-0.5 font-mono text-[9px] tracking-wider text-muted-foreground">
        CONSOLE
      </span>
    </div>
  );

  return (
    <AuthShell
      forceMobile={forceMobile}
      variant={variant}
      brandTag={brandTag}
      mobileBrandTag={mobileBrandTag}
      topRight={<ThemeToggle theme={theme} onToggle={onToggleTheme} />}
    >
      {children}
    </AuthShell>
  );
}
