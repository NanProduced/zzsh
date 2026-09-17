import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

// Local CLI only: no database writes, application route, or authentication bypass.
const fail = (code) => { throw new Error(code); };
const identifier = (s) => /^[a-z][a-z0-9_-]{0,63}$/.test(s ?? '') || fail('INVALID_RESOURCE_OR_ACTOR');
export function localOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_LOCAL_ORIGIN'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('LOOPBACK_ORIGIN_REQUIRED');
  return url.origin;
}

export function totp({ secret, encoding }, now = Date.now()) {
  if (typeof secret !== 'string' || !secret) fail('TOTP_SECRET_MISSING');
  let key;
  if (encoding === 'utf8') key = Buffer.from(secret, 'utf8');
  else if (encoding === 'base32') {
    const value = secret.toUpperCase().replace(/=+$/, '');
    if (!/^[A-Z2-7]+$/.test(value)) fail('INVALID_BASE32');
    const bits = [...value].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
    key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
    if (!key.length || /1/.test(bits.slice(key.length * 8))) fail('INVALID_BASE32');
  } else fail('TOTP_ENCODING_REQUIRED');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function validateProfile(p) {
  if (p?.version !== 1 || p.localTest !== true) fail('LOCAL_TEST_PROFILE_REQUIRED');
  identifier(p.resource);
  if (!p.actors || !Object.keys(p.actors).length) fail('ACTORS_REQUIRED');
  for (const [alias, actor] of Object.entries(p.actors)) {
    identifier(alias);
    if (!['admin', 'user'].includes(actor.realm)) fail('INVALID_REALM');
    if (actor.kind !== undefined && !['phone', 'username'].includes(actor.kind)) fail('INVALID_IDENTIFIER_KIND');
    localOrigin(actor.origin);
    if (![actor.userId, actor.username, actor.password].every(v => typeof v === 'string' && v.length)) fail('ACTOR_CREDENTIALS_REQUIRED');
    if (actor.realm === 'admin') totp(actor.totp ?? {});
  }
  return p;
}

// Credentials survive worktree retirement. Git's first worktree is the main checkout.
export function defaultStore() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const first = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).split('\n')[0];
  if (!first.startsWith('worktree ')) fail('MAIN_CHECKOUT_NOT_FOUND');
  return join(first.slice(9).trim(), 'apps/api/.secrets/local-auth');
}

const protectedDirectories = new Set();
function privateDirectory(path) {
  if (protectedDirectories.has(path)) return;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
    if (!/^S-1-[0-9-]+$/.test(sid)) fail('LOCAL_SID_UNAVAILABLE');
    // This directory is exclusively created/owned by this tool, never a supplied source directory.
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe', windowsHide: true });
  } else chmodSync(path, 0o700);
  protectedDirectories.add(path);
}

export function writePrivate(path, data) {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) rmSync(temporary); }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail('PROFILE_OR_STATE_UNREADABLE'); }
}

