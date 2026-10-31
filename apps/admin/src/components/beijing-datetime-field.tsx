import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MembershipDateTimeField, beijingInputToUtc, utcToBeijingInput } from "@/views/membership-entitlement-form";

/**
 * 统一的北京时间日期时间选择器（复用 MembershipDateTimeField 的日历 + 时分弹层）。
 * value / onChange 使用与原 datetime-local 相同的 "YYYY-MM-DDTHH:mm"（北京时间）字符串，语义不变。
 */
export function BeijingDateTimeField({
  label,
  value,
  onChange,
  disabled = false,
  clearable = true,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  clearable?: boolean;
  invalid?: boolean;
}) {
  return (
    <div className="relative" aria-invalid={invalid || undefined} data-beijing-datetime="">
      <MembershipDateTimeField
        label={label}
        value={value ? beijingInputToUtc(value) : ""}
        disabled={disabled}
        onChange={(utc) => onChange(utc ? utcToBeijingInput(utc) : "")}
      />
      <input
        type="text"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-beijing-datetime-input=""
        aria-label={`${label}（北京时间，YYYY-MM-DDTHH:mm）`}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === "" || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(next)) onChange(next);
        }}
      />
      {clearable && value && !disabled ? (
        <Button type="button" variant="ghost" size="xs" aria-label={`清除${label}`} className="absolute right-0 top-0 h-5 px-1 text-[10px]" onClick={() => onChange("")}>
          <XIcon className="size-3" />
          清除
        </Button>
      ) : null}
    </div>
  );
}

/** ISO(UTC) 值的便捷包装：内部按北京时间展示与选择。 */
export function BeijingInstantField({ label, value, onChange, disabled }: { label: string; value: string | null | undefined; onChange: (iso: string | null) => void; disabled?: boolean }) {
  return (
    <BeijingDateTimeField
      label={label}
      value={value ? utcToBeijingInput(value) : ""}
      disabled={disabled}
      onChange={(local) => onChange(local ? beijingInputToUtc(local) || null : null)}
    />
  );
}
