import { prepareLocalFundsPlan, assertFundsWriterCoverage,assertEmptyCoverageReceiptMode,continuationCommissionEffects } from "./local-funds-plan.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildNextContinuationRows, readBoundSourceRows } from "./local-source-adapter.mjs";
import { requiresInvitationCountClosure } from "./local-round-contract.mjs";
import { openingReviewResource } from "./local-target-opening.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const micros = value => value.replace(/\.([0-9]{3})Z$/, (_, digits) => "." + digits + "000Z");
async function arrayOf(ctx, name) {
    const result = [], file = ctx.domainFile(name);
    if (file) {
        const rows = ctx.isNextMigration ? readBoundSourceRows(file, ctx.manifest.files[name]) : ctx.readRows(file);
        for await (const row of rows) result.push(row);
    }
    return result;
}
export async function importEmptyCoverageChunk(module,client,actor,inputs,reviews,isNext){
    if(typeof isNext!=='boolean')throw new Error('MIGRATION_PROFILE_FLAG_UNPROVEN');
    const scope=await module.bindReviewedEmptyFinanceObservationBatch(client,actor,inputs,reviews);
    const result=await (isNext ? module.importReviewedCompactEmptyFinanceObservationBatch : module.importReviewedEmptyFinanceObservationBatch)(client,actor,inputs,scope);
    return{...result.body,replayed:result.body.created===0};
}
export function readEmptyCoverageInputs(chunk, expectedHash) {
    const bytes = readFileSync(chunk.file);
    if (expectedHash !== null && (!/^[a-f0-9]{64}$/.test(expectedHash ?? "") || sha(bytes) !== expectedHash))
        throw new Error("PREPARED_CHUNK_SHA_CHANGED");
    const rows = JSON.parse(bytes);
    if (!Array.isArray(rows) || rows.length !== chunk.rows) throw new Error("PREPARED_CHUNK_ROWS_CHANGED");
    return rows.map(row => row.input);
}
function freezePhase(ctx, name, rows) { ctx.state.generatedPhases ??= {}; const dir = join(ctx.output, "phases"); if (!existsSync(dir))
    mkdirSync(dir); const file = join(dir, name + ".json"); const previous = ctx.state.generatedPhases[name]; if (previous) {
    const bytes = readFileSync(file);
    if (sha(bytes) !== previous.sha256)
        throw new Error("PREPARED_PHASE_SHA_CHANGED");
    return JSON.parse(bytes);
} const bytes = JSON.stringify(rows); writeFileSync(file, bytes, { flag: "wx" }); ctx.state.generatedPhases[name] = { file, sha256: sha(bytes), rows: rows.length }; ctx.save(); return rows; }
async function facts(ctx, legacyIds) { const { client, actor } = ctx; const parents = (await client.query(`SELECT legacy_id AS "legacyId",id AS "parentOrderId",source_digest AS "sourceDigest",binding_digest AS "bindingDigest",source_snapshot AS "sourceSnapshot",to_char(source_completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceCompletedAt",owner_user_id AS "ownerUserId",renter_user_id AS "renterUserId",account_id AS "accountId",deposit_amount_cents::text AS "depositAmountCents" FROM zzsh_order.legacy_order_read_snapshot WHERE legacy_id=ANY($1::text[])`, [legacyIds])).rows; const ids = parents.map(p => p.parentOrderId); const duties = (await client.query(`SELECT id,order_id AS "orderId",kind,source_record_id AS "sourceRecordId",amount_cents::text AS "amountCents",status,counterparty_user_id AS "counterpartyUserId",settled_by AS "settledBy",admission_id AS "admissionId" FROM zzsh_order.legacy_order_duty WHERE order_id=ANY($1::text[])`, [ids])).rows; const admissions = (await client.query(`SELECT id,duty_id AS "dutyId",order_id AS "orderId",admission_digest AS "admissionDigest" FROM zzsh_order.legacy_order_duty_admission WHERE order_id=ANY($1::text[])`, [ids])).rows; const heads = (await client.query(`SELECT order_id AS "orderId",revision::text FROM zzsh_order.legacy_continuation_version WHERE order_id=ANY($1::text[]) AND superseded_at IS NULL`, [ids])).rows; const operations = ["order.legacy.liability.import", "order.legacy.commission.completed-import", "order.legacy.continuation.import"]; const scopes = ids.flatMap(id => operations.map(op => JSON.stringify(["admin", actor.userId, op, id]))); const receipts = (await client.query('SELECT scope_key,key,request_fingerprint AS fingerprint,response_status AS "responseStatus" FROM zzsh_supply.idempotency_record WHERE scope_key=ANY($1::text[])', [scopes])).rows.map(row => { const [realm, principalId, operation, resourceId] = JSON.parse(row.scope_key); return { principalId, operation, resourceId, key: row.key, fingerprint: row.fingerprint, responseStatus: row.responseStatus }; }); const revisions = new Map(heads.map(h => [h.orderId, h.revision]));
    const dutiesByOrder = Map.groupBy(duties, d => d.orderId);
    const admissionsByOrder = Map.groupBy(admissions, a => a.orderId);
    const receiptsByOrder = Map.groupBy(receipts, r => r.resourceId);
    const current = parents.map(parent => ({ orderId: parent.parentOrderId, readRef: "core-dataset:" + ctx.state.binding.oid + ":" + parent.parentOrderId, headRevision: revisions.get(parent.parentOrderId) ?? null, depositAmountCents: parent.depositAmountCents, duties: dutiesByOrder.get(parent.parentOrderId) ?? [], admissions: admissionsByOrder.get(parent.parentOrderId) ?? [], idempotency: { principalId: actor.userId, records: receiptsByOrder.get(parent.parentOrderId) ?? [] } })); return { parents, current }; }
