import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketFlow,
  contributorSourceSql,
  dashboardVersion,
  distributionSnapshot,
  legacyStock,
  mapEarningRow,
  nativeStock,
  parseDashboardFilters,
  rankingRows,
  readMyDistributionSummary,
  readAdminDistributionEarnings,
  readAdminDistributionOverview,
  readAdminDistributionOverviewSection,
  readUnifiedDistributionOverview,
  readAdminDistributionParticipants,
  readAdminDistributionDownline,
  stockMetrics,
  type DashboardFilters,
} from "../src/finance/admin-distribution-dashboard";
import { unifiedDistributionSourceSql } from "../src/finance/admin-distribution-unified-read";
import { auditLegacyInvitationPacket } from "../src/finance/legacy-invitation-audit";
import { prepareHistoricalObservation } from "../src/finance/personal-finance-read";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";

test("proven positive pending legacy accrual only affects invited contributor counts",()=>{
 const counts=contributorSourceSql(true,true,"TRUE","$1"),ordinary=unifiedDistributionSourceSql(true,true,"TRUE",false);
 assert.match(counts,/pending\.source='LEGACY_IMPORT'/);assert.match(counts,/lo\.source_pay_status=1/);
 assert.match(counts,/pending\.status='PENDING'/);assert.match(counts,/pending\.amount_cents>=0/);
 assert.match(counts,/r\.type='INVITER'/);assert.match(counts,/amount_cents>0 AND state IN\('PENDING','MATURED','SETTLED'\)/);
 assert.match(counts,/legacy_continuation_version h/);assert.doesNotMatch(ordinary,/pending\.source='LEGACY_IMPORT'/);
 assert.doesNotMatch(counts,/\b(INSERT|UPDATE|DELETE)\s+(INTO|zzsh_)/i);
});

const legacy = (id: string, code: string, patch: Record<string, unknown> = {}) => {
  const userId = legacyOwnerUserId("legacy_mysql_restore", "la_user", id);
  return {
    userId, legacyId: id, identitySourceDigest: "a".repeat(64),
    userSource: { id, code, inviter_id: 0, first_leader: 0, is_delete: 0 },
    qualificationSource: { id, user_id: id, is_delete: 0, is_distribution: 1, is_freeze: 0, level_id: "1" },
    childCounts: { INVITER: { all: 0, inPlan: 0 }, DISTRIBUTION_LEADER: { all: 0, inPlan: 0 } },
    ...patch,
  };
};
const packet = {
  schema: "legacy-invitations.v1", sourceSystem: "legacy_mysql_restore", policyVersionId: "policy-1",
  policyConfigDigest: "b".repeat(64), subjects: [legacy("1", "FX1")], gradeMapping: [{ legacyGradeId: "1", levelCode: "L1" }],
  sourceCodeMultiplicity: [{ matchCode: "FX1", count: 1 }],
} as any;

test("distribution dashboard filters use a bounded Beijing period and closed enum values", () => {
  const filters = parseDashboardFilters(new URLSearchParams(), new Date("2026-11-02T03:00:00Z"));
  assert.equal(filters.to, "2026-11-02");
  assert.equal(filters.from, "2026-10-04");
  assert.equal(filters.source, "ALL");
  for (const query of ["from=2026-10-02&to=2026-10-01", "from=2026-10-01&to=2027-10-10", "from=2026-02-30", "to=2026-13-01", "source=OTHER", "page=0", "rankingLimit=5", "rankingLimit=101"]) {
    assert.throws(() => parseDashboardFilters(new URLSearchParams(query)));
  }
});

const dashboardContext = (directoryRead = false, network = true) => ({
  actor: { userId: "admin-1", sessionId: "session-1" }, access: { isBoss: true }, gameScope: {},
  directoryRead, authorizationKey: "access", scope: { isBoss: true, games: network ? "ALL_GAMES" : "SELECTED_GAMES", gameIds: network ? [] : ["game-1"], network: network ? "AVAILABLE" : "UNAVAILABLE", reasonCodes: [] },
}) as any;

test("version hashes visible revisions and optional sources, without unrelated events or hidden names", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ native: "n", events: "e", legacy: "l", participants: "p", relations: "r" }] }; } } as any;
  await dashboardVersion(client, dashboardContext(false, false), false);
  const scoped = calls.at(-1)!.sql;
  assert.match(scoped, /WHERE .*game_id/s);
  assert.doesNotMatch(scoped, /personal_finance_observation|u\.name|FROM zzsh_order\.distribution_participant|FROM zzsh_order\.invitation_relation/);
  assert.match(scoped, /JOIN visible_earnings e ON e\.id=t\.earning_id/);
  await dashboardVersion(client, dashboardContext(true), true);
  assert.match(calls.at(-1)!.sql, /p\.revision,p\.eligibility,p\.commission_frozen/);
  assert.match(calls.at(-1)!.sql, /r\.parent_user_id,r\.child_user_id/);
  assert.match(calls.at(-1)!.sql, /lo\.source_entity='la_order'/, 'version join covers the frozen legacy-order key');
  assert.match(calls.at(-1)!.sql, /u\.name/);
});

test("hidden directory names cannot participate in dashboard list searches; ID searches remain usable", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("to_regclass")) return { rows: [{ native: true, legacy: true }] };
    if (sql.includes("WITH visible_earnings AS")) return { rows: [{ native: "n" }] };
    if (sql.includes("clock_timestamp")) return { rows: [{ at: "2026-11-02T00:00:00Z" }] };
    if (sql.includes("participant_amounts") && sql.includes("ORDER BY")) return { rows: [] };
    if(sql.includes("count(*)::text AS total"))return {rows:[{total:"0"}]};
    if(sql.startsWith('WITH legacy_records'))return {rows:[unifiedAggregate()]};
    return { rows: [] };
  } } as any;
  const f = parseDashboardFilters(new URLSearchParams("q=user-1"));
  await readAdminDistributionEarnings(client, dashboardContext(false), f);
  const list = calls.find(x => x.sql.includes("WITH rows AS"))!.sql;
  assert.doesNotMatch(list.slice(list.indexOf("FROM rows WHERE")), /beneficiary_name/);
  assert.match(list, /lo\.id AS allowed_order_id/);
  assert.match(list, /lo\.source_entity='la_order'/, 'commission join covers the frozen legacy-order key');
  assert.doesNotMatch(list, /::bigint/);
  await readAdminDistributionParticipants(client, dashboardContext(false), f);
  const participants = calls.filter(x => x.sql.includes("ORDER BY COALESCE(a.record_count,0) DESC")).at(-1)!.sql;
  const whereStart = participants.indexOf("WHERE lower");
  assert.ok(whereStart >= 0);
  assert.doesNotMatch(participants.slice(whereStart, participants.indexOf("ORDER BY", whereStart)), /u\.name/);
  assert.match(participants, /participant_amounts/);
  assert.ok(calls.some(x => x.values.includes("%user-1%")));
});

