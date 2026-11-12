import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { handleAdminSecurity, type AuthSecurityOptions } from "../src/auth/auth-security";
import { initializeFirstAdministrators, readFirstAdministrators, type InitialAdministratorsInput } from "../src/auth/initial-administrators";

type Security = {
  status: "PENDING_ENROLLMENT" | "ACTIVE";
  isBoss: boolean;
  passwordChangeRequired: boolean;
  bootstrapExpiresAt: Date | null;
  unlimitedInitialEnrollment: boolean;
  bootstrapUsedAt: Date | null;
  firstActivatedAt: Date | null;
};

async function activate(overrides: Partial<Security>, twoFactor = true) {
  const row: Security = { status: "PENDING_ENROLLMENT", isBoss: true, passwordChangeRequired: false,
    bootstrapExpiresAt: null, unlimitedInitialEnrollment: false, bootstrapUsedAt: null, firstActivatedAt: null, ...overrides };
  let writes = 0, audits = 0;
  const query = async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config")) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."admin_security"') && sql.includes('WHERE "admin_user_id"')) return { rows: [{ ...row }] };
    if (sql.startsWith('UPDATE "zzsh_iam"."admin_security"')) { writes++; row.status = "ACTIVE"; return { rows: [] }; }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { audits++; return { rows: [] }; }
    throw new Error("Unexpected fixture query");
  };
  const client = { query, release() {} } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pool;
  const auth = { api: { getSession: async () => ({ user: { id: "admin_fixture", twoFactorEnabled: twoFactor },
    session: { id: "session_fixture", locked: false } }) } };
  const options = { pool, adminAuth: auth, userAuth: auth, apiOrigin: "http://127.0.0.1:4292", adminOrigin: "http://127.0.0.1:4291" } as unknown as AuthSecurityOptions;
  let status = 200;
  const response = { setHeader() { return this; }, status(value: number) { status = value; return this; }, json() {} };
  await handleAdminSecurity({ method: "POST", url: "/api/v1/admin/security/enrollment/activate", body: {},
    headers: { origin: options.adminOrigin, "x-request-id": "req_fixture" } }, response, options);
  return { status, writes, audits };
}

test("first Boss activation has no expiry, including pending accounts created by an older version", async () => {
  for (const bootstrapExpiresAt of [null, new Date("2020-01-01T00:00:00Z")]) {
    assert.deepEqual(await activate({ bootstrapExpiresAt }), { status: 200, writes: 1, audits: 1 });
  }
});

test("first Boss still requires a changed password, TOTP and an unused activation", async () => {
  assert.deepEqual(await activate({ passwordChangeRequired: true }), { status: 403, writes: 0, audits: 0 });
  assert.deepEqual(await activate({}, false), { status: 403, writes: 0, audits: 0 });
  assert.deepEqual(await activate({ bootstrapUsedAt: new Date() }), { status: 409, writes: 0, audits: 0 });
});

test("initial operations account can activate without a deadline, but its later recovery cannot", async () => {
  assert.deepEqual(await activate({ isBoss: false, unlimitedInitialEnrollment: true }), { status: 200, writes: 1, audits: 1 });
  assert.deepEqual(await activate({ isBoss: false, unlimitedInitialEnrollment: true, firstActivatedAt: new Date("2019-01-01T00:00:00Z") }), { status: 409, writes: 0, audits: 0 });
});

test("ordinary and previously activated Boss recovery retain their activation deadlines", async () => {
  for (const overrides of [
    { isBoss: false, bootstrapExpiresAt: null },
    { isBoss: false, bootstrapExpiresAt: new Date("2020-01-01T00:00:00Z") },
    { firstActivatedAt: new Date("2019-01-01T00:00:00Z"), bootstrapExpiresAt: new Date("2020-01-01T00:00:00Z") },
  ]) assert.deepEqual(await activate(overrides), { status: 409, writes: 0, audits: 0 });
});

const initialInput: InitialAdministratorsInput = {
  bosses: [{ name: "Boss 1", password: "fixture-password-boss-1" }, { name: "Boss 2", password: "fixture-password-boss-2" }],
  operations: [{ name: "运营 1", password: "fixture-password-ops-1" }, { name: "运营 2", password: "fixture-password-ops-2" }],
};

test("initial administrator creation requires a transaction and four distinct valid passwords", async () => {
  let queries = 0, hashes = 0;
  const client = { getTransactionStatus: () => "I", query: async () => { queries++; return { rows: [] }; } } as unknown as PoolClient;
  const hash = async () => { hashes++; return "fixture-hash"; };
  await assert.rejects(initializeFirstAdministrators(client, initialInput, hash, "init-fixture"), /INITIAL_ADMINS_TRANSACTION_REQUIRED/);
  (client as unknown as { getTransactionStatus: () => string }).getTransactionStatus = () => "T";
  const duplicate: InitialAdministratorsInput = { ...initialInput, operations: [initialInput.operations[0], initialInput.bosses[0]] };
  await assert.rejects(initializeFirstAdministrators(client, duplicate, hash, "init-fixture"), /INITIAL_ADMINS_INPUT_INVALID/);
  assert.equal(queries, 0); assert.equal(hashes, 0);
});

