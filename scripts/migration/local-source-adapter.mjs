import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
// NEXT preserves the original evidence even when the old order lacks calculation inputs.
// A preserved ISOLATED record does not authorize settlement or prove a channel refund.
export const NEXT_CONTINUATION_POLICY = 'PRESERVE_SOURCE_ADMISSION_V1';
/** Full capture is input evidence; NEXT writes only the owner's selected account/order population. */
export function assertNextBusinessPopulation(population, isNext) {
  if (isNext !== true && isNext !== false) throw new Error('MIGRATION_PROFILE_FLAG_UNPROVEN');
  if (isNext && population?.mode !== 'SELECTED_BUSINESS_SCOPE') throw new Error('NEXT_SELECTED_BUSINESS_SCOPE_REQUIRED');
}
/** Validate opaque historical refund evidence without attributing it to an order. */
export function inspectUnresolvedRefundSource(snapshot, canonicalize) {
  const raw = snapshot?.rawSource;
  if (snapshot?.associationState !== 'UNRESOLVED' || raw?.entity !== 'la_refund_record' || typeof raw.canonical !== 'string') return 'SOURCE_MISSING';
  if (!/^[a-f0-9]{64}$/.test(raw.digest ?? '') || createHash('sha256').update(raw.canonical).digest('hex') !== raw.digest) return 'SOURCE_DIGEST_MISMATCH';
  let value;
  try { value = JSON.parse(raw.canonical); } catch { return 'SOURCE_JSON_INVALID'; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalize(value) !== raw.canonical) return 'SOURCE_CANONICAL_INVALID';
  if (!Object.hasOwn(value,'order_id') || !Object.hasOwn(value,'order_sn')) return 'SOURCE_ORDER_FIELDS_MISSING';
  const idUsable = (typeof value.order_id === 'string' || typeof value.order_id === 'number' && Number.isSafeInteger(value.order_id))
    && /^[1-9]\d{0,23}$/.test(String(value.order_id));
  const numberUsable = typeof value.order_sn === 'string' && value.order_sn.trim().length > 0;
  if (!idUsable && !numberUsable) return 'SOURCE_ORDER_IDENTIFIERS_UNUSABLE';
  return null;
}

export function expectedContinuationImports(manifest, isNext) {
  const d = manifest?.domains?.continuations;
  if (isNext !== true && isNext !== false) throw new Error('CONTINUATION_PROFILE_UNPROVEN');
  if (!isNext) return d?.parameterComplete;
  const s = d?.preparedEvidence;
  const fields = ['readyComplete', 'readyIsolated', 'readyUnprepared', 'unreadyEmitted', 'unreadyUnprepared'];
  if (s?.policy !== NEXT_CONTINUATION_POLICY || !fields.every(k => Number.isSafeInteger(s[k]) && s[k] >= 0)
      || s.readyUnprepared !== 0 || s.unreadyEmitted !== 0 || s.unreadyUnprepared !== 0 || !Number.isSafeInteger(d.source)
      || fields.reduce((n, k) => n + s[k], 0) !== d.source
      || !Number.isSafeInteger(d.parameterComplete) || !Number.isSafeInteger(d.isolated)
      || d.parameterComplete + d.isolated !== d.source
      || (manifest.files?.continuations?.rows ?? 0) !== s.readyComplete + s.readyIsolated + s.unreadyEmitted) {
    throw new Error('NEXT_CONTINUATION_SOURCE_COVERAGE_UNPROVEN');
  }
  return s.readyComplete + s.readyIsolated;
}

export function verifyNextContinuationRows(manifest, rows, admit) {
  const expected = expectedContinuationImports(manifest, true);
  const seen = new Set(), ready = [];
  let complete = 0, isolated = 0, unready = 0;
  for (const row of rows) {
    if (!row || typeof row.sourceId !== 'string' || seen.has(row.sourceId)) throw new Error('CONTINUATION_SOURCE_DUPLICATE');
    seen.add(row.sourceId);
    if (row.targetParentReady === false) { unready++; continue; }
    if (row.targetParentReady !== true || row.source?.legacyOrderId !== row.sourceId || !/^[a-f0-9]{64}$/.test(row.parentSourceDigest ?? ''))
      throw new Error('CONTINUATION_SOURCE_PARENT_MISMATCH');
    const actual = admit(row.source);
    if (!['PARAMETER_COMPLETE', 'ISOLATED'].includes(row.admission) || actual.admission !== row.admission
        || JSON.stringify(actual.reasons) !== JSON.stringify(row.reasons)) throw new Error('CONTINUATION_SOURCE_ADMISSION_MISMATCH');
    if (row.admission === 'PARAMETER_COMPLETE') complete++; else isolated++;
    ready.push(row);
  }
  const s = manifest.domains.continuations.preparedEvidence;
  if (ready.length !== expected || complete !== s.readyComplete || isolated !== s.readyIsolated || unready !== s.unreadyEmitted)
    throw new Error('NEXT_CONTINUATION_SOURCE_COUNT_MISMATCH');
  return ready;
}

