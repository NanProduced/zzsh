"use client";

import { SkeletonBlock } from "../ui/information";
import "./session-loading.css";

export function SessionLoading({ label, layout = "workspace" }: {
  label: string;
  layout?: "form" | "workspace" | "compact";
}) {
  return <section className="session-loading" data-layout={layout} aria-busy="true" aria-label={label}>
    <p className="session-loading-label" role="status">{label}</p>
    <div className="session-loading-layout" aria-hidden="true">
      <div className="session-loading-main">
        <SkeletonBlock label="" lines={2} variant="text" />
        <div className="session-loading-fields">
          {Array.from({ length: layout === "compact" ? 4 : 6 }, (_, index) => <SkeletonBlock key={index} label="" lines={2} variant="text" />)}
        </div>
      </div>
      {layout !== "compact" ? <div className="session-loading-side">
        <SkeletonBlock label="" lines={2} variant="text" />
        <SkeletonBlock label="" lines={4} />
        <SkeletonBlock label="" lines={1} variant="amount" />
      </div> : null}
    </div>
  </section>;
}
