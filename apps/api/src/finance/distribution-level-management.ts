import {randomUUID} from 'node:crypto';
import {ensureOnlyFields,invalid,conflict} from '../supply/supply-util';
import {validateDistributionPolicy,usesLegacyRentalDistributionBase,type DistributionPolicyConfig} from './distribution-policy';

type ManagedPolicy=Extract<DistributionPolicyConfig,{schema:'distribution-policy.v4'}>;
export type LevelCommand={action:'UPSERT';code:string|null;name:string;rank:number;renterPercent:string;ownerPercent:string;isDefault:boolean}|{action:'DELETE';code:string};

/** Version conversion keeps original policies untouched and retains their economic base. */
export function managedDistributionPolicy(previous:DistributionPolicyConfig):ManagedPolicy{
 if(previous.schema==='distribution-policy.v4')return previous;
 if(previous.schema==='distribution-policy.v2')return validateDistributionPolicy({
  schema:'distribution-policy.v4',scope:previous.scope,enabled:previous.enabled,participation:previous.participation,depth:previous.depth,selfRebate:previous.selfRebate,
  accountModes:previous.accountModes,minimumAccrualCents:previous.minimumAccrualCents,settlementDelayDays:previous.settlementDelayDays,
  levels:[{code:'level_default',rank:1,default:true,renterPercent:previous.renterPercent,ownerPercent:previous.ownerPercent,upgrade:null}],
  levelNames:{level_default:'默认等级'},baseMode:'PLATFORM_CONTRIBUTION',
 },previous.scope) as ManagedPolicy;
 const {schema:_,...common}=previous;
 const {legacySource:__,...plain}=common as typeof common & {legacySource?:unknown};
 const levelNames=previous.schema==='distribution-policy.v3'?previous.legacySource.levelNames:Object.fromEntries(previous.levels.map(level=>[level.code,level.code]));
 return validateDistributionPolicy({...plain,schema:'distribution-policy.v4',levelNames,baseMode:usesLegacyRentalDistributionBase(previous)?'LEGACY_RENTAL':'PLATFORM_CONTRIBUTION'},previous.scope) as ManagedPolicy;
}

export function parseLevelCommand(body:Record<string,unknown>):LevelCommand{
 if(body.action==='DELETE'){
  ensureOnlyFields(body,['action','code']);
  if(typeof body.code!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.code))throw invalid('Exact level code required');
  return{action:'DELETE',code:body.code};
 }
 ensureOnlyFields(body,['action','code','name','rank','renterPercent','ownerPercent','isDefault']);
 if(body.action!=='UPSERT'||body.code!==null&&(typeof body.code!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.code))
  ||typeof body.name!=='string'||body.name.trim().length<1||body.name.trim().length>100
  ||typeof body.rank!=='number'||!Number.isInteger(body.rank)||body.rank<1||body.rank>999
  ||typeof body.renterPercent!=='string'||typeof body.ownerPercent!=='string'||typeof body.isDefault!=='boolean')throw invalid('Complete level details required');
 return{action:'UPSERT',code:body.code as string|null,name:body.name.trim(),rank:body.rank,renterPercent:body.renterPercent,ownerPercent:body.ownerPercent,isDefault:body.isDefault};
}

/** Deleted codes are not reused, and the caller atomically remaps existing participants. */
export function applyLevelCommand(previous:DistributionPolicyConfig,command:LevelCommand,newCode=()=>`level_${randomUUID().replaceAll('-','')}`){
 const config=managedDistributionPolicy(previous),levels=config.levels.map(level=>({...level})),names={...config.levelNames};
 let removedCode:string|null=null;
 if(command.action==='DELETE'){
  const index=levels.findIndex(level=>level.code===command.code);
  if(index<0)throw conflict('Level no longer exists');
  if(levels[index]!.default)throw conflict('Default level cannot be deleted');
  levels.splice(index,1);delete names[command.code];removedCode=command.code;
 }else{
  const code=command.code??newCode(),index=levels.findIndex(level=>level.code===code);
  if(command.code!==null&&index<0)throw conflict('Level no longer exists');
  if(command.code===null&&index>=0)throw conflict('Level identifier collision');
  if(index>=0&&levels[index]!.default&&!command.isDefault)throw conflict('Choose another default level first');
  if(command.isDefault)for(const level of levels)level.default=false;
  const upgrade=command.isDefault?null:index>=0?levels[index]!.upgrade:null;
  const next={code,rank:command.rank,default:command.isDefault,renterPercent:command.renterPercent,ownerPercent:command.ownerPercent,upgrade};
  if(index<0)levels.push(next);else levels[index]=next;
  names[code]=command.name;
 }
 const validated=validateDistributionPolicy({...config,levels,levelNames:names},config.scope) as ManagedPolicy;
 return{config:validated,removedCode,defaultCode:validated.levels.find(level=>level.default)!.code};
}
