import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePopulationMode, selectSourceScenarios, summarizePopulationScope } from "./local-source-scenarios.mjs";
import { parseSourceCaptureLine, sourceJsonLine, readLfLines, readSourceRows, readBoundSourceRows, readVerifiedSourceRows, verifyDisplayCaptureInputs, sourceAccountPlan, assertCapturedSourceOrigin, assertDisplayCaptureCoverage, assertDisplayCaptureRow, assertLegacyIdentityColumns, assertLegacyListedPricingColumns, assertLegacySkinDictionaryColumns, inspectLegacyListedPricingCapture, inspectLegacySkinDictionaryCapture, planLegacyIdentitySource, matchesLegacyIdentitySource } from "./local-source-adapter.mjs";
import { deriveAdditionalSkinAmbiguities, hasNonExactSkinSourceToken, useDynamicSkinDictionaryRules } from "./local-target-holdings.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";

test('new source captures bind the restored server and pre/post read-only proof without changing old receipts',()=>{
  const sha='a'.repeat(64),uuid='12345678-1234-1234-1234-123456789abc',id='b'.repeat(64);
  const binding={schema:'zzsh.local-source-origin.v2',container:{id},source:{database:'sg_zzsh_restore',serverUuid:uuid,network:'none',readOnly:true,superReadOnly:true,eventScheduler:'DISABLED'},restoreRecord:{dumpSha256:sha,consumedSha256:sha,importClientExitCode:0,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'}};
  const receipt={schema:'zzsh.legacy-source-capture.v1',status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,client:{code:0},clientStderrPresent:false,containerId:id,database:'sg_zzsh_restore',sourceOrigin:{schema:binding.schema,bindingSha256:sha,serverUuid:uuid,verifiedAfterCapture:true,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'},
    identity:{database:'sg_zzsh_restore',principal:'root@localhost',readOnly:1,isolation:'REPEATABLE-READ',accessMode:'READ ONLY',txState:'ACTIVE',serverUuid:uuid,globalReadOnly:1,superReadOnly:1,eventScheduler:'DISABLED'}};
  assert.doesNotThrow(()=>assertCapturedSourceOrigin(receipt,binding,sha));assert.doesNotThrow(()=>assertCapturedSourceOrigin({}, {schema:'zzsh.local-source-origin.v1'},sha));
  for(const change of [{sourceOrigin:{...receipt.sourceOrigin,verifiedAfterCapture:false}},{identity:{...receipt.identity,superReadOnly:0}},
    {sourceOrigin:{...receipt.sourceOrigin,bindingSha256:'0'.repeat(64)}},{containerId:'c'.repeat(64)}])
    assert.throws(()=>assertCapturedSourceOrigin({...receipt,...change},binding,sha),/SOURCE_ORIGIN_BINDING_MISMATCH/);
  assert.throws(()=>assertCapturedSourceOrigin(receipt,{schema:'zzsh.local-source-origin.v1'},sha),/SOURCE_ORIGIN_BINDING_MISMATCH/);
});
test('fresh display coverage preserves unknowns and distinguishes omitted facts from false or zero',()=>{
  const scope='ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',display={rows:3,accountBaseRatio:{scope,known:2,unknown:1},accountFullPayout:{scope,selected:1,unselected:1,unknown:1}};
  assert.doesNotThrow(()=>assertDisplayCaptureCoverage(display));
  for(const invalid of [{...display,accountBaseRatio:undefined},{...display,accountFullPayout:undefined},{...display,accountBaseRatio:{scope,known:3,unknown:1}},
    {...display,accountFullPayout:{scope,selected:1,unselected:1,unknown:-1}}])assert.throws(()=>assertDisplayCaptureCoverage(invalid),/DISPLAY_CAPTURE_COVERAGE_REQUIRED/);
  assert.doesNotThrow(()=>assertDisplayCaptureRow({sourceAccountBaseRatioWanPerYuan:null,sourceAccountFullPayoutSelected:false}));
  assert.doesNotThrow(()=>assertDisplayCaptureRow({sourceAccountBaseRatioWanPerYuan:'42',sourceAccountFullPayoutSelected:null}));
  for(const row of [{},{sourceAccountBaseRatioWanPerYuan:null},{sourceAccountBaseRatioWanPerYuan:0,sourceAccountFullPayoutSelected:false},
    {sourceAccountBaseRatioWanPerYuan:null,sourceAccountFullPayoutSelected:0}])assert.throws(()=>assertDisplayCaptureRow(row),/DISPLAY_CAPTURE_FACTS_REQUIRED/);
});
test('display preflight compares every captured ratio and payout with source before target access',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'display-source-proof-')),files=['source.jsonl','accounts.jsonl','display.jsonl'].map(name=>join(dir,name));
  const sha=value=>createHash('sha256').update(value).digest('hex'),canonical=JSON.stringify,scope='ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT';
  const source=[{id:'1',status:'3',is_delete:'0',base_bot:'42',is_full_payout:'0'},{id:'2',status:'3',is_delete:'0',base_bot:null,is_full_payout:null},{id:'3',status:'1',is_delete:'0',base_bot:'50',is_full_payout:'1'}];
  const accounts=source.map((row,i)=>({sourceId:row.id,sourceDigest:sha(canonical(row)),sourceStatus:i===2?'1':'3',sourceDeleted:false,
    snapshot:i===2?null:{schema:'fixture'},sourceUpdatedAt:'2026-01-01T00:00:00.000Z'}));
  const rows=[{sourceId:'1',baseSourceDigest:accounts[0].sourceDigest,sourceUpdatedAt:accounts[0].sourceUpdatedAt,snapshot:{sourceAccountBaseRatioWanPerYuan:'42',sourceAccountFullPayoutSelected:false,issues:[]}},
    {sourceId:'2',baseSourceDigest:accounts[1].sourceDigest,sourceUpdatedAt:accounts[1].sourceUpdatedAt,snapshot:{sourceAccountBaseRatioWanPerYuan:null,sourceAccountFullPayoutSelected:null,issues:['base_bot:MISSING','is_full_payout:UNKNOWN']}}];
  const write=(index,values)=>{const bytes=Buffer.from(values.map(row=>JSON.stringify(row)).join('\n')+'\n');writeFileSync(files[index],bytes);return {file:['source.jsonl','accounts.jsonl','display.jsonl'][index],sha256:sha(bytes),rows:values.length}};
  try{
    const sourceEntry={...write(0,source),fields:['base_bot','is_full_payout']},accountsEntry=write(1,accounts),entry=write(2,rows);
    const display={...entry,notDisplayable:1,accountBaseRatio:{scope,known:1,unknown:1},accountFullPayout:{scope,selected:0,unselected:1,unknown:1}};
    const input={sourceDir:dir,sourceEntry,accountsDir:dir,accountsEntry,displayDir:dir,display,canonicalize:canonical};
    assert.equal((await verifyDisplayCaptureInputs(input)).status,'SOURCE_DISPLAY_CAPTURE_VERIFIED_TARGET_NOT_RUN');
    rows[0].snapshot.sourceAccountBaseRatioWanPerYuan='41';Object.assign(display,write(2,rows));
    await assert.rejects(verifyDisplayCaptureInputs(input),/DISPLAY_CAPTURE_SOURCE_MISMATCH/);
    rows[0].snapshot.sourceAccountBaseRatioWanPerYuan='42';delete rows[0].snapshot.sourceAccountFullPayoutSelected;Object.assign(display,write(2,rows));
    await assert.rejects(verifyDisplayCaptureInputs(input),/DISPLAY_CAPTURE_FACTS_REQUIRED/);
  }finally{for(const file of files)unlinkSync(file);rmdirSync(dir)}
});

