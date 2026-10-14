import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandLogo } from "@/components/brand/brand-logo";

const DOCS = {
  terms: { title: "平台服务协议", sibling: "privacy" as const, siblingTitle: "用户隐私政策" },
  privacy: { title: "用户隐私政策", sibling: "terms" as const, siblingTitle: "平台服务协议" },
} as const;

function documentEntry(doc: string) {
  if (doc !== "terms" && doc !== "privacy") notFound();
  return DOCS[doc];
}

export function generateStaticParams(): { doc: string }[] {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  const entry = documentEntry(doc);
  return entry ? { title: `《${entry.title}》 · 洲洲商行` } : {};
}

/**
 * Public reading carrier for the two consent links. The formal text has not been delivered yet, so
 * the page states that plainly instead of standing in for a legal document, and always offers a way
 * back. It is a status page for content, not a second copy of the help centre.
 */
export default async function LegalDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const entry = documentEntry(doc);
  return <div className="auth-page">
    <header className="auth-page-header">
      <Link href="/" className="auth-page-brand" aria-label="洲洲商行首页"><BrandLogo height={36} /></Link>
      <Link href="/" className="auth-page-back">返回门户首页</Link>
    </header>
    <main className="auth-page-main">
      <section className="auth-page-card" aria-labelledby="legal-doc-title">
        <h1 id="legal-doc-title" className="auth-page-title">《{entry.title}》</h1>
        <div className="auth-unavailable" role="status">
          <p>正式内容尚未提供，暂无法阅读正式协议。</p>
          <p>协议正文与版本信息仍在接入，接入后会在本页展示标题、正文及实际有据的版本信息；当前页面只说明内容状态，不是正式协议文本。</p>
        </div>
        <p className="auth-page-links">另一份文件：<Link href={`/legal/${entry.sibling}`}>《{entry.siblingTitle}》</Link></p>
      </section>
    </main>
    <footer className="auth-page-footer">洲洲商行 · 公开浏览无需登录</footer>
  </div>;
}
