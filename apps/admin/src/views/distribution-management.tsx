import {useEffect,useRef,useState} from 'react';
import {AlertCircle,RefreshCw} from 'lucide-react';
import {AdminApiError,adminRequest,hasPermission,type SessionSnapshot} from '../api';
import {Alert,AlertDescription,AlertTitle} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Skeleton} from '@/components/ui/skeleton';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {parseDistributionPercent,type DistributionLevel} from './distribution-policy-model';
import {dashboardContextIdentity} from './distribution-dashboard-model';
import {DistributionUserName,distributionUserLabel} from './distribution-user-name';

type Snapshot=Extract<SessionSnapshot,{authenticated:true}>;
type ManagedConfig={schema:'distribution-policy.v4';levels:DistributionLevel[];levelNames:Record<string,string>};
type LevelRead={knowledge:'KNOWN'|'UNKNOWN';policy:null|{versionId:string;revision:string;managed:ManagedConfig};writeAssemblyReady:boolean};
type Participant={userId:string;name:string|null;eligibility:string;frozen:boolean|null;revision:string;levelCode:string|null;levelName:string|null;inviteCode:string|null;inviteCodeId:string|null};
type ParticipantsRead={items:Participant[];total:string|null;page:number;hasMore:boolean;writeAssemblyReady:boolean;freezeWriteReady?:boolean;policy:null|{versionId:string;revision:string;schema:string;levels:{code:string;name:string}[]}};
type Intent={actor:string;session:string;path:string;body:Record<string,unknown>;key:string};
const can=(snapshot:Snapshot,permission:string)=>snapshot.security.status==='ACTIVE'&&!snapshot.session.locked&&!snapshot.security.passwordChangeRequired&&(snapshot.security.isBoss||hasPermission(snapshot,permission));
const pathPattern=/^\/distribution\/manage\/(?:levels|participants\/[A-Za-z0-9._:-]+\/(?:level|code|freeze))$/;
const storageKey=(s:Snapshot)=>`zzsh.distribution.management.pending.${encodeURIComponent(s.adminUserId+'|'+s.session.id)}`;
function readIntent(snapshot:Snapshot):Intent|null|'unreadable'{
 try{
  const raw=sessionStorage.getItem(storageKey(snapshot));if(raw===null)return null;
  const value=JSON.parse(raw) as Intent;
  return value&&value.actor===snapshot.adminUserId&&value.session===snapshot.session.id&&typeof value.path==='string'&&pathPattern.test(value.path)
   &&typeof value.key==='string'&&/^idem_[a-f0-9]{32}$/.test(value.key)&&value.body!==null&&typeof value.body==='object'&&!Array.isArray(value.body)?value:'unreadable';
 }catch{return 'unreadable';}
}
const object=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** A bare HTTP 200 is not a matching original receipt. */
export function matchesDistributionManagementReceipt(intent:Intent,value:unknown):boolean{
 if(!object(value))return false;
 const match=/^\/distribution\/manage\/participants\/([A-Za-z0-9._:-]+)\/(level|code|freeze)$/.exec(intent.path);
 try{
  if(match?.[2]==='code')return value.userId===match[1]&&value.code===intent.body.code&&typeof value.codeId==='string'&&value.codeId!==intent.body.expectedCodeId;
  if(match?.[2]==='level')return value.userId===match[1]&&value.levelCode===intent.body.levelCode&&typeof intent.body.expectedParticipantRevision==='string'
   &&value.revision===(BigInt(intent.body.expectedParticipantRevision)+1n).toString();
  if(match?.[2]==='freeze')return value.userId===match[1]&&value.frozen===intent.body.frozen&&typeof intent.body.expectedParticipantRevision==='string'
   &&typeof value.changed==='boolean'&&value.revision===(BigInt(intent.body.expectedParticipantRevision)+(value.changed?1n:0n)).toString();
  if(intent.path!=='/distribution/manage/levels'||typeof intent.body.expectedRevision!=='string'||!object(intent.body.command)||!object(value.config)
   ||typeof value.versionId!=='string'||!value.versionId||value.revision!==(BigInt(intent.body.expectedRevision)+1n).toString()
   ||value.config.schema!=='distribution-policy.v4'||!Array.isArray(value.config.levels)||!value.config.levels.length
   ||value.config.levels.filter((level:any)=>level?.default===true).length!==1||!object(value.config.levelNames)||!Number.isInteger(value.reassigned)||value.reassigned<0)return false;
  const command=intent.body.command;
  if(command.action==='DELETE')return typeof command.code==='string'&&!value.config.levels.some((level:any)=>level.code===command.code);
  if(command.action!=='UPSERT')return false;
  return value.config.levels.some((level:any)=>object(level)&&typeof level.code==='string'&&(command.code===null||level.code===command.code)
   &&value.config.levelNames[level.code]===String(command.name).trim()&&level.rank===command.rank&&level.default===command.isDefault
   &&parseDistributionPercent(level.renterPercent)===parseDistributionPercent(command.renterPercent)
   &&parseDistributionPercent(level.ownerPercent)===parseDistributionPercent(command.ownerPercent));
 }catch{return false;}
}