test("period ranking binds timestamps before scope and missing historical sources stay UNKNOWN", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("to_regclass")) return { rows: [{ native: true, legacy: false }] };
    if (sql.includes("WITH visible_earnings AS")) return { rows: [{ native: "n" }] };
    if (sql.includes("clock_timestamp")) return { rows: [{ at: "2026-11-02T00:00:00Z" }] };
    if(sql.startsWith('WITH legacy_records'))return {rows:[unifiedAggregate()]};
    if(sql.includes("count(*)::text AS total"))return {rows:[{total:"0"}]};
    return { rows: [] };
  } } as any;
  const f = parseDashboardFilters(new URLSearchParams("from=2026-10-01&to=2026-10-31&rankingBasis=PERIOD_SETTLED_FLOW"));
  const result = await readAdminDistributionOverview(client, dashboardContext(), f);
  const ranking = calls.find(x => x.sql.startsWith('WITH legacy_records'))!;
  assert.deepEqual(ranking.values, ["admin-1", true,"2026-10-01T00:00:00+08:00", "2026-11-01T00:00:00+08:00"]);
  assert.equal(result.current.settled.knowledge, "UNKNOWN");
  assert.equal(calls.filter(x => x.sql.includes("WITH visible_earnings AS")).length, 1);
  assert.equal(calls.some(x => /FROM zzsh_order\.personal_finance_observation/.test(x.sql)), false);
});

test('invite ranking uses registration relations and marks incomplete source coverage',async()=>{
 const calls:string[]=[];const client={query:async(sql:string)=>{calls.push(sql);
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-02T00:00:00Z'}]};
  if(sql.startsWith('WITH legacy_records'))return{rows:[unifiedAggregate()]};
  if(sql.includes('WHERE r.type=\'INVITER\''))return{rows:[{user_id:'parent',name:'Parent',count:3,partial:true}]};
  if(sql.includes('count(*)::int AS participants'))return{rows:[{participants:1,eligible:1,frozen:0}]};
  return{rows:[]};
 }} as any;
 const read=await readAdminDistributionOverview(client,dashboardContext(),filtersForTest());
 assert.equal(read.rankings.directInvites.knowledge,'PARTIAL');assert.equal(read.rankings.directInvites.items[0]?.count,'3');
 const sql=calls.find(value=>value.includes("WHERE r.type='INVITER'"))!;assert.match(sql,/count\(DISTINCT r\.child_user_id\)/);assert.doesNotMatch(sql,/commission_frozen/);
});

test('overview sections independently return their own authorized projection without the global pagination digest',async()=>{
 const calls:string[]=[];const client={query:async(sql:string)=>{calls.push(sql);
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-02T00:00:00Z'}]};
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true}]};
  if(sql.includes('ranking_rows AS'))return{rows:[{user_id:'person',name:'User',roles:['OWNER_REFERRAL'],cents:'100',count:'1',has_legacy:true}]};
  if(sql.startsWith('WITH legacy_records'))return{rows:[unifiedAggregate()]};
  if(sql.includes("WHERE r.type='INVITER'"))return{rows:[{user_id:'parent',count:3,partial:true}]};
  if(sql.includes('count(*)::int AS participants'))return{rows:[{participants:1,eligible:1,frozen:0}]};
  return{rows:[]};
 }} as any;
 const ctx=dashboardContext(),filters=filtersForTest();
 const core=await readAdminDistributionOverviewSection(client,ctx,filters,'CORE');assert.equal(core.section,'CORE');assert.ok('current' in core);assert.ok(!('ranking' in core));
 const ranking=await readAdminDistributionOverviewSection(client,ctx,filters,'EARNINGS_RANKING');assert.equal(ranking.section,'EARNINGS_RANKING');assert.ok('ranking' in ranking);assert.equal(ranking.ranking.knowledge,'PARTIAL');
 const invite=await readAdminDistributionOverviewSection(client,ctx,filters,'INVITE_RANKING');assert.equal(invite.section,'INVITE_RANKING');assert.ok('ranking' in invite);assert.equal(invite.ranking.items[0]?.count,'3');
 assert.equal(calls.some(sql=>sql.includes('WITH visible_earnings AS')),false);
});

test('installed but empty historical source does not prove ranking coverage',async()=>{
 const client={query:async(sql:string)=>{
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-02T00:00:00Z'}]};
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true,coverage:false}]};
  if(sql.includes('ranking_rows AS'))return{rows:[]};
  throw Error('Unexpected query');
 }} as any;
 const read=await readAdminDistributionOverviewSection(client,dashboardContext(),filtersForTest(),'EARNINGS_RANKING');
 assert.equal(read.section,'EARNINGS_RANKING');assert.ok('ranking' in read);
 assert.deepEqual(read.ranking.items,[]);assert.equal(read.ranking.knowledge,'PARTIAL');
 assert.deepEqual(read.ranking.reasonCodes,['HISTORICAL_COVERAGE_NOT_CLOSED']);
});

// Synthetic SQL response contract; this is not a PostgreSQL or migration acceptance fixture.
function unifiedAggregate(patch: Record<string,unknown> = {}) {
  return {count:'0',legacy_count:'0',record_amount_cents:'0',unknown_state_count:'0',record_states:[],recovery_cents:'0',
    accrued_cents:'0',accrued_count:'0',settled_cents:'0',settled_count:'0',orders:'0',unconfirmed_credit_count:'0',unconfirmed_occurred_count:'0',trend:[],ranking:[],recent:[],...patch};
}

