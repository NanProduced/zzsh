import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
export function parseSourceCaptureLine(line) {
    return JSON.parse(/^[0-9A-F]+$/.test(line) ? Buffer.from(line, "hex").toString("utf8") : line);
}
export const sourceJsonLine = row => JSON.stringify(row).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029") + "\n";
/** Source text can contain U+2028/U+2029; readline treats those as record separators. JSONL uses LF. */
export async function* readSourceRows(file) {
    const input = createReadStream(file, { encoding: "utf8" }); let pending = "";
    try {
        for await (const chunk of input) {
            pending += chunk; let at;
            while ((at = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, at); pending = pending.slice(at + 1);
                if (line.trim()) yield JSON.parse(line);
            }
        }
        if (pending.trim()) yield JSON.parse(pending);
    } finally { input.destroy(); }
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
    return { packets, summary: { ...full.summary, selectedSubjects: prior.size, selectedPackets: packets.length, policy: null, automaticEligibilityEnabled: false, childCounts: "FULL_SOURCE_PROOF_NOT_CLOSED_ON_PARTIAL_TARGET" } };
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

/** Retain only the digest and requested original field in memory during independent readback. */
export function legacyAccountCaptureProof(raw, canonicalize) {
    return { sourceId: raw.id, sourceDigest: digest(canonicalize(raw)), metricSourceFields:
        Object.fromEntries(["is_full_payout"].filter(name => Object.hasOwn(raw, name)).map(name => [name, raw[name]])) };
}
export function matchesLegacyAccountCapture(proof, planned, canonicalize) {
    return Boolean(proof && proof.sourceId === planned.sourceId && planned.metricSourceFields !== undefined
        && proof.sourceDigest === planned.sourceDigest && canonicalize(proof.metricSourceFields) === canonicalize(planned.metricSourceFields));
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
