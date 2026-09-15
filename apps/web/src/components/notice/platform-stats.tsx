"use client";
import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Megaphone, Pause, Play, ChartNoAxesCombined, Info } from "lucide-react";
import Counter from "../effects/counter";
import { isPublicCount, type PlatformStatsData, type PublicDeal } from "../../lib/public-activity";
export type { PlatformStatsData, PublicDeal } from "../../lib/public-activity";
export function RollingNumber({value,reduced,fontSize=24}:{value:number|null;reduced:boolean;fontSize?:number}) {
  if(!isPublicCount(value)) return null;
  const formatted=value.toLocaleString("en-US");
  if(reduced)return <span className="rolling-number" style={{fontSize}}>{formatted}</span>;
  const groups=formatted.split(",");
  return <span className="rolling-number reactbits-number" aria-label={formatted}><span aria-hidden="true" className="counter-groups">{groups.map((group,i)=><span className="counter-group" key={groups.length-i}>{i>0&&<span>,</span>}<Counter value={Number(group)} places={[...group].map((_,j)=>10**(group.length-j-1))} fontSize={fontSize} gap={0} horizontalPadding={0} gradientHeight={0}/></span>)}</span></span>;
}
export function PlatformStats({data,deals=[],isDemo=false}:{data?:PlatformStatsData;deals?:PublicDeal[];isDemo?:boolean}) {
  const [index,setIndex]=useState(0);
  const [paused,setPaused]=useState(false);
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const [reduced,setReduced]=useState(true);
  const [visible,setVisible]=useState(true);
  useEffect(()=>{
    const media=matchMedia("(prefers-reduced-motion: reduce)");
    const update=()=>setReduced(media.matches);
    const visibility=()=>setVisible(!document.hidden);
    update();visibility();media.addEventListener("change",update);document.addEventListener("visibilitychange",visibility);
    return ()=>{media.removeEventListener("change",update);document.removeEventListener("visibilitychange",visibility);};
  },[]);
  const records=deals.filter(d=>d.id&&d.game&&d.title&&d.priceLabel);
  const current=records.length ? records[index%records.length] : null;
  const running=records.length>1&&!paused&&!hovered&&!focused&&!reduced&&visible;
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>setIndex(i=>(i+1)%records.length),5000);return()=>clearInterval(timer);},[running,records.length]);
  const metrics=[['昨日访问',data?.visits],['当前上架账号',data?.listings]] as const;
  return <section className="platform-activity" aria-label="平台统计与最新成交">
    <div className="activity-summary">
      <ChartNoAxesCombined className="activity-emblem" size={32} strokeWidth={1.7} aria-hidden="true" />
      <span>累计完成</span>
      {isPublicCount(data?.transactions)?<RollingNumber value={data.transactions} reduced={reduced} fontSize={28}/>:<span className="stat-unknown" aria-label="数据暂未提供">—</span>}
      <span>笔交易</span>
      {isDemo&&<Popover.Root><Popover.Trigger asChild><button className="stats-info" aria-label="统计数据说明：当前为演示数据"><Info size={15} aria-hidden="true"/></button></Popover.Trigger><Popover.Portal><Popover.Content className="stats-info-panel" side="bottom" sideOffset={8} collisionPadding={12}>当前为演示数据，不代表实际访问量、上架数量或成交记录。</Popover.Content></Popover.Portal></Popover.Root>}
    </div>
    <div className="activity-metrics">{metrics.map(([label,value])=><div key={label}><span>{label}</span>{isPublicCount(value)?<RollingNumber value={value} reduced={reduced} fontSize={20}/>:<span className="stat-unknown" aria-label="数据暂未提供">—</span>}</div>)}</div>
    <div className="deal-ticker" data-running={running} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))setFocused(false);}}>
      <span className="deal-label"><Megaphone size={18} aria-hidden="true"/><span className="sr-only">最新成交</span></span>
      {current?<div className="deal-message" aria-live="off" key={current.id}><strong>{current.game}</strong><span className="deal-title" title={current.title}>{current.title}</span><span className="deal-price"><small>成交价</small>{current.priceLabel}</span></div>:<span className="deal-title">暂无可展示的成交信息</span>}
      {records.length>1&&<button className="deal-pause" disabled={reduced} aria-label={reduced?'减少动态：成交播报已暂停':paused?'恢复成交播报':'暂停成交播报'} onClick={()=>setPaused(p=>!p)}>{paused||reduced?<Play size={14}/>:<Pause size={14}/>}</button>}
      <img className="deal-companion" src="/art/zhouzhou/deal-announcer.webp" alt="" aria-hidden="true" width={110} height={110} />
    </div>
  </section>;
}
