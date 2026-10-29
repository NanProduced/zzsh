"use client";
import Link from "next/link";
import {
  ChevronRight,
  Coins,
  Crown,
  Gamepad2,
  Headphones,
  House,
  Search,
  ScrollText,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { helpCategories, helpCategoryLabel } from "@/content/help/types";
import { HelpNavAside, HelpNavDrawer } from "./help-nav";
import { HelpShell } from "./help-shell";
import { LegacyHashHandler } from "./help-article-extras";
import { SupportContactButton } from "@/components/support/support-contact-button";
import type { HelpArticleCard, HelpNavData } from "./nav-data";
import "./help.css";
import "./help-home.css";

/** 分类没有独立列表页：`/help?category=x` 在服务端 redirect 到该分类第一篇，分类入口直接指向文章。 */
export type HelpPageView =
  | { kind: "home"; featured: HelpArticleCard[] }
  | { kind: "search"; query: string; hits: HelpArticleCard[] };

type HelpPageProps = {
  view: HelpPageView;
  navData: HelpNavData;
  query: string;
  legacyHashMap: Record<string, string>;
};

const homeCategories: Record<string, { Icon: LucideIcon; start: string }> = {
  rental: { Icon: Gamepad2, start: 'rental-getting-started' },
  publish: { Icon: House, start: 'publish-prepare' },
  fees: { Icon: Coins, start: 'fees-overview' },
  account: { Icon: Shield, start: 'account-register-login' },
  'after-sale': { Icon: Headphones, start: 'issue-during-rental' },
  membership: { Icon: Crown, start: 'membership-benefits' },
};

function HomeView({ featured, navData }: { featured: HelpArticleCard[]; navData: HelpNavData }) {
  const agreements = navData.aux.find((c) => c.id === 'agreement')?.articles;
  const agreementSlug = (agreements?.find(article => article.slug === 'terms-and-privacy') ?? agreements?.[0])?.slug;
  if ([...navData.categories, ...navData.aux].every(group => group.articles.length === 0)) return <div className="help-empty" role="status"><h2>当前暂无公开帮助文档</h2><p>如需核对租赁或出租条件，请联系平台客服。</p><SupportContactButton className="help-contact-cta">联系平台客服</SupportContactButton></div>;

  return (
    <div className="help-home">
      <section className="help-home-services" aria-labelledby="help-services-title">
      <div className="help-home-section-header">
        <h2 className="help-home-section-title" id="help-services-title">按服务查找帮助</h2>
        <p className="help-home-section-desc">从租号到出租，找到你需要的服务说明。</p>
      </div>
      <nav className="help-home-categories-panel" aria-label="帮助分类">
        {helpCategories.filter(category => navData.categories.some(group => group.id === category.id && group.articles.length > 0)).map((category) => {
          const { Icon, start } = homeCategories[category.id]!;
          const articles = navData.categories.find((c) => c.id === category.id)?.articles;
          const targetSlug = (articles?.find(article => article.slug === start) ?? articles?.[0])?.slug;
          const targetHref = targetSlug ? `/help/${targetSlug}` : `/help?category=${category.id}`;
          return (
            <Link key={category.id} className="help-home-category-card" href={targetHref}>
              <div className="help-home-category-icon">
                <Icon size={28} strokeWidth={1.75} aria-hidden="true" />
              </div>
              <div className="help-home-category-info">
                <h3 className="help-home-category-title">{category.label}</h3>
                <p className="help-home-category-desc">{category.description}</p>
              </div>
              <ChevronRight size={16} className="help-home-category-arrow" aria-hidden="true" />
            </Link>
          );
        })}
      </nav>
      </section>

      {/* 常见问题 */}
      {featured.length > 0 ? <section className="help-home-section" aria-labelledby="help-featured-title">
        <div className="help-home-section-header">
          <h2 className="help-home-section-title" id="help-featured-title">常见问题</h2>
          <p className="help-home-section-desc">选一个问题，看看具体怎么做。</p>
        </div>
        <div className="help-home-faq-panel">
          {featured.map((article) => (
            <Link key={article.slug} className="help-home-faq-card" href={`/help/${article.slug}`}>
              <span className="help-home-faq-title">{article.title}</span>
              <ChevronRight size={16} className="help-home-faq-arrow" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section> : null}

      {/* 底部协议与客服入口 */}
      <div className="help-home-contact">
        <span className="help-home-contact-icon"><Headphones size={28} strokeWidth={1.75} aria-hidden="true" /></span>
        <div className="help-home-contact-copy"><h2>还没有找到答案？</h2><p>联系平台客服，继续帮你解决。</p></div>
        <SupportContactButton className="help-home-contact-action">
          <span>联系平台客服</span><ChevronRight size={17} aria-hidden="true" />
        </SupportContactButton>
      </div>
      {agreementSlug ? <p className="help-home-agreement"><Link href={`/help/${agreementSlug}`}><ScrollText size={15} aria-hidden="true" />查看平台协议与规则<ChevronRight size={14} aria-hidden="true" /></Link></p> : null}
    </div>
  );
}

function SearchView({ query, hits }: { query: string; hits: HelpArticleCard[] }) {
  return (
    <section className="help-category-view" aria-labelledby="help-search-title">
      <div className="help-category-header">
        <div className="help-search-header-row">
          <div>
            <h1 className="help-category-title" id="help-search-title">搜索结果</h1>
            <p className="help-category-desc">与 <strong>{query}</strong> 相关的帮助文档{hits.length > 0 ? `（${hits.length} 篇）` : ""}</p>
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
            const categoryLabel = helpCategoryLabel(article.category);
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
      ) : (
        <div className="help-empty">
          <Search size={32} className="help-empty-icon" aria-hidden="true" />
          <h3>未找到与「{query}」相关的帮助文档</h3>
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
      )}
    </section>
  );
}

function HelpHeroBanner({ navData }: { navData: HelpNavData }) {
  const available = new Set([...navData.categories, ...navData.aux].flatMap(group => group.articles.map(article => article.slug)));
  return (
    <section className="help-welcome" aria-labelledby="help-welcome-title">
      <div className="help-welcome-copy">
      <p className="help-welcome-eyebrow">洲洲商行 · 服务帮助</p>
      <h1 id="help-welcome-title">有问题，<span>找洲洲。</span></h1>
      <p className="help-welcome-description">租号、出租与账号问题，在这里找到答案。</p>
      <form action="/help" method="get" role="search" aria-label="查找服务帮助" className="help-hero-search">
        <Search size={22} strokeWidth={1.8} aria-hidden="true" />
        <input type="search" name="q" aria-label="搜索租号、押金或退款问题" placeholder="搜索租号、押金、退款等问题" maxLength={120} />
        <button type="submit"><Search size={18} aria-hidden="true" /><span>搜索</span></button>
      </form>
      <nav className="help-quick-start" aria-label="常用服务指南">
        <span>快捷帮助</span>
        {available.has("rental-getting-started") ? <Link href="/help/rental-getting-started">租号流程</Link> : null}
        {available.has("publish-prepare") ? <Link href="/help/publish-prepare">上架须知</Link> : null}
        {available.has("fees-refund-status") ? <Link href="/help/fees-refund-status">退款说明</Link> : null}
        {available.has("account-register-login") ? <Link href="/help/account-register-login">账号安全</Link> : null}
      </nav>
      </div>
      <picture className="help-welcome-art" aria-hidden="true">
        <source type="image/webp" srcSet="/images/help/zhouzhou-service-v1-480.webp 480w, /images/help/zhouzhou-service-v1-960.webp 960w" sizes="(max-width: 640px) 170px, (max-width: 1000px) 360px, 550px" />
        <img src="/images/help/zhouzhou-service-v1-960.webp" width={960} height={640} alt="" fetchPriority="high" decoding="async" />
      </picture>
    </section>
  );
}

export function HelpPage({ view, navData, query, legacyHashMap }: HelpPageProps) {
  const isHome = view.kind === "home";
  const breadcrumbs = view.kind === "search"
    ? [{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: "搜索结果" }]
    : [{ label: "首页", href: "/" }, { label: "帮助中心" }];

  return (
    <HelpShell
      breadcrumbs={isHome ? [] : breadcrumbs}
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
          <HelpHeroBanner navData={navData} />
          <HomeView featured={view.featured} navData={navData} />
        </div>
      ) : (
        <div className="help-layout help-layout--category">
          <HelpNavAside data={navData} />
          <div className="help-main">
            <HelpNavDrawer data={navData} />
            {view.kind === "search" ? <SearchView query={view.query} hits={view.hits} /> : null}
          </div>
        </div>
      )}
    </HelpShell>
  );
}