test('unified overview preserves unknown responsibilities, actual recovery, one ranking and exact amounts', async()=>{
  const calls:{sql:string;values:unknown[]}[]=[],large='9007199254740993';
  const client={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return{rows:[unifiedAggregate({count:'4',record_amount_cents:(BigInt(large)+550n).toString(),unknown_state_count:'1',
    record_states:[{state:'SETTLED',count:'1',amountCents:large},{state:'PENDING',count:'1',amountCents:'100'},{state:'UNKNOWN',count:'1',amountCents:'400'},{state:'RECOVERY_REQUIRED',count:'1',amountCents:'50'}],recovery_cents:'20',
    accrued_cents:'100',accrued_count:'1',settled_cents:'95',settled_count:'1',orders:'1',unconfirmed_credit_count:'1',unconfirmed_occurred_count:'2',
    ranking:[{user_id:'second',cents:'100',roles:[]},{user_id:'first',cents:large,roles:[]}],
    recent:[{id:'history:one',source:'LEGACY',amount_cents:large,state:'UNKNOWN',occurred_at:null}]})]};}} as any;
  const read=await readUnifiedDistributionOverview(client,dashboardContext(false),filtersForTest(),{legacy:true,duties:true});
  assert.equal(read.current.settled.cents,large);assert.equal(read.current.pending.cents,'100');assert.equal(read.current.needsReview.count,'1');assert.equal(read.current.recovery.cents,'20');
  assert.equal(read.recordSummary.knowledge,'UNKNOWN');assert.equal(read.flow.unconfirmedCreditCount,'1');assert.equal(read.recent[0]?.occurredAt,null);
  assert.deepEqual(read.earningsRanking.map(x=>x.userId),['first','second']);
  const sql=calls[0]!.sql;
  assert.match(sql,/DISTINCT ON\(p.source_system,p.source_entity,p.source_id,p.user_id,p.snapshot->>'level'\)/);
  assert.match(sql,/sourceOrderType'='1'/);assert.match(sql,/d.order_id=p.allowed_order_id/);assert.match(sql,/source_record_id=p.source_id/);
  assert.match(sql,/legacyChangeType'='1001'.*action'='1'/s);assert.match(sql,/credit.n=1/);assert.match(sql,/rawSource/);assert.match(sql,/legacy_log_candidates AS MATERIALIZED/);assert.match(sql,/credit.amount=p.original->>'earnings'/);assert.match(sql,/credit.original_at=p.original->>'settle_time'/);assert.doesNotMatch(sql,/LATERAL/);
  assert.doesNotMatch(sql,/sourceUpdatedAt|FOR UPDATE|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  const empty=await readUnifiedDistributionOverview({query:async()=>({rows:[unifiedAggregate()]})} as any,dashboardContext(),filtersForTest(),{legacy:true,duties:false});
  assert.equal(empty.current.settled.cents,'0');assert.equal(empty.current.pending.count,'0');assert.equal(empty.recordSummary.knowledge,'UNKNOWN');
});

function summaryRecordRows(){
 const at="2026-11-02T00:00:00.000000Z",native=(id:string,state:string,amount:string)=>({id:"native:"+id,origin:"NATIVE",state,role:"OWNER_REFERRAL",source_amount:amount,occurred_at:at,due_at:at,funds_disposition:state==="RECOVERY_REQUIRED"?"SETTLED":state,recovery_required_cents:state==="RECOVERY_REQUIRED"?amount:null,included:false,version:state==="PENDING"?"1":"2",order_id:id,source_digest:"a".repeat(64)});
 const historical=(id:number,status:number,amount:string)=>{const snapshot={kind:"historicalDistribution",sourceId:id,sourceUserId:11,amount,sourceStatus:status,sourceUpdatedAt:Date.parse(at)/1000,level:2,orderId:70+id},p=prepareHistoricalObservation(snapshot,{userId:"u1",legacyUserId:"11",sourceSystem:"legacy_mysql_restore",basisId:null});return{id:"history:"+id,origin:"LEGACY_MYSQL",state:status===1?"PENDING":"SETTLED",role:"RENTER_REFERRAL",source_amount:amount,occurred_at:at,due_at:null,funds_disposition:"HISTORICAL_STATUS_ONLY",recovery_required_cents:null,included:true,version:"0",order_id:String(70+id),user_id:"u1",legacy_user_id:"11",source_system:p.sourceSystem,source_entity:p.sourceEntity,source_id:p.sourceId,source_digest:p.sourceDigest,source_canonical:p.sourceCanonical,snapshot};};
 return[native("one","SETTLED","100"),native("two","PENDING","25"),native("three","PENDING","25"),native("four","RECOVERY_REQUIRED","30"),historical(1,2,"2.00"),historical(2,1,"0.40")];
}
function emptyRecordAggregate(){return{count:"0",digest:"empty",native_amount_cents:"0",historical_amount_cents:"0",record_amount_cents:"0",unknown_state_count:"0",record_states:[]};}

test("self summary does not turn an uninstalled historical source into a known zero", async () => {
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM "zzsh_auth_user"."user" WHERE "id"')) return { rows: [{ suspended: false }], rowCount: 1 };
    if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [{ accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT" }], rowCount: 1 };
    if (sql.includes('FROM "zzsh_auth_user"."session"')) return { rows: [{}], rowCount: 1 };
    if (sql.includes("to_regclass")) return { rows: [{ native: true, legacy: false, history:false, native_origin:false,legacy_finance:false }] };
    if(sql.includes(" AS count,md5"))return{rows:[emptyRecordAggregate()]};
    if (sql.includes("clock_timestamp")) return { rows: [{ at: "2026-11-02T03:00:00Z" }] };
    assert.doesNotMatch(sql, /FROM zzsh_order\.personal_finance_observation/);
    return { rows: [], rowCount: 0 };
  } } as any;
  const result = await readMyDistributionSummary(client, { userId: "u1", sessionId: "s1" });
  for (const metric of [result.legacy.settled, result.legacy.pending, result.legacy.expired]) assert.deepEqual(metric, { knowledge: "UNKNOWN", cents: null, count: null, reasonCodes: ["LEGACY_SOURCE_NOT_INSTALLED"] });
  assert.equal(result.network.inviter.knowledge,'UNKNOWN');assert.equal(result.network.leader.count,null);assert.match(result.network.leader.reasonCodes.join(','),/INVITEE_MAPPING_NOT_CLOSED/);
});

test("legacy invitation audit reports v1 readiness and the v2 level-mapping gap without writing", () => {
  const v1 = auditLegacyInvitationPacket(packet, { schema: "distribution-policy.v1" });
  assert.equal(v1.subjects, 1);
  assert.equal(v1.v1Compatible, true);
  assert.equal(v1.preparedRelations, 0);
  assert.deepEqual(v1.v2GapCodes, []);
  const v2 = auditLegacyInvitationPacket(packet, { schema: "distribution-policy.v2" });
  assert.equal(v2.v1Compatible, false);
  assert.deepEqual(v2.v2GapCodes, ["V2_POLICY_LEVEL_MAPPING_NOT_ADMITTED"]);
  const collision = auditLegacyInvitationPacket({ ...packet, subjects: [legacy("1", "fX1"), legacy("2", "FX1")], sourceCodeMultiplicity: [{ matchCode: "FX1", count: 1 }] }, { schema: "distribution-policy.v1" });
  assert.equal(collision.codeCaseCollisions, 1);
  assert.equal(collision.v1Compatible, false);
});

test("distribution snapshot binds source/period but allows page navigation", () => {
  const filters: DashboardFilters = { from: "2026-10-01", to: "2026-10-31", source: "NATIVE", state: "ALL", role: "ALL", q: "", page: 1, pageSize: 20, rankingBasis: "CURRENT_SETTLED_STOCK", rankingLimit: 10, sort: "recordCount", order: "desc" };
  const context = { actor: { userId: "admin", sessionId: "session" }, authorizationKey: "access", scope: { isBoss: true, games: "ALL_GAMES", gameIds: [], network: "AVAILABLE", reasonCodes: [] } } as any;
  const key = { keyId: "test", secret: "x".repeat(32) };
  const first = distributionSnapshot("v1", "2026-11-02T00:00:00Z", filters, context, key);
  const next = distributionSnapshot("v1", "2026-11-02T00:00:00Z", { ...filters, page: 2 }, context, key, first.token);
  assert.equal(next.version, "v1");
  assert.throws(() => distributionSnapshot("v1", "2026-11-02T00:00:00Z", { ...filters, source: "LEGACY" }, context, key, first.token), (error: any) => error.status === 409);
});

test("self summary keeps native and historical stocks separate and uses SETTLE flow for today/month", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM "zzsh_auth_user"."user" WHERE "id"')) return { rows: [{ suspended: false }], rowCount: 1 };
      if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [{ accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT" }], rowCount: 1 };
      if (sql.includes('FROM "zzsh_auth_user"."session"')) return { rows: [{}], rowCount: 1 };
      if(sql.includes("finance history coverage installed"))return{rows:[{installed:false}]};
      if (sql.includes("to_regclass")) return { rows: [{ native: true, legacy: true,history:true,native_origin:false,legacy_finance:false }], rowCount: 1 };
      if(sql.includes(" AS count,md5"))return{rows:[{count:"6",digest:"records",native_amount_cents:"180",historical_amount_cents:"240",record_amount_cents:"420",unknown_state_count:"1",record_states:[{state:"SETTLED",count:"2",amountCents:"300"},{state:"PENDING",count:"2",amountCents:"50"},{state:"RECOVERY_REQUIRED",count:"1",amountCents:"30"},{state:"UNKNOWN",count:"1",amountCents:"40"}]}]};
      if(sql.startsWith("WITH original_earnings"))return{rows:summaryRecordRows()};
      if(sql.startsWith("SELECT invitees_knowledge"))return{rows:[{invitees_knowledge:"KNOWN"}]};
      if (sql.includes("clock_timestamp()")) return { rows: [{ at: "2026-11-02T03:00:00Z" }], rowCount: 1 };
      if (sql.includes("WHERE beneficiary_user_id=$1 GROUP BY state")) return { rows: [{ state: "SETTLED", count: 1, cents: "100" }, { state: "PENDING", count: 2, cents: "50" }, { state: "RECOVERY_REQUIRED", count: 1, cents: "30" }], rowCount: 3 };
      if (sql.includes("source_kind='HISTORICAL_DISTRIBUTION'")) return { rows: [{ status: "2", count: 1, cents: "200" }, { status: "1", count: 1, cents: "40" }], rowCount: 2 };
      if (sql.includes("GROUP BY f.kind,t.action")) return { rows: [{ kind: "EARNING_SETTLED", action: "SETTLE", cents: "100", count: 1 }], rowCount: 1 };
      if (sql.includes("to_char(f.created_at")) return { rows: [{ day: "2026-11-02", cents: "100" }], rowCount: 1 };
      if (sql.includes("count(DISTINCT order_id)")) return { rows: [{ count: "4" }], rowCount: 1 };
      if (sql.includes("FROM zzsh_order.invitation_relation WHERE parent_user_id")) return { rows: [{ type: "DISTRIBUTION_LEADER", count: 2 }], rowCount: 1 };
      if (sql.includes("ORDER BY e.created_at DESC LIMIT 5")) return { rows: [{ id: "earning-1", source: "NATIVE", beneficiary_id: "u1", beneficiary_name: "U", role: "OWNER_REFERRAL", amount_cents: "100", state: "SETTLED", occurred_at: "2026-11-02T00:00:00Z" }], rowCount: 1 };
      throw new Error("unexpected query: " + sql.slice(0, 80));
    },
  } as any;
  const summary = await readMyDistributionSummary(client, { userId: "u1", sessionId: "s1" });
  assert.equal(summary.native.settled.cents, "100");
  assert.equal(summary.native.pending.cents, "50");
  assert.equal(summary.native.recovery.cents, "30");
  assert.equal(summary.legacy.settled.cents, "200");
  assert.equal(summary.legacy.pending.cents, "40");
  assert.equal(summary.flow.settled.cents, "100");
  assert.equal(summary.flow.monthSettled.cents, "100");
  assert.equal(summary.network.leader.count, "2");
  assert.equal(summary.trend.length, 30);
  assert.equal(summary.trend.at(-1)?.date, "2026-11-02");
  assert.equal(summary.recent[0]?.source, "NATIVE");
  assert.equal(summary.unified.mappedRecordCount,"6");assert.equal(summary.unified.knownSubtotalCents,"420");assert.equal(summary.unified.unknownStateCount,"1");assert.equal(summary.unified.knowledge,"UNKNOWN");assert.equal(summary.recentRecords.length,5);
  assert.ok(calls.filter(sql=>sql==="BEGIN"||sql==="COMMIT").length===0,"the shared reader does not open a nested transaction");
  assert.ok(calls.every(sql=>!sql.includes('FOR UPDATE')),'the whole summary is safe in its caller-owned READ ONLY transaction');
  assert.ok(calls.some(sql => sql.includes("GROUP BY state")));
});

