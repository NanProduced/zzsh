import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.ZZSH_API_ORIGIN="http://127.0.0.1:3102";
process.env.ZZSH_WEB_ORIGIN="http://127.0.0.1:3100";
const { GET, POST } = await import("../src/app/api/account/rental-membership/route.ts");
const walletRoute=await import("../src/app/api/account/wallet/[[...path]]/route.ts");

function request(init = {}) {
  return new Request("http://127.0.0.1:3100/api/account/rental-membership", init);
}

test("membership route reads the existing self endpoint and keeps only tier and version", async () => {
  const previous = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return Response.json({ membership: { tier: "VIP", version: "4", sourceRef: "admin-secret", source: "hidden" } });
  };
  try {
    const response = await GET(request({ headers: { cookie: "zzsh_user.session_token=user; zzsh_admin.session_token=admin; other=x", "x-request-id": "req_member_1" } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { membership: { tier: "VIP", version: "4" } });
    assert.equal(seen.url, "http://127.0.0.1:3102/api/v1/users/me/rental-membership");
    assert.equal(seen.options.method, "GET");
    assert.equal(seen.options.headers.get("cookie"), "zzsh_user.session_token=user");
    assert.equal(seen.options.headers.get("x-request-id"), "req_member_1");
  } finally {
    globalThis.fetch = previous;
  }
});

test("wallet BFF preserves exact knowledge, strips raw evidence and rejects client subject overrides",async()=>{
 const previous=globalThis.fetch;let calls=0;
 const unknown={currency:'CNY',unit:'cent',knowledge:'UNKNOWN',amountCents:null};
 const known={currency:'CNY',unit:'cent',knowledge:'KNOWN',amountCents:'9999999999999999'};
 globalThis.fetch=async()=>{calls++;return Response.json({wallet:{contractVersion:'personal-finance.read.v1',subjectId:'self',coverage:{knowledge:'KNOWN',sourceDigest:'private',sourceCanonical:'private'},buckets:{available:known,reserved:unknown,restricted:unknown,pendingEarnings:unknown,refundPayable:unknown},withdrawable:{...unknown,reasonCodes:['WITHDRAWAL_POLICY_NOT_ACTIVE']},debug:'private'}});};
 const params={params:Promise.resolve({path:[]})};
 try{const r=await walletRoute.GET(new Request('http://127.0.0.1:3100/api/account/wallet'),params);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const body=await r.json();assert.deepEqual(body.wallet.buckets.available,known);assert.deepEqual(body.wallet.buckets.reserved,unknown);assert(!JSON.stringify(body).includes('private'));assert.equal((await walletRoute.GET(new Request('http://127.0.0.1:3100/api/account/wallet?userId=other'),params)).status,400);assert.equal((await walletRoute.GET(new Request('http://127.0.0.1:3100/api/account/wallet',{headers:{authorization:'Bearer other'}}),params)).status,403);assert.equal(calls,1);
 globalThis.fetch=async()=>Response.json({error:{code:'EVIDENCE_UNAVAILABLE',stack:'private'}},{status:503});assert.equal((await walletRoute.GET(new Request('http://127.0.0.1:3100/api/account/wallet'),params)).status,503);
 }finally{globalThis.fetch=previous;}
});
test('wallet BFF projects pages and details without raw evidence and rejects bad money',async()=>{
 const previous=globalThis.fetch;const e={schemaVersion:1,id:'history:h1',occurredAt:'2026-10-01T00:00:00Z',importedAt:'2026-10-03T00:00:00Z',bucket:'AVAILABLE',deltaCents:'-120',kind:'HISTORICAL',includedInOpening:true,sourceKind:'HISTORICAL_EARNINGS_LOG',sourceId:'1',source:{type:'LEGACY_MYSQL',system:'fixture',entity:'la_log_earnings',id:'1',digest:'private'},businessReference:{type:'LEGACY_UNRESOLVED',id:'1',number:'legacy-sn',raw:'private'},balanceAfterCents:'0',sourceCanonical:'private',sourceUserId:'private'};
 const context={contractVersion:'personal-finance.read.v1',subjectId:'self',asOf:'2026-10-03T00:00:00Z',snapshotVersion:'1:1:1',coverage:{knowledge:'KNOWN',origin:'RECONCILED_OPENING',sourceDigest:'private'}};
 try{globalThis.fetch=async()=>Response.json({...context,entry:e});const one=await walletRoute.GET(new Request('http://127.0.0.1:3100/api/account/wallet/entries/history%3Ah1'),{params:Promise.resolve({path:['entries','history:h1']})});assert.equal(one.status,200);const oneBody=await one.json();assert.equal(oneBody.entry.deltaCents,'-120');assert.equal(oneBody.contractVersion,context.contractVersion);assert.equal(oneBody.subjectId,'self');assert.equal(oneBody.asOf,context.asOf);assert.equal(oneBody.snapshotVersion,'1:1:1');assert.equal(oneBody.coverage.origin,'RECONCILED_OPENING');assert.equal(oneBody.entry.schemaVersion,1);assert.equal(oneBody.entry.source.entity,'la_log_earnings');assert.equal(oneBody.entry.businessReference.number,'legacy-sn');assert(!JSON.stringify(oneBody).includes('private'));
 globalThis.fetch=async()=>Response.json({contractVersion:'v1',subjectId:'self',asOf:'2026-10-03T00:00:00Z',snapshotVersion:'1:1:1',coverage:{knowledge:'KNOWN',sourceDigest:'private'},bucket:'AVAILABLE',items:[e],totals:{count:'1',byBucket:[{bucket:'AVAILABLE',count:'1',postedNetCents:'0',coveredHistoricalNetCents:'-120',uncoveredHistoricalNetCents:'0'}],historicalCoverage:'INCLUDED',meaning:'historical only',sourceCanonical:'private'},nextCursor:'opaque'});const page=await walletRoute.GET(new Request('http://127.0.0.1:3100/api/account/wallet/entries?bucket=AVAILABLE'),{params:Promise.resolve({path:['entries']})});assert.equal(page.status,200);const b=await page.json();assert.equal(b.items[0].includedInOpening,true);assert.equal(b.totals.byBucket[0].postedNetCents,'0');assert.equal(b.totals.postedNetCents,undefined);assert.equal(b.snapshotVersion,'1:1:1');assert(!JSON.stringify(b).includes('private'));
 for(const patch of [{deltaCents:1.2},{deltaCents:'-0'},{balanceAfterCents:1.2},{schemaVersion:2}]){globalThis.fetch=async()=>Response.json({...context,entry:{...e,...patch}});assert.equal((await walletRoute.GET(new Request('http://127.0.0.1:3100/api/account/wallet/entries/history%3Ah1'),{params:Promise.resolve({path:['entries','history:h1']})})).status,502);}
 }finally{globalThis.fetch=previous;}
});

test("membership route rejects writes, authorization headers and forwards upstream errors", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      error: { code: "UNAUTHENTICATED", message: "login", requestId: "req_upstream_9", sourceRef: "secret-ref", details: { stack: "secret-stack" } },
      sourceRef: "outer-ref",
      debug: "trace",
    }, { status: 401 });
  };
  try {
    assert.equal((await POST()).status, 404);
    assert.equal((await GET(request({ headers: { authorization: "Bearer forbidden" } }))).status, 403);
    assert.equal(calls, 0);
    const denied = await GET(request({ headers: { "x-request-id": "req_member_err" } }));
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("x-request-id"), "req_member_err");
    assert.deepEqual(await denied.json(), { error: { code: "UNAUTHENTICATED", message: "login", requestId: "req_upstream_9" } });
    globalThis.fetch = async () => Response.json({ error: { requestId: "not safe/id", sourceRef: "secret-ref", details: ["raw"] } }, { status: 500 });
    const bare = await GET(request({ headers: { "x-request-id": "req_member_bare" } }));
    assert.equal(bare.status, 500);
    assert.deepEqual(await bare.json(), { error: { code: "INTERNAL_ERROR", message: "会员等级暂时无法读取", requestId: "req_member_bare" } });
    globalThis.fetch = async () => { throw new Error("down"); };
    assert.equal((await GET(request())).status, 503);
  } finally {
    globalThis.fetch = previous;
  }
});

