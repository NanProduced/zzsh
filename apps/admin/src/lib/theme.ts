import type { Theme, ThemeMode } from "../api";

export const THEME_KEY = "zzsh-admin-theme";

export function getSystemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

export type ThemeStorageStatus = "saved" | "default" | "error";

export function readStoredThemeState(): { mode: ThemeMode; status: ThemeStorageStatus } {
  if (typeof window === "undefined") return { mode: "dark", status: "default" };
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") {
      return { mode: raw, status: "saved" };
    }
    return { mode: "dark", status: "default" };
  } catch {
    return { mode: "dark", status: "error" };
  }
}

export function readSavedThemeMode(): ThemeMode {
  return readStoredThemeState().mode;
}

export function saveThemeMode(mode: ThemeMode): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(THEME_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export function resetThemeMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(THEME_KEY, "dark");
    return true;
  } catch {
    return false;
  }
}

export function readUrlTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const urlTheme = new URLSearchParams(window.location.search).get("theme");
    if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
  } catch {
    // Invalid URL or search params
  }
  return null;
}

export function clearUrlTheme(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("theme")) {
      url.searchParams.delete("theme");
      const newSearch = url.searchParams.toString();
      const nextPath = `${url.pathname}${newSearch ? `?${newSearch}` : ""}${url.hash}`;
      window.history.replaceState(window.history.state, "", nextPath);
    }
  } catch {
    // Ignore history error
  }
}

export function resolveTheme(mode: ThemeMode, urlTheme?: Theme | null): Theme {
  if (urlTheme === "light" || urlTheme === "dark") {
    return urlTheme;
  }
  if (mode === "system") {
    return getSystemTheme();
  }
  return mode;
}

export function applyThemeToDom(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function resolveInitialTheme(): { mode: ThemeMode; resolvedTheme: Theme; status: ThemeStorageStatus } {
  const { mode, status } = readStoredThemeState();
  const urlTheme = readUrlTheme();
  const resolvedTheme = resolveTheme(mode, urlTheme);
  return { mode, resolvedTheme, status };
}
