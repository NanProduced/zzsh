// Source: https://platejs.org/r/code-block-node.json — Plate UI (MIT)
// Adapted: removed lowlight syntax highlighting, the language combobox (writes
// a `lang` attribute outside the storage whitelist) and the format button.
// Kept structure + clipboard copy only; code is never executed or highlighted.
// `!` padding wins over the unlayered shared pre rules in plate-document.css.
import { useEffect, useState } from "react";

import { Check, Copy } from "lucide-react";
import { NodeApi, type TCodeBlockElement } from "platejs";
import { PlateElement, type PlateElementProps } from "platejs/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function CodeBlockElement(props: PlateElementProps<TCodeBlockElement>) {
  const { element } = props;

  return (
    <PlateElement {...props} className={cn("py-1", props.className)}>
      <div className="relative rounded-md border border-border bg-muted/50">
        <pre className="overflow-x-auto p-4! pr-12! font-mono text-sm leading-normal [tab-size:2]">
          <code>{props.children}</code>
        </pre>

        <div className="absolute top-1.5 right-1.5 z-10 flex select-none gap-0.5" contentEditable={false}>
          <CopyButton value={() => NodeApi.string(element)} />
        </div>
      </div>
    </PlateElement>
  );
}

function CopyButton({ value }: { value: () => string }) {
  const [hasCopied, setHasCopied] = useState(false);

  useEffect(() => {
    if (!hasCopied) return;
    const timer = setTimeout(() => setHasCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [hasCopied]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-muted-foreground hover:text-foreground"
          aria-label={hasCopied ? "已复制" : "复制代码"}
          onClick={() => {
            if (!navigator.clipboard) return;
            void navigator.clipboard.writeText(value());
            setHasCopied(true);
          }}
        >
          {hasCopied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hasCopied ? "已复制" : "复制代码"}</TooltipContent>
    </Tooltip>
  );
}

export function CodeLineElement(props: PlateElementProps) {
  return <PlateElement {...props} />;
}
