import { createHash } from "node:crypto";
import { createReadStream, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { sourceUserPlan, sourceContactPlanningRow, sourceAccountPlan, sourceOrderPlan, sourceFinanceObservation, sourceContinuation, sourceInvitationPlan, readSourceRows as rows, sourceJsonLine } from "./local-source-adapter.mjs";
import { selectSourceScenarios } from "./local-source-scenarios.mjs";
const require = createRequire(import.meta.url), ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--prepare")) {
    console.log(JSON.stringify({ action: "PLAN", required: ["--prepare", "--source", "--source-sha", "--source-binding", "--source-binding-sha", "--out"], optional: ["--scenario-selection", "--api-dist"], dbConnections: 0, credentialReads: 0, writeAllowed: false }));
    process.exit(0);
}
const monotonicStarted = performance.now();
if (process.version !== "v24.20.0")
    throw new Error("NODE_BASELINE_MISMATCH");
const source = resolve(option("--source") ?? ""), output = resolve(option("--out") ?? "");
if (!source.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || !output.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || existsSync(output))
    throw new Error("NEW_PRIVATE_SOURCE_OUTPUT_REQUIRED");
const sha = value => createHash("sha256").update(value).digest("hex");
const receiptBytes = readFileSync(join(source, "receipt.json"));
if (sha(receiptBytes) !== option("--source-sha"))
    throw new Error("CAPTURE_RECEIPT_SHA_MISMATCH");
const sourceReceipt = JSON.parse(receiptBytes);
if (sourceReceipt.status !== "CAPTURED_READ_ONLY" || !sourceReceipt.rollbackConfirmed || !sourceReceipt.clientClosed)
    throw new Error("SOURCE_CAPTURE_NOT_CONFIRMED");
const bindingFile = option('--source-binding'), bindingSha = option('--source-binding-sha');
if (!bindingFile || !/^[a-f0-9]{64}$/.test(bindingSha ?? ''))
    throw new Error('FROZEN_SOURCE_ORIGIN_REQUIRED');
const bindingBytes = readFileSync(bindingFile);
if (sha(bindingBytes) !== bindingSha)
    throw new Error('SOURCE_ORIGIN_SHA_MISMATCH');
const binding = JSON.parse(bindingBytes);
if (binding.container?.id !== sourceReceipt.containerId || binding.source?.database !== sourceReceipt.database || !binding.restoreRecord?.dumpSha256 || !binding.restoreRecord?.cutoff || !Number.isFinite(Date.parse(binding.restoreRecord.cutoff)) || Date.parse(binding.restoreRecord.cutoff) > Date.parse(sourceReceipt.startedAt))
    throw new Error('SOURCE_ORIGIN_BINDING_MISMATCH');
for (const [domain, file] of Object.entries(sourceReceipt.files)) {
    if (file.file !== basename(file.file))
        throw new Error("SOURCE_PATH_INVALID");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(join(source, file.file)))
        hash.update(bytes);
    if (hash.digest("hex") !== file.sha256)
        throw new Error("SOURCE_FILE_SHA_MISMATCH:" + domain);
}
const api = resolve(option("--api-dist") ?? join(ROOT, "apps/api/dist/src"));
const mod = name => require(join(api, name + ".js"));
const modules = { planner: mod("legacy-load/user-order-offline-plan"), contentHash: mod("supply/content-hash"), orderRead: mod("order/legacy-order-read"), finance: mod("finance/legacy-finance-source-preparation"), financeRead: mod("finance/personal-finance-read"), calc: mod("order/legacy-continuation-calc"), identity: mod("auth/identity-subject") };
if (!Array.isArray(modules.orderRead.LEGACY_ORDER_READ_SOURCE_FIELDS))
    throw new Error("FORMAL_ORDER_SOURCE_FIELDS_NOT_EXPORTED");
const sidResult = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
const sid = /S-1-5-[0-9-]+/.exec(sidResult.stdout)?.[0];
if (!sid)
    throw new Error("SID_REQUIRED");
