import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Clock3, ChevronDown, FilePenLine, RefreshCw } from 'lucide-react';
import { AdminApiError, adminRequest, formatDate, hasPermission, type SessionSnapshot } from '../api';
import { directoryScopeOf } from '../workspace/admin-directory-read';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { inspectPending, pendingWriteSubject, savePendingWrite, dropPendingWrite, updatePendingWriteKind, type PendingApprovalWrite, type PendingInspection } from './approval/pending-writes';
import { receiptEnvelopeIssue, type OperationEntry, type RequestDetail, type RecoveryResult } from './approval/contract';
import { buildDistributionPolicyPayload, distributionCentsLabel, parseDistributionPolicyRead, sameDistributionProposal, type DistributionPolicyRead, type PolicyHead, type DistributionPolicyPayload } from './distribution-policy-model';
export { parseDistributionPolicyRead } from './distribution-policy-model';
export type { DistributionLevel, DistributionPolicyConfig, DistributionPolicyRead } from './distribution-policy-model';

function historicalUpgradeLabel(value:import('./distribution-policy-model').DistributionLevel['upgrade']){
 if(value===null)return '未设置自动升级';
 const names:Record<string,string>={LAST_PAID_AMOUNT:'最近一次付款',TOTAL_PAID_AMOUNT:'累计付款',PAID_COUNT:'付款次数',SETTLED_REFERRAL:'已结佣金'};
 return (value.match==='ALL'?'全部满足：':'任一满足：')+value.conditions.map(c=>(names[c.metric]??'原条件')+' ≥ '+(c.metric==='PAID_COUNT'?c.value+'次':distributionCentsLabel(c.value))).join('；');
}
type Snapshot=Extract<SessionSnapshot,{authenticated:true}>;
const OP='distribution.policy.publish',TRIGGER='distribution.policy.publish.requested',CREATE='/security/approvals/requests',CREATE_OP='approval.request.create';
export const DISTRIBUTION_POLICY_READ='personal.distribution.policy.read',DISTRIBUTION_POLICY_MANAGE='personal.distribution.policy.manage';
export function distributionPolicyAccess(snapshot:Snapshot){const canManage=snapshot.security.isBoss||hasPermission(snapshot,DISTRIBUTION_POLICY_MANAGE);return{canRead:canManage||hasPermission(snapshot,DISTRIBUTION_POLICY_READ),canManage};}
export function readDistributionPolicyAdmin(signal?:AbortSignal){return adminRequest<unknown>('/distribution/policy',undefined,'GET',{},signal).then(parseDistributionPolicyRead);}
type View={scope:string;status:'loading'|'ready'|'error';read:DistributionPolicyRead|null;error:string;operation:OperationEntry|null};
type Draft={head:PolicyHead;enabled:boolean;renter:string;owner:string;reason:string};
const blank=(scope:string):View=>({scope,status:'loading',read:null,error:'',operation:null});
const errorText=(e:unknown)=>e instanceof AdminApiError?(e.status===403?'当前身份无权读取这项记录':e.status===409?'政策或可见范围已经变化，请刷新后核对':e.status===404||e.status===503?'分销接口尚未就绪，已有记录不会按零或默认比例补齐':'读取暂未完成，请保留当前输入后重试'):'读取暂未完成，请保留当前输入后重试';
const requestPath=(id:string)=>'/approvals?'+new URLSearchParams({requestId:id,from:'distribution-policy'});

