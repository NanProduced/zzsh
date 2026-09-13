"use client";
import { useState } from "react";
import { Heart, ImageOff, ArrowUpRight } from "lucide-react";
export interface AccountCardData {
  id: string; title: string; safeBox: string; hafeCoins: string;
  resourceFee: string; deposit: string; dailyConsumptionM: string; estimatedLease: string;
  imageSrc?: string;
}
export function AccountCard({ data, onActionNotice }: { data: AccountCardData; onActionNotice: (title: string, message: string) => void }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const missing = !data.imageSrc || failedSrc === data.imageSrc;
  return <article className="account-card" aria-label={data.title}>
    <div className="account-image">
      {missing ? <span className="image-fallback"><ImageOff size={22} />{data.imageSrc ? "图片加载失败" : "图片未提供"}</span> :
        <img src={data.imageSrc} alt={`${data.title}公开图片`} onError={() => setFailedSrc(data.imageSrc)} loading="lazy" />}
      <button className="icon-button favorite" aria-label={`收藏${data.title}`} onClick={() => onActionNotice("收藏暂不可用", "本次未保存收藏，请稍后再试。")}><Heart size={17} /></button>
    </div>
    <div className="account-content">
      <h3>{data.title}</h3><p className="account-resources">{data.hafeCoins} 哈夫币 <span> / </span>{data.safeBox} 安全箱</p>
      <dl className="account-fees"><div><dt>资源费用</dt><dd>¥{data.resourceFee}</dd></div><div><dt>押金</dt><dd>¥{data.deposit}</dd></div></dl>
      <dl className="account-terms"><div><dt>每日消耗</dt><dd>{data.dailyConsumptionM} M档</dd></div><div><dt>预计租期</dt><dd>{data.estimatedLease}</dd></div></dl>
      <button className="button account-detail" onClick={() => onActionNotice("账号详情暂不可用", "暂时无法打开该账号详情，请稍后再试。")}>查看账号<ArrowUpRight size={15} /></button>
    </div>
  </article>;
}