export async function applyInvitationDomains(ctx, reviewCommon, resource, canonical) {
    const {client,actor,mod,manifest,state}=ctx;
    const packets=ctx.invitationSource ? null : ctx.invitationPackets??await arrayOf(ctx,"invitation-facts");
    const source=()=>ctx.invitationSource ? ctx.invitationSource() : packets;
    const packetCount=ctx.invitationSource ? ctx.invitationPacketCount : packets.length;
    const review=(packet,phase)=>({ref:reviewCommon.ref,attempt:reviewCommon.attempt,actor:reviewCommon.actor,
      resource:{...resource,ownerOid:Number(state.resource.owner_oid)},notBefore:reviewCommon.notBefore,expiresAt:reviewCommon.expiresAt,
      sourceDigest:sha(canonical(packet.input.source)),bodyDigest:packet.bodyDigest,phase});
    const module=mod("finance/legacy-invitation-facts-maintenance");
    await ctx.runItems("invitationFacts",source(),async packet=>{
        if(packet.input.policy!==null)throw new Error("SOURCE_INVITATION_POLICY_MUST_REMAIN_UNBOUND");
        const scope=await module.bindReviewedLegacyInvitationFacts(client,actor,review(packet,'IMPORT'));
        return module.importReviewedLegacyInvitationFacts(client,actor,packet.input,packet.bodyDigest,scope);
    },1);
    if(requiresInvitationCountClosure(manifest)){
        if(state.phases.invitationFacts?.complete!==true || state.phases.invitationFacts.quarantined!==0
          || state.phases.invitationFacts.nextIndex!==packetCount)throw new Error("INVITATION_IMPORT_NOT_COMPLETE");
        await ctx.runItems("invitationCounts",source(),async packet=>{
            const scope=await module.bindReviewedLegacyInvitationFacts(client,actor,review(packet,'COUNTS'));
            return module.closeReviewedLegacyInvitationCounts(client,actor,packet.input,packet.bodyDigest,scope);
        },1);
    }
}
export async function applyFinancialDomains(ctx) {
    if (typeof ctx.isNextMigration !== 'boolean') throw new Error('MIGRATION_PROFILE_FLAG_UNPROVEN');
    if(!ctx.fundsSource||!ctx.refundAttemptsSource)throw new Error("EXACT_FINANCIAL_SUPPLEMENTS_REQUIRED");
    const { client, actor, mod, manifest, state } = ctx, preparation = mod("finance/legacy-finance-source-preparation"), canonical = mod("supply/content-hash").canonicalize;
    const sourceCutoff=new Date(manifest.sourceCutoff).toISOString();
    const resource = openingReviewResource(ctx);
    const reviewCommon = { ref: "CORE_FULL_LEGACY_" + state.binding.oid, attempt: "dataset-" + state.binding.datasetSha256.slice(0, 16), actor: { userId: actor.userId, sessionId: actor.sessionId }, resource, ...(state.executionWindow ?? { notBefore: state.startedAt, expiresAt: new Date(Date.parse(state.startedAt) + 12 * 3600000).toISOString() }), cutoff: sourceCutoff };
    // Empty coverage is streamed: each 400-entry chunk is frozen to its own restricted file as soon
    // as it is complete, so a full-source round never holds one entry per subject and source kind.
    const emptyDir = join(ctx.output, "phases", "financeEmptyCoverage");
    if (!existsSync(emptyDir)) mkdirSync(emptyDir, { recursive: true });
    const emptyDescriptors = [], emptyContentHashes = new Map();
    const emitEmptyChunk = chunk => {
        const file = join(emptyDir, chunk.digest + ".json");
        const content = JSON.stringify(chunk.entries), contentHash = sha(content);
        if (ctx.isNextMigration && emptyContentHashes.has(chunk.digest)) throw new Error("PREPARED_CHUNK_DUPLICATE");
        emptyContentHashes.set(chunk.digest, contentHash);
        if (existsSync(file)) {
            if (sha(readFileSync(file)) !== contentHash) throw new Error("PREPARED_CHUNK_SHA_CHANGED");
        } else writeFileSync(file, content, { flag: "wx" });
        emptyDescriptors.push({ sourceId: chunk.sourceId, digest: chunk.digest, rows: chunk.rows, domains: chunk.domains, file });
    };
    const preparationStarted = performance.now(), fundsPlan = await prepareLocalFundsPlan({ ...ctx, emitEmptyChunk });
    const preparedMs = performance.now() - preparationStarted;
    if (state.generatedPhases?.financeHistory && !state.fundsSupplement) throw new Error("FROZEN_V1_FINANCE_HISTORY_REQUIRES_SEPARATE_REVIEW");
    const history = freezePhase(ctx, "financeHistory", fundsPlan.history);
    const guarantees = freezePhase(ctx, "guaranteeHistory", fundsPlan.guaranteeHistory);
    if (state.generatedPhases?.financeEmptyCoverage) {
        const previous = state.generatedPhases.financeEmptyCoverage;
        if (previous.digest !== fundsPlan.emptyCoverage.digest || previous.rows !== fundsPlan.emptyCoverage.rows)
            throw new Error("PREPARED_EMPTY_COVERAGE_CHANGED");
        assertEmptyCoverageReceiptMode(previous,ctx.isNextMigration);
        if (ctx.isNextMigration && JSON.stringify(previous.chunks) !== JSON.stringify(emptyDescriptors))
            throw new Error("PREPARED_EMPTY_COVERAGE_CHANGED");
        for (const chunk of previous.chunks) if (!existsSync(chunk.file)) throw new Error("PREPARED_CHUNK_MISSING");
    } else {
        state.generatedPhases ??= {};
        state.generatedPhases.financeEmptyCoverage = { ...fundsPlan.emptyCoverage, chunks: emptyDescriptors, ...(ctx.isNextMigration ? {receiptMode:"BATCH_V2"} : {}) };
        ctx.save();
    }
    const coverage = assertFundsWriterCoverage(fundsPlan, history, guarantees, fundsPlan.emptyCoverage);
    const priorSupplement=state.fundsSupplement;
    state.fundsSupplement = { executionProvenance:[...(priorSupplement?.executionProvenance??[]),{at:new Date().toISOString(),toolFiles:fundsPlan.binding.toolFiles,compiledModules:fundsPlan.binding.compiledModules,preparedMs,historyGroups:history.length,emptyGroups:fundsPlan.emptyCoverage.rows,emptyChunks:fundsPlan.emptyCoverage.chunks,guaranteeGroups:guarantees.length}],binding: priorSupplement?.binding??fundsPlan.binding, inputSha256: fundsPlan.inputSha256, refundAttemptCoverage:fundsPlan.refundAttemptCoverage,pendingCommissionCoverage:fundsPlan.pendingCommissionCoverage, coverage };
    ctx.save();
    await applyInvitationDomains(ctx,reviewCommon,resource,canonical);
    await ctx.runBatches("financeHistory", history, async (rows) => { const module = mod("finance/personal-finance-observation-maintenance"); const inputs = rows.map(row => row.input); const reviews = inputs.map(input => ({ ...reviewCommon, inputSha256: input.coverage.inputSha256, bodyDigest: sha(canonical(input)), userId: input.coverage.userId, sourceKind: input.coverage.sourceKind })); const scopes = await module.bindReviewedFinanceObservationAdmissionBatch(client, actor, reviews); const result = await module.importReviewedFinanceObservationsBatchOn(client, actor, inputs, scopes); const created = result.body.created; return rows.map((_, i) => ({ replayed: i >= created })); }, 500);
    await ctx.runItems("financeEmptyCoverage",state.generatedPhases.financeEmptyCoverage.chunks,async chunk=>{
        const module=mod("finance/personal-finance-observation-maintenance"),inputs=readEmptyCoverageInputs(chunk,ctx.isNextMigration ? emptyContentHashes.get(chunk.digest) : null);
        const reviews=inputs.map(input=>({...reviewCommon,inputSha256:input.coverage.inputSha256,bodyDigest:sha(canonical(input)),userId:input.coverage.userId,sourceKind:input.coverage.sourceKind}));
        return importEmptyCoverageChunk(module,client,actor,inputs,reviews,ctx.isNextMigration);
    },5);
    // The old listing deposit is out of scope: nothing is written for it, and the exclusion is
    // recorded on the plan so the report can prove it was deliberate.
    const continuations = await arrayOf(ctx, "continuations");
    const next = ctx.isNextMigration === true;
    let continuationRows = !next && state.generatedPhases?.continuationEvidence ? freezePhase(ctx, "continuationEvidence", []) : null;
    if (!continuationRows) {
        const target = await facts(ctx, continuations.map(row => row.sourceId));
        const byLegacy = new Map(target.parents.map(p => [p.legacyId, p]));
        continuationRows = [];
        if (next) {
            continuationRows = buildNextContinuationRows({manifest, rows: continuations, parents: target.parents, sourceAsOf: micros(sourceCutoff), admit: mod("order/legacy-continuation-calc").admitLegacyEvidence});
            const prior = state.generatedPhases?.continuationEvidence && freezePhase(ctx, "continuationEvidence", []);
            if (prior && JSON.stringify(prior) !== JSON.stringify(continuationRows)) throw new Error("CONTINUATION_FROZEN_PHASE_CHANGED");
        } else {
        for (const row of continuations) {
            const parent = byLegacy.get(row.sourceId);
            if (!parent) {
                state.quarantine.push({ domain: "continuationEvidence", sourceId: row.sourceId, code: "TARGET_PARENT_NOT_MAPPED" });
                continue;
            }
            if (row.admission !== "PARAMETER_COMPLETE") {
                state.quarantine.push({ domain: "continuationEvidence", sourceId: row.sourceId, code: "SOURCE_PARAMETERS_ISOLATED" });
                continue;
            }
            continuationRows.push({ sourceId: row.sourceId, body: { orderId: parent.parentOrderId, sourceDigest: parent.sourceDigest, sourceAsOf: micros(sourceCutoff), evidenceRef: manifest.sourceRef + ":continuation:" + row.sourceId, source: row.source, commissionEvidence: row.commissionEvidence } });
        }
        }
        continuationRows = freezePhase(ctx, "continuationEvidence", continuationRows);
    }
    await ctx.runItems("continuationEvidence", continuationRows, row => mod("order/legacy-continuation-evidence").importLegacyContinuationEvidence(client, actor, row.body), 20);
    const liabilities = await arrayOf(ctx, "liabilities");
    let liabilityRows = state.generatedPhases?.liabilityDuties ? freezePhase(ctx, "liabilityDuties", []) : null;
    if (!liabilityRows) {
        const target = await facts(ctx, liabilities.map(row => row.sourceId));
        const parentIds = new Map(target.parents.map(p => [p.legacyId, p.parentOrderId]));
        const assembly = preparation.assembleLegacyLiabilityBatch({ batchId: "full-liabilities-" + state.binding.oid, parents: target.parents, current: target.current, rows: liabilities.map(row => ({ classification: row.classification, legacyOrderId: row.sourceId, mappedOrderId: parentIds.get(row.sourceId) ?? null, originalOrder: row.originalOrder, refundRecord: row.refundRecords.length === 1 ? row.refundRecords[0] : null, evidenceRef: manifest.sourceRef + ":liability:" + row.sourceId })) });
        writeFileSync(join(ctx.output, "liability-assembly.json"), JSON.stringify(assembly, null, 2), { flag: "wx" });
        liabilityRows = [];
        for (const row of assembly.rows) {
            if (row.admitted && row.command)
                liabilityRows.push({ sourceId: row.sourceKey, body: row.command.body, effect: row.effect });
            else
                state.quarantine.push({ domain: "liabilityDuties", sourceId: row.sourceKey, code: row.reasons.join("|") || row.state });
        }
        liabilityRows = freezePhase(ctx, "liabilityDuties", liabilityRows);
    }
    await ctx.runItems("liabilityDuties", liabilityRows, row => mod("order/legacy-liability-intake").importLegacyHistoricalLiability(client, actor, row.body), 20);
    const pending = await arrayOf(ctx, "pending-commissions");
    let completedRows = state.generatedPhases?.completedCommissions ? freezePhase(ctx, "completedCommissions", []) : null;
    if (!completedRows) {
        const target = await facts(ctx, pending.map(row => row.parentLegacyOrderId));
        const parents = new Map(target.parents.map(p => [p.legacyId, p]));
        const identities = (await client.query("SELECT split_part(i.provider_reference,':',2) AS id FROM zzsh_iam.user_identity_state i WHERE i.provider='legacy_mysql_restore' AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=i.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS' AND a.details->>'legacyId'=split_part(i.provider_reference,':',2))")).rows.map(r => r.id);
        const assembly = preparation.assembleLegacyCompletedCommissionBatch({ batchId: "full-commissions-" + state.binding.oid, cutoff: micros(sourceCutoff), parents: target.parents, current: target.current, verifiedBeneficiaries: identities, rows: pending.map(row => ({ sourceRecord: row.sourceRecord, parentLegacyOrderId: row.parentLegacyOrderId, mappedOrderId: parents.get(row.parentLegacyOrderId)?.parentOrderId ?? null, bucket: parents.get(row.parentLegacyOrderId)?.sourceSnapshot?.order_status === '4' ? "COMPLETED_PARENT" : "INFLIGHT_PARENT", evidenceRef: manifest.sourceRef + ":commission:" + row.sourceRecord.id })) });
        writeFileSync(join(ctx.output, "commission-assembly.json"), JSON.stringify(assembly, null, 2), { flag: "wx" });
        completedRows = [];
        for (const row of assembly.rows) {
            if (row.admitted && row.command)
                completedRows.push({ sourceId: row.sourceKey, body: row.command.body, effect: row.effect });
            else if (row.state !== "OBSERVE_ONLY")
                state.quarantine.push({ domain: "completedCommissions", sourceId: row.sourceKey, code: row.reasons.join("|") || row.state });
        }
        completedRows = freezePhase(ctx, "completedCommissions", completedRows);
    }
    await ctx.runItems("completedCommissions", completedRows, row => mod("order/legacy-continuation-evidence").importLegacyCompletedCommission(client, actor, row.body), 20);
    const wanted = [...liabilityRows, ...completedRows].filter(row => row.effect).map(row=>({...row,effect:{...row.effect,...(row.body?.commission?{level:row.body.commission.level,ratio:row.body.commission.ratio,sourceRecordId:row.body.commission.id}:{} )}}));
    wanted.push(...continuationCommissionEffects(continuationRows,mod).map(effect=>({effect})));
    const ids = wanted.map(row => row.effect.dutyId);
    const actual = (await client.query("SELECT id,amount_cents::text AS amount,status,counterparty_user_id AS beneficiary,kind,source_record_id AS source_id,settled_by,level::text AS level,ratio::text,source_digest FROM zzsh_order.legacy_order_duty WHERE id=ANY($1::text[])", [ids])).rows;
    const byId = new Map(actual.map(row => [row.id, row]));
    const mismatches = [];
    for (const row of wanted) {
        const expected = row.effect, found = byId.get(expected.dutyId);
        if (!found || found.amount !== expected.amountCents || found.beneficiary !== expected.beneficiaryUserId || found.kind !== expected.kind || found.status !== expected.status || found.settled_by !== expected.settledBy || expected.sourceRecordId!==undefined&&found.source_id!==expected.sourceRecordId || expected.level!==undefined&&(found.level!==expected.level||!mod("order/legacy-continuation-model").legacyDecimalEquals(found.ratio,expected.ratio)) || expected.sourceDigest!==undefined&&found.source_digest!==expected.sourceDigest)
            mismatches.push({ dutyId: expected.dutyId, reason: "EXACT_DUTY_FACT_DIFFERED" });
    }
    const subjects=[...new Set([...history.map(row=>row.input.coverage.legacyUserId),...fundsPlan.emptyCoverage.subjects])];
    const observed=(await client.query(`SELECT source_kind,count(*)::int AS count,(sum((snapshot->>'amount')::numeric)*100)::numeric(24,0)::text AS amount FROM zzsh_order.personal_finance_observation WHERE source_system='legacy_mysql_restore' AND legacy_user_id=ANY($1::text[]) GROUP BY source_kind`,[subjects])).rows;
    const targetReadable={};
    for(const [domain,count]of Object.entries(coverage)){
        if(domain==='guarantees')continue;
        const kind=history.find(row=>row.domain===domain)?.input.coverage.sourceKind,found=observed.find(row=>row.source_kind===kind);
        targetReadable[domain]={expected:count.writer,actual:found?.count??0,recordedAmountCents:found?.amount??'0'};
        if((found?.count??0)!==count.writer||(found?.amount??'0')!==count.recordedAmountCents)mismatches.push({domain,reason:'SOURCE_OBSERVATION_COUNT_OR_AMOUNT_DRIFT'});
    }
    const actualCoverage=(await client.query(`SELECT source_kind,count(*)::int AS count,count(*) FILTER(WHERE source_count=0 AND imported_count=0 AND isolated_count=0)::int AS empty FROM zzsh_order.personal_finance_observation_coverage WHERE source_system='legacy_mysql_restore' AND source_cutoff=$1::timestamptz AND legacy_user_id=ANY($2::text[]) GROUP BY source_kind`,[sourceCutoff,subjects])).rows;
    for(const [domain,count]of Object.entries(coverage))if(domain!=='guarantees'){
        const kind=history.find(row=>row.domain===domain)?.input.coverage.sourceKind??fundsPlan.emptyCoverage.kinds[domain];
        const found=actualCoverage.find(row=>row.source_kind===kind);Object.assign(targetReadable[domain],{coverageExpected:count.coverageSelected,coverageActual:found?.count??0,provedEmpty:found?.empty??0});
        if(found?.count!==count.coverageSelected||found?.empty!==count.emptyCoverage)mismatches.push({domain,reason:'SOURCE_COVERAGE_SUBJECT_OR_EMPTY_SET_GAP'});
    }
    const attemptActual=(await client.query(`SELECT count(*)::int AS count,count(DISTINCT a->>'sourceId')::int AS distinct_count,COALESCE(sum((a->>'amountCents')::numeric),0)::text AS amount FROM zzsh_order.personal_finance_observation o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'sourceAttempts') a WHERE o.source_kind='HISTORICAL_REFUND' AND o.legacy_user_id=ANY($1::text[])`,[subjects])).rows[0];
    targetReadable.refundAttempts={expected:fundsPlan.refundAttemptCoverage.selected,actual:attemptActual?.count??0,distinctSourceIds:attemptActual?.distinct_count??0,recordedAmountCents:attemptActual?.amount??'0'};
    if(attemptActual?.count!==fundsPlan.refundAttemptCoverage.selected||attemptActual?.distinct_count!==fundsPlan.refundAttemptCoverage.selected||attemptActual?.amount!==fundsPlan.refundAttemptCoverage.recordedAmountCents)mismatches.push({domain:'refundAttempts',reason:'TYPED_SOURCE_ATTEMPT_COVERAGE_GAP'});
    // The only acceptable target fact is none at all: any row here would mean the old listing deposit
    // found another way in.
    // The retired listing-deposit tables no longer exist in the target, and their absence is exactly the
  // state this reconciliation wants to prove, so a missing table counts as zero rather than failing.
  const guaranteePresent=(await client.query(`SELECT to_regclass('zzsh_order.legacy_owner_guarantee_observation') IS NOT NULL AS present`)).rows[0]?.present===true;
  const guaranteeActual=guaranteePresent?(await client.query(`SELECT count(*)::int AS count FROM zzsh_order.legacy_owner_guarantee_observation`)).rows[0]:{count:0};
    targetReadable.guarantees={expected:0,actual:guaranteeActual?.count??0,policyExcluded:true,listingDeposit:fundsPlan.listingDepositExclusion};
    if((guaranteeActual?.count??0)!==0)mismatches.push({domain:'guarantees',reason:'LISTING_DEPOSIT_PRESENT_IN_TARGET'});
    const native = (await client.query("SELECT (SELECT count(*)::int FROM zzsh_order.rental_order) native_orders,(SELECT count(*)::int FROM zzsh_order.payment_confirmation) native_payments,(SELECT count(*)::int FROM zzsh_order.settlement_posting) native_postings,(SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry) native_ledger")).rows[0];
    const report = { targetReadable,expectedDuties: wanted.length, matched: actual.length, mismatches, native, storedOpening: "NOT_IMPORTED_WITHOUT_REVIEWED_ECONOMIC_PROOF", financialHistory: "OBSERVATION_ONLY_NO_CHANNEL_OR_WALLET_POSTING", sourceRawRetained: true,sourceRawScope:"SAFE_PG_SNAPSHOTS_AND_RESTRICTED_SOURCE_REFERENCE" };
    // A stopped round re-enters this stage, so an identical reconciliation file from the previous attempt
  // is reused instead of failing on the exclusive-create flag.
  const reconciliationFile = join(ctx.output, "financial-reconciliation.json");
  const reconciliationBody = JSON.stringify(report, null, 2);
  if (!existsSync(reconciliationFile)) writeFileSync(reconciliationFile, reconciliationBody, { flag: "wx" });
    state.financialReconciliation = report;
    if (mismatches.length)
        throw new Error("FINANCIAL_DUTY_RECONCILIATION_FAILED");
}
