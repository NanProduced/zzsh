/**
 * 金额单位适配（纯文本，无浮点）。
 * 元→分的精确解析器唯一实现放在这里；管理端 `membership-entitlement-form` 再导出，
 * 避免出现第二份解析器（历史实现与此逐字等价，未改变语义）。
 * 分→元展示继续由各端已有格式化器负责，本模块不重复实现。
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

/** 输入框说明：依据与输入必须同单位；`maxYuan` 由调用方用本端格式化器给出。 */
export function yuanInputHint(maxYuan?: string | null): string {
  return maxYuan ? `按元填写，最多两位小数；上限 ${maxYuan} 元` : "按元填写，最多两位小数";
}
