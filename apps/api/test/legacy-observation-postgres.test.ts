import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";

import {
  recordLegacyObservation,
  resolveLegacyObservationToDraft,
  type LegacyImportActor,
  type LegacyObservationInput,
} from "../src/supply/legacy-observation";
import type { SupplyGateReader } from "../src/supply/publishing";

const HOST = "127.0.0.1";
const PORT = 55432;
const SERVER_LISTENER_PORT = 5432;
const DATABASE = "zzsh_test_supply_baseline_accept";
const DATABASE_OID = 790510;
const DATABASE_OWNER = "zzsh";
const DATABASE_MARKER = "zzsh:m3b-supply-test:v1";
const MIGRATION_ROLE = "zzsh_m3b_baseline_accept_m";
const RUNTIME_ROLE = "zzsh_m3b_baseline_accept_r";
const RESOURCE_LOCK = "409915899069720480";
const FROZEN_JOURNAL_SHA = "626b26606e940e806a04e38ba535a23c5848e2304af7e51f4ba543292406b2ae";
const PREFIX = "r5_tech_";
const ACCOUNT_IDS = [
  "r5_tech_account_happy",
  "r5_tech_account_race_a",
  "r5_tech_account_race_b",
  "r5_tech_account_error",
] as const;
const SOURCE_SYSTEM = "r5_tech_legacy_mysql_restore";
const SOURCE_ENTITY = "r5_tech_la_rental_accounts";
const TECH_ONLY = "TECH_ONLY";

type Credentials = {
  host: string;
  port: number;
  database: string;
  migration: { role: string; password: string };
  runtime: { role: string; password: string };
};

type SerializedError = {
  name: string;
  status?: number;
  code?: string;
  message: string;
};

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: SerializedError };

type Directory = {
  gameId: string;
  gameCode: string;
  itemIds: string[];
  skinId: string;
  entitlementId: string;
  ownerUserId: string;
  scopedActorId: string;
  bossActorId: string;
  skinCategoryId: string | null;
  createdSkin: boolean;
  createdEntitlement: boolean;
};

type FixtureState = {
  currentVersionId: string | null;
  legacyHold: string;
  revision: string;
  versions: number;
  inventory: number;
  skins: number;
  entitlements: number;
  media: number;
  maps: number;
  audits: number;
  idempotency: number;
};

type Evidence = {
  status: "RUNNING" | "PASS" | "FAIL";
  startedAt: string;
  endedAt?: string;
  target?: Record<string, unknown>;
  cases: Array<Record<string, unknown>>;
  notes: string[];
  failure?: SerializedError;
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const idHash = (value: string): string => sha256(value).slice(0, 16);

function serializedError(error: unknown): SerializedError {
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    ...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
    ...(typeof candidate?.code === "string" ? { code: candidate.code } : {}),
    message: typeof candidate?.message === "string" ? candidate.message.slice(0, 240) : String(error).slice(0, 240),
  };
}

function credentialsFromFile(): Credentials {
  const file = process.env.REAL_SOURCE_5_CREDENTIALS_FILE;
  if (!file) throw new Error("REAL_SOURCE_5_CREDENTIALS_FILE is required");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const migration = raw.migration as Record<string, unknown> | undefined;
  const runtime = raw.runtime as Record<string, unknown> | undefined;
  if (
    typeof raw.host !== "string" ||
    typeof raw.port !== "number" ||
    typeof raw.database !== "string" ||
    typeof migration?.role !== "string" ||
    typeof migration.password !== "string" ||
    typeof runtime?.role !== "string" ||
    typeof runtime.password !== "string"
  )
    throw new Error("registered credentials shape is incomplete");
  return {
    host: raw.host,
    port: raw.port,
    database: raw.database,
    migration: { role: migration.role, password: migration.password },
    runtime: { role: runtime.role, password: runtime.password },
  };
}

function makePool(credentials: Credentials, role: string, password: string, applicationName: string, max: number): Pool {
  return new Pool({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: role,
    password,
    max,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 3000,
    application_name: applicationName,
  });
}

async function begin(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='7000ms'");
  await client.query("SET LOCAL lock_timeout='5000ms'");
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the operation error; the outer finally still releases the client.
  }
}

type Barrier = {
  arrive(): void;
  cancel(error: unknown): void;
  wait(): Promise<void>;
};

