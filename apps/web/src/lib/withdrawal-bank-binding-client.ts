import { WithdrawalRequestError, assertCurrent, badWithdrawal, id, key, record, recoveryStorage, revision, text, time, underWithdrawalLock, withdrawalRequest, type WithdrawalWriteOptions } from "./withdrawal-client-core.ts";

export type BankBinding = { id: string; revision: string; cardMask: string; holderNameMask: string; updatedAt: string; ownershipVerification: "NOT_VERIFIED" };
export type BankBindingRead = { contractVersion: "withdrawal-bank-binding.v1"; integration: "INTEGRATED" | "NOT_INTEGRATED"; binding: BankBinding | null; expectedRevision: string | null };
export type BankBindingInput = { name: string; cardNo: string; expectedRevision: string };
export type PendingBankBinding = { userId: string; key: string; expectedRevision: string };
export type BankBindingWriteOptions = WithdrawalWriteOptions & { resume?: boolean; expectedPending?: PendingBankBinding };
export type BankBindingReceipt = { integration: "INTEGRATED" | "NOT_INTEGRATED"; knowledge: "KNOWN" | "UNKNOWN"; receipt: BankBindingRead | null };
const prefix = "zzsh.bank-binding-recovery.v1:";

export function parseBankBinding(value: unknown): BankBindingRead {
  const b = record(value);
  if (b.contractVersion !== "withdrawal-bank-binding.v1" || !["INTEGRATED", "NOT_INTEGRATED"].includes(String(b.integration))) throw badWithdrawal();
  if (b.integration === "NOT_INTEGRATED") {
    if (b.binding !== null || b.expectedRevision !== null) throw badWithdrawal();
    return { contractVersion: b.contractVersion, integration: "NOT_INTEGRATED", binding: null, expectedRevision: null };
  }
  const expectedRevision = revision(b.expectedRevision);
  if (b.binding === null) {
    if (expectedRevision !== "0") throw badWithdrawal();
    return { contractVersion: b.contractVersion, integration: "INTEGRATED", binding: null, expectedRevision };
  }
  const row = record(b.binding), cardMask = text(row.cardMask, 32), holderNameMask = text(row.holderNameMask, 128);
  const rev = revision(row.revision);
  if (rev === "0" || rev !== expectedRevision || !/^\*{4} \*{4} \d{4}$/.test(cardMask) || !/^.[*]{2}$/u.test(holderNameMask) || row.ownershipVerification !== "NOT_VERIFIED") throw badWithdrawal();
  return { contractVersion: b.contractVersion, integration: "INTEGRATED", expectedRevision, binding: { id: id(row.id), revision: rev, cardMask, holderNameMask, updatedAt: time(row.updatedAt), ownershipVerification: "NOT_VERIFIED" } };
}
export function parseBankBindingReceipt(value: unknown): BankBindingReceipt {
  const b = record(value);
  if (!["INTEGRATED", "NOT_INTEGRATED"].includes(String(b.integration)) || !["KNOWN", "UNKNOWN"].includes(String(b.knowledge)) || (b.knowledge === "KNOWN") !== (b.receipt !== null)) throw badWithdrawal();
  if (b.integration === "NOT_INTEGRATED" && b.knowledge !== "UNKNOWN") throw badWithdrawal();
  const receipt = b.receipt === null ? null : parseBankBinding(b.receipt);
  if (receipt && (receipt.integration !== "INTEGRATED" || !receipt.binding)) throw badWithdrawal();
  return { integration: b.integration as BankBindingReceipt["integration"], knowledge: b.knowledge as BankBindingReceipt["knowledge"], receipt };
}
export function validateBankBindingInput(value: BankBindingInput): BankBindingInput {
  if (typeof value.name !== "string" || typeof value.cardNo !== "string" || value.name.length > 128 || value.cardNo.length > 32 || /[\p{Cs}\p{Cc}]/u.test(value.name)) throw new WithdrawalRequestError(400, "INVALID_ARGUMENT");
  const name = value.name.trim(), cardNo = value.cardNo.replaceAll(" ", "");
  if (!name || new TextEncoder().encode(name).length > 128 || !/^[0-9]{15,19}$/.test(cardNo)) throw new WithdrawalRequestError(400, "INVALID_ARGUMENT");
  let expectedRevision: string;
  try { expectedRevision = revision(value.expectedRevision); } catch { throw new WithdrawalRequestError(400, "INVALID_ARGUMENT"); }
  return { name, cardNo, expectedRevision };
}
export async function readBankBinding(userId: string, signal?: AbortSignal): Promise<BankBindingRead> { return parseBankBinding(await withdrawalRequest("withdrawal-bank-binding", "", { expectedUserId: userId, signal })); }
export function pendingBankBinding(userId: string): PendingBankBinding | null {
  try {
    const raw = recoveryStorage().getItem(prefix + id(userId));
    if (raw === null) return null;
    const p = record(JSON.parse(raw));
    if (Object.keys(p).sort().join() !== "expectedRevision,key,userId" || p.userId !== userId) throw badWithdrawal();
    return { userId, key: key(p.key), expectedRevision: revision(p.expectedRevision) };
  } catch { throw new WithdrawalRequestError(0, "RECOVERY_STORAGE_UNAVAILABLE"); }
}
function storePending(p: PendingBankBinding) {
  try { const storage = recoveryStorage(), raw = JSON.stringify({ userId: p.userId, key: p.key, expectedRevision: p.expectedRevision }); storage.setItem(prefix + id(p.userId), raw); if (storage.getItem(prefix + p.userId) !== raw) throw Error(); }
  catch { throw new WithdrawalRequestError(0, "RECOVERY_STORAGE_UNAVAILABLE"); }
}
function clearPending(p: PendingBankBinding) {
  const current = pendingBankBinding(p.userId);
  if (current?.key === p.key && current.expectedRevision === p.expectedRevision) recoveryStorage().removeItem(prefix + p.userId);
}
function samePending(left: PendingBankBinding | null, right: PendingBankBinding) {
  return left?.userId === right.userId && left.key === right.key && left.expectedRevision === right.expectedRevision;
}
function selectedPending(value: PendingBankBinding | undefined, userId: string): PendingBankBinding | null {
  if (!value) return null;
  try {
    if (value.userId !== userId) throw Error();
    return { userId: id(value.userId), key: key(value.key), expectedRevision: revision(value.expectedRevision) };
  } catch { throw new WithdrawalRequestError(409, "RECOVERY_CONTEXT_CHANGED"); }
}
export async function saveBankBinding(userId: string, input: BankBindingInput, options: BankBindingWriteOptions = {}): Promise<BankBindingRead> {
  const body = validateBankBindingInput(input), current = options.isCurrent ?? (() => true);
  const selected = selectedPending(options.expectedPending, userId);
  return underWithdrawalLock("bank-binding", userId, async () => {
    assertCurrent(current, options.signal);
    const prior = pendingBankBinding(userId);
    if (options.resume) {
      if (!prior) throw new WithdrawalRequestError(409, "NO_PENDING_REQUEST");
      if (!selected || !samePending(prior, selected) || selected.expectedRevision !== body.expectedRevision) throw new WithdrawalRequestError(409, "RECOVERY_CONTEXT_CHANGED");
    } else if (selected || prior) throw new WithdrawalRequestError(409, "PENDING_REQUEST_EXISTS");
    const pending = prior ?? { userId, key: crypto.randomUUID(), expectedRevision: body.expectedRevision };
    if (!prior) storePending(pending);
    try {
      const result = parseBankBinding(await withdrawalRequest("withdrawal-bank-binding", "", { expectedUserId: userId, method: "POST", body, key: pending.key, signal: options.signal }));
      assertCurrent(current, options.signal);
      if (!result.binding || BigInt(result.binding.revision) !== BigInt(body.expectedRevision) + 1n) throw badWithdrawal();
      if (options.resume && !samePending(pendingBankBinding(userId), pending)) throw new WithdrawalRequestError(409, "RECOVERY_CONTEXT_CHANGED");
      clearPending(pending);
      try { const latest = await readBankBinding(userId, options.signal); assertCurrent(current, options.signal); return latest; }
      catch (error) {
        if (!current() || options.signal?.aborted) throw error;
        throw new WithdrawalRequestError(error instanceof WithdrawalRequestError ? error.status : 0, "BANK_BINDING_CURRENT_READ_UNAVAILABLE", error instanceof WithdrawalRequestError ? error.requestId : undefined);
      }
    } catch (error) {
      // A first definite rejection can end that attempt; an older unresolved key cannot be discarded by a later rejection.
      if (!prior && error instanceof WithdrawalRequestError && error.status >= 400 && error.status < 500 && error.code !== "IDENTITY_CHANGED") clearPending(pending);
      throw error;
    }
  });
}
export async function recoverBankBinding(userId: string, options: BankBindingWriteOptions = {}): Promise<BankBindingReceipt & { current: BankBindingRead | null }> {
  const current = options.isCurrent ?? (() => true);
  assertCurrent(current, options.signal);
  const pending = selectedPending(options.expectedPending, userId) ?? pendingBankBinding(userId);
  if (!pending) throw new WithdrawalRequestError(409, "NO_PENDING_REQUEST");
  const result = parseBankBindingReceipt(await withdrawalRequest("withdrawal-bank-binding", `/receipt?key=${encodeURIComponent(pending.key)}`, { expectedUserId: userId, signal: options.signal }));
  assertCurrent(current, options.signal);
  if (result.knowledge === "UNKNOWN") return { ...result, current: null };
  if (!result.receipt?.binding || BigInt(result.receipt.binding.revision) !== BigInt(pending.expectedRevision) + 1n) throw badWithdrawal();
  // An explicit original-key read remains useful if local storage is unavailable; it never clears a different marker.
  try { clearPending(pending); } catch { /* The UI separately keeps its storage-unavailable write block. */ }
  try { const latest = await readBankBinding(userId, options.signal); assertCurrent(current, options.signal); return { ...result, current: latest }; }
  catch (error) { if (!current() || options.signal?.aborted) throw error; return { ...result, current: null }; }
}
