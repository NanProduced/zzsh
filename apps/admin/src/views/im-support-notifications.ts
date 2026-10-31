"use client";

import { useEffect, useRef } from "react";

export type SupportNotificationPermission = "unsupported" | NotificationPermission;
export type SupportNotificationRow = { id: string; title: string; body: string; signature: string; unread: boolean };
const PREF_PREFIX = "zzsh.im-support.notifications";
const TITLE_PREFIX = /^\(\d+\) 新消息 · /;

/**
 * What one bell click does. "default" means the browser has not answered the permission
 * prompt yet: that click is the first authorization, so success must switch reminders on
 * instead of toggling the default-on preference off.
 */
export type SupportNotificationTogglePlan =
  | { kind: "notice"; notice: string }
  | { kind: "request" }
  | { kind: "apply"; enabled: boolean };

export function planSupportNotificationToggle(permission: SupportNotificationPermission, enabled: boolean): SupportNotificationTogglePlan {
  if (permission === "unsupported") return { kind: "notice", notice: "当前浏览器不支持桌面通知；页面内未读仍会显示。" };
  if (permission === "denied") return { kind: "notice", notice: "浏览器已屏蔽通知；请在地址栏的站点设置中允许通知后刷新页面。" };
  if (permission === "default") return { kind: "request" };
  return { kind: "apply", enabled: !enabled };
}

/** The signature snapshot that marks the current queue as already seen. */
export function seedSupportNotificationSeen(rows: SupportNotificationRow[]): Map<string, string> {
  const next = new Map<string, string>();
  for (const row of rows) if (row.signature) next.set(row.id, row.signature);
  return next;
}

/** Rows whose signature changed after the last seed; read rows and the open row never notify. */
export function changedSupportNotificationRows(previous: Map<string, string>, rows: SupportNotificationRow[], selectedId: string | null): SupportNotificationRow[] {
  return rows.filter((row) => row.unread && row.id !== selectedId && row.signature && previous.get(row.id) !== row.signature);
}

export function supportNotificationPermission(): SupportNotificationPermission {
  return typeof window === "undefined" || typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function readSupportNotificationPreference(adminUserId: string): boolean {
  if (!adminUserId || typeof window === "undefined") return true;
  try {
    const value = window.localStorage.getItem(`${PREF_PREFIX}.${adminUserId}`);
    return value !== "off";
  } catch { return true; }
}

export function storeSupportNotificationPreference(adminUserId: string, enabled: boolean): void {
  if (!adminUserId || typeof window === "undefined") return;
  try { window.localStorage.setItem(`${PREF_PREFIX}.${adminUserId}`, enabled ? "on" : "off"); } catch { /* local preference */ }
}

export async function requestSupportNotificationPermission(): Promise<SupportNotificationPermission> {
  if (supportNotificationPermission() === "unsupported") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return "denied"; }
}

let audioContext: AudioContext | null = null;
/** Must run from a user gesture once; later chimes reuse the unlocked context. */
export function unlockSupportAudio(): void {
  if (typeof window === "undefined") return;
  try {
    const Ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    void audioContext.resume().catch(() => undefined);
  } catch { /* audio is optional */ }
}

export function playSupportChime(): void {
  const context = audioContext;
  if (!context || context.state !== "running") return;
  try {
    const start = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.055, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
    gain.connect(context.destination);
    for (const [offset, frequency] of [[0, 880], [0.16, 1174.66]] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.24);
    }
  } catch { /* audio is optional */ }
}

/** Desktop notification + title count. Keep the workbench tab open: web cannot notify after it closes. */
export function useSupportUnreadNotifications(input: {
  adminUserId: string;
  enabled: boolean;
  /** True only after the first successful queue read; an empty queue is still a loaded queue. */
  loaded: boolean;
  rows: SupportNotificationRow[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): { unreadCount: number } {
  const seen = useRef<Map<string, string> | null>(null);
  const seenOwner = useRef(input.adminUserId);
  const openRef = useRef(input.onOpen);
  openRef.current = input.onOpen;
  const unreadCount = input.rows.filter((row) => row.unread).length;

  useEffect(() => {
    // Another operator signs in: their rows were never seeded here, so forget the old map.
    if (seenOwner.current !== input.adminUserId) {
      seenOwner.current = input.adminUserId;
      seen.current = null;
    }
    // Before the first successful queue read there is no baseline to compare against.
    // Seeding the empty first frame made the real queue look like a burst of new rows.
    if (!input.loaded) { seen.current = null; return; }
    const previous = seen.current;
    seen.current = seedSupportNotificationSeen(input.rows);
    if (!input.enabled || supportNotificationPermission() !== "granted") return;
    // The first loaded queue only seeds the map; it must not notify for rows that were
    // already unread when the workbench (or a new operator's view) opened.
    if (previous === null) return;
    const changed = changedSupportNotificationRows(previous, input.rows, input.selectedId);
    if (!changed.length) return;
    playSupportChime();
    const hidden = typeof document !== "undefined" && (document.hidden || !document.hasFocus());
    if (!hidden) return;
    for (const row of changed.slice(0, 3)) {
      try {
        const notification = new Notification(`新消息 · ${row.title}`, { body: row.body, tag: `zzsh-im-${row.id}`, silent: true });
        notification.onclick = () => {
          try { window.focus(); notification.close(); } catch { /* window may be gone */ }
          openRef.current(row.id);
        };
      } catch { /* permission can change between checks */ }
    }
  }, [input.adminUserId, input.enabled, input.loaded, input.rows, input.selectedId]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = document.title.replace(TITLE_PREFIX, "");
    document.title = unreadCount > 0 ? `(${unreadCount}) 新消息 · ${base}` : base;
    return () => { document.title = base; };
  }, [unreadCount]);

  return { unreadCount };
}