export class LocalSession {
  constructor(origin, realm, cookies = [], fetcher = fetch) {
    this.origin = localOrigin(origin);
    this.prefix = realm === 'admin' ? 'zzsh_admin.' : 'zzsh_user.';
    this.cookies = cookies.filter(c => this.validCookie(c));
    this.fetcher = fetcher;
  }
  validCookie(c) {
    return typeof c.name === 'string' && c.name.startsWith(this.prefix) && c.domain === '127.0.0.1' &&
      typeof c.path === 'string' && c.path.startsWith('/') && typeof c.value === 'string' &&
      !/[\r\n;]/.test(c.name + c.value) && (c.expires === -1 || c.expires > Date.now() / 1000);
  }
  absorb(headers, requestPath) {
    for (const raw of headers.getSetCookie()) {
      const [pair, ...parts] = raw.split(';').map(x => x.trim());
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const attrs = Object.fromEntries(parts.map(x => { const i = x.indexOf('='); return i < 0 ? [x.toLowerCase(), true] : [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
      const c = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: String(attrs.domain ?? '127.0.0.1'),
        path: String(attrs.path ?? (requestPath.slice(0, requestPath.lastIndexOf('/')) || '/')),
        expires: attrs['max-age'] !== undefined ? Date.now() / 1000 + Number(attrs['max-age']) : attrs.expires ? Date.parse(String(attrs.expires)) / 1000 : -1,
        httpOnly: attrs.httponly === true, secure: attrs.secure === true,
        sameSite: ({ lax: 'Lax', strict: 'Strict', none: 'None' })[String(attrs.samesite).toLowerCase()] ?? 'Lax' };
      this.cookies = this.cookies.filter(old => old.name !== c.name || old.path !== c.path);
      if (this.validCookie(c)) this.cookies.push(c);
    }
  }
  async request(path, body) {
    if (!path.startsWith('/api/') || path.includes('..') || path.includes('\\')) fail('INVALID_AUTH_PATH');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) fail('INVALID_AUTH_PATH');
    const cookies = this.cookies.filter(c => this.validCookie(c) && (!c.secure || url.protocol === 'https:') &&
      (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')));
    let response;
    try {
      response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Origin: this.origin, 'Content-Type': 'application/json', Cookie: cookies.sort((a,b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ') },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail('AUTH_NETWORK_OR_REDIRECT_ERROR'); }
    this.absorb(response.headers, url.pathname);
    let json;
    try { json = await response.json(); } catch { fail('AUTH_RESPONSE_NOT_JSON'); }
    return { status: response.status, body: json };
  }
  state() { return { cookies: this.cookies.filter(c => this.validCookie(c)), origins: [] }; }
}

function assertSuccess(response, stage) {
  if (response.status !== 200) fail(`${stage}_HTTP_${response.status}`);
}
export function ready(actor, response) {
  if (response.status === 401) return false;
  assertSuccess(response, 'SESSION');
  const s = response.body;
  if (actor.realm === 'admin') {
    if (s?.authenticated === false) return false;
    if (s?.adminUserId !== actor.userId) fail('SESSION_IDENTITY_MISMATCH');
    if (s.security?.status !== 'ACTIVE' || s.security?.passwordChangeRequired || s.user?.twoFactorEnabled !== true) fail('ADMIN_ENROLLMENT_REQUIRED');
    if (s.session?.locked !== false) fail('ADMIN_SESSION_LOCKED');
  } else {
    if (s === null) return false;
    if (s?.user?.id !== actor.userId || !s.session) fail('SESSION_IDENTITY_MISMATCH');
    if (s.user.suspended === true) fail('USER_UNAVAILABLE');
  }
  return true;
}

export async function authenticate(actor, { state, fresh = false, fetcher = fetch } = {}) {
  const session = new LocalSession(actor.origin, actor.realm, fresh ? [] : state?.cookies, fetcher);
  const sessionPath = actor.realm === 'admin' ? '/api/bff/admin/session' : '/api/auth/user/get-session';
  if (!fresh && session.cookies.length && ready(actor, await session.request(sessionPath))) return { state: session.state(), reused: true };
  session.cookies = [];
  if (actor.realm === 'admin') {
    const signIn = await session.request('/api/bff/admin/auth/sign-in/username', { username: actor.username, password: actor.password });
    assertSuccess(signIn, 'PASSWORD');
    if (signIn.body?.twoFactorRedirect === true) {
      // Reuse exactly the URI Base32 secret OR Better Auth raw UTF-8 value, never infer encoding.
      assertSuccess(await session.request('/api/bff/admin/auth/two-factor/verify-totp', { code: totp(actor.totp) }), 'TOTP');
    }
  } else {
    assertSuccess(await session.request('/api/auth/user/sign-in/identifier', { identifier: actor.username, password: actor.password, kind: actor.kind ?? 'username' }), 'PASSWORD');
  }
  if (!ready(actor, await session.request(sessionPath))) fail('SESSION_NOT_AUTHENTICATED');
  return { state: session.state(), reused: false };
}

export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals: [command] } = parseArgs({ args, allowPositionals: true, options: {
    resource: { type: 'string' }, actor: { type: 'string' }, input: { type: 'string' }, store: { type: 'string' }, fresh: { type: 'boolean' }, clipboard: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (v.help || !command) {
    console.log('local:auth ensure --resource NAME --input PRIVATE_PROFILE.json | list --resource NAME | login --resource NAME --actor NAME [--fresh] | otp --resource NAME --actor NAME [--clipboard]\nSee docs/local-test-auth.md'); return;
  }
  if (!['ensure','list','login','otp'].includes(command)) fail('UNKNOWN_COMMAND');
  identifier(v.resource);
  const directory = join(resolve(v.store ?? defaultStore()), v.resource);
  const profilePath = join(directory, 'profile.json');
  if (command === 'ensure' && v.input) {
    const incoming = validateProfile(readJson(resolve(v.input)));
    if (incoming.resource !== v.resource) fail('RESOURCE_MISMATCH');
    if (existsSync(profilePath)) {
      const old = validateProfile(readJson(profilePath));
      if (JSON.stringify(old) !== JSON.stringify(incoming)) fail('PROFILE_EXISTS_DIFFERENT_DO_NOT_RESET');
    } else writePrivate(profilePath, incoming);
  }
  if (!existsSync(profilePath)) fail('PROFILE_MISSING_REGISTER_EXISTING_FIXTURE_WITH_ENSURE_INPUT');
  const profile = validateProfile(readJson(profilePath));
  if (profile.resource !== v.resource) fail('RESOURCE_MISMATCH');
  if (command === 'ensure' || command === 'list') {
    console.log(JSON.stringify({ resource: profile.resource, profile: profilePath, actors: Object.entries(profile.actors).map(([alias, a]) => ({ alias, realm: a.realm, origin: a.origin })) })); return;
  }
  identifier(v.actor);
  const actor = profile.actors[v.actor];
  if (!actor) fail('ACTOR_NOT_REGISTERED');
  if (command === 'otp') {
    if (actor.realm !== 'admin') fail('USER_DOES_NOT_REQUIRE_TOTP');
    const code = totp(actor.totp);
    if (v.clipboard) { execFileSync('clip.exe', [], { input: code, windowsHide: true }); console.log('TOTP copied to clipboard'); }
    else console.log(code);
    return;
  }
  const statePath = join(directory, `${v.actor}.storage-state.json`);
  const stampPath = join(directory, `${v.actor}.binding.json`);
  const binding = { origin: actor.origin, realm: actor.realm, userId: actor.userId };
  const canReuse = existsSync(stampPath) && JSON.stringify(readJson(stampPath)) === JSON.stringify(binding);
  try {
    const result = await authenticate(actor, { state: canReuse && existsSync(statePath) ? readJson(statePath) : undefined, fresh: v.fresh });
    writePrivate(statePath, result.state);
    writePrivate(stampPath, binding);
    console.log(JSON.stringify({ authenticated: true, resource: profile.resource, actor: v.actor, realm: actor.realm, origin: actor.origin, reused: result.reused, storageState: statePath }));
  } catch (error) {
    if (existsSync(statePath)) rmSync(statePath);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message?.match(/^[A-Z][A-Z0-9_]+$/) ? error.message : 'LOCAL_AUTH_FAILED_SEE_DOCS'); process.exitCode = 1; });
}