test("initial administrator creation refuses occupied targets and an unsafe operations preset before hashing", async () => {
  for (const occupied of [true, false]) {
    let hashes = 0, writes = 0;
    const client = { getTransactionStatus: () => "T", async query(sql: string) {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("AS occupied")) return { rows: [{ occupied }] };
      if (sql.includes("AS valid")) return { rows: [{ valid: false }] };
      writes++; throw new Error("unexpected write");
    } } as unknown as PoolClient;
    await assert.rejects(initializeFirstAdministrators(client, initialInput, async () => { hashes++; return "hash"; }, "init-fixture"),
      occupied ? /INITIAL_ADMINS_TARGET_NOT_EMPTY/ : /INITIAL_ADMINS_OPERATIONS_ROLE_NOT_READY/);
    assert.equal(hashes, 0); assert.equal(writes, 0);
  }
});

function initialReadFixture() {
  const state = { isolation: "repeatable read", read_only: "on", users: 4, credentials: 4, security: 4, sessions: 0, factors: 0, ops_role_ready: true };
  const passwords=[...initialInput.bosses,...initialInput.operations];
  const rows=passwords.map((account,index)=>({id:`admin_fixture_${index}`,actor_type:"system",actor_id:null,session_id:null,outcome:"SUCCESS",
    details:{username:`ZZ${String(index+1).padStart(5,'0')}`,role:index<2?"BOSS":"OPERATIONS"},name:account.name,
    username:`zz${String(index+1).padStart(5,'0')}`,two_factor:false,suspended:false,status:"PENDING_ENROLLMENT",is_boss:index<2,
    password_change_required:true,first_activated_at:null,bootstrap_used_at:null,expiry_null:index<2,expiry_infinite:index>=2,
    game_scope_mode:"ALL_GAMES",credential_count:1,password_hash:`hash_${index}`,roles:index<2?null:["role_preset_ops"],individual_permissions:0}));
  const client={getTransactionStatus:()=>"T",query:async(sql:string)=>sql.includes("current_setting('transaction_isolation')")?{rows:[state]}:{rows:[...rows].reverse()}} as unknown as PoolClient;
  const verify=async({password,hash}:{password:string;hash:string})=>password===passwords[Number(hash.slice(5))]?.password;
  return {state,rows,client,verify};
}

test("initial administrator recovery only confirms the same four pending accounts and passwords",async()=>{
  const f=initialReadFixture(),result=await readFirstAdministrators(f.client,initialInput,f.verify,"initial-fixture");
  assert.deepEqual(result,{knowledge:"KNOWN",accounts:[{username:"ZZ00001",role:"BOSS"},{username:"ZZ00002",role:"BOSS"},
    {username:"ZZ00003",role:"OPERATIONS"},{username:"ZZ00004",role:"OPERATIONS"}]});
  assert(!JSON.stringify(result).includes("fixture-password"));assert(!JSON.stringify(result).includes("hash_"));
  const changed=structuredClone(initialInput);changed.operations[1].password="different-password-123";
  await assert.rejects(readFirstAdministrators(f.client,changed,f.verify,"initial-fixture"),/INITIAL_ADMINS_READBACK_CONFLICT/);
});

test("initial administrator recovery preserves unknown and rejects partial or changed evidence",async()=>{
  const f=initialReadFixture();f.rows.length=0;Object.assign(f.state,{users:0,credentials:0,security:0});
  assert.deepEqual(await readFirstAdministrators(f.client,initialInput,f.verify,"initial-fixture"),{knowledge:"UNKNOWN",accounts:null});
  f.state.users=1;await assert.rejects(readFirstAdministrators(f.client,initialInput,f.verify,"initial-fixture"),/INITIAL_ADMINS_READBACK_CONFLICT/);
  for(const mutate of [
    (x:ReturnType<typeof initialReadFixture>)=>{x.rows[0]!.outcome="FAILURE";},
    (x:ReturnType<typeof initialReadFixture>)=>{x.rows[2]!.expiry_infinite=false;},
    (x:ReturnType<typeof initialReadFixture>)=>{x.rows[3]!.roles=["role_preset_ops","role_extra"];},
    (x:ReturnType<typeof initialReadFixture>)=>{x.state.sessions=1;},
    (x:ReturnType<typeof initialReadFixture>)=>{x.state.ops_role_ready=false;},
    (x:ReturnType<typeof initialReadFixture>)=>{x.rows.push({...x.rows[0]!});},
  ]){const sample=initialReadFixture();mutate(sample);await assert.rejects(readFirstAdministrators(sample.client,initialInput,sample.verify,"initial-fixture"),/INITIAL_ADMINS_READBACK_CONFLICT/);}
});

test("initial administrator recovery requires a read-only snapshot and sanitizes verifier failures",async()=>{
  const f=initialReadFixture();f.state.read_only="off";
  await assert.rejects(readFirstAdministrators(f.client,initialInput,f.verify,"initial-fixture"),/INITIAL_ADMINS_READ_ONLY_REQUIRED/);
  f.state.read_only="on";f.state.isolation="read committed";
  await assert.rejects(readFirstAdministrators(f.client,initialInput,f.verify,"initial-fixture"),/INITIAL_ADMINS_READ_ONLY_REQUIRED/);
  f.state.isolation="repeatable read";
  await assert.rejects(readFirstAdministrators(f.client,initialInput,async()=>{throw Error("sensitive-fixture");},"initial-fixture"),error=>error instanceof Error&&error.message==="INITIAL_ADMINS_VERIFY_FAILED");
});