/** Persist before sending and only retry the identical intent/key when the result is unknown. */
function useManagedCommand(snapshot:Snapshot,onSuccess:()=>void){
 const [pending,setPending]=useState<Intent|null|'unreadable'>(()=>readIntent(snapshot)),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const sending=useRef(false),identity=snapshot.adminUserId+'|'+snapshot.session.id,live=useRef(identity);live.current=identity;
 useEffect(()=>{setPending(readIntent(snapshot));setBusy(false);setNotice('');},[identity]);
 async function send(intent:Intent,retry:boolean){
  if(sending.current)return;sending.current=true;setBusy(true);setNotice('');
  try{
   const receipt=await adminRequest(intent.path,intent.body,'POST',{'idempotency-key':intent.key});
   if(live.current!==identity)return;
   if(!matchesDistributionManagementReceipt(intent,receipt))throw Error('原请求回执尚未匹配');
   const stored=readIntent(snapshot);if(stored==='unreadable'||stored?.key!==intent.key)throw Error('原请求本地记录异常，请核对操作日志');
   sessionStorage.removeItem(storageKey(snapshot));setPending(null);setNotice('已保存');onSuccess();
  }catch(error){
   if(live.current!==identity)return;
   if(!retry&&error instanceof AdminApiError&&error.status>=400&&error.status<500&&error.status!==408&&error.status!==429){
    try{if(readIntent(snapshot)!=='unreadable')sessionStorage.removeItem(storageKey(snapshot));setPending(null);}catch{setPending('unreadable');}
    setNotice(error.status===409?'资料已变化或输入与现有记录冲突，请刷新后核对':error.status===403?'当前账号没有执行权限':'输入或操作条件未满足，请检查后重试');
   }else setNotice('结果暂未确认。请查询原请求，不要重新提交其他修改。');
  }finally{sending.current=false;if(live.current===identity)setBusy(false);}
 }
 function submit(path:string,body:Record<string,unknown>){
  if(busy||pending!==null||!pathPattern.test(path))return;
  const intent:Intent={actor:snapshot.adminUserId,session:snapshot.session.id,path,body,key:`idem_${crypto.randomUUID().replaceAll('-','')}`};
  try{sessionStorage.setItem(storageKey(snapshot),JSON.stringify(intent));const saved=readIntent(snapshot);if(saved==='unreadable'||!saved||saved.key!==intent.key)throw Error();setPending(saved);void send(saved,false);}
  catch{setPending('unreadable');setNotice('无法安全保存原请求，暂未发送；请检查浏览器存储。');}
 }
 return{busy,pending,notice,submit,retry:()=>{if(pending&&pending!=='unreadable')void send(pending,true);}};
}
function CommandNotice({command,disabled=false}:{command:ReturnType<typeof useManagedCommand>;disabled?:boolean}){
 if(!command.notice&&!command.pending)return null;
 return <Alert variant={command.pending?'warning':'default'}><AlertCircle aria-hidden="true"/><AlertTitle>{command.pending?'操作结果待核对':command.notice}</AlertTitle>{command.pending?<AlertDescription>{command.pending==='unreadable'?'本地原请求记录不可读取，暂不能继续提交。':<>请使用原请求查询结果。<Button className="ml-2" size="sm" variant="outline" disabled={command.busy||disabled} onClick={command.retry}>查询原请求</Button></>}</AlertDescription>:null}</Alert>;
}
function loadError(error:unknown){return error instanceof AdminApiError&&error.status===403?'当前身份没有相应权限':error instanceof AdminApiError&&error.status===503?'管理能力或数据库结构尚未就绪':'读取失败，请刷新后重试';}

