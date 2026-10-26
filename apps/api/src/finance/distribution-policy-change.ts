import { canonicalize } from '../supply/content-hash';
import { ensureOnlyFields, invalid, conflict } from '../supply/supply-util';
import { referralPercent, validateDistributionPolicy, type DistributionPolicyConfig } from './distribution-policy';

export const DISTRIBUTION_POLICY_OPERATION='distribution.policy.publish';
export type DistributionPolicyChange={schema:'distribution-policy-change.v1';expectedPolicyId:string;expectedRevision:string;expectedPolicyDigest:string;changes:{enabled?:boolean;renterPercent?:string;ownerPercent?:string};reason:string};
type PolicyHead={versionId:string;revision:string;digest:string;config:DistributionPolicyConfig};
export function parseDistributionPolicyChange(value:Record<string,unknown>):DistributionPolicyChange{
 ensureOnlyFields(value,['schema','expectedPolicyId','expectedRevision','expectedPolicyDigest','changes','reason']);
 if(value.schema!=='distribution-policy-change.v1'||typeof value.expectedPolicyId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.expectedPolicyId)||typeof value.expectedRevision!=='string'||!/^[1-9]\d{0,18}$/.test(value.expectedRevision)||typeof value.expectedPolicyDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedPolicyDigest)||typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500)throw invalid('Original policy reference and reason required');
 if(!value.changes||typeof value.changes!=='object'||Array.isArray(value.changes))throw invalid('Explicit distribution policy changes required');
 const c=value.changes as Record<string,unknown>;ensureOnlyFields(c,['enabled','renterPercent','ownerPercent']);
 if(!Object.keys(c).length||c.enabled!==undefined&&typeof c.enabled!=='boolean')throw invalid('Explicit distribution state/rates required');
 return{schema:'distribution-policy-change.v1',expectedPolicyId:value.expectedPolicyId,expectedRevision:value.expectedRevision,expectedPolicyDigest:value.expectedPolicyDigest,changes:{...(c.enabled===undefined?{}:{enabled:c.enabled as boolean}),...(c.renterPercent===undefined?{}:{renterPercent:referralPercent(c.renterPercent).percent}),...(c.ownerPercent===undefined?{}:{ownerPercent:referralPercent(c.ownerPercent).percent})},reason:value.reason.trim()};
}
/** Only the approved two rates and on/off state may change. Other economics stay on the pinned head. */
export function prepareDistributionPolicyChange(head:PolicyHead,input:DistributionPolicyChange):DistributionPolicyConfig{
 if(head.versionId!==input.expectedPolicyId||head.revision!==input.expectedRevision||head.digest!==input.expectedPolicyDigest)throw conflict('Distribution policy baseline changed');
 const original=head.config,c=input.changes;
 if(original.schema==='distribution-policy.v1'&&(c.renterPercent===undefined||c.ownerPercent===undefined))throw invalid('Adopting uniform policy requires both explicit rates; no historical grade fallback');
 const config=validateDistributionPolicy({schema:'distribution-policy.v2',scope:original.scope,enabled:c.enabled??original.enabled,participation:original.participation,depth:original.depth,selfRebate:original.selfRebate,accountModes:[...original.accountModes],minimumAccrualCents:original.minimumAccrualCents,settlementDelayDays:original.settlementDelayDays,rateMode:'UNIFORM',renterPercent:c.renterPercent??(original.schema==='distribution-policy.v2'?original.renterPercent:undefined),ownerPercent:c.ownerPercent??(original.schema==='distribution-policy.v2'?original.ownerPercent:undefined)},original.scope);
 if(canonicalize(config)===canonicalize(original))throw invalid('Distribution policy change is empty');
 return config;
}
