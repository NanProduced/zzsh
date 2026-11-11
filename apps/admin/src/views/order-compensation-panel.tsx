import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, FilePlus2 } from 'lucide-react';
import { parseYuanToCents } from '@zzsh/ui/display-money';
import { AdminApiError, adminRequest, hasPermission, type SessionSnapshot } from '../api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmAlertDialog } from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { financeMoney, financeTime } from './admin-finance-api';
import { useMembershipApprovalRequest } from './membership-benefits-workspace';

type Snapshot=Extract<SessionSnapshot,{authenticated:true}>;
type Basis={origin:'NATIVE'|'LEGACY';orderId:string;gameId:string;ownerUserId:string;state:'SELECTED'|'NOT_SELECTED'|'UNKNOWN'|'LEGACY_REVIEW';sourceDigest:string|null};
type Case={id:string;status:string;amountCents:string|null;caseRef:string|null;reason:string|null;createdAt:string|null;postingId:string|null;postedAt:string|null;verified:boolean};
type Read={schema:'admin-order-compensation.v1';basis:Basis;state:'READY'|'UNAVAILABLE';items:Case[];truncated:boolean};
const status:Record<string,string>={PENDING:'待审批',APPROVED:'批准待入账',REJECTED:'已驳回',CANCELLED:'已撤回',EXPIRED:'已过期',EXECUTED:'入账待核对',EXECUTION_FAILED:'入账待核对'};

function validRead(value:unknown,orderId:string,origin:'NATIVE'|'LEGACY'):value is Read {
  if(!value||typeof value!=='object')return false;
  const data=value as Read,b=data.basis;
  return data.schema==='admin-order-compensation.v1'&&!!b&&b.orderId===orderId&&b.origin===origin&&typeof b.gameId==='string'&&typeof b.ownerUserId==='string'
    &&['SELECTED','NOT_SELECTED','UNKNOWN','LEGACY_REVIEW'].includes(b.state)&&(['UNKNOWN'].includes(b.state)?b.sourceDigest===null:typeof b.sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(b.sourceDigest))
    &&['READY','UNAVAILABLE'].includes(data.state)&&Array.isArray(data.items)&&data.items.length<=100&&typeof data.truncated==='boolean'
    &&data.items.every(item=>!!item&&typeof item.id==='string'&&typeof item.status==='string'&&typeof item.verified==='boolean');
}

