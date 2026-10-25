import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertActiveInTransaction, assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { ensureOnlyFields, fingerprintRequest, invalid, conflict, notFound, withIdempotency } from "../supply/supply-util";

export type WithdrawalBankBindingOptions = Readonly<{ database: string; runtimeUser: string;
  protection?: Readonly<{ currentKeyVersion: string; keyFor: (version: string) => Uint8Array }> }>;
type Actor = UserContext & { requestId: string };
type Details = { name: string; cardNo: string };
type Row = { id: string; user_id: string; revision: string; card_mask: string; holder_mask: string; updated_at: string; sealed_details?: string };
const TABLE = "zzsh_order.withdrawal_bank_binding", OP = "withdrawal.bank-binding.save.v1";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, BANK_ID = /^bank_[a-f0-9]{32}$/, REVISION = /^(0|[1-9][0-9]{0,18})$/;
const COLUMNS = `id,user_id,revision::text,card_mask,holder_mask,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;
const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);
const scopeKey = (userId: string) => JSON.stringify(["user", userId, OP, null]);
function details(body: Record<string, unknown>): Details {
  if (typeof body.name !== "string" || typeof body.cardNo !== "string" || body.name.length > 128 || body.cardNo.length > 32
    || /[\p{Cs}\p{Cc}]/u.test(body.name) || /\p{Cs}/u.test(body.cardNo)) throw invalid("Invalid bank binding fields");
  const name = body.name.trim(), cardNo = body.cardNo.replaceAll(" ", "");
  if (!name || Buffer.byteLength(name) > 128 || !/^[0-9]{15,19}$/.test(cardNo)) throw invalid("Invalid bank binding fields");
  return { name, cardNo };
}
function revision(value: unknown): string {
  if (typeof value !== "string" || !REVISION.test(value) || BigInt(value) > 9223372036854775807n) throw invalid("Invalid bank binding revision");
  return value;
}
const masks = (value: Details) => ({ card_mask: "**** **** " + value.cardNo.slice(-4), holder_mask: [...value.name][0] + "**" });
function summary(row: Row) {
  if (typeof row.id !== "string" || !BANK_ID.test(row.id) || typeof row.revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.revision)
    || BigInt(row.revision) > 9223372036854775807n || typeof row.card_mask !== "string" || !/^\*{4} \*{4} [0-9]{4}$/.test(row.card_mask)
    || typeof row.holder_mask !== "string"
    || [...row.holder_mask].length !== 3 || !row.holder_mask.endsWith("**") || /[\p{Cs}\p{Cc}]/u.test(row.holder_mask)
    || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) throw unavailable("BANK_BINDING_RECORD_INVALID");
  return { id: row.id, revision: row.revision, cardMask: row.card_mask, holderNameMask: row.holder_mask, updatedAt: row.updated_at,
    ownershipVerification: "NOT_VERIFIED" as const };
}
const projection = (row: Row | undefined) => ({ contractVersion: "withdrawal-bank-binding.v1" as const, integration: "INTEGRATED" as const,
  binding: row ? summary(row) : null, expectedRevision: row?.revision ?? "0" });
function receipt(value: any, userId: string) {
  if (!value || value.contractVersion !== "withdrawal-bank-binding.v1" || value.integration !== "INTEGRATED" || !value.binding
    || value.expectedRevision !== value.binding.revision) throw unavailable("BANK_BINDING_RECEIPT_INVALID");
  return projection({ id: value.binding.id, user_id: userId, revision: value.binding.revision, card_mask: value.binding.cardMask,
    holder_mask: value.binding.holderNameMask, updated_at: value.binding.updatedAt });
}
async function ready(c: PoolClient, o: WithdrawalBankBindingOptions) {
  if (![o.database, o.runtimeUser].every(v => typeof v === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(v))) throw unavailable("BANK_BINDING_SCOPE_INVALID");
  const row = (await c.query("SELECT current_database() AS database,current_user AS runtime_user,to_regclass($1) IS NOT NULL AS ready", [TABLE])).rows[0];
  if (row?.database !== o.database || row?.runtime_user !== o.runtimeUser) throw unavailable("BANK_BINDING_RESOURCE_MISMATCH");
  return row.ready === true;
}
async function current(c: PoolClient, userId: string, privateRead = false) {
  const row = (await c.query<Row>(`SELECT ${COLUMNS}${privateRead ? ",sealed_details" : ""} FROM ${TABLE} WHERE user_id=$1`, [userId])).rows[0];
  if (row && row.user_id !== userId) throw notFound();
  return row;
}
function key(o: WithdrawalBankBindingOptions, version: string) {
  try {
    if (!TOKEN.test(version) || !o.protection) throw Error();
    const value = o.protection.keyFor(version);
    if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw Error();
    return Buffer.from(value);
  } catch { throw unavailable("BANK_BINDING_KEY_UNAVAILABLE"); }
}
const aad = (userId: string, id: string, rev: string, version: string) => Buffer.from(JSON.stringify(["withdrawal-bank-binding.v1", userId, id, rev, version]));
function seal(value: Details, o: WithdrawalBankBindingOptions, userId: string, id: string, rev: string) {
  const version = o.protection?.currentKeyVersion;
  if (typeof version !== "string" || !TOKEN.test(version)) throw unavailable("BANK_BINDING_WRITE_DISABLED");
  const secret = key(o, version);
  try {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, nonce);
    cipher.setAAD(aad(userId, id, rev, version));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return JSON.stringify({ version: 1, keyVersion: version, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), encrypted: encrypted.toString("base64url") });
  } finally { secret.fill(0); }
}
function unseal(row: Row, o: WithdrawalBankBindingOptions): Details {
  try {
    if (typeof row.sealed_details !== "string" || Buffer.byteLength(row.sealed_details) > 4096) throw Error();
    const doc: unknown = JSON.parse(row.sealed_details);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw Error();
    const e = doc as Record<string, unknown>;
    if (Object.keys(e).sort().join(",") !== "encrypted,keyVersion,nonce,tag,version" || e.version !== 1 || typeof e.keyVersion !== "string"
      || typeof e.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(e.nonce) || typeof e.tag !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(e.tag)
      || typeof e.encrypted !== "string" || e.encrypted.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(e.encrypted)) throw Error();
    const secret = key(o, e.keyVersion);
    try {
      const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(e.nonce, "base64url"));
      decipher.setAAD(aad(row.user_id, row.id, row.revision, e.keyVersion)); decipher.setAuthTag(Buffer.from(e.tag, "base64url"));
      const raw = Buffer.concat([decipher.update(Buffer.from(e.encrypted, "base64url")), decipher.final()]);
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      ensureOnlyFields(parsed, ["name", "cardNo"]); const value = details(parsed), masked = masks(value);
      if (masked.card_mask !== row.card_mask || masked.holder_mask !== row.holder_mask) throw Error();
      return value;
    } finally { secret.fill(0); }
  } catch { throw unavailable("BANK_BINDING_DETAILS_UNAVAILABLE"); }
}

/** GET只读脱敏资料，不读取保护钥，也不把保存成功标为银行验证通过。 */
export async function readWithdrawalBankBinding(c: PoolClient, actor: Actor, o: WithdrawalBankBindingOptions) {
  const integrated = await ready(c, o); await assertUserContextInTransaction(c, actor);
  return integrated ? projection(await current(c, actor.userId)) : { contractVersion: "withdrawal-bank-binding.v1" as const,
    integration: "NOT_INTEGRATED" as const, binding: null, expectedRevision: null };
}
async function replayOwner(c: PoolClient, userId: string, requestKey: string) {
  const row = (await c.query(`SELECT b.id FROM zzsh_supply.idempotency_record r JOIN ${TABLE} b
    ON b.id=r.response_body->'binding'->>'id' AND b.user_id=$3
    WHERE r.scope_key=$1 AND r.key=$2`, [scopeKey(userId), requestKey, userId])).rows[0];
  if (!row) throw notFound();
}
export async function saveWithdrawalBankBindingInTransaction(c: PoolClient, actor: Actor, body: Record<string, unknown>, requestKey: unknown, o: WithdrawalBankBindingOptions) {
  ensureOnlyFields(body, ["name", "cardNo", "expectedRevision"]);
  const value = details(body), expected = revision(body.expectedRevision), k = validateIdempotencyKey(requestKey);
  if (!await ready(c, o)) throw unavailable("BANK_BINDING_NOT_INTEGRATED");
  // 与提现创建一样先取本人锁；绑卡修改和提现冻结不能交错读取姓名/卡号。
  await assertUserContextInTransaction(c, actor);
  const result = await withIdempotency(c, { realm: "user", principalId: actor.userId, operation: OP }, k,
    fingerprintRequest(OP, undefined, { ...value, expectedRevision: expected }), async replay => {
      await assertUserContextInTransaction(c, actor); if (replay) await replayOwner(c, actor.userId, k);
    }, async () => {
      if (!o.protection) throw unavailable("BANK_BINDING_WRITE_DISABLED");
      const old = await current(c, actor.userId); if ((old?.revision ?? "0") !== expected) throw conflict("Bank binding changed; reload before saving");
      if (BigInt(expected) === 9223372036854775807n) throw conflict("Bank binding revision exhausted");
      const id = old?.id ?? `bank_${randomUUID().replaceAll("-", "")}`, next = (BigInt(expected) + 1n).toString(), masked = masks(value);
      const encrypted = seal(value, o, actor.userId, id, next);
      const row = (old ? await c.query<Row>(`UPDATE ${TABLE} SET revision=$3,sealed_details=$4,card_mask=$5,holder_mask=$6
        WHERE id=$1 AND user_id=$2 AND revision=$7 RETURNING ${COLUMNS}`, [id, actor.userId, next, encrypted, masked.card_mask, masked.holder_mask, expected])
        : await c.query<Row>(`INSERT INTO ${TABLE}(id,user_id,revision,sealed_details,card_mask,holder_mask) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
          [id, actor.userId, next, encrypted, masked.card_mask, masked.holder_mask])).rows[0];
      if (!row || row.user_id !== actor.userId || row.id !== id || row.revision !== next) throw conflict("Bank binding write changed");
      await recordAudit(c, { actorType: "user", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId,
        action: "withdrawal.bank_binding.saved", objectType: "withdrawal_bank_binding", objectId: id, outcome: "SUCCESS",
        details: { previousRevision: expected, revision: next, ownershipVerification: "NOT_VERIFIED" } });
      return { status: 200, body: projection(row) };
    });
  if (result.status !== 200) throw unavailable("BANK_BINDING_RECEIPT_INVALID");
  return { ...result, body: receipt(result.body, actor.userId) };
}
export class BankBindingCommitUnknown extends SecurityApiError {
  constructor(readonly originalKey: string) { super(503, "EVIDENCE_UNAVAILABLE", "Bank binding result is unknown; recover the original request"); }
}
export async function saveWithdrawalBankBinding(pool: Pool, actor: Actor, body: Record<string, unknown>, requestKey: unknown, o: WithdrawalBankBindingOptions) {
  const k = validateIdempotencyKey(requestKey); let completed = false;
  try { return await withTransaction(pool, async c => { const result = await saveWithdrawalBankBindingInTransaction(c, actor, body, k, o); completed = true; return result; }); }
  catch (error) { if (completed) throw new BankBindingCommitUnknown(k); throw error; }
}
export async function recoverWithdrawalBankBinding(c: PoolClient, actor: Actor, requestKey: unknown, o: WithdrawalBankBindingOptions) {
  const k = validateIdempotencyKey(requestKey), integrated = await ready(c, o); await assertUserContextInTransaction(c, actor);
  if (!integrated) return { integration: "NOT_INTEGRATED" as const, knowledge: "UNKNOWN" as const, receipt: null };
  const row = (await c.query(`SELECT response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`, [scopeKey(actor.userId), k])).rows[0];
  if (!row) return { integration: "INTEGRATED" as const, knowledge: "UNKNOWN" as const, receipt: null };
  await replayOwner(c, actor.userId, k);
  return { integration: "INTEGRATED" as const, knowledge: "KNOWN" as const, receipt: receipt(row.response_body, actor.userId) };
}
/** 只供已持有本人事务锁的提现业务读取；本地存储密文不是JoinPay的Enc字段。 */
export async function readWithdrawalBankBindingPrivate(c: PoolClient, actor: Actor, id: string, expectedRevision: string, o: WithdrawalBankBindingOptions) {
  if (typeof id !== "string" || !BANK_ID.test(id) || revision(expectedRevision) === "0") throw invalid();
  if (!await ready(c, o)) throw unavailable("BANK_BINDING_NOT_INTEGRATED");
  await assertUserContextInTransaction(c, actor); const row = await current(c, actor.userId, true);
  if (!row || row.id !== id) throw notFound(); if (row.revision !== expectedRevision) throw conflict("Bank binding changed");
  return privateProjection(row, o);
}
function privateProjection(row: Row, o: WithdrawalBankBindingOptions) {
  summary(row);
  const sourceDigest = createHash("sha256").update(JSON.stringify([row.id, row.user_id, row.revision, row.sealed_details, row.card_mask, row.holder_mask, row.updated_at])).digest("hex");
  return { bindingId: row.id, revision: row.revision, cardMask: row.card_mask, sourceDigest, ...unseal(row, o) };
}
/** 仅供已授权的服务端提现调用；worker不伪造用户session，仍重取本人活动锁和确切资源。 */
export async function readWithdrawalBankBindingForPayout(c: PoolClient, userId: string, id: string, o: WithdrawalBankBindingOptions) {
  if (typeof userId !== "string" || !TOKEN.test(userId) || typeof id !== "string" || !BANK_ID.test(id)) throw invalid();
  if (!await ready(c, o)) throw unavailable("BANK_BINDING_NOT_INTEGRATED");
  await assertActiveInTransaction(c, userId); const row = await current(c, userId, true);
  if (!row || row.id !== id) throw notFound();
  return privateProjection(row, o);
}
