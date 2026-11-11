import { canonicalize } from "./content-hash";
import { parseNonNegativeDecimal } from "./decimal";
import { legacyPriceInteger } from "./legacy-listed-pricing";
import { sha256Hex } from "./supply-util";

const SALE_KEYS = ["barrettBulletSale", "bulletSale", "awmSale", "armorSale", "helmetSale", "coffeeSale", "experienceCardSale"] as const;
type PolicyBinding = { proofSha256: string; sourceReceiptSha256: string; sourceBindingSha256: string; dumpSha256: string; dumpVerifierSha256: string;
  sourceId: string; sourceDigest: string; legacyGameId: string; expectedAccountCount: number;
  authorityCanonical:string; authoritySha256:string };

/**
 * Validates a reviewed local capture against independently supplied sealed hashes and the exact
 * mapped source row. This checks integrity, not provenance of the reviewer's expected hashes.
 * Only a controlled importer may supply those hashes; they are not an HTTP quote parameter.
 */
export function readLegacyListedPolicy(canonical: string, expected: PolicyBinding) {
  const reject = (): never => { throw new Error("LEGACY_POLICY_PROOF_INVALID"); };
  if (!Number.isSafeInteger(expected.expectedAccountCount) || expected.expectedAccountCount < 1 || expected.expectedAccountCount > 10000
    || !/^[a-f0-9]{64}$/.test(expected.proofSha256)
    || !/^[a-f0-9]{64}$/.test(expected.sourceReceiptSha256) || !/^[a-f0-9]{64}$/.test(expected.sourceBindingSha256)
    || !/^[a-f0-9]{64}$/.test(expected.dumpSha256) || !/^[a-f0-9]{64}$/.test(expected.dumpVerifierSha256) || !/^[a-f0-9]{64}$/.test(expected.sourceDigest)
    || !/^[a-f0-9]{64}$/.test(expected.authoritySha256) || typeof expected.authorityCanonical !== "string" || Buffer.byteLength(expected.authorityCanonical,"utf8")>4096
    || sha256Hex(expected.authorityCanonical)!==expected.authoritySha256
    || !/^[1-9]\d{0,23}$/.test(expected.sourceId) || !/^[1-9]\d{0,23}$/.test(expected.legacyGameId)
    || typeof canonical !== "string" || Buffer.byteLength(canonical,"utf8") > 32768 || sha256Hex(canonical) !== expected.proofSha256) reject();
  let bundle: any; try { bundle = JSON.parse(canonical); if (canonicalize(bundle) !== canonical) reject(); } catch { return reject(); }
  let authority: any; try { authority=JSON.parse(expected.authorityCanonical); if(canonicalize(authority)!==expected.authorityCanonical)reject(); } catch { return reject(); }
  if(!authority || Object.keys(authority).sort().join(",")!==["schema","decision","scope","runtimeCacheKnowledge","productionCutover","sourceReceiptSha256","sourceBindingSha256","dumpSha256","policyBundleSha256","authorityRef","instruction"].sort().join(",")
    || authority.schema!=="legacy-listed-policy-authority-v1" || authority.decision!=="OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY"
    || authority.scope!=="LOCAL_AND_TEST_SERVER" || authority.runtimeCacheKnowledge!=="UNKNOWN" || authority.productionCutover!=="REVERIFY_SOURCE_RUNTIME_POLICY"
    || authority.sourceReceiptSha256!==expected.sourceReceiptSha256 || authority.sourceBindingSha256!==expected.sourceBindingSha256
    || authority.dumpSha256!==expected.dumpSha256 || authority.policyBundleSha256!==expected.proofSha256
    || typeof authority.authorityRef!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(authority.authorityRef)
    || typeof authority.instruction!=="string" || !authority.instruction.trim() || authority.instruction.length>500)reject();
  const p = bundle?.supplement, dump = bundle?.dumpVerification;
  const sameCapture = bundle?.schema === "legacy-listed-policy-evidence-v2";
  if ((!sameCapture && bundle?.schema !== "legacy-listed-policy-evidence-v1") || bundle.verifierSha256 !== expected.dumpVerifierSha256
    || bundle.temporalLimit !== (sameCapture ? "SAME_MYSQL_SNAPSHOT_RUNTIME_REDIS_NOT_CAPTURED" : "DUMP_AND_LATER_RESTORE_AGREE_CAPTURE_OMITTED_SPREADS_NO_PROOF_OF_INTERMEDIATE_UNCHANGED")
    || !p || sha256Hex(canonicalize(p)) !== bundle.supplementSha256
    || dump?.schema !== "zzsh.legacy-listing-dump-policy-check.v1" || dump.sourceDumpSha256 !== expected.dumpSha256
    || dump.gameId !== expected.legacyGameId || dump.matchCounts?.game !== 1 || dump.matchCounts?.fastConfig !== 1
    || typeof dump.sourceCutoff !== "string" || !Number.isFinite(Date.parse(dump.sourceCutoff))
    || dump.sourceCutoffMeaning !== "OWNER_LOCAL_DUMP_EXPORT_COMPLETED_NOT_PROVEN_PRODUCTION_STOP_WRITE_CUTOFF") reject();
  if (!p || p.schema !== (sameCapture ? "legacy-listed-policy-capture-v2" : "legacy-listed-policy-supplement-v1") || p.sourceReceiptSha256 !== expected.sourceReceiptSha256
    || p.sourceBindingSha256 !== expected.sourceBindingSha256 || p.dumpSha256 !== expected.dumpSha256
    || !/^[a-f0-9]{64}$/.test(p.containerId ?? "") || p.rollbackConfirmed !== true
    || p.identity?.database !== "sg_zzsh_restore" || p.identity.readOnly !== 1 || p.identity.isolation !== "REPEATABLE-READ"
    || p.identity.accessMode !== "READ ONLY" || p.identity.txState !== "ACTIVE"
    || (sameCapture
      ? p.comparison !== "ACCOUNTS_AND_POLICY_SAME_CAPTURE" || p.temporalLimit !== "RUNTIME_REDIS_NOT_CAPTURED" || p.clientClosed !== true
      : !["TEN_EXACT_ROWS_AND_CAPTURED_MATERIAL_POLICY_IDENTICAL","EXACT_LISTED_ROWS_AND_CAPTURED_MATERIAL_POLICY_IDENTICAL"].includes(p.comparison)
        || p.comparison === "TEN_EXACT_ROWS_AND_CAPTURED_MATERIAL_POLICY_IDENTICAL" && expected.expectedAccountCount !== 10
        || p.temporalLimit !== "TWO_SPREAD_FIELDS_WERE_NOT_IN_BASE_CAPTURE")
    || (sameCapture ? [p.baseCaptureStartedAt,p.baseCaptureFinishedAt] : [p.baseCaptureStartedAt,p.baseCaptureFinishedAt,p.startedAt,p.finishedAt])
      .some((value: unknown) => typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    || sameCapture && (Date.parse(p.baseCaptureStartedAt) > Date.parse(p.baseCaptureFinishedAt)
      || Date.parse(dump.sourceCutoff) > Date.parse(p.baseCaptureStartedAt))
    || !Array.isArray(p.accountSourceDigests) || p.accountSourceDigests.length !== expected.expectedAccountCount
    || p.accountSourceDigests.some((x: any) => !/^[1-9]\d{0,23}$/.test(x?.id ?? "") || !/^[a-f0-9]{64}$/.test(x?.sha256 ?? ""))
    || new Set(p.accountSourceDigests.map((x: any) => x.id)).size !== expected.expectedAccountCount
    || !p.accountSourceDigests.some((x: any) => x.id === expected.sourceId && x.sha256 === expected.sourceDigest)
    || !Array.isArray(p.gameRows) || !Array.isArray(p.settingRows)) reject();
  const games = p.gameRows.filter((x: any) => x.id === expected.legacyGameId);
  const fast = p.settingRows.filter((x: any) => x.type === "game" && x.name === "profitFirstDot");
  if (games.length !== 1 || fast.length !== 1 || typeof games[0].profitDot !== "string" || typeof fast[0].value !== "string"
    || games[0].profitDot !== dump.ordinaryProfitDot || fast[0].value !== dump.fastProfitFirstDot) reject();
  const salePrices: Record<string,string> = {};
  try {
    legacyPriceInteger(games[0].profitDot, true); legacyPriceInteger(fast[0].value, true);
    for (const key of SALE_KEYS) {
      const rows = p.settingRows.filter((x: any) => x.type === "expendConfig" && x.name === key);
      if (rows.length !== 1 || typeof rows[0].value !== "string") reject();
      parseNonNegativeDecimal(rows[0].value, 8, "legacy sale price"); salePrices[key] = rows[0].value;
    }
  } catch { return reject(); }
  // This self-contained, non-path policy record travels with PostgreSQL. Raw source accounts and
  // local filenames remain outside it; the reviewed evidence package is bound by its digest.
  const frozen = { schema:sameCapture ? "legacy-listed-policy-frozen-v2" : "legacy-listed-policy-frozen-v1", sourceSystem:"legacy_mysql_restore", sourceEntity:"la_rental_accounts",
    evidenceBundleSha256:expected.proofSha256, sourceReceiptSha256:expected.sourceReceiptSha256, sourceBindingSha256:expected.sourceBindingSha256,
    dumpSha256:expected.dumpSha256, verifierSha256:expected.dumpVerifierSha256, sourceCutoff:dump.sourceCutoff, sourceCutoffMeaning:dump.sourceCutoffMeaning,
    baseCaptureStartedAt:p.baseCaptureStartedAt, baseCaptureFinishedAt:p.baseCaptureFinishedAt,
    ...(!sameCapture ? {supplementStartedAt:p.startedAt, supplementFinishedAt:p.finishedAt} : {}),
    temporalLimit:bundle.temporalLimit, accountSourceDigests:p.accountSourceDigests, sourceAccountCount:expected.expectedAccountCount, legacyGameId:expected.legacyGameId,
    policyAuthority:{decision:authority.decision,scope:authority.scope,runtimeCacheKnowledge:authority.runtimeCacheKnowledge,productionCutover:authority.productionCutover,authorityRef:authority.authorityRef,authoritySha256:expected.authoritySha256},
    ordinarySpread:games[0].profitDot, fastSpread:fast[0].value, salePrices };
  const policyCanonical = canonicalize(frozen);
  return { ordinarySpread: games[0].profitDot as string, fastSpread: fast[0].value as string, salePrices,
    policyDigest: sha256Hex(policyCanonical), policyCanonical, temporalLimit: bundle.temporalLimit as string };
}
