import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseSourceCaptureLine, sourceJsonLine, readSourceRows, assertSourceSupplementFields, LEGACY_DISTRIBUTION_CAPTURE_FIELDS } from "./local-source-adapter.mjs";
import { assertAccountExtraColumns } from "./capture-legacy-account-extra.mjs";
const TABLES = {
    tradePolicy: { table: "la_system_config", fields: ["id", "type", "name", "value"], where: "(type='trade' AND name='advanceOrderSetRatio') OR (type='expendConfig' AND name IN ('barrettBullet','bullet','awm','armor','helmet','coffee','experienceCard','barrettBulletSale','bulletSale','awmSale','armorSale','helmetSale','coffeeSale','experienceCardSale'))" },
    users: { table: "la_user", fields: ["id", "sn", "nickname", "mobile", "is_bind_id", "is_disable", "is_delete", "is_high_risk", "password", "salt", "id_card", "create_time", "update_time", "money", "earnings", "code", "inviter_id", "first_leader", "second_leader", "third_leader"] },
    accounts: { table: "la_rental_accounts", fields: ["id", "user_id", "game_id", "no", "status", "is_delete", "price_tenant", "extra_goods_total_price_tenant", "deposit_amount", "rental_days", "default_consume_type", "update_time", "haff", "img_paths", "title_img_name", "is_full_payout", "base_bot", "awm_bullet_price", "level6_bullet_price", "level6_helmet_price", "level6_armor_price", "top_insure_card_price", "barrett_bullet_price", "coffee_price", "gold_skin", "knife_skin", "weapon_skin", "level6_bullet_num", "awm_bullet_num", "top_insure_card_num", "leshua_order_id", "yj_order_id", "transaction_id"] },
    orders: { table: "la_order", fields: ["id", "order_sn", "user_id", "sale_user_id", "accounts_id", "order_type", "order_source", "order_status", "pay_is", "is_settle", "is_delete", "create_time", "update_time", "pay_time", "confirm_time", "cancel_time", "tenancy_deadline", "express_is", "express_time", "expend_haff", "money", "goods_money", "expend_pay_money", "need_pay_money", "pay_money", "deposit_amount", "return_order_money", "detain_money", "sale_earnings", "commission_money", "full_payout_money", "awm_bullet_num", "level6_bullet_num", "level6_helmet_num", "level6_armor_num", "top_insure_card_num", "barrett_bullet_num", "coffee_num", "awm_bullet_price", "level6_bullet_price", "level6_helmet_price", "level6_armor_price", "top_insure_card_price", "barrett_bullet_price", "coffee_price", "team_id", "pay_way", "transaction_id", "profit_dot", "is_advance_set", "is_full_payout"] },
    earnings: { table: "la_log_earnings", fields: ["id", "sn", "user_id", "action", "change_type", "change_amount", "left_amount", "create_time", "source_id", "source_sn", "remark", "extra"] },
    moneyLogs: { table: "la_log_money", fields: ["id", "sn", "user_id", "action", "change_type", "change_amount", "left_amount", "create_time", "source_id", "source_sn", "remark", "extra"] },
    withdraws: { table: "la_withdraw_apply", fields: ["id", "user_id", "status", "sn", "money", "left_money", "handling_fee", "payment_time", "batch_no", "is_delete", "type", "create_time"] },
    refunds: { table: "la_refund_record", fields: ["id", "user_id", "order_id", "order_sn", "order_type", "sn", "refund_status", "order_amount", "refund_amount", "transaction_id", "refund_way", "create_time", "update_time"] },
    pays: { table: "la_pay_order", fields: ["id", "order_id", "order_type", "pay_is", "pay_way", "pay_money", "pay_order_sn", "pay_time", "transaction_id"] },
    distribution: { table: "la_distribution", fields: ["id", "user_id", "level_id", "is_distribution", "is_freeze", "is_delete"] },
    distributionOrders: { table: "la_distribution_order", fields: [...LEGACY_DISTRIBUTION_CAPTURE_FIELDS] },
    games: { table: "la_sg_game", fields: ["id", "game_name", "game_status", "is_delete", "type_id"] },
};
// Capture display, holdings and business continuation facts in the original snapshot, not a later supplement.
TABLES.users.fields.push("ancestor_relation", "avatar", "sex", "channel", "delete_time", "commission_rate", "is_deposit_free", "is_checked");
TABLES.accounts.fields.push("title", "description", "create_time", "agent_skin", "insure_lv", "insure_code", "grading_lv", "login_way", "vit_lv", "bear_lv", "dive_lv", "character_lv", "province", "city", "secret_kd", "processing_time_start", "processing_time_end", "ratio_type", "ban_record", "face_is_self", "level6_helmet_num", "level6_armor_num", "barrett_bullet_num", "coffee_num", "is_demulan", "is_sayyid", "awm_number", "helmet", "armor", "is_next_season_pass", "price_per", "price_vip", "extra_goods_total_price", "extra_goods_total_price_vip", "order_sn", "pay_is", "pay_money", "pay_time", "return_is", "team_id", "service_id", "info_source", "punishment_img_url", "personal_info_screenshot_url", "secret_service_screenshot_url", "advanced_weapon_screenshot_url", "high_risk_owner");
TABLES.accounts.expressions = { high_risk_owner: "(SELECT is_high_risk FROM la_user WHERE id=la_rental_accounts.user_id)" };
TABLES.orders.fields.push("leshua_order_id", "yj_order_id", "delete_time", "add_order_sn", "add_transaction_id", "add_money", "is_pay_add", "advance_time", "compensation", "share_money", "expend_money", "expend_ratio", "extra_haff", "extra_money", "service_id", "is_dismiss", "disagree_count", "form_options", "form_rule", "form_data", "form_data_format", "expend_remark", "user_remark", "shop_remark");
TABLES.distribution.fields.push("distribution_time", "create_time", "update_time", "delete_time");
TABLES.withdraws.fields.push("update_time", "delete_time", "payment_no", "transfer_time", "global_no");
TABLES.pays.fields.push("create_time");
TABLES.refunds.fields.push("refund_type");
TABLES.skinDictionaryTypes = { table: "la_dict_type", fields: ["id", "dict_name", "dict_type", "dict_remark", "dict_status", "is_delete", "create_time", "update_time", "delete_time"] };
TABLES.skinDictionaryData = { table: "la_dict_data", fields: ["id", "type_id", "name", "value", "remark", "sort", "status", "is_delete", "create_time", "update_time", "delete_time"] };
TABLES.distributionLevels = { table: "la_distribution_level", fields: ["id", "name", "weights", "self_ratio", "first_ratio", "second_ratio", "update_type", "is_default", "is_delete", "create_time", "update_time", "delete_time"] };
TABLES.distributionConfig = { table: "la_distribution_config", fields: ["id", "name", "value", "is_delete", "create_time", "update_time", "delete_time"] };
TABLES.orderAfter = { table: "la_order_after", fields: ["id", "after_sn", "user_id", "order_id", "after_type", "refund_sn", "refund_reason", "refund_remark", "refund_image", "refund_type", "refund_money", "refund_way", "after_status", "sub_status", "confirm_time", "audit_time", "handle_id", "handle_remark", "create_time", "update_time", "delete_time", "is_delete"] };
TABLES.accountDisplay = { ...TABLES.accounts, fields: [...TABLES.accounts.fields] };
if (process.argv.includes("--account-display-only")) {
    const display=TABLES.accountDisplay;
    for(const key of Object.keys(TABLES))delete TABLES[key];TABLES.accountDisplay=display;
}
if (process.argv.includes("--skin-dictionary-only")) {
    for (const key of Object.keys(TABLES)) delete TABLES[key];
    TABLES.skinDictionaryTypes = { table: "la_dict_type", fields: ["id", "type", "name", "value", "code", "type_name", "type_value", "dict_name", "dict_type", "dict_key", "field", "field_name", "is_delete", "status", "create_time", "update_time"] };
    TABLES.skinDictionaryData = { table: "la_dict_data", fields: ["id", "type_id", "dict_type_id", "dict_label", "dict_value", "name", "value", "label", "code", "sort", "is_delete", "status", "create_time", "update_time"] };
}
const fundsSupplement = process.argv.includes("--finance-supplement-only");
const refundSupplement = process.argv.includes("--refund-attempts-only");
if (fundsSupplement && refundSupplement) throw new Error("ONE_SOURCE_SUPPLEMENT_SCOPE_REQUIRED");
if (fundsSupplement) {
    const selected = { accounts: TABLES.accounts, earnings: TABLES.earnings, withdraws: TABLES.withdraws };
    for (const key of Object.keys(TABLES)) delete TABLES[key];
    Object.assign(TABLES, selected);
    TABLES.accounts.fields.push("create_pay_time", "pay_way", "pay_url_present", "pay_url_sha256");
    TABLES.accounts.expressions = {
        ...TABLES.accounts.expressions,
        pay_url_present: "JSON_EXTRACT(CASE WHEN pay_url IS NULL THEN NULL WHEN pay_url='' THEN 'false' ELSE 'true' END,'$')",
        pay_url_sha256: "SHA2(pay_url,256)",
    };
    TABLES.accounts.expressionSources = { pay_url_present: ["pay_url"], pay_url_sha256: ["pay_url"] };
    TABLES.earnings.fields.push("update_time", "delete_time");
    TABLES.withdraws.fields.push("real_name", "account", "money_qr_code", "apply_remark", "pay_desc", "pay_search_result", "audit_remark", "transfer_voucher", "transfer_remark", "bank_card_no", "bank_name", "mobile", "admin_id");
}
if (refundSupplement) {
    const parent = TABLES.refunds;
    for (const key of Object.keys(TABLES)) delete TABLES[key];
    TABLES.refunds = parent;
    TABLES.refundLogs = { table: "la_refund_log", fields: ["id", "sn", "record_id", "user_id", "handle_id", "order_amount", "refund_amount", "refund_status", "refund_msg", "create_time", "update_time"] };
    const expr = { id: "CAST(l.id AS CHAR)", record_id: "CAST(l.record_id AS CHAR)", attempt_user_id: "CAST(l.user_id AS CHAR)", parent_record_id: "CAST(r.id AS CHAR)", parent_user_id: "CAST(r.user_id AS CHAR)", parent_order_type: "CAST(r.order_type AS CHAR)", parent_order_id: "CAST(r.order_id AS CHAR)", parent_source_entity: "IF(r.id IS NULL,NULL,'la_refund_record')", order_source_entity: "CASE r.order_type WHEN 'order' THEN 'la_order' WHEN 'recharge' THEN 'la_recharge_order' ELSE NULL END", resolved_order_id: "CAST(CASE r.order_type WHEN 'order' THEN o.id WHEN 'recharge' THEN rc.id ELSE NULL END AS CHAR)", order_user_id: "CAST(CASE r.order_type WHEN 'order' THEN o.user_id WHEN 'recharge' THEN rc.user_id ELSE NULL END AS CHAR)", order_sale_user_id: "CAST(o.sale_user_id AS CHAR)", order_sn: "CAST(CASE r.order_type WHEN 'order' THEN o.order_sn WHEN 'recharge' THEN rc.order_sn ELSE NULL END AS CHAR)", order_pay_money: "CAST(o.pay_money AS CHAR)", order_status: "CAST(o.order_status AS CHAR)", order_is_delete: "CAST(o.is_delete AS CHAR)" };
    TABLES.sourceParentBindings = { table: "la_refund_log", fields: Object.keys(expr), expressions: expr, from: "la_refund_log l LEFT JOIN la_refund_record r ON r.id=l.record_id LEFT JOIN la_order o ON r.order_type='order' AND o.id=r.order_id LEFT JOIN la_recharge_order rc ON r.order_type='recharge' AND rc.id=r.order_id", orderBy: "l.id" };
}
const sourceSupplement = fundsSupplement || refundSupplement;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2), option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--capture")) {
    console.log(JSON.stringify({ action: "PLAN", source: "local frozen MySQL only", domains: Object.keys(TABLES), fieldsByDomain: Object.fromEntries(Object.entries(TABLES).map(([domain,entry])=>[domain,entry.fields])), required: ["--capture", "--container-id", "--out", ...(sourceSupplement ? ["--base-source", "--base-sha"] : [])], dbConnections: 0, credentialReads: 0, rawContentsPublic: false }));
    process.exit(0);
}
if (process.version !== "v24.20.0")
    throw new Error("NODE_BASELINE_MISMATCH");
