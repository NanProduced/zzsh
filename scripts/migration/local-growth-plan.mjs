import { createHash } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const itemFields = ["barrett_bullet", "level6_bullet", "awm_bullet", "level6_armor", "level6_helmet", "coffee", "top_insure_card"];
const money = value => {
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,21})\.\d{2}$/.test(value)) throw Error("SOURCE_AMOUNT_UNPROVEN");
    return BigInt(value.replace(".", ""));
};
const fail = reason => { throw Error(reason); };

/** Final order fields, never prepaid material, current prices, owner earnings or payment-log sums. */
export function legacyCompletedComponents(raw) {
    if (raw.order_status !== "4" || raw.pay_is !== "1" || !/^[1-9]\d*$/.test(raw.confirm_time ?? "")) fail("NOT_CONFIRMED_COMPLETED");
    if (raw.compensation !== null && money(raw.compensation) !== 0n) fail("COMPENSATION_CLASSIFICATION_REQUIRED");
    if (raw.is_settle === "3") fail("CONFISCATED_DEPOSIT_CLASSIFICATION_REQUIRED");
    if (money(raw.detain_money) !== 0n) fail("DETAINED_AMOUNT_CLASSIFICATION_REQUIRED");
    if (typeof raw.return_order_money === "string" && raw.return_order_money.startsWith("-")) fail("NEGATIVE_ORIGINAL_RETURN_REQUIRES_ADDITIONAL_PAYMENT_PROOF");
    const resource = money(raw.pay_money) - money(raw.return_order_money);
    let material = 0n, basis = "FINAL_EXPLICIT_EXPEND_MONEY";
    if (raw.expend_money !== null) material = money(raw.expend_money);
    else {
        basis = "FINAL_QUANTITIES_AND_FROZEN_ORDER_PRICES";
        for (const field of itemFields) {
            const quantity = raw[field + "_num"];
            if (quantity === null) continue; // Old ExpendMoneyUtil explicitly ignores NULL quantities on finalized orders.
            if (typeof quantity !== "string" || !/^(0|[1-9]\d{0,9})$/.test(quantity)) fail("FINAL_QUANTITY_UNPROVEN");
            if (quantity === "0") continue;
            const price = money(raw[field + "_price"]);
            if (price <= 0n) fail("HISTORICAL_FALLBACK_PRICE_UNPROVEN");
            material += BigInt(quantity) * price;
        }
    }
    if (resource < material) fail("COMPONENT_TOTAL_CONFLICT");
    // Old final pricing records no independent minimum component; keep its final rental contract intact.
    return { rentalCents: (resource - material).toString(), materialCents: material.toString(), minimumBillingCents: "0", minimumAgreementRef: null, basis };
}