test("membership route projects the independent public policy and drops private or unsupported policy fields", async () => {
  const previous = globalThis.fetch;
  const policy = { version: "rental-benefits-20261003.v1", scope: "DELTA_ACCOUNT_RENTAL", scopeLabel: "三角洲行动账号租赁",
    tenantDeposit: { STANDARD: "ACCOUNT_BASE", VIP: "WAIVED", SVIP: "WAIVED", DISCOUNT_USER: "ACCOUNT_BASE" },
    resourcePrice: "PERSONAL_QUOTE", validity: "UNKNOWN", acquisition: "UNKNOWN", notice: "以个人确认结果为准。" };
  try {
    globalThis.fetch = async () => Response.json({ membership: { tier: "VIP", version: "99", sourceRef: "private" },
      benefitPolicy: { ...policy, ownerPrice: "private", sourceRef: "private", tenantDeposit: { ...policy.tenantDeposit, internal: "private" } } });
    assert.deepEqual(await (await GET(request())).json(), { membership: { tier: "VIP", version: "99" }, benefitPolicy: policy });
    for (const patch of [{ scope: "ALL_GAMES" }, { validity: "FOREVER" }, { tenantDeposit: { ...policy.tenantDeposit, DISCOUNT_USER: "WAIVED" } }]) {
      globalThis.fetch = async () => Response.json({ membership: { tier: "VIP", version: "99" }, benefitPolicy: { ...policy, ...patch } });
      assert.deepEqual(await (await GET(request())).json(), { membership: { tier: "VIP", version: "99" } });
    }
  } finally { globalThis.fetch = previous; }
});
