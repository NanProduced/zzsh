import type { Metadata } from "next";
import { LiveHome } from "@/components/home/live-home";
import { SEO_HOME_DESCRIPTION, SEO_HOME_TITLE, SEO_LOGO_PATH, SEO_SITE_NAME, seoCanonical, seoOrigin } from "@/lib/seo";

export const metadata: Metadata = {
  title: { absolute: SEO_HOME_TITLE },
  description: SEO_HOME_DESCRIPTION,
  alternates: { canonical: seoCanonical("/") },
};

export default function HomePage() {
  const origin = seoOrigin();
  return <>
    {origin ? (
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebSite", name: SEO_SITE_NAME, url: origin },
              { "@type": "Organization", name: SEO_SITE_NAME, url: origin, logo: `${origin}${SEO_LOGO_PATH}` },
            ],
          }),
        }}
      />
    ) : null}
    <LiveHome />
  </>;
}