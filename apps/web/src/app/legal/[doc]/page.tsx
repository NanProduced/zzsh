import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandLogo } from "@/components/brand/brand-logo";
import { getLegalDocument, getLegalDocumentSibling, isLegalDocId, listLegalDocuments } from "@/content/legal/documents";
import { readLegalDocument } from "@/lib/legal-server";

export const dynamic = "force-dynamic";

export function generateStaticParams(): { doc: string }[] {
  return listLegalDocuments().map((record) => ({ doc: record.doc }));
}

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  const entry = getLegalDocument(doc);
  if (!entry) notFound();
  return { title: `《${entry.title}》 · 洲洲商行` };
}

function PublishedBody({ body }: { body: string }) {
  return (
    <div className="legal-doc-published">
      {body.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index} style={{ whiteSpace: "pre-wrap" }}>{paragraph}</p>
      ))}
    </div>
  );
}

/**
 * Public reading carrier for the two consent links. The formal text and its
 * effective version come from the API; when no sealed version is effective the
 * page states that plainly instead of standing in for a legal document.
 */
export default async function LegalDocPage({ params, searchParams }: { params: Promise<{ doc: string }>; searchParams?: Promise<{ version?: string }> }) {
  const { doc } = await params;
  if (!isLegalDocId(doc)) notFound();
  const entry = getLegalDocument(doc);
  if (!entry) notFound();
  const version = (await searchParams)?.version;
  if (version !== undefined && (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(version))) notFound();
  const reading = await readLegalDocument(doc, version);
  const sibling = getLegalDocumentSibling(doc);
  const published = reading.state === "PUBLISHED" ? reading.document : null;
  return <div className="auth-page">
    <header className="auth-page-header">
      <Link href="/" className="auth-page-brand" aria-label="洲洲商行首页"><BrandLogo height={36} /></Link>
      <Link href="/" className="auth-page-back">返回门户首页</Link>
    </header>
    <main className="auth-page-main">
      <section className="auth-page-card" aria-labelledby="legal-doc-title">
        <h1 id="legal-doc-title" className="auth-page-title">《{published?.title ?? entry.title}》</h1>
        {published ? <>
          <p className="legal-doc-meta">版本 {published.id} · 于 {published.effectiveAt} 生效</p>
          <PublishedBody body={published.body} />
        </> : (
          <div className="auth-unavailable" role="status">
            <p>{reading.state === "PENDING" ? entry.note : "协议正文暂时无法读取，请稍后重试。当前页面不是正式协议文本。"}</p>
            <p>正式文本与版本信息由平台发布后在本页展示；未发布时不提供占位正文，也不以帮助文章代替协议。当前页面不是正式协议文本。</p>
          </div>
        )}
        <p className="auth-page-links">另一份文件：<Link href={`/legal/${sibling.doc}`}>《{sibling.title}》</Link></p>
      </section>
    </main>
    <footer className="auth-page-footer">洲洲商行 · 公开浏览无需登录</footer>
  </div>;
}
