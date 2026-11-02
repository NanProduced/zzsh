import { createHash } from "node:crypto";
/** A later, bounded extract may add facts but cannot rewrite any field in its frozen base row. */
export function assertSourceSupplementFields(original, supplement) {
    if (!original || !supplement || original.id !== supplement.id)
        throw new Error("SUPPLEMENT_SOURCE_ID_CHANGED");
    for (const [field, value] of Object.entries(original))
        if (!Object.hasOwn(supplement, field) || supplement[field] !== value)
            throw new Error("SUPPLEMENT_COMMON_FIELD_DRIFT:" + original.id + ":" + field);
}
const digest = value => createHash("sha256").update(value).digest("hex");
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
export function sourceUserPlan(raw, modules, sourceRef, seenPhones) {
    const canonical = modules.contentHash.canonicalize(raw);
    const row = {
        id: raw.id, mobile: raw.mobile, nickname: raw.nickname,
        is_delete: raw.is_delete, is_disable: raw.is_disable, is_bind_id: raw.is_bind_id, is_high_risk: raw.is_high_risk,
        ageAdult: sourceAdultEvidence(raw.id_card, raw.update_time), createTime: raw.create_time, updateTime: raw.update_time,
        sourceDigest: digest(canonical), evidenceRef: `${sourceRef}:la_user:${raw.id}`,
        legacyPassword: raw.password === null || raw.password === "" ? null : { version: "legacy-md5-v1", md5: raw.password.toLowerCase(), salt: raw.salt ?? "" },
    };
    const plan = modules.planner.planLegacyUser(row, seenPhones);
    if (plan.disposition === "PARAMETER_READY")
        seenPhones.add(plan.writerInput.evidence.mobile);
    else if (typeof plan.claimedMobile === "string")
        seenPhones.add(plan.claimedMobile);
    return plan;
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
        gameCode, sourceStatus: raw.status, sourceDeleted: raw.is_delete === "1", businessNo: raw.no ?? null,
        evidenceRef: `${sourceRef}:la_rental_accounts:${raw.id}`, snapshot: snapshot.snapshot,
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
        account: { legacyId: raw.accounts_id, businessNo: account.businessNo, sourceDigest: account.sourceDigest },
        owner: { userId: owner.userId, legacyId: raw.sale_user_id, businessNo: null, sourceDigest: owner.sourceDigest },
        renter: { userId: renter.userId, legacyId: raw.user_id, businessNo: null, sourceDigest: renter.sourceDigest },
        gameCode: account.gameCode,
    };
}
export function sourceFinanceObservation(domain, raw) {
    const integer = value => { if (!/^-?[0-9]+$/.test(value ?? "") || !Number.isSafeInteger(Number(value)))
        throw new Error("SOURCE_INTEGER_INVALID"); return Number(value); };
    if (domain === "earnings")
        return {
            kind: "HISTORICAL_EARNINGS_LOG", sourceId: raw.id, legacyUserId: raw.user_id,
            row: { id: integer(raw.id), sn: raw.sn, action: integer(raw.action), amount: raw.change_amount, userId: integer(raw.user_id), sourceId: integer(raw.source_id), createdAt: integer(raw.create_time), changeType: integer(raw.change_type), leftAmount: raw.left_amount },
        };
    if (domain === "withdraws")
        return {
            kind: "HISTORICAL_WITHDRAWAL", sourceId: raw.id, legacyUserId: raw.user_id,
            row: { id: integer(raw.id), sn: raw.sn, type: integer(raw.type), money: raw.money, status: integer(raw.status), userId: integer(raw.user_id), batch_no: raw.batch_no, is_delete: integer(raw.is_delete), left_money: raw.left_money, create_time: integer(raw.create_time), handling_fee: raw.handling_fee, payment_time: integer(raw.payment_time) },
        };
    if (domain === "distributionOrders")
        return {
            kind: "HISTORICAL_DISTRIBUTION", sourceId: raw.id, legacyUserId: raw.user_id,
            row: Object.fromEntries(["id", "sn", "user_id", "order_type", "order_id", "earnings", "level", "level_id", "ratio", "status", "settle_time", "is_delete", "create_time", "update_time"].map(name => [name, raw[name] ?? null])),
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
