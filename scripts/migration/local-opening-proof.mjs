import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { sourceFinanceObservation, readBoundSourceRows } from "./local-source-adapter.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

/** Retain only the source fields needed to independently check a prepared balance. */
export function capturedOpeningUser(raw, { canonical, legacyOwnerUserId }) {
  if (!raw || typeof raw.id !== "string" || !raw.id) throw new Error("OPENING_CAPTURED_USER_INVALID");
  return { sourceId: raw.id, userId: legacyOwnerUserId("legacy_mysql_restore", "la_user", raw.id),
    sourceDigest: sha(canonical(raw)), hasAmounts: Object.hasOwn(raw, "money") && Object.hasOwn(raw, "earnings"),
    source: { id: raw.id, money: raw.money, earnings: raw.earnings } };
}

/** Compare with captured la_user rather than trusting the prepared balance's own digest. */
export function assertOpeningUserSource(balance, captured, planned, { canonical, financeRead }) {
  if (!balance || !captured || !captured.hasAmounts || !planned || balance.sourceId !== captured.sourceId || planned.sourceId !== captured.sourceId
    || balance.userId !== captured.userId || planned.userId !== captured.userId
    || balance.sourceDigest !== captured.sourceDigest || planned.sourceDigest !== captured.sourceDigest
    || canonical(balance.source) !== canonical(captured.source)
    || balance.amounts?.earnings !== financeRead.sourceYuanToCents(captured.source.earnings)
    || balance.amounts?.money !== financeRead.sourceSignedYuanToCents(captured.source.money))
    throw new Error("OPENING_CAPTURED_BALANCE_MISMATCH");
}

/** Match every prepared candidate to its captured stored balance without summing transaction flows. */
export async function verifyPreparedOpeningUsers({ balances, openings, capturedUsers, plannedUsers, modules, inputSha256, cutoff }) {
  const iterator = openings[Symbol.asyncIterator](), seen = new Set(); let subjects = 0, candidate = 0, reviewRequired = 0, amount = 0n;
  for await (const balance of balances) {
    if (seen.has(balance.sourceId)) throw new Error("OPENING_SOURCE_BALANCE_DUPLICATE");
    seen.add(balance.sourceId);
    const captured = capturedUsers.get(balance.sourceId), planned = plannedUsers.get(balance.sourceId);
    assertOpeningUserSource(balance, captured, planned, modules);
    const next = await iterator.next(), row = next.value;
    if (next.done || row?.sourceId !== balance.sourceId || row.userId !== balance.userId) throw new Error("OPENING_PREPARED_SUBJECT_MISMATCH");
    if (row.state === "CANDIDATE") {
      const input = row.input, proof = input?.proof;
      const sourceDigest = sha(JSON.stringify({ id: captured.source.id, earnings: captured.source.earnings, money: captured.source.money }));
      if (input?.inputSha256 !== inputSha256 || input.cutoff !== cutoff || input.sourceCanonical !== modules.canonical(captured.source)
        || proof?.userId !== captured.userId || proof.source?.sourceSystem !== "legacy_mysql_restore" || proof.source?.sourceEntity !== "la_user"
        || proof.source?.sourceId !== captured.sourceId || proof.source?.identityDigest !== captured.sourceDigest
        || proof.sourceDigest !== sourceDigest || proof.availableCents !== balance.amounts.earnings) throw new Error("OPENING_PREPARED_SOURCE_MISMATCH");
      candidate++; amount += BigInt(proof.availableCents);
    } else if (row.state === "REVIEW_REQUIRED" && typeof row.reason === "string" && row.reason) reviewRequired++;
    else throw new Error("OPENING_PREPARED_STATE_INVALID");
    subjects++;
  }
  if (!(await iterator.next()).done) throw new Error("OPENING_PREPARED_SUBJECT_MISMATCH");
  return { status: "SOURCE_VALUE_AND_SUBJECT_VERIFIED", subjects, candidate, reviewRequired, candidateAvailableCents: amount.toString() };
}

/** Re-read source, planned users, balances and the opening package before target writes. */
export async function verifyOpeningUserCapture({ datasetDir, sourceDir, openingDir, dataset, source, opening, datasetSha256, sourceReceiptSha256, fundsReceiptSha256, modules, privatePath }) {
  const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  if (![datasetSha256,sourceReceiptSha256,fundsReceiptSha256].every(hex)||typeof privatePath!=='function'
    ||dataset?.sourceReceiptSha256!==sourceReceiptSha256||source?.status!=='CAPTURED_READ_ONLY'||source.rollbackConfirmed!==true||source.clientClosed!==true
    ||opening?.status!=='REVIEWED_CANDIDATES_TARGET_NOT_RUN'||opening.datasetSha256!==datasetSha256
    ||opening.sourceUsers?.status!=='SOURCE_VALUE_AND_SUBJECT_VERIFIED'||opening.sourceUsers.sha256!==source.files?.users?.sha256
    ||opening.sourceUsers.matched!==opening.stats?.subjects||opening.sourceCutoff!==new Date(dataset.sourceCutoff).toISOString())
    throw new Error('OPENING_SOURCE_CAPTURE_BINDING_INVALID');
  const expectedInputSha=sha(modules.canonical({datasetSha256,sourceReceiptSha256,supplementReceiptSha256:fundsReceiptSha256,cutoff:opening.sourceCutoff}));
  if(opening.sourceInputSha256!==expectedInputSha)throw new Error('OPENING_SOURCE_CAPTURE_BINDING_INVALID');
  const read=(dir,meta)=>{
    if(!meta||typeof meta.file!=='string'||meta.file!==basename(meta.file))throw new Error('OPENING_SOURCE_CAPTURE_BINDING_INVALID');
    return readBoundSourceRows(privatePath(join(dir,meta.file)),meta);
  };
  const capturedUsers=new Map(),plannedUsers=new Map();
  for await(const raw of read(sourceDir,source.files.users)){
    const user=capturedOpeningUser(raw,modules);if(capturedUsers.has(user.sourceId))throw new Error('OPENING_CAPTURED_USER_DUPLICATE');capturedUsers.set(user.sourceId,user);
  }
  for await(const user of read(datasetDir,dataset.files.users)){
    if(typeof user.sourceId!=='string'||plannedUsers.has(user.sourceId))throw new Error('OPENING_PLANNED_USER_DUPLICATE');
    plannedUsers.set(user.sourceId,{sourceId:user.sourceId,userId:user.userId,sourceDigest:user.sourceDigest});
  }
  const proof=await verifyPreparedOpeningUsers({balances:read(datasetDir,dataset.files['stored-balances']),
    openings:read(openingDir,{file:opening.file,sha256:opening.sha256,rows:opening.stats?.subjects}),capturedUsers,plannedUsers,modules,inputSha256:expectedInputSha,cutoff:opening.sourceCutoff});
  if(proof.subjects!==opening.stats.subjects||proof.candidate!==opening.stats.candidate||proof.reviewRequired!==opening.stats.reviewRequired
    ||proof.candidateAvailableCents!==opening.stats.candidateAvailableCents||proof.subjects!==dataset.domains?.users?.ready)
    throw new Error('OPENING_SOURCE_RECONCILIATION_CHANGED');
  return {...proof,sourceUsersSha256:source.files.users.sha256,openingSha256:opening.sha256};
}

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