test("stock, flow and ranking projections keep true zero, UNKNOWN history and REVOKE/RECOVER separate", async () => {
  const zero = stockMetrics([]);
  assert.deepEqual(zero.settled, { knowledge: "KNOWN", cents: "0", count: "0", reasonCodes: [] });
  assert.deepEqual(zero.recovery, { knowledge: "KNOWN", cents: "0", count: "0", reasonCodes: [] });
  const stock = stockMetrics([
    { state: "SETTLED", count: 2, cents: "150" },
    { state: "RECOVERY_REQUIRED", count: 1, cents: "30" },
  ]);
  assert.equal(stock.settled.cents, "150");
  assert.equal(stock.pending.cents, "0");
  assert.equal(stock.recovery.cents, "30");
  assert.equal(stock.revoked.cents, "0");

  const flow = bucketFlow([
    { kind: "EARNING_PENDING", action: "ACCRUE", count: 1, cents: "100" },
    { kind: "EARNING_SETTLED", action: "SETTLE", count: 1, cents: "100" },
    { kind: "EARNING_REVOKED", action: "REVOKE", count: 1, cents: "40" },
    { kind: "EARNING_REVOKED", action: "RECOVER", count: 1, cents: "30" },
  ]);
  assert.equal(flow.settled.cents, "100");
  assert.equal(flow.accrued.cents, "100");
  assert.equal(flow.reversed.cents, "40");
  assert.equal(flow.recovered.cents, "30");
  assert.notEqual(flow.reversed.cents, flow.recovered.cents);

  const ranking = rankingRows([
    { user_id: "first", cents: "100" },
    { user_id: "tie", cents: "100" },
    { user_id: "third", cents: "50" },
    { user_id: "zero", cents: "0" },
    { user_id: "negative", cents: "-10" },
  ]);
  assert.deepEqual(ranking.map(item => [item.userId, item.rank]), [["first", 1], ["tie", 1], ["third", 3]]);
  const inviteRanking = rankingRows([
    { user_id: "leader", count: 2 },
    { user_id: "tied", count: 2 },
    { user_id: "one", count: 1 },
    { user_id: "none", count: 0 },
  ], "count");
  assert.deepEqual(inviteRanking.map(item => [item.userId, item.rank, item.count]), [["leader", 1, "2"], ["tied", 1, "2"], ["one", 3, "1"]]);

  const historical = mapEarningRow({
    id: "legacy:1", source: "LEGACY", beneficiary_id: "u1", beneficiary_name: "旧用户", role: "RENTER_REFERRAL",
    order_id: "old-order", order_number: "LO-1", amount_cents: "1234", recovery_cents: null, state: "SETTLED",
    occurred_at: "2024-01-02T00:00:00Z", settled_at: null, due_at: null, recorded_at: "2026-10-01T00:00:00Z", game_id: "game-1",
  }, false);
  assert.equal(historical.source, "LEGACY");
  assert.equal(historical.settledAt, null);
  assert.equal(historical.beneficiaryName, null);
  assert.equal(historical.amountCents, "1234");

  const unknown = await legacyStock(null as any, { ...filtersForTest(), rankingLimit: 10 }, {} as any, false) as any;
  for (const key of ["settled", "pending", "expired", "orders"]) {
    assert.equal(unknown[key].knowledge, "UNKNOWN");
    assert.equal(unknown[key].cents, null);
    assert.ok(unknown[key].reasonCodes.includes("LEGACY_SOURCE_NOT_INSTALLED"));
  }
  assert.equal(unknown.coverage, "UNKNOWN");
});