test("verified row stream hashes consumed bytes and refuses a changed file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "verified-source-")), file = join(directory, "rows.jsonl");
  const records = [{ id: "1", note: "line\u2028separator" }, { id: "2" }], bytes = Buffer.from(records.map(JSON.stringify).join("\n") + "\n");
  const entry = { rows: 2, sha256: createHash("sha256").update(bytes).digest("hex") };
  try {
    writeFileSync(file, bytes); const seen = [];
    assert.equal(await readVerifiedSourceRows(file, entry, row => seen.push(row)), 2); assert.deepEqual(seen, records);
    await assert.rejects(readVerifiedSourceRows(file, { ...entry, sha256: "0".repeat(64) }, () => {}), /SOURCE_STREAM_CHANGED/);
    await assert.rejects(readVerifiedSourceRows(file, { ...entry, rows: 1 }, () => {}), /SOURCE_STREAM_CHANGED/);
    await assert.rejects(readVerifiedSourceRows(file, entry, row => { if (row.id === "1") writeFileSync(file, Buffer.concat([bytes, Buffer.from("\n")])); }), /SOURCE_STREAM_CHANGED(?:_AFTER_READ)?/);
    writeFileSync(file, bytes); let accepted = false;
    await assert.rejects((async () => {
      for await (const row of readBoundSourceRows(file, entry)) if (row.id === "1") writeFileSync(file, Buffer.concat([bytes, Buffer.from("\n")]));
      accepted = true;
    })(), /SOURCE_STREAM_CHANGED(?:_AFTER_READ)?/);
    assert.equal(accepted, false);
  } finally { unlinkSync(file); rmdirSync(directory); }
});

