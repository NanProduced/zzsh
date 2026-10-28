import type { Pool, PoolClient } from "pg";

/** B5: read-only masked identity display. Full values never leave this module and are never logged. */
export const IDENTITY_MASKING_VERSION = "identity-mask-v1" as const;
export interface IdentityDisplay { realNameMasked: string; idCardMasked: string; maskingVersion: typeof IDENTITY_MASKING_VERSION }
export type IdentityDisplayResult = { identityDisplay: IdentityDisplay; identityDisplayReason: null }
  | { identityDisplay: null; identityDisplayReason: "NOT_RECORDED" | "NOT_VERIFIED" | "STORE_UNAVAILABLE" };

export function maskRealName(name: string): string {
  const c = Array.from(name.trim());
  if (c.length <= 1) return "*";
  if (c.length === 2) return `${c[0]}*`;
  return `${c[0]}${"*".repeat(c.length - 2)}${c[c.length - 1]}`;
}
export function maskIdCard(id: string): string {
  const c = Array.from(id.trim());
  if (c.length === 18) return `${c.slice(0, 6).join("")}${"*".repeat(8)}${c.slice(14).join("")}`;
  if (c.length <= 4) return "*".repeat(c.length);
  // Non-18 legacy formats: keep only the last 4 (stricter than v1 18-char rule).
  return `${"*".repeat(c.length - 4)}${c.slice(-4).join("")}`;
}

/** Minimal restricted store interface: one self-scoped SELECT, no write path. */
export interface IdentityDisplayStore { read(userId: string): Promise<{ realName: string; idCardNo: string } | null> }
export function pgIdentityDisplayStore(db: Pool | PoolClient): IdentityDisplayStore {
  return {
    async read(userId) {
      const r = await db.query<{ realName: string; idCardNo: string }>(
        `/* identity-display-read */ SELECT real_name AS "realName", id_card_no AS "idCardNo"
           FROM zzsh_iam.user_identity_display_source WHERE user_id = $1`, [userId]);
      return r.rows[0] ?? null;
    },
  };
}

export async function readIdentityDisplay(store: IdentityDisplayStore, userId: string, identityStatus: string | null | undefined): Promise<IdentityDisplayResult> {
  if (identityStatus !== "VERIFIED") return { identityDisplay: null, identityDisplayReason: "NOT_VERIFIED" };
  let row: { realName: string; idCardNo: string } | null;
  try { row = await store.read(userId); }
  catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42501") return { identityDisplay: null, identityDisplayReason: "STORE_UNAVAILABLE" };
    throw new Error("identity display read failed"); // drop driver message/detail to avoid echoing values
  }
  if (!row) return { identityDisplay: null, identityDisplayReason: "NOT_RECORDED" };
  return { identityDisplay: { realNameMasked: maskRealName(row.realName), idCardMasked: maskIdCard(row.idCardNo), maskingVersion: IDENTITY_MASKING_VERSION }, identityDisplayReason: null };
}
