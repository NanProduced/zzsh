import { AdminApiError } from '../api';

export type DistributionLevel={code:string;rank:number;default:boolean;renterPercent:string;ownerPercent:string;upgrade:null|{match:'ANY'|'ALL';conditions:{metric:string;value:string}[]}};
type CommonPolicy={scope:'LOCAL_CONTROLLED'|'NATIVE';enabled:boolean;participation:'AUTO_AT_REGISTRATION';depth:1;selfRebate:false;accountModes:('ordinary'|'custom')[];minimumAccrualCents:string;settlementDelayDays:number};
export type DistributionPolicyConfig=CommonPolicy&({schema:'distribution-policy.v1';levels:DistributionLevel[]}|{schema:'distribution-policy.v2';rateMode:'UNIFORM';renterPercent:string;ownerPercent:string;levels:[]});
export type PolicyHead={versionId:string;revision:string;digest:string;config:DistributionPolicyConfig;createdAt:string};
export type ChangeContext={schema:'distribution-policy-change-context.v1';state:'EMPTY'|'PENDING'|'UNAVAILABLE';contractReady:boolean;writeAssemblyReady:boolean;request:null|{requestId:string;status:string;requestedBy:string;requesterName?:string|null;createdAt:string;deciderName?:string|null;decidedAt?:string|null;expectedPolicyId:string|null;expectedRevision:string|null;expectedPolicyDigest:string|null;changes:unknown};reasonCodes:string[]};
export type DistributionPolicyRead=({knowledge:'KNOWN';policy:PolicyHead}|{knowledge:'UNKNOWN';policy:null;reason:string;scope?:'LOCAL_CONTROLLED'|'NATIVE'})&{scope?:'LOCAL_CONTROLLED'|'NATIVE';changeContext?:ChangeContext;semanticsVersion?:'distribution-policy.lifecycle.v2'};
export type DistributionPolicyUpdatePayload={schema:'distribution-policy-change.v1';expectedPolicyId:string;expectedRevision:string;expectedPolicyDigest:string;changes:{enabled?:boolean;renterPercent?:string;ownerPercent?:string};reason:string};
export type DistributionPolicyInitialPayload={schema:'distribution-policy-initialize.v1';config:{enabled:boolean;accountModes:('ordinary'|'custom')[];minimumAccrualCents:string;settlementDelayDays:number;renterPercent:string;ownerPercent:string};reason:string};
export type DistributionPolicyPayload=DistributionPolicyUpdatePayload|DistributionPolicyInitialPayload;
const fail=():never=>{throw new AdminApiError(502,'DISTRIBUTION_POLICY_CONTRACT_REQUIRED');};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const cents=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,23})$/.test(v);
export function parseDistributionPercent(value:unknown):string{
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,2})(?:\.\d{1,8})?$/.test(value))throw Error('请输入0至100之间的精确百分比，最多8位小数');
 const [whole,fraction='']=value.split('.');if(BigInt(whole!)*100000000n+BigInt(fraction.padEnd(8,'0'))>10000000000n)throw Error('两类分销比例分别不能超过100%');
 const decimal=fraction.replace(/0+$/,'');return whole+(decimal?'.'+decimal:'');
}
export function distributionCentsLabel(value:string|null|undefined){
 if(typeof value!=='string'||! /^(0|[1-9]\d{0,23})$/.test(value))return '未知';
 const n=BigInt(value);return `¥${(n/100n).toLocaleString('zh-CN')}.${(n%100n).toString().padStart(2,'0')}`;
}
export function parseDistributionPolicyRead(value:unknown):DistributionPolicyRead{
 if(!object(value))return fail();let context:ChangeContext|undefined;
 if(value.changeContext!==undefined){const c=value.changeContext;if(!object(c)||c.schema!=='distribution-policy-change-context.v1'||!['EMPTY','PENDING','UNAVAILABLE'].includes(c.state)||typeof c.contractReady!=='boolean'||typeof c.writeAssemblyReady!=='boolean'||!Array.isArray(c.reasonCodes)||c.reasonCodes.some((r:unknown)=>typeof r!=='string'))return fail();if(c.state==='EMPTY'&&c.request!==null)return fail();if(c.request!==null&&(!object(c.request)||typeof c.request.requestId!=='string'||typeof c.request.status!=='string'||typeof c.request.requestedBy!=='string'||typeof c.request.createdAt!=='string'))return fail();context=c as ChangeContext;}
 if(value.knowledge==='UNKNOWN'&&value.policy===null&&typeof value.reason==='string'){const readScope=value.scope??value.config?.scope;if(readScope!==undefined&&!['LOCAL_CONTROLLED','NATIVE'].includes(readScope))return fail();return{knowledge:'UNKNOWN',policy:null,reason:value.reason,...(readScope?{scope:readScope}:{}),...(context?{changeContext:context}:{}),...(value.semanticsVersion==='distribution-policy.lifecycle.v2'?{semanticsVersion:'distribution-policy.lifecycle.v2' as const}:{})};}
 const p=value.policy,c=p?.config;if(value.knowledge!=='KNOWN'||!object(p)||typeof p.versionId!=='string'||typeof p.revision!=='string'||!/^[1-9]\d{0,18}$/.test(p.revision)||typeof p.digest!=='string'||!/^[a-f0-9]{64}$/.test(p.digest)||!object(c)||!['LOCAL_CONTROLLED','NATIVE'].includes(c.scope)||typeof c.enabled!=='boolean'||c.participation!=='AUTO_AT_REGISTRATION'||c.depth!==1||c.selfRebate!==false||!Array.isArray(c.accountModes)||!c.accountModes.length||new Set(c.accountModes).size!==c.accountModes.length||c.accountModes.some((m:unknown)=>m!=='ordinary'&&m!=='custom')||!cents(c.minimumAccrualCents)||!Number.isInteger(c.settlementDelayDays)||c.settlementDelayDays<0||c.settlementDelayDays>999999||typeof p.createdAt!=='string')return fail();
 try{
  if(c.schema==='distribution-policy.v2'){if(c.rateMode!=='UNIFORM'||!Array.isArray(c.levels)||c.levels.length)return fail();parseDistributionPercent(c.renterPercent);parseDistributionPercent(c.ownerPercent);}
  else if(c.schema==='distribution-policy.v1'){if(!Array.isArray(c.levels)||!c.levels.length||c.levels.length>999||c.levels.filter((l:any)=>l.default===true).length!==1||new Set(c.levels.map((l:any)=>l.code)).size!==c.levels.length||new Set(c.levels.map((l:any)=>l.rank)).size!==c.levels.length)return fail();for(const l of c.levels){if(!object(l)||typeof l.code!=='string'||!Number.isInteger(l.rank)||l.rank<1||typeof l.default!=='boolean'||l.upgrade!==null&&(!object(l.upgrade)||!['ANY','ALL'].includes(l.upgrade.match)||!Array.isArray(l.upgrade.conditions)))return fail();parseDistributionPercent(l.renterPercent);parseDistributionPercent(l.ownerPercent);}}
  else return fail();
 }catch{return fail();}
 return{knowledge:'KNOWN',policy:p as PolicyHead,scope:c.scope,...(context?{changeContext:context}:{}),...(value.semanticsVersion==='distribution-policy.lifecycle.v2'?{semanticsVersion:'distribution-policy.lifecycle.v2' as const}:{})};
}
export function sameDistributionProposal(actual:unknown,expected:unknown){
 if(!object(actual)||!object(expected))return false;
 if(actual.schema==='distribution-policy-initialize.v1'||expected.schema==='distribution-policy-initialize.v1'){return actual.schema===expected.schema&&actual.reason===expected.reason&&JSON.stringify(actual.config)===JSON.stringify(expected.config);}
 if(!['schema','expectedPolicyId','expectedRevision','expectedPolicyDigest','reason'].every(k=>actual[k]===expected[k]))return false;
 if(!object(actual.changes)||!object(expected.changes))return false;
 const a=Object.keys(actual.changes).sort(),b=Object.keys(expected.changes).sort();return a.join('|')===b.join('|')&&a.every(k=>actual.changes[k]===expected.changes[k]);
}
export function buildDistributionPolicyPayload(head:PolicyHead,draft:{enabled:boolean;renter:string;owner:string;reason:string}):DistributionPolicyUpdatePayload{
 const renter=parseDistributionPercent(draft.renter.trim()),owner=parseDistributionPercent(draft.owner.trim());
 const scaled=(v:string)=>{const [a,b='']=v.split('.');return BigInt(a!)*100000000n+BigInt(b.padEnd(8,'0'));};
 if(scaled(renter)+scaled(owner)>10000000000n)throw Error('邀请租客与邀请号主两类比例合计不能超过100%');
 if(draft.reason.trim().length<3||draft.reason.length>500)throw Error('请填写至少3个字的变更原因');
 const changes:DistributionPolicyUpdatePayload['changes']={};if(draft.enabled!==head.config.enabled)changes.enabled=draft.enabled;
 if(head.config.schema==='distribution-policy.v1'||renter!==head.config.renterPercent)changes.renterPercent=renter;
 if(head.config.schema==='distribution-policy.v1'||owner!==head.config.ownerPercent)changes.ownerPercent=owner;
 if(!Object.keys(changes).length)throw Error('当前没有需要提交的变更');
 return{schema:'distribution-policy-change.v1',expectedPolicyId:head.versionId,expectedRevision:head.revision,expectedPolicyDigest:head.digest,changes,reason:draft.reason.trim()};
}

