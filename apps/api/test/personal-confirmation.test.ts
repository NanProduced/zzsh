import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { signConfirmation, verifyConfirmation } from "../src/order/confirmation-token";
import { parseMembershipChange, membershipProjection, RENTAL_MEMBERSHIP_BENEFIT_POLICY } from "../src/auth/rental-membership";
import { confirmationInput } from "../src/order/personal-confirmation";
import { personalOrderInput, createPersonalReservation } from "../src/order/personal-order";

const key={keyId:"fixture",secret:"isolated-fixture-only-not-production-key"};
const binding={userId:"user-1",sessionId:"session-1",accountId:"account-1",versionId:"version-1",releaseId:"release-1",listingHash:"a".repeat(64),quoteDigest:"b".repeat(64)};
test("confirmed public membership rules retain qualification privacy and independent content version",()=>{
  assert.deepEqual(membershipProjection({tier:"VIP",version:"99",sourceRef:"private-grant"}),{tier:"VIP",version:"99"});
  const p=RENTAL_MEMBERSHIP_BENEFIT_POLICY;
  assert.equal(p.scope,"DELTA_ACCOUNT_RENTAL");
  assert.equal(p.tenantDeposit.VIP,"WAIVED");assert.equal(p.tenantDeposit.SVIP,"WAIVED");
  assert.equal(p.tenantDeposit.STANDARD,"ACCOUNT_BASE");assert.equal(p.tenantDeposit.DISCOUNT_USER,"ACCOUNT_BASE");
  assert.equal(p.validity,"UNKNOWN");assert.equal(p.acquisition,"UNKNOWN");assert.notEqual(p.version,"99");
});
test("personal confirmation fixed HMAC, strict claims, expiry and rebuilt evidence binding",()=>{
  const signed=signConfirmation(binding,1000,key);
  assert.equal(verifyConfirmation(signed.token,binding,1001,key).confirmationId,signed.claims.confirmationId);
  assert.throws(()=>signConfirmation(binding,1000,undefined),(e:any)=>e.status===503);
  for(const name of Object.keys(binding) as (keyof typeof binding)[])assert.throws(()=>verifyConfirmation(signed.token,{...binding,[name]:name.endsWith("Hash")||name.endsWith("Digest")?"c".repeat(64):"other"},1001,key));
  assert.throws(()=>verifyConfirmation(signed.token,binding,1300,key),(e:any)=>e.code==="CONFIRMATION_EXPIRED");
  for(const token of [null,"",signed.token+"a","x".repeat(4097),signed.token.replace(/^./,"x")])assert.throws(()=>verifyConfirmation(token,binding,1001,key));
  assert.throws(()=>verifyConfirmation(signed.token,binding,1001,{...key,secret:"wrong-"+key.secret}));
  const resign=(claims:unknown)=>{const bytes=Buffer.from(JSON.stringify(claims)).toString("base64url");return bytes+"."+createHmac("sha256",key.secret).update(bytes).digest("base64url");};
  for(const patch of [{alg:"none"},{schema:"unknown"},{keyId:"other"},{audience:"other"},{issuedAt:1002,expiresAt:1302},{expiresAt:1400},{ownerAmount:"secret"}])assert.throws(()=>verifyConfirmation(resign({...signed.claims,...patch}),binding,1001,key));
  const decoded=JSON.parse(Buffer.from(signed.token.split(".")[0]!,"base64url").toString());
  assert.deepEqual(Object.keys(decoded).sort(),[...Object.keys(binding),"schema","audience","keyId","confirmationId","issuedAt","expiresAt"].sort());
  for(const field of ["tier","sourceRef","ownerAmount","platformFullProfit","publisherBailRequirementCents","inventory"])assert.equal(field in decoded,false);
});
test("membership and confirmation inputs reject client-controlled prices and invalid tier/version",()=>{
  const change={tier:"VIP",expectedVersion:"0",sourceRef:"fixture:grant",reason:"isolated grant"};
  assert.equal(parseMembershipChange(change).tier,"VIP");
  for(const tier of [null,0,{},"PREFERENTIAL","ADMIN",""])assert.throws(()=>parseMembershipChange({...change,tier}));
  for(const expectedVersion of [null,1,"-1","1.1","01"])assert.throws(()=>parseMembershipChange({...change,expectedVersion}));
  assert.throws(()=>parseMembershipChange({...change,extra:true}));
  assert.throws(()=>parseMembershipChange({...change,reason:""}));
  const input={accountId:"account-1",versionId:"version-1",releaseId:"release-1"};
  for(const extra of [{tier:"VIP"},{tenantDeposit:0},{userId:"other"},{V:"2"},{confirmationToken:"x"}])assert.throws(()=>confirmationInput({...input,...extra}));
});

