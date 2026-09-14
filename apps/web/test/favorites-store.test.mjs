import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FavoritesStore } from '../src/lib/favorites-store.ts';
import { SupplyRequestError } from '../src/lib/supply-client.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function page(accountIds, nextCursor = null) { return { accountIds, nextCursor }; }
class FakeTransport {
  constructor() {
    this.sessions = [];
    this.pages = [];
    this.writes = [];
    this.sessionCalls = 0;
    this.pageCalls = [];
    this.writeCalls = 0;
  }
  static value(entry) {
    if (entry instanceof Error) return Promise.reject(entry);
    return Promise.resolve(entry);
  }
  session() {
    this.sessionCalls += 1;
    const next = this.sessions.shift();
    if (next === undefined) return Promise.resolve({ userId: null });
    return FakeTransport.value(next);
  }
  favoritesPage(cursor) {
    this.pageCalls.push(cursor);
    const next = this.pages.shift();
    if (next === undefined) return Promise.resolve(page([]));
    return FakeTransport.value(next);
  }
  setFavorite(_accountId, _saved, _key) {
    this.writeCalls += 1;
    const next = this.writes.shift();
    if (next === undefined) return Promise.resolve();
    return FakeTransport.value(next);
  }
}

test('identity switch discards a held list response from the previous user', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' }, { userId: 'user-b' });
  const held = deferred();
  transport.pages.push(held.promise, page([]));
  const store = new FavoritesStore(transport);
  void store.confirmIdentity();
  await flush();
  assert.equal(store.getSnapshot().userId, 'user-a');
  await store.confirmIdentity();
  assert.equal(store.getSnapshot().userId, 'user-b');
  held.resolve(page(['account-a']));
  await flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.userId, 'user-b');
  assert.equal(snapshot.saved.has('account-a'), false);
  assert.equal(snapshot.saved.size, 0);
  assert.equal(store.statusOf('account-a') === 'saved', false);
  store.dispose();
});

test('a write response released after switching users cannot touch the new identity', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' }, { userId: 'user-b' });
  transport.pages.push(page([]), page([]));
  const heldWrite = deferred();
  transport.writes.push(heldWrite.promise);
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  const write = store.toggle('account-x', true);
  await flush();
  assert.equal(store.statusOf('account-x'), 'pending');
  await store.confirmIdentity();
  assert.equal(store.getSnapshot().userId, 'user-b');
  heldWrite.resolve();
  await write;
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.userId, 'user-b');
  assert.equal(snapshot.saved.has('account-x'), false);
  assert.equal(snapshot.pending.size, 0);
  assert.equal(snapshot.notice, null);
  assert.equal(store.statusOf('account-x') === 'saved', false);
  store.dispose();
});

test('a failed write notice and attempt are cleared on identity switch and never retried', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' }, { userId: 'user-b' });
  transport.pages.push(page([]), page([]));
  transport.writes.push(new SupplyRequestError(500, null));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  await assert.rejects(() => store.toggle('account-x', true));
  assert.equal(store.getSnapshot().notice.retryAccountId, 'account-x');
  await store.confirmIdentity();
  assert.equal(store.getSnapshot().notice, null);
  const writesBeforeRetry = transport.writeCalls;
  await store.retry();
  await flush();
  assert.equal(transport.writeCalls, writesBeforeRetry);
  assert.equal(store.statusOf('account-x') === 'saved', false);
  store.dispose();
});

test('identity confirmation failure is an error, not a guest, and can be retried', async () => {
  const transport = new FakeTransport();
  transport.sessions.push(new Error('network'), { userId: 'user-a' });
  transport.pages.push(page(['account-a']));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  assert.equal(store.getSnapshot().status, 'error');
  assert.equal(store.getSnapshot().saved.size, 0);
  await store.confirmIdentity();
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.equal(store.getSnapshot().saved.has('account-a'), true);
  store.dispose();
});

test('the identity is cleared while re-confirmation is in flight', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page([]), page([]));
  transport.writes.push(undefined);
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  await store.toggle('account-x', true);
  assert.equal(store.getSnapshot().saved.has('account-x'), true);
  const heldSession = deferred();
  transport.sessions.push(heldSession.promise);
  const second = store.confirmIdentity();
  await flush();
  const loading = store.getSnapshot();
  assert.equal(loading.status, 'loading');
  assert.equal(loading.saved.size, 0);
  assert.equal(loading.notice, null);
  assert.equal(loading.pending.size, 0);
  assert.equal(store.statusOf('account-x'), 'unknown');
  heldSession.resolve({ userId: 'user-a' });
  await second;
  store.dispose();
});

test('a background load cannot revert a favorite saved while it was in flight', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  const held = deferred();
  transport.pages.push(held.promise);
  transport.writes.push(undefined);
  const store = new FavoritesStore(transport);
  const confirm = store.confirmIdentity();
  await flush();
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.equal(store.getSnapshot().complete, false);
  await store.toggle('account-x', true);
  assert.equal(store.statusOf('account-x'), 'saved');
  held.resolve(page([]));
  await confirm;
  assert.equal(store.getSnapshot().complete, true);
  assert.equal(store.statusOf('account-x'), 'saved');
  assert.equal(store.getSnapshot().saved.has('account-x'), true);
  store.dispose();
});

