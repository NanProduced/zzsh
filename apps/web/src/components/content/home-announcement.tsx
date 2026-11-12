"use client";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { updateVisibility, type PublicUpdate } from "@zzsh/content/updates";
import { PlateDocument } from "@zzsh/ui/plate-document";
import "@zzsh/ui/plate-document.css";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { parseUpdate, parseUpdatesPage } from "@/lib/platform-updates";
import "./home-announcement.css";

const storageKey = (id: string) => `zzsh:home-announcement:${id}`;

export function HomeAnnouncement() {
  const { isOpen: authOpen } = useAuthOverlay();
  const [item, setItem] = useState<PublicUpdate | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const dismissed = useRef(new Set<string>());

  useEffect(() => {
    if (authOpen) { setItem(null); return; }
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/content/updates?surface=home-popup&limit=1", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const page = parseUpdatesPage(await response.json()), offset = Date.parse(page.asOf) - Date.now(), candidate = page.items[0];
        if (!candidate || candidate.type !== "ANNOUNCEMENT" || !candidate.settings.homePopup || dismissed.current.has(`${candidate.id}:${candidate.versionId}`)) return;
        try { if (window.localStorage.getItem(storageKey(candidate.id)) === candidate.versionId) return; } catch { /* storage may be unavailable */ }
        const detailResponse = await fetch(`/api/content/updates/${encodeURIComponent(candidate.id)}`, { cache: "no-store", signal: controller.signal });
        if (!detailResponse.ok) return;
        const detail = parseUpdate(await detailResponse.json(), true);
        if (!controller.signal.aborted && detail.id === candidate.id && detail.versionId === candidate.versionId && detail.type === "ANNOUNCEMENT" && updateVisibility(detail.settings, Date.now() + offset).visible) {
          setClockOffset(offset); setItem(detail);
        }
      } catch { /* A failed optional notice must not block the home page. */ }
    })();
    return () => controller.abort();
  }, [authOpen]);

  useEffect(() => {
    if (!item?.settings.validUntil) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = Date.parse(item.settings.validUntil!) - (Date.now() + clockOffset);
      if (remaining <= 0) { setItem(null); return; }
      timer = setTimeout(schedule, Math.min(remaining, 2_147_000_000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [item, clockOffset]);

  const dismiss = () => {
    if (!item) return;
    dismissed.current.add(`${item.id}:${item.versionId}`);
    try { window.localStorage.setItem(storageKey(item.id), item.versionId); } catch { /* the notice is still dismissed for this visit */ }
    setItem(null);
  };
  const mediaUrls = Object.fromEntries(Object.entries(item?.mediaUrls ?? {}).filter((entry): entry is [string, string] => entry[1] !== null));
  return <Dialog.Root open={Boolean(item) && !authOpen} onOpenChange={open => { if (!open) dismiss(); }}>
    {item ? <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay home-announcement-overlay" />
      <Dialog.Content className="home-announcement-dialog" aria-describedby={undefined}>
        <header><Dialog.Title>{item.title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭公告"><X size={20} aria-hidden="true" /></Dialog.Close></header>
        <div className="home-announcement-body">{item.document ? <PlateDocument document={item.document} mediaUrls={mediaUrls} /> : <p>{item.body ?? ""}</p>}</div>
        <footer><Dialog.Close className="button primary">我知道了</Dialog.Close></footer>
      </Dialog.Content>
    </Dialog.Portal> : null}
  </Dialog.Root>;
}
