export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "zzsh-user-theme";

export function resolveSavedTheme(value: string | null): Theme { return value === "light" ? "light" : "dark"; }

export function applyTheme(theme: Theme): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  const resolved = resolveSavedTheme(theme);
  const root = document.documentElement;

  if (resolved === "dark") {
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
  } else {
    root.classList.remove("dark");
    root.setAttribute("data-theme", "light");
  }

  return resolved;
}
