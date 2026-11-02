import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const sha = value => createHash("sha256").update(value).digest("hex");
const micros = value => value.replace(/\.([0-9]{3})Z$/, (_, digits) => "." + digits + "000Z");
async function arrayOf(ctx, name) { const result = []; const file = ctx.domainFile(name); if (file)
    for await (const row of ctx.readRows(file))
        result.push(row); return result; }
function freezePhase(ctx, name, rows) { ctx.state.generatedPhases ??= {}; const dir = join(ctx.output, "phases"); if (!existsSync(dir))
    mkdirSync(dir); const file = join(dir, name + ".json"); const previous = ctx.state.generatedPhases[name]; if (previous) {
    const bytes = readFileSync(file);
    if (sha(bytes) !== previous.sha256)
        throw new Error("PREPARED_PHASE_SHA_CHANGED");
    return JSON.parse(bytes);
} const bytes = JSON.stringify(rows); writeFileSync(file, bytes, { flag: "wx" }); ctx.state.generatedPhases[name] = { file, sha256: sha(bytes), rows: rows.length }; ctx.save(); return rows; }
async function facts(ctx, legacyIds) { const { client, actor } = ctx; const parents = (await client.query(`SELECT legacy_id AS "legacyId",id AS "parentOrderId",source_digest AS "sourceDigest",binding_digest AS "bindingDigest",source_snapshot AS "sourceSnapshot",to_char(source_completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceCompletedAt",owner_user_id AS "ownerUserId",renter_user_id AS "renterUserId",account_id AS "accountId",deposit_amount_cents::text AS "depositAmountCents" FROM zzsh_order.legacy_order_read_snapshot WHERE legacy_id=ANY($1::text[])`, [legacyIds])).rows; const ids = parents.map(p => p.parentOrderId); const duties = (await client.query(`SELECT id,order_id AS "orderId",kind,source_record_id AS "sourceRecordId",amount_cents::text AS "amountCents",status,counterparty_user_id AS "counterpartyUserId",settled_by AS "settledBy",admission_id AS "admissionId" FROM zzsh_order.legacy_order_duty WHERE order_id=ANY($1::text[])`, [ids])).rows; const admissions = (await client.query(`SELECT id,duty_id AS "dutyId",order_id AS "orderId",admission_digest AS "admissionDigest" FROM zzsh_order.legacy_order_duty_admission WHERE order_id=ANY($1::text[])`, [ids])).rows; const heads = (await client.query(`SELECT order_id AS "orderId",revision::text FROM zzsh_order.legacy_continuation_version WHERE order_id=ANY($1::text[]) AND superseded_at IS NULL`, [ids])).rows; const operations = ["order.legacy.liability.import", "order.legacy.commission.completed-import", "order.legacy.continuation.import"]; const scopes = ids.flatMap(id => operations.map(op => JSON.stringify(["admin", actor.userId, op, id]))); const receipts = (await client.query('SELECT scope_key,key,request_fingerprint AS fingerprint,response_status AS "responseStatus" FROM zzsh_supply.idempotency_record WHERE scope_key=ANY($1::text[])', [scopes])).rows.map(row => { const [realm, principalId, operation, resourceId] = JSON.parse(row.scope_key); return { principalId, operation, resourceId, key: row.key, fingerprint: row.fingerprint, responseStatus: row.responseStatus }; }); const current = parents.map(parent => ({ orderId: parent.parentOrderId, readRef: "core-dataset:" + ctx.state.binding.oid + ":" + parent.parentOrderId, headRevision: heads.find(h => h.orderId === parent.parentOrderId)?.revision ?? null, depositAmountCents: parent.depositAmountCents, duties: duties.filter(d => d.orderId === parent.parentOrderId), admissions: admissions.filter(a => a.orderId === parent.parentOrderId), idempotency: { principalId: actor.userId, records: receipts.filter(r => r.resourceId === parent.parentOrderId) } })); return { parents, current }; }
export async function applyFinancialDomains(ctx) {
    const { client, actor, mod, manifest, state } = ctx, preparation = mod("finance/legacy-finance-source-preparation"), canonical = mod("supply/content-hash").canonicalize;
    const resource = { host: "127.0.0.1", port: 55432, database: "zzsh_test_regression", oid: Number(state.binding.oid), owner: state.resource.owner, marker: state.resource.marker, role: state.resource.role, roleOid: Number(state.resource.role_oid) };
    const reviewCommon = { ref: "CORE_FULL_LEGACY_" + state.binding.oid, attempt: "dataset-" + state.binding.datasetSha256.slice(0, 16), actor: { userId: actor.userId, sessionId: actor.sessionId }, resource, notBefore: state.startedAt, expiresAt: new Date(Date.parse(state.startedAt) + 12 * 3600000).toISOString(), cutoff: manifest.sourceCutoff };
    let history = state.generatedPhases?.financeHistory ? freezePhase(ctx, "financeHistory", []) : null;
    if (!history) {
        const groups = new Map();
        for (const row of await arrayOf(ctx, "finance-observations")) {
            const key = row.userId + ":" + row.kind;
            if (!groups.has(key))
                groups.set(key, { userId: row.userId, legacyUserId: row.legacyUserId, identityDigest: row.identityDigest, sourceKind: row.kind, domain: row.domain, rows: [] });
            groups.get(key).rows.push(row.row);
        }
        history = [];
        for (const group of groups.values()) {
            const inputSha256 = manifest.files["finance-observations"].sha256;
            try {
                const input = preparation.prepareFrozenFinanceHistory({ subject: { userId: group.userId, legacyUserId: group.legacyUserId, identityDigest: group.identityDigest }, sourceKind: group.sourceKind, inputSha256, cutoff: manifest.sourceCutoff, sourceCount: group.rows.length, rows: group.rows, isolated: [] });
                history.push({ sourceId: group.legacyUserId + ":" + group.sourceKind, input });
            }
            catch (error) {
                state.quarantine.push({ domain: "financeHistory", sourceId: group.legacyUserId, sourceKind: group.sourceKind, code: error.code ?? "HISTORY_PREPARATION_REFUSED" });
            }
        }
        history = freezePhase(ctx, "financeHistory", history);
    }
    await ctx.runItems("financeHistory", history, async (row) => { const input = row.input; const review = { ...reviewCommon, inputSha256: input.coverage.inputSha256, bodyDigest: sha(canonical(input)), userId: input.coverage.userId, sourceKind: input.coverage.sourceKind }; const module = mod("finance/personal-finance-observation-maintenance"); const scope = await module.bindReviewedFinanceObservationAdmission(client, actor, review); return module.importReviewedFinanceObservations(client, actor, input, scope); }, 20);
    const continuations = await arrayOf(ctx, "continuations");
    let continuationRows = state.generatedPhases?.continuationEvidence ? freezePhase(ctx, "continuationEvidence", []) : null;
    if (!continuationRows) {
        const target = await facts(ctx, continuations.map(row => row.sourceId));
        const byLegacy = new Map(target.parents.map(p => [p.legacyId, p]));
        continuationRows = [];
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
            continuationRows.push({ sourceId: row.sourceId, body: { orderId: parent.parentOrderId, sourceDigest: parent.sourceDigest, sourceAsOf: micros(manifest.sourceCutoff), evidenceRef: manifest.sourceRef + ":continuation:" + row.sourceId, source: row.source, commissionEvidence: row.commissionEvidence } });
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
        const assembly = preparation.assembleLegacyCompletedCommissionBatch({ batchId: "full-commissions-" + state.binding.oid, cutoff: micros(manifest.sourceCutoff), parents: target.parents, current: target.current, verifiedBeneficiaries: identities, rows: pending.map(row => ({ sourceRecord: row.sourceRecord, parentLegacyOrderId: row.parentLegacyOrderId, mappedOrderId: parents.get(row.parentLegacyOrderId)?.parentOrderId ?? null, bucket: parents.get(row.parentLegacyOrderId)?.sourceSnapshot?.order_status === '4' ? "COMPLETED_PARENT" : "INFLIGHT_PARENT", evidenceRef: manifest.sourceRef + ":commission:" + row.sourceRecord.id })) });
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
    const wanted = [...liabilityRows, ...completedRows].filter(row => row.effect);
    const ids = wanted.map(row => row.effect.dutyId);
    const actual = (await client.query("SELECT id,amount_cents::text AS amount,status,counterparty_user_id AS beneficiary,kind,source_record_id AS source_id,settled_by AS settled_by FROM zzsh_order.legacy_order_duty WHERE id=ANY($1::text[])", [ids])).rows;
    const byId = new Map(actual.map(row => [row.id, row]));
    const mismatches = [];
    for (const row of wanted) {
        const expected = row.effect, found = byId.get(expected.dutyId);
        if (!found || found.amount !== expected.amountCents || found.beneficiary !== expected.beneficiaryUserId || found.kind !== expected.kind || found.status !== expected.status || found.settled_by !== expected.settledBy)
            mismatches.push({ dutyId: expected.dutyId, reason: "EXACT_DUTY_FACT_DIFFERED" });
    }
    const native = (await client.query("SELECT (SELECT count(*)::int FROM zzsh_order.rental_order) native_orders,(SELECT count(*)::int FROM zzsh_order.payment_confirmation) native_payments,(SELECT count(*)::int FROM zzsh_order.settlement_posting) native_postings,(SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry) native_ledger")).rows[0];
    const report = { expectedDuties: wanted.length, matched: actual.length, mismatches, native, storedOpening: "NOT_IMPORTED_WITHOUT_REVIEWED_ECONOMIC_PROOF", financialHistory: "OBSERVATION_ONLY_NO_CHANNEL_OR_WALLET_POSTING", sourceRawRetained: true };
    writeFileSync(join(ctx.output, "financial-reconciliation.json"), JSON.stringify(report, null, 2), { flag: "wx" });
    state.financialReconciliation = report;
    if (mismatches.length)
        throw new Error("FINANCIAL_DUTY_RECONCILIATION_FAILED");
}
