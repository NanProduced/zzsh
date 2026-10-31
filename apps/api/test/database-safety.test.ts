import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../src/auth/security-core";
import { assertBusinessRuntimeIdentity, BusinessDatabaseService, createBusinessPool } from "../src/database/business";
import { closeResource, finishDatabaseTest } from "./database-test-support";
import { applyRuntimePrivileges, configureSkinIdentityPrivileges } from "../src/database/business-migrations";

test('directory pool is single-use within the existing ten business connection slots and both pools close',async()=>{
  const config={database:{host:'127.0.0.1',port:1,name:'offline',user:'offline',password:'offline'}},shared=createBusinessPool(config,{max:8}),directory=createBusinessPool(config,{max:2,maxUses:1});
  assert.equal(shared.options.max!+directory.options.max!,10);
  assert.equal(directory.options.maxUses,1);
  assert.equal(shared.totalCount,0);assert.equal(directory.totalCount,0);
  await new BusinessDatabaseService(shared,directory).onApplicationShutdown();
  assert.equal(shared.ended,true);assert.equal(directory.ended,true);
});

test('database shutdown attempts both pools and preserves an end failure',async()=>{
  const original=new Error('end failed'),closed:string[]=[];
  const shared={end:async()=>{closed.push('shared');throw original;}} as unknown as Pool;
  const directory={end:async()=>{closed.push('directory');}} as unknown as Pool;
  await assert.rejects(new BusinessDatabaseService(shared,directory).onApplicationShutdown(),error=>error===original);
  assert.deepEqual(closed,['shared','directory']);
});

test("identity failure closes the resource without DROP or CREATE", async () => {
  const events: string[] = [];
  let authorized = true;
  try {
    events.push("IDENTITY");
    throw new Error("wrong database identity");
  } catch {
    authorized = false;
  }
  await closeResource(
    authorized,
    { release: (destroy) => events.push(destroy ? "release:destroy" : "release") },
    async () => {
      events.push("DROP/CREATE");
    },
  );
  assert.deepEqual(events, ["IDENTITY", "release:destroy"]);
});

test("cleanup failure still closes both pools and preserves the primary error", async () => {
  const events: string[] = [];
  const primaryError = new Error("primary failure");
  await assert.rejects(
    () =>
      finishDatabaseTest(
        primaryError,
        async () => {
          events.push("reset");
          throw new Error("reset cleanup failure");
        },
        async () => {
          events.push("test:end");
        },
        async () => {
          events.push("admin:end");
        },
      ),
    (error: unknown) => error === primaryError,
  );
  assert.deepEqual(events, ["reset", "test:end", "admin:end"]);
});

const skinMetadataColumns = ["rarity_evidence", "is_collectible", "default_state", "media_source"];

function skinAclFixture(metadata: readonly string[]) {
  const writes: string[] = [];
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.includes("count(*)")) {
      const names = args[0] as string[];
      return { rows: [{ count: names.includes("owner_kind") ? 7 : names.filter(name => metadata.includes(name)).length }] };
    }
    if (sql.includes("AS present")) return { rows: [{ present: true }] };
    writes.push(sql); return { rows: [] };
  } } as unknown as Parameters<typeof configureSkinIdentityPrivileges>[0];
  return { pool, writes };
}

test("skin ACL grants new metadata only for the complete schema and keeps derived and stable fields denied", async () => {
  for (const metadata of [[], skinMetadataColumns]) {
    const f = skinAclFixture(metadata);
    await configureSkinIdentityPrivileges(f.pool, "fixture_runtime");
    assert.equal(f.writes.length, 1);
    const sql = f.writes[0]!;
    assert.match(sql, /REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON zzsh_supply\.skin FROM/);
    assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|ALL)(?:\s*,[^()]*)?\s+ON (?:TABLE\s+)?zzsh_supply\.skin\s+TO/i);
    const insert = /GRANT INSERT \(([^)]+)\) ON zzsh_supply\.skin TO/.exec(sql)![1]!.split(",");
    const update = /GRANT UPDATE \(([^)]+)\) ON zzsh_supply\.skin TO/.exec(sql)![1]!.split(",");
    for (const field of skinMetadataColumns) {
      assert.equal(insert.includes(field), metadata.length === 4, `INSERT ${field}`);
      assert.equal(update.includes(field), metadata.length === 4, `UPDATE ${field}`);
    }
    for (const field of ["naming_state", "created_at", "updated_at"]) {
      assert.equal(insert.includes(field), false, `INSERT ${field} stays denied`);
      assert.equal(update.includes(field), false, `UPDATE ${field} stays denied`);
    }
    for (const field of ["id", "game_id", "code"]) assert.equal(update.includes(field), false, `UPDATE ${field} stays denied`);
    for (const field of ["owner_kind", "owner_id", "firearm_id", "base_name"]) assert.equal(insert.includes(field), false, `INSERT ${field} stays denied`);
    assert.ok(update.includes("owner_kind"));
    assert.ok(insert.includes("aliases"));
  }
});