test("full source captures skin columns and dictionaries in one snapshot", () => {
  const accounts=["id","knife_skin","agent_skin","weapon_skin","gold_skin"],types=["id","dict_type"],data=["id","type_id","name","value","is_delete"];
  assert.doesNotThrow(()=>assertLegacySkinDictionaryColumns(new Set(accounts),new Set(types),new Set(data)));
  for(const field of accounts) assert.throws(()=>assertLegacySkinDictionaryColumns(new Set(accounts.filter(x=>x!==field)),new Set(types),new Set(data)),/SOURCE_SKIN_DICTIONARY_COLUMN_MISSING/);
  for(const field of types) assert.throws(()=>assertLegacySkinDictionaryColumns(new Set(accounts),new Set(types.filter(x=>x!==field)),new Set(data)),/SOURCE_SKIN_DICTIONARY_COLUMN_MISSING/);
  for(const field of data) assert.throws(()=>assertLegacySkinDictionaryColumns(new Set(accounts),new Set(types),new Set(data.filter(x=>x!==field))),/SOURCE_SKIN_DICTIONARY_COLUMN_MISSING/);
  const receipt={status:"CAPTURED_READ_ONLY",rollbackConfirmed:true,clientClosed:true,
    skinDictionaryCapture:{schema:"zzsh.legacy-skin-dictionary-capture.v1",accounts:"accountDisplay",types:"skinDictionaryTypes",data:"skinDictionaryData",sameSnapshot:true},
    files:{accountDisplay:{fields:accounts},skinDictionaryTypes:{fields:types},skinDictionaryData:{fields:data}}};
  assert.equal(inspectLegacySkinDictionaryCapture(receipt).status,"SAME_SNAPSHOT_DYNAMIC_RULES");
  assert.equal(inspectLegacySkinDictionaryCapture({}).status,"LEGACY_FIXED_RULES");
  const manifest={sourceReceiptSha256:"a".repeat(64),skinDictionaryEvidence:{status:"SAME_SNAPSHOT_DYNAMIC_RULES"}};
  assert.equal(useDynamicSkinDictionaryRules(manifest,receipt,receipt,manifest.sourceReceiptSha256,manifest.sourceReceiptSha256),true);
  assert.equal(useDynamicSkinDictionaryRules({}, {}, {}, "old", "old"),false);
  assert.throws(()=>useDynamicSkinDictionaryRules({...manifest,skinDictionaryEvidence:undefined},receipt,receipt,manifest.sourceReceiptSha256,manifest.sourceReceiptSha256),/HOLDINGS_DYNAMIC_SOURCE_PROOF_MISSING/);
  assert.throws(()=>useDynamicSkinDictionaryRules(manifest,receipt,receipt,manifest.sourceReceiptSha256,"other"),/HOLDINGS_DYNAMIC_SOURCE_NOT_SAME_CAPTURE/);
  assert.throws(()=>useDynamicSkinDictionaryRules(manifest,receipt,{},manifest.sourceReceiptSha256,manifest.sourceReceiptSha256),/HOLDINGS_DYNAMIC_SOURCE_NOT_SAME_CAPTURE/);
  assert.throws(()=>inspectLegacySkinDictionaryCapture({...receipt,skinDictionaryCapture:{...receipt.skinDictionaryCapture,sameSnapshot:false}}),/SOURCE_SKIN_DICTIONARY_PROOF_INVALID/);
  const script=new URL("./capture-local-source.mjs",import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,"$1");
  const full=spawnSync(process.execPath,[script,"--plan"],{encoding:"utf8",timeout:5000});assert.equal(full.status,0);assert.equal(JSON.parse(full.stdout).skinDictionaryCapture.sameSnapshot,true);
  const supplement=spawnSync(process.execPath,[script,"--skin-dictionary-only","--plan"],{encoding:"utf8",timeout:5000});assert.equal(supplement.status,0);assert.equal(JSON.parse(supplement.stdout).skinDictionaryCapture,undefined);
});

