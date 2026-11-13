// These cases exercise chat or presence writes after the connection is granted.
export function grantedSupportConnection(pathname, method) {
  if (method !== "POST") return undefined;
  if (pathname.endsWith("/im/presence/connect")) return Response.json({ ok: true, reason: "CLAIMED" });
  if (pathname.endsWith("/im/presence/connection")) return Response.json({ ok: true, reason: "OWNED" });
}