const containerId = option("--container-id"), output = option("--out");
if (!/^[a-f0-9]{64}$/.test(containerId ?? ""))
    throw new Error("EXACT_CONTAINER_ID_REQUIRED");
if (!output || !isAbsolute(output) || existsSync(output))
    throw new Error("NEW_ABSOLUTE_PRIVATE_OUTPUT_REQUIRED");
const privateRoot = realpathSync("E:/zzsh-local-state/restricted");
const baseRows = new Map(), commonHashes = new Map(), supplementBinding = {}, baseOrders = new Map();
if (sourceSupplement) {
    const base = resolve(option("--base-source") ?? ""), expected = option("--base-sha");
    if (!base.toLowerCase().startsWith(privateRoot.toLowerCase() + "\\") || !/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("BOUND_PRIVATE_BASE_CAPTURE_REQUIRED");
    const bytes = readFileSync(join(base, "receipt.json")), original = JSON.parse(bytes);
    if (hash(bytes) !== expected || original.status !== "CAPTURED_READ_ONLY" || !original.rollbackConfirmed || !original.clientClosed || original.containerId !== containerId || original.database !== "sg_zzsh_restore") throw new Error("BASE_CAPTURE_NOT_CONFIRMED");
    Object.assign(supplementBinding, { baseSource: base, baseReceiptSha256: expected, fullSourcePopulation: true, comparison: "EXACT_SOURCE_ID_SETS_AND_EVERY_BASE_FIELD", actualBusinessTablesRead: fundsSupplement ? ["la_rental_accounts", "la_log_earnings", "la_withdraw_apply", "la_user"] : ["la_refund_log", "la_refund_record", "la_order", "la_recharge_order"], ...(fundsSupplement ? { derivedObserved: { accounts: { high_risk_owner: { sourceTable: "la_user", sourceColumn: "is_high_risk", method: "SAME_SNAPSHOT_CORRELATED_LOOKUP" } } } } : {}), domains: {} });
    for (const domain of Object.keys(TABLES).filter(domain => original.files[domain])) {
        const file = original.files[domain];
        if (!file || file.file !== parse(file.file).base) throw new Error("BASE_SOURCE_FILE_INVALID");
        const raw = readFileSync(join(base, file.file));
        if (hash(raw) !== file.sha256) throw new Error("BASE_SOURCE_FILE_CHANGED:" + domain);
        const rows = new Map(), expectedHash = createHash("sha256"), fields = [...file.fields].sort();
        for await (const row of readSourceRows(join(base, file.file))) {
            if (rows.has(row.id)) throw new Error("BASE_SOURCE_ID_DUPLICATE:" + domain);
            rows.set(row.id, row); expectedHash.update(sourceJsonLine(Object.fromEntries(fields.map(field => [field, row[field]]))));
        }
        if (rows.size !== file.rows) throw new Error("BASE_SOURCE_ROWS_CHANGED:" + domain);
        baseRows.set(domain, rows); commonHashes.set(domain, { fields, hash: createHash("sha256") });
        supplementBinding.domains[domain] = { baseRows: file.rows, commonFields: fields, expectedCommonSha256: expectedHash.digest("hex"), comparedRows: 0, remainingIds: file.rows };
    }
    if (refundSupplement) {
        const file = original.files.orders, raw = readFileSync(join(base, file.file));
        if (hash(raw) !== file.sha256) throw new Error("BASE_ORDER_FILE_CHANGED");
        for await (const row of readSourceRows(join(base, file.file))) baseOrders.set(row.id, row);
        supplementBinding.typedParentBinding = { attemptSourceEntity: "la_refund_log", recordSourceEntity: "la_refund_record", recordForeignKey: "record_id", orderEntityByType: { order: "la_order", recharge: "la_recharge_order" }, orderFieldsCompared: ["user_id", "sale_user_id", "order_sn", "pay_money", "order_status", "is_delete"], comparedRows: 0 };
        supplementBinding.sourceEvidence = [
            { path: "E:/zzsh/analysis/front/source/com/mdd/common/enums/RefundEnum.java", lines: "4-9,30-38" },
            { path: "E:/zzsh/analysis/admin/source/com/mdd/admin/service/impl/OrderManageServiceImpl.java", lines: "615-639,651-656,678-687" },
            { path: "E:/zzsh/analysis/front/source/com/mdd/front/service/impl/OrderServiceImpl.java", lines: "1190-1220,1250-1267" },
        ].map(entry => ({ ...entry, sha256: hash(readFileSync(entry.path)) }));
    }
}
const destination = resolve(output);
if (!destination.toLowerCase().startsWith(privateRoot.toLowerCase() + "\\"))
    throw new Error("PRIVATE_OUTPUT_OUTSIDE_REGISTERED_ROOT");
let ancestor = dirname(destination);
while (ancestor !== parse(ancestor).root) {
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
        throw new Error("OUTPUT_REPARSE_POINT_REFUSED");
    ancestor = dirname(ancestor);
}
const inspected = spawnSync("docker", ["inspect", "--format", "{{.Id}}", "zzsh-mysql-restore"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
if (inspected.status !== 0 || inspected.stdout.trim() !== containerId)
    throw new Error("FROZEN_SOURCE_CONTAINER_CHANGED");
const sidResult = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
const sid = /S-1-5-[0-9-]+/.exec(sidResult.stdout)?.[0];
if (!sid)
    throw new Error("CURRENT_SID_UNAVAILABLE");
mkdirSync(destination, { recursive: false });
const acl = spawnSync("icacls", [destination, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
if (acl.status !== 0)
    throw new Error("PRIVATE_OUTPUT_ACL_FAILED");
const monotonicStarted = performance.now();
const receipt = { schema: "zzsh.legacy-source-capture.v1", toolSha256: hash(readFileSync(fileURLToPath(import.meta.url))), supportToolSha256: hash(readFileSync(new URL("./local-source-adapter.mjs", import.meta.url))), accountExtraToolSha256: hash(readFileSync(new URL("./capture-legacy-account-extra.mjs", import.meta.url))), transport: "HEX_JSON_TO_UTF8_JSONL", startedAt: new Date().toISOString(), containerId, database: "sg_zzsh_restore", status: "STARTED", files: {}, physicalColumns: {}, statements: 0, privateReads: 0, connections: 1 };
if (sourceSupplement) receipt.sourceSupplement = supplementBinding;
if (refundSupplement) receipt.aggregates = [];
let child, stderr = "", section = null, failure, rollbackConfirmed = false;
const handles = new Map(), columns = new Map();
const input = ["--defaults-extra-file=/root/.my.cnf", "--user=root", "--protocol=SOCKET", "--skip-reconnect", "--local-infile=0", "--default-character-set=utf8mb4", "--batch", "--raw", "--skip-column-names", "--unbuffered", "sg_zzsh_restore"];
child = spawn("docker", ["exec", "-i", containerId, "mysql", ...input], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString("utf8")).slice(-8192); });
const closed = new Promise((resolveClose) => { child.once("error", error => resolveClose({ error: error.code })); child.once("close", (code, signal) => resolveClose({ code, signal })); });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
function send(sql, statements = 1) { receipt.statements += statements; child.stdin.write(sql + "\n"); }
const timeout = setTimeout(() => { failure ??= "SOURCE_CAPTURE_DEADLINE"; child.stdin.end(); }, 10 * 60 * 1000);
try {
    send("SET SESSION transaction_read_only=1; SET SESSION transaction_isolation='REPEATABLE-READ'; SET SESSION max_execution_time=60000; START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;", 4);
    send("SELECT JSON_OBJECT('_phase','identity','database',DATABASE(),'principal',CURRENT_USER(),'readOnly',@@transaction_read_only,'isolation',@@transaction_isolation,'thread',CONNECTION_ID(),'accessMode',(SELECT ACCESS_MODE FROM performance_schema.events_transactions_current t JOIN performance_schema.threads p ON p.THREAD_ID=t.THREAD_ID WHERE p.PROCESSLIST_ID=CONNECTION_ID()),'txState',(SELECT STATE FROM performance_schema.events_transactions_current t JOIN performance_schema.threads p ON p.THREAD_ID=t.THREAD_ID WHERE p.PROCESSLIST_ID=CONNECTION_ID()));");
    send("SELECT JSON_OBJECT('_phase','column','table',TABLE_NAME,'name',COLUMN_NAME) FROM information_schema.columns WHERE TABLE_SCHEMA='sg_zzsh_restore'" + (fundsSupplement ? " AND TABLE_NAME IN ('la_rental_accounts','la_log_earnings','la_withdraw_apply')" : refundSupplement ? " AND TABLE_NAME IN ('la_refund_log','la_refund_record','la_order','la_recharge_order')" : "") + " ORDER BY TABLE_NAME,ORDINAL_POSITION;");
    send("SELECT JSON_OBJECT('_phase','columns-complete');");
    for await (const line of lines) {
        if (!line)
            continue;
        let row;
        try {
            row = parseSourceCaptureLine(line);
        }
        catch {
            writeFileSync(join(destination, "failed-response.txt"), line, { flag: "wx" });
            throw new Error("MYSQL_RESPONSE_NOT_JSON");
        }
        if (row._phase === "identity") {
            if (row.database !== "sg_zzsh_restore" || row.principal !== "root@localhost" || row.readOnly !== 1 || row.isolation !== "REPEATABLE-READ" || row.accessMode !== "READ ONLY" || row.txState !== "ACTIVE")
                throw new Error("SOURCE_READ_ONLY_IDENTITY_FAILED");
            receipt.identity = row;
        }
        else if (row._phase === "column") {
            if (!columns.has(row.table))
                columns.set(row.table, new Set());
            columns.get(row.table).add(row.name);
        }
        else if (row._phase === "columns-complete") {
            if (!receipt.identity)
                throw new Error("SOURCE_IDENTITY_NOT_OBSERVED");
            receipt.physicalColumns = Object.fromEntries([...columns].map(([table, fields]) => [table, [...fields]]));
            if (refundSupplement) {
                send("SELECT JSON_OBJECT('_phase','aggregate','kind','attempt-status','status',CAST(refund_status AS CHAR),'rows',COUNT(*),'refundAmountYuan',CAST(SUM(refund_amount) AS CHAR)) FROM la_refund_log GROUP BY refund_status ORDER BY refund_status;");
                send("SELECT JSON_OBJECT('_phase','aggregate','kind','parent-link','parentType',parent_type,'recordMissing',record_missing,'orderMissing',order_missing,'userMismatch',user_mismatch,'rows',COUNT(*)) FROM (SELECT r.order_type parent_type,r.id IS NULL record_missing,CASE r.order_type WHEN 'order' THEN o.id IS NULL WHEN 'recharge' THEN rc.id IS NULL ELSE NULL END order_missing,IF(r.id IS NULL,NULL,l.user_id<>r.user_id) user_mismatch FROM la_refund_log l LEFT JOIN la_refund_record r ON r.id=l.record_id LEFT JOIN la_order o ON r.order_type='order' AND o.id=r.order_id LEFT JOIN la_recharge_order rc ON r.order_type='recharge' AND rc.id=r.order_id) links GROUP BY parent_type,record_missing,order_missing,user_mismatch;");
                send("SELECT JSON_OBJECT('_phase','aggregate','kind','retry-risk','totalAttempts',(SELECT COUNT(*) FROM la_refund_log),'multipleAttemptRecordIds',COALESCE(SUM(attempts>1),0),'multipleSuccessRecordIds',COALESCE(SUM(successes>1),0),'attemptsInRepeatedRecordIds',COALESCE(SUM(IF(attempts>1,attempts,0)),0)) FROM (SELECT record_id,COUNT(*) attempts,SUM(refund_status=1) successes FROM la_refund_log GROUP BY record_id) t;");
                send("SELECT JSON_OBJECT('_phase','aggregate','kind','duplicate-attempt-sn','groups',COUNT(*),'rows',COALESCE(SUM(n),0)) FROM (SELECT sn,COUNT(*) n FROM la_refund_log GROUP BY sn HAVING COUNT(*)>1) t;");
            }
            for (const [domain, entry] of Object.entries(TABLES)) {
                const present = columns.get(entry.table);
                if (!present?.has("id"))
                    throw new Error("SOURCE_REQUIRED_TABLE_MISSING:" + entry.table);
                if (entry.table === "la_rental_accounts") assertAccountExtraColumns(present);
                const available = field => present.has(field) || Object.hasOwn(entry.expressions??{},field) && (entry.expressionSources?.[field] ?? []).every(source => present.has(source));
                const fields = [...new Set(entry.fields)].filter(available);
                receipt.files[domain] = { file: domain + ".jsonl", table: entry.table, fields, missingFields: entry.fields.filter(field => !available(field)), rows: 0, bytes: 0 };
                handles.set(domain, { fd: openSync(join(destination, domain + ".jsonl"), "wx"), hash: createHash("sha256") });
                send("SELECT JSON_OBJECT('_phase','section','domain','" + domain + "');");
                send("SELECT HEX(JSON_OBJECT(" + fields.flatMap(field => ["'" + field + "'", entry.expressions?.[field]??"CAST(`" + field + "` AS CHAR)"]).join(",") + ")) FROM " + (entry.from ?? "`" + entry.table + "`") + (entry.where ? " WHERE " + entry.where : "") + " ORDER BY " + (entry.orderBy ?? "id") + ";");
            }
            send("ROLLBACK; SELECT JSON_OBJECT('_phase','rollback-complete');", 2);
            child.stdin.end();
        }
        else if (row._phase === "section") {
            section = row.domain;
            if (!handles.has(section))
                throw new Error("UNKNOWN_SOURCE_SECTION");
        }
        else if (row._phase === "rollback-complete") {
            rollbackConfirmed = true;
        }
        else if (row._phase === "aggregate" && refundSupplement) receipt.aggregates.push(row);
        else {
            const handle = handles.get(section);
            if (!handle)
                throw new Error("SOURCE_ROW_OUTSIDE_SECTION");
            if (baseRows.has(section)) {
                const original = baseRows.get(section)?.get(row.id);
                if (!original) throw new Error("SUPPLEMENT_SOURCE_ID_SET_CHANGED:" + section);
                assertSourceSupplementFields(original, row);
                const common = commonHashes.get(section);
                common.hash.update(sourceJsonLine(Object.fromEntries(common.fields.map(field => [field, row[field]]))));
                baseRows.get(section).delete(row.id); supplementBinding.domains[section].comparedRows++;
            }
            if (refundSupplement && section === "sourceParentBindings" && row.parent_order_type === "order") {
                const original = baseOrders.get(row.parent_order_id);
                if (Boolean(original) !== (row.resolved_order_id !== null)) throw new Error("REFUND_PARENT_ORDER_ID_SET_CHANGED");
                if (original) {
                    for (const field of supplementBinding.typedParentBinding.orderFieldsCompared)
                        if (original[field] !== row["order_" + field.replace(/^order_/, "")]) throw new Error("REFUND_PARENT_ORDER_FIELD_CHANGED:" + field);
                    supplementBinding.typedParentBinding.comparedRows++;
                }
            }
            const bytes = Buffer.from(sourceJsonLine(row));
            writeSync(handle.fd, bytes);
            handle.hash.update(bytes);
            receipt.files[section].rows++;
            receipt.files[section].bytes += bytes.length;
        }
    }
    const exit = await closed;
    receipt.client = exit;
    if (exit.code !== 0 || stderr)
        throw new Error("MYSQL_CAPTURE_CLIENT_FAILED");
    if (!rollbackConfirmed)
        throw new Error("SOURCE_ROLLBACK_NOT_CONFIRMED");
    if (sourceSupplement) for (const [domain, remaining] of baseRows) {
        const comparison = supplementBinding.domains[domain]; comparison.remainingIds = remaining.size;
        comparison.actualCommonSha256 = commonHashes.get(domain).hash.digest("hex");
        if (remaining.size || comparison.expectedCommonSha256 !== comparison.actualCommonSha256) throw new Error("SUPPLEMENT_COMMON_SOURCE_CHANGED:" + domain);
    }
    receipt.status = "CAPTURED_READ_ONLY";
}
catch (error) {
    failure ??= error.message;
    receipt.status = "FAILED_STOPPED";
    receipt.failure = failure;
    child.stdin.end();
    await closed;
    process.exitCode = 1;
}
finally {
    clearTimeout(timeout);
    for (const [domain, handle] of handles) {
        closeSync(handle.fd);
        receipt.files[domain].sha256 = handle.hash.digest("hex");
    }
    receipt.rollbackConfirmed = rollbackConfirmed;
    receipt.clientClosed = child.exitCode !== null;
    receipt.clientStderrPresent = stderr.length > 0;
    if (stderr) { writeFileSync(join(destination, "client-stderr.txt"), stderr, { flag: "wx" }); receipt.clientErrorNumber = /ERROR\s+(\d+)/.exec(stderr)?.[1] ?? null; }
    receipt.finishedAt = new Date().toISOString();
    receipt.monotonicElapsedMs = performance.now() - monotonicStarted;
    writeFileSync(join(destination, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: receipt.status, output: destination, rollbackConfirmed, clientClosed: receipt.clientClosed, counts: Object.fromEntries(Object.entries(receipt.files).map(([name, file]) => [name, file.rows])), failure: receipt.failure }));
}
