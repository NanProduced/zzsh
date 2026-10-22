import type { PoolClient } from "pg";
import { readUserDirectoryBusinessSummaries, type CreditSummary, type MembershipSummary, type UserDirectoryBusinessViewer } from "./user-directory-business-summary";

export type DirectoryUserSummary = { name: string; image: string | null; maskedPhone: string | null; riskFlag?: boolean; membershipSummary?: MembershipSummary; creditSummary?: CreditSummary };

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
export async function readDirectoryUserSummaries(client: PoolClient, userIds: readonly string[], permissions?: ReadonlySet<string>, viewer?: UserDirectoryBusinessViewer): Promise<Map<string, DirectoryUserSummary>> {
  const ids = [...new Set(userIds)], summaries = new Map<string, DirectoryUserSummary>();
  if (!permissions?.has("user.directory.read") || !ids.length) return summaries;
  const rows = (await client.query<{ id: string; name: string; image: string | null; phone: string | null; riskFlag?: boolean }>(
    viewer ? `SELECT /* directory-user-summaries */ u.id,u.name,u.image,u."phoneNumber" AS phone,COALESCE(r.flagged,false) AS "riskFlag"
      FROM zzsh_auth_user."user" u LEFT JOIN zzsh_iam.user_risk_flag r ON r.user_id=u.id WHERE u.id=ANY($1::text[])`
      : `SELECT id,name,image,"phoneNumber" AS phone FROM zzsh_auth_user."user" WHERE id=ANY($1::text[])`, [ids],
  )).rows;
  for (const row of rows) if (ids.includes(row.id)) summaries.set(row.id, { name: row.name, image: row.image, maskedPhone: maskPhoneNumber(row.phone), ...(viewer ? {riskFlag: row.riskFlag === true} : {}) });
  if (viewer && summaries.size) {
    const business = await readUserDirectoryBusinessSummaries(client, {
      ...viewer,
      membershipSummaryRead: viewer.membershipSummaryRead && (viewer.isBoss || permissions.has('membership.growth.read.summary')),
      creditRead: viewer.creditRead && (viewer.isBoss || permissions.has('credit.read')),
    }, [...summaries.keys()]);
    for (const [id, summary] of summaries) {
      const facts = business.get(id);
      if (facts?.membershipSummary.state === 'ready') summary.membershipSummary = facts.membershipSummary;
      if (facts?.creditSummary.state === 'ready') summary.creditSummary = facts.creditSummary;
    }
  }
  return summaries;
}
