/** Canonical form used by every phone auth operation: +86 followed by 11 digits. */
export function normalizeMainlandPhone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const compact = value.trim().replace(/[\s-]/g, "");
  const digits = compact.startsWith("+86") ? compact.slice(3) : compact.startsWith("0086") ? compact.slice(4) : compact;
  return /^1[3-9]\d{9}$/.test(digits) ? `+86${digits}` : null;
}
