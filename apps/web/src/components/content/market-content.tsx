"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { QrCode, X } from "lucide-react";
import { usePublicContent } from "./public-content-provider";

export function ManagedMarketBanner() {
  const { resource } = usePublicContent("placement:MARKET_DELTA_BANNER");
  const [failed, setFailed] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => { const media = window.matchMedia("(max-width: 799px)"); const update = () => setNarrow(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const payload = resource?.payload?.kind === "banner" ? resource.payload : null;
  const desktop = payload?.mediaId ? resource?.media.find(item => item.id === payload.mediaId)?.url : null;
  const mobile = payload?.mobileMediaId ? resource?.media.find(item => item.id === payload.mobileMediaId)?.url : null;
  if (!desktop || failed === desktop) return <Link className="market-poster-link" href="#account-list" aria-label="浏览三角洲资源账号"><img src="/art/zhouzhou/delta-section-banner-poster-v3@1080.webp" srcSet="/art/zhouzhou/delta-section-banner-poster-v3@1080.webp 1080w, /art/zhouzhou/delta-section-banner-poster-v3@1620.webp 1620w, /art/zhouzhou/delta-section-banner-poster-v3.png 2172w" sizes="(max-width: 799px) 96vw, 1056px" alt="三角洲行动账号租赁专区" fetchPriority="high" /></Link>;
  return <Link className="market-poster-link" href="#account-list" aria-label="浏览三角洲资源账号">
    <picture>{mobile && failed !== mobile ? <source media="(max-width: 799px)" srcSet={mobile} /> : null}<img src={desktop} alt="三角洲行动账号租赁专区" onError={() => setFailed(narrow && mobile && failed !== mobile ? mobile : desktop)} /></picture>
  </Link>;
}

export function ManagedMarketContact({ channel }: { channel: "MARKET_PLAYER_GROUP" | "MARKET_COOPERATION" }) {
  const { status, resource, retry } = usePublicContent(`placement:${channel}`);
  const payload = resource?.payload?.kind === "contact" ? resource.payload : null;
  const title = channel === "MARKET_PLAYER_GROUP" ? "玩家交流群" : "合作咨询";
  const description = channel === "MARKET_PLAYER_GROUP" ? "玩家交流用途；订单沟通和交易请通过站内客服与订单群。" : "商务合作咨询；请勿通过私人二维码支付租号订单。";
  const src = payload?.qrMediaId ? resource?.media.find(item => item.id === payload.qrMediaId)?.url : null;
  const [failed, setFailed] = useState<string | null>(null);
  const ready = Boolean(src && failed !== src);
  const template = channel === "MARKET_PLAYER_GROUP" ? "group-qr-card-v3" : "cooperation-qr-card-v3";
  return <Dialog.Root><div className="market-contact-card">
    <img src={`/art/zhouzhou/${template}@810.webp`} sizes="(max-width: 799px) 46vw, 300px" alt={`${title}联系卡`} loading="lazy" decoding="async" />
    {ready ? <Dialog.Trigger asChild><button type="button" className="market-qr-binding" aria-label={`放大查看${title}二维码`}><img src={src!} alt={`${title}二维码`} onError={() => setFailed(src!)} /><span>点击放大</span></button></Dialog.Trigger>
      : <div className="market-qr-placeholder" role="status"><QrCode size={16} aria-hidden="true" /><span>{status === "loading" ? "读取中" : status === "error" || payload?.qrMediaId ? "暂不可读" : "待配置"}</span>{status !== "loading" && (status === "error" || payload?.qrMediaId) ? <button type="button" className="button quiet" onClick={() => { setFailed(null); retry(); }}>重试</button> : null}</div>}
  </div>
    <Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className="managed-contact-dialog" aria-describedby={undefined}>
      <header><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭二维码"><X size={18} aria-hidden="true" /></Dialog.Close></header>
      <p>{description}</p>
      {ready ? <img className="managed-contact-qr" src={src!} alt={`${title}二维码`} onError={() => setFailed(src!)} /> : <p role="status">二维码暂时无法读取。<button type="button" className="button quiet" onClick={() => { setFailed(null); retry(); }}>重试读取</button></p>}
      <p>订单沟通和支付请通过站内客服与订单页面。</p>
      {ready ? <a className="button secondary" href={src!} download>保存二维码</a> : null}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