export function buildNextContinuationRows({ manifest, rows, parents, sourceAsOf, admit }) {
  const ready = verifyNextContinuationRows(manifest, rows, admit);
  const byId = new Map(parents.map(parent => [parent.legacyId, parent]));
  if (byId.size !== parents.length) throw new Error('CONTINUATION_PARENT_DUPLICATE');
  return ready.map(row => {
    const parent = byId.get(row.sourceId);
    if (!parent || row.parentSourceDigest !== parent.sourceDigest) throw new Error('CONTINUATION_SOURCE_PARENT_MISMATCH');
    return { sourceId: row.sourceId, body: { orderId: parent.parentOrderId, sourceDigest: parent.sourceDigest,
      sourceAsOf, evidenceRef: manifest.sourceRef + ':continuation:' + row.sourceId, source: row.source, commissionEvidence: row.commissionEvidence } };
  });
}
export function parseSourceCaptureLine(line) {
    return JSON.parse(/^[0-9A-F]+$/.test(line) ? Buffer.from(line, "hex").toString("utf8") : line);
}
export const sourceJsonLine = row => JSON.stringify(row).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029") + "\n";
/** A new restore is accepted only with the same pre/post-checked capture origin. */
export function assertCapturedSourceOrigin(receipt,binding,bindingSha) {
    const origin=receipt?.sourceOrigin;
    if(binding?.schema!=="zzsh.local-source-origin.v2") {
        if(origin?.schema==="zzsh.local-source-origin.v2") throw new Error("SOURCE_ORIGIN_BINDING_MISMATCH");
        return;
    }
    const identity=receipt?.identity;
    if(!/^[a-f0-9]{64}$/.test(bindingSha??"")||receipt?.schema!=="zzsh.legacy-source-capture.v1"||receipt.status!=="CAPTURED_READ_ONLY"
      ||receipt.rollbackConfirmed!==true||receipt.clientClosed!==true||receipt.client?.code!==0||receipt.clientStderrPresent!==false
      ||origin?.schema!==binding.schema||origin.bindingSha256!==bindingSha
      ||origin.verifiedAfterCapture!==true||origin.sourceExportConsistency!=="NOT_VERIFIED_BY_RESTORE"
      ||binding.restoreRecord?.sourceExportConsistency!=="NOT_VERIFIED_BY_RESTORE"||origin.serverUuid!==binding.source?.serverUuid
      ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(origin.serverUuid??"")||!/^[a-f0-9]{64}$/.test(binding.container?.id??"")
      ||binding.source?.network!=="none"||binding.source.readOnly!==true||binding.source.superReadOnly!==true||binding.source.eventScheduler!=="DISABLED"
      ||!/^[a-f0-9]{64}$/.test(binding.restoreRecord?.dumpSha256??"")||binding.restoreRecord.consumedSha256!==binding.restoreRecord.dumpSha256||binding.restoreRecord.importClientExitCode!==0
      ||receipt.containerId!==binding.container?.id||receipt.database!==binding.source?.database
      ||identity?.database!==receipt.database||identity.principal!=="root@localhost"||identity.readOnly!==1||identity.isolation!=="REPEATABLE-READ"||identity.accessMode!=="READ ONLY"||identity.txState!=="ACTIVE"
      ||identity.serverUuid!==origin.serverUuid||identity.globalReadOnly!==1||identity.superReadOnly!==1||identity.eventScheduler!=="DISABLED")
        throw new Error("SOURCE_ORIGIN_BINDING_MISMATCH");
}
/** New captures must distinguish unavailable account facts from an omitted projection. */
export function assertDisplayCaptureCoverage(display) {
    const ratio=display?.accountBaseRatio,payout=display?.accountFullPayout,total=display?.rows,scope="ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT";
    const valid=value=>Number.isSafeInteger(value)&&value>=0;
    if(!valid(total)||ratio?.scope!==scope||![ratio.known,ratio.unknown].every(valid)||ratio.known+ratio.unknown!==total
      ||payout?.scope!==scope||![payout.selected,payout.unselected,payout.unknown].every(valid)
      ||payout.selected+payout.unselected+payout.unknown!==total)throw new Error("DISPLAY_CAPTURE_COVERAGE_REQUIRED");
}
export function assertDisplayCaptureRow(snapshot) {
    if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot)
      ||!Object.hasOwn(snapshot,"sourceAccountBaseRatioWanPerYuan")||!Object.hasOwn(snapshot,"sourceAccountFullPayoutSelected")
      ||snapshot.sourceAccountBaseRatioWanPerYuan!==null&&typeof snapshot.sourceAccountBaseRatioWanPerYuan!=="string"
      ||snapshot.sourceAccountFullPayoutSelected!==null&&typeof snapshot.sourceAccountFullPayoutSelected!=="boolean")
      throw new Error("DISPLAY_CAPTURE_FACTS_REQUIRED");
}
export function assertLegacyIdentityColumns(columns) {
    for (const field of ["id", "is_bind_id", "real_name", "id_card"])
        if (!columns?.has(field)) throw new Error("SOURCE_IDENTITY_COLUMN_MISSING:" + field);
}
export function assertLegacyListedPricingColumns(gameColumns, configColumns) {
    for (const [table, columns, fields] of [["la_sg_game", gameColumns, ["id", "profit_dot"]], ["la_system_config", configColumns, ["id", "type", "name", "value"]]])
        for (const field of fields) if (!columns?.has(field)) throw new Error("SOURCE_LISTED_PRICING_COLUMN_MISSING:" + table + "." + field);
}
export function assertLegacySkinDictionaryColumns(accountColumns,typeColumns,dataColumns) {
    for (const [table,columns,fields] of [["la_rental_accounts",accountColumns,["id","knife_skin","agent_skin","weapon_skin","gold_skin"]],
        ["la_dict_type",typeColumns,["id","dict_type"]],["la_dict_data",dataColumns,["id","type_id","name","value","is_delete"]]])
        for (const field of fields) if (!columns?.has(field)) throw new Error("SOURCE_SKIN_DICTIONARY_COLUMN_MISSING:" + table + "." + field);
}
export function inspectLegacySkinDictionaryCapture(receipt) {
    const proof=receipt?.skinDictionaryCapture;
    if (proof===undefined || proof===null) return {status:"LEGACY_FIXED_RULES"};
    if (proof.schema!=="zzsh.legacy-skin-dictionary-capture.v1" || proof.accounts!=="accountDisplay" || proof.types!=="skinDictionaryTypes"
        || proof.data!=="skinDictionaryData" || proof.sameSnapshot!==true || receipt.status!=="CAPTURED_READ_ONLY"
        || receipt.rollbackConfirmed!==true || receipt.clientClosed!==true) throw new Error("SOURCE_SKIN_DICTIONARY_PROOF_INVALID");
    for (const name of ["accountDisplay","skinDictionaryTypes","skinDictionaryData"])
        if (!Array.isArray(receipt.files?.[name]?.fields)) throw new Error("SOURCE_SKIN_DICTIONARY_PROOF_INVALID");
    assertLegacySkinDictionaryColumns(new Set(receipt.files.accountDisplay.fields),new Set(receipt.files.skinDictionaryTypes.fields),new Set(receipt.files.skinDictionaryData.fields));
    return {status:"SAME_SNAPSHOT_DYNAMIC_RULES"};
}
export function inspectLegacyListedPricingCapture(receipt, games, settings, parseInteger) {
    const proof = receipt?.listedPricingCapture;
    if (proof === undefined || proof === null) return { status: "NOT_CAPTURED_IN_BASE" };
    if (proof.schema !== "zzsh.legacy-listed-pricing-capture.v1" || proof.gameDomain !== "games" || proof.gameProfitField !== "profit_dot"
        || proof.fastConfigDomain !== "tradePolicy" || proof.fastConfigType !== "game" || proof.fastConfigName !== "profitFirstDot"
        || proof.runtimeRedis !== "NOT_CAPTURED" || receipt.status !== "CAPTURED_READ_ONLY" || receipt.rollbackConfirmed !== true || receipt.clientClosed !== true
        || !Array.isArray(receipt.files?.games?.fields) || !Array.isArray(receipt.files?.tradePolicy?.fields)
        || !Array.isArray(games) || !Array.isArray(settings) || typeof parseInteger !== "function") throw new Error("SOURCE_LISTED_PRICING_PROOF_INVALID");
    assertLegacyListedPricingColumns(new Set(receipt.files.games.fields), new Set(receipt.files.tradePolicy.fields));
    const game = games.filter(row => row?.id === "1" && row.is_delete === "0"), fast = settings.filter(row => row?.type === "game" && row.name === "profitFirstDot");
    if (game.length !== 1 || fast.length !== 1 || typeof game[0].profit_dot !== "string" || typeof fast[0].value !== "string") throw new Error("SOURCE_LISTED_PRICING_VALUES_NOT_UNIQUE");
    try { parseInteger(game[0].profit_dot, true); parseInteger(fast[0].value, true); }
    catch { throw new Error("SOURCE_LISTED_PRICING_VALUES_INVALID"); }
    return { status: "MYSQL_CAPTURE_VALUES_VALIDATED", gameRows: 1, fastConfigRows: 1, runtimeRedis: "NOT_CAPTURED", target: "NOT_VERIFIED" };
}
export function planLegacyIdentitySource(raw, verified, modules) {
    if (!verified) return { state: "NOT_VERIFIED", trustedIdentityNumber: null, legacyIdentityProfile: null };
    const details = { realName: raw.real_name, idCardNo: raw.id_card };
    if (!modules.identityProfile.validLegacyIdentityDetails(details)) return { state: "INVALID", trustedIdentityNumber: null, legacyIdentityProfile: null };
    try {
        return { state: "READY", trustedIdentityNumber: modules.identity.normalizeIdentityDocument(raw.id_card), legacyIdentityProfile: details };
    } catch { return { state: "INVALID", trustedIdentityNumber: null, legacyIdentityProfile: null }; }
}
export function matchesLegacyIdentitySource(raw, row) {
    const verified = row?.input?.evidence?.status?.realNameBound;
    if (!raw || raw.id !== row?.sourceId || typeof verified !== "boolean" || raw.is_bind_id !== (verified ? "1" : "0")) return false;
    return verified ? row.legacyIdentityProfile?.realName === raw.real_name && row.legacyIdentityProfile?.idCardNo === raw.id_card
        : row.legacyIdentityProfile === null;
}
/** Legacy text can contain U+2028/U+2029; only LF terminates these files' records. */
export async function* readLfLines(input, onBytes) {
    const decoder = new StringDecoder("utf8"); let pending = "";
    try {
        for await (const chunk of input) {
            if (onBytes) onBytes(chunk);
            pending += decoder.write(chunk); let at;
            while ((at = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, at); pending = pending.slice(at + 1);
                yield line;
            }
        }
        pending += decoder.end();
        if (pending) yield pending;
    } finally { input.destroy(); }
}
export async function* readSourceRows(file, onBytes) {
    for await (const line of readLfLines(createReadStream(file), onBytes)) if (line.trim()) yield JSON.parse(line);
}
/** Consumers must finish the stream before accepting data derived from it. */
export async function* readBoundSourceRows(file, entry) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.rows) || entry.rows < 0) throw new Error("SOURCE_STREAM_META_INVALID");
    const consumed = createHash("sha256"); let count = 0;
    for await (const row of readSourceRows(file, bytes => consumed.update(bytes))) { count++; yield row; }
    if (count !== entry.rows || consumed.digest("hex") !== entry.sha256) throw new Error("SOURCE_STREAM_CHANGED");
    const after = createHash("sha256"); for await (const bytes of createReadStream(file)) after.update(bytes);
    if (after.digest("hex") !== entry.sha256) throw new Error("SOURCE_STREAM_CHANGED_AFTER_READ");
}
/** Visit only in memory until the consumed bytes and subsequent file state have both been verified. */
export async function readVerifiedSourceRows(file, entry, visit) {
    if (typeof visit !== "function") throw new Error("SOURCE_STREAM_META_INVALID");
    let count = 0; for await (const row of readBoundSourceRows(file, entry)) { visit(row); count++; }
    return count;
}

