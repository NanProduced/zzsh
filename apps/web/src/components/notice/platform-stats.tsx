"use client";
import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChartNoAxesCombined, Info } from "lucide-react";
import Counter from "../effects/counter";
import { PlatformUpdateTicker } from "../content/platform-update-notices";
import { isPublicCount, type PlatformStatsData, type PublicDeal } from "../../lib/public-activity";
export type { PlatformStatsData, PublicDeal } from "../../lib/public-activity";
export function RollingNumber({value,reduced,fontSize=24}:{value:number|null;reduced:boolean;fontSize?:number}) {
  if(!isPublicCount(value)) return null;
  const formatted=value.toLocaleString("en-US");
  if(reduced)return <span className="rolling-number" style={{fontSize}}>{formatted}</span>;
  const groups=formatted.split(",");
  return <span className="rolling-number reactbits-number"><span className="sr-only">{formatted}</span><span aria-hidden="true" className="counter-groups">{groups.map((group,i)=><span className="counter-group" key={groups.length-i}>{i>0&&<span>,</span>}<Counter value={Number(group)} places={[...group].map((_,j)=>10**(group.length-j-1))} fontSize={fontSize} gap={0} horizontalPadding={0} gradientHeight={0}/></span>)}</span></span>;
}
export function PlatformStats({data,isDemo=false}:{data?:PlatformStatsData;deals?:PublicDeal[];isDemo?:boolean}) {
  const [reduced,setReduced]=useState(true);
  useEffect(()=>{
    const media=matchMedia("(prefers-reduced-motion: reduce)");
    const update=()=>setReduced(media.matches);
    update();media.addEventListener("change",update);
    return ()=>{media.removeEventListener("change",update);};
  },[]);
  const metrics=[['昨日访问',data?.visits],['当前上架账号',data?.listings]] as const;
  return <section className="platform-activity" aria-label="平台统计与平台动态">
    <div className="activity-summary">
      <ChartNoAxesCombined className="activity-emblem" size={32} strokeWidth={1.7} aria-hidden="true" />
      <span>累计完成</span>
      {isPublicCount(data?.transactions)?<RollingNumber value={data.transactions} reduced={reduced} fontSize={28}/>:<span className="stat-unknown" aria-label="数据暂未提供">—</span>}
      <span>笔交易</span>
      {isDemo&&<Popover.Root><Popover.Trigger asChild><button className="stats-info" aria-label="统计数据说明：当前为演示数据"><Info size={15} aria-hidden="true"/></button></Popover.Trigger><Popover.Portal><Popover.Content className="stats-info-panel" side="bottom" sideOffset={8} collisionPadding={12}>当前为演示数据，不代表实际访问量、上架数量或成交记录。</Popover.Content></Popover.Portal></Popover.Root>}
    </div>
    <div className="activity-metrics">{metrics.map(([label,value])=><div key={label}><span>{label}</span>{isPublicCount(value)?<RollingNumber value={value} reduced={reduced} fontSize={20}/>:<span className="stat-unknown" aria-label="数据暂未提供">—</span>}</div>)}</div>
    <PlatformUpdateTicker />
  </section>;
}
