"use client";
import {PersonalEarnings} from './personal-earnings';import {useEffect,useRef,useState,type FormEvent} from 'react';import {Copy,RefreshCw,Users,Link2,Clock3,Sparkles,ShieldCheck} from 'lucide-react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';import {formatOrderTime} from '@/lib/order-client';import {WalletRequestError} from '@/lib/personal-wallet-client';
import {readMyInvitation,readMyInvitees,pendingLeaderBinding,bindLeader,recoverLeaderBinding,readMyDistributionTerms,type InvitationRead,type MyDistributionTerms} from '@/lib/invitation-client';
import './financial-primitives.css';
import './personal-invitations.css';
type Filter='ALL'|'INVITER'|'DISTRIBUTION_LEADER';type Page=Awaited<ReturnType<typeof readMyInvitees>>;
type TabKey='overview'|'earnings'|'relations'|'rules';
const typeLabel={INVITER:'注册邀请',DISTRIBUTION_LEADER:'佣金关系'};

const AVATAR_COLORS = [
  "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
  "linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)",
  "linear-gradient(135deg, #10b981 0%, #047857 100%)",
  "linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)",
  "linear-gradient(135deg, #ec4899 0%, #be185d 100%)",
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string) {
  if (!name) return "友";
  return name.trim().slice(0, 1).toUpperCase();
}

