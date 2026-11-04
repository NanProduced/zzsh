"use client";

import { useState } from "react";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import { DEFAULT_RESOURCES, type FooterResource } from "@zzsh/content";
import { usePublicContent } from "@/components/content/public-content-provider";
import { SupportContactButton } from "@/components/support/support-contact-button";
import "./header-footer.css";

const defaults = DEFAULT_RESOURCES["placement:FOOTER"] as FooterResource;
const empty: FooterResource = { ...defaults, copyright: "", icp: "", policeRegion: "", policeCode: "", licenseUrl: null, help: [], support: [], complaint: false, socials: [] };

function Social({ label, href, qr }: { label: string; href: string | null; qr: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!qr) return href ? <a href={href}>{label}</a> : null;
  return <Popover.Root><Popover.Trigger asChild><button type="button">{label}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="site-footer-social-panel" sideOffset={8} collisionPadding={16} aria-label={`${label}二维码`}>
      {failed === qr ? <p role="status">二维码暂时无法读取</p> : <img src={qr} alt={`${label}二维码`} onError={() => setFailed(qr)} />}
      {href ? <a href={href}>访问{label}</a> : null}
      <Popover.Close aria-label={`关闭${label}二维码`}>关闭</Popover.Close>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

export function PortalFooter() {
  const { resource } = usePublicContent("placement:FOOTER");
  const footer = resource ? resource.state === "available" && resource.payload?.kind === "footer" ? resource.payload : empty : defaults;
  return <footer className="site-footer">
    <div className="portal-width site-footer-inner">
      <div className="site-footer-top">
        <div className="site-footer-brand"><Link href="/" aria-label="洲洲商行首页"><img className="brand-logo" src="/brand/zzsh-logo-variant-05@480.png" width={216} height={72} alt="洲洲商行" /></Link><p>玩得更远，一直有洲洲。</p></div>
        <div className="site-footer-contact"><SupportContactButton className="site-footer-support">联系客服</SupportContactButton>
          {footer.socials.map((social, index) => <Social key={`${social.label}:${index}`} label={social.label} href={social.href} qr={social.qrMediaId ? resource?.media.find(item => item.id === social.qrMediaId)?.url ?? null : null} />)}
        </div>
      </div>
      <div className="site-footer-links">
        {([["使用帮助", footer.help], ["服务支持", footer.support]] as const).map(([title, links]) => links.length || title === "服务支持" ? <nav key={title} aria-label={title}><h2>{title}</h2><ul>{links.map((link, index) => <li key={`${link.label}:${index}`}><a href={link.href}>{link.label}</a></li>)}{title === "服务支持" ? <><li><Link href="/updates">平台动态</Link></li>{footer.complaint ? <li><SupportContactButton type="COMPLAINT">投诉建议</SupportContactButton></li> : null}</> : null}</ul></nav> : null)}
      </div>
      <div className="site-footer-bottom">
        <div>{footer.copyright ? <span>© {new Date().getFullYear()} {footer.copyright}</span> : null}<Link href="/legal/terms">平台服务协议</Link><Link href="/legal/privacy">用户隐私政策</Link>{footer.licenseUrl ? <a href={footer.licenseUrl}>营业执照</a> : null}</div>
        {footer.icp || footer.policeCode ? <div>{footer.icp ? <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{footer.icp}</a> : null}{footer.policeCode ? <a href={`https://beian.gov.cn/portal/registerSystemInfo?recordcode=${footer.policeCode}`} target="_blank" rel="noopener noreferrer">{footer.policeRegion}公网安备{footer.policeCode}号</a> : null}</div> : null}
      </div>
    </div>
  </footer>;
}