test("native stock keeps role rows in earnings but counts each order once", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("GROUP BY e.state")) return { rows: [{ state: "SETTLED", count: 2, cents: "190" }], rowCount: 1 };
      if (sql.includes("count(DISTINCT e.order_id)")) return { rows: [{ count: "1" }], rowCount: 1 };
      throw new Error("unexpected native stock SQL: " + sql.slice(0, 80));
    },
  } as any;
  const context = {
    actor: { userId: "admin", sessionId: "session" }, access: { isBoss: true },
    scope: { isBoss: true, games: "ALL_GAMES", gameIds: [], network: "AVAILABLE", reasonCodes: [] },
    directoryRead: true, authorizationKey: "access",
  } as any;
  const result = await nativeStock(client, filtersForTest(), context);
  assert.equal(result.settled.count, "2");
  assert.equal(result.settled.cents, "190");
  assert.equal(result.orders.count, "1");
  assert.ok(calls.some(sql => sql.includes("count(DISTINCT e.order_id)")));
  assert.ok(calls.every(sql => sql.includes("zzsh_order.rental_referral_earning")), "native stock never reads historical observations");
});

function filtersForTest(): DashboardFilters {
  return { from: "2026-10-01", to: "2026-10-31", source: "ALL", state: "ALL", role: "ALL", q: "", page: 1, pageSize: 20, rankingBasis: "CURRENT_SETTLED_STOCK", rankingLimit: 10, sort: "recordCount", order: "desc" };
}

test('participants include historical commissions and leave incomplete child totals unknown',async()=>{
 const client={query:async(sql:string)=>{
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
  if(sql.includes('participant_amounts')&&sql.includes('ORDER BY'))return{rows:[{user_id:'old_user',eligibility:'UNKNOWN',source_type:'LEGACY_MYSQL',invitees_knowledge:'UNKNOWN',leader_children:0,inviter_children:0,record_count:'3',settled_cents:'9007199254740993',pending_cents:'25',recovery_cents:'0',review_cents:'100',review_count:'1',total:1}]};
  return{rows:[]};
 }} as any;
 const result=await readAdminDistributionParticipants(client,dashboardContext(),filtersForTest()),p=result.items[0]!;
 assert.equal(p.settledCents,'9007199254740993');assert.equal(p.pendingCents,'25');assert.equal(p.needsReviewCents,'100');assert.equal(p.needsReviewCount,'1');assert.equal(p.mappedRecordCount,'3');assert.equal(p.recordCount,null);
 assert.equal(p.inviterChildren,null);assert.equal(p.leaderChildren,null);assert.equal(p.eligibility,'UNKNOWN');assert.deepEqual(p.earningsReasonCodes,['HISTORICAL_COVERAGE_NOT_CLOSED']);
});

test('participant list preserves true, false and unknown freeze states',async()=>{
 const frozen=[true,false,null];
 const client={query:async(sql:string)=>{
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:false,duties:false,coverage:false,native_origin:false}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
  if(sql.includes('participant_amounts')&&sql.includes('ORDER BY'))return{rows:frozen.map((value,index)=>({user_id:'person_'+index,eligibility:'ELIGIBLE',commission_frozen:value,source_type:'LEGACY_MYSQL',invitees_knowledge:'UNKNOWN',leader_children:0,inviter_children:0,record_count:'0',settled_cents:'0',pending_cents:'0',recovery_cents:'0',review_cents:'0',review_count:'0',total:3}))};
  return{rows:[]};
 }} as any;
 const result=await readAdminDistributionParticipants(client,dashboardContext(),filtersForTest(),undefined,undefined,undefined,true);
 assert.deepEqual(result.items.map(item=>item.frozen),frozen);
});

test('each downline view preserves true, false and unknown freeze states',async()=>{
 const frozen=[true,false,null];
 const client={query:async(sql:string)=>{
  if(sql.includes('SELECT invitees_knowledge'))return{rows:[{invitees_knowledge:'UNKNOWN',source_type:'LEGACY_MYSQL'}]};
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:false,duties:false,coverage:false,native_origin:false}]};
  if(sql.includes('contributor_page AS')||sql.includes('SELECT r.child_user_id,u.name'))return{rows:frozen.map((value,index)=>({child_user_id:'person_'+index,eligibility:'ELIGIBLE',commission_frozen:value,source_type:'LEGACY_MYSQL',invitees_knowledge:'UNKNOWN',children:0,total:3,uncertain:false}))};
  if(sql.includes('count(DISTINCT child_user_id)'))return{rows:[{count:3}]};
  return{rows:[]};
 }} as any;
 for(const type of ['INVITER','COMMISSION_CONTRIBUTOR','DISTRIBUTION_LEADER']){
  const result=await readAdminDistributionDownline(client,dashboardContext(),'parent',new URLSearchParams({type}));
  assert.deepEqual(result.items.map(item=>item.participant?.frozen),frozen,type);
 }
});