test('a late page response cannot re-add a favorite removed afterwards', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' }, { userId: 'user-a' });
  transport.pages.push(page(['account-y']));
  transport.writes.push(undefined);
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  assert.equal(store.statusOf('account-y'), 'saved');
  const held = deferred();
  transport.pages.push(held.promise);
  const confirm = store.confirmIdentity();
  await flush();
  await store.toggle('account-y', false);
  held.resolve(page(['account-y']));
  await confirm;
  assert.equal(store.getSnapshot().saved.has('account-y'), false);
  assert.equal(store.statusOf('account-y') === 'saved', false);
  store.dispose();
});

test('more than one hundred favorites load completely and only then become definitively unsaved', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  const firstPage = Array.from({ length: 100 }, (_, index) => `account-${index}`);
  const held = deferred();
  transport.pages.push(held.promise, page(['account-100']));
  const store = new FavoritesStore(transport);
  const confirm = store.confirmIdentity();
  await flush();
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.equal(store.statusOf('not-favorited'), 'unknown');
  held.resolve(page(firstPage, 'cursor-1'));
  await confirm;
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.saved.size, 101);
  assert.equal(snapshot.saved.has('account-99'), true);
  assert.equal(snapshot.saved.has('account-100'), true);
  assert.equal(store.statusOf('not-favorited'), 'unsaved');
  assert.equal(transport.pageCalls.length, 2);
  store.dispose();
});

test('a 401 write clears private state into guest instead of keeping stale favorites', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page(['account-a']));
  transport.writes.push(new SupplyRequestError(401, null));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  await assert.rejects(() => store.toggle('account-b', true));
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, 'guest');
  assert.equal(snapshot.saved.size, 0);
  assert.equal(snapshot.pending.size, 0);
  assert.equal(snapshot.notice.retryAccountId, null);
  store.dispose();
});

test('no session is a guest, not an error', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: null });
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  assert.equal(store.getSnapshot().status, 'guest');
  assert.equal(store.getSnapshot().saved.size, 0);
  store.dispose();
});

test('a same-user refresh keeps an in-flight write result', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' }, { userId: 'user-a' });
  transport.pages.push(page([]), page([]));
  const heldWrite = deferred();
  transport.writes.push(heldWrite.promise);
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  const write = store.toggle('account-x', true);
  const refresh = store.confirmIdentity();
  await flush();
  assert.equal(store.getSnapshot().userId, 'user-a');
  heldWrite.resolve();
  await write;
  await refresh;
  assert.equal(store.statusOf('account-x'), 'saved');
  assert.equal(store.getSnapshot().saved.has('account-x'), true);
  assert.equal(store.getSnapshot().pending.size, 0);
  store.dispose();
});

test('a failed write across a same-user refresh rolls back and keeps its retry', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' }, { userId: 'user-a' });
  transport.pages.push(page(['account-y']), page(['account-y']));
  const heldWrite = deferred();
  transport.writes.push(heldWrite.promise);
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  const write = store.toggle('account-z', true);
  const refresh = store.confirmIdentity();
  await flush();
  heldWrite.reject(new SupplyRequestError(500, null));
  await assert.rejects(() => write);
  await refresh;
  assert.equal(store.statusOf('account-z'), 'unsaved');
  assert.equal(store.getSnapshot().notice.retryAccountId, 'account-z');
  assert.equal(store.getSnapshot().pending.size, 0);
  assert.equal(store.getSnapshot().saved.has('account-z'), false);
  store.dispose();
});

test('a repeated toggle on the same item while pending is ignored', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page([]));
  const heldWrite = deferred();
  transport.writes.push(heldWrite.promise);
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  const first = store.toggle('account-x', true);
  await flush();
  await store.toggle('account-x', false);
  assert.equal(transport.writeCalls, 1);
  heldWrite.resolve();
  await first;
  assert.equal(store.statusOf('account-x'), 'saved');
  await store.toggle('account-x', false);
  assert.equal(transport.writeCalls, 2);
  assert.equal(store.statusOf('account-x'), 'unsaved');
  store.dispose();
});

test('panel records are saved evidence while the background list is incomplete', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(new Error('page failed'));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.equal(store.getSnapshot().complete, false);
  assert.equal(store.statusOf('account-p'), 'unknown');
  store.registerSavedRecords(['account-p']);
  assert.equal(store.statusOf('account-p'), 'saved');
  await store.toggle('account-p', false);
  assert.equal(store.statusOf('account-p'), 'unsaved');
  store.dispose();
});

test('a failed cancel restores the panel record', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(new Error('page failed'));
  transport.writes.push(new SupplyRequestError(500, null));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  store.registerSavedRecords(['account-q']);
  await assert.rejects(() => store.toggle('account-q', false));
  assert.equal(store.statusOf('account-q'), 'saved');
  assert.equal(store.getSnapshot().notice.retryAccountId, 'account-q');
  store.dispose();
});

