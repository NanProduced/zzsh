import { notFound } from 'next/navigation';
import { Clock3 } from 'lucide-react';
import { ServiceShell } from '@/components/layout/service-shell';
import { PlateDocument } from '@zzsh/ui/plate-document';
import '@zzsh/ui/plate-document.css';
import { loadPlatformUpdate } from '@/lib/updates-server';
import { updateDate, updateReturnHref, updateTypeLabel } from '@/lib/platform-updates';
import { UpdateBackLink } from '@/components/content/updates-list';
import '../updates.css';

function plateMediaUrls(urls: Readonly<Record<string, string | null>>): Record<string, string> {
  return Object.fromEntries(Object.entries(urls).filter((entry): entry is [string, string] => entry[1] !== null));
}

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const item = await loadPlatformUpdate((await params).id).catch(() => null);
  return { title: `${item?.title ?? '平台动态'} · 洲洲商行` };
}

export default async function PlatformUpdatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const item = await loadPlatformUpdate((await params).id);
  if (!item) notFound();
  const back = updateReturnHref((await searchParams).from),
    settings = item.settings;

  return (
    <div className="platform-updates-center">
      <ServiceShell
        title={item.title}
        showBack={false}
        showPageHeading={false}
        headingInContent
        contextLabel={null}
        breadcrumbs={[
          { label: '首页', href: '/' },
          { label: '平台动态', href: back },
          { label: '正文' },
        ]}
      >
        <article className="update-article">
          <UpdateBackLink href={back} />
          <header className="update-article-heading">
            <div className="update-article-meta">
              <span className={`update-kind update-kind--${item.type.toLowerCase()}`}>
                {updateTypeLabel(item.type)}
              </span>
              <time dateTime={item.publishedAt}>发布于 {updateDate(item.publishedAt)}</time>
              {item.expired ? (
                <span className="update-ended">已过展示有效期 · 历史内容</span>
              ) : null}
            </div>
            <h1>{item.title}</h1>
            {item.summary ? (
              <p className="update-article-summary">{item.summary}</p>
            ) : null}
          </header>

          {item.expired ? (
            <div className="update-expired-callout" role="status">
              <span className="update-expired-icon" aria-hidden="true"><Clock3 size={18} /></span>
              <div className="update-expired-copy">
                <strong>历史动态提示</strong>
                <p>此动态已过展示有效期，正文保留供历史查阅。实际服务状态和适用规则请以相关业务页面为准。</p>
              </div>
            </div>
          ) : null}

          {settings.effectiveAt || settings.impact ? (
            <dl className="update-impact">
              {settings.effectiveAt ? (
                <div>
                  <dt>生效时间</dt>
                  <dd>
                    <time dateTime={settings.effectiveAt}>
                      {new Intl.DateTimeFormat('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(settings.effectiveAt))}
                    </time>
                  </dd>
                </div>
              ) : null}
              {settings.impact ? (
                <div>
                  <dt>影响范围</dt>
                  <dd>{settings.impact}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          <div className="update-article-body">
            {item.document
              ? <PlateDocument document={item.document} mediaUrls={plateMediaUrls(item.mediaUrls)} />
              : <p>{item.body ?? ''}</p>}
          </div>

          <div className="update-article-footer">
            <UpdateBackLink href={back} />
          </div>
        </article>
      </ServiceShell>
    </div>
  );
}