test("v2 creation bounds the original credential body without pre-validating successful replays",()=>{
  assert.deepEqual(personalOrderInput({confirmationToken:"opaque-original"}),{confirmationToken:"opaque-original"});
  for(const confirmationToken of [null,0,{},"","x".repeat(4097)])assert.throws(()=>personalOrderInput({confirmationToken}));
  for(const extra of [{tier:"VIP"},{rentalAmountCents:"0"},{accountId:"other"}])assert.throws(()=>personalOrderInput({confirmationToken:"opaque-original",...extra}));
});

// Exercise the real rebuild -> sign -> verify path; only SQL transport is synthetic.
import { createControlledConfirmationFundingReader, issuePersonalConfirmation, rebuildPersonalConfirmation, verifyPersonalConfirmation } from "../src/order/personal-confirmation";
import { computeContentHash, type ContentPayloadInput } from "../src/supply/content-hash";
import { computeQuote } from "../src/supply/pricing";
import { evaluatePublication } from "../src/supply/publishing";
import { withIdempotency } from "../src/supply/supply-util";

function personalRefsFixture(v2=true) {
  const context={userId:"renter",sessionId:"session-1"},input={accountId:"account-1",versionId:"version-1",releaseId:"release-1"};
  const haffRule={schema:"haff-ratio-v1" as const,baseBySafeBox:{a:"40"},vitalityDeltaByLevel:{6:"0"},bearDeltaByLevel:{6:"0"},dailyDeltaByTermOption:{d:"0"},options:{s:{delta:"0",enabled:true}}};
  const term={code:"d",dailyConsumption:"10000000",durationRounding:"CEIL_DAY" as const};
  const computed=computeQuote({priceVersionId:"price-1",mode:"PERCENT",commissionRate:"0.2",roundingPolicy:"HALF_UP_CENT_V1",haffRule,lines:[{itemId:"haff",quantity:"60000000",pricingKind:"HAFF_RATIO",customerTier:"STANDARD"}],conditions:{safeBoxCode:"a",vitLevel:6,bearLevel:6,termOptionCode:"d",pricingOptionCode:"s"},termOption:term,deposits:{tenantDepositCents:"30000",publisherBailRequirementCents:"0"}});assert(computed.quotable);computed.quote.ruleReleaseId=input.releaseId;
  const payload:ContentPayloadInput={schemaVersion:1,accountId:input.accountId,gameId:"game-1",ruleRefs:{releaseId:input.releaseId,priceVersionId:"price-1",termVersionId:"term-1",agreementVersionId:"agreement-1",agreementDigest:"d".repeat(64),...(v2?{catalogRevision:"93"}:{})},declaration:{title:"Offline",description:null,attributes:{safe_box_code:"a",vit_level:6,bear_level:6,...(v2?{full_payout_declaration:{schema:"full-payout-declaration-v1",selected:false}}:{})},inventory:[{itemId:"haff",quantity:"60000000"}],skins:[],entitlements:[],termOptionCode:"d",pricingOptionCode:"s",mediaBindings:[]},quoteValues:computed.quote as unknown as Record<string,unknown>};
  const account={id:input.accountId,owner_user_id:"owner",game_id:"game-1",current_version_id:input.versionId,lifecycle:"ACTIVE",legacy_hold:"NONE"};
  const version={id:input.versionId,account_id:input.accountId,origin:"NATIVE",review_state:"PUBLISHED",rule_release_id:input.releaseId,content_hash:computeContentHash(payload),payload,attributes:payload.declaration.attributes};
  const runId="11111111-1111-4111-8111-111111111111",allowed=new Map([[account.id,{runId,ownerUserId:"owner",listingVersionId:version.id,listingHash:version.content_hash}]]);
  const client={query:async(sql:string)=>{let rows:unknown[];
    if(sql.includes('owner_user_id AS "ownerUserId"'))rows=[{ownerUserId:"owner",gameId:"game-1"}];
    else if(sql.includes('SELECT id FROM zzsh_auth_user.'))rows=[{id:"renter"},{id:"owner"}];
    else if(sql.includes('AS "accountStatus"'))rows=[{id:"renter",suspended:false,accountStatus:"ACTIVE",identityStatus:"VERIFIED",ageStatus:"ADULT"}];
    else if(sql.includes('zzsh_auth_user."session"'))rows=[{ok:1}];
    else if(sql.includes('SELECT current_database()'))rows=[{database:"zzsh_test_order_trade_settlement",role:"zzsh_order_trade_settlement_r"}];
    else if(sql.includes('AS ok'))rows=[{ok:true}];
    else if(sql.includes('WHERE confirmation_id='))rows=[];
    else if(sql.includes('SELECT * FROM zzsh_supply.rental_account'))rows=[account];
    else if(sql.includes('SELECT * FROM zzsh_supply.listing_version'))rows=[version];
    else if(sql.includes('rule_acceptance'))rows=[{ok:1}];
    else if(sql.includes('listing_media'))rows=[{id:'media-1',purpose:'ACCOUNT_DISPLAY',ownership_kind:'USER_SUPPLY',review_state:'PENDING',technical_state:'READY',public_storage_key:'offline',access_class:'PUBLIC_DISPLAY'}];
    else if(sql.includes('listing_publication'))rows=[{source:"OWNER_DIRECT"}];
    else if(sql.includes('user_identity_state'))rows=[{suspended:false,account_status:"ACTIVE",identity_status:"VERIFIED",age_status:"ADULT"}];
    else if(sql.includes('game_service_operation'))rows=[{id:"service-1",gameId:"game-1",gameCode:"delta",gameEnabled:true,serviceCode:"ACCOUNT_RENTAL",enabled:true,revision:"1"}];
    else if(sql.includes('p.funding_policy AS policy'))rows=[{policy:null}];
    else if(sql.includes('zzsh_supply.game'))rows=[{enabled:true,current_release_id:input.releaseId,catalog_revision:"93"}];
    else if(sql.includes('user_rental_membership'))rows=[{tier:"STANDARD",version:"1",sourceRef:"registration:v1",updatedBy:null}];
    else if(sql.includes('SELECT p.id,p.status'))rows=[{id:"price-1",status:"SEALED",mode:"PERCENT",haff_rule:haffRule,commission_rate:"0.2",rounding_policy:"HALF_UP_CENT_V1",term_version_id:"term-1"}];
    else if(sql.includes('FROM zzsh_supply.price_line'))rows=[{item_id:"haff",pricing_kind:"HAFF_RATIO",unit_quantity:null,buyer_unit_amount:null,owner_unit_amount:null}];
    else if(sql.includes('FROM zzsh_supply.term_option'))rows=[term];
    else if(sql.includes('extract(epoch'))rows=[{now:"1000"}];
    else throw Error('Unexpected SQL: '+sql);return{rows,rowCount:rows.length};}} as never;
  const controlled=createControlledConfirmationFundingReader({config:{profile:"test",provider:"fake",testOperationsEnabled:true,database:{target:"local-compose",targetProfile:"test",host:"127.0.0.1",port:55432,name:"zzsh_test_order_trade_settlement",user:"zzsh_order_trade_settlement_r"}} as never,resourceSet:"trade_settlement",runId,allowedListings:allowed});
  const legacy=async()=>({version:"v1",sourceRef:"fixture",baseDepositCents:"30000",publisherBailRequirementCents:"0",vipWaiver:false,svipWaiver:false,fullPayoutSelected:false,fullPayoutPolicyRef:"legacy",fullPayoutFeeCents:"0"});
  const options={key,gate:async()=>({publisherBail:"NOT_REQUIRED" as const,occupancy:"FREE" as const,reference:"fixture"}),fundingReader:v2?controlled:legacy};
  const rehash=()=>{version.content_hash=computeContentHash(payload);allowed.get(account.id)!.listingHash=version.content_hash;};return{client,context,input,options,payload,version,account,rehash};
}

