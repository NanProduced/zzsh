"use client";

import { ServiceShell } from "@/components/layout/service-shell";
import { StatusContent, type StatusKind } from "./status-content";
import "@/components/layout/functional-shell.css";
import styles from "./status-page.module.css";

export function StatusPage({ kind, onRetry }: { kind: StatusKind; onRetry?: () => void }) {
  return <div className={styles.page}>
    <ServiceShell title="访问提示" showPageHeading={false} headingInContent breadcrumbs={[]} contextLabel={null} showBack={false}>
      <StatusContent kind={kind} onRetry={onRetry} />
    </ServiceShell>
  </div>;
}
