import {createHash} from 'node:crypto';import {canonicalize} from '../supply/content-hash';import {ensureOnlyFields,invalid,conflict} from '../supply/supply-util';import {parseNonNegativeDecimal,formatDecimalExact,divideToScale} from '../supply/decimal';import {exactCents} from './personal-finance-read';
export type ReferralRatio={numerator:string;denominator:string};
export type LevelCondition={metric:'LAST_PAID_AMOUNT'|'TOTAL_PAID_AMOUNT'|'PAID_COUNT'|'SETTLED_REFERRAL';value:string};
export type DistributionLevelPolicy={code:string;rank:number;default:boolean;renterPercent:string;ownerPercent:string;upgrade:null|{match:'ANY'|'ALL';conditions:LevelCondition[]}};
export type DistributionPolicyConfig={schema:'distribution-policy.v1';scope:'LOCAL_CONTROLLED';enabled:boolean;participation:'AUTO_AT_REGISTRATION';depth:1;selfRebate:false;accountModes:('ordinary'|'custom')[];minimumAccrualCents:string;settlementDelayDays:number;levels:DistributionLevelPolicy[]};
const unsigned=(v:unknown)=>{const text=exactCents(v);if(BigInt(text)<0n)throw invalid('Nonnegative policy amount required');return text;};
export function referralPercent(value:unknown):{percent:string;ratio:ReferralRatio}{if(typeof value!=='string'||!/^(0|[1-9]\d{0,2})(?:\.\d{1,8})?$/.test(value))throw invalid('Exact percent string required');const n=parseNonNegativeDecimal(value,8,'referral percent'),den=100n*10n**BigInt(n.scale);if(n.value>den)throw invalid('Referral percent exceeds 100');return{percent:formatDecimalExact(n),ratio:{numerator:n.value.toString(),denominator:den.toString()}};}
const compare=(a:ReferralRatio,b:ReferralRatio)=>BigInt(a.numerator)*BigInt(b.denominator)-BigInt(b.numerator)*BigInt(a.denominator);
function boundedPair(a:ReferralRatio,b:ReferralRatio){if(BigInt(a.numerator)*BigInt(b.denominator)+BigInt(b.numerator)*BigInt(a.denominator)>BigInt(a.denominator)*BigInt(b.denominator))throw invalid('Cross-level referral total exceeds the same base');}
export function validateDistributionPolicy(value:Record<string,unknown>):DistributionPolicyConfig{
 ensureOnlyFields(value,['schema','scope','enabled','participation','depth','selfRebate','accountModes','minimumAccrualCents','settlementDelayDays','levels']);
 if(value.schema!=='distribution-policy.v1'||value.scope!=='LOCAL_CONTROLLED'||typeof value.enabled!=='boolean'||value.participation!=='AUTO_AT_REGISTRATION'||value.depth!==1||value.selfRebate!==false)throw invalid('Unsupported rental distribution policy mode');
 if(!Array.isArray(value.accountModes)||!value.accountModes.length||value.accountModes.length>2||new Set(value.accountModes).size!==value.accountModes.length||value.accountModes.some(m=>m!=='ordinary'&&m!=='custom'))throw invalid('Unreviewed account mode');
 if(typeof value.settlementDelayDays!=='number'||!Number.isInteger(value.settlementDelayDays)||value.settlementDelayDays<0||value.settlementDelayDays>999999)throw invalid('Whole settlement delay days required');
 if(!Array.isArray(value.levels)||!value.levels.length||value.levels.length>999)throw invalid('Typed distribution levels required');
 const levels=value.levels.map((raw:unknown)=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw invalid('Level object required');const l=raw as Record<string,unknown>;ensureOnlyFields(l,['code','rank','default','renterPercent','ownerPercent','upgrade']);
  if(typeof l.code!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(l.code)||typeof l.rank!=='number'||!Number.isInteger(l.rank)||l.rank<1||l.rank>999||typeof l.default!=='boolean')throw invalid('Level code/rank invalid');
  const renter=referralPercent(l.renterPercent),owner=referralPercent(l.ownerPercent);let upgrade:DistributionLevelPolicy['upgrade']=null;
  if(l.upgrade!==null){if(!l.upgrade||typeof l.upgrade!=='object'||Array.isArray(l.upgrade))throw invalid('Upgrade rule must be explicit null or typed');const u=l.upgrade as Record<string,unknown>;ensureOnlyFields(u,['match','conditions']);if(!['ANY','ALL'].includes(String(u.match))||!Array.isArray(u.conditions)||!u.conditions.length||u.conditions.length>4||l.default)throw invalid('Empty/unsupported upgrade rule');
   const conditions=u.conditions.map((c:unknown)=>{if(!c||typeof c!=='object'||Array.isArray(c))throw invalid('Condition required');const f=c as Record<string,unknown>;ensureOnlyFields(f,['metric','value']);if(!['LAST_PAID_AMOUNT','TOTAL_PAID_AMOUNT','PAID_COUNT','SETTLED_REFERRAL'].includes(String(f.metric)))throw invalid('Unsupported upgrade metric');return{metric:f.metric as LevelCondition['metric'],value:unsigned(f.value)};});if(new Set(conditions.map(c=>c.metric)).size!==conditions.length)throw invalid('Duplicate upgrade metric');upgrade={match:u.match as 'ANY'|'ALL',conditions};
  }
  return{code:l.code,rank:l.rank,default:l.default,renterPercent:renter.percent,ownerPercent:owner.percent,upgrade};
 });
 if(new Set(levels.map(l=>l.code)).size!==levels.length||new Set(levels.map(l=>l.rank)).size!==levels.length||levels.filter(l=>l.default).length!==1)throw invalid('Exactly one default and unique stable levels required');
 let maxR=referralPercent(levels[0]!.renterPercent).ratio,maxO=referralPercent(levels[0]!.ownerPercent).ratio;for(const l of levels){const r=referralPercent(l.renterPercent).ratio,o=referralPercent(l.ownerPercent).ratio;if(compare(r,maxR)>0n)maxR=r;if(compare(o,maxO)>0n)maxO=o;}boundedPair(maxR,maxO);
 return{schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:value.enabled,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:value.accountModes as ('ordinary'|'custom')[],minimumAccrualCents:unsigned(value.minimumAccrualCents),settlementDelayDays:value.settlementDelayDays,levels};
}
/** Pair applies the actual payment-frozen ratios; no rebalance or silent subsidy. */
export function allocateFrozenReferralPair(baseCents:string,renter:ReferralRatio|null,owner:ReferralRatio|null,minimumAccrualCents:string){
 const base=BigInt(unsigned(baseCents)),minimum=BigInt(unsigned(minimumAccrualCents));const amount=(r:ReferralRatio|null)=>{if(!r)return 0n;const n=BigInt(unsigned(r.numerator)),d=BigInt(unsigned(r.denominator));if(d===0n||n>d)throw invalid('Frozen referral ratio invalid');return divideToScale({value:base*n,scale:0},{value:d,scale:0},0).value;};
 const r=amount(renter),o=amount(owner);if(r+o>base)throw conflict('Rounded referral pair exceeds source base');return{renterCents:r>0n&&r>=minimum?r.toString():null,ownerCents:o>0n&&o>=minimum?o.toString():null,skipped:{renter:r===0n||r<minimum,owner:o===0n||o<minimum}};
}
export function frozenDistributionPolicyDigest(config:DistributionPolicyConfig){return createHash('sha256').update(canonicalize(config)).digest('hex');}


