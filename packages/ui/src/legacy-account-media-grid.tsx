import { LegacyAccountImage } from "./legacy-account-image";
import { AccountMediaPlaceholder } from "./account-media-placeholder";

/** Counts come from an already authorized account detail response. */
export function LegacyAccountMediaGrid({ accountId, displayCount, penaltyCount }: { accountId: string; displayCount: number; penaltyCount: number }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(accountId) || ![displayCount, penaltyCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100)) return <p>图片信息暂不可用</p>;
  if (!displayCount && !penaltyCount) return <AccountMediaPlaceholder state="UNAVAILABLE" />;
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
    {([ ["display", displayCount, "账号展示图"], ["penalty", penaltyCount, "处罚截图"] ] as const).flatMap(([kind, count, label]) => Array.from({ length: count }, (_, index) =>
      <figure key={`${kind}-${index}`}><LegacyAccountImage src={`/api/bff/admin/supply/accounts/${accountId}/legacy-images/${kind}/${index}`} alt={`${label}，第${index + 1}张`} className="aspect-[4/3] w-full rounded-lg border border-border object-contain" /><figcaption className="mt-1 text-xs text-muted-foreground">{label}</figcaption></figure>))}
  </div>;
}