/** Original full-source cohort closes every renter source; no-order cohort members get reviewed empty coverage. */
export function buildLocalGrowthPlan({ modules, cohort, orders, targets, payments, refunds, refundLogs, cutoff, lineage, oldRuleEvidenceRef }) {
    const canonical = modules.canonicalize, proof = value => { const canonicalText = canonical(value); return { canonical: canonicalText, digest: sha(canonicalText) }; };
    const targetById = new Map(targets.map(row => [row.legacyId, row])), cohortById = new Map(cohort.map(row => [row.sourceId, row.userId]));
    if (cohortById.size !== cohort.length || targetById.size !== orders.length || cohort.length !== new Set(cohort.map(row => row.userId)).size) fail("GROWTH_SOURCE_DENOMINATOR_CONFLICT");
    const index = (rows, key) => { const result = new Map(); for (const row of rows) { const k = key(row); const list = result.get(k) ?? []; list.push(row); result.set(k, list); } return result; };
    const pays = index(payments.filter(row => row.order_type === "1" && row.pay_is === "1"), row => row.order_id);
    const refs = index(refunds.filter(row => row.order_type === "order"), row => row.order_id), logs = index(refundLogs, row => row.record_id);
    const grouped = new Map(cohort.map(row => [row.userId, []])), audit = [], seen = new Set();
    const review = { schema: "local-growth-reviewed-source.v1", cutoff, sourceLineage: lineage, oldRuleEvidenceRef, cohort: cohort.map(row => [row.sourceId, row.userId]).sort(),
        sourceOrderKeys: orders.map(row => "legacy_mysql_restore:la_order:" + row.id).sort(),
        rules: ["FINAL_CONFIRMED_ORDER_COMPONENTS_ONLY", "EXPLICIT_FINAL_MATERIAL_OR_FROZEN_QUANTITY_PRICE", "OLD_FINAL_NULL_QUANTITY_UTILITY_SEMANTICS", "TYPED_FULL_REFUND_VOID_BEFORE_CONFIRM", "PENDING_IS_NOT_SETTLED", "REFUND_CONFLICT_IS_UNKNOWN", "NO_CURRENT_PRICE_OR_PREPAYMENT", "NO_SEPARATE_UNBOOKED_MINIMUM", "NO_DEPOSIT_COMPENSATION_OR_CONFISCATION"] };
    const reviewProof = proof(review);
    for (const raw of orders) {
        if (seen.has(raw.id)) fail("DUPLICATE_SOURCE_ORDER"); seen.add(raw.id);
        const target = targetById.get(raw.id), userId = cohortById.get(raw.user_id);
        if (!target || !userId || userId !== target.renterUserId || cohortById.get(raw.sale_user_id) !== target.ownerUserId) fail("GROWTH_SOURCE_TARGET_MISSING");
        const parent = target.sourceSnapshot, binding = { ...target }; delete binding.sourceSnapshot;
        if (sha(canonical(parent)) !== target.sourceDigest || Object.keys(parent).some(key => parent[key] !== raw[key])) fail("GROWTH_PARENT_SOURCE_DRIFT");
        if (target.legacyAccountId !== raw.accounts_id || target.legacyOwnerId !== raw.sale_user_id || target.legacyRenterId !== raw.user_id || target.sourceOrderStatus !== Number(raw.order_status) || target.sourcePayStatus !== Number(raw.pay_is)) fail("GROWTH_BINDING_DRIFT");
        const sourceRecord = proof(raw), sourceKey = "legacy_mysql_restore:la_order:" + raw.id;
        const common = { parentSourceDigest: target.sourceDigest, basisDigest: sourceRecord.digest, legacyOrderId: raw.id, subjectUserId: userId, cutoff, oldRuleEvidenceRef };
        const orderRefunds = refs.get(raw.id) ?? [];
        const refundReviewRefs = [reviewProof.digest, ...orderRefunds.flatMap(row => [proof(row).digest, ...(logs.get(row.id) ?? []).map(log => proof(log).digest)])];
        let kind = "LEGACY_COMPLETED", components, reason = null, componentBasis = null;
        if (raw.pay_is === "0") components = proof({ schema: "legacy-consumption-exclusion.v1", classification: "NOT_PAID", ...common });
        else if (["2", "3", "6", "7", "8", "9"].includes(raw.order_status)) {
            kind = "LEGACY_PENDING_UNSETTLED";
            components = proof({ schema: "legacy-consumption-exclusion.v1", classification: "PAID_NOT_EFFECTIVELY_SETTLED", ...common });
        } else if (raw.order_status === "5") {
            kind = "LEGACY_CANCELLED_FULL_REFUND";
            const selectedPays = pays.get(raw.id) ?? [], selectedLogs = orderRefunds.flatMap(row => logs.get(row.id) ?? []);
            components = proof({ schema: "legacy-consumption-exclusion.v1", classification: "PAID_CANCELLED_FULL_REFUND", ...common,
                payment: { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_pay_order", extractSha256: lineage.paymentFileSha256, records: selectedPays.map(proof) },
                refundRecord: { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_refund_record", extractSha256: lineage.refundFileSha256, records: orderRefunds.map(proof) },
                refundLog: { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_refund_log", extractSha256: lineage.refundLogFileSha256, records: selectedLogs.map(proof) } });
            refundReviewRefs.push(components.digest);
        } else {
            try {
                if (orderRefunds.length) fail("COMPLETED_ORDER_REFUND_ECONOMIC_REVIEW_REQUIRED");
                const split = legacyCompletedComponents(raw); componentBasis = split.basis;
                components = proof({ schema: "legacy-consumption-components.v1", ...common, ...split });
            } catch (error) {
                reason = error.message; components = proof({ schema: "legacy-consumption-unresolved.v1", ...common, reason });
            }
        }
        const input = { binding, subjectUserId: userId, recordedAt: cutoff, origin: { kind, parentSourceSnapshot: parent, sourceRecord, components } };
        grouped.get(userId).push({ input, componentDigest: components.digest, sourceKey, refundReviewRefs, reason, componentBasis });
    }
    const packages = [], summary = { users: cohort.length, orders: orders.length, complete: 0, pending: 0, knownZero: 0, noRenterOrders: 0, positive: 0, contributions: 0, orderKnowledge: {}, reasons: {}, tiers: {}, lifetimeCents: "0", rollingCents: "0", windowStart: modules.growthWindowStartAt(cutoff) };
    let lifetime = 0n, rolling = 0n;
    for (const [userId, entries] of grouped) {
        const expectedSourceKeys = entries.map(row => row.sourceKey).sort();
        const receipt = { subjectUserId: userId, cutoff, fromExclusive: null, sourceExtractSha256: lineage.captureReceiptSha256, sourceSetSha256: sha(canonical({ subjectUserId: userId, cutoff, fromExclusive: null, expectedSourceKeys })), expectedSourceKeys,
            refundReviewEvidenceRefs: [...new Set([reviewProof.digest, ...entries.flatMap(row => row.refundReviewRefs)])].sort() };
        const business = { schema: "legacy-growth-maintenance-package-v1", reason: "本地Nov3完整旧源租赁消费按正式90天成长合同承接；不产生资金分录或旧等级礼遇", source: { receipt, inputs: entries.map(row => row.input), corrections: [], admitted: { receiptDigests: [sha(canonical(receipt))], componentDigests: entries.map(row => row.componentDigest), correctionDigests: [] }, gameIdBySettlementId: Object.fromEntries(entries.map(row => [row.sourceKey, row.input.binding.gameId])) } };
        const bytes = JSON.stringify(business) + "\n", businessSha256 = sha(bytes), prepared = modules.prepareLegacyGrowthBackfill({ ...business.source, packageDigest: businessSha256 });
        if (!prepared.ok) fail("GROWTH_PREPARATION_REJECTED:" + prepared.reason);
        const projected = entries.map(row => ({ row, result: modules.projectLegacyGrowthConsumption(row.input, new Set(business.source.admitted.componentDigests), receipt) }));
        for (const { row, result } of projected) {
            summary.orderKnowledge[result.knowledge] = (summary.orderKnowledge[result.knowledge] ?? 0) + 1;
            const reason = row.reason ?? result.reason;
            if (reason) summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
            if (result.knowledge === "UNKNOWN") audit.push({ userId, sourceKey: row.sourceKey, reason, projectionReason: result.reason, sourceDigest: row.input.binding.sourceDigest, sourceRecordDigest: row.input.origin.sourceRecord.digest });
        }
        let projection = null;
        if (prepared.coverageState === "COMPLETE") {
            summary.complete++;
            projection = modules.replayGrowthProjection({ userId, asOf: cutoff, contributions: prepared.rows.map(row => row.contribution) });
            if (projection.lifetimeCents === "0") summary.knownZero++; else summary.positive++;
            if (!entries.length) summary.noRenterOrders++;
            summary.tiers[projection.effectiveTier] = (summary.tiers[projection.effectiveTier] ?? 0) + 1;
            lifetime += BigInt(projection.lifetimeCents); rolling += BigInt(projection.rollingCents);
        } else summary.pending++;
        summary.contributions += prepared.rows.length;
        packages.push({ userId, bytes, sha256: businessSha256, executionKey: "nov3-growth-" + businessSha256.slice(0, 48), prepared, projection });
    }
    summary.lifetimeCents = lifetime.toString(); summary.rollingCents = rolling.toString();
    return { packages, review, reviewDigest: reviewProof.digest, summary, unknownSources: audit };
}