mkdirSync(output);
const acl = spawnSync("icacls", [output, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
if (acl.status !== 0)
    throw new Error("OUTPUT_ACL_FAILED");
const handles = new Map(), fileMeta = {};
function emit(name, row) { if (!handles.has(name)) {
    handles.set(name, { fd: openSync(join(output, name + ".jsonl"), "wx"), hash: createHash("sha256") });
    fileMeta[name] = { file: name + ".jsonl", rows: 0, bytes: 0 };
} const h = handles.get(name), bytes = Buffer.from(sourceJsonLine(row)); writeSync(h.fd, bytes); h.hash.update(bytes); fileMeta[name].rows++; fileMeta[name].bytes += bytes.length; }
const report = { schema: "zzsh.local-legacy-dataset.v1", startedAt: new Date().toISOString(), source, sourceReceiptSha256: sha(receiptBytes), apiDist: api, toolFiles: Object.fromEntries(["prepare-local-dataset.mjs", "local-source-adapter.mjs", "local-source-scenarios.mjs"].map(name => [name, sha(readFileSync(new URL(name, import.meta.url)))])), sourceCutoff: binding.restoreRecord.cutoff, capturedAt: sourceReceipt.finishedAt, sourceOrigin: { bindingSha256: bindingSha, dumpSha256: binding.restoreRecord.dumpSha256, cutoffMeaning: binding.restoreRecord.cutoffMeaning }, sourceRef: "local-frozen-source:" + sha(receiptBytes), domains: {}, quarantine: {}, dbConnections: 0, credentialReads: 0, writeAllowed: false, files: fileMeta };
const isolate = (domain, sourceId, reason) => { const key = domain + ":" + reason; report.quarantine[key] = (report.quarantine[key] ?? 0) + 1; emit("quarantine", { domain, sourceId, reason }); };
const users = new Map(), accounts = new Map(), accountRows = new Map(), games = new Map(), seenPhones = new Set(), pays = new Map(), refunds = new Map(), commissions = new Map();
const append = (map, key, row) => { if (!map.has(key))
    map.set(key, []); map.get(key).push(row); };
const policy = { advanceOrderSetRatio: null, expend: {} };
try {
    const data = {}, parsedBySha = new Map();
    for (const [domain, file] of Object.entries(sourceReceipt.files)) {
        if (parsedBySha.has(file.sha256)) {
            data[domain] = parsedBySha.get(file.sha256);
            if (data[domain].length !== file.rows) throw new Error("SOURCE_DENOMINATOR_CHANGED:" + domain);
            continue;
        }
        data[domain] = [];
        const ids = new Set();
        for await (const raw of rows(join(source, file.file))) {
            if (ids.has(raw.id)) throw new Error("DUPLICATE_SOURCE_ID:" + domain);
            ids.add(raw.id); data[domain].push(raw);
        }
        if (data[domain].length !== file.rows) throw new Error("SOURCE_DENOMINATOR_CHANGED:" + domain);
        parsedBySha.set(file.sha256, data[domain]);
    }
    report.parsedSourceFiles = parsedBySha.size;
    const contactSources = [];
    for (const raw of data.users) contactSources.push(sourceContactPlanningRow(raw, modules, report.sourceRef));
    const contacts = mod("legacy-load/legacy-contact-projection").planLegacyContactProjections(contactSources);
    report.userContactProjection = { schema: "legacy-contact-projection-v1", sourceSubjects: contacts.size, writtenWithOriginalImport: true, winner: "UNIQUE_NON_CANCELLED_ONLY", frozenRetainsClaim: true, decisions: {} };
    for (const p of contacts.values()) report.userContactProjection.decisions[p.decision] = (report.userContactProjection.decisions[p.decision] ?? 0) + 1;
    const selection = args.includes("--scenario-selection") ? selectSourceScenarios(data, contacts) : null;
    const sourceRows = domain => selection ? data[domain].filter(raw => selection.includes(domain, raw)) : data[domain];
    if (selection) {
        report.scenarioSelection = selection.summary;
        for (const [domain, ids] of Object.entries(selection.selected)) for (const sourceId of ids) emit("scenario-selection", { domain, sourceId });
        for (const missing of selection.missing) isolate("relationships", missing.sourceId, missing.cause);
    }
    for (const row of sourceRows("games")) {
        if (row.id === "1" && row.game_name === "三角洲行动" && row.is_delete === "0")
            games.set(row.id, "delta");
    }
    if (games.size !== 1)
        throw new Error("DELTA_SOURCE_DICTIONARY_NOT_CONFIRMED");
    report.gameBindings = Object.fromEntries(games);
    for (const raw of sourceRows("tradePolicy")) {
        if (raw.type === 'trade' && raw.name === 'advanceOrderSetRatio')
            policy.advanceOrderSetRatio = raw.value;
        else if (raw.type === 'expendConfig') {
            if (Object.hasOwn(policy.expend, raw.name))
                throw Error('DUPLICATE_SOURCE_POLICY');
            policy.expend[raw.name] = raw.value;
        }
    }
    if (typeof policy.advanceOrderSetRatio !== 'string' || Object.keys(policy.expend).length !== 14)
        throw Error('SOURCE_POLICY_INCOMPLETE');
    for (const raw of sourceRows("pays"))
        if (raw.order_type === '1' && raw.pay_is === '1')
            append(pays, raw.order_id, raw);
    for (const raw of sourceRows("refunds"))
        if (raw.order_type === 'order')
            append(refunds, raw.order_id, raw);
    for (const raw of sourceRows("distributionOrders"))
        if (raw.order_type === '1' && raw.status === '1' && raw.is_delete === '0')
            append(commissions, raw.order_id, raw);
    let sourceMoney = 0n, sourceEarnings = 0n, mappedMoney = 0n, mappedEarnings = 0n;
    report.domains.users = { source: 0, ready: 0, isolated: 0 };
    for (const raw of sourceRows("users")) {
        report.domains.users.source++;
        let balance;
        try {
            balance = { money: modules.financeRead.sourceSignedYuanToCents(raw.money), earnings: modules.financeRead.sourceYuanToCents(raw.earnings) };
            sourceMoney += BigInt(balance.money);
            sourceEarnings += BigInt(balance.earnings);
        }
        catch {
            isolate("balances", raw.id, "STORED_AMOUNT_INVALID");
        }
        try {
            const p = sourceUserPlan(raw, modules, report.sourceRef, seenPhones, contacts);
            if (p.disposition !== "PARAMETER_READY") {
                report.domains.users.isolated++;
                isolate("users", raw.id, p.reason ?? "NOT_READY");
                continue;
            }
            const input = p.writerInput;
            let trustedIdentityNumber = null;
            if (input.evidence.status.realNameBound && typeof raw.id_card === 'string' && raw.id_card.trim()) {
                try {
                    trustedIdentityNumber = modules.identity.normalizeIdentityDocument(raw.id_card);
                }
                catch { }
            }
            const metadata = { sourceId: raw.id, userId: p.userId, sourceDigest: input.evidence.sourceDigest, evidenceDigest: input.evidenceDigest, sourceStatus: input.evidence.status, highRisk: p.risk?.value ?? null };
            users.set(raw.id, metadata);
            emit("users", { ...metadata, input, trustedIdentityNumber });
            report.domains.users.ready++;
            if (balance) {
                mappedMoney += BigInt(balance.money);
                mappedEarnings += BigInt(balance.earnings);
                emit("stored-balances", { ...metadata, source: { id: raw.id, money: raw.money, earnings: raw.earnings }, amounts: balance, state: "REVIEW_REQUIRED_NO_OPENING_ADMISSION" });
            }
        }
        catch (error) {
            report.domains.users.isolated++;
            isolate("users", raw.id, error.code ?? "SOURCE_USER_INVALID");
        }
    }
    report.storedBalanceTotals = { selectedSourceMoneyCents: sourceMoney.toString(), selectedSourceEarningsCents: sourceEarnings.toString(), mappedMoneyCents: mappedMoney.toString(), mappedEarningsCents: mappedEarnings.toString(), targetOpening: "NOT_ADMITTED", fullSourceTotalsNotInferredFromSelection: true };
    const invitation = sourceInvitationPlan(data.users, data.distribution, { ...modules, invitation: mod("finance/legacy-invitation-facts"), migration: mod("supply/legacy-user-migration") }, sourceReceipt, report.sourceReceiptSha256, report.sourceCutoff, new Set(users.keys()));
    report.invitationFacts = invitation.summary;
    for (const packet of invitation.packets) emit("invitation-facts", packet);
    report.domains.accounts = { source: 0, ready: 0, isolated: 0, snapshotReady: 0 };
    for (const raw of sourceRows("accounts")) {
        report.domains.accounts.source++;
        accountRows.set(raw.id, raw);
        try {
            const p = sourceAccountPlan(raw, users, modules, report.sourceRef, games);
            if (!p.ready) {
                report.domains.accounts.isolated++;
                isolate("accounts", raw.id, p.reason);
                continue;
            }
            accounts.set(raw.id, p);
            emit("accounts", p);
            report.domains.accounts.ready++;
            if (p.snapshot)
                report.domains.accounts.snapshotReady++;
        }
        catch {
            report.domains.accounts.isolated++;
            isolate("accounts", raw.id, "SOURCE_ACCOUNT_INVALID");
        }
    }
    report.domains.orders = { source: 0, ready: 0, isolated: 0 };
    report.domains.continuations = { source: 0, parameterComplete: 0, isolated: 0 };
    report.domains.liabilities = { source: 0, byClassification: {} };
    for (const raw of sourceRows("orders")) {
        report.domains.orders.source++;
        let p;
        try {
            p = sourceOrderPlan(raw, users, accounts, modules, report.sourceRef);
            if (!p.ready) {
                report.domains.orders.isolated++;
                isolate("orders", raw.id, p.reason);
            }
            else {
                emit("orders", p);
                report.domains.orders.ready++;
            }
        }
        catch {
            report.domains.orders.isolated++;
            isolate("orders", raw.id, "SOURCE_ORDER_INVALID");
        }
        if (raw.pay_is === '1' && raw.is_delete === '0' && ['3', '8', '9'].includes(raw.order_status)) {
            report.domains.continuations.source++;
            try {
                const pending = commissions.get(raw.id) ?? [];
                const sourceEvidence = sourceContinuation(raw, accountRows.get(raw.accounts_id), pays.get(raw.id) ?? [], pending, policy);
                const admission = modules.calc.admitLegacyEvidence(sourceEvidence);
                const evidence = pending.map(c => { const canonical = modules.contentHash.canonicalize(c); return { sourceRecordId: c.id, canonical, digest: sha(canonical), evidenceRef: report.sourceRef + ':la_distribution_order:' + c.id }; });
                emit('continuations', { sourceId: raw.id, parentSourceDigest: p?.ready ? p.sourceDigest : null, source: sourceEvidence, commissionEvidence: evidence, admission: admission.admission, reasons: admission.reasons, targetParentReady: p?.ready === true });
                if (admission.admission === 'PARAMETER_COMPLETE')
                    report.domains.continuations.parameterComplete++;
                else
                    report.domains.continuations.isolated++;
            }
            catch {
                report.domains.continuations.isolated++;
                isolate('continuations', raw.id, 'SOURCE_CONTINUATION_INVALID');
            }
        }
        let classification = null;
        if (raw.pay_is === '1') {
            if (raw.order_status === '4' && raw.is_settle === '0')
                classification = 'COMPLETED_UNREFUNDED';
            else if (raw.order_status === '4' && raw.is_settle === '2')
                classification = 'DETAINED';
            else if (raw.is_settle === '3')
                classification = 'POSTED_CONFISCATION';
            else if (raw.order_status === '5' && raw.return_order_money !== null && BigInt(modules.financeRead.sourceSignedYuanToCents(raw.return_order_money)) > 0n && (refunds.get(raw.id)?.length ?? 0) > 0)
                classification = 'REFUND_RECORD_EXISTS';
        }
        if (classification) {
            report.domains.liabilities.source++;
            report.domains.liabilities.byClassification[classification] = (report.domains.liabilities.byClassification[classification] ?? 0) + 1;
            emit('liabilities', { sourceId: raw.id, classification, originalOrder: raw, refundRecords: refunds.get(raw.id) ?? [], targetParentReady: p?.ready === true });
        }
    }
    for (const [orderId, commissionRows] of commissions)
        for (const row of commissionRows)
            emit('pending-commissions', { parentLegacyOrderId: orderId, sourceRecord: row });
    for (const domain of ["earnings", "withdraws", "distributionOrders"]) {
        report.domains[domain] = { source: 0, ready: 0, isolated: 0 };
        for (const raw of sourceRows(domain)) {
            report.domains[domain].source++;
            const user = users.get(raw.user_id);
            if (!user) {
                report.domains[domain].isolated++;
                isolate(domain, raw.id, "SUBJECT_NOT_MAPPED");
                continue;
            }
            try {
                const observation = sourceFinanceObservation(domain, raw);
                const preview = modules.finance.previewFrozenFinanceObservation(observation.kind, observation.row, { userId: user.userId, legacyUserId: raw.user_id });
                emit("finance-observations", { domain, ...observation, userId: user.userId, identityDigest: user.sourceDigest, sourceDigest: preview.sourceDigest, sourceEventAt: preview.sourceEventAt, financialSource: preview.financialSource });
                report.domains[domain].ready++;
            }
            catch {
                report.domains[domain].isolated++;
                isolate(domain, raw.id, "SOURCE_FINANCE_OBSERVATION_INVALID");
            }
        }
    }
    for (const name of ["pays", "refunds", "distribution", "moneyLogs", "orderAfter", "distributionLevels", "distributionConfig"])
        if (data[name]) {
            const retained = sourceRows(name);
            report.domains[name] = { source: retained.length, disposition: "RETAINED_SOURCE_RELATION_EVIDENCE_NOT_NATIVE_TRANSACTION" };
            for (const row of retained) emit("source-relations", { domain: name, row });
        }
    for (const [domain, entry] of Object.entries(report.domains)) if (sourceReceipt.files[domain]) entry.fullSource = sourceReceipt.files[domain].rows;
    report.status = "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN";
}
catch (error) {
    report.status = "FAILED_STOPPED";
    report.error = error.message;
    process.exitCode = 1;
}
finally {
    report.plannerBuild = { nodeVersion: process.version, packageLockSha256: sha(readFileSync(join(ROOT, "package-lock.json"))), files: {}, sources: {} };
    for (const path of Object.keys(require.cache)) if (path.startsWith(api + "\\") || path.startsWith(api + "/")) {
        const relative = path.slice(api.length + 1).replaceAll("\\", "/");
        report.plannerBuild.files[relative] = sha(readFileSync(path));
        const original = join(ROOT, "apps/api/src", relative.replace(/\.js$/, ".ts"));
        if (existsSync(original)) report.plannerBuild.sources[relative] = sha(readFileSync(original));
    }
    for (const [name, h] of handles) {
        closeSync(h.fd);
        fileMeta[name].sha256 = h.hash.digest("hex");
    }
    report.finishedAt = new Date().toISOString();
    report.monotonicElapsedMs = performance.now() - monotonicStarted;
    writeFileSync(join(output, "manifest.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: report.status, output, domains: report.domains, quarantine: report.quarantine, error: report.error }));
}
