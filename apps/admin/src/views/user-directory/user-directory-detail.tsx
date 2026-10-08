import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { restoreTabs, tabHref, tabFromLocation } from '@/workspace/tab-model';
import { AdminApiError } from '../../api';
import { PERMISSION, STATUS_LABEL, sourceLabel, type Audit, type Order, type Resource, type User } from './user-directory-data';
import { Denied, DomainBlock, Identity, Loading, Message, Status, Summary, errorText, time, useDirectoryRequest, type PageProps, type UserDirectoryData } from './user-directory-shared';
import { CreditPanel } from './credit-panel';

const SECTION_NAMES = { overview:'概览',orders:'订单记录',resources:'资源账号',credit:'信用与保证金',security:'账号安全' };
const ORDER_STATUS:Record<string,string>={PENDING_PAYMENT:'待支付',PAID:'已支付',COMPLETED:'已完成',CANCELLED:'已取消'};
const AUDIT_ACTION_LABEL:Record<string,string>={'user.account.restored':'账号恢复','user.account.deactivated':'账号停用','user.account.cancelled':'账号注销','user.identity.verification':'身份核验','user.legacy_owner.migrated':'旧用户迁入记录'};
const auditActionLabel=(action:string)=>AUDIT_ACTION_LABEL[action]??'未识别操作';

