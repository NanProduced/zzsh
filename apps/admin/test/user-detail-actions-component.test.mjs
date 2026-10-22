import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(tree, 'package.json'));
const React = require('react'), ts = require('typescript');
class AdminApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
function loadHook() {
  const file = path.join(tree, 'apps/admin/src/views/user-directory/user-detail-actions.tsx');
  const module = new Module(file); module.filename = file; module.paths = Module._nodeModulePaths(path.dirname(file));
  const native = module.require.bind(module);
  module.require = name => {
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: () => props => React.createElement('div', null, props.children) });
    if (name === '../../api') return { AdminApiError };
    if (name === './user-directory-shared') return { Message: () => null, errorText: error => error?.message ?? 'error', time: value => value, useDirectoryRequest: () => ({ result: { state: 'loading' } }) };
    return native(name);
  };
  module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return module.exports.useUserCommand;
}
function storage() {
  const values = new Map(), localValues = new Map();
  const state = { failSet: false, failRemove: false };
  globalThis.sessionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (state.failSet) throw Error('STORAGE_UNAVAILABLE'); values.set(key, value); }, removeItem: key => { if (state.failRemove) throw Error('STORAGE_UNAVAILABLE'); values.delete(key); } };
  globalThis.localStorage = { getItem: key => localValues.get(key) ?? null, setItem: (key, value) => localValues.set(key, value), removeItem: key => localValues.delete(key) };
  return { values, localValues, state };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const command = (userId = 'user-A', key = 'original-note-key') => ({ path: `${userId}/notes`, method: 'POST', key, body: { text: '待核对的内部备注' } });
const noteDigest = () => createHash('sha256').update(command().body.text).digest('hex');
function adapter(options = {}) {
  const calls = { writes: [], notes: [], details: [], pagedNotes: 0 };
  const result = {
    snapshot: { adminUserId: 'admin-A', session: { id: 'session-A', locked: false }, security: { status: 'ACTIVE', passwordChangeRequired: false } },
    async userCommand(path, body, method, key) {
      calls.writes.push({ path, body: body ? { ...body } : undefined, method, key });
      if (options.write) return options.write(path, body, method, key);
      const userId = path.split('/')[0];
      return path.endsWith('/risk-flag') ? { userId, flagged: body.flagged, revision: body.expectedRevision + 1, changed: true }
        : method === 'DELETE' ? { userId, noteId: path.split('/').at(-1), deleted: true } : { userId, noteId: 'note-accepted', created: true };
    },
    async note(userId, noteId) {
      calls.notes.push({ userId, noteId });
      if (options.read) return options.read(userId, noteId);
      return { id: noteId, userId, deleted: false, author: { id: result.snapshot.adminUserId, displayName: '管理员' }, text: command().body.text, bodyDigest: noteDigest() };
    },
    async detail(userId) { calls.details.push(userId); return options.detail ? options.detail(userId) : { id: userId, riskFlag: true, riskRevision: 1 }; },
    async notes() { calls.pagedNotes++; return { items: [], nextCursor: null }; },
  };
  result.calls = calls; return result;
}
async function render(t, hook, initialAdapter, initialUser = 'user-A', initialKind = 'notes') {
  const browser = new Window({ url: 'http://127.0.0.1:4291/users/user-A' });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = require('react-dom/client').createRoot(host);
  let props = { adapter: initialAdapter, userId: initialUser, kind: initialKind }, latest, mounted = true;
  const done = [];
  function Probe() {
    latest = hook(props.adapter, props.userId, props.kind, () => done.push({ userId: props.userId, sessionId: props.adapter.snapshot.session.id }));
    return React.createElement('div', { 'data-pending': latest.pending?.key ?? '', 'data-phase': latest.pending?.phase ?? '', 'data-blocked': String(latest.blocked) }, latest.message);
  }
  const update = async changes => { props = { ...props, ...changes }; await React.act(async () => root.render(React.createElement(Probe))); };
  const unmount = async () => { if (mounted) { await React.act(async () => root.unmount()); mounted = false; } };
  t.after(async () => { await unmount(); host.remove(); await browser.happyDOM.abort(); });
  await update({});
  return { get action() { return latest; }, done, host, update, unmount };
}
async function submit(h, value) { await React.act(async () => { await h.action.submit(value); }); }

test('UNKNOWN survives unmount/reload; a 403 replay retains the exact original request', async t => {
  const store = storage(), hook = loadHook();
  let mode = 'lost';
  const a = adapter({ write: async () => { throw mode === 'lost' ? new Error('RESPONSE_LOST') : new AdminApiError(403, 'FORBIDDEN'); } });
  const first = await render(t, hook, a); await submit(first, command());
  assert.equal(first.action.pending.key, 'original-note-key'); assert.equal(store.values.size, 1);
  await first.unmount(); mode = 'denied';
  const resumed = await render(t, loadHook(), a);
  assert.deepEqual(resumed.action.pending.body, command().body);
  await submit(resumed, resumed.action.pending);
  assert.equal(resumed.action.pending.key, 'original-note-key'); assert.equal(store.values.size, 1);
  assert.deepEqual(a.calls.writes[0], a.calls.writes[1]); assert.equal(a.calls.notes.length, 0);
  assert.equal(resumed.action.accepted, false); assert.equal(resumed.done.length, 0);
  assert.equal(store.localValues.size, 0);
});

