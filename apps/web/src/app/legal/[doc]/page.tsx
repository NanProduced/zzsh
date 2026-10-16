import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandLogo } from "@/components/brand/brand-logo";
import { getLegalDocument, getLegalDocumentSibling, listLegalDocuments, type LegalDocumentRecord } from "@/content/legal/documents";

export function generateStaticParams(): { doc: string }[] {
  return listLegalDocuments().map((record) => ({ doc: record.doc }));
}

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  const entry = getLegalDocument(doc);
  if (!entry) notFound();
  return { title: `《${entry.title}》 · 洲洲商行` };
}

function PublishedBody({ entry }: { entry: LegalDocumentRecord }) {
  return (
    <div className="legal-doc-published">
      <p className="legal-doc-meta">版本 {entry.version} · 于 {entry.effectiveAt} 生效</p>
      {(entry.body ?? []).map((block, index) => {
        switch (block.type) {
          case "paragraph":
            return <p key={index}>{block.text}</p>;
          case "list":
            return block.ordered
              ? <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>
              : <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
          case "heading":
            return <h2 key={index}>{block.text}</h2>;
        }
      })}
    </div>
  );
}

/**
 * Public reading carrier for the two consent links, driven by the versioned legal-document registry.
 * PUBLISHED records render title, version, effective date and structured body; PENDING records keep
 * the honest status-page semantics: the page states plainly that the formal text has not been
 * delivered, instead of standing in for a legal document, and always offers a way back. It is a
 * status page for content, not a second copy of the help centre.
 */
export default async function LegalDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const entry = getLegalDocument(doc);
  if (!entry) notFound();
  const sibling = getLegalDocumentSibling(entry.doc);
  return <div className="auth-page">
    <header className="auth-page-header">
      <Link href="/" className="auth-page-brand" aria-label="洲洲商行首页"><BrandLogo height={36} /></Link>
      <Link href="/" className="auth-page-back">返回门户首页</Link>
    </header>
    <main className="auth-page-main">
      <section className="auth-page-card" aria-labelledby="legal-doc-title">
        <h1 id="legal-doc-title" className="auth-page-title">《{entry.title}》</h1>
        {entry.status === "PUBLISHED" ? (
          <PublishedBody entry={entry} />
        ) : (
          <div className="auth-unavailable" role="status">
            <p>{entry.note}</p>
            <p>协议正文与版本信息仍在接入，接入后会在本页展示标题、正文及实际有据的版本信息；当前页面只说明内容状态，不是正式协议文本。</p>
          </div>
        )}
        <p className="auth-page-links">另一份文件：<Link href={`/legal/${sibling.doc}`}>《{sibling.title}》</Link></p>
      </section>
    </main>
    <footer className="auth-page-footer">洲洲商行 · 公开浏览无需登录</footer>
  </div>;
}
