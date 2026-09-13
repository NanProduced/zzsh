"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return <div className={`theme-toggle ${className}`} role="group" aria-label="切换色彩主题">
    <button className="icon-button" aria-label={theme === "dark" ? "切换为浅色" : "切换为深色"} title={theme === "dark" ? "切换为浅色" : "切换为深色"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
  </div>;
}
