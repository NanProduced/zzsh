import { canonicalize } from "./content-hash";
import { convertLegacyDisplayFields } from "./legacy-display-snapshot";
import { invalid, sha256Hex } from "./supply-util";

const hex = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9._:-]{1,128}$/;
const ratioPattern = /^(0|[1-9]\d{0,9})(?:\.\d{1,8})?$/;
const ratioIssues = ["base_bot:MISSING", "base_bot:NON_POSITIVE", "base_bot:INVALID"] as const;

/** Observation at legacy capture time, never a price frozen by an earlier order. */
export type LegacyAccountCaptureFact = {
  schema: "legacy-account-capture-fact-v1";
  accountId: string; legacyId: string; observationVersionId: string;
  baseSourceDigest: string; displayDigest: string; captureSha256: string; sourceUpdatedAt: string;
  sourceAccountBaseRatioWanPerYuan: string | null; ratioIssue: string | null;
  sourceAccountFullPayoutSelected: boolean | null; payoutIssue: string | null;
};

export function parseLegacyAccountCaptureFact(value: unknown): LegacyAccountCaptureFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid captured account fact");
  const x = value as Record<string, unknown>;
  if (Object.keys(x).sort().join(",") !== ["accountId","baseSourceDigest","captureSha256","displayDigest","legacyId","observationVersionId","payoutIssue","ratioIssue","schema","sourceAccountBaseRatioWanPerYuan","sourceAccountFullPayoutSelected","sourceUpdatedAt"].sort().join(",")
    || x.schema !== "legacy-account-capture-fact-v1"
    || [x.accountId,x.legacyId,x.observationVersionId].some(v => typeof v !== "string" || !id.test(v))
    || [x.baseSourceDigest,x.displayDigest,x.captureSha256].some(v => typeof v !== "string" || !hex.test(v))
    || typeof x.sourceUpdatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x.sourceUpdatedAt)
    || !Number.isFinite(Date.parse(x.sourceUpdatedAt))) throw invalid("Invalid captured account binding");
  const ratio = x.sourceAccountBaseRatioWanPerYuan, payout = x.sourceAccountFullPayoutSelected;
  if (ratio === null ? typeof x.ratioIssue !== "string" || !(ratioIssues as readonly string[]).includes(x.ratioIssue)
    : typeof ratio !== "string" || !ratioPattern.test(ratio) || BigInt(ratio.replace(".", "")) === 0n || x.ratioIssue !== null)
    throw invalid("Invalid captured account ratio");
  if (payout === null ? x.payoutIssue !== "is_full_payout:UNKNOWN" : typeof payout !== "boolean" || x.payoutIssue !== null)
    throw invalid("Invalid captured account payout selection");
  return x as LegacyAccountCaptureFact;
}

export function legacyAccountCaptureFactDigest(value: LegacyAccountCaptureFact): string {
  return sha256Hex(canonicalize(parseLegacyAccountCaptureFact(value)));
}

/** Build from the full captured source row, whose digest is bound to the imported original. */
export function legacyAccountCaptureFactFromSource(
  binding: Omit<LegacyAccountCaptureFact, "schema" | "sourceAccountBaseRatioWanPerYuan" | "ratioIssue" | "sourceAccountFullPayoutSelected" | "payoutIssue">,
  source: Record<string, unknown>,
): LegacyAccountCaptureFact {
  if (!source || typeof source !== "object" || Array.isArray(source) || source.id !== binding.legacyId
    || sha256Hex(canonicalize(source)) !== binding.baseSourceDigest) throw invalid("Captured source row differs from original");
  const display = convertLegacyDisplayFields(source, { includeAccountBaseRatio: true, includeAccountFullPayout: true });
  const ratio = display.sourceAccountBaseRatioWanPerYuan ?? null, payout = display.sourceAccountFullPayoutSelected ?? null;
  const ratioIssue = display.issues.find(issue => issue.startsWith("base_bot:")) ?? null;
  const payoutIssue = display.issues.find(issue => issue.startsWith("is_full_payout:")) ?? null;
  return parseLegacyAccountCaptureFact({ schema:"legacy-account-capture-fact-v1", ...binding,
    sourceAccountBaseRatioWanPerYuan:ratio, ratioIssue, sourceAccountFullPayoutSelected:payout, payoutIssue });
}