export function DistributionPolicyPanel({snapshot,onOpenPath,onDirtyChange}:{snapshot:Snapshot;onOpenPath?:(path:string,title?:string)=>void;onDirtyChange?:(dirty:boolean)=>void}){
 const identity=snapshot.adminUserId+'|'+snapshot.session.id,access=distributionPolicyAccess(snapshot),scope=directoryScopeOf(snapshot),subject=pendingWriteSubject(snapshot.adminUserId,snapshot.session.id,'',CREATE_OP);
 const live=useRef(scope);live.current=scope;const dirtyChange=useRef(onDirtyChange);dirtyChange.current=onDirtyChange;const generation=useRef(0),readSequence=useRef(0),sending=useRef(false);
 const [stored,setStored]=useState<View>(()=>blank(scope)),view=stored.scope===scope?stored:blank(scope);
 const [draft,setDraft]=useState<Draft|null>(null),[discard,setDiscard]=useState(false),[notice,setNotice]=useState(''),[pending,setPending]=useState<PendingInspection>(()=>inspectPending(subject)),[knownRequest,setKnownRequest]=useState<{identity:string;id:string}|null>(null),[busy,setBusy]=useState(false);
 const knownRequestId=knownRequest?.identity===identity?knownRequest.id:null;const setKnownRequestId=(id:string)=>setKnownRequest({identity,id});
 const current=(owner:string,gen:number)=>live.current===owner&&generation.current===gen;
 const update=(owner:string,gen:number,p:Partial<View>)=>{if(current(owner,gen))setStored(v=>({...v,...p}));};
 const refreshPending=()=>setPending(inspectPending(subject));
 async function load(owner:string,gen:number,signal?:AbortSignal){const seq=++readSequence.current;try{const read=await readDistributionPolicyAdmin(signal);if(seq===readSequence.current&&current(owner,gen)){update(owner,gen,{read,status:'ready',error:''});if(read.changeContext?.request?.requestId)setKnownRequestId(read.changeContext.request.requestId);}}catch(e){if(!signal?.aborted&&seq===readSequence.current)update(owner,gen,{status:'error',error:errorText(e)});}}
 async function verifyOriginal(id:string,record:PendingApprovalWrite,owner:string,gen:number){
  const detail=await adminRequest<RequestDetail>('/security/approvals/requests/detail?requestId='+encodeURIComponent(id));
  if(!current(owner,gen))return;
  if(detail.requestId!==id||detail.operation?.code!==OP||!sameDistributionProposal(detail.operation.payload,record.body.payload))throw Error('原申请与这次分销变更尚未匹配，原请求记录保留');
  dropPendingWrite(subject,record.idempotencyKey);refreshPending();setKnownRequestId(id);setNotice('申请记录已核对；审批与执行进度请查看原申请');void load(owner,gen);
 }
 async function recover(owner=scope,gen=generation.current){
  const original=inspectPending(subject);if(original.state!=='valid'||original.record.body.operationCode!==OP||sending.current)return;
  sending.current=true;if(current(owner,gen))setBusy(true);
  try{const record=original.record,result=await adminRequest<RecoveryResult>('/security/approvals/recovery?'+new URLSearchParams({operation:CREATE_OP,key:record.idempotencyKey}));
   if(!current(owner,gen))return;if(result.knowledge!=='KNOWN')throw Error('原结果尚未核清，没有回执不代表未提交');
   const issue=receiptEnvelopeIssue(result,{key:record.idempotencyKey,operation:CREATE_OP,target:null});if(issue)throw Error(issue);
   if(result.outcome==='REJECTED'){if(record.kind==='readback')throw Error('原受理信息与回执冲突，原请求记录保留');dropPendingWrite(subject,record.idempotencyKey);refreshPending();setNotice('原创建请求已明确拒绝，核对原因后可重新办理');return;}
   const id=result.receipt?.approvalRequestId;if(!id)throw Error('原申请编号尚未取得，原记录保留');
   setKnownRequestId(id);updatePendingWriteKind(subject,record.idempotencyKey,'readback');refreshPending();await verifyOriginal(id,record,owner,gen);
  }catch(e){if(current(owner,gen))setNotice(e instanceof Error&&!(e instanceof AdminApiError)?e.message:errorText(e));}
  finally{if(current(owner,gen)){sending.current=false;setBusy(false);}}
 }
 useEffect(()=>{const gen=++generation.current,controller=new AbortController();sending.current=false;setStored(blank(scope));setDraft(null);setNotice('');setBusy(false);setPending(inspectPending(subject));
  if(access.canRead)void load(scope,gen,controller.signal);
  if(access.canManage&&hasPermission(snapshot,'approval.request.create'))void adminRequest<{operations?:OperationEntry[]}>('/security/approvals/operations',undefined,'GET',{},controller.signal).then(v=>{const op=Array.isArray(v.operations)?v.operations.find(o=>o.operationCode===OP):null;update(scope,gen,{operation:op&&typeof op.initiation?.allowed==='boolean'&&Array.isArray(op.triggers)?op:null});}).catch(()=>{if(!controller.signal.aborted)update(scope,gen,{operation:null});});
  const existing=inspectPending(subject);if(existing.state==='valid'&&existing.record.body.operationCode===OP)void recover(scope,gen);
  return()=>{controller.abort();generation.current++;dirtyChange.current?.(false);};
 },[scope]);
 useEffect(()=>{dirtyChange.current?.(draft!==null);},[draft]);
 const head=view.read?.knowledge==='KNOWN'?view.read.policy:null,context=view.read?.changeContext;
 const operationReady=view.operation?.initiation.allowed===true&&view.operation.triggers.some(t=>t.triggerCondition===TRIGGER);
 const canRequest=access.canManage&&hasPermission(snapshot,'approval.request.create')&&operationReady&&context?.state==='EMPTY'&&context.contractReady&&context.writeAssemblyReady&&pending.state==='absent';
 const activeRequest=context?.request?.requestId??knownRequestId;
 const openRequest=(id:string)=>onOpenPath?onOpenPath(requestPath(id),'分销政策申请'):window.location.assign(requestPath(id));
 const originalAction=knownRequestId?<Button variant='outline' size='sm' onClick={()=>openRequest(knownRequestId)}>查看原申请</Button>:pending.state==='valid'&&pending.record.subject===subject?<Button variant='outline' size='sm' onClick={()=>onOpenPath?onOpenPath('/approvals?tab=mine'):window.location.assign('/approvals?tab=mine')}>到审批中心核对原请求</Button>:null;
 async function submit(payload:DistributionPolicyPayload){
  if(!canRequest||sending.current||!head)return;const owner=scope,gen=generation.current;
  if(payload.expectedPolicyId!==head.versionId||payload.expectedRevision!==head.revision||payload.expectedPolicyDigest!==head.digest){setNotice('当前政策已变化，本次未提交；请核对后重新编辑');return;}
  if(!globalThis.crypto?.randomUUID){setNotice('无法生成原请求标识，本次未提交');return;}
  const idempotencyKey='idem_'+crypto.randomUUID().replaceAll('-',''),body={operationCode:OP,triggerCondition:TRIGGER,payloadVersion:1,payload,summary:'调整全站分销政策'};
  const saved=savePendingWrite({actorId:snapshot.adminUserId,sessionId:snapshot.session.id,target:'',operation:CREATE_OP,path:CREATE,idempotencyKey,body,readback:{kind:'lists',keys:['mine']},successMessage:'分销变更申请已受理',kind:'unknown'});
  if(!saved.ok){refreshPending();setNotice('无法可靠保存原请求，本次没有提交');return;}
  sending.current=true;setBusy(true);refreshPending();setNotice('');
  try{const result=await adminRequest<{approvalRequestId?:string;requestId?:string}>(CREATE,body,'POST',{'idempotency-key':idempotencyKey});if(!current(owner,gen))return;const id=result.approvalRequestId??result.requestId;if(!id)throw Error('请求已返回，原申请编号尚未核清');setKnownRequestId(id);updatePendingWriteKind(subject,idempotencyKey,'readback');refreshPending();setDraft(null);await verifyOriginal(id,saved.record,owner,gen);}
  catch(e){if(current(owner,gen))setNotice(e instanceof Error&&!(e instanceof AdminApiError)?e.message:'原请求结果待核对，请查询原结果，不能重新发起');}
  finally{if(current(owner,gen)){sending.current=false;setBusy(false);}}
 }
 if(!access.canRead)return <Alert variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>当前管理员没有分销政策权限</AlertTitle><AlertDescription>政策读取与本单分销查询分别授权。</AlertDescription>{originalAction?<AlertAction>{originalAction}</AlertAction>:null}</Alert>;
 if(view.status==='loading')return <p role="status" className="text-sm text-muted-foreground">正在读取分销政策…</p>;
 if(view.status==='error'||!view.read)return <Alert variant="destructive"><CircleAlert aria-hidden="true"/><AlertTitle>分销政策暂未读到</AlertTitle><AlertDescription>{view.error}</AlertDescription><AlertAction><Button variant="outline" onClick={()=>void load(scope,generation.current)}>重新读取</Button>{originalAction}</AlertAction></Alert>;
 if(!head)return <Alert variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>尚未取得当前分销政策</AlertTitle><AlertDescription>不采用默认比例，也不能据此判断为已关闭。</AlertDescription>{originalAction?<AlertAction>{originalAction}</AlertAction>:null}</Alert>;
 const config=head.config,foreign=pending.state==='valid'&&pending.record.body.operationCode!==OP;
 const pendingMessage=pending.state==='unreadable'?'原请求记录暂时不可读，新提交已暂停':pending.state==='valid'?(foreign?'还有其他审批创建请求待核对，请先到审批中心处理':'这次分销申请的原结果仍待核对'):context?.state==='PENDING'?(context.request?'已有分销政策变更等待处理':'已有分销政策变更；当前身份无权查看申请详情'):context?.state==='UNAVAILABLE'||!context?'暂未取得政策变更状态，不能视为没有申请':!context.contractReady||!context.writeAssemblyReady?'政策提审与执行能力待接入，当前保持只读':!operationReady?'当前身份暂不能发起分销政策申请':'';
 return <section className="space-y-5" data-distribution-policy>
  <header className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold">当前分销政策</h2><Badge variant={config.enabled?'success':'secondary'}>{config.enabled?'已开启':'已关闭'}</Badge></div><p className="mt-1 text-sm text-muted-foreground">分别查看推荐租客、推荐号主产生的奖励规则。</p></div><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={()=>void load(scope,generation.current)}><RefreshCw aria-hidden="true"/>刷新政策</Button><Button disabled={!canRequest||busy} onClick={()=>{setNotice('');setDraft({head,enabled:config.enabled,renter:config.schema==='distribution-policy.v2'?config.renterPercent:'',owner:config.schema==='distribution-policy.v2'?config.ownerPercent:'',reason:''});}}><FilePenLine aria-hidden="true"/>申请调整政策</Button></div></header>
  {(notice||pendingMessage)&&<Alert variant="warning"><Clock3 aria-hidden="true"/><AlertTitle>{notice||pendingMessage}</AlertTitle><AlertDescription>{context?.request?<span>提交人 {context.request.requesterName??'资料未提供'} · 提交 {formatDate(context.request.createdAt)} · {context.request.status==='PENDING'?'等待Boss审批':context.request.status==='APPROVED'?'已批准，等待执行':'执行未完成，需处理原申请'}{context.request.deciderName?` · 审批人 ${context.request.deciderName}`:''}{context.request.decidedAt?` · 审批 ${formatDate(context.request.decidedAt)}`:''}</span>:<span>当前权益按原政策运行；审批通过与实际执行分别核对。</span>}</AlertDescription><AlertAction>{pending.state==='valid'&&!foreign?<Button variant="outline" size="sm" disabled={busy} onClick={()=>void recover()}>查询原结果</Button>:null}{activeRequest?<Button variant="outline" size="sm" onClick={()=>openRequest(activeRequest)}>查看原申请</Button>:pending.state!=='absent'?<Button variant="outline" size="sm" onClick={()=>onOpenPath?onOpenPath('/approvals?tab=mine'):window.location.assign('/approvals?tab=mine')}>前往审批中心</Button>:null}</AlertAction></Alert>}
  {config.schema==='distribution-policy.v2'?<div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border p-4"><p className="text-sm text-muted-foreground">推荐租客奖励比例</p><p className="mt-2 text-2xl font-semibold tabular-nums">{config.renterPercent}%</p></div><div className="rounded-xl border p-4"><p className="text-sm text-muted-foreground">推荐号主奖励比例</p><p className="mt-2 text-2xl font-semibold tabular-nums">{config.ownerPercent}%</p></div></div>:<Collapsible><CollapsibleTrigger render={<Button variant="outline" className="w-full justify-between"/>}>当前记录为历史分级方案<ChevronDown aria-hidden="true"/></CollapsibleTrigger><CollapsibleContent><p className="my-3 text-sm text-muted-foreground">保留原比例供核对；新的统一方案必须明确填写两类比例，不从旧默认等级推定。</p><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>历史等级</TableHead><TableHead>推荐租客</TableHead><TableHead>推荐号主</TableHead><TableHead>原升级规则</TableHead></TableRow></TableHeader><TableBody>{config.levels.map(level=><TableRow key={level.code}><TableCell>{level.code}{level.default?' · 原默认':''}</TableCell><TableCell>{level.renterPercent}%</TableCell><TableCell>{level.ownerPercent}%</TableCell><TableCell>{historicalUpgradeLabel(level.upgrade)}</TableCell></TableRow>)}</TableBody></Table></div></CollapsibleContent></Collapsible>}
  <dl className="grid gap-x-8 gap-y-4 border-y py-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">计佣口径</dt><dd className="mt-1">原结算平台分量扣除补偿费后，按付款冻结比例计算</dd></div><div><dt className="text-muted-foreground">适用租赁方式</dt><dd className="mt-1">{config.accountModes.map(m=>m==='ordinary'?'普通租赁':'自定义方案').join('、')}；极速不计佣</dd></div><div><dt className="text-muted-foreground">最低计提金额</dt><dd className="mt-1 tabular-nums">{distributionCentsLabel(config.minimumAccrualCents)}，与最低提现金额分开</dd></div><div><dt className="text-muted-foreground">待入账期</dt><dd className="mt-1">结算后 {config.settlementDelayDays} 天；到期不代表已转入可用余额</dd></div></dl>
  <p className="text-sm text-muted-foreground">{view.read.semanticsVersion==='distribution-policy.lifecycle.v2'?'关闭只暂停停用期首次付款的新计佣；合法关系、已冻结权益及原待入账记录保留。':'当前接口未声明新版停用语义，不能据此判断关系和既有权益的处理结果。'}</p>
  <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>查看政策依据<ChevronDown aria-hidden="true"/></CollapsibleTrigger><CollapsibleContent><dl className="mt-2 space-y-2 break-all text-xs text-muted-foreground"><div>版本：{head.versionId} · 修订 {head.revision}</div><div>记录创建：{formatDate(head.createdAt)}（不等于审批或生效时间）</div><div>来源范围：{config.scope==='LOCAL_CONTROLLED'?'本地受控政策':'原生政策'} · 摘要 {head.digest}</div></dl></CollapsibleContent></Collapsible>
  <Dialog open={draft!==null} onOpenChange={open=>{if(!open&&!busy)setDiscard(true);}}><DialogContent className="max-w-xl" closeLabel="关闭政策编辑"><DialogHeader><DialogTitle>申请调整分销政策</DialogTitle><DialogDescription>运营拟定 → Boss审批 → 执行新版本。已付款订单继续使用原冻结依据。</DialogDescription></DialogHeader>{draft&&<PolicyDraftForm draft={draft} busy={busy} canSubmit={canRequest} onChange={setDraft} onSubmit={submit} onCancel={()=>setDiscard(true)}/>}</DialogContent></Dialog>
  <Dialog open={discard} onOpenChange={setDiscard}><DialogContent closeLabel="关闭取消确认"><DialogHeader><DialogTitle>放弃未提交的修改？</DialogTitle><DialogDescription>这不会撤销已发送的申请；原请求与核对记录保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setDiscard(false)}>继续编辑</Button><Button variant="destructive" onClick={()=>{setDiscard(false);setDraft(null);}}>放弃修改</Button></DialogFooter></DialogContent></Dialog>
 </section>;
}
function PolicyDraftForm({draft,busy,canSubmit,onChange,onSubmit,onCancel}:{draft:Draft;busy:boolean;canSubmit:boolean;onChange:(d:Draft)=>void;onSubmit:(p:DistributionPolicyPayload)=>void;onCancel:()=>void}){
 let proposal:DistributionPolicyPayload|null=null,error='';try{proposal=buildDistributionPolicyPayload(draft.head,draft);}catch(e){error=e instanceof Error?e.message:'请检查政策输入';}
 const change=(p:Partial<Draft>)=>onChange({...draft,...p});
 return <form className="space-y-4" onSubmit={e=>{e.preventDefault();if(proposal&&!busy&&canSubmit)onSubmit(proposal);}}><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm">推荐租客奖励比例（%）<Input aria-label="推荐租客奖励比例" inputMode="decimal" aria-invalid={!proposal} aria-describedby={!proposal?"distribution-draft-errors":undefined} value={draft.renter} disabled={busy} onChange={e=>change({renter:e.target.value})}/></label><label className="space-y-1 text-sm">推荐号主奖励比例（%）<Input aria-label="推荐号主奖励比例" inputMode="decimal" aria-invalid={!proposal} aria-describedby={!proposal?"distribution-draft-errors":undefined} value={draft.owner} disabled={busy} onChange={e=>change({owner:e.target.value})}/></label></div><div className="space-y-1 text-sm"><span>申请后的分销状态</span><Select value={draft.enabled?'true':'false'} disabled={busy} onValueChange={v=>{if(v==='true'||v==='false')change({enabled:v==='true'});}}><SelectTrigger aria-label="申请后的分销状态"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="true">开启新计佣</SelectItem><SelectItem value="false">暂停新计佣</SelectItem></SelectContent></Select></div><label className="block space-y-1 text-sm">变更原因<Textarea aria-label="分销政策变更原因" aria-invalid={!proposal} aria-describedby={!proposal?"distribution-draft-errors":undefined} value={draft.reason} maxLength={500} disabled={busy} onChange={e=>change({reason:e.target.value})}/></label>{proposal?<div className="rounded-lg border p-3 text-sm"><p className="font-medium">本次拟变更</p>{Object.entries(proposal.changes).map(([k,v])=><p key={k}>{k==='enabled'?'计佣状态':k==='renterPercent'?'推荐租客比例':'推荐号主比例'}：{typeof v==='boolean'?(v?'开启':'暂停'):`${v}%`}</p>)}<p className="mt-2 text-muted-foreground">其他经济参数保持原版本；审批通过后仍需执行。</p></div>:<p id="distribution-draft-errors" role="alert" className="text-sm text-muted-foreground">{error}</p>}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>取消修改</Button><Button type="submit" disabled={!proposal||!canSubmit||busy}>{busy?'正在提交…':'提交Boss审批'}</Button></DialogFooter></form>;
}