export function buildInitialDistributionPolicyPayload(draft:{enabled:boolean;renter:string;owner:string;minimumAccrualCents:string;settlementDelayDays:string;accountModes:('ordinary'|'custom')[];reason:string}):DistributionPolicyInitialPayload{
 const renter=parseDistributionPercent(draft.renter.trim()),owner=parseDistributionPercent(draft.owner.trim());
 const scaled=(v:string)=>{const [a,b='']=v.split('.');return BigInt(a!)*100000000n+BigInt(b.padEnd(8,'0'));};
 if(scaled(renter)+scaled(owner)>10000000000n)throw Error('邀请租客与邀请号主两类比例合计不能超过100%');
 if(!/^(0|[1-9]\d{0,23})$/.test(draft.minimumAccrualCents)||!/^\d{1,6}$/.test(draft.settlementDelayDays)||draft.accountModes.length<1||draft.reason.trim().length<3||draft.reason.length>500)throw Error('请完整填写首版政策的金额、方式、期限和原因');
 return{schema:'distribution-policy-initialize.v1',config:{enabled:draft.enabled,accountModes:[...draft.accountModes],minimumAccrualCents:draft.minimumAccrualCents,settlementDelayDays:Number(draft.settlementDelayDays),renterPercent:renter,ownerPercent:owner},reason:draft.reason.trim()};
}
