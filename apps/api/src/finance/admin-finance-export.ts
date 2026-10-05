import { createHash } from "node:crypto";
import { SecurityApiError, recordAudit, withTransaction } from "../auth/security-core";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { canonicalize } from "../supply/content-hash";
import { financeSnapshot, readFinanceSourceVersion, type FinanceActor, type FinanceEntry, type FinanceFilters } from "./admin-finance-read";
import type { AdminFinanceOptions } from "./admin-finance-routes";
import { exactCents } from "./personal-finance-read";
import type { SupplyResponse } from "../supply/supply-routes";

export function financeCsvCell(value: string | null): string {
  const text = value ?? "";
  return '"' + (/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
}
export function generateAdminFinanceCsv(entries: readonly FinanceEntry[], filters: FinanceFilters, asOf: string, version: string) {
  const header = ["分录引用", "业务引用", "原编号", "主体ID", "主体", "资金类别", "方向", "变动金额_分", "金额状态", "业务", "状态", "分类", "改变用户资金", "当前账内分录", "来源类型", "来源系统", "来源实体", "来源ID", "事实时间_UTC", "采集时间_UTC", "核验时间_UTC", "缺项", "生效范围", "起日_AsiaShanghai", "止日_AsiaShanghai", "数据截止_UTC", "快照版本", "币种"];
  const lines = entries.map(entry => [entry.id, entry.documentRef, entry.documentNumber, entry.subjectId, entry.subjectName, entry.bucket, entry.direction,
    entry.deltaCents, entry.knowledge, entry.kind, entry.state, entry.classification, String(entry.affectsCurrentWallet), String(entry.affectsCurrentLedger), entry.sourceType, entry.sourceSystem, entry.sourceEntity, entry.sourceId,
    entry.occurredAt, entry.importedAt, entry.evidence.queriedAt ?? null, entry.reasonCodes.join("|"), filters.scope, filters.from, filters.to, asOf, version, "CNY"]
    .map((value, index) => index === 7 && value !== null ? '"' + exactCents(value) + '"' : financeCsvCell(value)).join(","));
  const bytes = Buffer.from("\uFEFF" + [header.map(financeCsvCell).join(","), ...lines].join("\r\n") + "\r\n", "utf8");
  if (bytes.length > 12 * 1024 * 1024) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Finance export size limit reached",[{path:"finance.exportLimit.12MiB",code:"INVALID_FIELD"}]);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), rowCount: entries.length };
}

export function observeAdminFinanceDelivery(response: SupplyResponse, options: AdminFinanceOptions, actor: FinanceActor, receipt: { requestId: string; fileDigest: string; rowCount: number }): void {
  const node = response as SupplyResponse & { once?: (event: string, callback: () => void) => void; writableFinished?: boolean };
  let observed = false;
  const record = (phase: "SERVER_FINISHED" | "DELIVERY_UNKNOWN") => {
    if (observed) return; observed = true;
    void withTransaction(options.pool, client => recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId,
      action: `finance.export.${phase.toLowerCase()}`, objectType: "finance_export", outcome: phase === "SERVER_FINISHED" ? "SUCCESS" : "FAILURE", requestId: receipt.requestId,
      details: { phase, fileDigest: receipt.fileDigest, rowCount: receipt.rowCount, clientSaved: "UNCONFIRMED" } }))
      .catch(() => { console.warn("FINANCE_EXPORT_COMPLETION_AUDIT_FAILED", receipt.requestId); });
  };
  node.once?.("finish", () => record("SERVER_FINISHED"));
  node.once?.("close", () => record(node.writableFinished ? "SERVER_FINISHED" : "DELIVERY_UNKNOWN"));
}

/** The audit transaction commits before any response body. No funds/ledger writes. */
export async function prepareAdminFinanceExport(options: AdminFinanceOptions, actor: FinanceActor, filters: FinanceFilters, token: string, generated: ReturnType<typeof generateAdminFinanceCsv>, requestId: string) {
  return withTransaction(options.pool, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await assertAdminContextInTransaction(client, actor);
    const access = await loadEffectiveAdminAccess(client, actor.userId);
    if (access?.status !== "ACTIVE" || access.passwordChangeRequired || !access.permissions.has("finance.read")) throw new SecurityApiError(403, "FORBIDDEN", "Finance permission required");
    const authorizationKey = createHash("sha256").update(canonicalize([...access.permissions].sort())).digest("hex");
    const source = await readFinanceSourceVersion(client), facts = { ...source, entries:[],subjects:[],revisions:[],withdrawalsReady:source.ready.withdrawals };
    const snapshot = financeSnapshot(facts, filters, { ...actor, authorizationKey }, options.listingCursorKey, token);
    await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, action: "finance.export.prepared", objectType: "finance_export", outcome: "SUCCESS", requestId,
      details: { phase: "PREPARED", contractVersion: "admin-finance.read.v1", filterHash: createHash("sha256").update(canonicalize(filters)).digest("hex"),
        asOf: snapshot.asOf, rowCount: generated.rowCount, fileDigest: generated.sha256 } });
    return { phase: "PREPARED" as const, asOf: snapshot.asOf, rowCount: generated.rowCount, fileDigest: generated.sha256, requestId };
  });
}
