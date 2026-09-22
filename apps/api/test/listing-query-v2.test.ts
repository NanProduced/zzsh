import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { parseListingQueryV2,parseListingFilters,parseFilterConfig,parseServiceWindow,LISTING_OPERATORS } from "../src/supply/listing-filter-contract";
import { encodeListingCursor,decodeListingCursor,type ListingCursorBinding } from "../src/supply/listing-cursor";
import { buildListingCandidates } from "../src/supply/listing-candidates";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import { validateListingQuery } from "../src/supply/listing-filter-config";

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
