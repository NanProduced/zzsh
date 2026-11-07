/**
 * 金额单位适配（纯文本，无浮点）。
 * 元→分的精确解析器唯一实现放在这里；管理端 `membership-entitlement-form` 再导出，
 * 避免出现第二份解析器（历史实现与此逐字等价，未改变语义）。
 * 不同端共用参考单价的显示舍入；实际账务以服务端金额为准。
 */

/** 合法元值输入：非负十进制，最多两位小数；其它一律 null，不猜测、不四舍五入。 */
export function parseYuanToCents(yuan: string | undefined): string | null {
  if (typeof yuan !== 'string') return null;
  const trimmed = yuan.trim();
  if (!trimmed || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents.toString();
}

/** 兼容旧接口的元字符串，只补齐无损的零；含非整分时交由服务端重新计算。 */
export function formatExactYuan(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d{0,23})(?:\.(\d{1,8}))?$/.exec(value);
  if (!match || /[1-9]/.test((match[2] ?? "").slice(2))) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0").slice(0, 2)}`;
}

/** 仅格式化参考单价，不用于重新计算应付或结算。 */
export function formatReferenceYuan(value: unknown, options?: { grouped?: boolean }): string | null {
  if (typeof value !== "string") return null;
  if (value === "< ¥0.01") return value;
  const match = /^(约\s*)?¥?(\d{1,40})(?:\.(\d{1,16}))?(（不足1分）)?$/.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? "", digits = fraction.padEnd(3, "0");
  const cents = BigInt(match[2]!) * 100n + BigInt(digits.slice(0, 2)) + (digits[2]! >= "5" ? 1n : 0n);
  const rounded = Boolean(match[1]) || /[1-9]/.test(fraction.slice(2));
  const nonzero = BigInt(match[2]!) !== 0n || /[1-9]/.test(fraction) || Boolean(match[4]);
  const whole=(cents / 100n).toString(), display=options?.grouped?whole.replace(/\B(?=(\d{3})+(?!\d))/g,","):whole;
  const label = `${rounded ? "约 " : ""}¥${display}.${(cents % 100n).toString().padStart(2, "0")}`;
  return nonzero && cents === 0n ? "< ¥0.01" : label;
}

/** 输入框说明：依据与输入必须同单位；`maxYuan` 由调用方用本端格式化器给出。 */
export function yuanInputHint(maxYuan?: string | null): string {
  return maxYuan ? `按元填写，最多两位小数；上限 ${maxYuan} 元` : "按元填写，最多两位小数";
}