export function OrderCompensationPanel({snapshot,orderId,displayNo,origin,actionsTarget,onOpenPath,refreshNonce}:{snapshot:Snapshot;orderId:string;displayNo:string;origin:'NATIVE'|'LEGACY';actionsTarget:HTMLElement|null;onOpenPath:(path:string,title?:string)=>void;refreshNonce:number}){
  const access=snapshot.security.isBoss||hasPermission(snapshot,'order.compensation.request')||hasPermission(snapshot,'order.compensation.approve');
  const canRequest=snapshot.security.status==='ACTIVE'&&!snapshot.security.passwordChangeRequired&&!snapshot.session.locked&&(snapshot.security.isBoss||hasPermission(snapshot,'order.compensation.request')&&hasPermission(snapshot,'approval.request.create'));
  const identity=JSON.stringify([snapshot.adminUserId,snapshot.session.id,snapshot.session.locked,snapshot.security.status,snapshot.security.passwordChangeRequired,[...snapshot.permissions].sort(),orderId,origin]);
  const live=useRef(identity);live.current=identity;
  const [read,setRead]=useState<{identity:string;state:'loading'|'ready'|'error';value?:Read}>({identity,state:'loading'}),[nonce,setNonce]=useState(0);
  const [open,setOpen]=useState(false),[armed,setArmed]=useState<{cents:string;caseRef:string;reason:string;evidenceRef:string;sourceDigest:string}|null>(null),[amount,setAmount]=useState(''),[caseRef,setCaseRef]=useState(''),[reason,setReason]=useState(''),[evidenceRef,setEvidenceRef]=useState(''),[legacyConfirmed,setLegacyConfirmed]=useState(false);
  const approval=useMembershipApprovalRequest(snapshot,'compensation');
  const current=read.identity===identity?read:{identity,state:'loading' as const};
  useEffect(()=>{const controller=new AbortController();setRead({identity,state:'loading'});setOpen(false);setArmed(null);setLegacyConfirmed(false);
    if(!access)return()=>controller.abort();
    void adminRequest<unknown>(`/orders/${encodeURIComponent(orderId)}/compensation?origin=${origin}`,undefined,'GET',{},controller.signal).then(value=>{
      if(controller.signal.aborted)return;if(!validRead(value,orderId,origin))throw Error('COMPENSATION_REFERENCE_MISMATCH');setRead({identity,state:'ready',value});
    }).catch(()=>{if(!controller.signal.aborted)setRead({identity,state:'error'});});return()=>controller.abort();
  },[identity,orderId,origin,refreshNonce,nonce,access]);
  if(!access)return null;
  const data=current.value,basis=data?.basis,cents=parseYuanToCents(amount);
  const validText=(value:string,min:number,max:number)=>{const v=value.trim();return [...v].length>=min&&[...v].length<=max&&!/[\x00-\x1f\x7f]/.test(v);};
  const pending=approval.pending.state!=='absent'||Boolean(approval.foreignPending)||approval.legacyPending;
  const eligible=canRequest&&data?.state==='READY'&&basis?.sourceDigest&&['SELECTED','LEGACY_REVIEW'].includes(basis.state)&&!pending;
  const formValid=Boolean(eligible&&(basis?.state!=='LEGACY_REVIEW'||legacyConfirmed)&&cents&&/^[1-9]\d{0,15}$/.test(cents)&&validText(caseRef,3,120)&&validText(reason,3,500)&&validText(evidenceRef,3,200));
  const submit=async()=>{
    if(live.current!==identity||!formValid||!basis?.sourceDigest||!cents||!armed||armed.cents!==cents||armed.caseRef!==caseRef||armed.reason!==reason||armed.evidenceRef!==evidenceRef||armed.sourceDigest!==basis.sourceDigest)return;
    const owner=identity;
    const id=await approval.submit({operationCode:'order.compensation.grant',triggerCondition:'order.compensation.requested',payloadVersion:1,
      payload:{schema:'order-compensation.v1',orderId,origin,gameId:basis.gameId,ownerUserId:basis.ownerUserId,sourceDigest:basis.sourceDigest,amountCents:cents,
        caseRef:caseRef.trim().normalize('NFC'),reason:reason.trim().normalize('NFC'),evidenceRef:evidenceRef.trim().normalize('NFC')},summary:`订单 ${displayNo} 包赔赔偿`});
    if(live.current!==owner)return;
    if(id){setOpen(false);setAmount('');setCaseRef('');setReason('');setEvidenceRef('');setLegacyConfirmed(false);setNonce(n=>n+1);}
  };
  const trigger=<Button variant="outline" size="sm" disabled={!eligible||approval.busy} onClick={()=>setOpen(true)}><FilePlus2 aria-hidden size={14}/>申请包赔赔偿</Button>;
  return <>
    {actionsTarget?createPortal(trigger,actionsTarget):null}
    {current.state==='loading'?<p className="oc-finance-muted">正在读取本单赔偿申请…</p>:current.state==='error'?<Alert variant="warning"><CircleAlert aria-hidden/><AlertTitle>包赔赔偿暂不可读取</AlertTitle><AlertDescription>无法判断是否已有申请，请稍后重试。</AlertDescription><Button size="sm" variant="outline" onClick={()=>setNonce(n=>n+1)}>重新读取</Button></Alert>:data?.state==='UNAVAILABLE'?<p className="oc-finance-muted">包赔赔偿功能尚未就绪。</p>:<>
      {data?.items.length?<section className="oc-finance-section" aria-label="包赔赔偿"><h3>包赔赔偿</h3>{data.items.map(item=><div className="oc-finance-row" key={item.id}><div><strong>{item.caseRef||'事故编号未记录'}</strong><small>{item.verified&&item.status==='EXECUTED'?'已入账号主余额':status[item.status]??'状态待核对'} · {financeTime(item.postedAt??item.createdAt)}</small>{item.reason?<small>{item.reason}</small>:null}</div><strong>{financeMoney(item.amountCents)}</strong>{snapshot.security.isBoss||hasPermission(snapshot,'approval.request.read')?<Button size="sm" variant="link" onClick={()=>onOpenPath(`/approvals/${encodeURIComponent(item.id)}`,'包赔赔偿审批')}>查看申请</Button>:null}</div>)}{data.truncated?<p className="oc-finance-muted">仅显示最近 100 条，请在审批中心继续查看。</p>:null}</section>:null}
      {basis?.state==='LEGACY_REVIEW'?<p className="oc-finance-muted">旧单的下单包赔选择需由客服按原始依据核实。</p>:basis?.state==='NOT_SELECTED'?<p className="oc-finance-muted">本单未选择全额包赔。</p>:basis?.state==='UNKNOWN'?<p className="oc-finance-muted">本单包赔依据暂未取得，请联系客服核对。</p>:null}
    </>}
    {approval.error||pending?<Alert variant="warning"><CircleAlert aria-hidden/><AlertTitle>{approval.error??'原审批申请仍待核对'}</AlertTitle><AlertDescription>请先核对原申请，再发起新的赔偿。</AlertDescription>{approval.pending.state==='valid'?<Button variant="outline" size="sm" disabled={approval.busy} onClick={()=>void approval.recover()}>核对原请求</Button>:null}{approval.requestId?<Button variant="link" size="sm" onClick={()=>onOpenPath(`/approvals/${encodeURIComponent(approval.requestId!)}`,'原审批申请')}>查看原申请</Button>:null}</Alert>:null}
    {approval.requestId&&!pending&&!approval.error&&!data?.items.some(item=>item.id===approval.requestId)?<div className="oc-finance-note" role="status">赔偿申请已提交。<Button variant="link" size="sm" onClick={()=>onOpenPath(`/approvals/${encodeURIComponent(approval.requestId!)}`,'包赔赔偿审批')}>查看申请</Button></div>:null}
    <Dialog open={open} onOpenChange={next=>{if(!approval.busy)setOpen(next);}}><DialogContent size="md" className="max-h-[calc(100dvh-2rem)] overflow-y-auto" closeLabel="关闭包赔赔偿申请"><DialogHeader><DialogTitle>申请包赔赔偿</DialogTitle><DialogDescription>订单 {displayNo} · 赔偿默认发给本单号主。审批通过后直接记入号主余额。</DialogDescription></DialogHeader>
      {basis?.state==='LEGACY_REVIEW'?<Alert variant="warning"><CircleAlert aria-hidden/><AlertTitle>请先核实旧单保障</AlertTitle><AlertDescription>迁入账号资料不能证明下单时的保障选择，请填写旧站或客服工单核对依据。</AlertDescription></Alert>:null}
      <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm">赔偿金额（元）<Input aria-label="赔偿金额（元）" inputMode="decimal" maxLength={19} value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label><label className="space-y-1 text-sm">事故或工单编号<Input aria-label="事故或工单编号" value={caseRef} maxLength={120} onChange={e=>setCaseRef(e.target.value)} placeholder="用于区分不同事故"/></label></div>
      <label className="block space-y-1 text-sm">处理原因<Textarea aria-label="处理原因" value={reason} maxLength={500} onChange={e=>setReason(e.target.value)} rows={3}/></label>
      <label className="block space-y-1 text-sm">核对依据<Input aria-label="核对依据" value={evidenceRef} maxLength={200} onChange={e=>setEvidenceRef(e.target.value)} placeholder="工单号或核对记录"/></label>
      {basis?.state==='LEGACY_REVIEW'?<div className="flex items-start gap-2 text-sm"><Checkbox aria-label="已核实旧订单选择了全额包赔" checked={legacyConfirmed} onCheckedChange={value=>setLegacyConfirmed(value===true)}/><span>我已根据上述依据核实：这笔旧订单下单时选择了全额包赔。</span></div>:null}
      <DialogFooter><Button variant="outline" disabled={approval.busy} onClick={()=>setOpen(false)}>取消</Button><Button disabled={!formValid||approval.busy} onClick={()=>{if(cents&&basis?.sourceDigest)setArmed({cents,caseRef,reason,evidenceRef,sourceDigest:basis.sourceDigest});}}>核对并提交</Button></DialogFooter>
    </DialogContent></Dialog>
    <ConfirmAlertDialog open={armed!==null} onOpenChange={value=>{if(!value)setArmed(null);}} contentLabel="确认提交包赔赔偿" title="确认提交赔偿申请？" description={`订单 ${displayNo}，申请赔偿 ${financeMoney(armed?.cents)}，审批通过后记入号主余额。`} confirmLabel="确认提交" cancelLabel="返回核对" busy={approval.busy} onConfirm={()=>{void submit();setArmed(null);}}/>
  </>;
}