/** Check the entire display package against the frozen source before any target write. */
export async function verifyDisplayCaptureInputs({sourceDir,sourceEntry,accountsDir,accountsEntry,displayDir,display,canonicalize}) {
    assertDisplayCaptureCoverage(display);
    if(typeof canonicalize!=="function"||!Array.isArray(sourceEntry?.fields)||!['base_bot','is_full_payout'].every(key=>sourceEntry.fields.includes(key))
      ||!Number.isSafeInteger(display.notDisplayable)||display.notDisplayable<0||display.rows+display.notDisplayable!==accountsEntry?.rows)
      throw new Error("DISPLAY_CAPTURE_SOURCE_REQUIRED");
    const file=(directory,entry)=>{
      if(typeof directory!=="string"||!entry||typeof entry.file!=="string"||entry.file!==basename(entry.file))throw new Error("DISPLAY_CAPTURE_SOURCE_REQUIRED");
      const path=join(directory,entry.file),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("DISPLAY_CAPTURE_SOURCE_REQUIRED");return path;
    };
    const source=new Map(),expected=new Map();
    await readVerifiedSourceRows(file(sourceDir,sourceEntry),sourceEntry,row=>{
      if(typeof row?.id!=="string"||!row.id||source.has(row.id)||!Object.hasOwn(row,'base_bot')||!Object.hasOwn(row,'is_full_payout')
        ||!['0','1','2','3','4','5','6'].includes(row.status)||!['0','1'].includes(row.is_delete))
        throw new Error("DISPLAY_CAPTURE_SOURCE_INVALID");
      source.set(row.id,{...legacyAccountCaptureProof(row,canonicalize),status:row.status,deleted:row.is_delete==='1'});
    });
    let nonDisplayable=0;
    await readVerifiedSourceRows(file(accountsDir,accountsEntry),accountsEntry,row=>{
      const proof=source.get(row?.sourceId);
      if(!proof||proof.sourceDigest!==row.sourceDigest||String(row.sourceStatus)!==proof.status||row.sourceDeleted!==proof.deleted||expected.has(row.sourceId))
        throw new Error("DISPLAY_CAPTURE_ACCOUNT_SOURCE_MISMATCH");
      const eligible=Boolean(row.snapshot&&row.sourceUpdatedAt&&[0,3,4,5,6].includes(Number(row.sourceStatus))&&!row.sourceDeleted);
      if(eligible)expected.set(row.sourceId,{proof,sourceUpdatedAt:row.sourceUpdatedAt});else {expected.set(row.sourceId,null);nonDisplayable++;}
    });
    if(nonDisplayable!==display.notDisplayable)throw new Error("DISPLAY_CAPTURE_DENOMINATOR_MISMATCH");
    const seen=new Set(),ratio={known:0,unknown:0},payout={selected:0,unselected:0,unknown:0};
    const entry={file:display.file,sha256:display.sha256,rows:display.rows};
    await readVerifiedSourceRows(file(displayDir,entry),entry,row=>{
      const match=expected.get(row?.sourceId);assertDisplayCaptureRow(row?.snapshot);
      if(!match||seen.has(row.sourceId)||row.baseSourceDigest!==match.proof.sourceDigest||row.sourceUpdatedAt!==match.sourceUpdatedAt
        ||!matchesCapturedAccountBaseRatio(match.proof,row.snapshot,row.baseSourceDigest)
        ||!matchesCapturedAccountFullPayout(match.proof,row.snapshot,row.baseSourceDigest))throw new Error("DISPLAY_CAPTURE_SOURCE_MISMATCH");
      seen.add(row.sourceId);ratio[row.snapshot.sourceAccountBaseRatioWanPerYuan===null?'unknown':'known']++;
      payout[row.snapshot.sourceAccountFullPayoutSelected===null?'unknown':row.snapshot.sourceAccountFullPayoutSelected?'selected':'unselected']++;
    });
    if(seen.size!==display.rows||seen.size!==expected.size-nonDisplayable||ratio.known!==display.accountBaseRatio.known||ratio.unknown!==display.accountBaseRatio.unknown
      ||['selected','unselected','unknown'].some(key=>payout[key]!==display.accountFullPayout[key]))throw new Error("DISPLAY_CAPTURE_DENOMINATOR_MISMATCH");
    return {status:"SOURCE_DISPLAY_CAPTURE_VERIFIED_TARGET_NOT_RUN",sourceAccounts:sourceEntry.rows,preparedAccounts:accountsEntry.rows,
      displayRows:display.rows,notDisplayable:nonDisplayable,ratio,payout,sourceSha256:sourceEntry.sha256,accountsSha256:accountsEntry.sha256,displaySha256:display.sha256,
      sourceConnections:0,targetConnections:0,targetWrites:0};
}
/** A later, bounded extract may add facts but cannot rewrite any field in its frozen base row. */
export function assertSourceSupplementFields(original, supplement) {
    if (!original || !supplement || original.id !== supplement.id)
        throw new Error("SUPPLEMENT_SOURCE_ID_CHANGED");
    for (const [field, value] of Object.entries(original))
        if (!Object.hasOwn(supplement, field) || supplement[field] !== value)
            throw new Error("SUPPLEMENT_COMMON_FIELD_DRIFT:" + original.id + ":" + field);
}
const digest = value => createHash("sha256").update(value).digest("hex");
export const LEGACY_DISTRIBUTION_CAPTURE_FIELDS = ["id", "sn", "user_id", "order_type", "order_id", "earnings", "level", "level_id", "ratio", "status", "settle_time", "is_delete", "create_time", "update_time", "order_goods_id", "goods_id", "sku_id", "delete_time"];
const flag = value => { if (value === "1")
    return true; if (value === "0")
    return false; throw new Error("SOURCE_FLAG_NOT_BINARY"); };