test("skin ACL refuses every partial metadata schema before issuing an ACL write", async () => {
  for (const metadata of [skinMetadataColumns.slice(0, 1), skinMetadataColumns.slice(0, 2), skinMetadataColumns.slice(0, 3), ["media_source"]]) {
    const f = skinAclFixture(metadata);
    await assert.rejects(configureSkinIdentityPrivileges(f.pool, "fixture_runtime"), /Skin metadata schema is incomplete/);
    assert.deepEqual(f.writes, [], `partial schema ${metadata.join(",")} sends no grant`);
  }
});

function fundingAclFixture(present: readonly unknown[], incompleteInventory = false) {
  const seen: string[] = [];
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    seen.push(sql);
    if (sql.startsWith("SELECT name,to_regprocedure(name)")) return { rows: (args[0] as string[]).slice(0, incompleteInventory ? 1 : 2).map((name, index) => ({ name, present: present[index] })) };
    if (sql.startsWith("SELECT name,to_regclass")) return { rows: (args[0] as string[]).map(name => ({ name, present: false })) };
    if (sql.includes("count(*)")) return { rows: [{ count: 0, ready: false }] };
    return { rows: [{ relation: null, present: false, proof: false, initializer: false, allocator: null, ready: false }] };
  } } as unknown as Parameters<typeof applyRuntimePrivileges>[0];
  return { pool, seen, grants: () => seen.filter(sql => sql.includes("GRANT EXECUTE ON FUNCTION zzsh_supply.valid_funding_policy_legacy_v1")) };
}

test("funding validator ACL leaves the old prefix alone and explicitly grants only the complete v2 function set", async () => {
  const old = fundingAclFixture([false, false]);
  await applyRuntimePrivileges(old.pool, "fixture_runtime");
  assert.deepEqual(old.grants(), []);
  const current = fundingAclFixture([true, true]);
  await applyRuntimePrivileges(current.pool, "fixture_runtime");
  const first = [...current.seen];
  assert.equal(current.grants().length, 1);
  const sql = current.grants()[0]!;
  assert.match(sql, /valid_funding_policy_legacy_v1\(jsonb\)/);
  assert.match(sql, /valid_funding_policy_draft\(jsonb\)/);
  assert.match(sql, /zzsh_supply\.valid_funding_policy\(jsonb\) TO "fixture_runtime"/);
  assert.doesNotMatch(sql, /ALL FUNCTIONS|PUBLIC|SECURITY DEFINER/);
  current.seen.length = 0;
  await applyRuntimePrivileges(current.pool, "fixture_runtime");
  assert.deepEqual(current.seen, first, "the same common ACL entry converges on repeated invocation");
});

test("funding validator ACL refuses either partial deployment and incomplete or unknown inventory", async () => {
  for (const present of [[true, false], [false, true]]) {
    const f = fundingAclFixture(present);
    await assert.rejects(applyRuntimePrivileges(f.pool, "fixture_runtime"), /Funding validator schema is incomplete/);
    assert.deepEqual(f.grants(), []);
  }
  for (const f of [fundingAclFixture([true, true], true), fundingAclFixture([undefined, false]), fundingAclFixture(["false", false])]) {
    await assert.rejects(applyRuntimePrivileges(f.pool, "fixture_runtime"), /Funding validator inventory is incomplete/);
    assert.deepEqual(f.grants(), []);
  }
});

type ScriptedClient = PoolClient & { queries: string[]; releases: (boolean | undefined)[] };