function Orders({adapter,user,refreshNonce,onOpenPath}:{adapter:UserDirectoryData;user:User;refreshNonce:number;onOpenPath:PageProps["onOpenPath"]}) {
  const [role,setRole]=useState(''); const [status,setStatus]=useState('');
  const filters={...(role?{role}:{}),...(status?{status}:{})};
  return <><div className="ud-section-heading"><h2>订单记录</h2><span className="ud-muted">授权游戏范围内 · 一行一单</span></div>
    <div className="ud-order-filters"><label className="ud-field"><span>该用户在具体订单中的参与方</span><select aria-label="该用户在具体订单中的参与方" value={role} onChange={e=>setRole(e.target.value)}><option value="">全部</option><option value="renter">租用方</option><option value="owner">资源归属方</option></select></label>
    <label className="ud-field"><span>订单状态</span><select aria-label="订单状态" value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部</option>{Object.entries(ORDER_STATUS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div>
    <DomainBlock adapter={adapter} id={user.id} domain="orders" filters={filters} refreshNonce={refreshNonce}>{data=>(data as Order[]).length ? <div className="ud-order-list">{(data as Order[]).map(order=><article key={order.orderId} className="ud-order" data-order-id={order.orderId}><div className="ud-order-title"><button className="oc-link" onClick={()=>onOpenPath(`/orders/${order.orderId}`,order.displayNo)}>{order.displayNo}<ArrowUpRightIcon size={13}/></button><Badge variant="outline">{ORDER_STATUS[order.status]??`未知：${order.status}`}</Badge><Badge variant="secondary">本单{order.role==='renter'?'租用方':'资源归属方'}</Badge></div><p>{order.title} · {order.accountDisplayNo??'资源账号信息受限'}</p>
      <dl className="ud-order-facts"><div><dt>资源预付 / 押金 / 需付（订单记录）</dt><dd>CNY {order.amounts.rental?.amount??"未知"} / {order.amounts.deposit?.amount??"未知"} / {order.amounts.totalDue?.amount??"未知"}</dd></div><div><dt>支付时间</dt><dd>{order.paidAt?time(order.paidAt):order.payment?.state==='RECORDED_PAID'||['PAID','COMPLETED'].includes(order.status)?'支付时间待确认':'暂无可核验支付时间'}</dd></div><div><dt>创建时间</dt><dd>{time(order.createdAt)}</dd></div><div><dt>交易另一方</dt><dd>{order.counterpartyName||'昵称未设置'}</dd></div>{order.status==='CANCELLED'?<div><dt>取消信息</dt><dd>{order.cancelReason??'原因未知'} · {time(order.cancelledAt)}</dd></div>:null}{order.expiredAwaitingCancel?<div><dt>保留期</dt><dd>已过保留期，待服务端确认取消</dd></div>:null}</dl></article>)}</div>:<Message kind="empty" title="范围内暂无符合当前条件的订单">调整订单参与方或状态后重新查询。</Message>}</DomainBlock>
    <Message title="履约上下文暂未接入用户目录">付款、加入订单群、交付与正式开租是独立事实；这里不推断履约进度。处理履约事项时须进一步核对该订单的事实记录。</Message></>;
}

function publicationLabel(resource:Resource) {
  const publication=resource.publication;
  if(publication.versionPublished)return publication.source==='OWNER_DIRECT'?'当前版本已直接发布':'当前版本已按旧承接审核发布';
  if(!resource.currentVersionId)return '未提交发布';
  const labels:Record<string,string>={DRAFT:'未发布',SUBMITTED:'审核中',WITHDRAWN:'已下架',REJECTED:'已驳回',IMPORTED_UNVERIFIED:'旧资料待核'};
  return labels[publication.versionState??'']??`发布事实待确认（${publication.versionState??'未知'}）`;
}
function Resources({adapter,user,refreshNonce,onOpenPath}:{adapter:UserDirectoryData;user:User;refreshNonce:number;onOpenPath:PageProps["onOpenPath"]}) {
  return <><div className="ud-section-heading"><h2>资源账号</h2><span className="ud-muted">该用户关联的资源 · 授权游戏范围内</span></div><DomainBlock adapter={adapter} id={user.id} domain="resources" refreshNonce={refreshNonce}>{data=>(data as Resource[]).length?<div className="ud-resource-list">{(data as Resource[]).map(resource=><article className="ud-resource" key={resource.accountId}><button className="oc-link" onClick={()=>onOpenPath(`/supply/accounts/${resource.accountId}`,`账号 ${resource.displayNo??""}`)}>{resource.displayNo??"编号待核"}<ArrowUpRightIcon size={13}/></button><p>{resource.game.name} · 生命周期：{resource.lifecycle==='ACTIVE'?'有效':resource.lifecycle==='ARCHIVED'?'已归档':`未知：${resource.lifecycle}`}</p><p>发布者暂停：{resource.ownerPaused?'是':'否'} · 平台限制：{resource.staffRestricted?'是':'否'} · 旧平台保留：{resource.legacyHold==='NONE'?'无':resource.legacyHold==='ACTIVE_LEGACY'?'旧单承接中':resource.legacyHold==='UNRESOLVED'?'待核对':resource.legacyHold}</p><Badge variant="outline">{publicationLabel(resource)}</Badge><p>发布事实不等于当前可租资格。</p></article>)}</div>:<Message kind="empty" title="范围内暂无资源账号">已按供给读取权限和游戏范围查询。</Message>}</DomainBlock></>;
}

type RestoreResult='success'|'rejected'|'conflict'|'failed'|'pending'|'readback-failed';
function Restore({adapter,user,changed}:{adapter:UserDirectoryData;user:User;changed:()=>void}) {
  const [open,setOpen]=useState(false); const [reason,setReason]=useState(''); const [password,setPassword]=useState(''); const [code,setCode]=useState('');
  const [result,setResult]=useState<RestoreResult>(); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [read,setRead]=useState<User>(); const [writeAccepted,setWriteAccepted]=useState(false);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const clearSecrets=()=>{setPassword('');setCode('');};
  const current=read??user;
  const hasRestoreAccess=adapter.has('user.account.restore');
  const eligible=hasRestoreAccess&&!writeAccepted&&current.status==='DEACTIVATED';
  const reread=async()=>{
    setBusy(true);setError('');const request=new AbortController();controller.current=request;
    try {const value=await adapter.detail(user.id,request.signal);if(request.signal.aborted)return;setRead(value);if(value.status==='ACTIVE'){setResult('success');setError('');changed();}else if(writeAccepted){setResult('readback-failed');setError('恢复请求已被接受，但账号状态仍未显示为正常；不会自动重复提交。');}}
    catch(failure){if(!request.signal.aborted){setResult(currentResult=>writeAccepted?'readback-failed':currentResult);setError(errorText(failure));}}finally{if(!request.signal.aborted)setBusy(false);}
  };
  const submit=async()=>{
    if(!eligible||result==='pending'||writeAccepted)return;
    setError('');setRead(undefined);setBusy(true);const request=new AbortController();controller.current=request;
    try {await adapter.restore(user.id,reason,password,code,request.signal);if(request.signal.aborted)return;setWriteAccepted(true);setResult('success');try {const value=await adapter.detail(user.id,request.signal);if(request.signal.aborted)return;setRead(value);if(value.status==='ACTIVE'){setResult('success');setError('');changed();}else {setResult('readback-failed');setError('恢复请求已被接受，但账号状态仍未显示为正常；不会自动重复提交。');}}catch(readbackFailure){if(!request.signal.aborted){setResult('readback-failed');setError(errorText(readbackFailure));}}}
    catch(failure){if(request.signal.aborted)return;setResult(failure instanceof AdminApiError&&failure.status===0?'pending':failure instanceof AdminApiError&&failure.status===401?'rejected':failure instanceof AdminApiError&&failure.status===409?'conflict':'failed');setError(errorText(failure));
      try {const value=await adapter.detail(user.id,request.signal);if(!request.signal.aborted)setRead(value);}catch{/* The outcome remains unconfirmed when re-read also fails. */}}
    finally {clearSecrets();if(!request.signal.aborted)setBusy(false);}
  };
  const labels:Record<RestoreResult,string>={success:'账号恢复已处理',rejected:'管理员再认证被拒绝',conflict:'账号状态已变化',failed:'恢复操作失败',pending:'恢复结果待确认','readback-failed':'恢复请求已提交，状态待确认'};
  return <div className="ud-restore"><h2>账号恢复</h2>{!hasRestoreAccess?<Denied permission="user.account.restore"/>:<><p>{writeAccepted?'恢复请求已被服务端接受；当前状态需要重读确认。':eligible?'已停用，可进入恢复评估。需操作原因与管理员密码/TOTP再认证。':current.status==='CANCELLED'?'已注销账号不可恢复。':'当前账号状态不符合恢复资格。'}</p>{writeAccepted?<Button variant="outline" onClick={()=>setOpen(true)}>核对恢复结果</Button>:eligible?<Button variant="outline" onClick={()=>setOpen(true)}>账号恢复</Button>:null}</>}
    {(result==='pending'||result==='readback-failed')&&!open?<Message title={labels[result]}>先核对服务端账号状态；不会自动重试或重复提交。</Message>:null}
    <Dialog open={open} onOpenChange={value=>{if(busy)return;setOpen(value);if(!value){clearSecrets();setReason('');}}}><DialogContent className="ud-restore-dialog" showCloseButton={false}><DialogHeader><DialogTitle>账号恢复评估 · {user.name}</DialogTitle><DialogDescription>恢复只改变账号可用状态，不复活旧会话或验证凭据，不覆盖实名与年龄结果。</DialogDescription></DialogHeader><form aria-busy={busy} onSubmit={e=>{e.preventDefault();void submit();}}>
      <label className="ud-field"><span>操作原因（3–500字）</span><textarea aria-label="操作原因" value={reason} minLength={3} maxLength={500} required onChange={e=>setReason(e.target.value)}/></label>
      <label className="ud-field"><span>管理员密码</span><Input type="password" aria-label="管理员密码" autoComplete="off" value={password} minLength={12} required onChange={e=>setPassword(e.target.value)}/></label>
      <label className="ud-field"><span>管理员 TOTP（6位）</span><Input type="password" inputMode="numeric" aria-label="管理员 TOTP" autoComplete="off" pattern="[0-9]{6}" maxLength={6} value={code} required onChange={e=>setCode(e.target.value)}/></label>
      {result?<Message kind={result==='success'?'success':result==='pending'||result==='readback-failed'?'info':'error'} title={labels[result]}>{read?`重读账号状态：${STATUS_LABEL[read.status]}。`:'账号状态尚未确认。'}{result==='success'?'请用户重新登录；旧会话和验证凭据不会复活。':result==='readback-failed'?'恢复写入已成功，但状态回读未完成；不会自动重复提交。':result==='pending'?'未收到确认结果，请重新读取账号状态；不自动重复提交。':'填写新的再认证信息后由管理员决定是否重试。'}</Message>:null}
      {error&&result!=='pending'&&result!=='readback-failed'?<Message kind="error" title="操作未完成">{error}</Message>:null}{error&&result==='readback-failed'?<Message kind="info" title="状态读取提示">{error}</Message>:null}
      <div className="ud-dialog-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>{setOpen(false);clearSecrets();setReason('');}}>关闭</Button>{result?<Button type="button" disabled={busy} onClick={()=>void reread()}>重新读取账号状态</Button>:null}{eligible&&result!=='pending'&&result!=='success'&&result!=='readback-failed'?<Button type="submit" disabled={busy||reason.trim().length<3||password.length<12||!/^\d{6}$/.test(code)}>{busy?'处理中…':'提交恢复'}</Button>:null}</div>
    </form></DialogContent></Dialog></div>;
}

export function UserDetail({adapter,snapshot,tab,onOpenPath,onQueryChange,refreshNonce}:PageProps&{adapter:UserDirectoryData}) {
  const id=tab.objectId!;const [revision,setRevision]=useState(0);
  const {result,retry}=useDirectoryRequest(`${id}:${refreshNonce}:${revision}`,signal=>adapter.detail(id,signal));
  const section=tab.query.section&&tab.query.section in SECTION_NAMES?tab.query.section:'overview';
  const [visited,setVisited]=useState(new Set([section]));useEffect(()=>setVisited(current=>new Set([...current,section])),[section]);
  const back=()=>{const existing=restoreTabs(snapshot.adminUserId,{isBoss:snapshot.security.isBoss,permissions:snapshot.permissions})?.tabs.find(item=>item.id==='users');onOpenPath(tabHref(existing??tabFromLocation('/users')));};
  if(result.state==='loading')return <Loading/>;
  if(result.state==='error')return <><Button variant="ghost" onClick={back}>返回列表</Button><Message kind="error" title="用户详情加载失败" retry={retry}>{errorText(result.error)}</Message></>;
  const user=result.data;
  return <section className="ud-detail"><Button variant="ghost" onClick={back}><ArrowLeftIcon size={16}/>返回列表</Button><div className="ud-detail-heading"><Identity user={user} full heading/><Status user={user}/></div><nav className="ud-sections" aria-label="用户详情分区">{Object.entries(SECTION_NAMES).map(([key,label])=><Button variant={section===key?'secondary':'ghost'} key={key} aria-current={section===key?'page':undefined} onClick={()=>onQueryChange({section:key})}>{label}</Button>)}</nav>
    {[...visited].map(view=><div key={view} hidden={view!==section} className="ud-section-body">{view==='overview'?<>
      <div className="ud-overview-grid"><div><h2>身份与账号</h2><dl className="ud-facts"><div><dt>用户昵称</dt><dd>{user.name||'未设置昵称'}</dd></div><div><dt>旧平台用户名</dt><dd>{user.provider==='legacy_mysql_restore'?user.displayUsername||user.username||'来源未提供':'未关联旧平台用户名'}</dd></div><div><dt>实名 / 年龄</dt><dd>{user.identity} / {user.age}</dd></div><div><dt>实名通过时间</dt><dd>{time(user.verifiedAt)}</dd></div><div><dt>账号状态</dt><dd>{STATUS_LABEL[user.status]}</dd></div><div><dt>邮箱（脱敏）</dt><dd>{user.emailMasked??'未绑定真实邮箱'}</dd></div><div><dt>注册时间（北京时间）</dt><dd>{time(user.createdAt)}</dd></div></dl></div>
      <div><h2>关联业务</h2><div className="ud-business-links"><div><Summary kind="orders" part={user.orders}/>{adapter.has(PERMISSION.orders)?<Button variant="outline" onClick={()=>onQueryChange({section:'orders'})}>查看订单记录</Button>:<Denied permission={PERMISSION.orders}/>}</div><div><Summary kind="resources" part={user.resources}/>{adapter.has(PERMISSION.resources)?<Button variant="outline" onClick={()=>onQueryChange({section:'resources'})}>查看资源账号</Button>:<Denied permission={PERMISSION.resources}/>}</div></div></div></div>
      <div className="ud-overview-row"><h2>最近业务活动</h2><Message title="业务活动暂不可用">当前可按注册时间定位用户；此处不推断近期业务。</Message></div>
      <div className="ud-overview-row"><h2>客服上下文</h2>{adapter.has(PERMISSION.support)?<><Message title="用户维度完整咨询历史暂未接入">客服工作台按指派与队列处理；进入工作台后重新核对权限，群访问还需已加入该订单群。</Message><Button variant="outline" onClick={()=>onOpenPath('/support')}>进入客服工作台<ArrowUpRightIcon size={14}/></Button></>:<Denied permission={PERMISSION.support}/>}</div>
      <Message title="数据完整性说明">订单和资源仅反映各自授权游戏范围。无权限、读取失败或暂未接入均不代表没有业务；请分别核对有权读取的订单和资源记录。</Message>
    </>:view==='orders'?<Orders adapter={adapter} user={user} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:view==='resources'?<Resources adapter={adapter} user={user} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:view==='credit'?<CreditPanel adapter={adapter} user={user} refreshNonce={refreshNonce}/>:<>
      <div className="ud-overview-row"><h2>账号与安全状态</h2><p>账号：{STATUS_LABEL[user.status]} · 实名：{user.identity} · 年龄：{user.age}</p><p>{user.phoneMasked} · {user.emailMasked??'未绑定真实邮箱'}</p></div>
      <Restore adapter={adapter} user={user} changed={()=>setRevision(value=>value+1)}/>
      <div className="ud-overview-row"><h2>账号安全操作审计</h2><p className="ud-muted">当前记录已按审计权限筛选。</p><DomainBlock adapter={adapter} id={id} domain="audit" refreshNonce={revision+refreshNonce}>{data=>(data as Audit[]).length?<ul className="ud-audit">{(data as Audit[]).map(event=><li key={event.eventId}>{auditActionLabel(event.action)} · {time(event.occurredAt)} · {event.outcome==='SUCCESS'?'成功':event.outcome==='FAILURE'?'失败':'结果未知'}<details><summary>技术标识</summary><code>{event.action} · {event.outcome} · {event.requestId??'无请求编号'}</code></details></li>)}</ul>:<Message kind="empty" title="范围内暂无账号安全操作记录">不代表其他管理员没有执行过操作。</Message>}</DomainBlock></div>
      {adapter.has(PERMISSION.audit)?<details className="ud-trace"><summary>技术追溯 · 仅授权审计</summary><p>来源：{sourceLabel(user.provider)}</p>{user.trace?.sourceCreatedAt?<p>旧来源注册时间：{time(user.trace.sourceCreatedAt)}；旧来源更新时间：{time(user.trace.sourceUpdatedAt??null)}</p>:<p>旧来源时间：未知或未提供。</p>}{user.legacyId?<p>旧平台ID：{user.legacyId}（辅助定位）</p>:null}<p>本地创建：{time(user.createdAt)}；本地更新：{time(user.updatedAt)}</p></details>:null}
    </>}</div>)}
  </section>;
}
