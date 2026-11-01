import { useEffect, useState } from "react";
import type { UserDirectoryDetail } from "../../api";
import { PreviewCardShell } from "./preview-card";
import { UserPreviewCard } from "./user-preview";

type Requester = <T>(path: string) => Promise<T>;
const ACCOUNT_STATUS_TEXT: Record<string, string> = { ACTIVE: "账号正常", RESTRICTED: "账号受限", FROZEN: "已冻结", CANCELLED: "已注销", UNKNOWN: "状态未知" };
const REAL_NAME_TEXT: Record<string, string> = { VERIFIED: "已实名", UNVERIFIED: "未实名", REJECTED: "实名未通过", UNKNOWN: "实名未知" };

/** Mounted by the existing preview trigger, so profile reads stay on demand. */
export function UserProfilePreview({ userId, name, request, onOpenProfile }: {
  userId: string; name: string; request: Requester; onOpenProfile?: (userId: string) => void;
}) {
  const [profile, setProfile] = useState<UserDirectoryDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const canRead = Boolean(onOpenProfile);
  useEffect(() => {
    let active = true;
    setProfile(null);
    if (!canRead) { setState("denied"); return; }
    setState("loading");
    void request<{ user: UserDirectoryDetail }>(`/users/${encodeURIComponent(userId)}`)
      .then(value => { if (active) { setProfile(value.user ?? null); setState("ready"); } })
      .catch(error => {
        if (active) setState([401, 403, 423].includes((error as { status?: number } | null)?.status ?? 0) ? "denied" : "error");
      });
    return () => { active = false; };
  }, [userId, request, canRead]);
  if (!canRead || !profile) return <PreviewCardShell ariaLabel={`用户预览：${name}`} header={<strong>{name}</strong>}>
    <p className="text-xs text-muted-foreground">{!canRead || state === "denied" ? "当前账号无权读取该用户资料。" : state === "loading" ? "正在读取用户资料…" : "用户资料暂时无法读取。"}</p>
  </PreviewCardShell>;
  return <UserPreviewCard
    name={name}
    currentName={profile.name && profile.name.trim() !== name ? profile.name : undefined}
    userId={userId}
    businessNo={profile.displayUsername}
    image={profile.image}
    maskedPhone={profile.maskedPhone}
    accountStatus={ACCOUNT_STATUS_TEXT[profile.accountStatus] ?? "状态未知"}
    realNameStatus={REAL_NAME_TEXT[profile.identity?.status ?? profile.identityStatus] ?? "实名未知"}
    membershipSummary={profile.membershipSummary}
    creditSummary={profile.creditSummary}
    riskFlag={profile.riskFlag}
    canOpen={Boolean(onOpenProfile)}
    onOpen={() => onOpenProfile?.(userId)}
    deniedReason="当前账号无权查看用户资料"
  />;
}