function scriptedClient(failures: { begin?: Error; commit?: Error; rollback?: Error } = {}): ScriptedClient {
  const queries: string[] = [];
  const releases: (boolean | undefined)[] = [];
  return {
    queries,
    releases,
    async query(text: string) {
      queries.push(text);
      if (text === "BEGIN" && failures.begin) throw failures.begin;
      if (text === "COMMIT" && failures.commit) throw failures.commit;
      if (text === "ROLLBACK" && failures.rollback) throw failures.rollback;
      return { rows: [] };
    },
    release(destroy?: boolean) {
      releases.push(destroy);
    },
  } as unknown as ScriptedClient;
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

test("withTransaction commits the callback result and returns the client to the pool", async () => {
  const client = scriptedClient();
  const result = await withTransaction(poolFor(client), async () => "ok");
  assert.equal(result, "ok");
  assert.deepEqual(client.queries, ["BEGIN", "COMMIT"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction rethrows the callback error and reuses the client after a confirmed ROLLBACK", async () => {
  const client = scriptedClient();
  const failure = new Error("callback failure");
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => { throw failure; }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction retires the client exactly once when ROLLBACK is not confirmed", async () => {
  const failure = new Error("callback failure");
  const client = scriptedClient({ rollback: new Error("rollback not acknowledged") });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => { throw failure; }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(client.releases, [true]);
});

test("withTransaction keeps the COMMIT error even when ROLLBACK is acknowledged", async () => {
  const commitFailure = new Error("commit outcome unknown");
  const client = scriptedClient({ commit: commitFailure });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => "unreachable"),
    (error: unknown) => error === commitFailure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction retires the client when neither COMMIT nor ROLLBACK is confirmed", async () => {
  const commitFailure = new Error("commit outcome unknown");
  const client = scriptedClient({ commit: commitFailure, rollback: new Error("rollback not acknowledged") });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => "unreachable"),
    (error: unknown) => error === commitFailure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.deepEqual(client.releases, [true]);
});

test("withTransaction rolls back and releases normally when BEGIN fails", async () => {
  const beginFailure = new Error("begin rejected");
  const client = scriptedClient({ begin: beginFailure });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => "unreachable"),
    (error: unknown) => error === beginFailure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction propagates a pool connect failure without releasing a client", async () => {
  const connectFailure = new Error("pool unavailable");
  let connects = 0;
  const pool = {
    connect: async () => {
      connects += 1;
      throw connectFailure;
    },
  } as unknown as Pool;
  await assert.rejects(
    () => withTransaction(pool, async () => "unreachable"),
    (error: unknown) => error === connectFailure,
  );
  assert.equal(connects, 1);
});

type CapturedQuery = { sql: string; args: unknown[] };

function runtimeIdentityPool(options: {
  identity?: Record<string, unknown> | null;
  ownership?: Record<string, unknown> | null;
}): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const pool = {
    async query(sql: string, args?: unknown[]) {
      queries.push({ sql, args: args ?? [] });
      if (sql.includes("ownsBusinessSchema")) {
        return { rows: options.ownership === null ? [] : [options.ownership ?? { ownsBusinessSchema: false, ownsBusinessRelation: false, hasPrivilegedMembership: false }] };
      }
      return { rows: options.identity === null ? [] : [options.identity] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function leastPrivilegeIdentityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseName: "zzsh_business",
    currentUser: "zzsh_runtime",
    owner: "zzsh_owner",
    isSuperuser: false,
    canCreateRole: false,
    canCreateDb: false,
    canReplicate: false,
    canBypassRls: false,
    canCreateDatabase: false,
    canCreateIamSchema: false,
    canCreateUserSchema: false,
    canCreateAdminSchema: false,
    canCreateSupplySchema: false,
    canCreateOrderSchema: false,
    canCreateContentSchema: false,
    canUpdateAudit: false,
    canDeleteAudit: false,
    canTruncateAudit: false,
    ...overrides,
  };
}

const RUNTIME_IDENTITY_CONFIG = { database: { name: "zzsh_business", user: "zzsh_migration", runtimeUser: "zzsh_runtime" } };

test("runtime identity probes content schema ownership and CREATE while accepting a least-privilege role", async () => {
  const { pool, queries } = runtimeIdentityPool({ identity: leastPrivilegeIdentityRow() });
  await assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG);
  const identityQuery = queries.find((entry) => entry.sql.includes('"databaseName"'));
  const ownershipQuery = queries.find((entry) => entry.sql.includes("ownsBusinessSchema"));
  assert.ok(identityQuery && ownershipQuery);
  assert.match(identityQuery.sql, /COALESCE\(has_schema_privilege\(current_user, to_regnamespace\('zzsh_content'\)::oid, 'CREATE'\), false\)/,
    "content CREATE probe must resolve the optional schema by OID so a missing schema yields false instead of throwing 3F000");
  assert.doesNotMatch(identityQuery.sql, /has_schema_privilege\(current_user, 'zzsh_content', 'CREATE'\)/,
    "the name overload throws undefined_schema when the optional content schema is absent");
  const schemas = ownershipQuery.args[0] as string[];
  assert.ok(schemas.includes("zzsh_content"), "ownership probe must cover the content schema");
  assert.equal(schemas.length, 8);
});

