"use client";
import Link from "next/link";
import { ChevronRight, Headphones } from "lucide-react";
import { helpAuxCategories, helpCategories, helpCategoryLabel, type AnyHelpCategoryId } from "@/content/help/types";
import { HelpNavAside, HelpNavDrawer } from "./help-nav";
import { HelpShell } from "./help-shell";
import { LegacyHashHandler } from "./help-article-extras";
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

function ArticleCard({ article }: { article: HelpArticleCard }) {
  return (
    <li>
      <Link className="help-article-item-link" href={`/help/${article.slug}`}>
        <h3>{article.title}</h3>
        <p>{article.summary}</p>
        <span className="help-article-tags">
          <span className="help-tag">{helpCategoryLabel(article.category)}</span>
          {article.audience.map((a) => <span key={a} className="help-tag">{a}</span>)}
          {article.game ? <span className="help-tag help-tag--accent">适用：{article.game}</span> : null}
        </span>
      </Link>
    </li>
  );
}

function HomeView({ featured }: { featured: HelpArticleCard[] }) {
  return (
    <>
      <section aria-labelledby="help-featured-title">
        <h2 className="help-section-title" id="help-featured-title">推荐问题</h2>
        <p className="help-section-desc">人工挑选的代表问题，也可以在顶部直接搜索帮助文档。</p>
        <ul className="help-featured">
          {featured.map((article) => (
            <li key={article.slug}>
              <Link className="help-featured-link" href={`/help/${article.slug}`}>
                <ChevronRight size={14} className="help-link-arrow" aria-hidden="true" />
                <span>{article.title}<small>{article.summary}</small></span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="help-categories-title">
        <h2 className="help-section-title" id="help-categories-title">按任务浏览</h2>
        <p className="help-section-desc">选择与你当前任务最接近的分类。</p>
        <div className="help-category-grid">
          {helpCategories.map((category) => (
            <Link key={category.id} className="help-category-card" href={`/help?category=${category.id}`}>
              <h3>{category.label}</h3>
              <p>{category.description}</p>
            </Link>
          ))}
        </div>
      </section>
      <section aria-labelledby="help-agreement-title" style={{ marginTop: 34 }}>
        <h2 className="help-section-title" id="help-agreement-title">协议与规则</h2>
        <div className="help-category-grid">
          {helpAuxCategories.map((category) => (
            <Link key={category.id} className="help-category-card" href={`/help?category=${category.id}`}>
              <h3>{category.label}</h3>
              <p>{category.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

function CategoryView({ category, articles }: { category: AnyHelpCategoryId; articles: HelpArticleCard[] }) {
  const meta = [...helpCategories, ...helpAuxCategories].find((c) => c.id === category);
  return (
    <section aria-labelledby="help-category-title">
      <h2 className="help-section-title" id="help-category-title">{meta?.label ?? "分类"}</h2>
      <p className="help-section-desc">{meta?.description ?? ""}</p>
      <ul className="help-article-list">
        {articles.map((article) => <ArticleCard key={article.slug} article={article} />)}
      </ul>
    </section>
  );
}

function SearchView({ query, hits }: { query: string; hits: HelpArticleCard[] }) {
  return (
    <section aria-labelledby="help-search-title">
      <h2 className="help-section-title" id="help-search-title">搜索结果</h2>
      <p className="help-result-summary">与 <strong>{query}</strong> 相关的帮助文档{hits.length > 0 ? `（${hits.length} 篇）` : ""}</p>
      {hits.length > 0 ? (
        <ul className="help-article-list">
          {hits.map((article) => <ArticleCard key={article.slug} article={article} />)}
        </ul>
      ) : (
        <div className="help-empty">
          <h3>没有找到相关文档</h3>
          <p>换个关键词试试，例如「押金」「提前结束」「人脸」；也可以按分类浏览，或直接联系平台客服。</p>
          <div className="help-empty-actions">
            <Link className="help-contact-cta" href="/help">浏览全部帮助</Link>
            <Link className="help-contact-cta" href="/support"><Headphones size={16} aria-hidden="true" /><span>联系平台客服</span></Link>
          </div>
        </div>
      )}
    </section>
  );
}

export function HelpPage({ view, navData, query, legacyHashMap }: HelpPageProps) {
  const breadcrumbs = view.kind === "category"
    ? [{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: helpCategoryLabel(view.category) }]
    : view.kind === "search"
      ? [{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: "搜索结果" }]
      : [{ label: "首页", href: "/" }, { label: "帮助中心" }];
  return (
    <HelpShell breadcrumbs={breadcrumbs} title="帮助中心" description="查找租号、出租、费用与账号相关的说明。" initialQuery={query}>
      {view.kind === "home" ? <LegacyHashHandler map={legacyHashMap} /> : null}
      <div className="help-layout">
        <HelpNavAside
          data={navData}
          activeCategory={view.kind === "category" ? view.category : undefined}
        />
        <div className="help-main">
          <HelpNavDrawer
            data={navData}
            activeCategory={view.kind === "category" ? view.category : undefined}
          />
          {view.kind === "home" ? <HomeView featured={view.featured} /> : null}
          {view.kind === "category" ? <CategoryView category={view.category} articles={view.articles} /> : null}
          {view.kind === "search" ? <SearchView query={view.query} hits={view.hits} /> : null}
        </div>
      </div>
    </HelpShell>
  );
}
