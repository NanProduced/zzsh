import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountAuthComponent, deferred } from './react-auth-harness.mjs';
const file = 'apps/web/src/components/account/identity-verification-form.tsx';
const capability = () => ({ available: true, real: true, idempotencyRequired: true,
  privacy: { versionId: 'privacy_1', digest: 'a'.repeat(64), title: '测试隐私政策', bodyPath: '/api/v1/legal-documents/privacy?version=privacy_1' },
  disclosure: { versionId: 'identity-provider-transfer-v1', digest: 'b'.repeat(64), body: '本次将姓名和身份证号码提交给阿里云二要素实名核验服务，仅用于本次身份核验。' } });
const completed = () => ({ status: 'VERIFIED', ageStatus: 'ADULT', message: '实名校验已通过。', verificationAttempt: { state: 'COMPLETED', replayed: false } });
const unknown = () => ({ status: 'UNKNOWN', ageStatus: 'UNKNOWN', message: '原核验未决。', verificationAttempt: { state: 'UNKNOWN', noReissue: true } });
const storage = 'zzsh.identity-verification.user_A';
const mount = (options = {}, props = {}) => mountAuthComponent(file, 'IdentityVerificationForm', { userId: 'user_A', identityStatus: 'UNVERIFIED', capability: capability(), canAct: () => true, onCompleted() {}, ...props }, { initialStatus: 'authenticated', ...options });
async function fill(p, agree = true) { await p.input('identity-full-name', '合成姓名'); await p.input('identity-document-number', '110101200001010000'); if (agree) await p.input('identity-verification-consent', true); }

test('marketplace disclosure is shown and submitted as its own consent version', async () => {
  const seen = [], current = capability();
  current.disclosure = { ...current.disclosure, versionId: 'identity-provider-transfer-market-v1', body: '本次将姓名和身份证号码提交至云市场实名认证服务商。' };
  const p = await mount({ fetch: async (_url, body) => { seen.push(body); return Response.json(completed()); } }, { capability: current });
  try {
    assert.match(p.host.textContent, /云市场实名认证服务商/);
    await fill(p); await p.submit();
    assert.equal(seen[0].privacyAcceptance.disclosureVersion, 'identity-provider-transfer-market-v1');
  } finally { await p.close(); }
});

test('real verification needs current published privacy and separate per-attempt consent', async () => {
  const seen = [];
  const p = await mount({ fetch: async (_url, body, init) => { seen.push({ body, init }); return Response.json(completed()); } });
  try {
    await fill(p, false); await p.submit(); assert.equal(seen.length, 0); assert.match(p.host.textContent, /单独确认本次核验/);
    const link = p.host.querySelector('a'); assert.equal(link.getAttribute('href'), '/legal/privacy?version=privacy_1');
    await p.input('identity-verification-consent', true); await p.submit();
    assert.equal(seen.length, 1); assert.match(new Headers(seen[0].init.headers).get('idempotency-key'), /^identity_/);
    assert.deepEqual(seen[0].body.privacyAcceptance, { accepted: true, versionId: 'privacy_1', digest: 'a'.repeat(64), disclosureVersion: 'identity-provider-transfer-v1' });
    assert.equal(p.window.sessionStorage.getItem(storage), null);
    assert.equal(p.host.querySelector('#identity-full-name').value, ''); assert.equal(p.host.querySelector('#identity-document-number').value, '');
    assert.doesNotMatch(JSON.stringify(p.window.localStorage), /110101|合成姓名/);
  } finally { await p.close(); }
  const closed = await mount({}, { capability: { ...capability(), privacy: null } });
  try { assert.equal(closed.host.querySelector('form'), null); assert.equal(closed.calls.length, 0); } finally { await closed.close(); }
});

test('202 retains only the opaque key and reads the same request without another POST or private body', async () => {
  let key; const seen = [];
  const p = await mount({ fetch: async (url, body, init) => { seen.push({ url, body, init }); if (url.endsWith('/verify')) { key = new Headers(init.headers).get('idempotency-key'); return Response.json(unknown(), { status: 202 }); } return Response.json(completed()); } });
  try {
    await fill(p); await p.submit();
    assert.equal(p.window.sessionStorage.getItem(storage), key); assert.doesNotMatch(p.window.sessionStorage.getItem(storage), /110101|合成姓名/);
    assert.equal(p.host.querySelector('form'), null); assert.match(p.host.textContent, /不要重新提交/);
    await p.click('查询原核验结果');
    assert.equal(seen.length, 2); assert.equal(seen[1].init.method, 'GET'); assert.equal(seen[1].body, undefined);
    assert.equal(new Headers(seen[1].init.headers).get('idempotency-key'), key);
    assert.equal(p.window.sessionStorage.getItem(storage), null);
  } finally { await p.close(); }
});