test("runtime identity rejects a role owning the content schema", async () => {
  const { pool } = runtimeIdentityPool({
    identity: leastPrivilegeIdentityRow(),
    ownership: { ownsBusinessSchema: true, ownsBusinessRelation: false, hasPrivilegedMembership: false },
  });
  await assert.rejects(() => assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG), /least privilege/);
});

test("runtime identity rejects a role owning a content relation", async () => {
  const { pool } = runtimeIdentityPool({
    identity: leastPrivilegeIdentityRow(),
    ownership: { ownsBusinessSchema: false, ownsBusinessRelation: true, hasPrivilegedMembership: false },
  });
  await assert.rejects(() => assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG), /least privilege/);
});

test("runtime identity rejects a role holding CREATE on the content schema", async () => {
  const { pool } = runtimeIdentityPool({ identity: leastPrivilegeIdentityRow({ canCreateContentSchema: true }) });
  await assert.rejects(() => assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG), /least privilege/);
});

test("runtime identity treats a NULL content CREATE projection (absent schema) as no privilege, not a violation", async () => {
  const { pool } = runtimeIdentityPool({ identity: leastPrivilegeIdentityRow({ canCreateContentSchema: null }) });
  await assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG);
});


// 真实pg/pg-pool在子进程内借出无socket Client，避免未捕获error杀死测试宿主。
const businessClientErrorProbe = String.raw`
  const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),net=require('node:net');
  const {createBusinessPool}=require(BUSINESS_MODULE),{withTransaction}=require(SECURITY_MODULE);
  let socketAttempts=0;const forbid=()=>{socketAttempts++;throw Error('OFFLINE_SOCKET_FORBIDDEN');};
  net.Socket.prototype.connect=forbid;net.connect=forbid;net.createConnection=forbid;net.Server.prototype.listen=forbid;
  const failure=Object.assign(Error('DO_NOT_LOG_SYNTHETIC_SECRET'),{code:'ECONNRESET'}),clients=[],queries=[],logs=[];
  class Client extends EventEmitter{
    constructor(config){super();this.config=config;this._queryable=true;this._ending=false;this.processID=700+clients.length;clients.push(this);}
    connect(cb){process.nextTick(()=>cb(null));}
    query(sql,values,cb){if(typeof values==='function')cb=values;queries.push(sql);
      const result=new Promise((resolve,reject)=>{
        if(!this._queryable){process.nextTick(()=>reject(Error('Connection is not queryable')));return;}
        if(MODE==='active'&&sql==='COMMIT'){this._queryable=false;process.nextTick(()=>{process.nextTick(()=>reject(failure));this.emit('error',failure);});return;}
        process.nextTick(()=>resolve({command:sql,rows:[]}));
      });
      if(cb){result.then(r=>cb(null,r),e=>cb(e));return;}return result;
    }
    end(cb){if(this._ending){if(cb)process.nextTick(cb);return Promise.resolve();}this._ending=true;return new Promise(resolve=>process.nextTick(()=>{this.emit('end');cb?.();resolve();}));}
  }
  const previousError=console.error;console.error=line=>logs.push(JSON.parse(String(line)));
  const pool=createBusinessPool({database:{host:'127.0.0.1',port:1,name:'SYNTHETIC_OFFLINE',user:'SYNTHETIC_OFFLINE',password:'SYNTHETIC_NOT_A_CREDENTIAL'}});
  Object.assign(pool,{Client});
  (async()=>{let originalErrorPreserved=false,idleRemoved=false;
    try{
      if(MODE==='active'){
        let caught;try{await withTransaction(pool,async()=>({mustNotReturn:true}));}catch(e){caught=e;}
        assert.equal(caught,failure);originalErrorPreserved=true;await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(queries,['BEGIN','COMMIT','ROLLBACK']);assert.equal(pool.totalCount,0);
        assert.equal(logs.filter(x=>x.event==='business_pool_client_error').length,1);
      }else{
        const client=await pool.connect();const listenerCount=client.listenerCount('error');client.release();assert.equal(listenerCount,1);client.emit('error',failure);
        await new Promise(resolve=>setImmediate(resolve));assert.equal(pool.totalCount,0);idleRemoved=true;
        assert.equal(logs.filter(x=>x.event==='business_pool_idle_client_error').length,1);
        const replacement=await pool.connect();assert.notEqual(replacement,client);assert.equal(replacement.listenerCount('error'),1);replacement.release();
      }
      await pool.end();assert.equal(socketAttempts,0);assert(!JSON.stringify(logs).includes(failure.message));assert(!JSON.stringify(logs).includes('SYNTHETIC_NOT_A_CREDENTIAL'));
      assert(logs.every(x=>Object.keys(x).sort().join(',')==='backendPid,code,event'));
      console.error=previousError;process.stdout.write(JSON.stringify({mode:MODE,originalErrorPreserved,idleRemoved,logs,physicalClients:clients.length,socketAttempts})+'\n');
    }finally{if(!pool.ended)await pool.end();console.error=previousError;}
  })().catch(e=>{console.error(e);process.exitCode=2;});
`;
function probeBusinessClientError(mode: "active" | "idle") {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const source = "const MODE=" + JSON.stringify(mode) + ";const BUSINESS_MODULE=" + JSON.stringify(require.resolve("../src/database/business")) + ";const SECURITY_MODULE=" + JSON.stringify(require.resolve("../src/auth/security-core")) + ";" + businessClientErrorProbe;
  return spawnSync(process.execPath, ["-e", source], { encoding: "utf8", env });
}
test("business pool keeps active client transport error observable without losing the original COMMIT error", () => {
  const child = probeBusinessClientError("active"); assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout); assert.equal(result.originalErrorPreserved, true); assert.equal(result.socketAttempts, 0);
  assert.equal(result.logs[0].event, "business_pool_client_error"); assert.equal(result.logs[0].code, "ECONNRESET");
});
test("business pool retains idle removal and one persistent listener per physical client", () => {
  const child = probeBusinessClientError("idle"); assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout); assert.equal(result.idleRemoved, true); assert.equal(result.physicalClients, 2); assert.equal(result.socketAttempts, 0);
  assert(result.logs.some((row: { event: string }) => row.event === "business_pool_idle_client_error"));
});

