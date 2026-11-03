import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, LocalSession, localOrigin, ready, totp, validateProfile, main } from './local-auth.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

const cacheActor = { realm: 'user', origin: 'http://127.0.0.1:4310', userId: 'legacy-user', cacheOnly: true };
const cacheState = { cookies: [{ name: 'zzsh_user.session_token', value: 'existing-cache', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
const userSnapshot = { user: { id: cacheActor.userId }, session: { id: 'existing-session' } };

test('cache-only profiles need a subject but store no password; boolean inputs remain strict', () => {
  const profile = entry => ({ version: 1, localTest: true, resource: 'cache_fixture', actors: { legacy: entry } });
  assert.equal(validateProfile(profile(cacheActor)).actors.legacy.cacheOnly, true);
  assert.equal(validateProfile(profile({ realm: 'admin', origin: actor.origin, userId: actor.userId, cacheOnly: true })).actors.legacy.realm, 'admin');
  for (const cacheOnly of ['true', 'false', null, 0, 1, {}, []]) assert.throws(() => validateProfile(profile({ ...cacheActor, cacheOnly })), /CACHE_ONLY_BOOLEAN_REQUIRED/);
  for (const password of ['old-source-password', '', null, undefined]) assert.throws(() => validateProfile(profile({ ...cacheActor, password })), /CACHE_ONLY_PASSWORD_NOT_ALLOWED/);
  assert.throws(() => validateProfile(profile({ ...cacheActor, userId: '' })), /ACTOR_CREDENTIALS_REQUIRED/);
  assert.throws(() => validateProfile(profile({ ...cacheActor, cacheOnly: false })), /ACTOR_CREDENTIALS_REQUIRED/);
  assert.equal(validateProfile(profile({ ...actor, cacheOnly: false })).actors.legacy.password, actor.password);
});

test('cache-only authentication verifies one existing user/admin session and sends no password', async () => {
  for (const [entry, state, body] of [[cacheActor, cacheState, userSnapshot],
    [{ realm: 'admin', origin: actor.origin, userId: actor.userId, cacheOnly: true }, { ...cacheState, cookies: cacheState.cookies.map(c => ({ ...c, name: 'zzsh_admin.session_token' })) }, snapshot]]) {
    const calls = [];
    const result = await authenticate(entry, { state, fetcher: async (url, options) => {
      calls.push(url.pathname); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
      return response(body);
    } });
    assert.equal(result.reused, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /session$/);
  }
});

test('missing/expired cache and --fresh reject before any request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw Error('must not request'); };
  for (const state of [undefined, { cookies: [] }, { cookies: cacheState.cookies.map(c => ({ ...c, expires: 1 })) },
    { cookies: cacheState.cookies.map(c => ({ ...c, name: 'zzsh_admin.session_token' })) }]) {
    await assert.rejects(authenticate(cacheActor, { state, fetcher }), /CACHE_ONLY_SESSION_REQUIRED/);
  }
  await assert.rejects(authenticate(cacheActor, { state: cacheState, fresh: true, fetcher }), /CACHE_ONLY_FRESH_NOT_ALLOWED/);
  await assert.rejects(authenticate({ ...cacheActor, cacheOnly: 'true' }, { state: cacheState, fetcher }), /CACHE_ONLY_BOOLEAN_REQUIRED/);
  assert.equal(calls, 0);
});

test('a rejected cache is never followed by password/TOTP or a replacement session', async () => {
  for (const reply of [response(null), response({}, [], 401), response({}, [], 403), response({ ...userSnapshot, user: { id: 'other-user' } }),
    response({ ...userSnapshot, user: { id: cacheActor.userId, suspended: true } })]) {
    let calls = 0;
    await assert.rejects(authenticate(cacheActor, { state: cacheState, fetcher: async (_url, options) => { calls++; assert.equal(options.method, 'GET'); return reply; } }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(authenticate(cacheActor, { state: cacheState, fetcher: async () => { calls++; throw Error('private transport diagnostic'); } }), /AUTH_NETWORK_OR_REDIRECT_ERROR/);
  assert.equal(calls, 1);
});

test('ordinary actors still fall back from an expired server session to password login', async () => {
  const user = { ...cacheActor, cacheOnly: false, username: 'existing-user', password: 'correct-password' }, calls = [];
  const result = await authenticate(user, { state: cacheState, fetcher: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method });
    if (calls.length === 1) return response(null, [], 401);
    if (calls.length === 2) { assert.equal(JSON.parse(options.body).password, user.password); return response({}, ['zzsh_user.session_token=renewed; Path=/; HttpOnly']); }
    return response(userSnapshot);
  } });
  assert.equal(result.reused, false);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'GET']);
});