export function sourceAdultEvidence(card, updatedAt) {
    if (typeof card !== "string" || !/^[0-9]{17}[0-9Xx]$/.test(card) || !/^[1-9][0-9]{0,11}$/.test(updatedAt ?? ""))
        return null;
    const y = Number(card.slice(6, 10)), m = Number(card.slice(10, 12)), d = Number(card.slice(12, 14));
    const born = new Date(Date.UTC(y, m - 1, d));
    if (born.getUTCFullYear() !== y || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d)
        return null;
    const anniversary = new Date(born);
    anniversary.setUTCFullYear(y + 18);
    const at = Number(updatedAt) * 1000;
    if (!Number.isSafeInteger(at) || at > 253402300799999 || born.getTime() > at)
        return null;
    const utc = new Date(at).toISOString().slice(0, 10), cst = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
    const cutoff = anniversary.toISOString().slice(0, 10), a = utc >= cutoff, b = cst >= cutoff;
    return a === b ? a : null;
}
/** Transformation of original source fields, not a new identity-verification assertion. */
export function sourceUserPlanningRow(raw, modules, sourceRef) {
    const canonical = modules.contentHash.canonicalize(raw);
    const row = {
        id: raw.id, sn: raw.sn, mobile: raw.mobile, nickname: raw.nickname,
        is_delete: raw.is_delete, is_disable: raw.is_disable, is_bind_id: raw.is_bind_id, is_high_risk: raw.is_high_risk,
        ageAdult: sourceAdultEvidence(raw.id_card, raw.update_time), createTime: raw.create_time, updateTime: raw.update_time,
        sourceDigest: digest(canonical), evidenceRef: `${sourceRef}:la_user:${raw.id}`,
        legacyPassword: raw.password === null || raw.password === "" ? null : { version: "legacy-md5-v1", md5: raw.password.toLowerCase(), salt: raw.salt ?? "" },
    };
    return row;
}
/** Classify the source value without inventing a timestamp for missing or malformed data. */
export function classifyLegacyRegistrationTime(value, epochTimestamp) {
    if (value === null || value === undefined || value === 0 || value === "0") return "MISSING";
    try {
        if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return epochTimestamp(String(value)) ? "VALID" : "INVALID";
        if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return epochTimestamp(value) ? "VALID" : "INVALID";
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return "INVALID";
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,19) === value.slice(0,19) ? "VALID" : "INVALID";
    } catch { return "INVALID"; }
}
export function compareLegacyRegistrationFact(sourceTime, legacyId, fact) {
    if (!fact?.userId) return "TARGET_FACT_MISSING";
    if (fact.legacyId !== legacyId) return "TARGET_LEGACY_ID_MISMATCH";
    if (sourceTime === null || sourceTime === undefined) return fact.registeredAt === null ? "MATCH" : "TARGET_TIME_MISMATCH";
    const expected = Date.parse(sourceTime), observed = fact.registeredAt instanceof Date ? fact.registeredAt.getTime() : Date.parse(fact.registeredAt);
    if (!Number.isFinite(expected)) return "SOURCE_TIME_INVALID";
    return Number.isFinite(observed) && observed === expected ? "MATCH" : "TARGET_TIME_MISMATCH";
}
export function sourceUserPlan(raw, modules, sourceRef, seenPhones, contactProjections) {
    const row = sourceUserPlanningRow(raw, modules, sourceRef);
    if (contactProjections) {
        const contactProjection = contactProjections.get(raw.id);
        if (!contactProjection) throw new Error("WHOLE_SOURCE_CONTACT_PROJECTION_MISSING");
        row.contactProjection = contactProjection;
    }
    const plan = modules.planner.planLegacyUser(row, seenPhones);
    if (plan.disposition === "PARAMETER_READY") {
        if (plan.writerInput.evidence.mobile !== null) seenPhones.add(plan.writerInput.evidence.mobile);
    } else if (typeof plan.claimedMobile === "string")
        seenPhones.add(plan.claimedMobile);
    return plan;
}
export function sourceContactPlanningRow(raw, modules, sourceRef) {
    const sourceDigest = digest(modules.contentHash.canonicalize(raw));
    return { legacyId: raw.id, sourceSn: raw.sn, sourceDigest, mobile: raw.mobile === "" ? null : raw.mobile,
        deleted: flag(raw.is_delete), disabled: flag(raw.is_disable),
        sourceContactRef: `${sourceRef}:la_user:${raw.id}:mobile`,
        sourceContactDigest: digest(JSON.stringify(["legacy_mysql_restore", "la_user", raw.id, sourceDigest, "mobile", raw.mobile === "" ? null : raw.mobile])) };
}
/** Only the new explicitly reviewed contact-aware package uses whole-source contact ownership. */
export function sourceUserContactBatch(rawRows, modules, sourceRef) {
    return modules.planner.planLegacyUserContactBatch(rawRows.map(raw => sourceUserPlanningRow(raw, modules, sourceRef)));
}
/** Whole-source code ownership is checked before deriving any bounded scenario packets. */
export function sourceInvitationPlan(rawUsers, qualifications, modules, receipt, receiptSha256, cutoff, selectedUserIds) {
    const invitation = modules.invitation, hash = invitation.invitationFactHash;
    const qualificationByUser = new Map();
    for (const row of qualifications) {
        if (qualificationByUser.has(row.user_id)) throw new Error("SOURCE_QUALIFICATION_SUBJECT_DUPLICATE");
        qualificationByUser.set(row.user_id, row);
    }
    const fields = ["id", "is_delete", "is_disable", "inviter_id", "first_leader", "second_leader", "third_leader", "create_time", "update_time"];
    const raw = rawUsers.map(row => ({ legacyId: row.id, userId: modules.migration.legacyOwnerUserId("legacy_mysql_restore", "la_user", row.id),
        identitySourceDigest: digest(modules.contentHash.canonicalize(row)), userSource: Object.fromEntries(fields.map(field => [field, row[field] ?? null])),
        codeSource: { id: row.id, code: row.code }, qualificationSource: qualificationByUser.has(row.id) ? Object.fromEntries(["id", "user_id", "level_id", "is_delete", "is_freeze", "is_distribution"].map(field => [field, qualificationByUser.get(row.id)[field] ?? null])) : null }));
    const byId = new Map(raw.map(row => [row.legacyId, row])), ids = [...byId.keys()].sort();
    const source = { schema: "legacy-invitation-source.v2", sourceSystem: "legacy_mysql_restore", cutoff: new Date(cutoff).toISOString(), receiptSha256, supplementReceiptSha256: receiptSha256,
        files: { users: { sha256: receipt.files.users.sha256, rows: rawUsers.length }, qualification: { sha256: receipt.files.distribution.sha256, rows: qualifications.length }, codes: { sha256: receipt.files.users.sha256, rows: rawUsers.length } },
        subjectSetDigest: hash(ids), codeSetDigest: hash(ids.map(id => [id, byId.get(id).codeSource.code.toUpperCase(), hash(byId.get(id).codeSource)])) };
    const full = invitation.planLegacyInvitationFacts(source, raw);
    const prior = new Map(), packets = [];
    for (const packet of full.packets) {
        const subjects = packet.subjects.filter(fact => selectedUserIds.has(fact.legacyId));
        if (!subjects.length) continue;
        const inPacket = new Set(subjects.map(fact => fact.legacyId)), anchorIds = new Set();
        for (const fact of subjects) for (const [type, field] of [["INVITER", "inviter_id"], ["DISTRIBUTION_LEADER", "first_leader"]])
            if (fact.parents[type].knowledge === "KNOWN_PARENT" && !inPacket.has(fact.userSource[field])) anchorIds.add(fact.userSource[field]);
        const anchors = [...anchorIds].sort().map(id => {
            const p = prior.get(id); if (!p) throw new Error("SCENARIO_INVITATION_PARENT_NOT_PREPARED");
            return { fact: p.fact, batchKey: p.key, batchDigest: p.bodyDigest };
        });
        const input = { ...packet, subjects, anchors }, prepared = invitation.prepareLegacyInvitationFacts(input, hash(input));
        packets.push({ input, key: prepared.key, bodyDigest: prepared.bodyDigest, relations: prepared.relations.length });
        for (const fact of subjects) prior.set(fact.legacyId, { fact, key: prepared.key, bodyDigest: prepared.bodyDigest });
    }
    return { packets, summary: { ...full.summary, selectedSubjects: prior.size, selectedPackets: packets.length, policy: null, automaticEligibilityEnabled: false,
      childCounts: prior.size === raw.length ? "FULL_SOURCE_PROOF_PENDING_TARGET_CLOSURE" : "FULL_SOURCE_PROOF_NOT_CLOSED_ON_PARTIAL_TARGET" } };
}
export function sourceAccountPlan(raw, users, modules, sourceRef, games) {
    if (!/^[1-9][0-9]*$/.test(raw.id ?? ""))
        return { ready: false, reason: "ACCOUNT_ID_INVALID" };
    const owner = users.get(raw.user_id);
    if (!owner)
        return { ready: false, reason: "OWNER_NOT_MAPPED" };
    const gameCode = games.get(raw.game_id);
    if (!gameCode)
        return { ready: false, reason: "GAME_NOT_SUPPORTED" };
    if (!/^-?[0-9]+$/.test(raw.status ?? "") || !["0", "1"].includes(raw.is_delete))
        return { ready: false, reason: "ACCOUNT_SOURCE_STATE_INVALID" };
    const sourceDigest = digest(modules.contentHash.canonicalize(raw));
    const fields = ["id", "user_id", "game_id", "no", "status", "is_delete", "price_tenant", "extra_goods_total_price_tenant", "deposit_amount", "rental_days", "default_consume_type", "update_time"];
    const snapshotRow = Object.fromEntries(fields.map(name => [name, raw[name] ?? null]));
    const snapshot = modules.planner.listingSnapshot(snapshotRow);
    return {
        ready: true, sourceId: raw.id, sourceDigest, ownerLegacyId: raw.user_id, ownerUserId: owner.userId, ownerSourceDigest: owner.sourceDigest,
        gameCode, sourceStatus: raw.status, sourceDeleted: raw.is_delete === "1", businessNo: raw.no === null || raw.no === "" ? null : raw.no,
        evidenceRef: `${sourceRef}:la_rental_accounts:${raw.id}`, snapshot: snapshot.snapshot,
        metricSourceFields: Object.fromEntries(["is_full_payout"].filter(name => Object.hasOwn(raw, name)).map(name => [name, raw[name]])),
        sourceUpdatedAt: snapshot.sourceUpdatedAt, snapshotMissing: snapshot.missing,
        media: { pathsDigest: digest(raw.img_paths ?? ""), pathsLength: (raw.img_paths ?? "").length, titleDigest: digest(raw.title_img_name ?? ""), state: "UNRESOLVED_BYTES" },
        skins: { state: "PENDING_UNASSIGNED", rawFieldPresence: ["gold_skin", "knife_skin", "weapon_skin"].filter(name => Object.hasOwn(raw, name)) },
    };
}
export function sourceOrderPlan(raw, users, accounts, modules, sourceRef) {
    if (!["0", "1"].includes(raw.is_delete))
        return { ready: false, reason: "SOURCE_DELETE_FLAG_INVALID" };
    const owner = users.get(raw.sale_user_id), renter = users.get(raw.user_id), account = accounts.get(raw.accounts_id);
    if (!owner)
        return { ready: false, reason: "ORDER_OWNER_NOT_MAPPED" };
    if (!renter)
        return { ready: false, reason: "ORDER_RENTER_NOT_MAPPED" };
    if (!account)
        return { ready: false, reason: "ORDER_ACCOUNT_NOT_MAPPED" };
    const fields = modules.orderRead.LEGACY_ORDER_READ_SOURCE_FIELDS;
    if (!Array.isArray(fields))
        throw new Error("FORMAL_ORDER_SOURCE_FIELDS_NOT_EXPORTED");
    const row = Object.fromEntries(fields.filter(name => Object.hasOwn(raw, name)).map(name => [name, raw[name]]));
    const sourceDigest = digest(modules.contentHash.canonicalize(row));
    return {
        ready: true, sourceId: raw.id, sourceDigest, sourceDeleted: raw.is_delete === "1", source: { legacyId: raw.id, digest: sourceDigest, evidenceRef: `${sourceRef}:la_order:${raw.id}`, row },
        account: { legacyId: raw.accounts_id, businessNo: account.businessNo, sourceDigest: account.sourceDigest,
          ...(Object.hasOwn(account, "metricSourceFields") ? { metricSourceFields: account.metricSourceFields } : {}) },
        owner: { userId: owner.userId, legacyId: raw.sale_user_id, businessNo: null, sourceDigest: owner.sourceDigest },
        renter: { userId: renter.userId, legacyId: raw.user_id, businessNo: null, sourceDigest: renter.sourceDigest },
        gameCode: account.gameCode,
    };
}

