"use client";

import { useEffect } from "react";
import { StatusContent } from "@/components/status/status-content";
import { applyTheme, resolveSavedTheme, THEME_STORAGE_KEY } from "@/lib/theme";
import styles from "@/components/status/status-page.module.css";

// Root recovery must not depend on the failed shell or its session providers.
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    try { applyTheme(resolveSavedTheme(localStorage.getItem(THEME_STORAGE_KEY))); }
    catch { applyTheme("dark"); }
  }, []);
  return <html lang="zh-CN" data-theme="dark" className="dark" suppressHydrationWarning>
    <body className={styles.standalone}>
      <header className={styles.standaloneHeader}><a className={styles.brand} href="/">洲洲商行</a></header>
      <main id="main-content" className={styles.standaloneMain}><StatusContent kind="unavailable" onRetry={retry} /></main>
    </body>
  </html>;
}