test("0116 throttle ACL skips an old prefix, rejects partial schema, and grants only the complete table set", async () => {
  const make = (shape: { failures: string | null; locks: string | null; proofs: string | null }) => {
    const base = fundingAclFixture([false, false]);
    const pool = { query: async (sql: string, args: unknown[] = []) => sql.includes("to_regclass('zzsh_iam.admin_auth_failure')")
      ? { rows: [shape] } : base.pool.query(sql, args) } as unknown as Parameters<typeof applyRuntimePrivileges>[0];
    return { pool, grants: () => base.seen.filter(sql => /GRANT/.test(sql) && sql.includes("admin_auth_failure")) };
  };
  const old = make({ failures: null, locks: null, proofs: null });
  await applyRuntimePrivileges(old.pool, "fixture_runtime");
  assert.deepEqual(old.grants(), []);
  const partial = make({ failures: "zzsh_iam.admin_auth_failure", locks: null, proofs: null });
  await assert.rejects(applyRuntimePrivileges(partial.pool, "fixture_runtime"), /Admin throttle schema is incomplete/);
  assert.deepEqual(partial.grants(), []);
  const full = make({ failures: "zzsh_iam.admin_auth_failure", locks: "zzsh_iam.admin_auth_lockout", proofs: "zzsh_iam.admin_auth_captcha_used" });
  await applyRuntimePrivileges(full.pool, "fixture_runtime");
  assert.equal(full.grants().length, 1);
  assert.match(full.grants()[0]!, /GRANT USAGE ON SEQUENCE zzsh_iam.admin_auth_failure_id_seq TO "fixture_runtime"/);
  assert.match(full.grants()[0]!, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE zzsh_iam.admin_auth_lockout/);
});