test('CLI cache-only mode is listed, reuses exact binding and preserves rejected state bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zzsh-local-auth-test-')), store = join(root, 'store'), directory = join(store, 'cache_fixture');
  const input = join(root, 'fixture.json'), statePath = join(directory, 'legacy.storage-state.json'), stampPath = join(directory, 'legacy.binding.json');
  const binding = { origin: cacheActor.origin, realm: cacheActor.realm, userId: cacheActor.userId };
  const originalLog = console.log, originalFetch = globalThis.fetch, output = [];
  let requests = 0;
  console.log = value => output.push(JSON.parse(value));
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(input, JSON.stringify({ version: 1, localTest: true, resource: 'cache_fixture', actors: { legacy: cacheActor } }));
    await main(['ensure', '--resource', 'cache_fixture', '--input', input, '--store', store]);
    assert.equal(output.at(-1).actors[0].cacheOnly, true);
    const login = ['login', '--resource', 'cache_fixture', '--actor', 'legacy', '--store', store];
    writeFileSync(statePath, JSON.stringify(cacheState)); writeFileSync(stampPath, JSON.stringify(binding));
    globalThis.fetch = async (_url, options) => { requests++; assert.equal(options.method, 'GET'); return response(userSnapshot); };
    await main(login);
    assert.equal(output.at(-1).authenticated, true); assert.equal(output.at(-1).cacheOnly, true); assert.equal(output.at(-1).reused, true); assert.equal(requests, 1);
    for (const kind of ['fresh', 'otp', 'missing-binding', 'wrong-binding', 'wrong-origin', 'wrong-realm', 'unreadable-binding', 'unreadable-state', 'expired', '401', 'wrong-subject', 'network']) {
      writeFileSync(statePath, kind === 'unreadable-state' ? '{' : JSON.stringify(kind === 'expired' ? { cookies: cacheState.cookies.map(c => ({ ...c, expires: 1 })) } : cacheState));
      const nextBinding = kind === 'wrong-binding' ? { ...binding, userId: 'other-user' } : kind === 'wrong-origin' ? { ...binding, origin: 'http://127.0.0.1:4312' } : kind === 'wrong-realm' ? { ...binding, realm: 'admin' } : binding;
      writeFileSync(stampPath, kind === 'unreadable-binding' ? '{' : JSON.stringify(nextBinding));
      if (kind === 'missing-binding') rmSync(stampPath);
      const before = readFileSync(statePath, 'utf8'), stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : null;
      requests = 0;
      globalThis.fetch = async (_url, options) => { requests++; assert.equal(options.method, 'GET'); if (kind === 'network') throw Error('private error'); return response(kind === 'wrong-subject' ? { ...userSnapshot, user: { id: 'other-user' } } : null, [], kind === '401' ? 401 : 200); };
      const args = kind === 'fresh' ? [...login, '--fresh'] : kind === 'otp' ? ['otp', ...login.slice(1)] : login;
      await assert.rejects(main(args), /CACHE_ONLY_/);
      assert.equal(readFileSync(statePath, 'utf8'), before, kind);
      assert.equal(existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : null, stamp, kind);
      assert.equal(requests, ['401', 'wrong-subject', 'network'].includes(kind) ? 1 : 0, kind);
    }
  } finally {
    console.log = originalLog; globalThis.fetch = originalFetch;
    const child = relative(resolve(tmpdir()), resolve(root));
    if (child.startsWith('zzsh-local-auth-test-') && !child.includes('/') && !child.includes('\\')) rmSync(root, { recursive: true });
  }
});
