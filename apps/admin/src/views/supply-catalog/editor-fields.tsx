import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SupplySelect } from "@/components/supply/supply-select";

import type { CatalogSkin, CatalogSkinOwner } from "../../api";
import { skinValues } from "../catalog-skin-fields";
import type { CatalogKind, PendingCatalogWrite } from "./model";

export type EditorState = { kind: CatalogKind; id?: string; values: Record<string, string>; revision?: string; confirm?: boolean; original?: CatalogSkin | CatalogSkinOwner; baseline?: string };
export type WriteIntent = PendingCatalogWrite & { scope: string; sequence: number; uncertain?: boolean; restored?: boolean; continueWith?: Record<string, string> };
export type WritePhase = "idle" | "saving" | "unknown" | "conflict" | "readback";

export const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="space-y-1 text-xs block">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

export function LabeledSelect({
  label,
  value,
  items,
  onValueChange,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <SupplySelect label={label} value={value} options={items} disabled={disabled} onValueChange={onValueChange} />
    </Field>
  );
}

export function editorValuesFor(kind: CatalogKind, record?: Record<string, unknown>): Record<string, string> {
  const base: Record<string, string> = { code: "", name: "" };
  if (kind === "items") return { ...base, unit: "PIECE", quantityScale: "0", required: "false", enabled: "true", sortOrder: "0", sourceField: "", sourceToken: "", sourceNote: "" };
  if (kind === "categories") return { ...base, parentId: "", sortOrder: "0", enabled: "true", formVisible: "true" };
  if (kind === "skins") return { ...base, categoryId: "", rarityCode: "", sortOrder: "0", enabled: "false", formVisible: "false", ...skinValues() };
  if (kind === "skin-owners") return { ...base, enabled: "true", ...skinValues() };
  if (kind === "rarities") return { ...base, sortOrder: "0", enabled: "true" };
  return { ...base, valueKind: "FLAG", expiryKind: "PERMANENT", enabled: "true", sortOrder: "0", sourceField: "", sourceToken: "" };
}

export function recordValues(kind: CatalogKind, record: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) values[key] = "";
    else values[key] = typeof value === "boolean" ? String(value) : String(value);
  }
  return values;
}

export function toPayload(kind: Exclude<CatalogKind, "skins" | "skin-owners">, values: Record<string, string>, editing: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const put = (field: string, key: string, parse: (value: string) => unknown = (value) => value) => {
    if (values[field] === undefined || values[field] === "") return;
    payload[key] = parse(values[field]!);
  };
  if (!editing) payload.code = values.code;
  payload.name = values.name;
  if (kind === "items") {
    put("unit", "unit");
    put("quantityScale", "quantityScale", Number);
    put("required", "required", (value) => value === "true");
    put("enabled", "enabled", (value) => value === "true");
    put("sortOrder", "sortOrder", Number);
    put("sourceField", "sourceField");
    put("sourceToken", "sourceToken");
    put("sourceNote", "sourceNote");
    if (editing && values.mediaId !== undefined) payload.mediaId = values.mediaId === "" ? null : values.mediaId;
  } else if (kind === "categories") {
    payload.parentId = values.parentId === "" ? null : values.parentId;
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
    put("formVisible", "formVisible", (value) => value === "true");
  } else if (kind === "rarities") {
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
  } else {
    put("valueKind", "valueKind");
    put("expiryKind", "expiryKind");
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
    put("sourceField", "sourceField");
    put("sourceToken", "sourceToken");
  }
  return payload;
}

export function validateEditor(kind: CatalogKind, values: Record<string, string>, editing: boolean): string | undefined {
  if (!editing && !CODE_PATTERN.test(values.code ?? "")) return "稳定 code 需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。";
  if (!values.name || values.name.trim().length === 0) return "名称不能为空。";
  if (kind === "items" && !["HAFF_BASE", "ROUND", "PIECE", "DAY"].includes(values.unit ?? "")) return "单位无效。";
  return undefined;
}

export function GameCreateForm({ draft, setDraft, onSubmit, loading, className }: { draft: { code: string; name: string; description: string }; setDraft: (draft: { code: string; name: string; description: string }) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; className?: string }) {
  return (
    <form onSubmit={onSubmit} className={"grid grid-cols-1 gap-3 md:grid-cols-3 " + (className ?? "")} noValidate>
      <Field label="稳定 code"><Input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} className="h-9 text-xs" placeholder="delta" /></Field>
      <Field label="名称"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="h-9 text-xs" placeholder="三角洲行动" /></Field>
      <Field label="描述（可选）"><Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="h-9 text-xs" /></Field>
      <div className="flex flex-wrap items-center gap-2 md:col-span-3">
        <Button type="submit" size="sm" disabled={loading}>{loading ? "创建中…" : "创建游戏"}</Button>
        <span className="text-xs text-muted-foreground">创建后下一步：维护六类词条，再到规则与价目、素材审核。</span>
      </div>
    </form>
  );
}