/** Missing source columns and null values remain distinguishable in the preparation report. */
export function summarizeLegacyDashboardSources(orders, accounts, receipt, distributionOrders = []) {
    const describe = (domain, table, field, rows) => {
        const captured = receipt?.files?.[domain]?.fields, physical = receipt?.physicalColumns?.[table];
        const counts = { present: 0, null: 0, missing: 0 };
        for (const row of rows) {
            if (!Object.hasOwn(row, field)) counts.missing++;
            else if (row[field] === null) counts.null++;
            else counts.present++;
        }
        return { captured: Array.isArray(captured) ? captured.includes(field) : null,
            physical: Array.isArray(physical) ? physical.includes(field) : null, ...counts };
    };
    const physical = receipt?.physicalColumns?.la_distribution_order, captured = receipt?.files?.distributionOrders?.fields;
    const distributionColumns = { rows: distributionOrders.length,
        physicalCount: Array.isArray(physical) ? physical.length : null,
        capturedCount: Array.isArray(captured) ? captured.length : null,
        physicalNotCaptured: Array.isArray(physical) && Array.isArray(captured) ? physical.filter(name => !captured.includes(name)) : null,
        capturedNotProjected: Array.isArray(captured) ? captured.filter(name => !LEGACY_DISTRIBUTION_CAPTURE_FIELDS.includes(name)) : null };
    return { shareMoney: describe("orders", "la_order", "share_money", orders),
        commissionMoney: describe("orders", "la_order", "commission_money", orders),
        paymentTime: describe("orders", "la_order", "pay_time", orders),
        accountFullPayoutAtCapture: describe("accounts", "la_rental_accounts", "is_full_payout", accounts), distributionColumns,
        accountFlagMeaning: "ACCOUNT_STATE_AT_SOURCE_CAPTURE_NOT_PROVEN_AT_ORDER_PAYMENT" };
}

