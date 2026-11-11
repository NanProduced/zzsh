import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { assertDisplayCaptureCoverage, assertDisplayCaptureRow, verifyDisplayCaptureInputs } from "./local-source-adapter.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Supplemental display facts are additive; original account and money facts stay immutable. */
export async function applyDisplayDomain(ctx, directory, manifestSha256) {
  const path = resolve(directory ?? "");
  if (!path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "")) throw new Error("BOUND_DISPLAY_INPUT_REQUIRED");
  const bytes = readFileSync(join(path, "manifest.json"));
  if (hash(bytes) !== manifestSha256) throw new Error("DISPLAY_MANIFEST_SHA_MISMATCH");
  const manifest = JSON.parse(bytes);
  if (manifest.status !== "DISPLAY_SUPPLEMENT_PREPARED_TARGET_NOT_RUN" || manifest.datasetSha256 !== ctx.state.binding.datasetSha256 || manifest.commonFieldDifferences !== 0 || manifest.file !== basename(manifest.file) || !/^[a-f0-9]{64}$/.test(manifest.extractSha256 ?? "")) throw new Error("DISPLAY_SOURCE_NOT_BOUND");
  if(ctx.manifest.identityProfiles){
    assertDisplayCaptureCoverage(manifest);
    const sourceDir=resolve(ctx.manifest.source??'');
    if(!sourceDir.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\"))throw new Error("DISPLAY_CAPTURE_SOURCE_REQUIRED");
    const sourceBytes=readFileSync(join(sourceDir,'receipt.json'));
    if(hash(sourceBytes)!==ctx.manifest.sourceReceiptSha256)throw new Error("DISPLAY_CAPTURE_SOURCE_REQUIRED");
    const source=JSON.parse(sourceBytes),contentHash=ctx.mod('supply/content-hash');
    if(source.status!=='CAPTURED_READ_ONLY'||source.rollbackConfirmed!==true||source.clientClosed!==true)throw new Error('DISPLAY_CAPTURE_SOURCE_REQUIRED');
    ctx.state.displayCapturePreflight=await verifyDisplayCaptureInputs({sourceDir,sourceEntry:source.files?.accounts,
      accountsDir:dirname(ctx.domainFile('accounts')),accountsEntry:ctx.manifest.files?.accounts,displayDir:path,display:manifest,canonicalize:contentHash.canonicalize});
  }
  const file = join(path, manifest.file), digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  if (digest.digest("hex") !== manifest.sha256) throw new Error("DISPLAY_INPUT_SHA_MISMATCH");
  ctx.state.additiveInputs ??= {};
  if (ctx.state.additiveInputs.display && ctx.state.additiveInputs.display.manifestSha256 !== manifestSha256) throw new Error("DISPLAY_CHECKPOINT_INPUT_CHANGED");
  ctx.state.additiveInputs.display = { directory: path, manifestSha256, extractSha256: manifest.extractSha256, rows: manifest.rows };
  ctx.save();
  const accountId = ctx.mod("legacy-load/legacy-account-seam").legacyAccountId;
  const writer = ctx.mod("supply/legacy-listing-read").recordLegacyDisplaySnapshot;
  const idFor = row => accountId("legacy_mysql_restore", "la_rental_accounts", row.sourceId);
  let bindings;
  await ctx.runItems("accountDisplay", ctx.readRows(file), async row => {
    if(ctx.manifest.identityProfiles)assertDisplayCaptureRow(row.snapshot);
    const id = idFor(row), original = bindings.get(id);
    if (!original) { const error = new Error("TARGET_ACCOUNT_SNAPSHOT_NOT_MAPPED"); error.status = 409; error.code = "TARGET_ACCOUNT_SNAPSHOT_NOT_MAPPED"; throw error; }
    if (original.source_digest !== row.baseSourceDigest || original.source_updated_at !== row.sourceUpdatedAt) throw new Error("TARGET_ACCOUNT_SNAPSHOT_SOURCE_DRIFT");
    return writer(ctx.client, id, { observationVersionId: original.observation_version_id, baseSourceDigest: row.baseSourceDigest, extractSha256: manifest.extractSha256, sourceUpdatedAt: row.sourceUpdatedAt, evidenceRef: `legacy-display-v1:${manifest.extractSha256}:${row.sourceId}`, snapshot: row.snapshot }, ctx.actor);
  }, 100, async batch => {
    // The writer still rechecks the immutable original and live permissions per account.
    const originals = (await ctx.client.query("SELECT account_id,observation_version_id,source_digest,to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') source_updated_at FROM zzsh_supply.legacy_listing_read_snapshot WHERE account_id=ANY($1::text[])", [batch.map(idFor)])).rows;
    bindings = new Map(originals.map(row => [row.account_id, row]));
  });
  const actual = (await ctx.client.query("SELECT count(*)::int n FROM zzsh_supply.legacy_listing_display_snapshot WHERE extract_sha256=$1" + (ctx.displayAccountIds ? " AND account_id=ANY($2::text[])" : ""), ctx.displayAccountIds ? [manifest.extractSha256, ctx.displayAccountIds] : [manifest.extractSha256])).rows[0].n;
  const phase = ctx.state.phases.accountDisplay;
  if (actual !== phase.created + phase.replayed || actual + phase.quarantined !== manifest.rows) throw new Error("DISPLAY_TARGET_DENOMINATOR_MISMATCH");
  ctx.state.displayReconciliation = { sourceRows: manifest.rows, targetRows: actual, quarantined: phase.quarantined, sourceRowsCompared: manifest.sourceRowsCompared, commonFieldDifferences: 0, targetFinancialEffects: 0 };
  ctx.save();
}
