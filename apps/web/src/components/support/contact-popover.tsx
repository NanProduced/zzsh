"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { MessageCircle, QrCode, X } from "lucide-react";
import { publicContacts } from "../../lib/service-navigation";
export function ContactPopover({kind,children,className,side="right"}:{kind:keyof typeof publicContacts;children:ReactNode;className?:string;side?:"left"|"right"}) {
  const [open,setOpen]=useState(false);
  const pinned=useRef(false), explicit=useRef(false);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const panel=useRef<HTMLDivElement>(null);
  const channel=publicContacts[kind];
  const cancel=()=>{if(timer.current)clearTimeout(timer.current);};
  const enter=()=>{cancel();setOpen(true);};
  const leave=()=>{cancel();timer.current=setTimeout(()=>{if(!pinned.current)setOpen(false);},180);};
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  return <Popover.Root open={open} onOpenChange={value=>{setOpen(value);if(!value)pinned.current=false;}}>
    <Popover.Trigger asChild><button className={className} onPointerEnter={e=>{if(e.pointerType==='mouse')enter();}} onPointerLeave={leave}
      onClick={e=>{e.preventDefault();cancel();explicit.current=true;pinned.current=!pinned.current;setOpen(pinned.current);if(pinned.current)requestAnimationFrame(()=>panel.current?.focus());}}>{children}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content ref={panel} tabIndex={-1} aria-label={channel.title} className="contact-panel" side={side} sideOffset={12} collisionPadding={12}
      onPointerEnter={cancel} onPointerLeave={leave} onOpenAutoFocus={e=>e.preventDefault()} onCloseAutoFocus={e=>{if(!explicit.current)e.preventDefault();explicit.current=false;}}>
      <div className="contact-panel-heading"><MessageCircle size={23}/><h2>{channel.title}</h2><Popover.Close className="icon-button" aria-label="关闭咨询面板"><X size={18}/></Popover.Close></div>
      <p>{channel.description}</p>
      {channel.qrSrc?<img className="contact-qr" src={channel.qrSrc} alt={`${channel.title}二维码`}/>:<div className="contact-unavailable"><QrCode size={38}/><strong>{kind==='follow'?'社交账号暂未公布':'联系入口待更新'}</strong><span>请稍后再来查看</span></div>}
      {channel.handle&&<p>{channel.handle}</p>}
      {kind==='escort'&&<small>微信咨询 · 本站暂不提供护航代肝下单</small>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