const errorText=(e:unknown)=>e instanceof WalletRequestError&&e.code==='PENDING_MARKER_UNREADABLE'?'暂时无法确认上次绑定，请保留当前页面并联系客服。':e instanceof WalletRequestError&&e.status===401?'登录身份已变化，请重新确认登录。':e instanceof WalletRequestError&&e.status===403?'当前账号无法读取或修改邀请关系。':e instanceof WalletRequestError&&e.status===409?'关系或政策已变化，请重新读取。未确认的绑定先查询原记录。':'邀请记录暂时无法读取，请稍后重试。';
export function PersonalInvitations({scope}:{scope:string}){
 const session=useUserSession(),store=useUserSessionStore(),live=useRef({scope,mounted:false});live.current.scope=scope;
 const [data,setData]=useState<{scope:string;value:InvitationRead|null}>({scope,value:null}),[page,setPage]=useState<{scope:string;value:Page|null}>({scope,value:null}),[filter,setFilter]=useState<Filter>('ALL'),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[code,setCode]=useState(''),[accepted,setAccepted]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[refreshNonce,setRefreshNonce]=useState(0),[activeTab,setActiveTab]=useState<TabKey>('overview'),[inviteeLimit,setInviteeLimit]=useState(6);const ticket=useRef(0);
 const userId=session.userId,current=()=>{const s=store.getSnapshot();return live.current.mounted&&live.current.scope===scope&&s.status==='authenticated'&&s.userId===userId&&`${s.userId}:${s.identityVersion}`===scope;};
 const fail=(e:unknown)=>{if(!current())return;setError(errorText(e));if(e instanceof WalletRequestError&&[401,403,409].includes(e.status)){setData({scope,value:null});setPage({scope,value:null});if(e.status===401)session.revalidate();}};
 const load=async(type:Filter=filter,preservePage=false)=>{if(!userId||!current())return;const id=++ticket.current,previous=preservePage&&page.scope===scope?page.value:null;setBusy(true);setError('');try{try{setPending(Boolean(pendingLeaderBinding(userId)));}catch(e){setPending(true);setError(errorText(e));}const results=await Promise.allSettled([readMyInvitation(userId),readMyInvitees(userId,type)]);if(!current()||id!==ticket.current)return;const rejected=results.find(r=>r.status==='rejected'&&r.reason instanceof WalletRequestError&&[401,403,409].includes(r.reason.status));if(rejected?.status==='rejected'){fail(rejected.reason);return;}if(results[0].status==='fulfilled')setData({scope,value:results[0].value});else{if(!preservePage)setData({scope,value:null});fail(results[0].reason);}if(results[1].status==='fulfilled'){const next=results[1].value,same=previous?.snapshotVersion&&previous.snapshotVersion===next.snapshotVersion&&previous.type===next.type&&previous.count===next.count&&previous.mappedRelationCount===next.mappedRelationCount&&next.items.every((item,index)=>previous.items[index]?.id===item.id);setPage({scope,value:same?previous:next});if(previous&&!same)setNotice('邀请关系已更新，已返回第一页。');}else{if(!preservePage)setPage({scope,value:null});fail(results[1].reason);}}catch(e){if(current()){setPending(true);fail(e);}}finally{if(current()&&id===ticket.current)setBusy(false);}};
 useEffect(()=>{live.current.mounted=true;setData({scope,value:null});setPage({scope,value:null});setFilter('ALL');setCode('');setAccepted(false);setNotice('');setError('');setPending(false);void load('ALL');return()=>{live.current.mounted=false;ticket.current++;};
 // Every completion checks stable identity against the shared store and its original scope.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope]);
 const value=data.scope===scope&&current()?data.value:null,list=page.scope===scope&&current()?page.value:null,bindingEnabled=value?.canBindLeader===true;
 const rawInvitees=list?.items??[];
 const topAvatars=rawInvitees.slice(0,5);
 const visibleInvitees=rawInvitees.slice(0,inviteeLimit);
 const hasMoreLocalInvitees=rawInvitees.length>inviteeLimit;
 const recover=async()=>{if(!userId||!current())return;setBusy(true);setError('');try{const result=await recoverLeaderBinding(userId,current);if(!current())return;setPending(Boolean(pendingLeaderBinding(userId)));if(result){setData({scope,value:result});setNotice('原绑定已确认。');}else setNotice('原绑定结果仍待确认，请稍后查询。');}catch(e){fail(e);}finally{if(current())setBusy(false);}};
 const submit=async(event:FormEvent)=>{event.preventDefault();if(!bindingEnabled||busy||pending||!value?.policyVersion||!value.participant.revision||!userId||!current()||!accepted)return;setBusy(true);setError('');setNotice('');try{const result=await bindLeader(userId,{code:code.trim(),policyVersion:value.policyVersion,expectedParticipantRevision:value.participant.revision},current);if(current()){setData({scope,value:result});setCode('');setAccepted(false);setNotice('分销上级已绑定。');}}catch(e){fail(e);}finally{if(current()){try{setPending(Boolean(pendingLeaderBinding(userId)));}catch{setPending(true);}setBusy(false);}}};
 const more=async()=>{if(!userId||!list?.nextCursor||!current())return;const id=++ticket.current;setBusy(true);try{const next=await readMyInvitees(userId,filter,list.nextCursor);if(current()&&id===ticket.current){if(next.knowledge!==list.knowledge||next.type!==list.type||next.snapshotVersion!==list.snapshotVersion||next.count!==list.count||next.mappedRelationCount!==list.mappedRelationCount||next.items.some(n=>list.items.some(i=>i.id===n.id)))throw new WalletRequestError(409,'INVITATION_PAGE_CHANGED');setPage({scope,value:{...next,items:[...list.items,...next.items]}});}}catch(e){fail(e);}finally{if(current()&&id===ticket.current)setBusy(false);}};
 const copy=async(link:boolean)=>{if(!value?.ownCode.code||!current())return;try{await navigator.clipboard.writeText(link?new URL('/login?inviteCode='+encodeURIComponent(value.ownCode.code),window.location.origin).href:value.ownCode.code);if(current())setNotice(link?'邀请链接已复制。':'邀请码已复制。');}catch{if(current())setNotice('无法自动复制，请选中邀请码复制。');}};
 return <section className="personal-invitations account-module account-section" aria-labelledby="invitation-heading" aria-busy={busy||undefined}>
  <div className="account-section-heading fin-header"><div><h2 id="invitation-heading" className="fin-header-title">邀请与佣金</h2><p className="fin-header-desc">查看邀请关系，确认上级与收益记录。</p></div><button className="button secondary fin-refresh-btn" type="button" disabled={busy} onClick={()=>{void load(filter,true);setRefreshNonce(n=>n+1);}}><RefreshCw size={15} className={busy ? "is-spinning" : ""} aria-hidden="true"/>刷新邀请与佣金</button></div>
  <nav className="invitation-section-links fin-subtabs" aria-label="邀请与佣金分区">
    <button type="button" className={`fin-tab-item${activeTab==='overview'?' is-active':''}`} aria-current={activeTab==='overview'?'page':undefined} onClick={()=>setActiveTab('overview')}>
      <span>邀请与上级</span>
      {activeTab==='overview'?<span className="fin-tab-indicator" aria-hidden="true"/>:null}
    </button>
    <button type="button" className={`fin-tab-item${activeTab==='earnings'?' is-active':''}`} aria-current={activeTab==='earnings'?'page':undefined} onClick={()=>setActiveTab('earnings')}>
      <span>佣金记录</span>
      {activeTab==='earnings'?<span className="fin-tab-indicator" aria-hidden="true"/>:null}
    </button>
    <button type="button" className={`fin-tab-item${activeTab==='relations'?' is-active':''}`} aria-current={activeTab==='relations'?'page':undefined} onClick={()=>setActiveTab('relations')}>
      <span>邀请关系</span>
      {activeTab==='relations'?<span className="fin-tab-indicator" aria-hidden="true"/>:null}
    </button>
    <button type="button" className={`fin-tab-item${activeTab==='rules'?' is-active':''}`} aria-current={activeTab==='rules'?'page':undefined} onClick={()=>setActiveTab('rules')}>
      <span>佣金规则</span>
      {activeTab==='rules'?<span className="fin-tab-indicator" aria-hidden="true"/>:null}
    </button>
  </nav>
  {error?<p className="invitation-error" role="alert">{error}</p>:null}{notice?<p className="invitation-notice" role="status">{notice}</p>:null}
  {pending?<section className="account-module-card invitation-pending"><Clock3 size={19} aria-hidden="true"/><div><h3>上次绑定结果待确认</h3><p>请先查询结果，确认前无法再次绑定。</p><button type="button" className="button secondary" disabled={busy} onClick={()=>void recover()}>查询绑定结果</button></div></section>:null}

  {/* Tab 1: 邀请与上级 */}
  <div className="invitation-pane" hidden={activeTab!=='overview'}>
    {/* 社交凭证与头像缩略显示 (Social Proof with Avatar Stack) */}
    <div className="invitation-social-proof-bar" aria-label="邀请关系概览">
      <div className="invitation-avatar-group">
        {topAvatars.length>0?topAvatars.map((item,idx)=>(
          <div key={item.id||idx} className="invitation-avatar-circle" style={{background:getAvatarColor(item.nickname),zIndex:topAvatars.length-idx}} title={item.nickname}>
            <span>{getInitials(item.nickname)}</span>
          </div>
        )):(
          <div className="invitation-avatar-circle is-empty">
            <Users size={14} aria-hidden="true"/>
          </div>
        )}
      </div>
      <div className="invitation-social-proof-text">
        <Sparkles size={14} className="invitation-sparkle-icon" aria-hidden="true"/>
        {list?.knowledge==='KNOWN'?<span>当前筛选 <strong>{list.count}</strong> 条关系</span>:list?.mappedRelationCount!==null&&list?.mappedRelationCount!==undefined?<span>已确认 <strong>{list.mappedRelationCount}</strong> 条关系 · 总数待核定</span>:<span>数量待核定</span>}
      </div>
    </div>

    <div className="invitation-workbench">
      <section className="account-module-card invitation-code">
        <div className="invitation-card-header">
          <h3 id="invitation-actions-heading">我的邀请码</h3>
          <span className="invitation-policy-pill">好友租号享折扣 · 您享最高分佣返还</span>
        </div>
        <strong>{value?.ownCode.code??(busy?'正在读取':'邀请信息尚在核对')}</strong>
        <p>{value?.ownCode.code?'分享邀请码，邀请好友加入。':'确认后可分享邀请码或邀请链接。'}</p>
        <div className="invitation-actions">
          <button className="button secondary" type="button" disabled={!value?.ownCode.code||busy} onClick={()=>void copy(false)}><Copy size={15} aria-hidden="true"/>复制邀请码</button>
          <button className="button secondary" type="button" disabled={!value?.ownCode.code||busy} onClick={()=>void copy(true)}><Link2 size={15} aria-hidden="true"/>复制邀请链接</button>
        </div>
      </section>
      {value?.leader.knowledge === 'KNOWN_PARENT' ? (
        <section className="account-module-card invitation-parent">
          <div className="invitation-card-header">
            <h3>佣金上级</h3>
            <span className="invitation-bound-badge">
              <ShieldCheck size={13} aria-hidden="true" />
              已生效
            </span>
          </div>
          <strong className="invitation-parent-status state-KNOWN_PARENT">已绑定</strong>
          <p className="invitation-source">注册邀请：{value?.inviter.knowledge === 'KNOWN_PARENT' ? '已记录' : value?.inviter.knowledge === 'KNOWN_NONE' ? '注册时未填写邀请码' : '待确认'}</p>
        </section>
      ) : null}
    </div>
  </div>

  {/* Tab 2: 佣金记录 */}
  <div className="invitation-pane" hidden={activeTab!=='earnings'}>
    <PersonalEarnings scope={scope} refreshNonce={refreshNonce}/>
  </div>

  {/* Tab 3: 邀请关系 */}
  <div className="invitation-pane" hidden={activeTab!=='relations'}>
    <section className="account-module-card invitation-list" aria-labelledby="invitation-list-heading">
      <div className="invitation-list-heading">
        <h3 id="invitation-list-heading"><Users size={18} aria-hidden="true"/>我的邀请关系</h3>
        <span>{list?.knowledge==='KNOWN'?`${list.count} 条关系`:list?.mappedRelationCount!==null&&list?.mappedRelationCount!==undefined?`已确认 ${list.mappedRelationCount} 条 · 总数待核定`:'数量待核定'}</span>
      </div>
      <div className="invitation-filters" role="group" aria-label="邀请关系类型">
        {(['ALL','INVITER','DISTRIBUTION_LEADER'] as Filter[]).map(type=><button key={type} type="button" aria-pressed={filter===type} disabled={busy} onClick={()=>{setFilter(type);setPage({scope,value:null});void load(type);}}>{type==='ALL'?'全部关系':typeLabel[type]}</button>)}
      </div>
      {list?.knowledge==='UNKNOWN'&&rawInvitees.length>0?<p className="invitation-source">部分邀请关系还在核对，以下为已确认的关系；完整数量暂未核定。</p>:null}
      {rawInvitees.length?(
        <ul className="invitation-user-list">
          {visibleInvitees.map(item=>(
            <li key={item.id} className="invitation-user-item">
              <div className="invitation-user-info">
                <div className="invitation-avatar-circle is-item" style={{background:getAvatarColor(item.nickname)}}>
                  <span>{getInitials(item.nickname)}</span>
                </div>
                <div>
                  <strong>{item.nickname}</strong>
                  <small>{item.boundAt===null?'原绑定时间未核定':formatOrderTime(item.boundAt)}</small>
                </div>
              </div>
              <span className={`invitation-type-tag type-${item.type.toLowerCase()}`}>{typeLabel[item.type]}</span>
            </li>
          ))}
        </ul>
      ):<p className="invitation-empty">{busy?'正在读取邀请记录…':list?.knowledge==='KNOWN'?'暂无已确认的邀请关系。':'邀请记录尚未完整核定，暂时无法确认数量。'}</p>}
      {hasMoreLocalInvitees?<button className="button secondary invitation-load-more" type="button" onClick={()=>setInviteeLimit(c=>c+6)}>{`展开更多关系（已显示 ${visibleInvitees.length} / 已读取 ${rawInvitees.length} 条）`}</button>:null}
      {list?.nextCursor?<button className="button secondary" type="button" disabled={busy} onClick={()=>void more()}>继续读取关系</button>:null}
    </section>
  </div>

  {/* Tab 4: 佣金规则 */}
  <div className="invitation-pane" hidden={activeTab!=='rules'}>
    <DistributionTermsCard scope={scope} refreshNonce={refreshNonce}/>
  </div>
 </section>;
}

const TERMS_REASON:Record<string,string>={POLICY_NOT_CONFIGURED:'佣金规则暂未确认',PARTICIPANT_UNKNOWN:'参与资格待确认',ELIGIBILITY_UNKNOWN:'参与资格待确认',LEVEL_UNKNOWN:'佣金等级待确认',LEVEL_NOT_IN_CURRENT_POLICY:'当前等级的佣金规则待确认',INELIGIBLE:'当前账号不参与佣金计划',COMMISSION_FROZEN:'佣金已暂停',POLICY_DISABLED:'佣金计划暂未开放',DISTRIBUTION_RESOURCE_NOT_ADMITTED:'佣金规则暂不可用'};
const modeLabel={ordinary:'普通出租',custom:'定制出租'};
const centsText=(c:string)=>'¥'+(BigInt(c)/100n).toString()+'.'+(BigInt(c)%100n).toString().padStart(2,'0');
/** GAP-014: the caller's own applicable terms only. Independent read; failure here never hides relations or earnings. */
export function DistributionTermsCard({scope,refreshNonce=0}:{scope:string;refreshNonce?:number}){
 const session=useUserSession(),store=useUserSessionStore(),userId=session.status==='authenticated'?session.userId:null;
 const [state,setState]=useState<{scope:string;value:MyDistributionTerms|null;error:string}|null>(null);
 useEffect(()=>{if(!userId)return;const abort=new AbortController();const owner=scope;setState(null);
  readMyDistributionTerms(userId,abort.signal).then(value=>{const s=store.getSnapshot();if(!abort.signal.aborted&&s.status==='authenticated'&&s.userId===userId)setState({scope:owner,value,error:''});},e=>{if(abort.signal.aborted)return;if(e instanceof WalletRequestError&&e.status===401)session.revalidate();setState({scope:owner,value:null,error:e instanceof WalletRequestError&&e.status===403?'当前账号无法读取分佣条款。':'适用条款暂时无法读取，请稍后重试。'});});
  return()=>abort.abort();},[scope,userId,refreshNonce]);
 const v=state?.scope===scope?state.value:null,error=state?.scope===scope?state.error:'',rates=v?.schema==='distribution-terms.self.v2'?v.rates:v?.level;
 return <section className="account-module-card invitation-terms" aria-labelledby="invitation-terms-heading">
  <div className="invitation-terms-header">
    <h3 id="invitation-terms-heading">我的佣金规则</h3>
    <span className="invitation-terms-sub">查看当前适用的佣金规则</span>
  </div>
  {error?<p role="alert" className="invitation-terms-alert error">{error}</p>:!state||state.scope!==scope?<p className="invitation-terms-alert">正在读取适用条款…</p>:!v||v.knowledge==='UNKNOWN'?<div className="invitation-terms-unknown"><strong>佣金规则待确认</strong><p>{TERMS_REASON[v?.reason??'']??'适用条款尚未核定'}。</p></div>:<>
   <div className="invitation-tier-badge-card">
     <div className="invitation-tier-badge">
       <Sparkles size={16} aria-hidden="true" />
       <strong>{v.rateMode==='UNIFORM'?'统一分佣比例':v.level?v.level.name??`等级 ${v.level.code}`:'暂无适用比例'}</strong>
       <span className="invitation-tier-tag">当前适用政策</span>
     </div>
     {v.applicable?null:<p className="invitation-tier-inapplicable">{TERMS_REASON[v.reason??'']??'当前不适用'}</p>}
   </div>
   {rates?<div className="invitation-terms-content">
     <div className="invitation-rate-cards">
       <div className="invitation-rate-card">
         <div className="rate-card-head">
           <span className="rate-card-title">邀请租客下单</span>
           <span className="rate-card-pill">租客分佣</span>
         </div>
         <strong className="rate-card-percent">{rates.renterPercent}%</strong>
         <p className="rate-card-desc">符合规则的租赁订单可产生佣金，入账进度以记录为准。</p>
       </div>
       <div className="invitation-rate-card">
         <div className="rate-card-head">
           <span className="rate-card-title">邀请号主出租</span>
           <span className="rate-card-pill">号主分佣</span>
         </div>
         <strong className="rate-card-percent">{rates.ownerPercent}%</strong>
         <p className="rate-card-desc">符合规则的出租订单可产生佣金，入账进度以记录为准。</p>
       </div>
     </div>
     <dl className="invitation-terms-list">
       <div className="terms-item">
         <dt>适用出租方式</dt>
         <dd>{(v.accountModes??[]).map(m=>modeLabel[m]).join('、')}</dd>
       </div>
       <div className="terms-item">
         <dt>转入可用余额的等待期</dt>
         <dd className="highlight-text">{v.settlementDelayDays} 天</dd>
       </div>
       <div className="terms-item">
         <dt>单笔最低</dt>
         <dd className="highlight-text">{v.minimumAccrualCents===null?'未核定':centsText(v.minimumAccrualCents)}</dd>
       </div>
     </dl>
   </div>:null}
  </>}
  {v?.policyVersion?<p className="invitation-source"><ShieldCheck size={14} aria-hidden="true" className="source-icon" />{v.scope==='LOCAL_CONTROLLED'?'测试规则，不代表正式佣金比例。':'佣金按订单发生时的规则计算。'}</p>:null}
 </section>;
}
