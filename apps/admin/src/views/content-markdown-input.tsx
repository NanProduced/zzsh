import MDEditor from "@uiw/react-md-editor/nohighlight";
import { getCommands } from "@uiw/react-md-editor/commands-cn";
import { useEffect, useState } from "react";

export const contentMarkdownCommands = getCommands().filter(command => command.name !== "image" && command.name !== "fullscreen" && command.name !== "comment");
export default function ContentMarkdownInput({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const getTheme = () => document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState<"dark" | "light">(getTheme);
  useEffect(() => { const observer = new MutationObserver(() => setTheme(getTheme())); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] }); return () => observer.disconnect(); }, []);
  return <div className="content-markdown-input" data-color-mode={theme}>
    <MDEditor value={value} onChange={source => onChange(source ?? "")} preview="edit" commands={contentMarkdownCommands} extraCommands={[]} height={560} visibleDragbar={false} disabled={disabled} textareaProps={{ "aria-label": "Markdown 正文", spellCheck: false, disabled }} />
  </div>;
}
