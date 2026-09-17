import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, LocalSession, localOrigin, ready, totp, validateProfile, main } from './local-auth.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const actor = { realm: 'admin', origin: 'http://127.0.0.1:4311', userId: 'staff-1', username: 'qa', password: 'test-password', totp: { encoding: 'utf8', secret: '12345678901234567890' } };
const snapshot = { authenticated: true, adminUserId: actor.userId, security: { status: 'ACTIVE', passwordChangeRequired: false }, user: { twoFactorEnabled: true }, session: { locked: false } };
const response = (body, cookies = [], status = 200) => { const headers = new Headers({ 'Content-Type': 'application/json' }); cookies.forEach(c => headers.append('Set-Cookie', c)); return new Response(JSON.stringify(body), { status, headers }); };

test('RFC 6238 vectors; URI Base32 and raw Better Auth secret have identical semantics', () => {
  const encoded = { encoding: 'base32', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
  for (const [seconds, expected] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']]) {
    assert.equal(totp(actor.totp, seconds * 1000), expected);
    assert.equal(totp(encoded, seconds * 1000), expected);
  }
  assert.throws(() => totp({ secret: 'ABC' }), /ENCODING/);
  assert.throws(() => totp({ secret: '*', encoding: 'base32' }), /BASE32/);
});

test('reject external targets, credentials in URL, traversal, malformed profile before login', () => {
  for (const value of ['https://production.example','http://127.0.0.1:4311/path','http://user:secret@127.0.0.1:4311','http://localhost:4311','http://127.0.0.1:4311?x=1']) assert.throws(() => localOrigin(value));
  assert.throws(() => validateProfile({ version: 1, localTest: true, resource: '../main', actors: { qa: actor } }));
  assert.throws(() => validateProfile({ version: 1, localTest: false, resource: 'qa', actors: { qa: actor } }));
});

test('password challenge -> TOTP -> authoritative session; only realm cookies exported', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url.pathname);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Origin, actor.origin);
    if (calls.length === 1) return response({ twoFactorRedirect: true }, ['zzsh_admin.two_factor=challenge; Path=/; HttpOnly', 'zzsh_user.session_token=wrong; Path=/']);
    if (calls.length === 2) {
      assert.match(options.headers.Cookie, /two_factor=challenge/);
      assert.equal(JSON.parse(options.body).code, totp(actor.totp));
      return response({ status: true }, ['zzsh_admin.two_factor=; Max-Age=0; Path=/', 'zzsh_admin.session_token=verified; Path=/; HttpOnly; SameSite=Lax']);
    }
    assert.equal(options.headers.Cookie, 'zzsh_admin.session_token=verified');
    return response(snapshot);
  };
  const result = await authenticate(actor, { fetcher });
  assert.deepEqual(calls, ['/api/bff/admin/auth/sign-in/username','/api/bff/admin/auth/two-factor/verify-totp','/api/bff/admin/session']);
  assert.equal(result.state.cookies.length, 1);
  assert.equal(result.state.cookies[0].httpOnly, true);
  let requests = 0;
  assert.equal((await authenticate(actor, { state: result.state, fetcher: async () => { requests++; return response(snapshot); } })).reused, true);
  assert.equal(requests, 1);
});

test('401/failed TOTP are not retried; different identity, enrollment, frozen and locked remain rejected', async () => {
  for (const state of [ { ...snapshot, adminUserId: 'another' }, { ...snapshot, security: { status: 'FROZEN' } }, { ...snapshot, security: { status: 'PENDING_ENROLLMENT' } }, { ...snapshot, session: { locked: true } } ]) assert.throws(() => ready(actor, { status: 200, body: state }));
  let requests = 0;
  await assert.rejects(authenticate(actor, { fetcher: async () => { requests++; return response({ message: 'private debug data' }, [], 401); } }), /^Error: PASSWORD_HTTP_401$/);
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(authenticate(actor, { fetcher: async () => ++requests === 1 ? response({ twoFactorRedirect: true }) : response({}, [], 401) }), /TOTP_HTTP_401/);
  assert.equal(requests, 2);
  await assert.rejects(authenticate(actor, { fetcher: async () => { throw new Error('secret in transport error'); } }), /^Error: AUTH_NETWORK_OR_REDIRECT_ERROR$/);
});

test('user password uses Web same-origin BFF, never sends SMS; null session is not success', async () => {
  const user = { ...actor, realm: 'user', origin: 'http://127.0.0.1:4310', username: '+8613800000000', kind: 'phone' };
  const calls = [];
  const result = await authenticate(user, { fetcher: async (url, options) => {
    calls.push(url.pathname);
    if (calls.length === 1) { assert.equal(JSON.parse(options.body).kind, 'phone'); return response({}, ['zzsh_user.session_token=user-session; Path=/; HttpOnly']); }
    return response({ user: { id: user.userId }, session: { id: 's1' } });
  } });
  assert.deepEqual(calls, ['/api/auth/user/sign-in/identifier', '/api/auth/user/get-session']);
  assert.equal(result.state.cookies[0].name, 'zzsh_user.session_token');
  assert.equal(ready(user, { status: 200, body: null }), false);
});

test('cookie path, expiry, realm and domain isolation', async () => {
  let sent;
  const client = new LocalSession(actor.origin, 'admin', [], async (_, options) => { sent = options.headers.Cookie; return response({}); });
  const headers = new Headers();
  for (const c of ['zzsh_admin.session_token=a; Path=/', 'zzsh_admin.extra=b; Path=/api/only', 'zzsh_admin.evil=x; Domain=example.com; Path=/', 'zzsh_admin.old=old; Max-Age=0; Path=/']) headers.append('Set-Cookie', c);
  client.absorb(headers, '/api/test');
  await client.request('/api/only-sibling');
  assert.equal(sent, 'zzsh_admin.session_token=a');
  await assert.rejects(client.request('//example.com'), /PATH/);
});

test('ensure preserves credentials across repeats and refuses silent replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zzsh-local-auth-test-'));
  const input = join(root, 'fixture.json');
  const store = join(root, 'store');
  const profile = { version: 1, localTest: true, resource: 'test_fixture', actors: { staff: actor } };
  const originalLog = console.log;
  const output = [];
  console.log = value => output.push(value);
  try {
    writeFileSync(input, JSON.stringify(profile));
    const args = ['ensure','--resource','test_fixture','--input',input,'--store',store];
    await main(args);
    const before = readFileSync(join(store, 'test_fixture/profile.json'), 'utf8');
    await main(args);
    assert.equal(readFileSync(join(store, 'test_fixture/profile.json'), 'utf8'), before);
    profile.actors.staff = { ...actor, password: 'new-password' };
    writeFileSync(input, JSON.stringify(profile));
    await assert.rejects(main(args), /PROFILE_EXISTS_DIFFERENT/);
    assert.equal(readFileSync(join(store, 'test_fixture/profile.json'), 'utf8'), before);
    assert.ok(output.every(line => !line.includes(actor.password) && !line.includes(actor.totp.secret)));
  } finally {
    console.log = originalLog;
    const child = relative(resolve(tmpdir()), resolve(root));
    if (child.startsWith('zzsh-local-auth-test-') && !child.includes('/') && !child.includes('\\')) rmSync(root, { recursive: true });
  }
});
