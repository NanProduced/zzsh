/** Display-only rounding; the server's original amount remains the pricing and settlement truth. */
export function formatUnitYuan(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(-?)(\d{1,40})(?:\.(\d{1,8}))?$/.exec(value);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2)) + (fraction[2] && fraction[2] >= "5" ? 1n : 0n);
  const nonzero = /[1-9]/.test(whole! + fraction);
  if (cents === 0n && nonzero) return sign ? "> -¥0.01" : "< ¥0.01";
  const rounded = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  const approximate = /[1-9]/.test(fraction.slice(2)) ? "约 " : "";
  return `${approximate}${sign && cents !== 0n ? "-" : ""}¥${rounded}`;
}
