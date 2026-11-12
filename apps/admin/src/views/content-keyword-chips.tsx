import { useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

/**
 * 搜索关键词 chips 输入（Owner UX round2 缺陷 4）：回车/逗号添加、可删除、去重、上限提示。
 * 底层合同不变：value/onChange 仍是 string[]，服务端 strings(keywords, 30, 100) 校验照旧。
 * 仅替换“每行一词”的大 textarea，不新增依赖，复用原生 input + lucide 图标。
 */
export type ContentKeywordChipsProps = {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** 最多关键词个数，与合同 strings(count=30) 对齐。 */
  max?: number;
  /** 单个关键词最大字符数，与合同 text(max=100) 对齐。 */
  maxLength?: number;
  placeholder?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
};

const splitTokens = (raw: string) => raw.split(/[,，\n]/).map(token => token.trim()).filter(Boolean);

export function ContentKeywordChips({
  id,
  value,
  onChange,
  disabled = false,
  max = 30,
  maxLength = 100,
  placeholder = "输入关键词，回车或逗号添加",
  ...rest
}: ContentKeywordChipsProps) {
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const atMax = value.length >= max;

  const commit = (raw: string) => {
    const tokens = splitTokens(raw);
    setDraft("");
    if (!tokens.length) return;
    const next = [...value];
    let issue: string | null = null;
    for (const token of tokens) {
      if (next.length >= max) { issue = `最多 ${max} 个关键词，已达上限。`; break; }
      const word = token.length > maxLength ? token.slice(0, maxLength) : token;
      if (token.length > maxLength) issue = `每个关键词最多 ${maxLength} 字，超出部分已截断。`;
      if (next.includes(word)) { issue = `「${word}」已存在，未重复添加。`; continue; }
      next.push(word);
    }
    if (next.length !== value.length) onChange(next);
    setNotice(issue);
  };

  const remove = (word: string) => { if (!disabled) { onChange(value.filter(entry => entry !== word)); setNotice(null); } };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === "Enter" || event.key === "," || event.key === "，") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && value.length) {
      const last = value[value.length - 1];
      if (last !== undefined) { event.preventDefault(); remove(last); }
    }
  };

  return (
    <div className="content-chips" data-disabled={disabled || undefined}>
      <div className="content-chips-box" onClick={() => { if (!disabled && !atMax) inputRef.current?.focus(); }}>
        {value.map(word => (
          <span className="content-chip" key={word}>
            <span className="content-chip-text">{word}</span>
            <button
              type="button"
              className="content-chip-remove"
              disabled={disabled}
              aria-label={`删除关键词 ${word}`}
              onClick={event => { event.stopPropagation(); remove(word); }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          className="content-chips-input"
          value={draft}
          disabled={disabled || atMax}
          placeholder={value.length ? (atMax ? "已达上限" : "继续添加…") : placeholder}
          aria-label={rest["aria-label"] ?? "搜索关键词"}
          aria-describedby={rest["aria-describedby"]}
          onChange={event => {
            const next = event.target.value;
            if (/[,，\n]/.test(next)) commit(next);
            else { setDraft(next); if (notice) setNotice(null); }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => { if (draft.trim()) commit(draft); }}
        />
      </div>
      <div className="content-chips-meta">
        <span className="content-chips-count">{value.length} / {max}</span>
        {notice ? <span className="content-chips-notice" role="status">{notice}</span>
          : atMax ? <span className="content-chips-notice">已达上限，删除后可继续添加。</span>
            : <span className="content-chips-hint">回车或逗号添加，点击 × 删除。</span>}
      </div>
    </div>
  );
}