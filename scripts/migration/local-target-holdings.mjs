import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { assertSourceSupplementFields } from "./local-source-adapter.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const AMBIGUOUS = ["影锋", "AUG-气象感应", "K416-命运", "M4棱镜攻势", "M7棱镜攻势", "QBZ95-王牌之剑", "SCAR-电玩", "Vctor-冲锋枪-美杜莎", "腾龙-气象感应"];

async function boundCapture(ctx, directory, expectedSha, name) {
  const path = resolve(directory ?? "");
  if (!path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || !/^[a-f0-9]{64}$/.test(expectedSha ?? "")) throw new Error("BOUND_SKIN_SOURCE_REQUIRED");
  const bytes = readFileSync(join(path, "receipt.json"));
  if (hash(bytes) !== expectedSha) throw new Error("SKIN_SOURCE_RECEIPT_SHA_MISMATCH");
  const receipt = JSON.parse(bytes), entry = receipt.files[name];
  const original = JSON.parse(readFileSync(join(ctx.manifest.source, "receipt.json")));
  if (receipt.status !== "CAPTURED_READ_ONLY" || !receipt.rollbackConfirmed || !receipt.clientClosed || receipt.containerId !== original.containerId || receipt.database !== original.database || !entry || entry.file !== basename(entry.file)) throw new Error("SKIN_SOURCE_NOT_CONFIRMED");
  const file = join(path, entry.file), digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  if (digest.digest("hex") !== entry.sha256) throw new Error("SKIN_SOURCE_FILE_SHA_MISMATCH");
  return { receipt, entry, file };
}