test("new duplicate skin source tokens remain unresolved even when the target catalog contains a matching name", () => {
  const fields=["knife_skin","agent_skin","weapon_skin","gold_skin"],types=new Map([["1",{dict_type:"weapon_skin"}],["2",{dict_type:"agent_skin"}]]);
  const dictionary=[{id:"11",type_id:"1",name:"共同皮肤",value:"共同皮肤",is_delete:"0"},{id:"12",type_id:"2",name:"共同皮肤",value:"共同皮肤",is_delete:"1"},
    {id:"13",type_id:"1",name:"显示名",value:"原值",is_delete:"0"}];
  const dynamic=deriveAdditionalSkinAmbiguities(dictionary,types,[],fields);
  assert.deepEqual(dynamic.additionalRules.map(x=>x.field),["agent_skin","weapon_skin"]);
  assert.ok(dynamic.nonExactTokens.has("weapon_skin\0显示名"));assert.ok(dynamic.nonExactTokens.has("weapon_skin\0原值"));
  assert.equal(deriveAdditionalSkinAmbiguities(dictionary,types,[{field:"weapon_skin",token:"共同皮肤"}],fields).additionalRules.length,1);
  const require=createRequire(import.meta.url),skin=require(new URL("../../apps/api/dist/src/legacy-load/legacy-skin-holdings.js",import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,"$1"));
  assert.equal(hasNonExactSkinSourceToken({weapon_skin:"显示名",agent_skin:null,knife_skin:null,gold_skin:null},fields,skin.splitLegacySkinColumn,dynamic.nonExactTokens),true);
  assert.equal(hasNonExactSkinSourceToken({weapon_skin:"其他",agent_skin:null,knife_skin:null,gold_skin:null},fields,skin.splitLegacySkinColumn,dynamic.nonExactTokens),false);
  const catalog=[{skinId:"skin_1",gameId:"game_1",sourceField:"weapon_skin",sourceToken:"共同皮肤",namingState:"VERIFIED",enabled:true,formVisible:true}];
  const holding=skin.mapLegacySkinHolding({accountKey:"1",gameId:"game_1",columns:{knife_skin:null,agent_skin:null,weapon_skin:"共同皮肤",gold_skin:null}},skin.buildLegacySkinIndex(catalog,dynamic.additionalRules),"1");
  assert.equal(holding.complete,false);assert.equal(holding.unresolved[0].reason,"SOURCE_AMBIGUOUS");assert.deepEqual(holding.mappedSkinIds,[]);
  assert.throws(()=>deriveAdditionalSkinAmbiguities([...dictionary,{...dictionary[0]}],types,[],fields),/SKIN_DYNAMIC_DICTIONARY_DUPLICATE/);
  assert.throws(()=>deriveAdditionalSkinAmbiguities([dictionary[0],{...dictionary[1],type_id:"999"}],types,[],fields),/SKIN_DYNAMIC_DICTIONARY_INVALID/);
});