/** Independent readback must find the one bound source observation from the import audit. */
export function matchesLegacyAccountMetricAudit(records, expected, bindingDigest, canonicalize) {
    return Boolean(Array.isArray(records) && records.length === 1 && records[0] && records[0].bindingDigest === bindingDigest
        && records[0].accountMetricSource && canonicalize(records[0].accountMetricSource) === canonicalize(expected));
}

/** Retain only the digest and requested original fields in memory during independent readback. */
export function legacyAccountCaptureProof(raw, canonicalize) {
    return { sourceId: raw.id, sourceDigest: digest(canonicalize(raw)), sourceBaseRatio: raw.base_bot, metricSourceFields:
        Object.fromEntries(["is_full_payout"].filter(name => Object.hasOwn(raw, name)).map(name => [name, raw[name]])) };
}
export function matchesLegacyAccountCapture(proof, planned, canonicalize) {
    return Boolean(proof && proof.sourceId === planned.sourceId && planned.metricSourceFields !== undefined
        && proof.sourceDigest === planned.sourceDigest && canonicalize(proof.metricSourceFields) === canonicalize(planned.metricSourceFields));
}

/** Independently compare captured base_bot; it is never treated as an order's frozen price. */
export function matchesCapturedAccountBaseRatio(proof, snapshot, expectedSourceDigest) {
    if (!proof || proof.sourceDigest !== expectedSourceDigest || !snapshot || !Object.hasOwn(snapshot,"sourceAccountBaseRatioWanPerYuan") || !Array.isArray(snapshot.issues)) return false;
    const raw = proof.sourceBaseRatio;
    const text = typeof raw === "string" ? raw : typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : null;
    let expected = null, issue;
    if (raw === null || raw === undefined || raw === "") issue = "base_bot:MISSING";
    else if (text === null || !/^(0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(text)) issue = "base_bot:INVALID";
    else if (BigInt(text.replace(".","")) === 0n) issue = "base_bot:NON_POSITIVE";
    else expected = text;
    return snapshot.sourceAccountBaseRatioWanPerYuan === expected
        && (issue ? snapshot.issues.filter(value => value === issue).length === 1 : !snapshot.issues.some(value => value.startsWith("base_bot:")));
}

export function matchesCapturedAccountFullPayout(proof, snapshot, expectedSourceDigest) {
    if (!proof || proof.sourceDigest !== expectedSourceDigest || !snapshot || !Object.hasOwn(snapshot,"sourceAccountFullPayoutSelected") || !Array.isArray(snapshot.issues)) return false;
    const raw=proof.metricSourceFields?.is_full_payout;
    const expected=raw===true || raw===1 || raw==='1' ? true : raw===false || raw===0 || raw==='0' ? false : null;
    return snapshot.sourceAccountFullPayoutSelected===expected && (expected===null
        ? snapshot.issues.filter(value=>value==='is_full_payout:UNKNOWN').length===1
        : !snapshot.issues.includes('is_full_payout:UNKNOWN'));
}

/** Order read snapshots remain exactly the whitelisted original la_order projection. */
export function legacyOrderCaptureProof(raw, sourceFields, canonicalize) {
    const source = Object.fromEntries(sourceFields.filter(name => Object.hasOwn(raw, name)).map(name => [name, raw[name]]));
    return { sourceId: raw.id, sourceDigest: digest(canonicalize(source)) };
}
export function matchesLegacyOrderCapture(proof, planned, canonicalize) {
    return Boolean(proof && proof.sourceId === planned.sourceId && proof.sourceDigest === planned.sourceDigest
        && digest(canonicalize(planned.source.row)) === proof.sourceDigest);
}
export const LEGACY_REFUND_RELATIONSHIP_POLICY = "legacy-refund-relationship-v2";
export const LEGACY_DATASET_PREPARATION_TOOLS = Object.freeze(["prepare-local-dataset.mjs", "local-source-adapter.mjs", "local-source-scenarios.mjs", "selected-business-scope.mjs"]);

/** A blank matching order number is missing evidence, not an exact refund link. */
export function isExactLegacyRefundRelationship(refund, order) {
    return refund?.order_type === "order" && typeof refund.order_id === "string" && refund.order_id !== "" && order?.id === refund.order_id
        && typeof refund.user_id === "string" && refund.user_id !== "" && order.user_id === refund.user_id
        && typeof refund.order_sn === "string" && refund.order_sn.trim() !== "" && order.order_sn === refund.order_sn;
}

export function sourceFinanceObservation(domain, raw) {
    const integer = value => { if (!/^-?[0-9]+$/.test(value ?? "") || !Number.isSafeInteger(Number(value)))
        throw new Error("SOURCE_INTEGER_INVALID"); return Number(value); };
    if (domain === "earnings")
        return {
            kind: "HISTORICAL_EARNINGS_LOG", sourceId: raw.id, legacyUserId: raw.user_id,
            row: { id: integer(raw.id), sn: raw.sn, action: integer(raw.action), amount: raw.change_amount, userId: integer(raw.user_id), sourceId: integer(raw.source_id), createdAt: integer(raw.create_time), changeType: integer(raw.change_type), leftAmount: raw.left_amount, ...Object.fromEntries(["source_sn", "remark", "extra", "update_time", "delete_time"].filter(k=>Object.hasOwn(raw,k)).map(k=>[k==="source_sn"?"sourceSn":k,raw[k]])) },
        };
    if (domain === "withdraws")
        return {
            kind: "HISTORICAL_WITHDRAWAL", sourceId: raw.id, legacyUserId: raw.user_id,
            row: { id: integer(raw.id), sn: raw.sn, type: integer(raw.type), money: raw.money, status: integer(raw.status), userId: integer(raw.user_id), batch_no: raw.batch_no, is_delete: integer(raw.is_delete), left_money: raw.left_money, create_time: integer(raw.create_time), handling_fee: raw.handling_fee, payment_time: integer(raw.payment_time), ...Object.fromEntries(["update_time", "delete_time", "payment_no", "transfer_time", "global_no"].filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]])) },
        };
    if (domain === "distributionOrders")
        return {
            kind: "HISTORICAL_DISTRIBUTION", sourceId: raw.id, legacyUserId: raw.user_id,
            row: Object.fromEntries(LEGACY_DISTRIBUTION_CAPTURE_FIELDS.filter(k=>Object.hasOwn(raw,k)).map(name => [name, raw[name] ?? null])),
        };
    throw new Error("SOURCE_DOMAIN_NOT_SUPPORTED");
}
/** Source-column mapping for the existing legacy arithmetic; no new price or settlement rule. */
export function sourceContinuation(raw, account, paidRows, commissionRows, policy) {
    const prices = row => Object.fromEntries(Object.entries({ barrett: "barrett_bullet_price", bullet: "level6_bullet_price", awm: "awm_bullet_price", armor: "level6_armor_price", helmet: "level6_helmet_price", coffee: "coffee_price", card: "top_insure_card_price" }).map(([name, column]) => [name, row?.[column] ?? null]));
    const quantities = Object.fromEntries(Object.entries({ barrett: "barrett_bullet_num", bullet: "level6_bullet_num", awm: "awm_bullet_num", armor: "level6_armor_num", helmet: "level6_helmet_num", coffee: "coffee_num", card: "top_insure_card_num" }).map(([name, column]) => [name, raw[column] ?? null]));
    return {
        legacyOrderId: raw.id, orderStatus: raw.order_status, isSettle: raw.is_settle, renterId: raw.user_id, ownerId: raw.sale_user_id, accountId: account?.id ?? null,
        profitDot: raw.profit_dot ?? null, baseBot: account?.base_bot ?? null, payMoney: raw.pay_money ?? null, goodsMoney: raw.goods_money ?? null, storedCommissionMoney: raw.commission_money ?? null,
        depositAmount: raw.deposit_amount ?? null, detainMoney: raw.detain_money ?? null, returnOrderMoney: raw.return_order_money ?? null, saleEarnings: raw.sale_earnings ?? null, fullPayoutMoney: raw.full_payout_money ?? null,
        isFullPayout: account?.is_full_payout ?? null, isAdvanceSet: raw.is_advance_set ?? null, orderPrices: prices(raw), accountPrices: prices(account), quantities: { expendHaff: raw.expend_haff ?? null, ...quantities },
        paidPay: paidRows.map(p => ({ id: p.id, payOrderSn: p.pay_order_sn, payMoney: p.pay_money, orderId: p.order_id })),
        commissions: commissionRows.map(c => ({ id: c.id, beneficiaryId: c.user_id, ratio: c.ratio, level: c.level, status: c.status, storedEarnings: c.earnings })), policy,
    };
}
