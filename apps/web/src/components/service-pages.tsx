"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { PortalHeader } from "./layout/portal-header";
import { PortalFooter } from "./layout/portal-footer";
import { SupportRail } from "./support/support-rail";
import { DeltaSection } from "./delta/delta-section";
import { ActionFeedbackDialog } from "./ui/action-feedback-dialog";
import type { PublishMode } from "../lib/service-navigation";

function ServiceShell({children,title,description,initialQuery=""}:{children:ReactNode;title:string;description:string;initialQuery?:string}) {
  const router=useRouter();const [query,setQuery]=useState(initialQuery);
  useEffect(()=>setQuery(initialQuery),[initialQuery]);
  return <div className="portal-home portal-subpage"><PortalHeader home={false} query={query} onQueryChange={setQuery} onSearch={q=>router.push(`/accounts?q=${encodeURIComponent(q)}`)}/><main className="portal-width subpage-main"><div className="subpage-heading"><Link href="/"><ArrowLeft size={16}/>返回首页</Link><h1>{title}</h1><p>{description}</p></div>{children}</main><PortalFooter/><SupportRail/></div>;
}
export function AccountMarket({query}:{query:string}) {
  const router=useRouter();const [notice,setNotice]=useState({isOpen:false,title:"",message:""});
  return <ServiceShell title="租账号" description="选择游戏，查看资源与出租条件。" initialQuery={query}><div className="market-content"><DeltaSection searchQuery={query} onResetSearch={()=>router.push('/accounts')} onActionNotice={(title,message)=>setNotice({isOpen:true,title,message})}/></div><ActionFeedbackDialog {...notice} onClose={()=>setNotice(v=>({...v,isOpen:false}))}/></ServiceShell>;
}
const blankDraft={title:"",resources:"",fee:"",deposit:"",daily:""};
type Draft=typeof blankDraft;
const draftKey="zzsh-publish-draft:v1";
export function PublishForm({mode}:{mode:PublishMode}) {
  const [draft,setDraft]=useState<Draft>(blankDraft);const [saved,setSaved]=useState("");
  useEffect(()=>{try{const raw=JSON.parse(sessionStorage.getItem(draftKey)||'{}');const next={...blankDraft};for(const k of Object.keys(next) as (keyof Draft)[])if(typeof raw?.[k]==='string')next[k]=raw[k].slice(0,1500);setDraft(next);}catch{setSaved("未能读取本地草稿");}},[]);
  const save=(next:Draft)=>{try{sessionStorage.setItem(draftKey,JSON.stringify(next));setSaved("已保存到当前标签页");}catch{setSaved("当前浏览器无法保存草稿，请保留本页");}};
  const change=(key:keyof Draft,value:string)=>{const next={...draft,[key]:value};setDraft(next);save(next);};
  return <ServiceShell title={mode==='fast'?'上架出租 · 极速模式':'上架出租'} description="填写公开的账号资源与出租条件，不要填写账号密码。"><form className="publish-form" onSubmit={e=>e.preventDefault()}>
    <div className="publish-mode"><Link href="/publish" aria-current={mode==='standard'?'page':undefined}>普通出租</Link><Link href="/publish?mode=fast" aria-current={mode==='fast'?'page':undefined}>极速出租</Link></div>
    <div className="publish-fields"><label>游戏<select disabled value="delta"><option value="delta">三角洲行动</option></select></label><label>{mode==='fast'?'极速比例 · 已锁定':'出租比例'}<input readOnly value="待平台配置"/><small>{mode==='fast'?'极速模式使用固定比例，当前配置尚未取得。':'可用比例以平台配置为准。'}</small></label>
      <label className="full-field">账号名称<input maxLength={80} value={draft.title} onChange={e=>change('title',e.target.value)} placeholder="概括账号的主要资源"/></label>
      <label className="full-field">资源说明<textarea rows={5} maxLength={1500} value={draft.resources} onChange={e=>change('resources',e.target.value)} placeholder="填写哈夫币、安全箱及可提供的资源"/></label>
      <label>资源费用（元）<input inputMode="decimal" value={draft.fee} maxLength={20} onChange={e=>change('fee',e.target.value)} placeholder="填写期望资源费用"/></label>
      <label>押金（元）<input inputMode="decimal" value={draft.deposit} maxLength={20} onChange={e=>change('deposit',e.target.value)} placeholder="与资源费用分别填写"/></label>
      <label>每日消耗档位（M）<input inputMode="numeric" value={draft.daily} maxLength={20} onChange={e=>change('daily',e.target.value)} placeholder="填写每日消耗档位"/></label>
      <label>账号图片<input disabled value="图片提交入口待开放" readOnly/></label>
    </div>
    <div className="publish-actions"><button type="button" className="button secondary" onClick={()=>save(draft)}>保存草稿</button><button className="button primary" disabled>提交上架</button><span role="status">{saved}</span></div>
    <p>上架配置暂未就绪，当前可填写草稿，暂不可提交。费用与可用条件以平台确认为准。</p>
  </form></ServiceShell>;
}
const accountViews={rentals:'租入订单',leased:'出租订单',accounts:'账号管理',favorites:'我的收藏',invite:'我的邀请码'};
export function AccountWorkspace({view}:{view:string}) {
  const active=Object.hasOwn(accountViews,view)?view as keyof typeof accountViews:'rentals';
  return <ServiceShell title={accountViews[active]} description="在这里继续处理你的租赁事务。"><nav className="account-tabs" aria-label="个人事务分类">{Object.entries(accountViews).map(([key,label])=><Link key={key} href={`/account?view=${key}`} aria-current={active===key?'page':undefined}>{label}</Link>)}</nav><section className="account-guest"><LockKeyhole size={30}/><h2>登录后查看{accountViews[active]}</h2><p>当前未取得个人信息。</p><Link href="/login" className="button primary">登录 / 注册</Link></section></ServiceShell>;
}

export function HelpPage() {
  return <ServiceShell title="帮助中心" description="了解租号、费用与上架要求。"><div className="help-page-content">
    <article id="rental-guide"><h2>租号流程</h2><p>选号并确认条件，付款后由真人客服在每单独立群协助履约。双方确认交付后起租。</p></article>
    <article id="billing-guide"><h2>费用与租期</h2><p>按哈夫币及指定物资消耗计费。资源费用与押金分别列明，每日消耗档位用于推算租期。</p><p>新单实际消耗价值达到本单计费总额70%时正常结算；低于门槛时，平台收取完整消耗下的全部平台利润，号主按实际消耗结算。最终费用以下单确认为准。</p></article>
    <article id="publish-guide"><h2>发布须知</h2><p>准备账号资源说明与公开截图。号主申报、资料审核不等于登录验号。</p><p>当前可查看上架表单，暂不接受在线提交。</p></article>
    <article id="protection"><h2>未成年人禁止消费</h2><p>理性游戏，守护成长。</p></article>
  </div></ServiceShell>;
}
