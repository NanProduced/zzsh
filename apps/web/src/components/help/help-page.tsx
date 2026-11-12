"use client";
import Link from "next/link";
import {
  ChevronRight,
  Coins,
  Crown,
  FileText,
  Gamepad2,
  Headphones,
  House,
  Search,
  ScrollText,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { helpCategories, helpCategoryLabel } from "@/content/help/types";
import { helpFolderIcon, HelpNavAside, HelpNavDrawer } from "./help-nav";
import { HelpShell } from "./help-shell";
import { LegacyHashHandler } from "./help-article-extras";
import { SupportContactButton } from "@/components/support/support-contact-button";
import { findHelpGroup, flattenHelpNavArticles, type HelpArticleCard, type HelpNavData } from "./nav-data";
import "./help.css";
import "./help-home.css";

export type HelpPageView =
  | { kind: "home"; featured: HelpArticleCard[] }
  | { kind: "category"; title: string; description: string | null; hits: HelpArticleCard[] }
  | { kind: "search"; query: string; hits: HelpArticleCard[] };

type HelpPageProps = {
  view: HelpPageView;
  navData: HelpNavData;
  query: string;
  legacyHashMap: Record<string, string>;
};

const homeCategoryIcons: Record<string, LucideIcon> = {
  rental: Gamepad2,
  publish: House,
  fees: Coins,
  account: Shield,
  "after-sale": Headphones,
  membership: Crown,
};

function HomeView({ featured, navData }: { featured: HelpArticleCard[]; navData: HelpNavData }) {
  const agreement = findHelpGroup(navData, "agreement");
  const agreements = agreement ? flattenHelpNavArticles({ entries: agreement.children }) : [];
  const agreementSlug = (agreements.find(article => article.slug === "terms-and-privacy") ?? agreements[0])?.slug;
  if (!navData.entries.length) return <div className="help-empty" role="status"><h2>当前暂无公开帮助文档</h2><p>如需核对租赁或出租条件，请联系平台客服。</p><SupportContactButton className="help-contact-cta">联系平台客服</SupportContactButton></div>;

  return (
    <div className="help-home">
      {featured.length > 0 ? <section className="help-home-section" aria-labelledby="help-featured-title">
        <div className="help-home-section-header">
          <h2 className="help-home-section-title" id="help-featured-title">常见问题</h2>
          <Link className="help-home-browse" href="#help-services-title">浏览全部分类 <ChevronRight size={15} aria-hidden="true" /></Link>
        </div>
        <div className="help-home-faq-panel">
          {featured.slice(0, 4).map((article) => (
            <Link key={article.slug} className="help-home-faq-card" href={`/help/${article.slug}`}>
              <span>
                <span className="help-home-faq-category">{article.categoryLabel ?? helpCategoryLabel(article.category)}</span>
                <strong className="help-home-faq-title">{article.title}</strong>
              </span>
              <ChevronRight size={16} className="help-home-faq-arrow" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section> : null}
      <section className="help-home-services" aria-labelledby="help-services-title">
      <div className="help-home-section-header">
        <h2 className="help-home-section-title" id="help-services-title">按主题找帮助</h2>
      </div>
      <nav className="help-home-categories-panel" aria-label="帮助分类">
        {navData.entries.filter(entry => entry.id !== "agreement").map(entry => {
          const preset = Object.hasOwn(homeCategoryIcons, entry.id) ? homeCategoryIcons[entry.id] : undefined;
          const articles = entry.kind === "FOLDER" ? flattenHelpNavArticles({ entries: entry.children }) : [entry];
          const Icon = entry.kind === "ARTICLE" ? FileText : entry.iconKey ? helpFolderIcon(entry.iconKey, entry.id) : preset ?? helpFolderIcon(null, entry.id);
          const description = entry.kind === "FOLDER" ? entry.description ?? helpCategories.find(category => category.id === entry.id)?.description : null;
          const label = <>
              <span className="help-home-category-icon"><Icon size={19} strokeWidth={1.75} aria-hidden="true" /></span>
              <span className="help-home-category-info">
                <strong className="help-home-category-title">{entry.title}</strong>
                {description ? <span className="help-home-category-desc">{description}</span> : null}
              </span>
              <ChevronRight size={16} className="help-home-category-arrow" aria-hidden="true" />
          </>;
          return entry.kind === "ARTICLE"
            ? <Link key={entry.id} className="help-home-category-card" href={`/help/${entry.slug}`}>{label}</Link>
            : <details key={entry.id} className="help-home-category-card">
                <summary>{label}</summary>
                <ul className="help-home-category-articles">
                  {articles.slice(0, 3).map(({ slug, title }) => <li key={slug}><Link href={`/help/${slug}`}>{title}</Link></li>)}
                </ul>
                {articles.length > 3 ? <Link className="help-home-category-more" href={`/help?category=${encodeURIComponent(entry.id)}`}>查看全部 {articles.length} 篇</Link> : null}
              </details>;
        })}
      </nav>
      </section>

      <section className="help-home-contact" aria-labelledby="help-home-contact-title">
        <span className="help-home-contact-icon"><Headphones size={19} strokeWidth={1.75} aria-hidden="true" /></span>
        <div className="help-home-contact-copy">
          <h2 id="help-home-contact-title">还没找到答案？</h2>
          <p>订单或账号问题，可请客服协助核实。</p>
        </div>
        <SupportContactButton className="help-home-contact-action">
          <span>联系平台客服</span><ChevronRight size={17} aria-hidden="true" />
        </SupportContactButton>
      </section>
      {agreementSlug ? <p className="help-home-agreement"><Link href={`/help/${agreementSlug}`}><ScrollText size={15} aria-hidden="true" />查看平台协议与规则<ChevronRight size={14} aria-hidden="true" /></Link></p> : null}
    </div>
  );
}

function ResultsView({ view }: { view: Exclude<HelpPageView, { kind: "home" }> }) {
  const { hits } = view;
  const isSearch = view.kind === "search";
  return (
    <section className="help-category-view" aria-labelledby="help-search-title">
      <div className="help-category-header">
        <div className="help-search-header-row">
          <div>
            <h1 className="help-category-title" id="help-search-title">{isSearch ? "搜索结果" : view.title}</h1>
            <p className="help-category-desc">{isSearch ? <>与 <strong>{view.query}</strong> 相关的帮助文档</> : view.description || "此分类的帮助文档"}{hits.length > 0 ? `（${hits.length} 篇）` : ""}</p>
          </div>
          <Link href="/help" className="help-search-back-link">
            返回帮助中心
          </Link>
        </div>
      </div>
      <div className="help-category-divider" />
      {hits.length > 0 ? (
        <ul className="help-category-article-list">
          {hits.map((article) => {
            const categoryLabel = article.categoryLabel ?? helpCategoryLabel(article.category);
            return (
              <li key={article.slug} className="help-category-article-item">
                <Link className="help-category-article-link" href={`/help/${article.slug}`}>
                  <div className="help-category-article-content">
                    <div className="help-category-article-badges">
                      <span className="help-audience-badge">{categoryLabel}</span>
                      {article.audience.length > 0 ? (
                        <span className="help-article-audience-text">{article.audience.join(" · ")}</span>
                      ) : null}
                      {article.game ? (
                        <span className="help-tag help-tag--accent">适用：{article.game}</span>
                      ) : null}
                    </div>
                    <h2 className="help-category-article-title">{article.title}</h2>
                    <p className="help-category-article-summary">{article.summary}</p>
                  </div>
                  <ChevronRight size={18} className="help-category-article-arrow" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : isSearch ? (
        <div className="help-empty">
          <Search size={32} className="help-empty-icon" aria-hidden="true" />
          <h2>未找到与「{view.query}」相关的帮助文档</h2>
          <p>换个关键词试试，例如「押金」「提前结束」「人脸」「退款」；也可以按分类浏览，或直接联系平台客服。</p>
          <div className="help-empty-tags">
            <span className="help-empty-tags-label">常见搜索：</span>
            <Link href="/help?q=押金" className="help-empty-tag">押金</Link>
            <Link href="/help?q=提前结束" className="help-empty-tag">提前结束</Link>
            <Link href="/help?q=退款" className="help-empty-tag">退款</Link>
            <Link href="/help?q=人脸" className="help-empty-tag">人脸</Link>
            <Link href="/help?q=换绑" className="help-empty-tag">换绑</Link>
          </div>
          <div className="help-empty-actions">
            <Link className="help-contact-cta help-contact-cta--primary" href="/help">浏览全部帮助</Link>
            <SupportContactButton className="help-contact-cta">
              <Headphones size={16} aria-hidden="true" />
              <span>联系平台客服</span>
            </SupportContactButton>
          </div>
        </div>
      ) : <p className="help-empty">此分类暂时没有可阅读的帮助文档。</p>}
    </section>
  );
}

function HelpHeroBanner() {
  return (
    <section className="help-welcome" aria-labelledby="help-welcome-title">
      <div className="help-welcome-copy">
      <h1 id="help-welcome-title">有问题，<span>找洲洲。</span></h1>
      <p className="help-welcome-description">租号、出租与账号问题，在这里找到答案。</p>
      </div>
      <form action="/help" method="get" role="search" aria-label="查找服务帮助" className="help-hero-search">
        <Search size={22} strokeWidth={1.8} aria-hidden="true" />
        <input type="search" name="q" aria-label="搜索租号、押金或退款问题" placeholder="搜索租号、押金、退款等问题" maxLength={120} />
        <button type="submit">搜索</button>
      </form>
      <picture className="help-welcome-art" aria-hidden="true">
        <source type="image/webp" srcSet="/images/help/zhouzhou-service-v1-480.webp 480w, /images/help/zhouzhou-service-v1-960.webp 960w" sizes="(max-width: 640px) 170px, 400px" />
        <img src="/images/help/zhouzhou-service-v1-960.webp" width={960} height={640} alt="" fetchPriority="high" decoding="async" />
      </picture>
    </section>
  );
}

export function HelpPage({ view, navData, query, legacyHashMap }: HelpPageProps) {
  const isHome = view.kind === "home";
  const breadcrumbs = isHome ? [] : [{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: view.kind === "search" ? "搜索结果" : view.title }];

  return (
    <HelpShell
      breadcrumbs={breadcrumbs}
      title="帮助中心"
      description={isHome ? "租号、出租与账号问题，在这里找到答案。" : undefined}
      initialQuery={query}
      showPageHeading={false}
      headingInContent
      home={isHome}
    >
      {isHome ? <LegacyHashHandler map={legacyHashMap} /> : null}
      {isHome ? (
        <div className="help-layout help-layout--home">
          <HelpHeroBanner />
          <HomeView featured={view.featured} navData={navData} />
        </div>
      ) : (
        <div className="help-layout help-layout--category">
          <HelpNavAside data={navData} />
          <div className="help-main">
            <HelpNavDrawer data={navData} />
            <ResultsView view={view} />
          </div>
        </div>
      )}
    </HelpShell>
  );
}
