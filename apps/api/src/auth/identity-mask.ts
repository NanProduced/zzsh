export function maskRealName(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length <= 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

export function maskIdCard(id: string): string {
  const chars = Array.from(id.trim());
  if (chars.length === 18) return `${chars.slice(0, 6).join("")}${"*".repeat(8)}${chars.slice(14).join("")}`;
  if (chars.length <= 4) return "*".repeat(chars.length);
  return `${"*".repeat(chars.length - 4)}${chars.slice(-4).join("")}`;
}