test('display projection omits legacy qualification bytes explicitly and retains duty proof in the pagination version',async()=>{
 const calls:string[]=[];const client={query:async(sql:string)=>{calls.push(sql);
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true,coverage:false,native_origin:false}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n',legacy:'l',participants:'p',relations:'r',effects:'e'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
  if(sql.includes('participant_amounts AS')&&sql.includes('ORDER BY'))return{rows:[{user_id:'old_user',name:'Old',eligibility:'ELIGIBLE',source_type:'LEGACY_MYSQL',level_code:'legacy_1',level_name:'默认',invitees_knowledge:'UNKNOWN',leader_children:0,inviter_children:0,record_count:'3',settled_cents:'2',pending_cents:'1',recovery_cents:'0',review_cents:'0',review_count:'0',total:1}]};
  if(sql.includes('contributor_records AS'))return{rows:[{user_id:'old_user',count:0,uncertain:true}]};
  return{rows:[]};
 }} as any;
 const read=await readAdminDistributionParticipants(client,dashboardContext(),filtersForTest(),undefined,undefined,undefined,true);
 assert.equal(read.items[0]!.legacyQualification,null);assert.equal(read.items[0]!.legacyQualificationKnowledge,'NOT_LOADED');
 assert.equal(calls.some(sql=>sql.includes('original distribution qualifications')),false);
 const version=calls.find(sql=>sql.includes('WITH visible_earnings AS'))!;
 assert.match(version,/legacy_order_duty_admission/);assert.match(version,/legacy_order_duty_revision/);assert.match(version,/legacy_continuation_version/);
 assert.doesNotMatch(version,/FROM zzsh_order\.personal_finance_observation l\s+WHERE l\.source_kind='HISTORICAL_EARNINGS_LOG'/);
});

test('contributor totals require closed invitations, covered commissions and resolved earning facts',async()=>{
 let relationKnown=false,historyKnown=false,uncertain=false;
 const client={query:async(sql:string)=>{
  if(sql.includes('finance history coverage installed'))return{rows:[{installed:true}]};
  if(sql.includes('finance history coverage exact targets'))return{rows:historyKnown?[{user_id:'old_user',id:'coverage_one',source_count:0,imported_count:0,isolated_count:0,imported_set_digest:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',actual_digest:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',actual_count:'0',invalid_count:'0',outside_count:'0',cutoff:'2026-11-03T00:00:00.000Z'}]:[]};
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true,coverage:true}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
  if(sql.includes('contributor_records AS MATERIALIZED'))return{rows:[{user_id:'old_user',count:2,uncertain}]};
  if(sql.includes('participant_amounts')&&sql.includes('ORDER BY'))return{rows:[{user_id:'old_user',source_type:'LEGACY_MYSQL',invitees_knowledge:relationKnown?'KNOWN':'UNKNOWN',leader_children:8,inviter_children:4,record_count:'3',settled_cents:'12',pending_cents:'0',recovery_cents:'0',review_cents:'0',review_count:'0',total:1}]};
  return{rows:[]};
 }} as any;
 const read=async()=>(await readAdminDistributionParticipants(client,dashboardContext(),filtersForTest())).items[0]!;
 let item=await read();assert.equal(item.inviterChildren,null);assert.equal(item.contributorChildren,null);assert.equal(item.mappedContributorChildren,2);
 relationKnown=true;item=await read();assert.equal(item.inviterChildren,4);assert.equal(item.contributorChildren,null);
 historyKnown=true;item=await read();assert.equal(item.contributorChildren,2);assert.equal(item.mappedContributorChildren,2);
 uncertain=true;item=await read();assert.equal(item.contributorChildren,null);assert.equal(item.mappedContributorChildren,2);
});

test('contributor downline is source scoped, paginated and preserves partial coverage',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.includes('SELECT invitees_knowledge'))return{rows:[{invitees_knowledge:'UNKNOWN',source_type:'LEGACY_MYSQL'}]};
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true,coverage:false}]};
  if(sql.includes('contributor_page AS'))return{rows:[{child_user_id:'invitee',source_type:'LEGACY_MYSQL',bound_at:'2026-11-01T00:00:00Z',invitees_knowledge:'UNKNOWN',children:3,total:4,uncertain:true}]};
  if(sql.includes('count(DISTINCT child_user_id)'))return{rows:[{count:10}]};
  return{rows:[]};
 }} as any;
 const result=await readAdminDistributionDownline(client,dashboardContext(),'parent',new URLSearchParams('type=COMMISSION_CONTRIBUTOR&page=2&pageSize=2'));
 assert.equal(result.knowledge,'PARTIAL');assert.equal(result.total,'4');assert.equal(result.items[0]?.userId,'invitee');assert.equal(result.items[0]?.boundAt,null);
 const page=calls.find(call=>call.sql.includes('contributor_page AS'))!;assert.deepEqual(page.values.slice(-3),[['parent'],2,2]);
 assert.match(page.sql,/r\.type='INVITER'/);assert.match(page.sql,/count\(\*\)::int FROM contributor_users/);
 await assert.rejects(()=>readAdminDistributionDownline(client,dashboardContext(false,false),'parent',new URLSearchParams('type=COMMISSION_CONTRIBUTOR')),(error:any)=>error.status===403);
});

test('participant zero amounts require the existing exact history coverage proof',async()=>{
 let covered=false;const client={query:async(sql:string)=>{
  if(sql.includes('finance history coverage installed'))return{rows:[{installed:true}]};
  if(sql.includes('finance history coverage exact target'))return{rows:[{user_id:'old_user',id:'coverage_one',source_count:0,imported_count:0,isolated_count:0,imported_set_digest:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',actual_digest:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',actual_count:'0',invalid_count:'0',outside_count:'0',cutoff:'2026-11-03T00:00:00.000Z'}]};
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,coverage:covered}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
  if(sql.includes('participant_amounts')&&sql.includes('ORDER BY'))return{rows:[{user_id:'old_user',eligibility:'UNKNOWN',source_type:'LEGACY_MYSQL',invitees_knowledge:'KNOWN',leader_children:0,inviter_children:0,record_count:'0',settled_cents:'0',pending_cents:'0',recovery_cents:'0',review_cents:'0',review_count:'0',total:1}]};
  return{rows:[]};
 }} as any;
 const read=()=>readAdminDistributionParticipants(client,dashboardContext(),filtersForTest());
 assert.equal((await read()).items[0]!.settledCents,null);covered=true;const p=(await read()).items[0]!;
 assert.equal(p.settledCents,'0');assert.equal(p.pendingCents,'0');assert.equal(p.recordCount,'0');assert.equal(p.earningsCoverage,'KNOWN');assert.equal(p.inviterChildren,0);
});

