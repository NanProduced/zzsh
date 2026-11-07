import assert from "node:assert/strict";
import test from "node:test";
import { compareLegacyRegions, deriveR07FilterConfig, parseRegionPairsTsv, parseRegionWordList } from "./legacy-region-coverage.mjs";

const list = (pairs) => parseRegionWordList(pairs.map(([province, city]) => `{ "province": "${province}", "city": "${city}" }`).join(","));

test("the word list is read in order and digested, not truncated", () => {
  const wordList = list([["北京市", "东城区"], ["上海市", "浦东新区"], ["重庆市", "渝中区"]]);
  assert.equal(wordList.pairs.length, 3);
  assert.match(wordList.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(wordList.pairs[1], ["上海市", "浦东新区"]);
});

test("a duplicated or empty word-list pair is refused instead of silently collapsing", () => {
  assert.throws(() => list([["北京市", "东城区"], ["北京市", "东城区"]]), /REGION_WORD_LIST_DUPLICATE/);
  assert.throws(() => list([["北京市", ""]]), /REGION_WORD_LIST_EMPTY_VALUE/);
});

test("every source pair is classified as matched, unknown or missing with its account count", () => {
  const wordList = list([["北京市", "东城区"], ["上海市", "浦东新区"]]);
  const result = compareLegacyRegions(wordList, [
    { province: "北京市", city: "东城区", accounts: 10 },
    { province: "上海市", city: "浦东新区", accounts: 5 },
    { province: "某省", city: "某市", accounts: 3 },
    { province: "", city: "", accounts: 2 },
  ]);
  assert.equal(result.matchedPairs, 2);
  assert.equal(result.unknownPairs, 1);
  assert.equal(result.missingPairs, 1);
  assert.equal(result.matchedAccounts, 15);
  assert.equal(result.unknownAccounts, 3);
  assert.equal(result.missingAccounts, 2);
  assert.deepEqual(result.unknown.map(row => row.city), ["某市"]);
  assert.equal(result.sourceAccounts, 20);
});

test("an unknown value is reported, never dropped and never rewritten", () => {
  const wordList = list([["北京市", "东城区"]]);
  const result = compareLegacyRegions(wordList, [{ province: "上海市", city: "浦东新区", accounts: 7 }]);
  assert.equal(result.matchedPairs, 0);
  assert.deepEqual(result.unknown, [{ province: "上海市", city: "浦东新区", accounts: 7 }]);
  assert.equal(result.unknownAccounts, 7);
});

test("the source pair file rejects a non-numeric count instead of reading it as zero", () => {
  assert.throws(() => parseRegionPairsTsv("北京市\t东城区\tten\n"), /REGION_PAIR_COUNT_INVALID/);
  assert.deepEqual(parseRegionPairsTsv("北京市\t东城区\t3\n\n"), [{ province: "北京市", city: "东城区", accounts: 3 }]);
});

test("R07 filter derives all regions and real skin types without mutating other baseline rules",()=>{
  const base={schemaVersion:1,fields:[{key:'resources',operator:'AND_MIN',label:'资源',enabled:true,order:1,items:[]},
    {key:'skinGroups',operator:'GROUPS',label:'皮肤',enabled:true,order:2,categoryIds:['old']}],sorts:[{key:'latest',enabled:true,order:1}]};
  const source=structuredClone(base),words=list([['北京市','东城区'],['上海市','浦东新区']]),derived=deriveR07FilterConfig(base,words);
  assert.deepEqual(base,source);assert.deepEqual(derived.fields.find(x=>x.key==='regions').regions,[{province:'北京市',city:'东城区'},{province:'上海市',city:'浦东新区'}]);
  assert.deepEqual(derived.fields.find(x=>x.key==='skinGroups').ownerKinds,['AGENT','FIREARM','MELEE_TYPE']);
  assert.equal(Object.hasOwn(derived.fields.find(x=>x.key==='skinGroups'),'categoryIds'),false);
  assert.deepEqual(derived.fields[0],base.fields[0]);assert.deepEqual(derived.sorts,base.sorts);
  assert.throws(()=>deriveR07FilterConfig(base,{pairs:Array.from({length:513},(_,i)=>['省',String(i)])}),/FILTER_BASELINE_INVALID/);
});
