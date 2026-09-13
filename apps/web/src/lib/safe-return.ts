// Only same-site absolute paths may be used as post-login return targets.
export function safeReturnTo(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.normalize("NFKC").trim();
  if (!path.startsWith("/")) return undefined;
  if (path.startsWith("//") || path.startsWith("/\\")) return undefined;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return undefined;
  if (path.length > 512) return undefined;
  return path;
}