test("new source capture includes both listing spreads in the same MySQL snapshot", () => {
  const game = new Set(["id", "profit_dot"]), config = new Set(["id", "type", "name", "value"]);
  assert.doesNotThrow(() => assertLegacyListedPricingColumns(game, config));
  assert.throws(() => assertLegacyListedPricingColumns(new Set(["id"]), config), /SOURCE_LISTED_PRICING_COLUMN_MISSING:la_sg_game\.profit_dot/);
  for (const missing of config) assert.throws(() => assertLegacyListedPricingColumns(game, new Set([...config].filter(x => x !== missing))), /SOURCE_LISTED_PRICING_COLUMN_MISSING:la_system_config/);
  const capture = new URL("./capture-local-source.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const result = spawnSync(process.execPath, [capture, "--plan"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.ok(plan.fieldsByDomain.games.includes("profit_dot"));
  assert.match(plan.filtersByDomain.tradePolicy, /type='game' AND name='profitFirstDot'/);
  assert.equal(plan.listedPricingCapture.runtimeRedis, "NOT_CAPTURED");
  assert.equal(plan.dbConnections, 0);
});

test("captured listing pricing inputs require unique valid facts and never claim Redis or target verification", () => {
  const receipt = { status: "CAPTURED_READ_ONLY", rollbackConfirmed: true, clientClosed: true,
    listedPricingCapture: { schema: "zzsh.legacy-listed-pricing-capture.v1", gameDomain: "games", gameProfitField: "profit_dot", fastConfigDomain: "tradePolicy", fastConfigType: "game", fastConfigName: "profitFirstDot", runtimeRedis: "NOT_CAPTURED" },
    files: { games: { fields: ["id", "profit_dot"] }, tradePolicy: { fields: ["id", "type", "name", "value"] } } };
  const games = [{ id: "1", is_delete: "0", profit_dot: "6" }], settings = [{ type: "game", name: "profitFirstDot", value: "12" }], calls = [];
  const parser = (value, allowZero) => { calls.push([value, allowZero]); if (value === "bad") throw Error("invalid"); return BigInt(value); };
  assert.deepEqual(inspectLegacyListedPricingCapture(receipt, games, settings, parser), { status: "MYSQL_CAPTURE_VALUES_VALIDATED", gameRows: 1, fastConfigRows: 1, runtimeRedis: "NOT_CAPTURED", target: "NOT_VERIFIED" });
  assert.deepEqual(calls, [["6", true], ["12", true]]);
  assert.deepEqual(inspectLegacyListedPricingCapture({}, [], [], undefined), { status: "NOT_CAPTURED_IN_BASE" });
  for (const [g, s, code] of [[[], settings, "VALUES_NOT_UNIQUE"], [[...games, games[0]], settings, "VALUES_NOT_UNIQUE"], [games, [], "VALUES_NOT_UNIQUE"], [games, [...settings, settings[0]], "VALUES_NOT_UNIQUE"], [[{ ...games[0], profit_dot: "bad" }], settings, "VALUES_INVALID"]])
    assert.throws(() => inspectLegacyListedPricingCapture(receipt, g, s, parser), new RegExp(code));
  assert.throws(() => inspectLegacyListedPricingCapture({ ...receipt, rollbackConfirmed: false }, games, settings, parser), /PROOF_INVALID/);
  assert.throws(() => inspectLegacyListedPricingCapture({ ...receipt, listedPricingCapture: { ...receipt.listedPricingCapture, runtimeRedis: "CAPTURED" } }, games, settings, parser), /PROOF_INVALID/);
  assert.throws(() => inspectLegacyListedPricingCapture({ ...receipt, files: { ...receipt.files, games: { fields: null } } }, games, settings, parser), /PROOF_INVALID/);
});

test("legacy identity capture requires all source columns before extraction", () => {
  const fields = ["id", "is_bind_id", "real_name", "id_card"];
  assert.doesNotThrow(() => assertLegacyIdentityColumns(new Set(fields)));
  for (const missing of fields) {
    assert.throws(() => assertLegacyIdentityColumns(new Set(fields.filter(field => field !== missing))),
      { message: "SOURCE_IDENTITY_COLUMN_MISSING:" + missing });
  }
  const result = spawnSync(process.execPath, [new URL("./capture-local-source.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--plan"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  for (const field of fields) assert.ok(plan.fieldsByDomain.users.includes(field));
  assert.equal(plan.dbConnections, 0);
});

test("legacy identity preparation preserves verified source details and refuses incomplete facts", () => {
  const require = createRequire(import.meta.url), path = name => new URL(`../../apps/api/dist/src/auth/${name}.js`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const modules = { identity: require(path("identity-subject")), identityProfile: require(path("legacy-identity-profile")) };
  const raw = { real_name: "合成姓名", id_card: "99000019900101123x" };
  const ready = planLegacyIdentitySource(raw, true, modules);
  assert.equal(ready.state, "READY");
  assert.equal(ready.trustedIdentityNumber, "99000019900101123X");
  assert.deepEqual(ready.legacyIdentityProfile, { realName: raw.real_name, idCardNo: raw.id_card });
  assert.deepEqual(planLegacyIdentitySource(raw, false, modules), { state: "NOT_VERIFIED", trustedIdentityNumber: null, legacyIdentityProfile: null });
  for (const invalid of [{ ...raw, real_name: "" }, { ...raw, id_card: null }, { ...raw, id_card: "?" }]) {
    assert.deepEqual(planLegacyIdentitySource(invalid, true, modules), { state: "INVALID", trustedIdentityNumber: null, legacyIdentityProfile: null });
  }
});

test("identity readback compares the original source rather than trusting the prepared target input", () => {
  const source = { id: "12", is_bind_id: "1", real_name: "合成姓名", id_card: "99000019900101123X" };
  const row = { sourceId: "12", input: { evidence: { status: { realNameBound: true } } },
    legacyIdentityProfile: { realName: source.real_name, idCardNo: source.id_card } };
  assert.equal(matchesLegacyIdentitySource(source, row), true);
  for (const changed of [{ ...source, id: "13" }, { ...source, is_bind_id: "0" },
    { ...source, real_name: "其他合成姓名" }, { ...source, id_card: "99000019900101124X" }]) {
    assert.equal(matchesLegacyIdentitySource(changed, row), false);
  }
  const unverified = { sourceId: "12", input: { evidence: { status: { realNameBound: false } } }, legacyIdentityProfile: null };
  assert.equal(matchesLegacyIdentitySource({ ...source, is_bind_id: "0" }, unverified), true);
  assert.equal(matchesLegacyIdentitySource({ ...source, is_bind_id: "0" }, { ...unverified, legacyIdentityProfile: row.legacyIdentityProfile }), false);
});

test("hex capture framing retains multiline and control text as one valid JSONL record", () => {
  const raw = { id: "1", description: "原文\r\n二行\u2028三行\u0000", nullable: null, flag: "0", amount: "0001.2300" };
  const hex = Buffer.from(JSON.stringify(raw)).toString("hex").toUpperCase();
  const row = parseSourceCaptureLine(hex), stored = sourceJsonLine(row);
  assert.deepEqual(row, raw); assert.equal(stored.split("\n").length, 2); assert.deepEqual(JSON.parse(stored), raw);
  assert.deepEqual(parseSourceCaptureLine('{"_phase":"rollback-complete"}'), { _phase: "rollback-complete" });
  assert.throws(() => parseSourceCaptureLine("NOT_JSON"));
});
test("source JSONL reader uses LF and retains Unicode separators across read boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zzsh-source-lines-"));
  try {
    const file = join(dir, "source.jsonl"), rows = [{ id: "1", text: "A".repeat(65520) + "\u2028中文\u2029" }, { id: "2", nullable: null }];
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const actual = []; for await (const row of readSourceRows(file)) actual.push(row);
    assert.deepEqual(actual, rows); assert.equal(sourceJsonLine(rows[0]).includes("\u2028"), false);
    writeFileSync(file, JSON.stringify(rows[0]) + "\r\n\r\n" + JSON.stringify(rows[1]));
    const crlf = []; for await (const row of readSourceRows(file)) crlf.push(row);
    assert.deepEqual(crlf, rows);
  } finally { assert.equal(dirname(dir), tmpdir()); assert.ok(dir.split(/[\\/]/).at(-1).startsWith("zzsh-source-lines-")); rmSync(dir, { recursive: true }); }
});
test("LF records preserve raw bytes and split multibyte characters", async () => {
  const bytes=Buffer.from("甲\u2028乙\r\n丙\u2029丁"),seen=createHash("sha256"),lines=[];
  const chunks=Array.from(bytes,(_,index)=>bytes.subarray(index,index+1));
  for await(const line of readLfLines(Readable.from(chunks),chunk=>seen.update(chunk))) lines.push(line);
  assert.deepEqual(lines,["甲\u2028乙\r","丙\u2029丁"]);
  assert.equal(seen.digest("hex"),createHash("sha256").update(bytes).digest("hex"));
});

const user = (id, extra = {}) => ({ id, inviter_id: "0", first_leader: "0", second_leader: "0", third_leader: "0", money: "0.00", earnings: "0.00", is_delete: "0", is_disable: "0", mobile: "present", ...extra });
const account = (id, user_id, extra = {}) => ({ id, user_id, status: "0", is_delete: "0", no: "old", title: "", is_demulan: "0", is_next_season_pass: null, ...extra });
test('population scope requires one explicit choice and covers every captured row without enabling it', () => {
  assert.equal(resolvePopulationMode(['--prepare','--full-source']),'FULL_CAPTURED_SOURCE');
  assert.equal(resolvePopulationMode(['--prepare','--scenario-selection']),'SCENARIO_SELECTION');
  for(const args of [[],['--full-source','--scenario-selection'],['--full-source','--full-source']])
    assert.throws(()=>resolvePopulationMode(args),/EXACTLY_ONE_POPULATION_MODE_REQUIRED/);
  const data={users:[user('1'),user('2',{is_delete:'1'}),user('3',{is_disable:'1'})],accounts:[account('10','2')],orders:[]};
  const full=summarizePopulationScope(data,'FULL_CAPTURED_SOURCE',null,'a'.repeat(64));
  assert.equal(full.meaning,'CAPTURED_DOMAINS_ONLY_NOT_ALL_LEGACY_TABLES');assert.equal(full.consideredMeans,'INPUT_LOADED_NOT_CONVERTED_OR_IMPORTED');
  assert.equal(full.sourceStatusPolicy,'PRESERVE_SOURCE_FLAGS_VERIFY_SEPARATELY');assert.equal(full.targetStatus,'NOT_VERIFIED');assert.equal(full.domains.users.captured,3);assert.equal(full.domains.users.considered,3);
  assert.equal(full.domains.users.capturedIdsSha256,full.domains.users.consideredIdsSha256);assert.equal(full.domains.accounts.considered,1);
  const selected={includes:(domain,row)=>domain!=='users'||row.id==='1'};
  const partial=summarizePopulationScope(data,'SCENARIO_SELECTION',selected,'a'.repeat(64));
  assert.equal(partial.domains.users.considered,1);assert.equal(partial.domains.users.excluded,2);
  assert.notEqual(partial.domains.users.capturedIdsSha256,partial.domains.users.consideredIdsSha256);
  assert.throws(()=>summarizePopulationScope({...data,users:[user('1'),user('1')]},'FULL_CAPTURED_SOURCE',null,'a'.repeat(64)),/POPULATION_SOURCE_KEY_INVALID/);
  assert.throws(()=>summarizePopulationScope(data,'FULL_CAPTURED_SOURCE',selected,'a'.repeat(64)),/POPULATION_SCOPE_INPUT_INVALID/);
});
test("selection closes independent funds, ancestors and owner history without expanding unrelated descendants", () => {
  const data = {
    users: [user("1", { first_leader: "3" }), user("2"), user("3"), user("4", { inviter_id: "3", earnings: "10.00" }), user("5", { earnings: "99.00" }), user("6"), user("7"), user("8"), user("9", { inviter_id: "3" })],
    accounts: [account("10", "1"), account("11", "1", { status: "3" }), account("12", "3"), account("13", "4", { status: "3", ratio_type: "fast" }), account("14", "4", { status: "6" }), account("15", "5", { status: "3", is_delete: "1" }), account("16", "7", { status: "5" }), account("17", "8", { pay_money: "5.00" })],
    orders: [{ id: "20", user_id: "2", sale_user_id: "1", accounts_id: "10" }],
    withdraws: [{ id: "30", user_id: "1" }, { id: "31", user_id: "5" }],
    earnings: [{ id: "40", user_id: "1" }, { id: "41", user_id: "1" }, { id: "42", user_id: "5" }],
    distributionOrders: [{ id: "50", user_id: "6", order_id: "20", order_type: "1", status: "2", is_delete: "0" }],
    pays: [{ id: "60", order_id: "20", order_type: "1" }, { id: "61", order_id: "16", order_type: "2", pay_is: "0" }, { id: "62", order_id: "11", order_type: "2" }],
  };
  const plan = selectSourceScenarios(data);
  assert.deepEqual([...plan.selected.users].sort(), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.deepEqual([...plan.selected.accounts].sort(), ["10", "11", "12", "13", "14", "15", "16", "17"]);
  assert.equal(plan.summary.coreOrderUsers, 2); assert.equal(plan.summary.necessaryRelatedUsers, 6);
  assert.deepEqual(plan.summary.domains.earnings, { source: 3, selected: 3, excluded: 0 });
  assert.equal(plan.summary.domains.pays.selected, 3); assert.equal(plan.includes("pays", data.pays[1]), true); assert.equal(plan.summary.scenes["untraded-listed"].selected, 2);
  assert.ok(plan.summary.missingScenes.includes("cancelled-user")); assert.equal(plan.missing.length, 0);
  assert.equal(plan.includes("withdraws", data.withdraws[1]), true);
});

test("selection reports missing original references and rejects duplicate IDs without inventing facts", () => {
  const data = { users: [user("1", { first_leader: "9" })], accounts: [account("10", "1")], orders: [{ id: "20", user_id: "8", sale_user_id: "1", accounts_id: "10" }] };
  const plan = selectSourceScenarios(data);
  assert.deepEqual([...plan.selected.users], ["1"]); assert.equal(plan.missing.length, 2);
  assert.ok(plan.missing.some(row => row.sourceId === "8")); assert.ok(plan.missing.some(row => row.sourceId === "9"));
  assert.throws(() => selectSourceScenarios({ ...data, users: [...data.users, data.users[0]] }), /SOURCE_ID_NOT_UNIQUE:users/);
});
test("missing legacy aliases stay null in bindings while source rows and digests preserve original null or empty values", () => {
  const seen = [], modules = { contentHash: { canonicalize: JSON.stringify }, planner: { listingSnapshot: row => { seen.push(row.no); return { snapshot: { resourceNo: null }, sourceUpdatedAt: null, missing: [] }; } } };
  for (const no of [null, ""]) {
    const raw = { id: "1", user_id: "2", game_id: "1", status: "3", is_delete: "0", no };
    const p = sourceAccountPlan(raw, new Map([["2", { userId: "real-owner", sourceDigest: "a".repeat(64) }]]), modules, "real-source", new Map([["1", "delta"]]));
    assert.equal(p.businessNo, null); assert.equal(raw.no, no); assert.equal(p.sourceDigest, createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  }
  assert.deepEqual(seen, [null, ""]);
});
test("funds supplement plan is exactly three domains, keeps source fields, and never extracts the payment URL", () => {
  const result = spawnSync(process.execPath, [new URL("./capture-local-source.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--plan", "--finance-supplement-only"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); const p = JSON.parse(result.stdout);
  assert.deepEqual(p.domains, ["accounts", "earnings", "withdraws"]);
  assert.equal(p.listedPricingCapture, undefined);
  assert.equal(p.dbConnections, 0); assert.equal(p.credentialReads, 0);
  for (const field of ["create_pay_time", "pay_way", "pay_url_present", "pay_url_sha256", "high_risk_owner"]) assert.ok(p.fieldsByDomain.accounts.includes(field));
  assert.equal(p.fieldsByDomain.accounts.includes("pay_url"), false);
  for (const field of ["update_time", "delete_time"]) assert.ok(p.fieldsByDomain.earnings.includes(field));
  for (const field of ["real_name", "account", "money_qr_code", "apply_remark", "pay_desc", "pay_search_result", "audit_remark", "transfer_voucher", "transfer_remark", "bank_card_no", "bank_name", "mobile", "admin_id"]) assert.ok(p.fieldsByDomain.withdraws.includes(field));
  assert.ok(p.required.includes("--base-source")); assert.ok(p.required.includes("--base-sha"));
});
test("refund attempt capture plans all eleven columns and typed record/order bindings without another population", () => {
  const result = spawnSync(process.execPath, [new URL("./capture-local-source.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--plan", "--refund-attempts-only"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); const p = JSON.parse(result.stdout);
  assert.deepEqual(p.domains, ["refunds", "refundLogs", "sourceParentBindings"]);
  assert.deepEqual(p.fieldsByDomain.refundLogs, ["id", "sn", "record_id", "user_id", "handle_id", "order_amount", "refund_amount", "refund_status", "refund_msg", "create_time", "update_time"]);
  for (const field of ["parent_record_id", "parent_source_entity", "parent_order_type", "parent_order_id", "order_source_entity", "resolved_order_id"]) assert.ok(p.fieldsByDomain.sourceParentBindings.includes(field));
  assert.equal(p.dbConnections, 0); assert.equal(p.credentialReads, 0);
});
test("holding cutoff offset and UTC normalize to the same instant accepted by formal admission", () => {
  const require = createRequire(import.meta.url), formal = require(new URL("../../apps/api/dist/src/supply/legacy-observation.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const proof = value => ({ schema: "legacy-skin-holdings-source-v1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", sourceExtractSha256: "a".repeat(64), sourceCutoff: value.endsWith("Z") ? value : new Date(value).toISOString(), targetBindingsSha256: "b".repeat(64), tokenRulesVersion: "offset-representation-proof", tokenRulesExtractSha256: "c".repeat(64), tokenRules: [], gameId: "game_delta", catalogRevision: "2108", rows: [{ legacyId: "1", accountId: "account_one", observationVersionId: "version_one", sourceDigest: "d".repeat(64), sourceUpdatedAtUtc: "2026-11-03T07:45:26.000Z", columns: { knife_skin: null, agent_skin: "", weapon_skin: null, gold_skin: "" } }] });
  const offset = proof("2026-11-03T15:47:05+08:00"), utc = proof("2026-11-03T07:47:05.000Z");
  assert.deepEqual(offset, utc);
  const bytes = JSON.stringify(offset); assert.ok(formal.prepareLegacySkinHoldingsAdmission(bytes, createHash("sha256").update(bytes).digest("hex")));
  const micros = proof("2026-11-03T07:47:05.123456Z"); assert.equal(micros.sourceCutoff, "2026-11-03T07:47:05.123456Z");
  const microBytes = JSON.stringify(micros); assert.ok(formal.prepareLegacySkinHoldingsAdmission(microBytes, createHash("sha256").update(microBytes).digest("hex")));
});
