import type { PoolClient } from "pg";
import { MEMBERSHIP_GROWTH_BATCH_SQL, normalizeGrowthInstant, type MembershipGrowthBatchSnapshot } from "./membership-growth-integration";
import { LEGACY_GROWTH_BATCH_SQL, readCoverageSchema } from "./membership-growth-legacy-store";
import { SecurityApiError } from "./security-core";
import { readLegacyZeroReadAdmission, legacyZeroReadSubjectIds, closeLegacyZeroReadAdmission, type LegacyZeroReadAdmission } from "./membership-growth-read-admission";

const SIZE = 500;
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Membership source stream is unavailable");
const compareId = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
function replaceOne(sql: string, before: string, after: string): string {
  if (sql.indexOf(before) < 0 || sql.indexOf(before) !== sql.lastIndexOf(before)) throw unavailable();
  return sql.replace(before, after);
}

// The fields and proof relations are the original batch statements; only the population predicate/order changes.
export const DIRECTORY_MEMBERSHIP_STREAM_SQL = {
  subjects: replaceOne(replaceOne(MEMBERSHIP_GROWTH_BATCH_SQL.subjects, " AND e.object_id=ANY($1::text[])", ""), "WHERE u.id=ANY($1::text[])", "ORDER BY u.id COLLATE \"C\""),
  contributions: replaceOne(replaceOne(MEMBERSHIP_GROWTH_BATCH_SQL.contributions, "WHERE user_id=ANY($1::text[])", ""), "ORDER BY effective_at,source_key,revision", "ORDER BY user_id COLLATE \"C\",effective_at,source_key,revision"),
  sources: replaceOne(replaceOne(MEMBERSHIP_GROWTH_BATCH_SQL.sources, "WHERE o.renter_user_id=ANY($1::text[]) AND", "WHERE"), "ORDER BY v.id", "ORDER BY o.renter_user_id COLLATE \"C\",v.id"),
  versions: replaceOne(replaceOne(LEGACY_GROWTH_BATCH_SQL.versions, "subject_user_id=ANY($1::text[]) AND cutoff<=$2::timestamptz", "cutoff<=$1::timestamptz"), "ORDER BY subject_user_id,", "ORDER BY subject_user_id COLLATE \"C\","),
  liveSources: replaceOne(replaceOne(LEGACY_GROWTH_BATCH_SQL.sources, "o.renter_user_id=ANY($1::text[]) AND", ""), "ORDER BY o.renter_user_id,", "ORDER BY o.renter_user_id COLLATE \"C\",").replaceAll("$2::timestamptz", "$1::timestamptz"),
} as const;

type Row = { userId: string };
class SourcePortal<T extends Row> {
  private rows: T[] = [];
  private offset = 0;
  private done = false;
  private lastId: string | null = null;
  constructor(private readonly client: PoolClient, readonly name: string) {}
  async batch(): Promise<T[]> {
    if (this.done) return [];
    const rows = (await this.client.query<T>(`FETCH FORWARD ${SIZE} FROM ${this.name}`)).rows;
    if (rows.length > SIZE) throw unavailable();
    for (const row of rows) {
      if (typeof row.userId !== "string" || this.lastId !== null && compareId(this.lastId, row.userId) > 0) throw unavailable();
      this.lastId = row.userId;
    }
    this.done = rows.length < SIZE;
    return rows;
  }
  async through(lastId: string): Promise<T[]> {
    const result: T[] = [];
    for (;;) {
      if (this.offset >= this.rows.length) { this.rows = await this.batch(); this.offset = 0; }
      const row = this.rows[this.offset];
      if (!row || compareId(row.userId, lastId) > 0) return result;
      result.push(row); this.offset++;
    }
  }
  async exhausted(): Promise<boolean> {
    if (this.offset < this.rows.length) return false;
    this.rows = await this.batch(); this.offset = 0;
    return this.rows.length === 0;
  }
}