function createBarrier(participants: number, timeoutMs: number): Barrier {
  let arrived = 0;
  let settled = false;
  let resolveBarrier!: () => void;
  let rejectBarrier!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve;
    rejectBarrier = reject;
  });
  // A cancel/timeout can settle before the first wait() call; observe the
  // rejection immediately so it is not reported unhandled. wait() still
  // returns the original promise, so callers receive the original error.
  promise.catch(() => {});
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectBarrier(new Error(`concurrency barrier timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const settle = (settler: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settler();
  };

  return {
    arrive() {
      if (settled) return;
      arrived += 1;
      if (arrived === participants) settle(resolveBarrier);
    },
    cancel(error) {
      settle(() => rejectBarrier(error));
    },
    wait() {
      return promise;
    },
  };
}

async function connectPair(pool: Pick<Pool, "connect">): Promise<[PoolClient, PoolClient]> {
  const clients: PoolClient[] = [];
  try {
    clients.push(await pool.connect());
    clients.push(await pool.connect());
    return [clients[0]!, clients[1]!];
  } finally {
    if (clients.length < 2) {
      for (const client of clients) client.release();
    }
  }
}

async function concurrent<T>(pool: Pick<Pool, "connect">, operations: Array<(client: PoolClient) => Promise<T>>): Promise<Array<Outcome<T>>> {
  assert.equal(operations.length, 2);
  const clients: PoolClient[] = [];
  try {
    for (let index = 0; index < operations.length; index += 1) clients.push(await pool.connect());
  } catch (error) {
    for (const client of clients) client.release();
    throw error;
  }
  const gate = createBarrier(clients.length, 3000);
  const workers = clients.map(async (client, index) => {
    try {
      await begin(client);
      gate.arrive();
      await gate.wait();
      const value = await operations[index]!(client);
      await client.query("COMMIT");
      return { ok: true, value } as Outcome<T>;
    } catch (error) {
      gate.cancel(error);
      await rollback(client);
      return { ok: false, error: serializedError(error) } as Outcome<T>;
    } finally {
      client.release();
    }
  });
  return Promise.all(workers);
}

async function invoke<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<Outcome<T>> {
  const client = await pool.connect();
  try {
    await begin(client);
    const value = await operation(client);
    await client.query("COMMIT");
    return { ok: true, value };
  } catch (error) {
    await rollback(client);
    return { ok: false, error: serializedError(error) };
  } finally {
    client.release();
  }
}

async function invokeRollback<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<Outcome<T>> {
  const client = await pool.connect();
  try {
    await begin(client);
    const value = await operation(client);
    await rollback(client);
    return { ok: true, value };
  } catch (error) {
    await rollback(client);
    return { ok: false, error: serializedError(error) };
  } finally {
    client.release();
  }
}

function expectConflict<T>(outcome: Outcome<T>, label: string): void {
  assert.equal(outcome.ok, false, `${label} unexpectedly succeeded`);
  if (outcome.ok) return;
  assert.ok(
    outcome.error.status === 409 || outcome.error.status === 404 || outcome.error.status === 403,
    `${label} returned ${JSON.stringify(outcome.error)}`,
  );
}

function expectFailure<T>(outcome: Outcome<T>, label: string): SerializedError {
  assert.equal(outcome.ok, false, `${label} unexpectedly succeeded`);
  if (outcome.ok) throw new Error(`${label} unexpectedly succeeded`);
  return outcome.error;
}

async function readMigrationEvidence(client: PoolClient): Promise<Record<string, unknown>> {
  const journalPath = resolve(__dirname, "../../migrations/business/meta/_journal.json");
  const journalText = await readFile(journalPath, "utf8");
  const journalSha = sha256(journalText);
  assert.equal(journalSha, FROZEN_JOURNAL_SHA, "business journal moved from the frozen baseline");
  const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; when: number; tag: string }> };
  assert.equal(journal.entries.length, 56);
  assert.deepEqual(journal.entries.map((entry) => entry.idx), Array.from({ length: 56 }, (_, index) => index));
  const expected = journal.entries.map((entry) => ({
    ...entry,
    hash: sha256(readFileSync(resolve(__dirname, `../../migrations/business/${entry.tag}.sql`), "utf8")),
  }));
  const rows = (
    await client.query<{ id: number; hash: string; created_at: string }>(
      `SELECT id,hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY id`,
    )
  ).rows;
  assert.equal(rows.length, expected.length, "business migration count mismatch");
  rows.forEach((row, index) => {
    assert.equal(row.id, index + 1, "business migration ids are not contiguous");
    assert.equal(row.hash, expected[index]!.hash, `business migration hash mismatch at ${index}`);
    assert.equal(row.created_at, String(expected[index]!.when), `business migration timestamp mismatch at ${index}`);
  });
  return {
    count: rows.length,
    indexRange: [0, 55],
    journalSha,
    hashMatchCount: rows.length,
    whenMatchCount: rows.length,
    forbiddenMigration: "0056 not read",
  };
}

async function preflight(client: PoolClient): Promise<{ migrations: Record<string, unknown>; connections: Record<string, number>; privileges: Record<string, boolean> }> {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout='5000ms'");
  await client.query("SET LOCAL lock_timeout='1000ms'");
  try {
    const identity = (
      await client.query<{ current_user: string; current_database: string; server_port: number; server_version: string }>(
        `SELECT current_user,current_database(),inet_server_port()::int AS server_port,current_setting('server_version') AS server_version`,
      )
    ).rows[0]!;
    assert.equal(identity.current_user, MIGRATION_ROLE);
    assert.equal(identity.current_database, DATABASE);
    assert.equal(identity.server_port, SERVER_LISTENER_PORT);
    const database = (
      await client.query<{ oid: number; owner: string; marker: string | null; allow: boolean; template: boolean }>(
        `SELECT oid::int,pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker,
                datallowconn AS allow,datistemplate AS template
           FROM pg_database WHERE datname=current_database()`,
      )
    ).rows[0]!;
    assert.equal(database.oid, DATABASE_OID);
    assert.equal(database.owner, DATABASE_OWNER);
    assert.equal(database.marker, DATABASE_MARKER);
    assert.equal(database.allow, true);
    assert.equal(database.template, false);
    const roles = (
      await client.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean; rolreplication: boolean; rolbypassrls: boolean }>(
        `SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
           FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
        [[MIGRATION_ROLE, RUNTIME_ROLE]],
      )
    ).rows;
    assert.equal(roles.length, 2, "registered database roles are incomplete");
    for (const role of roles) {
      assert.equal(role.rolcanlogin, true);
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolcreaterole, false);
      assert.equal(role.rolcreatedb, false);
      assert.equal(role.rolreplication, false);
      assert.equal(role.rolbypassrls, false);
    }
    const migrationEvidence = await readMigrationEvidence(client);
    const connection = (
      await client.query<{ total: number; other: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE pid<>pg_backend_pid())::int AS other
           FROM pg_stat_activity WHERE datname=current_database()`,
      )
    ).rows[0]!;
    const privileges: Record<string, boolean> = {};
    const writableTables: Record<string, readonly string[]> = {
      "zzsh_supply.listing_version": ["INSERT", "UPDATE"],
      "zzsh_supply.inventory_line": ["INSERT"],
      "zzsh_supply.listing_skin": ["INSERT"],
      "zzsh_supply.listing_entitlement": ["INSERT"],
      "zzsh_supply.listing_media": ["INSERT"],
      "zzsh_supply.rental_account": ["UPDATE"],
      "zzsh_supply.legacy_supply_map": ["INSERT"],
      "zzsh_supply.idempotency_record": ["INSERT"],
      "zzsh_iam.audit_event": ["INSERT"],
    };
    for (const [table, required] of Object.entries(writableTables)) {
      const row = (
        await client.query<{ insert: boolean; update: boolean; select: boolean }>(
          `SELECT has_table_privilege($1,$2,'INSERT') AS insert,
                  has_table_privilege($1,$2,'UPDATE') AS update,
                  has_table_privilege($1,$2,'SELECT') AS select`,
          [RUNTIME_ROLE, table],
        )
      ).rows[0]!;
      for (const [operation, granted] of Object.entries(row)) {
        privileges[`${table}:${operation}`] = granted;
        if (required.includes(operation.toUpperCase())) assert.equal(granted, true, `${RUNTIME_ROLE} lacks ${operation} on ${table}`);
      }
    }
    const immutable = (
      await client.query<{ map_update: boolean; map_delete: boolean; audit_update: boolean; audit_delete: boolean }>(
        `SELECT has_table_privilege($1,'zzsh_supply.legacy_supply_map','UPDATE') AS map_update,
                has_table_privilege($1,'zzsh_supply.legacy_supply_map','DELETE') AS map_delete,
                has_table_privilege($1,'zzsh_iam.audit_event','UPDATE') AS audit_update,
                has_table_privilege($1,'zzsh_iam.audit_event','DELETE') AS audit_delete`,
        [RUNTIME_ROLE],
      )
    ).rows[0]!;
    assert.deepEqual(immutable, { map_update: false, map_delete: false, audit_update: false, audit_delete: false });
    Object.assign(privileges, immutable);
    return {
      migrations: migrationEvidence,
      connections: { total: connection.total, other: connection.other },
      privileges,
    };
  } finally {
    await rollback(client);
  }
}

async function acquireResourceLock(client: PoolClient): Promise<void> {
  const row = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [RESOURCE_LOCK])).rows[0]!;
  if (!row.locked) throw new Error("baseline_accept registration lock is occupied");
}

async function probeResourceLock(pool: Pool, client: PoolClient): Promise<boolean> {
  const probe = await pool.connect();
  try {
    const row = (await probe.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [RESOURCE_LOCK])).rows[0]!;
    if (row.locked) {
      await probe.query("SELECT pg_advisory_unlock($1::bigint)", [RESOURCE_LOCK]);
      return false;
    }
    return true;
  } finally {
    probe.release();
  }
}

async function readProtectedDigest(client: PoolClient): Promise<Array<{ table: string; count: number; digest: string }>> {
  const queries: Array<[string, string]> = [
    ["rental_account", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s|%s|%s|%s',id,owner_user_id,game_id,COALESCE(current_version_id,''),legacy_hold,revision),E'\\n' ORDER BY id),'')) AS digest FROM zzsh_supply.rental_account WHERE id NOT LIKE $1`],
    ["listing_version", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s|%s|%s|%s',id,account_id,sequence,origin,review_state,revision),E'\\n' ORDER BY id),'')) AS digest FROM zzsh_supply.listing_version WHERE account_id NOT LIKE $1`],
    ["media_asset", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s|%s|%s',id,COALESCE(account_id,''),access_class,review_state,revision),E'\\n' ORDER BY id),'')) AS digest FROM zzsh_supply.media_asset WHERE COALESCE(account_id,'') NOT LIKE $1 AND id NOT LIKE $1`],
    ["legacy_supply_map", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s|%s|%s|%s',source_system,source_entity,legacy_id,account_id,version_id,source_digest),E'\\n' ORDER BY source_system,source_entity,legacy_id),'')) AS digest FROM zzsh_supply.legacy_supply_map WHERE account_id NOT LIKE $1`],
    ["idempotency_record", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s|%s',scope_key,key,request_fingerprint,response_body::text),E'\\n' ORDER BY scope_key,key),'')) AS digest FROM zzsh_supply.idempotency_record WHERE scope_key NOT LIKE $1`],
    ["audit_event", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s|%s|%s',id,action,object_type,COALESCE(object_id,''),outcome),E'\\n' ORDER BY id),'')) AS digest FROM zzsh_iam.audit_event WHERE COALESCE(object_id,'') NOT LIKE $1`],
    ["admin_scope", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s',admin_user_id,game_id,granted_by_admin_id),E'\\n' ORDER BY admin_user_id,game_id),'')) AS digest FROM zzsh_supply.admin_supply_scope WHERE game_id NOT LIKE $1`],
    ["admin_permission", `SELECT count(*)::int AS count,md5(COALESCE(string_agg(format('%s|%s|%s',admin_user_id,permission_code,effect),E'\\n' ORDER BY admin_user_id,permission_code),'')) AS digest FROM zzsh_iam.admin_user_permission WHERE admin_user_id NOT LIKE $1`],
  ];
  const rows: Array<{ table: string; count: number; digest: string }> = [];
  for (const [table, sql] of queries) {
    const row = (await client.query<{ count: number; digest: string }>(sql, [`%${PREFIX}%`])).rows[0]!;
    rows.push({ table, count: row.count, digest: row.digest });
  }
  return rows;
}

async function readDirectory(client: PoolClient): Promise<Directory> {
  const game = (
    await client.query<{ id: string; code: string }>(
      `SELECT id,code FROM zzsh_supply.game WHERE code='delta' AND enabled ORDER BY id LIMIT 1`,
    )
  ).rows[0];
  if (!game) throw new Error("enabled delta game is missing");
  const items = (
    await client.query<{ id: string }>(
      `SELECT id FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled ORDER BY code,id LIMIT 3`,
      [game.id],
    )
  ).rows.map((row) => row.id);
  if (items.length < 3) throw new Error("delta does not have three enabled billable items for the bounded fixture");
  const owner = (
    await client.query<{ id: string }>(
      `SELECT u.id
         FROM zzsh_auth_user."user" u
         LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
        WHERE NOT u.suspended AND COALESCE(s.account_status,'ACTIVE')='ACTIVE'
        ORDER BY u.id LIMIT 1`,
    )
  ).rows[0];
  if (!owner) throw new Error("no existing active user identity is available for TECH_ONLY fixtures");
  const scopedActor = (
    await client.query<{ id: string }>(
      `WITH role_permissions AS (
         SELECT ur.admin_user_id,rp.permission_code
           FROM zzsh_iam.admin_user_role ur
           JOIN zzsh_iam.admin_role r ON r.id=ur.role_id AND r.status='ACTIVE'
           JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=r.id
       ), effective AS (
         SELECT s.admin_user_id
           FROM zzsh_iam.admin_security s
          WHERE s.status='ACTIVE' AND NOT s.is_boss
            AND (
              EXISTS (SELECT 1 FROM role_permissions p WHERE p.admin_user_id=s.admin_user_id AND p.permission_code='supply.catalog.manage')
              OR EXISTS (SELECT 1 FROM zzsh_iam.admin_user_permission p WHERE p.admin_user_id=s.admin_user_id AND p.permission_code='supply.catalog.manage' AND p.effect='ALLOW')
            )
            AND NOT EXISTS (SELECT 1 FROM zzsh_iam.admin_user_permission p WHERE p.admin_user_id=s.admin_user_id AND p.permission_code='supply.catalog.manage' AND p.effect='DENY')
       )
       SELECT e.admin_user_id AS id
         FROM effective e
         JOIN zzsh_supply.admin_supply_scope g ON g.admin_user_id=e.admin_user_id AND g.game_id=$1
        ORDER BY e.admin_user_id LIMIT 1`,
      [game.id],
    )
  ).rows[0];
  const bossActor = (
    await client.query<{ id: string }>(
      `SELECT admin_user_id AS id FROM zzsh_iam.admin_security WHERE status='ACTIVE' AND is_boss ORDER BY admin_user_id LIMIT 1`,
    )
  ).rows[0];
  if (!scopedActor || !bossActor || scopedActor.id === bossActor.id) throw new Error("two existing admin identities are required for replay proof");
    const category = (
    await client.query<{ id: string }>(
      `SELECT id FROM zzsh_supply.skin_category WHERE game_id=$1 ORDER BY id LIMIT 1`,
      [game.id],
    )
  ).rows[0];
  const skin = (
    await client.query<{ id: string }>(
      `SELECT id FROM zzsh_supply.skin WHERE game_id=$1 ORDER BY id LIMIT 1`,
      [game.id],
    )
  ).rows[0];
  const entitlement = (
    await client.query<{ id: string }>(
      `SELECT id FROM zzsh_supply.entitlement WHERE game_id=$1 ORDER BY id LIMIT 1`,
      [game.id],
    )
  ).rows[0];
  return {
    gameId: game.id,
    gameCode: game.code,
    itemIds: items,
    skinId: skin?.id ?? "r5_tech_skin",
    entitlementId: entitlement?.id ?? "r5_tech_entitlement",
    ownerUserId: owner.id,
    scopedActorId: scopedActor.id,
    bossActorId: bossActor.id,
    skinCategoryId: category?.id ?? null,
    createdSkin: !skin,
    createdEntitlement: !entitlement,
  };
}

async function prepareFixtures(client: PoolClient, directory: Directory): Promise<{ mediaId: string; categoryId: string | null }> {
  await begin(client);
  try {
    if (directory.createdSkin && !directory.skinCategoryId) {
      directory.skinCategoryId = "r5_tech_skin_category";
      await client.query(
        `INSERT INTO zzsh_supply.skin_category(id,game_id,code,name,enabled,form_visible)
         VALUES($1,$2,'r5_tech_category','R5 technical category',false,false)`,
        [directory.skinCategoryId, directory.gameId],
      );
    }
    if (directory.createdSkin) {
      await client.query(
        `INSERT INTO zzsh_supply.skin(id,game_id,code,name,category_id,enabled,form_visible,source_field,source_token)
         VALUES($1,$2,'r5_tech_skin','R5 technical skin',$3,false,false,NULL,NULL)`,
        [directory.skinId, directory.gameId, directory.skinCategoryId],
      );
    }
    if (directory.createdEntitlement) {
      await client.query(
        `INSERT INTO zzsh_supply.entitlement(id,game_id,code,name,value_kind,expiry_kind,enabled)
         VALUES($1,$2,'r5_tech_entitlement','R5 technical entitlement','FLAG','PERMANENT',false)`,
        [directory.entitlementId, directory.gameId],
      );
    }
    for (const accountId of ACCOUNT_IDS) {
      await client.query(
        `INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id,display_no)
         VALUES($1,$2,$3,$4)`,
        [accountId, directory.ownerUserId, directory.gameId, accountId],
      );
    }
    const mediaId = "r5_tech_media_happy";
    const mediaHash = sha256(mediaId);
    await client.query(
      `INSERT INTO zzsh_supply.media_asset
        (id,game_id,purpose,ownership_kind,owner_user_id,uploaded_by_realm,uploaded_by_user_id,
         storage_key,content_hash,mime,byte_size,width,height,access_class,review_state,account_id)
       VALUES($1,$2,'ACCOUNT_DISPLAY','USER_SUPPLY',$3,'user',$3,$4,$4,'image/png',1,1,1,'PRIVATE_REVIEW','PENDING',$5)`,
      [mediaId, directory.gameId, directory.ownerUserId, mediaHash, ACCOUNT_IDS[0]],
    );
    await client.query("COMMIT");
    return { mediaId, categoryId: directory.skinCategoryId };
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

function actor(id: string, suffix: string): LegacyImportActor {
  return { id, sessionId: `${PREFIX}session_${suffix}`, requestId: `${PREFIX}request_${suffix}` };
}

function sourceDigest(name: string): string {
  return sha256(`${TECH_ONLY}:${SOURCE_SYSTEM}:${SOURCE_ENTITY}:${name}`);
}

function completeInput(directory: Directory, mediaId: string, name: string, reordered: boolean): LegacyObservationInput {
  const entitlement = reordered
    ? { value: true, entitlementId: directory.entitlementId, expiryKnowledge: "UNKNOWN" as const, expiresAt: null }
    : { entitlementId: directory.entitlementId, value: true, expiresAt: null, expiryKnowledge: "UNKNOWN" as const };
  const media = reordered ? { position: 0, assetId: mediaId } : { assetId: mediaId, position: 0 };
  return {
    sourceSystem: SOURCE_SYSTEM,
    sourceEntity: SOURCE_ENTITY,
    legacyId: `${PREFIX}${name}`,
    evidenceRef: `${TECH_ONLY}:real-source-5/${name}`,
    sourceDigest: sourceDigest(name),
    inventory: [
      { itemId: directory.itemIds[0]!, quantity: "999999999999999999999999" },
      { itemId: directory.itemIds[1]!, quantity: "0" },
      { itemId: directory.itemIds[2]!, quantity: null },
    ],
    declaration: {
      title: `${TECH_ONLY} ${name}`,
      description: "controlled technical fixture",
      attributes: {
        safe_box_code: "box-a",
        vit_level: 6,
        bear_level: 6,
        secret_kd: "1.25",
        rentalPricing: { rentalMode: "custom" as const, ownerRatioB: "46" },
      },
      skins: [directory.skinId],
      entitlements: [entitlement],
      mediaBindings: [media],
      termOptionCode: "daily-10m",
      pricingOptionCode: "",
    },
  };
}

function inventoryOnlyInput(directory: Directory, name: string): LegacyObservationInput {
  return {
    sourceSystem: SOURCE_SYSTEM,
    sourceEntity: SOURCE_ENTITY,
    legacyId: `${PREFIX}${name}`,
    evidenceRef: `${TECH_ONLY}:real-source-5/${name}`,
    sourceDigest: sourceDigest(name),
    inventory: [{ itemId: directory.itemIds[0]!, quantity: "1" }],
  };
}

async function readFixtureState(client: PoolClient, accountId: string, actorId?: string): Promise<FixtureState> {
  const account = (
    await client.query<{ current_version_id: string | null; legacy_hold: string; revision: string }>(
      `SELECT current_version_id,legacy_hold,revision::text FROM zzsh_supply.rental_account WHERE id=$1`,
      [accountId],
    )
  ).rows[0]!;
  const count = async (table: string, where: string, values: unknown[]): Promise<number> =>
    Number((await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE ${where}`, values)).rows[0]!.count);
  return {
    currentVersionId: account.current_version_id,
    legacyHold: account.legacy_hold,
    revision: account.revision,
    versions: await count("zzsh_supply.listing_version", "account_id=$1", [accountId]),
    inventory: await count("zzsh_supply.inventory_line", "version_id IN (SELECT id FROM zzsh_supply.listing_version WHERE account_id=$1)", [accountId]),
    skins: await count("zzsh_supply.listing_skin", "version_id IN (SELECT id FROM zzsh_supply.listing_version WHERE account_id=$1)", [accountId]),
    entitlements: await count("zzsh_supply.listing_entitlement", "version_id IN (SELECT id FROM zzsh_supply.listing_version WHERE account_id=$1)", [accountId]),
    media: await count("zzsh_supply.listing_media", "version_id IN (SELECT id FROM zzsh_supply.listing_version WHERE account_id=$1)", [accountId]),
    maps: await count("zzsh_supply.legacy_supply_map", "account_id=$1", [accountId]),
    audits: await count("zzsh_iam.audit_event", "object_id=$1 AND action LIKE 'supply.publication.legacy_%'", [accountId]),
    idempotency: actorId
      ? await count("zzsh_supply.idempotency_record", "scope_key LIKE $1", [`%${actorId}%`])
      : 0,
  };
}

async function readVersionBundle(client: PoolClient, versionId: string): Promise<Record<string, unknown>> {
  const version = (
    await client.query(
      `SELECT id,account_id,sequence::text,origin,review_state,title,description,attributes,term_option_code,pricing_option_code,
              schema_version,rule_release_id,content_hash,payload
         FROM zzsh_supply.listing_version WHERE id=$1`,
      [versionId],
    )
  ).rows[0];
  assert.ok(version);
  const inventory = (
    await client.query(`SELECT item_id,quantity::text AS quantity FROM zzsh_supply.inventory_line WHERE version_id=$1 ORDER BY item_id`, [versionId])
  ).rows;
  const skins = (await client.query(`SELECT skin_id FROM zzsh_supply.listing_skin WHERE version_id=$1 ORDER BY skin_id`, [versionId])).rows;
  const entitlements = (
    await client.query(
      `SELECT entitlement_id,value,expires_at,expiry_knowledge FROM zzsh_supply.listing_entitlement WHERE version_id=$1 ORDER BY entitlement_id`,
      [versionId],
    )
  ).rows;
  const media = (
    await client.query(`SELECT asset_id,position FROM zzsh_supply.listing_media WHERE version_id=$1 ORDER BY position,asset_id`, [versionId])
  ).rows;
  return { ...version, inventory, skins, entitlements, media };
}

async function concurrentRecord(
  pool: Pool,
  accountIds: [string, string],
  input: LegacyObservationInput,
  actorValue: LegacyImportActor,
): Promise<Array<Outcome<string>>> {
  return concurrent(pool, accountIds.map((accountId) => (client) => recordLegacyObservation(client, accountId, input, actorValue)));
}

async function concurrentResolve(
  pool: Pool,
  accountId: string,
  input: Parameters<typeof resolveLegacyObservationToDraft>[2],
  actorValue: LegacyImportActor,
  gate: SupplyGateReader,
): Promise<Array<Outcome<Awaited<ReturnType<typeof resolveLegacyObservationToDraft>>>> > {
  return concurrent(pool, [
    (client) => resolveLegacyObservationToDraft(client, accountId, input, actorValue, gate),
    (client) => resolveLegacyObservationToDraft(client, accountId, input, actorValue, gate),
  ]);
}

function sourceLockArgument(input: Pick<LegacyObservationInput, "sourceSystem" | "sourceEntity" | "legacyId">): string {
  return JSON.stringify(["supply-legacy-source", input.sourceSystem, input.sourceEntity, input.legacyId]);
}

async function waitForSourceAdvisoryBlock(
  observer: PoolClient,
  blockedPid: number,
  blockingPid: number,
  timeoutMs: number,
): Promise<{ waitMs: number; waitEventType: string | null; waitEvent: string | null; waitingAdvisory: boolean }> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const row = (
      await observer.query<{
        wait_event_type: string | null;
        wait_event: string | null;
        blocking_pids: number[];
        waiting_advisory: boolean;
      }>(
        `SELECT a.wait_event_type,a.wait_event,COALESCE(pg_blocking_pids(a.pid),ARRAY[]::int[]) AS blocking_pids,
                EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND NOT l.granted) AS waiting_advisory
           FROM pg_stat_activity a WHERE a.pid=$1`,
        [blockedPid],
      )
    ).rows[0];
    last = row
      ? { waitEventType: row.wait_event_type, waitEvent: row.wait_event, blockingPids: row.blocking_pids, waitingAdvisory: row.waiting_advisory }
      : { missing: true };
    if (row?.waiting_advisory && row.blocking_pids.includes(blockingPid)) {
      return { waitMs: Date.now() - started, waitEventType: row.wait_event_type, waitEvent: row.wait_event, waitingAdvisory: true };
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`source advisory wait was not observed before timeout: ${JSON.stringify(last)}`);
}

const FREE_GATE: SupplyGateReader = async () => ({
  publisherBail: "NOT_REQUIRED",
  occupancy: "FREE",
  reference: `${TECH_ONLY}:free-gate`,
});

async function runAcceptance(evidence: Evidence): Promise<void> {
  const credentials = credentialsFromFile();
  assert.equal(credentials.host, HOST);
  assert.equal(credentials.port, PORT);
  assert.equal(credentials.database, DATABASE);
  assert.equal(credentials.migration.role, MIGRATION_ROLE);
  assert.equal(credentials.runtime.role, RUNTIME_ROLE);

  const migrationPool = makePool(credentials, credentials.migration.role, credentials.migration.password, "r5-tech-migration", 4);
  const runtimePool = makePool(credentials, credentials.runtime.role, credentials.runtime.password, "r5-tech-runtime", 6);
  let guard: PoolClient | undefined;
  let lockHeld = false;
  try {
    guard = await migrationPool.connect();
    const preflightEvidence = await preflight(guard);
    await acquireResourceLock(guard);
    lockHeld = true;
    assert.equal(await probeResourceLock(migrationPool, guard), true, "registration lock is not exclusive");
    evidence.target = {
      resource: { host: HOST, port: PORT, database: DATABASE, oid: DATABASE_OID, marker: DATABASE_MARKER },
      roles: { migration: MIGRATION_ROLE, runtime: RUNTIME_ROLE },
      migrations: preflightEvidence.migrations,
      preflightConnections: preflightEvidence.connections,
      runtimePrivileges: preflightEvidence.privileges,
      lock: { acquired: true, probeBlocked: true, heldUntilFinally: true },
    };

    await guard.query("BEGIN READ ONLY");
    await guard.query("SET LOCAL statement_timeout='5000ms'");
    const prefixRows = (
      await guard.query<{ table_name: string; count: number }>(
        `SELECT table_name,count(*)::int AS count FROM (
          SELECT 'rental_account' AS table_name,id FROM zzsh_supply.rental_account WHERE id LIKE $1
          UNION ALL SELECT 'listing_version',id FROM zzsh_supply.listing_version WHERE id LIKE $1
          UNION ALL SELECT 'skin',id FROM zzsh_supply.skin WHERE id LIKE $1
          UNION ALL SELECT 'skin_category',id FROM zzsh_supply.skin_category WHERE id LIKE $1
          UNION ALL SELECT 'entitlement',id FROM zzsh_supply.entitlement WHERE id LIKE $1
          UNION ALL SELECT 'media_asset',id FROM zzsh_supply.media_asset WHERE id LIKE $1
          UNION ALL SELECT 'legacy_supply_map',legacy_id FROM zzsh_supply.legacy_supply_map WHERE source_system LIKE $1
        ) rows GROUP BY table_name ORDER BY table_name`,
        [`%${PREFIX}%`],
      )
    ).rows;
    const prefixCount = new Map(prefixRows.map((row) => [row.table_name, row.count]));
    const continueOwnedFixture = process.env.REAL_SOURCE_5_CONTINUE_OWNED_FIXTURE === "1";
    const prefixTotal = prefixRows.reduce((sum, row) => sum + row.count, 0);
    if (prefixTotal > 0 && !continueOwnedFixture)
      throw new Error("R5 technical prefix already exists; refusing cleanup/reuse");
    if (continueOwnedFixture) {
      assert.equal(prefixCount.get("rental_account") ?? 0, 4);
      assert.equal(prefixCount.get("skin") ?? 0, 1);
      assert.equal(prefixCount.get("skin_category") ?? 0, 1);
      assert.equal(prefixCount.get("entitlement") ?? 0, 1);
      assert.equal(prefixCount.get("media_asset") ?? 0, 1);
      const ownedPartial = (
        await guard.query<{ happy_versions: number; happy_maps: number; happy_audits: number; other_versions: number; other_maps: number; other_audits: number; prefix_idempotency: number }>(
          `SELECT
            (SELECT count(*)::int FROM zzsh_supply.listing_version WHERE account_id=$1) AS happy_versions,
            (SELECT count(*)::int FROM zzsh_supply.legacy_supply_map WHERE account_id=$1) AS happy_maps,
            (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id=$1) AS happy_audits,
            (SELECT count(*)::int FROM zzsh_supply.listing_version WHERE account_id LIKE $2 AND account_id<>$1) AS other_versions,
            (SELECT count(*)::int FROM zzsh_supply.legacy_supply_map WHERE account_id LIKE $2 AND account_id<>$1) AS other_maps,
            (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id LIKE $2 AND object_id<>$1) AS other_audits,
            (SELECT count(*)::int FROM zzsh_supply.idempotency_record WHERE scope_key LIKE $3 OR response_body::text LIKE $3) AS prefix_idempotency`,
          [ACCOUNT_IDS[0], `${PREFIX}%`, `%${PREFIX}%`],
        )
      ).rows[0]!;
      const partialFixture = ownedPartial.happy_versions === 0;
      const completedFixture = ownedPartial.happy_versions === 2;
      assert.ok(partialFixture || completedFixture, "owned TECH_ONLY fixture is neither the known partial nor completed state");
      if (partialFixture) {
        assert.equal(ownedPartial.happy_maps, 0);
        assert.equal(ownedPartial.happy_audits, 0);
        assert.equal(ownedPartial.other_versions, 0);
        assert.equal(ownedPartial.other_maps, 0);
        assert.equal(ownedPartial.other_audits, 0);
        assert.equal(ownedPartial.prefix_idempotency, 0);
        assert.equal(prefixCount.get("legacy_supply_map") ?? 0, 0);
      } else {
        assert.equal(ownedPartial.happy_maps, 1);
        assert.equal(ownedPartial.happy_audits, 2);
        assert.equal(ownedPartial.other_versions, 3);
        assert.equal(ownedPartial.other_maps, 2);
        assert.equal(ownedPartial.other_audits, 3);
        assert.equal(ownedPartial.prefix_idempotency, 7);
        assert.equal(prefixCount.get("legacy_supply_map") ?? 0, 3);
      }
      evidence.notes.push("continued the exact TECH_ONLY fixture owned by the immediately preceding failed run; no fixture row was recreated or deleted");
    }
    const protectedBefore = await readProtectedDigest(guard);
    const directory = await readDirectory(guard);
    await rollback(guard);
    const mediaId = continueOwnedFixture ? "r5_tech_media_happy" : (await prepareFixtures(guard, directory)).mediaId;

    evidence.target!.directory = {
      game: { code: directory.gameCode, idHash: idHash(directory.gameId) },
      itemCount: directory.itemIds.length,
      itemIdHashes: directory.itemIds.map(idHash),
      existingOwnerIdHash: idHash(directory.ownerUserId),
      scopedActorIdHash: idHash(directory.scopedActorId),
      bossActorIdHash: idHash(directory.bossActorId),
      skin: { id: directory.skinId, created: directory.createdSkin },
      entitlement: { id: directory.entitlementId, created: directory.createdEntitlement },
      mediaId,
      marker: TECH_ONLY,
    };

    const scopedActor = actor(directory.scopedActorId, "scoped");
    const bossActor = actor(directory.bossActorId, "boss");
    const happy = completeInput(directory, mediaId, "happy", true);
    const happyObservation = await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[0], happy, scopedActor));
    assert.equal(happyObservation.ok, true);
    const happyObservationId = happyObservation.ok ? happyObservation.value : "";
    evidence.cases.push({ case: "complete_observation_insert_and_four_children", status: "PASS", versionIdHash: idHash(happyObservationId), marker: TECH_ONLY });

    const sameActorReplay = await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[0], happy, scopedActor));
    assert.equal(sameActorReplay.ok, true);
    assert.equal(sameActorReplay.ok && sameActorReplay.value, happyObservationId);
    evidence.cases.push({ case: "same_actor_same_body_replay", status: "PASS" });

    const reordered = completeInput(directory, mediaId, "happy", false);
    const crossActorReplay = await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[0], reordered, bossActor));
    assert.equal(crossActorReplay.ok, true);
    assert.equal(crossActorReplay.ok && crossActorReplay.value, happyObservationId);
    evidence.cases.push({ case: "cross_actor_media_entitlement_key_order_replay", status: "PASS" });

    const blockedTarget = ACCOUNT_IDS[1];
    const beforeSourceWait = await invoke(runtimePool, (client) => readFixtureState(client, blockedTarget));
    assert.equal(beforeSourceWait.ok, true);
    let sourceBlocker: PoolClient | undefined;
    let sourceWaiter: PoolClient | undefined;
    let sourceBlockerOpen = false;
    let sourceWaiterFinished = false;
    let sourceReplay: Promise<Outcome<string>> | undefined;
    try {
      const [blocker, waiter] = await connectPair(runtimePool);
      sourceBlocker = blocker;
      sourceWaiter = waiter;
      sourceBlockerOpen = true;
      await begin(blocker);
      const blockerPid = Number((await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sourceLockArgument(reordered)]);

      await begin(waiter);
      const waiterPid = Number((await waiter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      sourceReplay = (async () => {
        try {
          const value = await recordLegacyObservation(waiter, blockedTarget, reordered, bossActor);
          await waiter.query("ROLLBACK");
          return { ok: true, value };
        } catch (error) {
          await rollback(waiter);
          return { ok: false, error: serializedError(error) };
        } finally {
          sourceWaiterFinished = true;
        }
      })();
      const waitEvidence = await waitForSourceAdvisoryBlock(guard, waiterPid, blockerPid, 3000);
      await rollback(sourceBlocker);
      sourceBlockerOpen = false;
      const replay = await sourceReplay;
      assert.equal(replay.ok, false);
      if (!replay.ok) assert.equal(replay.error.status, 409);
      const afterSourceWait = await invoke(runtimePool, (client) => readFixtureState(client, blockedTarget));
      assert.equal(afterSourceWait.ok, true);
      assert.deepEqual(afterSourceWait.ok && afterSourceWait.value, beforeSourceWait.ok && beforeSourceWait.value);
      evidence.cases.push({
        case: "source_advisory_lock_wait_and_original_intent_replay",
        status: "PASS",
        waitObserved: true,
        waitingAdvisory: true,
        waitEventType: waitEvidence.waitEventType,
        waitEvent: waitEvidence.waitEvent,
        waitMs: waitEvidence.waitMs,
        blockingPidObserved: true,
        replayConflictStatus: 409,
        noNewObservationFacts: true,
      });
    } finally {
      if (sourceBlocker && sourceBlockerOpen) await rollback(sourceBlocker);
      if (sourceReplay && !sourceWaiterFinished) {
        await Promise.race([
          sourceReplay,
          new Promise<Outcome<string>>((resolveTimeout) => setTimeout(() => resolveTimeout({ ok: false, error: { name: "Timeout", message: "source replay cleanup timeout" } }), 1000)),
        ]);
      }
      if (sourceWaiter && !sourceWaiterFinished) await rollback(sourceWaiter);
      sourceBlocker?.release();
      sourceWaiter?.release();
    }

    const changedTitle = structuredClone(reordered);
    changedTitle.declaration!.title = `${TECH_ONLY} changed`;
    expectConflict(await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[0], changedTitle, bossActor)), "changed title");
    evidence.cases.push({ case: "cross_actor_changed_title_conflict", status: "PASS" });
    const changedInventory = structuredClone(reordered);
    changedInventory.inventory[0]!.quantity = "2";
    expectConflict(await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[0], changedInventory, bossActor)), "changed inventory");
    evidence.cases.push({ case: "cross_actor_changed_inventory_conflict", status: "PASS" });
    const changedDigest = structuredClone(reordered);
    changedDigest.sourceDigest = sha256(`${TECH_ONLY}:different-digest`);
    expectConflict(await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[0], changedDigest, bossActor)), "changed digest");
    evidence.cases.push({ case: "different_digest_conflict", status: "PASS" });
    expectConflict(await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[1], reordered, bossActor)), "different target");
    evidence.cases.push({ case: "different_target_conflict", status: "PASS" });

    const resolution = {
      sourceSystem: happy.sourceSystem,
      sourceEntity: happy.sourceEntity,
      legacyId: happy.legacyId,
      sourceDigest: happy.sourceDigest,
      expectedObservationVersionId: happyObservationId,
      expectedOwnerUserId: directory.ownerUserId,
      expectedGameId: directory.gameId,
    };
    const draftResult = await invoke(runtimePool, (client) => resolveLegacyObservationToDraft(client, ACCOUNT_IDS[0], resolution, scopedActor, FREE_GATE));
    assert.equal(draftResult.ok, true);
    const draftId = draftResult.ok ? draftResult.value.versionId : "";
    assert.equal(draftResult.ok && draftResult.value.status, "DRAFT");
    const draftReplay = await invoke(runtimePool, (client) => resolveLegacyObservationToDraft(client, ACCOUNT_IDS[0], resolution, bossActor, FREE_GATE));
    assert.equal(draftReplay.ok, true);
    assert.deepEqual(draftReplay.ok && draftReplay.value, draftResult.ok && draftResult.value);
    evidence.cases.push({ case: "single_native_draft_and_cross_actor_resolve_replay", status: "PASS", draftIdHash: idHash(draftId) });

    const readClient = await runtimePool.connect();
    try {
      await begin(readClient);
      const observedBundle = await readVersionBundle(readClient, happyObservationId);
      const draftBundle = await readVersionBundle(readClient, draftId);
      assert.equal(observedBundle.origin, "LEGACY_OBSERVATION");
      assert.equal(observedBundle.review_state, "IMPORTED_UNVERIFIED");
      assert.equal(draftBundle.origin, "NATIVE");
      assert.equal(draftBundle.review_state, "DRAFT");
      assert.equal(draftBundle.rule_release_id, null);
      assert.equal(draftBundle.content_hash, null);
      assert.equal(draftBundle.payload, null);
      assert.deepEqual(draftBundle.inventory, observedBundle.inventory);
      assert.deepEqual(draftBundle.skins, observedBundle.skins);
      assert.deepEqual(draftBundle.entitlements, observedBundle.entitlements);
      assert.deepEqual(draftBundle.media, observedBundle.media);
      const quantities = new Map((draftBundle.inventory as Array<{ item_id: string; quantity: string | null }>).map((row) => [row.item_id, row.quantity]));
      assert.equal(quantities.get(directory.itemIds[0]!), "999999999999999999999999");
      assert.equal(quantities.get(directory.itemIds[1]!), "0");
      assert.equal(quantities.get(directory.itemIds[2]!), null);
      const account = (await readClient.query(`SELECT current_version_id,legacy_hold FROM zzsh_supply.rental_account WHERE id=$1`, [ACCOUNT_IDS[0]])).rows[0]!;
      assert.equal(account.current_version_id, draftId);
      assert.equal(account.legacy_hold, "NONE");
      await rollback(readClient);
    } finally {
      readClient.release();
    }
    evidence.cases.push({ case: "observation_map_hold_and_four_child_value_equality", status: "PASS" });

    const wrongOwner = { ...resolution, expectedOwnerUserId: `${PREFIX}wrong-owner` };
    expectConflict(await invokeRollback(runtimePool, (client) => resolveLegacyObservationToDraft(client, ACCOUNT_IDS[0], wrongOwner, bossActor, FREE_GATE)), "wrong owner");
    const wrongGame = { ...resolution, expectedGameId: `${PREFIX}wrong-game` };
    expectConflict(await invokeRollback(runtimePool, (client) => resolveLegacyObservationToDraft(client, ACCOUNT_IDS[0], wrongGame, bossActor, FREE_GATE)), "wrong game");
    const wrongObservation = { ...resolution, expectedObservationVersionId: `${PREFIX}missing-observation` };
    expectConflict(await invokeRollback(runtimePool, (client) => resolveLegacyObservationToDraft(client, ACCOUNT_IDS[0], wrongObservation, bossActor, FREE_GATE)), "wrong observation");
    evidence.cases.push({ case: "owner_game_observation_guard_failures", status: "PASS" });

    const currentChanged = await invokeRollback(runtimePool, async (client) => {
      await client.query(`UPDATE zzsh_supply.rental_account SET current_version_id=NULL WHERE id=$1`, [ACCOUNT_IDS[0]]);
      return resolveLegacyObservationToDraft(client, ACCOUNT_IDS[0], resolution, bossActor, FREE_GATE);
    });
    expectConflict(currentChanged, "current version changed");
    const holdChanged = await invokeRollback(runtimePool, async (client) => {
      await client.query(`UPDATE zzsh_supply.rental_account SET legacy_hold='ACTIVE_LEGACY' WHERE id=$1`, [ACCOUNT_IDS[0]]);
      return resolveLegacyObservationToDraft(client, ACCOUNT_IDS[0], resolution, bossActor, FREE_GATE);
    });
    expectConflict(holdChanged, "legacy hold changed");
    evidence.cases.push({ case: "cached_resolve_rechecks_current_version_and_hold", status: "PASS" });

    const permissionInput = inventoryOnlyInput(directory, "permission-negative");
    const permissionFailure = await invokeRollback(runtimePool, async (client) => {
      await client.query(
        `INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect)
         VALUES($1,'supply.catalog.manage','DENY')
         ON CONFLICT(admin_user_id,permission_code) DO UPDATE SET effect='DENY'`,
        [directory.scopedActorId],
      );
      return recordLegacyObservation(client, ACCOUNT_IDS[3], permissionInput, scopedActor);
    });
    expectConflict(permissionFailure, "permission revoked");
    const scopeFailure = await invokeRollback(runtimePool, async (client) => {
      const moved = await client.query(
        `UPDATE zzsh_supply.admin_supply_scope SET admin_user_id=$3 WHERE admin_user_id=$1 AND game_id=$2`,
        [directory.scopedActorId, directory.gameId, directory.bossActorId],
      );
      assert.equal(moved.rowCount, 1);
      return recordLegacyObservation(client, ACCOUNT_IDS[3], inventoryOnlyInput(directory, "scope-negative"), scopedActor);
    });
    expectConflict(scopeFailure, "scope removed");
    evidence.cases.push({ case: "permission_revoke_and_scope_recheck", status: "PASS" });

    const negativeAccountId = ACCOUNT_IDS[2];
    const beforeFk = await invoke(runtimePool, async (client) => readFixtureState(client, negativeAccountId));
    assert.equal(beforeFk.ok, true);
    const badFk = inventoryOnlyInput(directory, "fk-negative");
    badFk.inventory = [{ itemId: `${PREFIX}missing-item`, quantity: "1" }];
    const fkFailure = await invokeRollback(runtimePool, (client) => recordLegacyObservation(client, negativeAccountId, badFk, scopedActor));
    const fkError = expectFailure(fkFailure, "inventory foreign key");
    assert.ok(fkError.code === "23503" || fkError.code === "P0001", JSON.stringify(fkError));
    if (fkError.code === "P0001") assert.match(fkError.message, /listing child belongs to another game/i);
    const afterFk = await invoke(runtimePool, async (client) => readFixtureState(client, negativeAccountId));
    assert.equal(afterFk.ok, true);
    assert.deepEqual(afterFk.ok && afterFk.value, beforeFk.ok && beforeFk.value);

    const badMedia = completeInput(directory, mediaId, "media-negative", false);
    const mediaFailure = await invokeRollback(runtimePool, (client) => recordLegacyObservation(client, negativeAccountId, badMedia, scopedActor));
    const mediaError = expectFailure(mediaFailure, "media ownership trigger");
    assert.match(mediaError.message, /media belongs to another account/i);
    const afterMedia = await invoke(runtimePool, async (client) => readFixtureState(client, negativeAccountId));
    assert.equal(afterMedia.ok, true);
    assert.deepEqual(afterMedia.ok && afterMedia.value, beforeFk.ok && beforeFk.value);

    const badQuantity = inventoryOnlyInput(directory, "quantity-negative");
    badQuantity.inventory = [{ itemId: directory.itemIds[0]!, quantity: "1".repeat(25) }];
    const quantityFailure = await invokeRollback(runtimePool, (client) => recordLegacyObservation(client, negativeAccountId, badQuantity, scopedActor));
    const quantityError = expectFailure(quantityFailure, "24 digit quantity boundary");
    assert.equal(quantityError.status, 400);
    evidence.cases.push({ case: "fk_media_trigger_and_transaction_rollback", status: "PASS", postgresFkCode: fkError.code });
    evidence.cases.push({ case: "null_zero_and_24_digit_quantity_preserved", status: "PASS" });

    const raceInput = inventoryOnlyInput(directory, "record-race");
    const race = await concurrentRecord(runtimePool, [ACCOUNT_IDS[1], ACCOUNT_IDS[2]], raceInput, scopedActor);
    assert.equal(race.filter((result) => result.ok).length, 1);
    assert.equal(race.filter((result) => !result.ok).length, 1);
    const raceFailure = race.find((result): result is { ok: false; error: SerializedError } => !result.ok)!;
    assert.equal(raceFailure.error.status, 409);
    const raceWinner = race.find((result): result is { ok: true; value: string } => result.ok)!;
    evidence.cases.push({ case: "concurrent_same_source_different_target", status: "PASS", winnerVersionIdHash: idHash(raceWinner.value) });

    const resolveInput = inventoryOnlyInput(directory, "resolve-race");
    const errorObservation = await invoke(runtimePool, (client) => recordLegacyObservation(client, ACCOUNT_IDS[3], resolveInput, scopedActor));
    assert.equal(errorObservation.ok, true);
    const errorObservationId = errorObservation.ok ? errorObservation.value : "";
    const resolveInputContract = {
      sourceSystem: resolveInput.sourceSystem,
      sourceEntity: resolveInput.sourceEntity,
      legacyId: resolveInput.legacyId,
      sourceDigest: resolveInput.sourceDigest,
      expectedObservationVersionId: errorObservationId,
      expectedOwnerUserId: directory.ownerUserId,
      expectedGameId: directory.gameId,
    };
    const resolveRace = await concurrentResolve(runtimePool, ACCOUNT_IDS[3], resolveInputContract, scopedActor, FREE_GATE);
    assert.equal(resolveRace.filter((result) => result.ok).length, 2);
    const resolveValues = resolveRace.filter((result): result is { ok: true; value: Awaited<ReturnType<typeof resolveLegacyObservationToDraft>> } => result.ok).map((result) => result.value);
    assert.equal(new Set(resolveValues.map((value) => value.versionId)).size, 1);
    const lostResponse = await invoke(runtimePool, (client) => resolveLegacyObservationToDraft(client, ACCOUNT_IDS[3], resolveInputContract, scopedActor, FREE_GATE));
    assert.equal(lostResponse.ok, true);
    const replayAfterLostResponse = await invoke(runtimePool, (client) => resolveLegacyObservationToDraft(client, ACCOUNT_IDS[3], resolveInputContract, scopedActor, FREE_GATE));
    assert.deepEqual(replayAfterLostResponse, lostResponse);
    evidence.cases.push({ case: "concurrent_same_target_resolve_and_response_lost_replay", status: "PASS", draftIdHash: idHash(resolveValues[0]!.versionId) });

    await guard.query("BEGIN READ ONLY");
    await guard.query("SET LOCAL statement_timeout='5000ms'");
    const protectedAfter = await readProtectedDigest(guard);
    assert.deepEqual(protectedAfter, protectedBefore, "non-R5 baseline facts changed");
    const prefixCounts = (
      await guard.query<{ accounts: number; versions: number; maps: number; audits: number; idempotency: number; media: number }>(
        `SELECT
          (SELECT count(*)::int FROM zzsh_supply.rental_account WHERE id LIKE $1) AS accounts,
          (SELECT count(*)::int FROM zzsh_supply.listing_version WHERE id LIKE $1 OR account_id LIKE $1) AS versions,
          (SELECT count(*)::int FROM zzsh_supply.legacy_supply_map WHERE source_system LIKE $1) AS maps,
          (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id LIKE $1) AS audits,
          (SELECT count(*)::int FROM zzsh_supply.idempotency_record WHERE scope_key LIKE $1 OR response_body::text LIKE $1) AS idempotency,
          (SELECT count(*)::int FROM zzsh_supply.media_asset WHERE id LIKE $1) AS media`,
        [`%${PREFIX}%`],
      )
    ).rows[0]!;
    await rollback(guard);
    assert.ok(prefixCounts.accounts <= 4);
    assert.ok(prefixCounts.media <= 4);
    assert.ok(prefixCounts.versions > 0 && prefixCounts.maps > 0 && prefixCounts.audits > 0 && prefixCounts.idempotency > 0);
    evidence.target!.postflight = {
      protectedBaselineUnchanged: true,
      committedTechnicalPrefix: { ...prefixCounts, marker: TECH_ONLY },
      realSourceRefs: [],
      publicationFactsWritten: false,
      quoteFactsWritten: false,
      fundingFactsWritten: false,
      orderFactsWritten: false,
    };
    evidence.status = "PASS";
  } finally {
    if (guard && lockHeld) {
      try {
        await guard.query("SELECT pg_advisory_unlock($1::bigint)", [RESOURCE_LOCK]);
      } catch (error) {
        evidence.notes.push(`resource lock release error: ${serializedError(error).message}`);
      }
    }
    guard?.release();
    await runtimePool.end();
    await migrationPool.end();
  }
}

type OfflineConcurrencyClient = {
  failBegin: boolean;
  released: number;
  rollbacks: number;
  committed: number;
  release(): void;
  query(text: string): Promise<{ rows: never[]; rowCount: number }>;
};

function offlineConcurrencyClient(failBegin = false): OfflineConcurrencyClient {
  const client = { failBegin, released: 0, rollbacks: 0, committed: 0 } as OfflineConcurrencyClient;
  client.release = () => {
    client.released += 1;
  };
  client.query = async (text: string) => {
    if (text === "BEGIN" && client.failBegin) throw new Error("simulated BEGIN failure");
    if (text === "ROLLBACK") client.rollbacks += 1;
    if (text === "COMMIT") client.committed += 1;
    return { rows: [], rowCount: 0 };
  };
  return client;
}

function offlineConcurrencyPool(sequence: Array<OfflineConcurrencyClient | Error>): Pick<Pool, "connect"> {
  let index = 0;
  return {
    async connect() {
      const next = sequence[index++];
      if (!next) throw new Error("fake pool sequence exhausted");
      if (next instanceof Error) throw next;
      return next as unknown as PoolClient;
    },
  };
}

test("REAL-SOURCE-5 concurrency helper releases the first client when the second connection fails", async () => {
  const first = offlineConcurrencyClient();
  await assert.rejects(
    () => concurrent(offlineConcurrencyPool([first, new Error("simulated second connect failure")]), [async () => "first", async () => "second"]),
    /second connect failure/,
  );
  assert.equal(first.released, 1);
  assert.equal(first.rollbacks, 0);
});

test("REAL-SOURCE-5 source lock pair releases the first client when the waiter connection fails", async () => {
  const first = offlineConcurrencyClient();
  await assert.rejects(
    () => connectPair(offlineConcurrencyPool([first, new Error("simulated source waiter connect failure")])),
    /source waiter connect failure/,
  );
  assert.equal(first.released, 1);
});

test("REAL-SOURCE-5 concurrency helper cancels the peer barrier when one BEGIN fails", async () => {
  const first = offlineConcurrencyClient(true);
  const second = offlineConcurrencyClient();
  const started = Date.now();
  const outcomes = await concurrent(offlineConcurrencyPool([first, second]), [async () => "first", async () => "second"]);
  assert.ok(Date.now() - started < 500, "peer barrier did not cancel promptly");
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.every((outcome) => !outcome.ok), true);
  assert.equal(first.released, 1);
  assert.equal(second.released, 1);
  assert.equal(first.rollbacks, 1);
  assert.equal(second.rollbacks, 1);
});

test("REAL-SOURCE-5 concurrency barrier observes cancellation before a peer arrives", async () => {
  const gate = createBarrier(2, 100);
  const waiting = gate.wait();
  gate.cancel(new Error("peer failed before arrival"));
  await assert.rejects(waiting, /peer failed before arrival/);
});

test("REAL-SOURCE-5 concurrency barrier has an independent bounded timeout", async () => {
  const started = Date.now();
  const gate = createBarrier(2, 25);
  gate.arrive();
  await assert.rejects(() => gate.wait(), /concurrency barrier timed out/);
  assert.ok(Date.now() - started < 500, "barrier timeout was not bounded");
});

test("REAL-SOURCE-5 concurrency barrier delivers cancellation to a wait arriving across event-loop turns", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = createBarrier(2, 1000);
    gate.cancel(new Error("peer BEGIN failed before other waiter arrived"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => gate.wait(), /peer BEGIN failed before other waiter arrived/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("REAL-SOURCE-5 concurrency barrier delivers timeout to a wait arriving across event-loop turns", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = createBarrier(2, 25);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(() => gate.wait(), /concurrency barrier timed out/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

if (process.env.REAL_SOURCE_5_CREDENTIALS_FILE) {
  test("REAL-SOURCE-5 baseline_accept PG technical acceptance", async () => {
    const evidence: Evidence = {
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      cases: [],
      notes: [
        "TECH_ONLY fixtures only; no real-source refs, source IDs, or publication facts are permitted.",
        "The service was called with the registered runtime role on one PoolClient per transaction.",
        "This is PG/service evidence, not browser, HTTP, BFF, or real-source qualification evidence.",
      ],
    };
    try {
      await runAcceptance(evidence);
    } catch (error) {
      evidence.status = "FAIL";
      evidence.failure = serializedError(error);
      throw error;
    } finally {
      evidence.endedAt = new Date().toISOString();
      const output = process.env.REAL_SOURCE_5_RESULT_FILE;
      if (output) await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    assert.equal(evidence.status, "PASS");
  });
}
