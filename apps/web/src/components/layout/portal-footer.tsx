"use client";
import Link from "next/link";
import { BrandLogo } from "@/components/brand/brand-logo";
import "./header-footer.css";

// Adapted from SmoothUI footer-1 (MIT); see docs/third-party-ui.md.
const groups: {title:string;links:[string,string][]}[] = [
  { title: "账号服务", links: [["租账号", "/accounts"], ["上架出租", "/publish"]] },
  { title: "租赁指南", links: [["租号流程", "/help#rental-guide"], ["费用与租期", "/help#billing-guide"], ["发布须知", "/help#publish-guide"]] },
  { title: "规则与支持", links: [["帮助与规则", "/help"], ["登录 / 注册", "/login"]] },
];
export function PortalFooter() {
  return <footer className="site-footer">
    <div className="portal-width site-footer-inner">
      <div className="site-footer-grid">
        <div className="site-footer-brand">
          <a href="/" aria-label="洲洲商行首页"><BrandLogo height={54} /></a>
          <p>挑选资源账号，先看清费用与条件。</p>
          <span>三角洲资源租赁 · 真人客服协助履约</span>
        </div>
        <div className="site-footer-links">
          {groups.map((group) => <nav key={group.title} aria-label={group.title}>
            <h2>{group.title}</h2>
            <ul>{group.links.map(([label, href]) => <li key={label}><Link href={href}>{label}</Link></li>)}</ul>
          </nav>)}
        </div>
      </div>
      <div className="site-footer-bottom"><p>© {new Date().getFullYear()} 洲洲商行</p></div>
    </div>
  </footer>;
}
