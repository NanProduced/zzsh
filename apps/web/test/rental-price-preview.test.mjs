import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV = 'test';
process.env.ZZSH_API_ORIGIN = 'http://127.0.0.1:3102';
process.env.ZZSH_WEB_ORIGIN = 'http://127.0.0.1:3100';
const { orderApi, OrderRequestError } = await import('../src/lib/order-client.ts');
const { forwardOrderRequest } = await import('../src/lib/order-proxy.ts');
const { GET } = await import('../src/app/api/rental-price-preview/route.ts');
const { toListingCard, toListingDetail } = await import('../src/lib/listing-view.ts');
const refs = { accountId: 'account-price', versionId: 'version-price', releaseId: 'release-price' };
const query = new URLSearchParams(refs).toString();
const url = 'http://127.0.0.1:3100/api/rental-price-preview';
const money = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
const quote = { schemaVersion: 2, currency: 'CNY', ruleReleaseId: refs.releaseId, lines: [], resourceTotal: money('1.00'), tenantDeposit: money('0.00'), tenantPayableTotal: money('1.00'), termSeconds: '86400', expiryDisclosures: [], unitAmountsInformational: true, baseRenterHaffRatioWanPerYuan: '44.12345678' };
const preview = { schema: 'rental-price-preview.v1', binding: { ...refs, listingHash: 'a'.repeat(64) }, asOfUtc: '2026-10-25T00:10:00.123456Z', refreshAfterUtc: '2026-10-25T00:10:30.123456Z', quote, baseTenantDeposit: money('100.00'), membershipBenefits: { schema: 'membership-benefits-v1', effectiveTier: 'GOLD', policyTier: 'GOLD', priceSource: 'GROWTH', depositSource: 'GROWTH', policyVersion: '1' } };
function request(search = query, headers = {}) { return new Request(url + '?' + search, { headers }); }

test('preview client sends exactly three references using the existing same-origin no-store read and Abort signal', async () => {
  const before = globalThis.fetch, seen = [], controller = new AbortController();
  globalThis.fetch = async (input, init) => { seen.push({ input: String(input), init }); return Response.json(preview); };
  try {
    const result = await orderApi.previewRentalPrice({ ...refs, userId: 'client-must-not-choose-actor', tier: 'VIP', fullPayoutTermsAcceptance: 'not-read-input' }, controller.signal);
    assert.deepEqual(result, preview); assert.equal(seen.length, 1); assert.equal(seen[0].input, '/api/rental-price-preview?' + query);
    assert.equal(seen[0].init.method, undefined); assert.equal(seen[0].init.credentials, 'same-origin'); assert.equal(seen[0].init.cache, 'no-store'); assert.equal(seen[0].init.signal, controller.signal);
    assert.equal(seen[0].init.body, undefined); assert(!('confirmationToken' in result)); assert(!('depositWaived' in result)); assert.equal(result.quote.tenantDeposit.amount, '0.00');
  } finally { globalThis.fetch = before; }
});

test('preview client keeps read errors and cancellation without trying confirmation or creation', async () => {
  const before = globalThis.fetch, calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ input: String(input), init }); return Response.json({ error: { code: 'MEMBERSHIP_UNKNOWN', message: '暂不可用' } }, { status: 503 }); };
  try {
    await assert.rejects(() => orderApi.previewRentalPrice(refs), error => error instanceof OrderRequestError && error.status === 503 && error.code === 'MEMBERSHIP_UNKNOWN');
    assert.equal(calls.length, 1); assert.match(calls[0].input, /^\/api\/rental-price-preview\?/); assert.equal(calls[0].init.body, undefined);
    const controller = new AbortController(), aborted = new DOMException('Aborted', 'AbortError'); controller.abort(); globalThis.fetch = async () => { throw aborted; };
    await assert.rejects(() => orderApi.previewRentalPrice(refs, controller.signal), error => error === aborted);
  } finally { globalThis.fetch = before; }
});

