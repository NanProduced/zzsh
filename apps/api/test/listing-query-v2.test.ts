import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { parseListingQueryV2,parseListingFilters,parseFilterConfig,parseServiceWindow,LISTING_OPERATORS } from "../src/supply/listing-filter-contract";
import { encodeListingCursor,decodeListingCursor,type ListingCursorBinding } from "../src/supply/listing-cursor";
import { buildListingCandidates,PUBLIC_STANDARD_TIER_GUARD } from "../src/supply/listing-candidates";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import { validateListingQuery,validateConfigCatalog,publicFilterMetadata,listingReadMode } from "../src/supply/listing-filter-config";
import { buildMixedListingCandidates,mixedListingBinding,LEGACY_NATIVE_TAKEOVER_GUARD } from "../src/supply/legacy-listing-read";

function skinCandidateQuery(match:"ANY"|"ALL") {
  return parseListingQueryV2(new URLSearchParams({queryVersion:"2",gameId:"game",filters:JSON.stringify({skinGroups:[{categoryId:"agents",ids:["skin-luna"],match}]})}),"/listings");
}

test("skin ANY candidates include the same-version late verified holding before public projection",()=>{
  const query=skinCandidateQuery("ANY");
  for(const sql of [buildListingCandidates(query,null),buildMixedListingCandidates(query,null)]) {
    assert.match(sql.text,/EXISTS\(SELECT 1 FROM \(\s*SELECT unnest\(h\.skin_ids\) AS skin_id FROM zzsh_supply\.legacy_skin_holding h WHERE h\.observation_version_id=v\.id/);
    assert.ok(sql.values.some(value=>Array.isArray(value)&&value.length===1&&value[0]==="skin-luna"));
  }
});

test("skin ALL candidates count the effective skin set rather than observation children only",()=>{
  const query=skinCandidateQuery("ALL");
  for(const sql of [buildListingCandidates(query,null),buildMixedListingCandidates(query,null)]) {
    assert.match(sql.text,/SELECT count\(DISTINCT s\.skin_id\) FROM \(\s*SELECT unnest\(h\.skin_ids\)/);
    assert.match(sql.text,/s\.skin_id=ANY\(\$\d+::text\[\]\)\)=cardinality\(\$\d+::text\[\]\)/);
  }
});

test("an authoritative empty late holding suppresses stale listing_skin matches",()=>{
  for(const match of ["ANY","ALL"] as const) {
    const sql=buildMixedListingCandidates(skinCandidateQuery(match),null);
    // Existence of the holding, including skin_ids={}, prevents the fallback.
    assert.match(sql.text,/SELECT ls\.skin_id FROM zzsh_supply\.listing_skin ls WHERE ls\.version_id=v\.id AND NOT EXISTS \(SELECT 1 FROM zzsh_supply\.legacy_skin_holding h2 WHERE h2\.observation_version_id=v\.id\)/);
    assert.doesNotMatch(sql.text,/cardinality\(h2\.skin_ids\)|array_length\(h2\.skin_ids/);
  }
});

test("native skin candidates retain their own listing_skin fallback and public guards",()=>{
  const sql=buildListingCandidates(skinCandidateQuery("ANY"),null);
  assert.match(sql.text,/FROM zzsh_supply\.listing_skin (ls|s) WHERE \1\.version_id=v\.id/);
  assert.doesNotMatch(sql.text,/h2\.account_id=a\.id/);
  assert.match(sql.text,/JOIN zzsh_supply\.listing_publication pub ON pub\.version_id=v\.id AND pub\.account_id=a\.id/);
  assert.ok(sql.text.includes(PUBLIC_STANDARD_TIER_GUARD));
  assert.match(sql.text,/a\.legacy_hold='NONE'/);
});

test("listing v2 finite parsing, normalization, UTF8 budget and independent legacy boundary",()=>{
  const parse=(extra:Record<string,string|undefined>={})=>{const q=new URLSearchParams({queryVersion:"2",gameId:"delta-id"});for(const [k,v] of Object.entries(extra))if(v!==undefined)q.set(k,v);return parseListingQueryV2(q,"/api/v1/supply/listings?"+q);};
  assert.equal(parse().sort,"latest");assert.equal(parse().direction,"DESC");assert.equal(parse().limit,20);
  assert.deepEqual(parseListingFilters({resources:[],skinGroups:[],safeBoxCodes:[]}),{});
  assert.deepEqual(parseListingFilters({resources:[{itemId:"b",minQuantity:"9007199254740993"},{itemId:"a",minQuantity:"0"}],gradingCodes:["7","3"]}),{resources:[{itemId:"a",minQuantity:"0"},{itemId:"b",minQuantity:"9007199254740993"}],gradingCodes:["3","7"]});
  assert.deepEqual(parseListingFilters({resources:[{itemId:"a",maxQuantity:"0"},{itemId:"b",minQuantity:"9007199254740993",maxQuantity:"9007199254740993"}]}),{resources:[{itemId:"a",maxQuantity:"0"},{itemId:"b",minQuantity:"9007199254740993",maxQuantity:"9007199254740993"}]});
  for(const resource of [{itemId:"a"},{itemId:"a",minQuantity:""},{itemId:"a",minQuantity:null},{itemId:"a",maxQuantity:null},{itemId:"a",minQuantity:"2",maxQuantity:"1"},{itemId:"a",minQuantity:"0",maxQuantity:"1000000000000000000000000"}])assert.throws(()=>parse({filters:JSON.stringify({resources:[resource]})}),(e:any)=>e.status===400&&Boolean(e.details?.[0]?.path));
  for(const filters of [null,{price:{min:1}},{resources:[{itemId:"a",minQuantity:null}]},{resources:[{itemId:"a",minQuantity:"1e2"}]},{resources:[{itemId:"a",minQuantity:"1000000000000000000000000"}]},{resources:[{itemId:"a",minQuantity:"01"}]},{resources:[{itemId:"a",minQuantity:"0",unit:"M"}]},{safeBoxCodes:["a","a"]},{vitality:{min:-1}},{bear:{min:"6"}},{regions:[{province:"a",city:"b"},{province:"a",city:"b"}]},{skinGroups:[{categoryId:"cat",ids:["a","a"],match:"ALL"}]},{skinGroups:Array.from({length:9},(_,i)=>({categoryId:"cat"+i,ids:[],match:"ANY"}))}])assert.throws(()=>parse({filters:JSON.stringify(filters)}),(e:any)=>e.status===400&&Boolean(e.details?.[0]?.path));
  for(const extra of [{filters:"{"},{limit:"0"},{limit:"51"},{limit:"1.5"},{sort:"recommended"},{sort:"coreQuantity"},{coreItemId:"haff"},{itemId:"legacy"},{skinId:"legacy"},{direction:"down"}])assert.throws(()=>parse(extra));
  const duplicate=new URLSearchParams("queryVersion=2&gameId=a&q=one&q=two");assert.throws(()=>parseListingQueryV2(duplicate,"/listings?"+duplicate));
  const raw="x".repeat(8192);assert.doesNotThrow(()=>parseListingQueryV2(new URLSearchParams("queryVersion=2&gameId=a"),raw));assert.throws(()=>parseListingQueryV2(new URLSearchParams("queryVersion=2&gameId=a"),raw+"中"));
  assert.equal(parseServiceWindow({startMinute:0,endMinute:1440,crossMidnight:false,timezone:"Asia/Shanghai"}).endMinute,1440);
  for(const w of [{startMinute:60,endMinute:60,crossMidnight:false},{startMinute:1380,endMinute:60,crossMidnight:false},{startMinute:0,endMinute:1440,crossMidnight:true},{startMinute:1440,endMinute:60,crossMidnight:true}])assert.throws(()=>parseServiceWindow({...w,timezone:"Asia/Shanghai"}));
});
test("listing cursor authenticates exact keys and rejects changed binding without Number coercion",()=>{
  const key={keyId:"listing-only",secret:"listing-cursor-fixture-not-production-secret"};
  const binding:ListingCursorBinding={queryVersion:2,gameId:"game",queryHash:"a".repeat(64),sort:"latest",direction:"DESC",coreItemId:null,filterRevision:"1",catalogRevision:"2",ruleReleaseId:"release"};
  const position={id:"account",key:"2026-09-18T00:00:00.123456Z",isNull:false};const token=encodeListingCursor(position,binding,key);
  assert.deepEqual(decodeListingCursor(token,binding,key),position);
  assert.throws(()=>decodeListingCursor(token,{...binding,filterRevision:"2"},key),(e:any)=>e.status===409);
  const versionBody=JSON.parse(Buffer.from(token.split(".")[0]!,"base64url").toString());versionBody.queryVersion=3;
  const versionEncoded=Buffer.from(JSON.stringify(versionBody)).toString("base64url");
  assert.throws(()=>decodeListingCursor(versionEncoded+"."+createHmac("sha256",key.secret).update(versionEncoded).digest("base64url"),binding,key),(e:any)=>e.status===409);
  for(const cursor of [token+"a",token.replace(/^./,"x"),"x".repeat(4097)])assert.throws(()=>decodeListingCursor(cursor,binding,key),(e:any)=>e.status===400);
  const body=JSON.parse(Buffer.from(token.split(".")[0]!,"base64url").toString());body.extra=true;const encoded=Buffer.from(JSON.stringify(body)).toString("base64url");assert.throws(()=>decodeListingCursor(encoded+"."+createHmac("sha256",key.secret).update(encoded).digest("base64url"),binding,key));
  const numeric={...binding,sort:"coreQuantity",coreItemId:"haff"};assert.equal(decodeListingCursor(encodeListingCursor({id:"a",key:"9007199254740993",isNull:false},numeric,key),numeric,key).key,"9007199254740993");
  assert.throws(()=>encodeListingCursor(position,binding,undefined),(e:any)=>e.status===503);
  const q=parseListingQueryV2(new URLSearchParams("queryVersion=2&gameId=a&sort=coreQuantity&coreItemId=haff&direction=DESC&filters=%7B%22resources%22%3A%5B%7B%22itemId%22%3A%22ammo%22%2C%22minQuantity%22%3A%222%22%2C%22maxQuantity%22%3A%225%22%7D%5D%7D"),"/listings");const sql=buildListingCandidates(q,{id:"a",key:null,isNull:true});assert.match(sql.text,/sort_key IS NULL AND id>/);assert.match(sql.text,/DESC NULLS LAST,id ASC LIMIT 200/);assert.match(sql.text,/l\.quantity>=\$[0-9]+::numeric AND l\.quantity<=\$[0-9]+::numeric/);assert.deepEqual(sql.values.slice(1,4),["ammo","2","5"]);
  const queryHash=(filters:unknown)=>sha256Hex(canonicalize({gameId:"a",q:null,filters,sort:"latest",direction:"DESC",coreItemId:null}));
  assert.notEqual(queryHash({resources:[{itemId:"ammo",minQuantity:"2"}]}),queryHash({resources:[{itemId:"ammo",minQuantity:"2",maxQuantity:"5"}]}));
});
test("resource endpoint bounds are independently checked against the compatible AND_MIN configuration",async()=>{
  const state:any={ruleReleaseId:"release",catalog:{items:[{id:"ammo"}]},config:{sorts:[{key:"latest",enabled:true}],fields:[{key:"resources",enabled:true,items:[{itemId:"ammo",min:"10",max:"100"}]}]}};
  const client:any={};
  const query=(resource:any)=>parseListingQueryV2(new URLSearchParams({queryVersion:"2",gameId:"game",filters:JSON.stringify({resources:[resource]})}),"/listings");
  for(const resource of [{itemId:"ammo",minQuantity:"10"},{itemId:"ammo",maxQuantity:"100"},{itemId:"ammo",minQuantity:"55",maxQuantity:"55"}])await validateListingQuery(client,query(resource),state);
  for(const [resource,path] of [[{itemId:"ammo",minQuantity:"9"},"filters.resources.minQuantity"],[{itemId:"ammo",maxQuantity:"101"},"filters.resources.maxQuantity"]] as const)await assert.rejects(validateListingQuery(client,query(resource),state),(error:any)=>error.status===400&&error.details?.[0]?.path===path);
});
test("filter configuration cannot introduce operators, paths or recommendation formulas",()=>{
  const config={schemaVersion:1,fields:[],sorts:[{key:"latest",label:"最新发布",enabled:true,order:0}]};assert.deepEqual(parseFilterConfig(config),config);
  for(const key of [["resources"],{}, {toString:null,valueOf:null},null,0,true,undefined,"UNKNOWN"])assert.throws(()=>parseFilterConfig({...config,fields:[{key,operator:"AND_MIN",label:"资源",enabled:true,order:0,options:[]}]}),(e:any)=>e.status===400&&e.details?.[0]?.path==="config.fields.key");
  for(const invalid of [{...config,expression:"sql"},{...config,sorts:[{key:"latest",label:"综合推荐",enabled:true,order:0}]},{...config,fields:[{key:"vitality",operator:"SQL",label:"体力",enabled:true,order:0,levels:[6]}]},{...config,fields:[{key:"resources",operator:LISTING_OPERATORS.resources,label:"资源",enabled:true,order:0,items:[{itemId:"a",min:"2",max:"1"}]}]}])assert.throws(()=>parseFilterConfig(invalid));
});
test("listing read mode distinguishes legacy-only, mixed and native from source facts",()=>{
  assert.equal(listingReadMode({ruleReleaseId:null,hasConfig:false,hasSnapshots:false}),"UNCONFIGURED");
  assert.equal(listingReadMode({ruleReleaseId:null,hasConfig:true,hasSnapshots:false}),"LEGACY_READ_ONLY");
  assert.equal(listingReadMode({ruleReleaseId:null,hasConfig:false,hasSnapshots:true}),"LEGACY_READ_ONLY");
  assert.equal(listingReadMode({ruleReleaseId:null,hasConfig:true,hasSnapshots:true}),"LEGACY_READ_ONLY");
  assert.equal(listingReadMode({ruleReleaseId:"release",hasConfig:true,hasSnapshots:false}),"NATIVE");
  assert.equal(listingReadMode({ruleReleaseId:"release",hasConfig:true,hasSnapshots:true}),"MIXED");
  assert.equal(listingReadMode({ruleReleaseId:"release",hasConfig:false,hasSnapshots:true}),"MIXED");
});
test("mixed candidates merge both sources once with native priority and one seek/order/limit",()=>{
  const filters=encodeURIComponent(JSON.stringify({safeBoxCodes:["box-a"]}));
  const q=parseListingQueryV2(new URLSearchParams(`queryVersion=2&gameId=game&sort=latest&direction=DESC&filters=${filters}`),"/listings");
  const sql=buildMixedListingCandidates(q,{id:"acc",key:"2026-09-18T00:00:00.123456Z",isNull:false});
  assert.match(sql.text,/WITH native AS/);assert.match(sql.text,/legacy AS/);assert.match(sql.text,/UNION ALL/);
  assert.match(sql.text,/DISTINCT ON \(id\)/);assert.match(sql.text,/0 AS priority/);assert.match(sql.text,/1 AS priority/);
  assert.match(sql.text,/ORDER BY id,priority/);
  const branches=sql.text.slice(0,sql.text.indexOf("merged AS"));
  // The seek rides inside both branches, so the merged set only ever carries rows
  // past the cursor; the final order/limit still runs once over the merged set.
  // Each branch repeats its own sort expression and a qualified account id: an
  // output alias such as sort_key is not visible in the same SELECT's WHERE, and
  // an unqualified id is ambiguous between the account and its version.
  assert.match(branches,/pub\.published_at < \$[0-9]+::timestamptz OR pub\.published_at IS NULL OR \(pub\.published_at=\$[0-9]+::timestamptz AND a\.id>\$[0-9]+\)/,"the native branch seeks on its own publication timestamp");
  assert.match(branches,/h\.source_updated_at < \$[0-9]+::timestamptz OR h\.source_updated_at IS NULL OR \(h\.source_updated_at=\$[0-9]+::timestamptz AND a\.id>\$[0-9]+\)/,"the legacy branch seeks on its own snapshot timestamp");
  // An empty seek conjunct would leave a dangling AND in a branch WHERE.
  assert.doesNotMatch(sql.text,/\bAND\s*\)/,"no branch WHERE ends in a dangling AND");
  assert.doesNotMatch(branches,/\(sort_key IS NULL AND id>|\(sort_key [<>]|\(sort_key=/,"no branch WHERE names the SELECT output alias or an unqualified id");
  assert.doesNotMatch(sql.text,/candidates AS/);
  assert.match(sql.text,/FROM merged ORDER BY sort_key DESC NULLS LAST,id ASC LIMIT 200/);
  assert.match(sql.text,/v\.payload#>.\{declaration,attributes\}'/);
  assert.match(sql.text,/\(COALESCE\(d\.snapshot->'attributes',v\.attributes\)\)->>'safe_box_code'/);
  assert.match(sql.text,/NOT EXISTS \(SELECT 1 FROM zzsh_supply\.listing_publication p WHERE p\.account_id=a\.id\)/);
  assert.match(sql.text,/v\.review_state='PUBLISHED' AND pub\.source='OWNER_DIRECT'/);
  const noCursor=buildMixedListingCandidates(q,null);
  assert.doesNotMatch(noCursor.text,/\bAND\s*\)/,"no cursor contributes no seek conjunct at all");
  assert.doesNotMatch(noCursor.text.slice(0,noCursor.text.indexOf("merged AS")),/a\.id>/,"no cursor means no seek predicate in either branch");
  const nullKey=buildMixedListingCandidates(q,{id:"acc",key:null,isNull:true});
  assert.equal(nullKey.text.match(/pub\.published_at IS NULL AND a\.id>\$[0-9]+/g)?.length,1,"the native branch carries the null-key seek");
  assert.equal(nullKey.text.match(/h\.source_updated_at IS NULL AND a\.id>\$[0-9]+/g)?.length,1,"the legacy branch carries the null-key seek");
  assert.doesNotMatch(nullKey.text,/\bAND\s*\)/);
  const ascending=buildMixedListingCandidates(parseListingQueryV2(new URLSearchParams(`queryVersion=2&gameId=game&sort=latest&direction=ASC&filters=${filters}`),"/listings"),{id:"acc",key:"2026-09-18T00:00:00.123456Z",isNull:false});
  assert.match(ascending.text,/pub\.published_at > \$[0-9]+::timestamptz/,"ascending flips only the comparison");
  assert.match(ascending.text,/h\.source_updated_at > \$[0-9]+::timestamptz/);
  assert.match(ascending.text,/ORDER BY sort_key ASC NULLS LAST,id ASC LIMIT 200/);
  const priced=parseListingQueryV2(new URLSearchParams("queryVersion=2&gameId=game&sort=resourceTotal"),"/listings");
  const pricedSql=buildMixedListingCandidates(priced,null);
  assert.match(pricedSql.text,/h\.snapshot->>'haffRentYuan'/);assert.match(pricedSql.text,/quoteValues,resourceTotal,amount/);
  assert.doesNotMatch(pricedSql.text,/\bAND\s*\)/);
  const pricedCursor=buildMixedListingCandidates(priced,{id:"acc",key:"100.00",isNull:false});
  const pricedBranches=pricedCursor.text.slice(0,pricedCursor.text.indexOf("merged AS"));
  assert.match(pricedBranches,/\(\(h\.snapshot->>'haffRentYuan'\)::numeric\+\(h\.snapshot->>'goodsYuan'\)::numeric\) < \$[0-9]+::numeric/,"the legacy branch seeks on its own amount expression");
  assert.match(pricedBranches,/a\.id>\$[0-9]+\)\)/,"the legacy branch qualifies the account id in the seek");
  assert.doesNotMatch(pricedCursor.text,/\bAND\s*\)/);
  const core=parseListingQueryV2(new URLSearchParams("queryVersion=2&gameId=game&sort=coreQuantity&coreItemId=haff"),"/listings");
  const coreSql=buildMixedListingCandidates(core,null);
  const refs=[...coreSql.text.matchAll(/l\.item_id=\$(\d+)/g)].map(m=>m[1]);
  assert.equal(refs.length,2,"both sources read the shared core item");assert.equal(refs[0],refs[1],"one core parameter is shared");
  const nativeSql=buildListingCandidates(q,null);
  assert.ok(nativeSql.text.includes(PUBLIC_STANDARD_TIER_GUARD),"native candidates keep the STANDARD tier guard");
  assert.ok(sql.text.includes(PUBLIC_STANDARD_TIER_GUARD),"mixed native branch reuses the same STANDARD tier guard");
  assert.ok(coreSql.text.includes(PUBLIC_STANDARD_TIER_GUARD),"the guard is present regardless of sort");
});
test("mixed read keeps configured historical safe box codes next to priced rule codes",async()=>{
  const config=parseFilterConfig({schemaVersion:1,fields:[{key:"safeBoxCodes",operator:"ANY",label:"安全箱",enabled:true,order:0,options:[{value:"safe_box_1x2",label:"基础安全箱(1*2)"},{value:"safe_box_3x3",label:"顶级安全箱(3*3)"}]},{key:"vitality",operator:"MIN",label:"体力",enabled:true,order:1,levels:[6,7]}],sorts:[{key:"latest",label:"最新发布",enabled:true,order:0}]});
  const catalog={game:{id:"game",code:"delta",catalogRevision:"1",ruleReleaseId:"release",rule:{baseBySafeBox:{safe_box_3x3:"50"}}},items:[],categories:[]};
  const state={catalog,config,legacyReadOnly:false,mixed:true,mode:"MIXED",hasLegacySnapshots:true,allowLegacyOptions:true,filterRevision:"1",catalogRevision:"1",ruleReleaseId:"release"} as unknown as Parameters<typeof publicFilterMetadata>[0];
  const metadata=publicFilterMetadata(state,true) as ReturnType<typeof publicFilterMetadata>;
  assert.deepEqual(metadata.fields.find(f=>f.key==="safeBoxCodes")!.options!.map(o=>o.value).sort(),["safe_box_1x2","safe_box_3x3"],"metadata keeps the configured historical code next to the priced code");
  const query=(codes:string[])=>parseListingQueryV2(new URLSearchParams(`queryVersion=2&gameId=game&filters=${encodeURIComponent(JSON.stringify({safeBoxCodes:codes}))}`),"/listings");
  await validateListingQuery({} as never,query(["safe_box_1x2"]),state);
  await validateListingQuery({} as never,query(["safe_box_3x3","safe_box_1x2"]),state);
  await assert.rejects(validateListingQuery({} as never,query(["safe_box_9x9"]),state),(error:any)=>error.status===400,"unknown codes stay rejected");
  const native={...state,mixed:false,mode:"NATIVE",allowLegacyOptions:false} as typeof state;
  await assert.rejects(validateListingQuery({} as never,query(["safe_box_1x2"]),native),(error:any)=>error.status===400,"native-only reads reject historical codes");
  assert.doesNotThrow(()=>validateConfigCatalog(config,catalog as never,true));
  assert.throws(()=>validateConfigCatalog(config,catalog as never,false),"native-only configuration cannot introduce a historical code");
});
test("mixed cursor binding rejects a cursor issued under native or legacy mode",()=>{
  const key={keyId:"coexist",secret:"coexist-cursor-fixture-not-production-secret"};
  const q=parseListingQueryV2(new URLSearchParams("queryVersion=2&gameId=game&sort=latest"),"/listings");
  const revisions={filterRevision:"3",catalogRevision:"4",ruleReleaseId:"release-1"};
  const mixed=mixedListingBinding(q,revisions);
  const position={id:"account",key:"2026-09-18T00:00:00.123456Z",isNull:false};
  assert.deepEqual(decodeListingCursor(encodeListingCursor(position,mixed,key),mixed,key),position);
  const native={...mixed,queryHash:sha256Hex(canonicalize({gameId:"game",q:null,filters:{},sort:"latest",direction:"DESC",coreItemId:null}))};
  assert.throws(()=>decodeListingCursor(encodeListingCursor(position,native,key),mixed,key),(e:any)=>e.status===409);
  const legacy={...mixed,queryHash:sha256Hex(canonicalize({mode:"LEGACY_READ_ONLY",q:null,filters:{},sort:"latest",direction:"DESC",coreItemId:null})),ruleReleaseId:"legacy-read-only"};
  assert.throws(()=>decodeListingCursor(encodeListingCursor(position,legacy,key),mixed,key),(e:any)=>e.status===409);
  assert.throws(()=>decodeListingCursor(encodeListingCursor(position,mixed,key),{...mixed,ruleReleaseId:"release-2"},key),(e:any)=>e.status===409);
});
