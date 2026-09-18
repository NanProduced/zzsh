import { CircleHelp } from "lucide-react";
import type { PublicCodeLabel } from "@/lib/supply-types";

type LoginMethodKind = "qq" | "wechat" | "steam" | "steam-global";

function loginMethodKind(method: PublicCodeLabel | null): LoginMethodKind | null {
  switch (method?.code) {
    case "legacy_login_qq":
      return "qq";
    case "legacy_login_wechat":
      return "wechat";
    case "legacy_login_steam_cn":
      return "steam";
    case "legacy_login_steam_global":
      return "steam-global";
    default:
      return null;
  }
}

export function LoginMethodIcon({ method, size = 19 }: { method: PublicCodeLabel | null; size?: number }) {
  const kind = loginMethodKind(method);
  if (kind === null) return <CircleHelp className="login-method-icon login-method-icon--unknown" size={size} aria-hidden="true" />;

  return <span className={`login-method-icon login-method-icon--${kind}`} aria-hidden="true">
    <svg viewBox="0 0 24 24" width={size} height={size} focusable="false">
      {kind === "qq" ? <>
        <path fill="currentColor" d="M12 3.25c-3.1 0-5.28 2.53-5.28 5.66 0 1.3-.52 2.38-1.13 3.37-.42.69-.87 1.48-.87 2.12 0 .58.46.94 1.14.94.52 0 1.08-.2 1.57-.49a5.4 5.4 0 0 0 1.27 1.46c-.7.28-1.28.68-1.28 1.3 0 .92 1.34 1.7 4.58 1.7s4.58-.78 4.58-1.7c0-.62-.58-1.02-1.28-1.3a5.4 5.4 0 0 0 1.27-1.46c.49.29 1.05.49 1.57.49.68 0 1.14-.36 1.14-.94 0-.64-.45-1.43-.87-2.12-.61-.99-1.13-2.07-1.13-3.37 0-3.13-2.18-5.66-5.28-5.66Z" />
        <path fill="currentColor" d="M8.7 6.8c.42-.55 1.13-.92 1.93-.92s1.51.37 1.93.92a.65.65 0 1 1-1.05.78c-.18-.24-.5-.4-.88-.4s-.7.16-.88.4a.65.65 0 1 1-1.05-.78Zm6.6 0c.42-.55 1.13-.92 1.93-.92s1.51.37 1.93.92a.65.65 0 1 1-1.05.78c-.18-.24-.5-.4-.88-.4s-.7.16-.88.4a.65.65 0 1 1-1.05-.78Z" opacity=".72" transform="translate(-4 0)" />
      </> : kind === "wechat" ? <>
        <path fill="currentColor" d="M11.15 5.15c-3.83 0-6.93 2.44-6.93 5.45 0 1.7.97 3.22 2.49 4.22l-.68 2.4 2.63-1.4c.77.2 1.61.3 2.49.3 3.83 0 6.93-2.44 6.93-5.45s-3.1-5.52-6.93-5.52Z" />
        <path fill="currentColor" d="M14.2 8.4c3.04 0 5.5 1.83 5.5 4.1 0 1.23-.74 2.34-1.9 3.1l.45 1.61-1.79-.95a7.8 7.8 0 0 1-2.26.34c-.78 0-1.52-.13-2.2-.35 1.33-.94 2.2-2.37 2.2-4 0-1.48-.74-2.82-1.95-3.78.61-.05 1.27-.07 1.95-.07Z" opacity=".72" />
        <circle cx="8.75" cy="10.7" r=".8" fill="var(--color-bg-card, #fff)" />
        <circle cx="13.45" cy="10.7" r=".8" fill="var(--color-bg-card, #fff)" />
        <circle cx="16.6" cy="12.45" r=".62" fill="var(--color-bg-card, #fff)" />
        <circle cx="19.1" cy="12.45" r=".62" fill="var(--color-bg-card, #fff)" />
      </> : <>
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="9.5" cy="12" r="2.05" fill="currentColor" />
        <path fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" d="m10.9 12 3.6-3.7m-3.6 3.7 3.6 3.7" />
        <circle cx="15.4" cy="8.3" r="1.55" fill="currentColor" />
        <circle cx="15.4" cy="15.7" r="1.55" fill="currentColor" />
      </>}
    </svg>
  </span>;
}