test('a complete read replaces panel evidence with server truth', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page([]));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  store.registerSavedRecords(['account-r']);
  assert.equal(store.statusOf('account-r'), 'saved');
  transport.pages.push(page([]));
  await store.reloadFavorites();
  assert.equal(store.getSnapshot().complete, true);
  assert.equal(store.statusOf('account-r'), 'unsaved');
  store.dispose();
});

test('a partial re-read keeps panel evidence', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page([]));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  store.registerSavedRecords(['account-s']);
  transport.pages.push(new Error('page failed'));
  await store.reloadFavorites();
  assert.equal(store.getSnapshot().complete, false);
  assert.equal(store.statusOf('account-s'), 'saved');
  store.dispose();
});

test('a late read cannot resurrect a canceled panel record', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  const held = deferred();
  transport.pages.push(held.promise);
  transport.writes.push(undefined);
  const store = new FavoritesStore(transport);
  const confirm = store.confirmIdentity();
  await flush();
  store.registerSavedRecords(['account-t']);
  assert.equal(store.statusOf('account-t'), 'saved');
  await store.toggle('account-t', false);
  held.resolve(page(['account-t']));
  await confirm;
  assert.equal(store.statusOf('account-t'), 'unsaved');
  assert.equal(store.getSnapshot().saved.has('account-t'), false);
  store.dispose();
});

test('a successful cancel survives a failed first-screen refresh', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page(['account-a']));
  transport.writes.push(undefined);
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  assert.equal(store.statusOf('account-a'), 'saved');
  await store.toggle('account-a', false);
  assert.equal(store.statusOf('account-a'), 'unsaved');
  transport.pages.push(new Error('network'));
  await store.reloadFavorites();
  assert.equal(store.getSnapshot().complete, false);
  assert.equal(store.statusOf('account-a'), 'unsaved');
  store.dispose();
});

test('a successful cancel survives a partial multi-page refresh with a stale page', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page([]));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  store.registerSavedRecords(['account-a', 'account-b']);
  transport.writes.push(undefined);
  await store.toggle('account-a', false);
  assert.equal(store.statusOf('account-a'), 'unsaved');
  assert.equal(store.statusOf('account-b'), 'saved');
  // First reload page still lists the canceled account (stale), second page fails.
  transport.pages.push(page(['account-a'], 'cursor-1'), new Error('network'));
  await store.reloadFavorites();
  assert.equal(store.getSnapshot().complete, false);
  assert.equal(store.statusOf('account-a'), 'unsaved');
  assert.equal(store.statusOf('account-b'), 'saved');
  store.dispose();
});

test('a later complete refresh confirms the cancel and drops panel evidence', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page([]));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  store.registerSavedRecords(['account-a', 'account-b']);
  transport.writes.push(undefined);
  await store.toggle('account-a', false);
  transport.pages.push(new Error('network'));
  await store.reloadFavorites();
  assert.equal(store.statusOf('account-a'), 'unsaved');
  // Authoritative complete read: server truth replaces both the cancel override and basis.
  transport.pages.push(page([]));
  await store.reloadFavorites();
  assert.equal(store.getSnapshot().complete, true);
  assert.equal(store.statusOf('account-a'), 'unsaved');
  assert.equal(store.statusOf('account-b'), 'unsaved');
  store.dispose();
});

test('a stale reload cannot overwrite a newer reload result', async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: 'user-a' });
  transport.pages.push(page([]));
  const store = new FavoritesStore(transport);
  await store.confirmIdentity();
  const held = deferred();
  transport.pages.push(held.promise, page([]));
  const staleReload = store.reloadFavorites();
  await flush();
  await store.reloadFavorites();
  assert.equal(store.statusOf('account-late'), 'unsaved');
  held.resolve(page(['account-late']));
  await staleReload;
  assert.equal(store.getSnapshot().saved.has('account-late'), false);
  assert.equal(store.statusOf('account-late'), 'unsaved');
  store.dispose();
});


test("shared identity pause hides state and preserves same-user pending mutation", async () => {
  let finishWrite;
  const write = new Promise(resolve => { finishWrite = resolve; });
  const store = new FavoritesStore({
    session: async () => { throw new Error("must use shared identity"); },
    favoritesPage: async () => ({accountIds: [], nextCursor: null}),
    setFavorite: async () => write,
  });
  await store.confirmIdentity({userId:"shared-a"});
  const pending = store.toggle("account-x", true);
  store.suspendIdentity("loading");
  assert.equal(store.getSnapshot().saved.size, 0);
  store.suspendIdentity("error");
  await store.confirmIdentity({userId:"shared-a"});
  finishWrite(); await pending;
  assert.equal(store.statusOf("account-x"), "saved");
  store.suspendIdentity("loading");
  await store.confirmIdentity({userId:"shared-b"});
  assert.equal(store.statusOf("account-x"), "unsaved");
});