/** Four source columns remain source declarations. Names or catalog media never imply ownership. */
export async function applyHoldingDomain(ctx, options) {
  const source = await boundCapture(ctx, options.source, options.sourceSha256, "accountDisplay");
  const dictionary = await boundCapture(ctx, options.dictionary, options.dictionarySha256, "skinDictionaryData");
  const dictionaryTypes = await boundCapture(ctx, options.dictionary, options.dictionarySha256, "skinDictionaryTypes");
  const modules = ctx.mod("legacy-load/legacy-skin-holdings"), canonical = ctx.mod("supply/content-hash").canonicalize;
  if (modules.LEGACY_SKIN_FIELDS.some(field => !source.entry.fields.includes(field))) throw new Error("FOUR_SOURCE_SKIN_FIELDS_NOT_OBSERVED");
  const rawBase = new Map();
  for await (const row of ctx.readRows(join(ctx.manifest.source, "accounts.jsonl"))) rawBase.set(row.id, row);
  const sourceCount = rawBase.size;
  const columnsById = new Map(); let compared = 0;
  for await (const row of ctx.readRows(source.file)) {
    assertSourceSupplementFields(rawBase.get(row.id), row);
    rawBase.delete(row.id);
    if (columnsById.has(row.id)) throw new Error("DUPLICATE_HOLDING_SOURCE_ID");
    columnsById.set(row.id, { columns: Object.fromEntries(modules.LEGACY_SKIN_FIELDS.map(field => [field, row[field]])), updatedAt: row.update_time });
    compared++;
  }
  if (compared !== sourceCount || rawBase.size) throw new Error("HOLDING_SOURCE_DENOMINATOR_CHANGED");
  const dictionaryRows = []; for await (const row of ctx.readRows(dictionary.file)) dictionaryRows.push(row);
  const types = new Map();
  for await (const row of ctx.readRows(dictionaryTypes.file)) {
    if (types.has(row.id) || typeof row.dict_type !== "string" || !row.dict_type) throw new Error("DICTIONARY_TYPE_CONTEXT_UNBOUND");
    types.set(row.id, row);
  }
  const tokenRules = AMBIGUOUS.map((token, index) => {
    const field = index === 0 ? "knife_skin" : "weapon_skin";
    const matches = dictionaryRows.filter(row => row.name === token && row.value === token);
    if (matches.length < 2 || matches.some(row => !/^[1-9]\d*$/.test(row.id) || !/^[1-9]\d*$/.test(row.type_id) || !["0", "1"].includes(row.is_delete) || !types.has(row.type_id))) throw new Error("RETAINED_SKIN_AMBIGUITY_NOT_SOURCE_PROVED");
    return { field, token, decision: "SOURCE_AMBIGUOUS", sources: matches.map(row => ({ dictField: types.get(row.type_id).dict_type, dictTypeId: Number(row.type_id), dictDataId: Number(row.id), state: row.is_delete === "1" ? "HISTORICAL_SOFT_DELETED" : "CURRENT" })) };
  });
  const gameId = ctx.state.gameBindings.delta;
  const catalogRevision = (await ctx.client.query("SELECT catalog_revision::text revision FROM zzsh_supply.game WHERE id=$1", [gameId])).rows[0]?.revision;
  const catalog = (await ctx.client.query(`SELECT id AS "skinId",game_id AS "gameId",source_field AS "sourceField",source_token AS "sourceToken",naming_state AS "namingState",enabled,form_visible AS "formVisible" FROM zzsh_supply.skin WHERE game_id=$1 ORDER BY id`, [gameId])).rows;
  const index = modules.buildLegacySkinIndex(catalog, tokenRules), catalogDigest = hash(canonical(catalog));
  const binding = { sourceSha256: options.sourceSha256, dictionarySha256: options.dictionarySha256, catalogRevision, catalogDigest, sourceExtractSha256: source.entry.sha256, tokenRulesExtractSha256: options.dictionarySha256, tokenRulesDigest: hash(canonical(tokenRules)) };
  ctx.state.additiveInputs ??= {};
  if (ctx.state.additiveInputs.holdings && canonical(ctx.state.additiveInputs.holdings) !== canonical(binding)) throw new Error("HOLDINGS_CHECKPOINT_INPUT_CHANGED");
  ctx.state.additiveInputs.holdings = binding;
  const phaseDir = join(ctx.output, "phases"); if (!existsSync(phaseDir)) mkdirSync(phaseDir);
  const phasePath = join(phaseDir, "skinHoldings.json"), prior = ctx.state.generatedPhases?.skinHoldings;
  let ready, sourceContext;
  if (prior) {
    const bytes = readFileSync(phasePath);
    if (hash(bytes) !== prior.sha256) throw new Error("HOLDINGS_PREPARED_PHASE_CHANGED");
    const prepared = JSON.parse(bytes); ready = prepared.rows; sourceContext = prepared.sourceContext;
  }
  else {
    const targetMap = new Map((await ctx.client.query("SELECT legacy_id,account_id,version_id,source_digest FROM zzsh_supply.legacy_supply_map WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts'")).rows.map(row => [row.legacy_id, row]));
    const targetBindingsSha256 = hash(canonical([...targetMap.values()].sort((a, b) => a.legacy_id < b.legacy_id ? -1 : 1)));
    sourceContext = { schema: "legacy-skin-holdings-source-v1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", sourceExtractSha256: source.entry.sha256, sourceCutoff: ctx.manifest.sourceCutoff, targetBindingsSha256, tokenRulesVersion: "SUP-SKIN-020-nine-source-ambiguities-v1", tokenRulesExtractSha256: options.dictionarySha256, tokenRules, gameId, catalogRevision };
    ready = []; const isolated = [], reasonCounts = {};
    for await (const account of ctx.readRows(ctx.domainFile("accounts"))) {
      const original = columnsById.get(account.sourceId), target = targetMap.get(account.sourceId);
      if (!target || target.source_digest !== account.sourceDigest) throw new Error("HOLDING_TARGET_MAP_NOT_BOUND");
      const holding = modules.mapLegacySkinHolding({ accountKey: account.sourceId, gameId, columns: original.columns }, index, catalogRevision);
      const sourceUpdatedAtUtc = ctx.mod("order/legacy-order-read").legacyEpochTimestamp(original.updatedAt);
      const reasons = [...holding.unobservedColumns.map(field => "UNOBSERVED:" + field), ...holding.pending.map(row => "PENDING:" + row.namingState), ...holding.unresolved.map(row => row.reason)];
      if (!sourceUpdatedAtUtc || Date.parse(sourceUpdatedAtUtc) > Date.parse(ctx.manifest.sourceCutoff)) reasons.push("SOURCE_UPDATED_AT_NOT_BOUND");
      if (reasons.length) {
        isolated.push({ sourceId: account.sourceId, reasons: [...new Set(reasons)], holding });
        for (const reason of new Set(reasons)) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
        continue;
      }
      const sealedRow = { legacyId: account.sourceId, accountId: target.account_id, observationVersionId: target.version_id, sourceDigest: target.source_digest, sourceUpdatedAtUtc, columns: original.columns };
      ready.push({ sourceId: account.sourceId, sealedRow, expectedSkinIds: holding.mappedSkinIds, evidenceRef: ctx.manifest.sourceRef + ":skin-holdings:" + account.sourceId });
    }
    writeFileSync(join(ctx.output, "skin-holdings-isolated.json"), JSON.stringify({ isolated, reasonCounts, originalColumnsObserved: true, partialSetNotWrittenAsComplete: true }), { flag: "wx" });
    ctx.state.skinHoldingsPreparation = { sourceAccounts: targetMap.size, ready: ready.length, isolated: isolated.length, reasonCounts, commonFieldDifferences: 0, ambiguityRulesRetained: tokenRules.length };
    const bytes = JSON.stringify({ sourceContext, rows: ready }); writeFileSync(phasePath, bytes, { flag: "wx" });
    ctx.state.generatedPhases ??= {}; ctx.state.generatedPhases.skinHoldings = { sha256: hash(bytes), rows: ready.length };
  }
  ctx.save();
  const writer = ctx.mod("supply/legacy-observation");
  await ctx.runItems("skinHoldings", ready, async row => {
    const bytes = JSON.stringify({ ...sourceContext, rows: [row.sealedRow] }), admission = writer.prepareLegacySkinHoldingsAdmission(bytes, hash(bytes));
    const prepared = writer.prepareLegacySkinHoldingsInput(admission, row.sourceId, catalog, row.evidenceRef);
    const existing = (await ctx.client.query("SELECT 1 FROM zzsh_supply.legacy_skin_holding WHERE account_id=$1", [prepared.accountId])).rowCount > 0;
    const result = await writer.recordLegacySkinHoldings(ctx.client, prepared.accountId, prepared.input, ctx.actor, admission);
    return { ...result, replayed: existing };
  }, 50);
  const actual = (await ctx.client.query("SELECT count(*)::int count FROM zzsh_supply.legacy_skin_holding WHERE evidence_ref LIKE $1", [ctx.manifest.sourceRef + ":skin-holdings:%"])).rows[0].count;
  const phase = ctx.state.phases.skinHoldings;
  ctx.state.skinHoldingsReconciliation = { expectedComplete: ready.length, actual, runtimeQuarantined: phase.quarantined, onlyCompleteDeclarationsAttached: true, noCatalogAliasOrIdentityChanges: true, neverRestoredTradingEligibility: true };
  ctx.save();
  if (actual + phase.quarantined !== ready.length) throw new Error("HOLDING_TARGET_DENOMINATOR_DIFFERED");
}
