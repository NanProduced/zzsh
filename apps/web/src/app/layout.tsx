import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { UserSessionProvider } from "@/components/session/user-session-provider";
import { AuthOverlayProvider } from "@/components/auth/auth-overlay-provider";
import { SupportRail } from "@/components/support/support-rail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PublicContentProvider } from "@/components/content/public-content-provider";
import { SEO_HOME_DESCRIPTION, SEO_HOME_TITLE, SEO_LOGO_PATH, SEO_SITE_NAME, seoMetadataBase } from "@/lib/seo";
import "./globals.css";
import "@zzsh/ui/content-document.css";

export const metadata: Metadata = {
  metadataBase: seoMetadataBase(),
  title: { default: SEO_HOME_TITLE, template: `%s - ${SEO_SITE_NAME}` },
  description: SEO_HOME_DESCRIPTION,
  applicationName: SEO_SITE_NAME,
  openGraph: {
    siteName: SEO_SITE_NAME,
    locale: "zh_CN",
    type: "website",
    title: SEO_HOME_TITLE,
    description: SEO_HOME_DESCRIPTION,
    images: [{ url: SEO_LOGO_PATH, width: 1254, height: 1254, alt: SEO_SITE_NAME }],
  },
  icons: {
    icon: [{ url: "/favicon.ico", type: "image/x-icon", sizes: "48x48 96x96" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#090b0e" },
    { media: "(prefers-color-scheme: light)", color: "#f5f7fa" },
  ],
};

const antiFlickerScript = `
(function() {
  try {
    var stored = localStorage.getItem('zzsh-user-theme');
    var isDark = true;
    if (stored === 'light') {
      isDark = false;
    } else {
      isDark = true; // 默认深色
    }
    if (isDark) {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (e) {
    document.documentElement.classList.add('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className="dark" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: antiFlickerScript }} />
      </head>
      <body className="min-h-screen bg-[var(--color-bg-canvas)] text-[var(--color-text-primary)] antialiased selection:bg-[var(--color-accent-brand)] selection:text-black">
        <TooltipProvider delayDuration={180} skipDelayDuration={100}>
        <ThemeProvider>
          <PublicContentProvider><UserSessionProvider><AuthOverlayProvider>{children}<SupportRail /></AuthOverlayProvider></UserSessionProvider></PublicContentProvider>
        </ThemeProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
