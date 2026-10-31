import { canonicalize } from '../supply/content-hash';
import { ensureOnlyFields, invalid, conflict } from '../supply/supply-util';
import { referralPercent, validateDistributionPolicy, type DistributionPolicyConfig } from './distribution-policy';

export const DISTRIBUTION_POLICY_OPERATION='distribution.policy.publish';
export type DistributionPolicyUpdate={schema:'distribution-policy-change.v1';expectedPolicyId:string;expectedRevision:string;expectedPolicyDigest:string;changes:{enabled?:boolean;renterPercent?:string;ownerPercent?:string};reason:string};
export type DistributionPolicyInitial={schema:'distribution-policy-initialize.v1';config:{enabled:boolean;accountModes:('ordinary'|'custom')[];minimumAccrualCents:string;settlementDelayDays:number;renterPercent:string;ownerPercent:string};reason:string};
export type DistributionPolicyChange=DistributionPolicyUpdate|DistributionPolicyInitial;
export const isInitialPolicyChange=(v:DistributionPolicyChange):v is DistributionPolicyInitial=>v.schema==='distribution-policy-initialize.v1';
type PolicyHead={versionId:string;revision:string;digest:string;config:DistributionPolicyConfig};
export function parseDistributionPolicyChange(value:Record<string,unknown>):DistributionPolicyChange{
 if(value.schema==='distribution-policy-initialize.v1'){
  ensureOnlyFields(value,['schema','config','reason']);
  if(typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500||!value.config||typeof value.config!=='object'||Array.isArray(value.config))throw invalid('Explicit initial policy configuration and reason required');
  const c=value.config as Record<string,unknown>;ensureOnlyFields(c,['enabled','accountModes','minimumAccrualCents','settlementDelayDays','renterPercent','ownerPercent']);
  if(typeof c.enabled!=='boolean'||!Array.isArray(c.accountModes)||!c.accountModes.length||c.accountModes.length>2||new Set(c.accountModes).size!==c.accountModes.length||c.accountModes.some(m=>m!=='ordinary'&&m!=='custom')
   ||typeof c.minimumAccrualCents!=='string'||!/^(0|[1-9]\d{0,23})$/.test(c.minimumAccrualCents)||typeof c.settlementDelayDays!=='number'||!Number.isInteger(c.settlementDelayDays)||c.settlementDelayDays<0||c.settlementDelayDays>999999)throw invalid('Explicit initial uniform policy fields required');
  return{schema:'distribution-policy-initialize.v1',config:{enabled:c.enabled,accountModes:[...c.accountModes] as ('ordinary'|'custom')[],minimumAccrualCents:c.minimumAccrualCents,settlementDelayDays:c.settlementDelayDays,renterPercent:referralPercent(c.renterPercent).percent,ownerPercent:referralPercent(c.ownerPercent).percent},reason:value.reason.trim()};
 }
 ensureOnlyFields(value,['schema','expectedPolicyId','expectedRevision','expectedPolicyDigest','changes','reason']);
 if(value.schema!=='distribution-policy-change.v1'||typeof value.expectedPolicyId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.expectedPolicyId)||typeof value.expectedRevision!=='string'||!/^[1-9]\d{0,18}$/.test(value.expectedRevision)||typeof value.expectedPolicyDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedPolicyDigest)||typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500)throw invalid('Original policy reference and reason required');
 if(!value.changes||typeof value.changes!=='object'||Array.isArray(value.changes))throw invalid('Explicit distribution policy changes required');
 const c=value.changes as Record<string,unknown>;ensureOnlyFields(c,['enabled','renterPercent','ownerPercent']);
 if(!Object.keys(c).length||c.enabled!==undefined&&typeof c.enabled!=='boolean')throw invalid('Explicit distribution state/rates required');
 return{schema:'distribution-policy-change.v1',expectedPolicyId:value.expectedPolicyId,expectedRevision:value.expectedRevision,expectedPolicyDigest:value.expectedPolicyDigest,changes:{...(c.enabled===undefined?{}:{enabled:c.enabled as boolean}),...(c.renterPercent===undefined?{}:{renterPercent:referralPercent(c.renterPercent).percent}),...(c.ownerPercent===undefined?{}:{ownerPercent:referralPercent(c.ownerPercent).percent})},reason:value.reason.trim()};
}
/** Only the approved two rates and on/off state may change. Other economics stay on the pinned head. */
export function initialDistributionPolicyConfig(input:DistributionPolicyInitial,scope:'LOCAL_CONTROLLED'|'NATIVE'):DistributionPolicyConfig{
 if(!['LOCAL_CONTROLLED','NATIVE'].includes(scope))throw invalid('Policy scope is required');
 return validateDistributionPolicy({schema:'distribution-policy.v2',scope,enabled:input.config.enabled,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,
  accountModes:[...input.config.accountModes],minimumAccrualCents:input.config.minimumAccrualCents,settlementDelayDays:input.config.settlementDelayDays,
  rateMode:'UNIFORM',renterPercent:input.config.renterPercent,ownerPercent:input.config.ownerPercent,levels:[]},scope);
}
export function prepareDistributionPolicyChange(head:PolicyHead,input:DistributionPolicyChange):DistributionPolicyConfig{
 if(isInitialPolicyChange(input))throw invalid('Initial policy has no baseline to update');
 if(head.versionId!==input.expectedPolicyId||head.revision!==input.expectedRevision||head.digest!==input.expectedPolicyDigest)throw conflict('Distribution policy baseline changed');
 const original=head.config,c=input.changes;
 if(original.schema==='distribution-policy.v1'&&(c.renterPercent===undefined||c.ownerPercent===undefined))throw invalid('Adopting uniform policy requires both explicit rates; no historical grade fallback');
 const config=validateDistributionPolicy({schema:'distribution-policy.v2',scope:original.scope,enabled:c.enabled??original.enabled,participation:original.participation,depth:original.depth,selfRebate:original.selfRebate,accountModes:[...original.accountModes],minimumAccrualCents:original.minimumAccrualCents,settlementDelayDays:original.settlementDelayDays,rateMode:'UNIFORM',renterPercent:c.renterPercent??(original.schema==='distribution-policy.v2'?original.renterPercent:undefined),ownerPercent:c.ownerPercent??(original.schema==='distribution-policy.v2'?original.ownerPercent:undefined)},original.scope);
 if(canonicalize(config)===canonicalize(original))throw invalid('Distribution policy change is empty');
 return config;
}