test("v2 five rule refs are signed and verified while catalog and listing hash stay intact; v1 stays compatible",async()=>{
  for(const v2 of [true,false]){const f=personalRefsFixture(v2),original=structuredClone(f.payload),hash=f.version.content_hash;
    assert.deepEqual(await evaluatePublication(f.client,f.account as never,f.version as never,f.options.gate),[]);
    const rebuilt=await rebuildPersonalConfirmation(f.client,f.context,f.input,f.options);
    assert.deepEqual(Object.keys(rebuilt.snapshot.ruleRefs).sort(),["releaseId","priceVersionId","termVersionId","agreementVersionId","agreementDigest"].sort());
    const issued=await issuePersonalConfirmation(f.client,f.context,f.input,f.options),verified=await verifyPersonalConfirmation(f.client,f.context,f.input,issued.confirmationToken,f.options);
    let inserted:Record<string,any>|undefined;const transport=f.client as unknown as {query:(sql:string,values?:unknown[])=>Promise<unknown>},query=transport.query.bind(transport);
    transport.query=async(sql,values)=>{if(sql.startsWith("INSERT INTO zzsh_order.rental_order")){inserted=JSON.parse(values![12] as string);throw Error("OFFLINE_INSERT_CAPTURED");}return query(sql,values);};
    await assert.rejects(()=>createPersonalReservation(f.client,f.context,issued.confirmationToken,{...f.options,holdSeconds:600},"offline-request"),/OFFLINE_INSERT_CAPTURED/);
    assert.deepEqual(inserted!.personal.ruleRefs,rebuilt.snapshot.ruleRefs);assert.equal(inserted!.listingHash,hash);assert.equal(inserted!.confirmationDigest,verified.claims.quoteDigest);
    assert.deepEqual(verified.snapshot,rebuilt.snapshot);assert.equal(verified.claims.listingHash,hash);assert.equal(rebuilt.snapshot.listingHash,hash);assert.deepEqual(f.payload,original);assert.equal(f.payload.ruleRefs.catalogRevision,v2?"93":undefined);
    f.payload.ruleRefs.agreementVersionId="agreement-2";f.rehash();await assert.rejects(()=>verifyPersonalConfirmation(f.client,f.context,f.input,issued.confirmationToken,f.options));
  }
});

