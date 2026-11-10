import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const token = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function readPinnedRegularFile(path, maximum = 100_000) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("LEGAL_INITIAL_SOURCE_UNSAFE");
  const full = resolve(path);
  for (let current = full; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || current === full && (!stat.isFile() || stat.size > maximum)) throw new Error("LEGAL_INITIAL_SOURCE_UNSAFE");
    if (dirname(current) === current) break;
  }
  return readFileSync(full);
}

/** Source references are explicit and pinned; actual bodies stay out of receipts. */
export function prepareLegalPair(input, readBytes, legal) {
  if (input?.schema !== "zzsh.legal-initial-source.v1" || !legal || typeof readBytes !== "function"
    || typeof input.effectiveAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.effectiveAt)
    || Number.isNaN(Date.parse(input.effectiveAt)) || new Date(input.effectiveAt).toISOString() !== input.effectiveAt) throw new Error("LEGAL_INITIAL_SOURCE_INVALID");
  const specs = [{ key: "terms", type: "PLATFORM_TERMS", title: "平台服务协议" }, { key: "privacy", type: "PLATFORM_PRIVACY", title: "用户隐私政策" }];
  const documents = Object.fromEntries(specs.map(spec => {
    const ref = input[spec.key];
    if (!ref || typeof ref.path !== "string" || !isAbsolute(ref.path) || !token(ref.sha256)) throw new Error("LEGAL_INITIAL_SOURCE_INVALID");
    const bytes = readBytes(ref.path);
    if (!Buffer.isBuffer(bytes) || sha(bytes) !== ref.sha256) throw new Error("LEGAL_INITIAL_SOURCE_CHANGED");
    let body;
    try { body = legal.normalizeLegalDocumentBody(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("LEGAL_INITIAL_BODY_INVALID"); }
    return [spec.key, { ...spec, body, digest: legal.legalDigest(body), sourceSha256: ref.sha256 }];
  }));
  return { effectiveAt: input.effectiveAt, documents };
}

/** Only the current sealed versions count, and both must be exactly the reviewed inputs. */
export function verifyLegalPair(current, prepared) {
  const result = {};
  for (const key of ["terms", "privacy"]) {
    const row = current?.[key], expected = prepared.documents[key];
    if (!row || row.docType !== expected.type || row.status !== "SEALED" || row.title !== expected.title
      || row.body !== expected.body || row.digest !== expected.digest || !row.id
      || !row.effectiveAt || Date.parse(row.effectiveAt) !== Date.parse(prepared.effectiveAt)) throw new Error("LEGAL_INITIAL_PAIR_NOT_CURRENT");
    result[key] = { id: row.id, digest: row.digest, sourceSha256: expected.sourceSha256 };
  }
  return { ...result, effectiveAt: prepared.effectiveAt };
}

/** The caller holds the target-bound transaction and has revalidated the administrator's session and permissions. */
export async function initializeLegalPair(client, actor, prepared, legal, recordAudit) {
  if (![actor?.id, actor?.sessionId, actor?.requestId].every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))) throw new Error("LEGAL_INITIAL_ACTOR_REQUIRED");
  await client.query("LOCK TABLE zzsh_content.legal_document_version IN SHARE ROW EXCLUSIVE MODE");
  const current = await legal.readCurrentPlatformDocuments(client);
  if (current.terms || current.privacy) {
    return { status: "EXACT_PRESENT", ...verifyLegalPair(current, prepared) };
  }
  const state = (await client.query("SELECT count(*)::int AS n,transaction_timestamp() AS now FROM zzsh_content.legal_document_version")).rows[0];
  if (!state || state.n !== 0) throw new Error("LEGAL_INITIAL_TARGET_NOT_EMPTY");
  if (!(Date.parse(prepared.effectiveAt) <= new Date(state.now).getTime())) throw new Error("LEGAL_INITIAL_NOT_YET_EFFECTIVE");
  for (const key of ["terms", "privacy"]) {
    const doc = prepared.documents[key];
    const draft = await legal.createLegalDraft(client, actor.id, { docType: doc.type, title: doc.title, body: doc.body, effectiveAt: prepared.effectiveAt });
    const sealed = await legal.sealLegalDocument(client, actor.id, draft.id, draft.revision);
    await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "legal.document.initialized", objectType: "legal_document_version",
      objectId: sealed.id, outcome: "SUCCESS", requestId: actor.requestId, reason: "REVIEWED_INITIAL_SOURCE",
      details: { docType: doc.type, digest: doc.digest, sourceSha256: doc.sourceSha256, effectiveAt: prepared.effectiveAt } });
  }
  return { status: "INITIALIZED", ...verifyLegalPair(await legal.readCurrentPlatformDocuments(client), prepared) };
}