type LevelDraft={mode:'edit'|'delete';code:string|null;name:string;rank:string;renter:string;owner:string;isDefault:boolean;reason:string};
export function DistributionLevelManager({snapshot,onChanged}:{snapshot:Snapshot;onChanged?:()=>void}){
 return <DistributionLevelManagerBody key={dashboardContextIdentity(snapshot)} snapshot={snapshot} onChanged={onChanged}/>;
}
function DistributionLevelManagerBody({snapshot,onChanged}:{snapshot:Snapshot;onChanged?:()=>void}){
 const [read,setRead]=useState<LevelRead|null>(null),[error,setError]=useState(''),[nonce,setNonce]=useState(0),[draft,setDraft]=useState<LevelDraft|null>(null);
 const allowed=can(snapshot,'distribution.level.manage'),command=useManagedCommand(snapshot,()=>{setDraft(null);setNonce(n=>n+1);onChanged?.();});
 useEffect(()=>{if(!allowed)return;const controller=new AbortController();setRead(null);setError('');
  void adminRequest<LevelRead>('/distribution/manage/levels',undefined,'GET',{},controller.signal).then(setRead).catch(e=>{if(!controller.signal.aborted)setError(loadError(e));});return()=>controller.abort();},[allowed,nonce,snapshot.adminUserId,snapshot.session.id]);
 if(!allowed)return null;
 const head=read?.knowledge==='KNOWN'?read.policy:null,config=head?.managed,disabled=!read?.writeAssemblyReady||command.busy||command.pending!==null;
 const edit=(level?:DistributionLevel)=>setDraft({mode:'edit',code:level?.code??null,name:level&&config?config.levelNames[level.code]??level.code:'',rank:level?String(level.rank):String(Math.max(0,...(config?.levels.map(item=>item.rank)??[]))+1),renter:level?.renterPercent??'0',owner:level?.ownerPercent??'0',isDefault:level?.default??false,reason:''});
 const change=(part:Partial<LevelDraft>)=>setDraft(current=>current?{...current,...part}:null);
 function save(){if(!head||!draft)return;const levelCommand=draft.mode==='delete'?{action:'DELETE',code:draft.code}:{action:'UPSERT',code:draft.code,name:draft.name,rank:Number(draft.rank),renterPercent:draft.renter,ownerPercent:draft.owner,isDefault:draft.isDefault};
  command.submit('/distribution/manage/levels',{expectedPolicyId:head.versionId,expectedRevision:head.revision,command:levelCommand,reason:draft.reason});}
 return <section className="space-y-4 border-b border-border pb-6" data-distribution-level-management>
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">分销等级</h2><p className="mt-1 text-sm text-muted-foreground">调整等级名称和佣金比例，直接用于后续付款的订单；已付款订单沿用原规则。</p></div><div className="flex gap-2"><Button variant="outline" onClick={()=>setNonce(n=>n+1)}><RefreshCw aria-hidden="true"/>刷新</Button><Button disabled={!config||disabled} onClick={()=>edit()}>新增等级</Button></div></div>
  <CommandNotice command={command}/>{error?<Alert variant="warning"><AlertCircle/><AlertTitle>等级暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>:null}
  {!read&&!error?<Skeleton className="h-28 w-full"/>:null}
  {read&&!read.writeAssemblyReady?<p className="text-sm text-muted-foreground">当前环境未启用等级维护，暂可查看。</p>:null}
  {config?<div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>等级</TableHead><TableHead>排序</TableHead><TableHead>邀请租客</TableHead><TableHead>邀请号主</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{[...config.levels].sort((a,b)=>a.rank-b.rank).map(level=><TableRow key={level.code}><TableCell>{config.levelNames[level.code]??level.code} {level.default?<Badge variant="secondary">默认</Badge>:null}</TableCell><TableCell>{level.rank}</TableCell><TableCell>{level.renterPercent}%</TableCell><TableCell>{level.ownerPercent}%</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" disabled={disabled} onClick={()=>edit(level)}>编辑</Button><Button variant="ghost" size="sm" disabled={disabled||level.default} onClick={()=>setDraft({mode:'delete',code:level.code,name:config.levelNames[level.code]??level.code,rank:'',renter:'',owner:'',isDefault:false,reason:''})}>删除</Button></TableCell></TableRow>)}</TableBody></Table></div>:read&&!head?<p className="text-sm text-muted-foreground">尚未取得当前分销政策。</p>:null}
  {draft?<div className="space-y-4 rounded-xl border border-border p-4"><h3 className="font-semibold">{draft.mode==='delete'?`删除「${draft.name}」`:draft.code?'编辑等级':'新增等级'}</h3>
   {draft.mode==='delete'?<p className="text-sm text-muted-foreground">删除后，当前使用此等级的用户将调整为默认等级；历史订单的佣金规则保持原样。</p>:<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <label className="space-y-1 text-sm">等级名称<Input value={draft.name} maxLength={100} onChange={e=>change({name:e.target.value})}/></label><label className="space-y-1 text-sm">排序<Input value={draft.rank} inputMode="numeric" onChange={e=>change({rank:e.target.value})}/></label>
    <label className="space-y-1 text-sm">邀请租客比例（%）<Input value={draft.renter} inputMode="decimal" onChange={e=>change({renter:e.target.value})}/></label><label className="space-y-1 text-sm">邀请号主比例（%）<Input value={draft.owner} inputMode="decimal" onChange={e=>change({owner:e.target.value})}/></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.isDefault} onChange={e=>change({isDefault:e.target.checked})}/>设为默认等级</label></div>}
   <label className="block max-w-xl space-y-1 text-sm">变更原因<Input value={draft.reason} maxLength={500} onChange={e=>change({reason:e.target.value})} placeholder="填写至少 3 个字"/></label>
   <div className="flex gap-2"><Button disabled={disabled||draft.reason.trim().length<3||draft.mode==='edit'&&(!draft.name.trim()||!/^\d+$/.test(draft.rank))} onClick={save}>{draft.mode==='delete'?'确认删除':'保存等级'}</Button><Button variant="outline" disabled={command.busy||command.pending!==null} onClick={()=>setDraft(null)}>取消</Button></div>
  </div>:null}
 </section>;
}

export type ParticipantManagementAction='level'|'code'|'freeze';
type ParticipantManagerProps={snapshot:Snapshot;initialUserId?:string;onOpenUser?:(userId:string)=>void;directAction?:ParticipantManagementAction;onChanged?:()=>void;onClose?:()=>void};

export function DistributionParticipantManager(props:ParticipantManagerProps){
 return <DistributionParticipantManagerBody key={dashboardContextIdentity(props.snapshot)+'|'+(props.initialUserId??'')+'|'+(props.directAction??'')} {...props}/>;
}
function DistributionParticipantManagerBody({snapshot,initialUserId,onOpenUser,directAction,onChanged,onClose}:ParticipantManagerProps){
 const [q,setQ]=useState(initialUserId??''),[search,setSearch]=useState(initialUserId??''),[page,setPage]=useState(1),[nonce,setNonce]=useState(0),[read,setRead]=useState<ParticipantsRead|null>(null),[error,setError]=useState('');
 const [chosen,setChosen]=useState<Participant|null>(null),[newLevel,setNewLevel]=useState(''),[newCode,setNewCode]=useState(''),[reason,setReason]=useState('');
 const allowed=can(snapshot,'distribution.participant.read'),mayChange=can(snapshot,'distribution.participant.manage'),canDirectory=can(snapshot,'user.directory.read');
 const command=useManagedCommand(snapshot,()=>{setChosen(null);setReason('');setNonce(n=>n+1);onChanged?.();});
 useEffect(()=>{if(!allowed)return;const controller=new AbortController();setRead(null);setError('');
  void adminRequest<ParticipantsRead>('/distribution/manage/participants?'+new URLSearchParams({q:search,page:String(page)}),undefined,'GET',{},controller.signal).then(setRead).catch(e=>{if(!controller.signal.aborted)setError(loadError(e));});return()=>controller.abort();},[allowed,search,page,nonce,snapshot.adminUserId,snapshot.session.id]);
 const directTarget=directAction&&initialUserId?read?.items.find(item=>item.userId===initialUserId)??null:null;
 useEffect(()=>{if(directTarget){setNewLevel(directTarget.levelCode??'');setNewCode(directTarget.inviteCode??'');setReason('');}},[directTarget]);
 if(!allowed)return null;
 const selected=directAction?directTarget:chosen,disabled=!mayChange||!read?.writeAssemblyReady||command.busy||command.pending!==null;
 const select=(item:Participant)=>{setChosen(item);setNewLevel(item.levelCode??'');setNewCode(item.inviteCode??'');setReason('');};
 const saveLevel=()=>{if(!selected||!read?.policy)return;command.submit(`/distribution/manage/participants/${encodeURIComponent(selected.userId)}/level`,{expectedPolicyId:read.policy.versionId,expectedPolicyRevision:read.policy.revision,expectedParticipantRevision:selected.revision,levelCode:newLevel,reason});};
 const saveCode=()=>{if(!selected?.inviteCodeId)return;command.submit(`/distribution/manage/participants/${encodeURIComponent(selected.userId)}/code`,{expectedCodeId:selected.inviteCodeId,code:newCode,reason});};
 const saveFreeze=()=>{if(!selected||selected.frozen===null||!read?.freezeWriteReady)return;command.submit(`/distribution/manage/participants/${encodeURIComponent(selected.userId)}/freeze`,{expectedParticipantRevision:selected.revision,frozen:!selected.frozen,reason});};
 const showLevel=!directAction||directAction==='level',showCode=!directAction||directAction==='code';
 const actionButtons=(label:string,onClick:()=>void,blocked:boolean,destructive=false)=><div className={directAction?'flex justify-end gap-2':'flex gap-2'}>{directAction&&onClose?<Button variant="outline" disabled={command.busy} onClick={onClose}>取消</Button>:null}<Button variant={destructive?'destructive':'default'} disabled={blocked} onClick={onClick}>{label}</Button></div>;
 return <section className={directAction?'space-y-4':'space-y-4 rounded-xl border border-border p-4'} data-distribution-participant-management>
  {!directAction?<><div><h2 className="text-lg font-semibold">维护分销参与人</h2><p className="mt-1 text-sm text-muted-foreground">按用户查找并调整分销等级或邀请码，原邀请关系和历史佣金保留。</p></div>
   <form className="flex flex-wrap gap-2" onSubmit={event=>{event.preventDefault();setChosen(null);setPage(1);setSearch(q.trim());}}><Input aria-label="搜索参与人" className="max-w-sm" value={q} onChange={e=>setQ(e.target.value)} placeholder="用户 ID 或昵称"/><Button type="submit" variant="outline">查找</Button></form></>:null}
  <CommandNotice command={command} disabled={!mayChange||!read?.writeAssemblyReady}/>{error?<Alert variant="warning"><AlertCircle/><AlertTitle>参与人暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>:null}
  {!read&&!error?<Skeleton className="h-28 w-full"/>:null}
  {read&&!read.writeAssemblyReady?<p className="text-sm text-muted-foreground">当前环境未启用参与人维护，暂可查看。</p>:null}
  {directAction&&read&&!selected?<p className="text-sm text-muted-foreground">未找到当前用户的分销资料，请刷新列表后重试。</p>:null}
  {!directAction&&read?<><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>用户</TableHead><TableHead>等级</TableHead><TableHead>邀请码</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{read.items.map(item=><TableRow key={item.userId}><TableCell><DistributionUserName userId={item.userId} name={item.name} canOpen={canDirectory&&Boolean(onOpenUser)} onOpen={()=>onOpenUser?.(item.userId)}/>{item.frozen?<Badge className="ml-2" variant="secondary">佣金冻结</Badge>:null}</TableCell><TableCell>{item.levelName??(item.levelCode?'待核对':'未设置')}</TableCell><TableCell>{item.inviteCode??'待核对'}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" onClick={()=>select(item)}>维护</Button></TableCell></TableRow>)}</TableBody></Table></div>{!read.items.length?<p className="py-4 text-center text-sm text-muted-foreground">没有找到匹配用户，试试其他用户 ID 或昵称。</p>:null}<div className="flex items-center gap-3 text-sm"><Button variant="outline" size="sm" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页</Button><span>第 {page} 页{read.total!==null?` · 共 ${read.total} 人`:''}</span><Button variant="outline" size="sm" disabled={!read.hasMore} onClick={()=>setPage(p=>p+1)}>下一页</Button></div></>:null}
  {selected?<div className={directAction?'space-y-4':'space-y-4 border-t border-border pt-4'}>
   {!directAction?<div className="flex items-center justify-between gap-3"><h3 className="font-semibold">维护 {distributionUserLabel(selected.name,selected.userId)}</h3><Button variant="ghost" size="sm" onClick={()=>setChosen(null)}>关闭</Button></div>:null}
   <label className="block max-w-xl space-y-1 text-sm">变更原因<Input value={reason} maxLength={500} onChange={e=>setReason(e.target.value)} placeholder="填写至少 3 个字"/></label>
   <div className={!directAction?'grid gap-5 md:grid-cols-2':'space-y-4'}>
    {showLevel?<div className="space-y-2"><label className="block text-sm">分销等级</label><Select value={newLevel} onValueChange={value=>setNewLevel(value??'')}><SelectTrigger aria-label="选择分销等级" className={directAction?'w-full':'min-w-44'}><SelectValue>{read?.policy?.levels.find(level=>level.code===newLevel)?.name??(newLevel?'等级待核对':'选择等级')}</SelectValue></SelectTrigger><SelectContent>{read?.policy?.levels.map(level=><SelectItem key={level.code} value={level.code}>{level.name}</SelectItem>)}</SelectContent></Select>{read?.policy?.schema==='distribution-policy.v2'?<p className="text-xs text-muted-foreground">请先在分销政策中保存等级配置。</p>:null}{actionButtons('保存等级',saveLevel,disabled||reason.trim().length<3||!newLevel||newLevel===selected.levelCode||read?.policy?.schema==='distribution-policy.v2')}</div>:null}
    {showCode?<div className="space-y-2"><label className="block text-sm">邀请码</label><Input aria-label="邀请码" value={newCode} maxLength={30} onChange={e=>setNewCode(e.target.value)}/><p className="text-xs text-muted-foreground">保存后旧码立即失效，且不会再分配给其他用户。</p>{actionButtons('保存邀请码',saveCode,disabled||reason.trim().length<3||!selected.inviteCodeId||!/^[A-Za-z0-9_-]{1,30}$/.test(newCode)||newCode.toUpperCase()===selected.inviteCode?.toUpperCase())}</div>:null}
    {!directAction||directAction==='freeze'?<div className="space-y-3"><p className="text-sm">冻结状态：{selected.frozen===null?'待核对':selected.frozen?'已冻结':'未冻结'}</p><p className="text-sm text-muted-foreground">冻结后，后续付款不会产生该分销商的新佣金；已付款订单的依据、已有佣金及邀请关系不变。</p>{!read?.freezeWriteReady?<p className="text-sm text-muted-foreground">当前环境尚未启用资格维护。</p>:null}{actionButtons(selected.frozen?'解除冻结':'冻结资格',saveFreeze,disabled||!read?.freezeWriteReady||selected.frozen===null||reason.trim().length<3,!selected.frozen)}</div>:null}
   </div>
  </div>:null}
 </section>;
}
