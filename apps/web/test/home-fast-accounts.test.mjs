import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFastAccounts, isHomeFastAccount } from '../src/lib/home-fast-accounts.ts';

const project = listing => ({ id: listing.id, rentalMode: listing.rentalMode, canCreateOrder: listing.canCreateOrder });
const page = (items, nextCursor = null) => ({ items, nextCursor });
const listing = (id, rentalMode = 'ordinary') => ({ id, rentalMode, canCreateOrder: true });

test('the homepage only accepts native fast accounts with current order eligibility', async () => {
  const valid = listing('native-fast', 'fast');
  for (const account of [listing('ordinary'), { ...valid, historicalReadOnly: true }, { ...valid, canCreateOrder: false }, { ...valid, canCreateOrder: undefined }, { ...valid, rentalMode: null }]) {
    assert.equal(isHomeFastAccount(account), false);
  }
  assert.equal(isHomeFastAccount(valid), true);
  const result = await collectFastAccounts(async () => page([valid, { ...listing('not-rentable', 'fast'), canCreateOrder: false }, listing('ordinary')]), project);
  assert.deepEqual(result.accounts.map(account => account.id), ['native-fast']);
  const inferred = await collectFastAccounts(async () => page([{ id: 'missing-server-eligibility', rentalMode: 'fast' }]), value => ({ ...value, canCreateOrder: true }));
  assert.deepEqual(inferred.accounts, [], 'a projection must not invent current server order eligibility');
});

test('home fast shelf follows cursor pages until a fast account is found', async () => {
  const seen = [];
  const result = await collectFastAccounts(async cursor => {
    seen.push(cursor);
    if (cursor === null) return page([listing('ordinary-1')], 'cursor-2');
    if (cursor === 'cursor-2') return page([listing('ordinary-2')], 'cursor-3');
    return page([listing('fast-3', 'fast')]);
  }, project);
  assert.deepEqual(seen, [null, 'cursor-2', 'cursor-3']);
  assert.deepEqual(result.accounts.map(item => item.id), ['fast-3']);
  assert.equal(result.hasMore, false);
});

test('home fast shelf does not claim exhaustion when the bounded read limit is reached', async () => {
  let reads = 0;
  const result = await collectFastAccounts(async cursor => {
    reads += 1;
    return page([listing(`ordinary-${reads}`)], `cursor-${reads + 1}`);
  }, project, 2);
  assert.equal(reads, 2);
  assert.deepEqual(result.accounts, []);
  assert.equal(result.hasMore, true);
});

test('home stops when both shelves are full without reading an unnecessary page', async () => {
  let reads = 0;
  const result = await collectFastAccounts(async () => {
    reads += 1;
    return page(Array.from({ length: 8 }, (_, index) => ({...listing(`shelf-${reads}-${index}`, 'fast'),historicalReadOnly:reads===2})), `next-${reads}`);
  }, value=>value);
  assert.equal(reads, 2);
  assert.equal(result.accounts.length, 8);
  assert.equal(result.historicalAccounts.length, 8);
  assert.equal(result.hasMore, true);
});

test('a full historical shelf does not hide native fast accounts on the next page', async () => {
  const cursors=[];
  const result=await collectFastAccounts(async cursor=>{
    cursors.push(cursor);
    return cursor===null
      ? page(Array.from({length:8},(_,i)=>({id:`history-${i}`,historicalReadOnly:true,rentalMode:null})), 'page-2')
      : page([listing('native-fast','fast')]);
  }, value=>value);
  assert.deepEqual(cursors,[null,'page-2']);
  assert.equal(result.historicalAccounts.length,8);
  assert.deepEqual(result.accounts.map(value=>value.id),['native-fast']);
  assert.equal(result.hasMore,false);
});

test('a full native fast shelf does not hide historical accounts on the next page', async () => {
  const cursors=[];
  const result=await collectFastAccounts(async cursor=>{
    cursors.push(cursor);
    return cursor===null
      ? page(Array.from({length:8},(_,i)=>listing(`fast-${i}`,'fast')), 'page-2')
      : page([{id:'history',historicalReadOnly:true,rentalMode:'fast'}]);
  }, value=>value);
  assert.deepEqual(cursors,[null,'page-2']);
  assert.equal(result.accounts.length,8);
  assert.deepEqual(result.historicalAccounts.map(value=>value.id),['history']);
  assert.equal(result.hasMore,false);
});

test('one full shelf still respects the page budget while the other remains empty', async () => {
  let reads=0;
  const result=await collectFastAccounts(async()=>{
    reads++;
    return page(Array.from({length:8},(_,i)=>listing(`fast-${reads}-${i}`,'fast')), `next-${reads}`);
  },project,3);
  assert.equal(reads,3);
  assert.equal(result.accounts.length,8);
  assert.equal(result.historicalAccounts.length,0);
  assert.equal(result.hasMore,true);
});

test('one server cursor stream supplies read-only history and native fast shelves without a guessed mode or duplicate ids',async()=>{
  const calls=[];
  const projectHistory=l=>({id:l.id,rentalMode:l.rentalMode??null,canCreateOrder:l.canCreateOrder,historicalReadOnly:l.source==='LEGACY_READ_ONLY'});
  const result=await collectFastAccounts(async cursor=>{
    calls.push(cursor);
    if(cursor===null) return page([{id:'legacy-unknown',source:'LEGACY_READ_ONLY'},listing('ordinary'),listing('fast','fast')],'p2');
    return page([{id:'legacy-unknown',source:'LEGACY_READ_ONLY'},{id:'legacy-fast',source:'LEGACY_READ_ONLY',rentalMode:'fast'}]);
  },projectHistory);
  assert.deepEqual(calls,[null,'p2']);
  assert.deepEqual(result.accounts.map(r=>r.id),['fast']);
  assert.deepEqual(result.historicalAccounts.map(r=>r.id),['legacy-unknown','legacy-fast']);
  assert.equal(result.historicalAccounts[0].rentalMode,null);
  assert.equal(result.historicalAccounts[1].rentalMode,'fast');
});

test('home does not claim exhaustion after clipping the last page or seeing a repeated server cursor',async()=>{
  const clipped=await collectFastAccounts(async()=>page(Array.from({length:10},(_,i)=>listing(String(i),'fast'))),project,4,8);
  assert.equal(clipped.accounts.length,8); assert.equal(clipped.hasMore,true);
  const loop=await collectFastAccounts(async()=>page([], 'same'),project);
  assert.equal(loop.pages,2); assert.equal(loop.hasMore,true);
});