test('an accepted receipt with failed readback restores as read-only and never rewrites', async t => {
  const store = storage(); let failed = true;
  const a = adapter({ read: async (userId, id) => { if (failed) throw new AdminApiError(503, 'READ_FAILED'); return { id, userId, deleted: false, author: { id: 'admin-A' }, text: command().body.text, bodyDigest: noteDigest() }; } });
  const first = await render(t, loadHook(), a); await submit(first, command());
  assert.equal(first.action.pending.phase, 'readback'); assert.equal(first.action.pending.receipt.noteId, 'note-accepted');
  assert.equal(first.action.accepted, false); await first.unmount();
  failed = false;
  const resumed = await render(t, loadHook(), a); assert.equal(resumed.action.pending.phase, 'readback');
  await submit(resumed, resumed.action.pending);
  assert.equal(a.calls.writes.length, 1); assert.equal(a.calls.notes.length, 2); assert.equal(a.calls.pagedNotes, 0);
  assert.equal(resumed.action.pending, undefined); assert.equal(resumed.action.accepted, true); assert.equal(store.values.size, 0);
});

test('a response received after unmount retains accepted responsibility without calling the old view', async t => {
  storage(); const hook = loadHook(), response = deferred();
  const a = adapter({ write: () => response.promise });
  const first = await render(t, hook, a); let writing;
  await React.act(async () => { writing = first.action.submit(command()); });
  await first.unmount();
  await React.act(async () => { response.resolve({ userId: 'user-A', noteId: 'note-accepted', created: true }); await writing; });
  assert.equal(first.done.length, 0); assert.equal(a.calls.notes.length, 0);
  const resumed = await render(t, hook, a); assert.equal(resumed.action.pending.phase, 'readback');
  await submit(resumed, resumed.action.pending);
  assert.equal(a.calls.writes.length, 1); assert.equal(resumed.done.length, 1);
});

test('late user-A responses cannot alter user-B UI; session/admin/user scopes remain distinct', async t => {
  storage(); const hook = loadHook(), response = deferred();
  const a = adapter({ write: () => response.promise });
  const h = await render(t, hook, a); let writing;
  await React.act(async () => { writing = h.action.submit(command()); });
  const b = adapter(); b.snapshot = { ...b.snapshot, adminUserId: 'admin-B', session: { id: 'session-B', locked: false } };
  await h.update({ adapter: b, userId: 'user-B' });
  assert.equal(h.action.pending, undefined); assert.equal(h.action.busy, false); assert.equal(h.action.accepted, false);
  await React.act(async () => { response.resolve({ userId: 'user-A', noteId: 'note-accepted', created: true }); await writing; });
  assert.equal(h.action.pending, undefined); assert.equal(h.action.accepted, false); assert.equal(h.done.length, 0); assert.equal(a.calls.notes.length, 0);
  await h.update({ adapter: a, userId: 'user-A' }); assert.equal(h.action.pending.phase, 'readback');
  await h.update({ adapter: { ...a, snapshot: { ...a.snapshot, session: { id: 'session-new', locked: false } } } });
  assert.equal(h.action.pending, undefined);
});

test('an unresolved notes command blocks a different risk command for the same user', async t => {
  storage(); const a = adapter({ write: async () => { throw new Error('LOST'); } });
  const h = await render(t, loadHook(), a); await submit(h, command());
  await h.update({ kind: 'risk' });
  assert.equal(h.action.blocked, true); assert.equal(h.action.pending, undefined);
  await submit(h, { path: 'user-A/risk-flag', method: 'POST', key: 'other-key', body: { flagged: true, expectedRevision: 0 } });
  assert.equal(a.calls.writes.length, 1);
  await h.update({ kind: 'notes' }); assert.equal(h.action.pending.key, 'original-note-key');
});

test('risk readback trusts its exact original receipt when later operations changed the flag', async t => {
  const store = storage();
  const a = adapter({ detail: async id => ({ id, riskFlag: false, riskRevision: 2 }) });
  const h = await render(t, loadHook(), a, 'user-A', 'risk');
  await submit(h, { path: 'user-A/risk-flag', method: 'POST', key: 'risk-original', body: { flagged: true, expectedRevision: 0 } });
  assert.equal(h.action.accepted, true); assert.equal(h.action.pending, undefined); assert.equal(a.calls.writes.length, 1); assert.equal(store.values.size, 0);
});

