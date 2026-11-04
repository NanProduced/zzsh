import { createHash } from "node:crypto";
import { sourceFinanceObservation } from "./local-source-adapter.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

/** Same frozen physical-source extraction used for the accepted local stored-opening package.
 * This chooses original evidence only; the API's formal proof validator decides completeness. */
export function prepareLocalStoredOpening(balance, { modules, logs, orders, withdraws, distributions, cutoff, inputSha256, sourceExtractSha256 }) {
  const preparation = modules.preparation, proof = modules.proof, canonical = modules.canonical;
  const rawLogs = logs.get(balance.sourceId) ?? [], observations = [], covered = new Map(), bindings = [], supplements = [];
  const root = (sourceKind, sourceEntity, sourceId, beneficiaryRole, time, row) => {
    const at = String(time);
    if (!/^[1-9][0-9]{0,9}$/.test(at) || Number(at) * 1000 > Date.parse(cutoff)) return null;
    const sourceCanonical = canonical(row);
    return { sourceKind, sourceEntity, sourceId: String(sourceId), beneficiaryRole, sourceEventAt: at, sourceCanonical, sourceDigest: sha(sourceCanonical) };
  };
  let missing;
  for (const raw of rawLogs) {
    let parsed, observed;
    try {
      parsed = sourceFinanceObservation("earnings", raw);
      observed = preparation.prepareFrozenFinanceObservation(parsed.kind, parsed.row, { userId: balance.userId, legacyUserId: balance.sourceId, identityDigest: balance.sourceDigest });
    } catch { missing = "SOURCE_LOG_INVALID"; break; }
    observations.push(observed.row);
    const log = JSON.parse(observed.row.rawSource.canonical), options = [];
    if (log.changeType === 1001) {
      const order = orders.get(String(log.sourceId)), distribution = distributions.get(String(log.sourceId));
      if (order && order.sale_user_id === balance.sourceId && order.order_status === "4" && order.pay_is === "1")
        options.push(root("LEGACY_RENTAL_OWNER_INCOME", "la_order", order.id, "OWNER", order.confirm_time, order));
      if (distribution && distribution.user_id === balance.sourceId && distribution.status === "2" && distribution.order_type === "1" && distribution.is_delete === "0")
        options.push(root("LEGACY_DISTRIBUTION_EARNING", "la_distribution_order", distribution.id, distribution.level === "2" ? "RENTER_REFERRAL" : distribution.level === "3" ? "OWNER_REFERRAL" : "UNCONFIRMED", distribution.settle_time, distribution));
    } else if (log.changeType === 1002) {
      const w = withdraws.get(String(log.sourceId));
      if (w && w.user_id === balance.sourceId) options.push(root("LEGACY_WITHDRAWAL", "la_withdraw_apply", w.id, "WALLET_HOLDER", w.create_time, sourceFinanceObservation("withdraws", w).row));
    } else if ([1003, 1004].includes(log.changeType)) {
      const w = withdraws.get(String(log.sourceId));
      if (w && w.user_id === balance.sourceId && w.status === "4") {
        const debit = root("LEGACY_WITHDRAWAL", "la_withdraw_apply", w.id, "WALLET_HOLDER", w.create_time, sourceFinanceObservation("withdraws", w).row);
        if (debit) covered.set(debit.sourceKind + ":" + debit.sourceId, debit);
        options.push(root("LEGACY_WITHDRAWAL_RETURN", "la_log_earnings", raw.id, "WALLET_HOLDER", raw.create_time, log));
      }
    } else if ([1006, 1007].includes(log.changeType) && String(log.sourceId) === "0") {
      options.push(root("LEGACY_ADMIN_LOG", "la_log_earnings", raw.id, "WALLET_HOLDER", raw.create_time, log));
    } else if (log.changeType === 1008) {
      const order = orders.get(String(log.sourceId));
      if (order && order.sale_user_id === balance.sourceId && order.is_settle === "3") options.push(root("LEGACY_DEPOSIT_COMPENSATION", "la_order", order.id, "OWNER", raw.create_time, order));
    } else { missing = "UNSUPPORTED_LOG_SOURCE_KIND"; break; }
    const available = options.filter(Boolean);
    if (!available.length) { missing = "ECONOMIC_ROOT_OR_TIME_UNREAD"; break; }
    if ([1006, 1007, 1008].includes(log.changeType)) {
      const extended = { ...log };
      for (const name of ["source_sn", "remark", "extra"]) if (Object.hasOwn(raw, name)) extended[name] = raw[name];
      const value = canonical(extended);
      supplements.push({ observationId: String(log.id), originalDigest: sha(canonical(log)), extractSha256: sourceExtractSha256, canonical: value, digest: sha(value) });
    }
    let selected = available[0];
    if (available.length > 1) {
      const possible = available.filter(candidate => {
        const binding = { observationId: String(log.id), observationDigest: observed.sourceDigest, sourceKind: candidate.sourceKind, sourceEntity: candidate.sourceEntity, sourceId: candidate.sourceId, beneficiaryRole: candidate.beneficiaryRole, sourceDigest: candidate.sourceDigest };
        try { return proof.validateReviewedOpeningSources({ covered: [candidate], observations: [observed.row], logBindings: [binding], sourceEvidence: [], included: ["la_log_earnings:" + log.id], cutoff }, { userId: balance.userId, legacyUserId: balance.sourceId }); }
        catch { return false; }
      });
      if (possible.length !== 1) { missing = "ECONOMIC_ROOT_AMBIGUOUS"; break; }
      selected = possible[0];
    }
    covered.set(selected.sourceKind + ":" + selected.sourceId, selected);
    bindings.push({ observationId: String(log.id), observationDigest: observed.sourceDigest, sourceKind: selected.sourceKind, sourceEntity: selected.sourceEntity, sourceId: selected.sourceId, beneficiaryRole: selected.beneficiaryRole, sourceDigest: selected.sourceDigest });
  }
  if (missing) return { sourceId: balance.sourceId, userId: balance.userId, state: "REVIEW_REQUIRED", reason: missing };
  try {
    const result = preparation.prepareStoredOpeningCandidate({ candidate: { legacyId: balance.sourceId, targetUserId: balance.userId,
      storedEarningsCents: balance.amounts.earnings, storedMoneyCents: balance.amounts.money,
      sourceDigest: sha(JSON.stringify({ id: balance.source.id, earnings: balance.source.earnings, money: balance.source.money })), admission: "MAPPED_PENDING_BATCH_APPROVAL" },
      subject: { userId: balance.userId, legacyUserId: balance.sourceId, identityDigest: balance.sourceDigest }, source: balance.source, inputSha256, cutoff,
      covered: [...covered.values()], observations, included: observations.map(row => "la_log_earnings:" + row.sourceId), logBindings: bindings, sourceEvidence: supplements });
    return { sourceId: balance.sourceId, userId: balance.userId, ...result };
  } catch (error) { return { sourceId: balance.sourceId, userId: balance.userId, state: "REVIEW_REQUIRED", reason: error.message ?? "SOURCE_PROOF_NOT_CLOSED" }; }
}