test("personal rule refs reject missing and mismatched frozen references before signing",async()=>{
  for(const field of ["releaseId","priceVersionId","termVersionId","agreementVersionId","agreementDigest"] as const){const f=personalRefsFixture();delete (f.payload.ruleRefs as Partial<typeof f.payload.ruleRefs>)[field];try{f.rehash();}catch{}await assert.rejects(()=>issuePersonalConfirmation(f.client,f.context,f.input,f.options));}
  for(const field of ["releaseId","priceVersionId","termVersionId"] as const){const f=personalRefsFixture();f.payload.ruleRefs[field]="wrong";f.rehash();await assert.rejects(()=>issuePersonalConfirmation(f.client,f.context,f.input,f.options));}
  const f=personalRefsFixture();f.version.content_hash="0".repeat(64);await assert.rejects(()=>issuePersonalConfirmation(f.client,f.context,f.input,f.options));
});

test("accepted order receipt replay bypasses new confirmation rebuilding",async()=>{
  const body={order:{id:"old-order",status:"CANCELLED"}},client={query:async(sql:string)=>({rows:sql.includes('idempotency_record')?[{requestFingerprint:"original",responseStatus:200,responseBody:body,publishRequired:false}]:[]})} as never;
  const replay=await withIdempotency(client,{realm:"user",principalId:"renter",operation:"order.reservation.create.v2"},"original-key","original",async()=>{},async()=>{throw Error('Must not rebuild accepted order');});assert.equal(replay.replayed,true);assert.deepEqual(replay.body,body);
});