/** Ordered portals plan the large relations once; every projection still consumes at most 500 subjects. */
export async function* streamDirectoryMembershipFacts(client: PoolClient, asOfUtc: string): AsyncGenerator<MembershipGrowthBatchSnapshot | { kind: "ADMITTED_EMPTY"; admission: LegacyZeroReadAdmission; asOfUtc: string }> {
  const asOf = normalizeGrowthInstant(asOfUtc);
  await client.query("SELECT set_config('jit','off',true)");
  const installed = await readCoverageSchema(client);
  const zeroReadAdmission = installed.coverage && installed.sources ? await readLegacyZeroReadAdmission(client, asOf) : null;
  const certifiedIds = legacyZeroReadSubjectIds(zeroReadAdmission, client, asOf);
  try {
  if (zeroReadAdmission && certifiedIds.length) yield { kind: "ADMITTED_EMPTY", admission: zeroReadAdmission, asOfUtc: asOf };
  const portals = [] as SourcePortal<Row>[];
  async function open<T extends Row>(name: string, sql: string, values: unknown[] = []): Promise<SourcePortal<T>> {
    await client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, values);
    const portal = new SourcePortal<T>(client, name); portals.push(portal); return portal;
  }
  const subjectSql = certifiedIds.length ? replaceOne(replaceOne(DIRECTORY_MEMBERSHIP_STREAM_SQL.subjects, "AND e.outcome='SUCCESS'", "AND e.outcome='SUCCESS' AND NOT(e.object_id=ANY($1::text[]))"), "ORDER BY u.id", "WHERE NOT(u.id=ANY($1::text[])) ORDER BY u.id") : DIRECTORY_MEMBERSHIP_STREAM_SQL.subjects;
  const subjects = await open<MembershipGrowthBatchSnapshot["subjects"][number]>("directory_growth_subjects", subjectSql, certifiedIds.length ? [certifiedIds] : []);
  const contributions = await open<MembershipGrowthBatchSnapshot["contributions"][number]>("directory_growth_contributions", DIRECTORY_MEMBERSHIP_STREAM_SQL.contributions);
  const sources = await open<MembershipGrowthBatchSnapshot["sources"][number]>("directory_growth_sources", DIRECTORY_MEMBERSHIP_STREAM_SQL.sources);
  const versionSql = certifiedIds.length ? replaceOne(DIRECTORY_MEMBERSHIP_STREAM_SQL.versions, "ORDER BY subject_user_id", "AND NOT(subject_user_id=ANY($2::text[])) ORDER BY subject_user_id") : DIRECTORY_MEMBERSHIP_STREAM_SQL.versions;
  const versions = installed.coverage && installed.sources ? await open<MembershipGrowthBatchSnapshot["legacy"]["versions"][number]>("directory_growth_versions", versionSql, certifiedIds.length ? [asOf, certifiedIds] : [asOf]) : null;
  const liveSources = installed.coverage && installed.sources ? await open<MembershipGrowthBatchSnapshot["legacy"]["sources"][number]>("directory_growth_live", DIRECTORY_MEMBERSHIP_STREAM_SQL.liveSources, [asOf]) : null;
  let previous: string | null = null;
  for (;;) {
    const batch = await subjects.batch();
    if (!batch.length) break;
    for (const subject of batch) {
      if (previous !== null && compareId(previous, subject.userId) >= 0) throw unavailable();
      previous = subject.userId;
    }
    const lastId = batch.at(-1)!.userId;
    yield { asOfUtc: asOf, subjects: batch, contributions: await contributions.through(lastId), sources: await sources.through(lastId), policy: undefined, entitlements: [], legacy: { installed, versions: await versions?.through(lastId) ?? [], sources: await liveSources?.through(lastId) ?? [], zeroReadAdmission } };
  }
  for (const portal of portals) if (portal !== subjects && !await portal.exhausted()) throw unavailable();
  for (const portal of portals) await client.query(`CLOSE ${portal.name}`);
  } finally { closeLegacyZeroReadAdmission(zeroReadAdmission); }
  // On failure the existing outer read wrapper ROLLBACKs; do not send cleanup SQL into an aborted transaction.
}