test('preview BFF forwards only user session, the exact root GET and references with no-store', async () => {
  const before = globalThis.fetch; let seen;
  globalThis.fetch = async (input, init) => { seen = { input: String(input), init }; return Response.json(preview, { headers: { 'cache-control': 'public,max-age=86400', 'set-cookie': 'zzsh_admin.session_token=forbidden; Path=/' } }); };
  try {
    const response = await GET(request(query, { cookie: 'zzsh_user.session_token=synthetic-user; zzsh_admin.session_token=synthetic-admin; unrelated=ignored', 'x-client-user-id': 'cannot-select', 'idempotency-key': 'not-forwarded' }));
    assert.equal(response.status, 200); assert.equal(seen.input, 'http://127.0.0.1:3102/api/bff/user/rental-price-preview?' + query); assert.equal(seen.init.method, 'GET'); assert.equal(seen.init.cache, 'no-store'); assert.equal(seen.init.redirect, 'error'); assert.equal(seen.init.body, undefined);
    assert.equal(seen.init.headers.get('cookie'), 'zzsh_user.session_token=synthetic-user'); assert.equal(seen.init.headers.get('origin'), 'http://127.0.0.1:3100'); assert.equal(seen.init.headers.get('authorization'), null); assert.equal(seen.init.headers.get('idempotency-key'), null); assert.equal(seen.init.headers.get('x-client-user-id'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null); assert.deepEqual(await response.json(), preview);
  } finally { globalThis.fetch = before; }
});

test('preview BFF rejects extra/duplicate/missing references, wrong root/method, body and foreign actor headers before forwarding', async () => {
  const before = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; return Response.json(preview); };
  try {
    for (const search of [query + '&accountId=other', query + '&userId=other', query + '&tier=VIP', query + '&amount=0', query + '&purpose=READ', query + '&fullPayoutTermsAcceptance=yes', 'accountId=a&versionId=v', 'accountId=&versionId=v&releaseId=r']) assert.equal((await GET(request(search))).status, 400);
    for (const headers of [{ authorization: 'Bearer synthetic' }, { origin: 'http://foreign.invalid' }]) assert.equal((await GET(request(query, headers))).status, 403);
    assert.equal((await GET(request(query, { 'content-length': '2' }))).status, 400);
    assert.equal((await GET(new Request(url + '/nested?' + query))).status, 404);
    assert.equal((await GET(new Request(url + '?' + query, { method: 'POST', body: '{}' }))).status, 404);
    assert.equal((await forwardOrderRequest(request(), { params: Promise.resolve({ path: ['nested'] }) }, 'rental-price-preview')).status, 404);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = before; }
});

test('preview BFF preserves upstream refusal states and maps failed/unparseable reads without POST fallback', async () => {
  const before = globalThis.fetch, seen = [];
  try {
    for (const status of [401, 403, 404, 409, 503]) { globalThis.fetch = async (input, init) => { seen.push({ input: String(input), init }); return Response.json({ error: { code: 'SYNTHETIC_' + status, message: 'Unavailable' } }, { status }); }; const r = await GET(request()); assert.equal(r.status, status); assert.equal((await r.json()).error.code, 'SYNTHETIC_' + status); assert.equal(r.headers.get('cache-control'), 'no-store'); }
    globalThis.fetch = async () => { throw Error('synthetic upstream unavailable'); }; assert.equal((await GET(request())).status, 503);
    globalThis.fetch = async () => new Response('not JSON'); assert.equal((await GET(request())).status, 502);
    assert(seen.every(v => v.init.method === 'GET' && v.input.startsWith('http://127.0.0.1:3102/api/bff/user/rental-price-preview?')));
  } finally { globalThis.fetch = before; }
});

function listing(value = quote) { return { ...refs, id: refs.accountId, source: 'NATIVE', title: '', description: null, attributes: {}, media: [], presentation: { items: [], skins: [], entitlements: [] }, game: { id: 'game', code: 'delta', name: 'Synthetic' }, quote: value, availability: { state: 'RENTABLE' }, canCreateOrder: true }; }
test('public card/detail map the frozen base ratio exactly and absence stays null without changing eligibility', () => {
  for (const value of ['44.12345678', null, undefined]) { const source = listing({ ...quote, baseRenterHaffRatioWanPerYuan: value }), card = toListingCard(source), detail = toListingDetail(source); assert.equal(card.baseRenterHaffRatioWanPerYuan, value ?? null); assert.equal(detail.baseRenterHaffRatioWanPerYuan, value ?? null); assert.equal(card.canCreateOrder, true); assert.equal(card.resourceTotalLabel, '¥1.00'); }
  const history = { ...listing(null), source: 'LEGACY_READ_ONLY', canCreateOrder: false, availability: { state: 'LEGACY_READ_ONLY' }, inventory: [], historicalQuote: { haffRent: money('1.00'), goods: money('0.00'), deposit: money('100.00'), termDays: '1' } };
  assert.equal(toListingCard(history).baseRenterHaffRatioWanPerYuan, null);
});
