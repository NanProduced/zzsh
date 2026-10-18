import type {Pool,PoolClient} from "pg";
import {readFileSync,realpathSync,statSync} from "node:fs";
import {isAbsolute,relative,resolve} from "node:path";
import {createHash} from "node:crypto";
import {withPublicListingSnapshot,readPublishingAccount,readCurrentVersion,readPublicListing,type SupplyGateReader} from "../supply/publishing";
import {SecurityApiError} from "../auth/security-core";
import {PUBLIC_CANDIDATE_FROM,PUBLIC_CANDIDATE_WHERE,PUBLIC_STANDARD_TIER_GUARD} from "../supply/listing-candidates";
import {canonicalize,normalizeTime} from "../supply/content-hash";
import {publicTextPrivacyIssues} from "../legacy-load/legacy-public-admission";
import {sha256Hex} from "../supply/supply-util";
import {legacyMoneyCents} from "./legacy-order-read";
import {centsToYuan} from "./order";

export type PublicActivityCount={value:number;asOf:string;scope:string};
export type PublicActivityDeals={items:Array<{id:string;game:string;title:string;priceLabel:string}>;asOf:string};
/** Read-only inputs from the existing reviewed import manifest/test-cohort inventory, never request JSON or an approval mechanism. */
export type TradeActivityBindings={
 resource:{database:string;oid:number;runtimeRole:string;marker:string};
 testExclusions:{accountIds:readonly string[];nativeOrderIds:readonly string[];legacyIds:readonly string[];evidenceRef:string};
 legacy?:{sourceSystem:"legacy_mysql_restore";sourceEntity:"la_order";sourceAsOf:string;sourceBatchSha256:string;snapshotCount:string;snapshotDigest:string;isolatedCount:string;isolatedSetDigest:string;evidenceRef:string};
};
type CompletedRow={origin:"NATIVE"|"LEGACY";id:string;accountId:string;versionId:string|null;contentHash:string|null;completedAt:string;rentalCents:string|null;goodsYuan:string|null;itemsYuan:string|null};
const utc=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,DIGEST=/^[a-f0-9]{64}$/,INTEGER=/^(0|[1-9]\d{0,23})$/;
const BATCH=200,SCAN_LIMIT=10000;
export function legacyActivitySnapshotDigest(rows:readonly {legacyId:string;sourceDigest:string;bindingDigest:string}[]):string{
 return sha256Hex([...rows].sort((a,b)=>a.legacyId<b.legacyId?-1:a.legacyId>b.legacyId?1:0).map(r=>`${r.legacyId}:${r.sourceDigest}:${r.bindingDigest}`).join("\n"));
}
function checkedBindings(value:TradeActivityBindings|undefined){
 if(value===undefined)return undefined;
 if(value===null||typeof value!=="object"||Array.isArray(value))throw new Error("PUBLIC_ACTIVITY_BINDINGS_INVALID");
 const b=structuredClone(value),r=b.resource;
 const text=(v:unknown)=>typeof v==="string"&&v.trim().length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
 if(!r || !text(r.database) || !text(r.runtimeRole) || !text(r.marker) || !Number.isSafeInteger(r.oid)||r.oid<=0 || !text(b.testExclusions?.evidenceRef))throw new Error("PUBLIC_ACTIVITY_BINDINGS_INVALID");
 for(const ids of [b.testExclusions.accountIds,b.testExclusions.nativeOrderIds,b.testExclusions.legacyIds])if(!Array.isArray(ids)||ids.length>10000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"||!ID.test(id)))throw new Error("PUBLIC_ACTIVITY_TEST_SCOPE_INVALID");
 const l=b.legacy;if(l!==undefined && (!l||l.sourceSystem!=="legacy_mysql_restore"||l.sourceEntity!=="la_order"||normalizeTime(l.sourceAsOf)!==l.sourceAsOf||!DIGEST.test(l.sourceBatchSha256)||!INTEGER.test(l.snapshotCount)||!DIGEST.test(l.snapshotDigest)||!INTEGER.test(l.isolatedCount)||!DIGEST.test(l.isolatedSetDigest)||!text(l.evidenceRef)))throw new Error("PUBLIC_ACTIVITY_LEGACY_COVERAGE_INVALID");
 return b;
}
/** Load existing reviewed read inputs at startup; no provider or data scope is inferred. */
export function loadTradePublicActivityBindings(env:NodeJS.ProcessEnv,workingDirectory:string):TradeActivityBindings|undefined{
 const file=env.PUBLIC_TRADE_ACTIVITY_BINDINGS_FILE,digest=env.PUBLIC_TRADE_ACTIVITY_BINDINGS_SHA256;
 if(file===undefined&&digest===undefined)return undefined;
 // shortcut: local reviewed-file assembly; production needs its own audited source/cohort binding.
 if(env.APP_PROFILE!=="test"||env.NODE_ENV==="production"||env.DB_TARGET!=="local-compose"||env.DB_HOST!=="127.0.0.1"||env.DB_PORT!=="55432"||!/^zzsh_test_/.test(env.DB_NAME??"")||!env.DB_USER||!file||file.trim()!==file||!DIGEST.test(digest??""))throw new Error("PUBLIC_ACTIVITY_BINDINGS_LOCAL_ONLY");
 const base=realpathSync(resolve(workingDirectory,".secrets")),target=realpathSync(resolve(workingDirectory,file)),rel=relative(base,target);
 if(!rel||rel.startsWith("..")||isAbsolute(rel)||!statSync(target).isFile())throw new Error("PUBLIC_ACTIVITY_BINDINGS_PATH");
 const limit=8*1024*1024;if(statSync(target).size>limit)throw new Error("PUBLIC_ACTIVITY_BINDINGS_SIZE");
 const bytes=readFileSync(target);if(bytes.length>limit||createHash("sha256").update(bytes).digest("hex")!==digest)throw new Error("PUBLIC_ACTIVITY_BINDINGS_DIGEST");
 const b=checkedBindings(JSON.parse(bytes.toString("utf8")));
 if(!b||b.resource.database!==env.DB_NAME||b.resource.runtimeRole!==env.DB_USER)throw new Error("PUBLIC_ACTIVITY_BINDINGS_RESOURCE_MISMATCH");
 return b;
}
async function context(client:PoolClient,b:TradeActivityBindings){
 const r=(await client.query<{database:string;oid:number;runtimeRole:string;marker:string;asOf:string}>(`SELECT current_database() AS database,d.oid::int AS oid,current_user AS "runtimeRole",shobj_description(d.oid,'pg_database') AS marker,${utc("statement_timestamp()")} AS "asOf" FROM pg_database d WHERE d.datname=current_database() /* public-activity-resource */`)).rows[0];
 if(!r || canonicalize({database:r.database,oid:r.oid,runtimeRole:r.runtimeRole,marker:r.marker})!==canonicalize(b.resource))throw new Error("PUBLIC_ACTIVITY_RESOURCE_MISMATCH");
 if(normalizeTime(r.asOf)!==r.asOf)throw new Error("PUBLIC_ACTIVITY_CLOCK_INVALID");return r.asOf;
}
async function legacyCovered(client:PoolClient,b:TradeActivityBindings,asOf:string){
 const l=b.legacy;if(!l||l.sourceAsOf>asOf)return false;
 const r=(await client.query<{count:string;digest:string;outOfCutoff:boolean}>(`SELECT count(*)::text AS count,encode(sha256(convert_to(COALESCE(string_agg(legacy_id||':'||source_digest||':'||binding_digest,chr(10) ORDER BY legacy_id COLLATE "C"),''),'UTF8')),'hex') AS digest,COALESCE(bool_or(source_created_at>$2::timestamptz OR source_completed_at>$2::timestamptz),false) AS "outOfCutoff" FROM zzsh_order.legacy_order_read_snapshot WHERE source_system='legacy_mysql_restore' AND source_entity='la_order' AND NOT(legacy_id=ANY($1::text[])) /* public-activity-legacy-coverage */`,[b.testExclusions.legacyIds,l.sourceAsOf])).rows[0];
 if(!r||!INTEGER.test(r.count)||!DIGEST.test(r.digest)||typeof r.outOfCutoff!=="boolean")throw new Error("PUBLIC_ACTIVITY_COVERAGE_RESULT_INVALID");
 return r.count===l.snapshotCount&&r.digest===l.snapshotDigest&&!r.outOfCutoff;
}
function completedRelation(){return `WITH completed AS(
 SELECT 'NATIVE'::text AS origin,o.id,o.account_id AS "accountId",o.listing_version_id AS "versionId",o.content_hash AS "contentHash",s.posted_at AS completed_at,o.rental_amount_cents::text AS "rentalCents",NULL::text AS "goodsYuan",NULL::text AS "itemsYuan"
 FROM zzsh_order.rental_order o JOIN zzsh_order.settlement_posting s ON s.order_id=o.id JOIN zzsh_order.payment_confirmation p ON p.id=o.paid_confirmation_id AND p.id=s.payment_confirmation_id AND p.order_id=o.id
 WHERE o.status='COMPLETED' AND p.disposition='APPLIED' AND p.source<>'CONTROLLED' AND s.posted_at<=$1::timestamptz AND NOT(o.id=ANY($2::text[])) AND NOT(o.account_id=ANY($4::text[]))
 UNION ALL
 SELECT 'LEGACY'::text,l.id,l.account_id,NULL::text,NULL::text,COALESCE(c.created_at,l.source_completed_at),NULL::text,l.source_snapshot->>'goods_money',l.source_snapshot->>'expend_pay_money'
 FROM zzsh_order.legacy_order_read_snapshot l
 LEFT JOIN LATERAL(SELECT stage FROM zzsh_order.legacy_continuation_version WHERE order_id=l.id AND created_at<=$1::timestamptz ORDER BY revision DESC LIMIT 1) h ON true
 LEFT JOIN LATERAL(SELECT created_at FROM zzsh_order.legacy_continuation_version WHERE order_id=l.id AND command='CONFIRM' AND created_at<=$1::timestamptz ORDER BY revision DESC LIMIT 1) c ON true
 WHERE l.source_system='legacy_mysql_restore' AND l.source_entity='la_order' AND l.source_pay_status=1 AND COALESCE(h.stage,l.source_order_status)=4
 AND NOT(l.legacy_id=ANY($3::text[])) AND NOT(l.account_id=ANY($4::text[]))
 )`;}
const parameters=(asOf:string,b:TradeActivityBindings)=>[asOf,b.testExclusions.nativeOrderIds,b.testExclusions.legacyIds,b.testExclusions.accountIds];
async function completedCount(client:PoolClient,b:TradeActivityBindings,asOf:string){
 const r=(await client.query<{count:string;unknown:string}>(`${completedRelation()} SELECT count(DISTINCT(origin,id)) FILTER(WHERE completed_at<=$1::timestamptz)::text AS count,count(*) FILTER(WHERE completed_at IS NULL)::text AS unknown FROM completed /* public-activity-completed-count */`,parameters(asOf,b))).rows[0];
 if(!r||!INTEGER.test(r.count)||!INTEGER.test(r.unknown))throw new Error("PUBLIC_ACTIVITY_COUNT_INVALID");return r.unknown!=="0"||BigInt(r.count)>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(r.count);
}
/** A provider is a real read, not a default zero. Missing reviewed coverage/cohort inputs stay unavailable. */
export function createTradePublicActivityReaders(options:{pool:Pool;gate:SupplyGateReader;bindings?:TradeActivityBindings}){
 const b=checkedBindings(options.bindings);
 return {
  completedTransactions:async():Promise<PublicActivityCount|null>=>{
   if(!b)return null;return withPublicListingSnapshot(options.pool,async client=>{const asOf=await context(client,b);if(!await legacyCovered(client,b,asOf))return null;
    const count=await completedCount(client,b,asOf);if(count===null)return null;
    return {value:count,asOf,scope:`NATIVE_POSTED_NON_CONTROLLED+LEGACY_MAPPED_COMPLETED;legacyCutoff=${b.legacy!.sourceAsOf};isolatedExcluded=${b.legacy!.isolatedCount};testsExcluded;dedupe=native-id/legacy-source-tuple`};
   });
  },
  currentListings:async():Promise<PublicActivityCount|null>=>{
   if(!b)return null;return withPublicListingSnapshot(options.pool,async client=>{const asOf=await context(client,b);let cursor="",count=0,scanned=0;
    for(;;){const rows=(await client.query<{id:string;versionId:string}>(`SELECT a.id,v.id AS "versionId" ${PUBLIC_CANDIDATE_FROM} WHERE ${PUBLIC_CANDIDATE_WHERE} AND ${PUBLIC_STANDARD_TIER_GUARD} AND a.id COLLATE "C">$1::text COLLATE "C" AND pub.published_at<=$2::timestamptz AND NOT(a.id=ANY($3::text[])) ORDER BY a.id COLLATE "C" LIMIT ${BATCH} /* public-activity-listings */`,[cursor,asOf,b.testExclusions.accountIds])).rows;
     if(rows.length>BATCH)throw new Error("PUBLIC_ACTIVITY_LISTING_PAGE_INVALID");for(const row of rows){if(!ID.test(row.id)||row.id<=cursor)throw new Error("PUBLIC_ACTIVITY_LISTING_CURSOR_INVALID");cursor=row.id;if(++scanned>SCAN_LIMIT)return null;const a=await readPublishingAccount(client,row.id),v=await readCurrentVersion(client,a);if(v.id!==row.versionId)throw new Error("PUBLIC_ACTIVITY_LISTING_VERSION_CHANGED");
      try{const listing=await readPublicListing(client,a,options.gate,undefined,true,"RENTABLE");if(listing.source!=="LEGACY_READ_ONLY")count++;}catch(error){if(error instanceof SecurityApiError&&error.code==="EVIDENCE_UNAVAILABLE")return null;if((error as {status?:number}).status!==404)throw error;}
     }if(rows.length<BATCH)return {value:count,asOf,scope:"CURRENT_FORMAL_PUBLIC_LISTINGS;shared-publication/rule/identity/acceptance/media/funding/occupancy-gates;tests-and-LEGACY_READ_ONLY-excluded"};
    }
   });
  },
  recentDeals:async():Promise<PublicActivityDeals|null>=>{
   if(!b)return null;return withPublicListingSnapshot(options.pool,async client=>{const asOf=await context(client,b);if(!await legacyCovered(client,b,asOf)||await completedCount(client,b,asOf)===null)return null;let afterTime:string|null=null,afterOrigin="",afterId="",scanned=0;const items:PublicActivityDeals["items"]=[];
    for(;;){const rows:CompletedRow[]=(await client.query<CompletedRow>(`${completedRelation()} SELECT origin,id,"accountId","versionId","contentHash",${utc("completed_at")} AS "completedAt","rentalCents","goodsYuan","itemsYuan" FROM completed WHERE completed_at<=$1::timestamptz AND EXISTS(SELECT 1 FROM zzsh_supply.listing_publication pub WHERE pub.account_id=completed."accountId" AND pub.published_at<=$1::timestamptz) AND($5::timestamptz IS NULL OR completed_at<$5::timestamptz OR(completed_at=$5::timestamptz AND(origin COLLATE "C",id COLLATE "C")>($6::text COLLATE "C",$7::text COLLATE "C"))) ORDER BY completed_at DESC,origin COLLATE "C",id COLLATE "C" LIMIT ${BATCH} /* public-activity-recent */`,[...parameters(asOf,b),afterTime,afterOrigin,afterId])).rows;
     if(rows.length>BATCH)throw new Error("PUBLIC_ACTIVITY_DEAL_PAGE_INVALID");for(const row of rows){if(!["NATIVE","LEGACY"].includes(row.origin)||!ID.test(row.id)||normalizeTime(row.completedAt)!==row.completedAt||row.completedAt>asOf)throw new Error("PUBLIC_ACTIVITY_DEAL_RESULT_INVALID");if(afterTime!==null&&(row.completedAt>afterTime||row.completedAt===afterTime&&(row.origin<afterOrigin||row.origin===afterOrigin&&row.id<=afterId)))throw new Error("PUBLIC_ACTIVITY_DEAL_CURSOR_INVALID");afterTime=row.completedAt;afterOrigin=row.origin;afterId=row.id;if(++scanned>SCAN_LIMIT)return null;
      let listing:Record<string,unknown>;try{listing=await readPublicListing(client,await readPublishingAccount(client,row.accountId),options.gate,undefined,true,"RENTABLE");}catch(error){if(error instanceof SecurityApiError&&error.code==="EVIDENCE_UNAVAILABLE")return null;if((error as {status?:number}).status===404)continue;throw error;}
      if(listing.source==="LEGACY_READ_ONLY")continue;if(row.origin==="NATIVE"&&(listing.versionId!==row.versionId||listing.releaseId===null||listing.contentHash!==undefined&&listing.contentHash!==row.contentHash))continue;
      const title=listing.title,game=(listing.game as {name?:unknown}|null)?.name;if(typeof title!=="string"||!title.trim()||title.length>2000||publicTextPrivacyIssues(title).length||typeof game!=="string"||!game.trim()||game.length>200||publicTextPrivacyIssues(game).length)return null;
      let cents:string|null=row.rentalCents;if(row.origin==="LEGACY"){const goods=legacyMoneyCents(row.goodsYuan),extra=legacyMoneyCents(row.itemsYuan);cents=goods===null||extra===null?null:(BigInt(goods)+BigInt(extra)).toString();}if(cents===null||!INTEGER.test(cents))return null;
      items.push({id:"public_deal_"+sha256Hex(JSON.stringify([row.origin,row.id])).slice(0,40),game,title,priceLabel:"原单租费 ¥"+centsToYuan(cents).amount});if(items.length===20)return {items,asOf};
     }if(rows.length<BATCH)return {items,asOf};
    }
   });
  },
 };
}