test("empty tail pages preserve the same filtered total and snapshot while a genuine empty set remains zero",async()=>{
 for(const kind of ['earnings','participants'] as const){for(const expected of ['7','0']){
  const calls:{sql:string;values:unknown[]}[]=[],client={query:async(sql:string,values:unknown[]=[])=>{
   calls.push({sql,values});if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true}]};if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n',events:'e',legacy:'l',participants:'p',relations:'r'}]};if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-02T00:00:00.000000Z'}]};
   if(sql.includes('count(*)::text AS total'))return{rows:[{total:expected}]};return{rows:[]};
  }} as any,context=dashboardContext(false),f={...filtersForTest(),page:expected==='0'?1:8,pageSize:2,q:'user-1'},key={keyId:'test',secret:'x'.repeat(40)};
  const read=kind==='earnings'?readAdminDistributionEarnings:readAdminDistributionParticipants,r=await read(client,context,f,key);
  assert.equal(r.total,expected);assert.equal(r.items.length,0);assert.equal(r.hasMore,false);assert.ok(r.snapshot);
  const page=calls.find(c=>c.sql.includes(' OVER()'))!,count=calls.find(c=>c.sql.includes('count(*)::text AS total'))!;
  if(kind==='earnings')assert.deepEqual(count.values,page.values.slice(0,-2),'same bindings without LIMIT/OFFSET');
  else{assert.deepEqual(count.values,['%user-1%'],'participant empty-page count skips amount-scope bindings');assert.match(page.sql,/participant_amounts/);assert.match(page.sql,/ORDER BY COALESCE\(a\.record_count,0\) DESC/);}
  assert.match(count.sql,/%|LIKE/);assert.ok(count.values.includes('%user-1%'));
 }}
});

test('participants sort by settled/pending and keep user_id tiebreak',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-02T00:00:00Z'}]};
  if(sql.includes('participant_amounts')&&sql.includes('ORDER BY'))return{rows:[{user_id:'u1',eligibility:'ELIGIBLE',commission_frozen:false,source_type:'NATIVE',invitees_knowledge:'KNOWN',leader_children:0,inviter_children:0,record_count:'1',settled_cents:'10',pending_cents:'2',recovery_cents:'0',review_cents:'0',review_count:'0',total:1}]};
  return{rows:[]};
 }} as any;
 await readAdminDistributionParticipants(client,dashboardContext(),{...filtersForTest(),sort:'settledCents',order:'asc'});
 const settled=calls.find(c=>c.sql.includes('ORDER BY COALESCE(a.settled_cents,0) ASC'))!;
 assert.match(settled.sql,/p\.user_id COLLATE "C" ASC/);
 assert.match(settled.sql,/LEFT JOIN LATERAL\s*\([\s\S]*FROM zzsh_order\.invitation_relation WHERE parent_user_id=p\.user_id/);
 assert.ok(settled.sql.indexOf('participant_page AS') < settled.sql.indexOf('SELECT p.user_id,u.name'));
  assert.doesNotMatch(settled.sql,/legacy_log_candidates/,'participant totals do not need individual settlement times');
 calls.length=0;
 await readAdminDistributionParticipants(client,dashboardContext(),{...filtersForTest(),sort:'pendingCents',order:'desc'});
 assert.ok(calls.some(c=>c.sql.includes('ORDER BY COALESCE(a.pending_cents,0) DESC')));
 assert.equal(parseDashboardFilters(new URLSearchParams('')).sort,'recordCount');
 assert.equal(parseDashboardFilters(new URLSearchParams('')).order,'desc');
 assert.throws(()=>parseDashboardFilters(new URLSearchParams('sort=bogus')),(e:any)=>e.status===400);
});

test("participant earnings bind the exact beneficiary without altering other filters", async () => {
 const calls: {sql:string;values:unknown[]}[]=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.includes("to_regclass"))return{rows:[{native:true,legacy:true}]};
  if(sql.includes("WITH visible_earnings AS"))return{rows:[{native:"n"}]};
  if(sql.includes("clock_timestamp"))return{rows:[{at:"2026-11-02T00:00:00Z"}]};
  if(sql.includes("count(*)::text AS total"))return{rows:[{total:"0"}]};
  return{rows:[]};
 }} as any;
 const filters=parseDashboardFilters(new URLSearchParams("beneficiary=user-42&state=SETTLED&q=order"));
 await readAdminDistributionEarnings(client,dashboardContext(),filters);
 const page=calls.find(call=>call.sql.includes("WITH rows AS")&&call.sql.includes("LIMIT"))!;
 const match=/beneficiary_id=\$(\d+)::text/.exec(page.sql);
 assert.ok(match,"beneficiary must use a PostgreSQL parameter");
 assert.equal(page.values[Number(match[1])-1],"user-42");
 assert.ok(page.values.includes("SETTLED"));
 assert.ok(page.values.includes("%order%"));
});

test('native-only earnings exclude irrelevant historical sources from both page and snapshot',async()=>{
 const calls:string[]=[];const client={query:async(sql:string)=>{calls.push(sql);
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-02T00:00:00Z'}]};
  if(sql.includes('count(*)::text AS total'))return{rows:[{total:'0'}]};return{rows:[]};
 }} as any;
 const result=await readAdminDistributionEarnings(client,dashboardContext(),{...filtersForTest(),source:'NATIVE'});
 assert.equal(result.total,'0');assert.deepEqual(result.items,[]);
 const version=calls.find(sql=>sql.includes('WITH visible_earnings AS'))!,page=calls.find(sql=>sql.includes('WITH rows AS'))!;
 for(const sql of [version,page])assert.doesNotMatch(sql,/FROM zzsh_order\.personal_finance_observation/);
 assert.match(page,/FROM zzsh_order\.rental_referral_earning/);
});

test('earnings page resolves settlement times once for the selected source-qualified records',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[],page=[
  {id:'native_1',source:'NATIVE',beneficiary_id:'person',amount_cents:'125',state:'SETTLED',total:2},
  {id:'history:legacy_1',source:'LEGACY',beneficiary_id:'person',amount_cents:'350',state:'SETTLED',total:2},
 ];
 const client={query:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n',events:'e',legacy:'l'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
  if(sql.startsWith('WITH rows AS'))return{rows:page.map(item=>({...item}))};
  if(sql.includes('SELECT id,source,settled_at FROM dashboard_records'))return{rows:[{id:'history:legacy_1',source:'LEGACY',settled_at:'2026-10-02T01:00:00Z'}, {id:'native_1',source:'NATIVE',settled_at:'2026-10-03T01:00:00Z'}]};
  throw Error('Unexpected query');
 }} as any;
 const result=await readAdminDistributionEarnings(client,dashboardContext(false),{...filtersForTest(),beneficiary:'person'});
 assert.equal(result.total,'2');assert.deepEqual(result.items.map(item=>item.settledAt),['2026-10-03T01:00:00Z','2026-10-02T01:00:00Z']);
 const first=calls.find(call=>call.sql.startsWith('WITH rows AS'))!,times=calls.find(call=>call.sql.includes('SELECT id,source,settled_at FROM dashboard_records'))!;
 assert.doesNotMatch(first.sql,/legacy_log_candidates/);assert.match(times.sql,/p\.id=ANY\(\$\d+::text\[\]\)/);assert.match(times.sql,/e\.id=ANY\(\$\d+::text\[\]\)/);
 assert.match(times.sql,/p\.source_system=l\.source_system AND p\.user_id=l\.user_id AND p\.source_id=l\.snapshot->>'referenceId'/);
 assert.deepEqual(times.values.slice(-2),[['native_1'],['legacy_1']]);assert.ok(times.values.includes('person'));
 assert.equal(calls.filter(call=>call.sql.includes('SELECT id,source,settled_at FROM dashboard_records')).length,1);
});

