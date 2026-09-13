import Link from "next/link";
import { Gamepad2, Upload, Zap, Shield, ArrowUpRight } from "lucide-react";
import { serviceLinks } from "../../lib/service-navigation";
import { ContactPopover } from "../support/contact-popover";
export function ServiceNavStack() {
  const icons={rent:Gamepad2,publish:Upload,fast:Zap};
  return <nav className="service-stack service-categories" aria-label="服务类目">
    {serviceLinks.map(item=>{const Icon=icons[item.icon];return <Link key={item.href} href={item.href}><span className="service-icon"><Icon size={21}/></span><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowUpRight className="service-arrow"/></Link>;})}
    <ContactPopover kind="escort" className="service-consult"><span className="service-icon"><Shield size={21}/></span><span><strong>护航代肝</strong><small>微信咨询 · 了解服务安排</small></span><ArrowUpRight className="service-arrow"/></ContactPopover>
  </nav>;
}
