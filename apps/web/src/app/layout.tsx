import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { UserSessionProvider } from "@/components/session/user-session-provider";
import { AuthOverlayProvider } from "@/components/auth/auth-overlay-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "洲洲商行 · 游戏服务与高价值账号租赁门户",
  description: "洲洲商行游戏服务门户。浏览三角洲行动资源账号，了解资源费用、押金、租期与真人客服履约流程。",
  icons: {
    icon: "/brand/zzsh-logo-variant-01.png",
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
        <ThemeProvider>
          <UserSessionProvider><AuthOverlayProvider>{children}</AuthOverlayProvider></UserSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
