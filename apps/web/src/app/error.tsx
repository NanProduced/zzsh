"use client";

import { StatusPage } from "@/components/status/status-page";

export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <StatusPage kind="unavailable" onRetry={retry} />;
}
