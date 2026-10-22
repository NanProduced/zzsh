import type { PoolClient } from "pg";

export type DirectoryUserSummary = { name: string; image: string | null; maskedPhone: string | null };

export function maskPhoneNumber(phone: string | null): string | null {
  if (!phone) return null;
  const compact = phone.trim();
  if (compact.length === 0) return null;
  if (compact.length <= 4) return "****";
  const head = compact.startsWith("+86") ? compact.slice(0, 6) : compact.slice(0, 3);
  const tail = compact.slice(-4);
  return `${head}****${tail}`;
}

/** Page-selected stable IDs only; directory permission does not expose sensitive profile fields. */
export async function readDirectoryUserSummaries(client: PoolClient, userIds: readonly string[], permissions?: ReadonlySet<string>): Promise<Map<string, DirectoryUserSummary>> {
  const ids = [...new Set(userIds)], summaries = new Map<string, DirectoryUserSummary>();
  if (!permissions?.has("user.directory.read") || !ids.length) return summaries;
  const rows = (await client.query<{ id: string; name: string; image: string | null; phone: string | null }>(
    `SELECT id,name,image,"phoneNumber" AS phone FROM zzsh_auth_user."user" WHERE id=ANY($1::text[])`, [ids],
  )).rows;
  for (const row of rows) summaries.set(row.id, { name: row.name, image: row.image, maskedPhone: maskPhoneNumber(row.phone) });
  return summaries;
}