test('accepted risk with a 403 readback keeps its receipt and resumes without another write', async t => {
  storage(); let denied = true;
  const a = adapter({ detail: async id => { if (denied) throw new AdminApiError(403, 'FORBIDDEN'); return { id, riskFlag: true, riskRevision: 1 }; } });
  const h = await render(t, loadHook(), a, 'user-A', 'risk');
  await submit(h, { path: 'user-A/risk-flag', method: 'POST', key: 'risk-original', body: { flagged: true, expectedRevision: 0 } });
  assert.equal(h.action.pending.phase, 'readback'); assert.equal(h.action.pending.receipt.revision, 1);
  denied = false; await submit(h, h.action.pending);
  assert.equal(h.action.accepted, true); assert.equal(a.calls.writes.length, 1); assert.equal(a.calls.details.length, 2);
});

test('delete requires the exact tombstone; 404 or an empty first page never proves deletion', async t => {
  storage(); let mode = 'missing';
  const a = adapter({ read: async (userId, id) => { if (mode === 'missing') throw new AdminApiError(404, 'NOT_FOUND'); return { id, userId, deleted: true }; } });
  const h = await render(t, loadHook(), a);
  await submit(h, { path: 'user-A/notes/note-old', method: 'DELETE', key: 'delete-original' });
  assert.equal(h.action.pending.phase, 'readback'); assert.equal(h.action.accepted, false); assert.equal(a.calls.pagedNotes, 0);
  mode = 'deleted'; await submit(h, h.action.pending);
  assert.equal(h.action.accepted, true); assert.equal(a.calls.writes.length, 1); assert.equal(a.calls.notes.every(call => call.noteId === 'note-old'), true);
});

test('new note readback validates author and text, not merely a matching id', async t => {
  storage(); let wrong = true;
  const a = adapter({ read: async (userId, id) => ({ id, userId, deleted: false, author: { id: wrong ? 'another-admin' : 'admin-A' }, text: command().body.text, bodyDigest: noteDigest() }) });
  const h = await render(t, loadHook(), a); await submit(h, command());
  assert.equal(h.action.pending.phase, 'readback'); assert.equal(h.action.accepted, false);
  wrong = false; await submit(h, h.action.pending);
  assert.equal(h.action.accepted, true); assert.equal(a.calls.writes.length, 1);
});

test('storage failures prevent first writes and prevent clearing an accepted record prematurely', async t => {
  const store = storage(), a = adapter(), h = await render(t, loadHook(), a);
  store.state.failSet = true; await submit(h, command());
  assert.equal(a.calls.writes.length, 0); assert.equal(h.action.pending, undefined);
  store.state.failSet = false; store.state.failRemove = true; await submit(h, command());
  assert.equal(a.calls.writes.length, 1); assert.equal(h.action.pending.phase, 'readback'); assert.equal(h.action.accepted, false);
  store.state.failRemove = false; await submit(h, h.action.pending);
  assert.equal(a.calls.writes.length, 1); assert.equal(h.action.accepted, true); assert.equal(store.values.size, 0);
});

test('unsupported paths and sensitive request fields are never persisted or sent', async t => {
  const store = storage(), a = adapter(), h = await render(t, loadHook(), a);
  await submit(h, { path: 'user-A/sensitive-profile', method: 'POST', key: 'sensitive-key', body: { phoneNumber: '+999synthetic' } });
  await submit(h, { ...command(), body: { ...command().body, phoneNumber: '+999synthetic' } });
  await submit(h, command('different-user'));
  assert.equal(a.calls.writes.length, 0); assert.equal(store.values.size, 0); assert.equal(store.localValues.size, 0);
});

test('in-flight responsibility prevents duplicate writes after an immediate remount', async t => {
  storage(); const hook = loadHook(), response = deferred(), a = adapter({ write: () => response.promise });
  const first = await render(t, hook, a); let writing;
  await React.act(async () => { writing = first.action.submit(command()); });
  await first.unmount(); const resumed = await render(t, hook, a);
  assert.equal(resumed.action.busy, true); await submit(resumed, resumed.action.pending); assert.equal(a.calls.writes.length, 1);
  await React.act(async () => { response.reject(new Error('LOST')); await writing; });
  assert.equal(resumed.action.busy, false); assert.equal(resumed.action.pending.key, 'original-note-key');
});

test('accepted create can close after a later deletion only with the original author and body digest', async t => {
  storage(); let wrong = true;
  const a = adapter({ read: async (userId, id) => ({ id, userId, deleted: true, author: { id: 'admin-A' }, bodyDigest: wrong ? '0'.repeat(64) : noteDigest() }) });
  const h = await render(t, loadHook(), a); await submit(h, command());
  assert.equal(h.action.pending.phase, 'readback'); assert.equal(h.action.accepted, false);
  wrong = false; await submit(h, h.action.pending);
  assert.equal(h.action.pending, undefined); assert.equal(h.action.accepted, true); assert.equal(a.calls.writes.length, 1);
});
