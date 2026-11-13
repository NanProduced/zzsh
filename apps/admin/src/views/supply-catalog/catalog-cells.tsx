import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SupplySelect } from "@/components/supply/supply-select";
import { CheckIcon, CopyIcon } from "lucide-react";

import { IDENTITY_LABEL } from "./model";

export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied("idle"), 1600);
  };
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/80 hover:text-foreground transition-colors group">
      <span className="font-mono text-xs truncate max-w-40">{code}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-5 p-0 text-muted-foreground/60 hover:text-foreground opacity-60 group-hover:opacity-100 transition-opacity"
        aria-label={`复制稳定 code ${code}`}
        onClick={() => void copy()}
      >
        {copied === "done" ? <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" /> : <CopyIcon className="size-3" />}
      </Button>
      {copied === "done" ? <span className="text-xs text-emerald-600 dark:text-emerald-400">已复制</span> : null}
      {copied === "failed" ? <span className="text-xs text-destructive">复制失败</span> : null}
    </span>
  );
}

export function StateBadge({ on, onLabel, offLabel, field }: { on: boolean; onLabel: string; offLabel: string; field?: "enabled" | "formVisible" }) {
  if (on) {
    return (
      <Badge
        variant="secondary"
        className={field === "formVisible" ? "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20 text-xs font-medium" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-xs font-medium"}
      >
        {onLabel}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground/80 border-border/60 text-xs font-normal">
      {offLabel}
    </Badge>
  );
}

export function NamingStateBadge({ state }: { state: string }) {
  if (state === "VERIFIED") {
    return (
      <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-xs font-medium">
        已核实
      </Badge>
    );
  }
  if (state === "PENDING") {
    return (
      <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 text-xs font-semibold">
        待核实
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground/80 border-border/60 text-xs">
      {IDENTITY_LABEL[state as keyof typeof IDENTITY_LABEL] ?? state}
    </Badge>
  );
}

export function CellSelect({
  label,
  value,
  items,
  onValueChange,
  disabled,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <SupplySelect label={label} value={value} options={items} disabled={disabled} onValueChange={onValueChange} className="h-8 text-xs" />
  );
}

export function CellInput({
  label,
  value,
  onValueChange,
  type = "text",
  disabled,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  type?: "text" | "number";
  disabled?: boolean;
}) {
  return (
    <Input
      aria-label={label}
      type={type}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
      className="h-8 w-full text-xs"
    />
  );
}