test('a cold remount recovers the original opaque key even when the provider or privacy is no longer available', async () => {
  const seen = [];
  const p = await mount({ initialSessionStorage: { [storage]: 'identity_original' }, fetch: async (url, body, init) => { seen.push({ url, body, init }); return Response.json(unknown(), { status: 202 }); } }, { capability: { available: false, real: true, idempotencyRequired: true, privacy: null } });
  try {
    assert.equal(p.host.querySelector('input'), null);
    await p.click('查询原核验结果');
    assert.equal(seen.length, 1); assert.equal(seen[0].init.method, 'GET'); assert.equal(seen[0].body, undefined);
    assert.equal(new Headers(seen[0].init.headers).get('idempotency-key'), 'identity_original');
    assert.equal(p.window.sessionStorage.getItem(storage), 'identity_original');
  } finally { await p.close(); }
});

test('recovery with an unavailable capability requires an actual attempt receipt before clearing its original key', async () => {
  const seen = [], notices = [];
  const p = await mount({ initialSessionStorage: { [storage]: 'identity_original' }, fetch: async (url, body, init) => {
    seen.push({ url, body, init });
    const receipt = completed();
    if (seen.length === 1) delete receipt.verificationAttempt;
    return Response.json(receipt);
  } }, { capability: undefined, onCompleted: value => notices.push(value) });
  try {
    await p.click('查询原核验结果');
    assert.equal(p.window.sessionStorage.getItem(storage), 'identity_original'); assert.deepEqual(notices, []);
    assert.equal(p.host.querySelector('form'), null); assert.match(p.host.textContent, /原请求仍保留/);
    await p.click('查询原核验结果');
    assert.equal(p.window.sessionStorage.getItem(storage), null); assert.equal(notices.length, 1);
    assert.ok(seen.every(call => call.init.method === 'GET' && call.body === undefined && new Headers(call.init.headers).get('idempotency-key') === 'identity_original'));
  } finally { await p.close(); }
});

test('an unreadable browser receipt prevents all new paid verification attempts', async () => {
  const p = await mount({ initialSessionStorage: { [storage]: 'invalid key' }, fetch: () => { throw Error('must not call'); } });
  try { assert.equal(p.host.querySelector('form'), null); assert.match(p.host.textContent, /阻止新的提交/); assert.equal(p.calls.length, 0); } finally { await p.close(); }
});

test('network unknown and malformed successful receipts preserve the original key instead of enabling a new request', async () => {
  for (const mode of ['network', 'malformed']) {
    const p = await mount({ fetch: async () => { if (mode === 'network') throw Error('response lost'); return Response.json({ status: 'VERIFIED' }); } });
    try { await fill(p); await p.submit(); assert.match(p.window.sessionStorage.getItem(storage), /^identity_/); assert.equal(p.host.querySelector('form'), null); assert.match(p.host.textContent, /只查询原结果|只查询原/); } finally { await p.close(); }
  }
});

test('a late response from an old identity cannot clear its key or display a successful verification on another account', async () => {
  const pending = deferred(), notices = [];
  const p = await mount({ fetch: () => pending.promise }, { onCompleted: value => notices.push(value) });
  try {
    await fill(p); await p.submit(); const key = p.window.sessionStorage.getItem(storage);
    p.identity.userId = 'user_B'; p.identity.identityVersion++; await p.render({ userId: 'user_B' });
    await p.React.act(async () => pending.resolve(Response.json(completed()))); await p.settle();
    assert.equal(p.window.sessionStorage.getItem(storage), key); assert.deepEqual(notices, []); assert.doesNotMatch(p.host.textContent, /实名校验已通过/);
  } finally { await p.close(); }
});

test('a changed privacy version clears the checkbox, and explicit fake capability remains visibly simulated', async () => {
  const p = await mount();
  try { await fill(p); await p.render({ capability: { ...capability(), privacy: { ...capability().privacy, versionId: 'privacy_2' } } }); assert.equal(p.host.querySelector('#identity-verification-consent').checked, false); } finally { await p.close(); }
  const fake = await mount({}, { capability: { available: true, real: false, idempotencyRequired: false } });
  try { assert.match(fake.host.textContent, /本地模拟校验/); assert.match(fake.host.textContent, /请勿填写真实姓名或身份证/); } finally { await fake.close(); }
});
