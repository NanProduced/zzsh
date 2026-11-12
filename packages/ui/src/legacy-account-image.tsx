"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { AccountMediaPlaceholder } from "./account-media-placeholder";

const id = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", index = "(?:0|[1-9][0-9]{0,5})";
const route = new RegExp(`^/api/(?:(?:v1/)?supply/listings/${id}/legacy-images/${index}|supply/accounts/${id}/legacy-images/(?:display|penalty)/${index}|bff/admin/supply/accounts/${id}/legacy-images/(?:display|penalty)/${index})$`);

/** Older responses need an authorized HEAD when the image load fails. */
export function LegacyAccountImage({ src, alt, className, knownState, ...imageProps }: { src: string | null; alt: string; knownState?: "PENDING_IMPORT" | "UNAVAILABLE" } & Pick<ComponentProps<"img">, "className" | "loading" | "width" | "height" | "fetchPriority" | "decoding">) {
  const [failure, setFailure] = useState<{ src: string; state: "PENDING_IMPORT" | "UNAVAILABLE" } | null>(null);
  const current = useRef(src), controller = useRef<AbortController | null>(null);
  current.current = src;
  useEffect(() => { controller.current?.abort(); setFailure(null); return () => controller.current?.abort(); }, [src]);
  if (knownState) return <AccountMediaPlaceholder state={knownState} className={className} />;
  if (!src || !route.test(src)) return <AccountMediaPlaceholder state="UNAVAILABLE" className={className} />;
  if (failure?.src === src) return <AccountMediaPlaceholder state={failure.state} className={className} />;
  return <img src={src} alt={alt} className={className} loading={imageProps.loading ?? "lazy"} {...imageProps} onError={() => {
    if (current.current !== src) return;
    setFailure({ src, state: "UNAVAILABLE" });
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    void fetch(src, { method: "HEAD", credentials: "same-origin", cache: "no-store", signal: request.signal }).then(response => {
      if (!request.signal.aborted && current.current === src && response.status === 404 && response.headers.get("x-zzsh-legacy-missing") === "1") setFailure({ src, state: "PENDING_IMPORT" });
    }).catch(() => {});
  }} />;
}
