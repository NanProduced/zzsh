"use client";

import { useRef, useState, type ComponentProps, type ReactNode } from "react";

/** Avatars are first-party reviewed paths, never a legacy or chat attachment URL. */
export function managedProfileImage(value: unknown): string | null {
  return typeof value === "string" && /^\/api\/v1\/profile\/avatars\/(?:(?:user|admin)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/(?:0|[1-9]\d{0,18})|presets\/[a-z0-9][a-z0-9-]{1,31}\/[1-9]\d{0,8}\/content)$/.test(value) ? value : null;
}

/** A failed/revoked version stays failed until its URL changes; no retry or external fallback. */
export function ProfileImage({ src, fallback, ...props }: Omit<ComponentProps<"img">, "src" | "onError"> & { src?: unknown; fallback: ReactNode }) {
  const url = managedProfileImage(src);
  const [failed, setFailed] = useState<string | null>(null);
  const current = useRef(url); current.current = url;
  return url && failed !== url
    ? <img key={url} {...props} src={url} alt={props.alt ?? ""} onError={() => { if (current.current === url) setFailed(url); }} />
    : <>{fallback}</>;
}