test('missing or duplicate page settlement-time results fail closed',async()=>{
 for(const returned of [[],[{id:'native_1',source:'NATIVE',settled_at:null},{id:'native_1',source:'NATIVE',settled_at:null}]]){
  const client={query:async(sql:string)=>{
   if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:false,duties:false}]};
   if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
   if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
   if(sql.startsWith('WITH rows AS'))return{rows:[{id:'native_1',source:'NATIVE',beneficiary_id:'person',amount_cents:'125',state:'SETTLED',total:1}]};
   if(sql.includes('SELECT id,source,settled_at FROM dashboard_records'))return{rows:returned};
   throw Error('Unexpected query');
  }} as any;
  await assert.rejects(readAdminDistributionEarnings(client,dashboardContext(),{...filtersForTest(),source:'NATIVE'}),error=>(error as {status?:number}).status===503);
 }
});

test('nonempty native-only page keeps its source and excludes every legacy lookup',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[],client={query:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true}]};
  if(sql.includes('WITH visible_earnings AS'))return{rows:[{native:'n'}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-03T00:00:00Z'}]};
  if(sql.startsWith('WITH rows AS'))return{rows:[{id:'native_1',source:'NATIVE',beneficiary_id:'person',beneficiary_name:'private',amount_cents:'125',state:'SETTLED',total:1}]};
  if(sql.includes('SELECT id,source,settled_at FROM dashboard_records'))return{rows:[{id:'native_1',source:'NATIVE',settled_at:'2026-10-03T01:00:00Z'}]};
  throw Error('Unexpected query');
 }} as any;
 const result=await readAdminDistributionEarnings(client,dashboardContext(false),{...filtersForTest(),source:'NATIVE'});
 assert.equal(result.items[0]!.settledAt,'2026-10-03T01:00:00Z');assert.equal(result.items[0]!.beneficiaryName,null);
 const times=calls.find(call=>call.sql.includes('SELECT id,source,settled_at FROM dashboard_records'))!;
 assert.doesNotMatch(times.sql,/personal_finance_observation|legacy_log_candidates/);assert.deepEqual(times.values.at(-1),['native_1']);
});


test("downline combines migrated and new relations, without inventing old dates or complete counts",async()=>{
 const calls:string[]=[];
 const client={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.includes('SELECT invitees_knowledge'))return{rows:[{invitees_knowledge:'KNOWN'}]};
  if(sql.includes('FROM zzsh_order.invitation_relation r'))return{rows:[
   {child_user_id:'old-child',source_type:'LEGACY_MYSQL',bound_at:'2026-11-05T00:00:00Z',invitees_knowledge:'UNKNOWN',children:2,total:2},
   {child_user_id:'new-child',source_type:'NATIVE_REGISTRATION',bound_at:'2026-11-06T00:00:00Z',invitees_knowledge:'KNOWN',children:3,total:2}
  ]};
  return{rows:[]};
 }} as any;
 const result=await readAdminDistributionDownline(client,dashboardContext(),'parent',new URLSearchParams('type=INVITER'));
 assert.equal(result.total,'2');
 assert.deepEqual(result.items.map((row:any)=>row.sourceType),['LEGACY_MYSQL','NATIVE_REGISTRATION']);
 assert.equal(result.items[0]?.boundAt,null,'legacy import time is not its original invitation time');
 assert.equal(result.items[0]?.children,null);assert.equal(result.items[0]?.mappedChildren,2);
 assert.equal(result.items[1]?.children,3);assert.equal(result.items[1]?.boundAt,'2026-11-06T00:00:00.000Z');
 const sql=calls.find(value=>value.includes('FROM zzsh_order.invitation_relation r'))!;
 assert.doesNotMatch(sql,/r\.source_type\s*=/,'source does not restrict the combined count');
 await assert.rejects(()=>readAdminDistributionDownline(client,dashboardContext(false,false),'parent',new URLSearchParams()),(error:any)=>error.status===403);
});


test("one participant detail narrows source proof and does not hash the unrelated full network",async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.includes('to_regclass'))return{rows:[{native:true,legacy:true,duties:true}]};
  if(sql.includes('clock_timestamp'))return{rows:[{at:'2026-11-06T00:00:00Z'}]};
  if(sql.includes('participant_amounts'))return{rows:[{user_id:'user-42',total:1,record_count:'0',settled_cents:'0',pending_cents:'0',recovery_cents:'0',review_cents:'0',review_count:'0'}]};
  return{rows:[]};
 }} as any;
 await readAdminDistributionParticipants(client,dashboardContext(),filtersForTest(),undefined,null,'user-42');
 assert.equal(calls.some(call=>call.sql.includes('WITH visible_earnings AS')),false);
 const page=calls.find(call=>call.sql.includes('participant_amounts'))!;
 assert.match(page.sql,/p\.user_id=\$3::text/);
 assert.doesNotMatch(page.sql,/legacy_log_candidates/,'detail totals do not read settlement-time logs');
 assert.match(page.sql,/e\.beneficiary_user_id=\$3::text/);
 assert.equal(page.values[2],'user-42');
});

test("participant earnings pagination versions every relevant source for the same subject",async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const c={query:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});return{rows:[{native:'n',events:'e',legacy:'l',participants:'p',relations:'r',effects:'x',coverage:'c'}]};}} as any;
 await dashboardVersion(c,dashboardContext(),true,true,true,'user-42',true);
 const query=calls[0]!;
 assert.deepEqual(query.values,['admin-1',true,'user-42']);
 for(const column of ['e.beneficiary_user_id','p.user_id','l.user_id','c.user_id'])assert.ok(query.sql.includes(column+'=$3::text'),column);
 assert.ok(query.sql.includes('r.parent_user_id=$3::text OR r.child_user_id=$3::text'));
  assert.match(query.sql,/visible_native_birth/);assert.match(query.sql,/native_user_insert_proof/);assert.match(query.sql,/o\.renter_user_id,o\.owner_user_id/);
});
