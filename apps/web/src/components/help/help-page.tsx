"use client";
import Link from "next/link";
import {
  ChevronRight,
  Coins,
  FileText,
  Gamepad2,
  Headphones,
  MessageSquare,
  ScrollText,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";
import { helpAuxCategories, helpCategories, helpCategoryLabel, type AnyHelpCategoryId } from "@/content/help/types";
import { HelpNavAside, HelpNavDrawer } from "./help-nav";
import { HelpShell } from "./help-shell";
import { LegacyHashHandler } from "./help-article-extras";
import { SupportContactButton } from "@/components/support/support-contact-button";
import type { HelpArticleCard, HelpNavData } from "./nav-data";
import "./help.css";

export type HelpPageView =
  | { kind: "home"; featured: HelpArticleCard[] }
  | { kind: "category"; category: AnyHelpCategoryId; articles: HelpArticleCard[] }
  | { kind: "search"; query: string; hits: HelpArticleCard[] };

type HelpPageProps = {
  view: HelpPageView;
  navData: HelpNavData;
  query: string;
  legacyHashMap: Record<string, string>;
};

const homeCategoryIcons: Record<string, LucideIcon> = {
  rental: Gamepad2,
  publish: FileText,
  fees: Coins,
  account: Shield,
  "after-sale": Headphones,
  membership: Users,
  agreement: ScrollText,
};

function HomeView({ featured, navData }: { featured: HelpArticleCard[]; navData: HelpNavData }) {
  const agreementSlug = navData.aux.find((c) => c.id === "agreement")?.articles[0]?.slug ?? "terms-and-privacy";

  return (
    <div className="help-home">
      {/* 6 分类入口网格：点击直接进入该分类首篇文档，三栏布局直接展示文章内容 */}
      <nav className="help-home-categories-panel" aria-label="帮助分类">
        {helpCategories.map((category) => {
          const Icon = homeCategoryIcons[category.id] ?? Gamepad2;
          const targetSlug = navData.categories.find((c) => c.id === category.id)?.articles[0]?.slug;
          const targetHref = targetSlug ? `/help/${targetSlug}` : `/help?category=${category.id}`;
          return (
            <Link key={category.id} className="help-home-category-card" href={targetHref}>
              <div className="help-home-category-icon">
                <Icon size={20} aria-hidden="true" />
              </div>
              <div className="help-home-category-info">
                <h2 className="help-home-category-title">{category.label}</h2>
                <p className="help-home-category-desc">{category.description}</p>
              </div>
              <ChevronRight size={16} className="help-home-category-arrow" aria-hidden="true" />
            </Link>
          );
        })}
      </nav>

      {/* 常见问题 */}
      <section className="help-home-section" aria-labelledby="help-featured-title">
        <div className="help-home-section-header">
          <h2 className="help-home-section-title" id="help-featured-title">常见问题</h2>
          <p className="help-home-section-desc">以下是大家最关心的问题，点击查看相关说明。</p>
        </div>
        <div className="help-home-faq-panel">
          {featured.map((article) => (
            <Link key={article.slug} className="help-home-faq-card" href={`/help/${article.slug}`}>
              <span className="help-home-faq-title">{article.title}</span>
              <ChevronRight size={16} className="help-home-faq-arrow" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section>

      {/* 底部协议与客服入口 */}
      <div className="help-home-bottom-panel">
        <Link className="help-home-bottom-card" href={`/help/${agreementSlug}`}>
          <FileText size={18} className="help-home-bottom-icon" aria-hidden="true" />
          <span className="help-home-bottom-title">协议与规则</span>
          <ChevronRight size={16} className="help-home-bottom-arrow" aria-hidden="true" />
        </Link>
        <SupportContactButton className="help-home-bottom-card help-home-bottom-card--support">
          <MessageSquare size={18} className="help-home-bottom-icon" aria-hidden="true" />
          <span className="help-home-bottom-title">联系平台客服</span>
          <ChevronRight size={16} className="help-home-bottom-arrow" aria-hidden="true" />
        </SupportContactButton>
      </div>
    </div>
  );
}

function CategoryView({ category, articles }: { category: AnyHelpCategoryId; articles: HelpArticleCard[] }) {
  const meta = [...helpCategories, ...helpAuxCategories].find((c) => c.id === category);
  return (
    <section className="help-category-view" aria-labelledby="help-category-title">
      <div className="help-category-header">
        <h1 className="help-category-title" id="help-category-title">{meta?.label ?? "分类"}</h1>
        {meta?.description ? <p className="help-category-desc">{meta.description}</p> : null}
      </div>
      <div className="help-category-divider" />
      <ul className="help-category-article-list">
        {articles.map((article) => (
          <li key={article.slug} className="help-category-article-item">
            <Link className="help-category-article-link" href={`/help/${article.slug}`}>
              <div className="help-category-article-content">
                <h2 className="help-category-article-title">{article.title}</h2>
                <p className="help-category-article-summary">{article.summary}</p>
              </div>
              <ChevronRight size={18} className="help-category-article-arrow" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      <div className="help-category-support-card">
        <div className="help-category-support-icon">
          <Headphones size={22} aria-hidden="true" />
        </div>
        <div className="help-category-support-info">
          <h3>需要帮助？</h3>
          <p>如果在{meta?.label ?? "平台使用"}过程中遇到问题，可以联系平台客服获取帮助。</p>
        </div>
        <SupportContactButton className="help-contact-cta">
          <span>联系平台客服</span>
        </SupportContactButton>
      </div>
    </section>
  );
}

function SearchView({ query, hits }: { query: string; hits: HelpArticleCard[] }) {
  return (
    <section className="help-category-view" aria-labelledby="help-search-title">
      <div className="help-category-header">
        <h1 className="help-category-title" id="help-search-title">搜索结果</h1>
        <p className="help-category-desc">与 <strong>{query}</strong> 相关的帮助文档{hits.length > 0 ? `（${hits.length} 篇）` : ""}</p>
      </div>
      <div className="help-category-divider" />
      {hits.length > 0 ? (
        <ul className="help-category-article-list">
          {hits.map((article) => (
            <li key={article.slug} className="help-category-article-item">
              <Link className="help-category-article-link" href={`/help/${article.slug}`}>
                <div className="help-category-article-content">
                  <h2 className="help-category-article-title">{article.title}</h2>
                  <p className="help-category-article-summary">{article.summary}</p>
                </div>
                <ChevronRight size={18} className="help-category-article-arrow" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="help-empty">
          <h3>没有找到相关文档</h3>
          <p>换个关键词试试，例如「押金」「提前结束」「人脸」；也可以按分类浏览，或直接联系平台客服。</p>
          <div className="help-empty-actions">
            <Link className="help-contact-cta" href="/help">浏览全部帮助</Link>
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

function HelpHeroBanner() {
  return (
    <div className="help-hero-banner" role="region" aria-label="帮助中心视觉横幅">
      <picture>
        <source
          media="(max-width: 640px)"
          srcSet="/images/help/help-hero-banner-mobile.png 1x, /images/help/help-hero-banner-mobile@2x.png 2x"
          width={640}
          height={180}
        />
        <img
          src="/images/help/help-hero-banner.png"
          srcSet="/images/help/help-hero-banner.png 1x, /images/help/help-hero-banner@2x.png 2x"
          alt="帮助中心：租号、出租与账号问题，在这里找到答案。"
          width={1280}
          height={220}
          className="help-hero-banner-img"
          loading="eager"
        />
      </picture>
    </div>
  );
}

export function HelpPage({ view, navData, query, legacyHashMap }: HelpPageProps) {
  const isHome = view.kind === "home";
  const breadcrumbs = view.kind === "category"
    ? [{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: helpCategoryLabel(view.category) }]
    : view.kind === "search"
      ? [{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: "搜索结果" }]
      : [{ label: "首页", href: "/" }, { label: "帮助中心" }];

  return (
    <HelpShell
      breadcrumbs={breadcrumbs}
      title="帮助中心"
      description={isHome ? "租号、出租与账号问题，在这里找到答案。" : undefined}
      initialQuery={query}
      showPageHeading={false}
      headingInContent={!isHome}
      topContent={isHome ? <HelpHeroBanner /> : undefined}
    >
      {isHome ? <LegacyHashHandler map={legacyHashMap} /> : null}
      {isHome ? (
        <div className="help-layout help-layout--home">
          <HomeView featured={view.featured} navData={navData} />
        </div>
      ) : (
        <div className="help-layout help-layout--category">
          <HelpNavAside
            data={navData}
            activeCategory={view.kind === "category" ? view.category : undefined}
          />
          <div className="help-main">
            <HelpNavDrawer
              data={navData}
              activeCategory={view.kind === "category" ? view.category : undefined}
            />
            {view.kind === "category" ? <CategoryView category={view.category} articles={view.articles} /> : null}
            {view.kind === "search" ? <SearchView query={view.query} hits={view.hits} /> : null}
          </div>
        </div>
      )}
    </HelpShell>
  );
}
