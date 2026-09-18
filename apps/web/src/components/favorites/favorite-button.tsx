"use client";
import { Heart } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFavorites } from "./favorites-context";

export function FavoriteButton({ accountId, title, variant = "card" }: { accountId: string; title: string; variant?: "card" | "inline" }) {
  const favorites = useFavorites();
  const status = favorites?.statusOf(accountId) ?? "unknown";
  const identity = favorites?.snapshot.status ?? "loading";
  const pressed = status === "saved";
  const busy = status === "pending";
  const needsConfirmation = identity === "authenticated" && status === "unknown";
  const className = variant === "card" ? "icon-button favorite" : "button secondary favorite-inline";
  const label = pressed ? `取消收藏${title}` : needsConfirmation ? `刷新收藏状态${title}` : `收藏${title}`;
  const button = <button
    type="button"
    className={className}
    data-favorite-state={status}
    aria-pressed={pressed}
    aria-busy={busy || undefined}
    aria-label={label}
    disabled={!favorites || identity === "loading" || identity === "error" || busy}
    onClick={() => {
      if (needsConfirmation) {
        favorites?.refresh();
        return;
      }
      void favorites?.toggle(accountId, !pressed).catch(() => undefined);
    }}>
    <Heart size={17} fill={pressed ? "currentColor" : "none"} aria-hidden="true" />
    {variant === "inline" && <span>{busy ? "处理中…" : pressed ? "已收藏" : needsConfirmation ? "确认收藏状态" : "收藏"}</span>}
  </button>;
  return needsConfirmation ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top">收藏状态待确认，点击刷新</TooltipContent>
    </Tooltip>
  ) : button;
}

export function FavoriteNotice() {
  const favorites = useFavorites();
  if (!favorites?.notice) return null;
  return <p className="favorite-notice" role="alert">
    <span>{favorites.notice.text}</span>
    {favorites.notice.retryAccountId && <button type="button" className="favorite-notice-retry" onClick={() => favorites.retry()}>重试</button>}
    <button type="button" className="favorite-notice-dismiss" aria-label="关闭提示" onClick={() => favorites.dismissNotice()}>关闭</button>
  </p>;
}
