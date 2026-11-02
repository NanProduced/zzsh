import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
const TABLES = {
    tradePolicy: { table: "la_system_config", fields: ["id", "type", "name", "value"], where: "(type='trade' AND name='advanceOrderSetRatio') OR (type='expendConfig' AND name IN ('barrettBullet','bullet','awm','armor','helmet','coffee','experienceCard','barrettBulletSale','bulletSale','awmSale','armorSale','helmetSale','coffeeSale','experienceCardSale'))" },
    users: { table: "la_user", fields: ["id", "sn", "nickname", "mobile", "is_bind_id", "is_disable", "is_delete", "is_high_risk", "password", "salt", "id_card", "create_time", "update_time", "money", "earnings", "inviter_id", "first_leader", "second_leader", "third_leader"] },
    accounts: { table: "la_rental_accounts", fields: ["id", "user_id", "game_id", "no", "status", "is_delete", "price_tenant", "extra_goods_total_price_tenant", "deposit_amount", "rental_days", "default_consume_type", "update_time", "haff", "img_paths", "title_img_name", "is_full_payout", "base_bot", "awm_bullet_price", "level6_bullet_price", "level6_helmet_price", "level6_armor_price", "top_insure_card_price", "barrett_bullet_price", "coffee_price", "gold_skin", "knife_skin", "weapon_skin", "level6_bullet_num", "awm_bullet_num", "top_insure_card_num", "leshua_order_id", "yj_order_id", "transaction_id"] },
    orders: { table: "la_order", fields: ["id", "order_sn", "user_id", "sale_user_id", "accounts_id", "order_type", "order_source", "order_status", "pay_is", "is_settle", "is_delete", "create_time", "update_time", "pay_time", "confirm_time", "cancel_time", "tenancy_deadline", "express_is", "express_time", "expend_haff", "money", "goods_money", "expend_pay_money", "need_pay_money", "pay_money", "deposit_amount", "return_order_money", "detain_money", "sale_earnings", "commission_money", "full_payout_money", "awm_bullet_num", "level6_bullet_num", "level6_helmet_num", "level6_armor_num", "top_insure_card_num", "barrett_bullet_num", "coffee_num", "awm_bullet_price", "level6_bullet_price", "level6_helmet_price", "level6_armor_price", "top_insure_card_price", "barrett_bullet_price", "coffee_price", "team_id", "pay_way", "transaction_id", "profit_dot", "is_advance_set", "is_full_payout"] },
    earnings: { table: "la_log_earnings", fields: ["id", "sn", "user_id", "action", "change_type", "change_amount", "left_amount", "create_time", "source_id", "source_sn", "remark", "extra"] },
    moneyLogs: { table: "la_log_money", fields: ["id", "sn", "user_id", "action", "change_type", "change_amount", "left_amount", "create_time", "source_id", "source_sn", "remark", "extra"] },
    withdraws: { table: "la_withdraw_apply", fields: ["id", "user_id", "status", "sn", "money", "left_money", "handling_fee", "payment_time", "batch_no", "is_delete", "type", "create_time"] },
    refunds: { table: "la_refund_record", fields: ["id", "user_id", "order_id", "order_sn", "order_type", "sn", "refund_status", "order_amount", "refund_amount", "transaction_id", "refund_way", "create_time", "update_time"] },
    pays: { table: "la_pay_order", fields: ["id", "order_id", "order_type", "pay_is", "pay_way", "pay_money", "pay_order_sn", "pay_time", "transaction_id"] },
    distribution: { table: "la_distribution", fields: ["id", "user_id", "level_id", "is_distribution", "is_freeze", "is_delete"] },
    distributionOrders: { table: "la_distribution_order", fields: ["id", "user_id", "order_id", "order_type", "sn", "status", "earnings", "ratio", "level_id", "level", "is_delete", "create_time", "update_time", "settle_time"] },
    games: { table: "la_sg_game", fields: ["id", "game_name", "game_status", "is_delete", "type_id"] },
};
if (process.argv.includes("--account-display-only")) {
    const base=TABLES.accounts;
    const display={table:base.table,fields:[...base.fields,"agent_skin","insure_lv","grading_lv","login_way","vit_lv","bear_lv","dive_lv","character_lv","province","city","secret_kd","processing_time_start","processing_time_end","ratio_type","ban_record","face_is_self","level6_helmet_num","level6_armor_num","barrett_bullet_num","coffee_num","high_risk_owner"],expressions:{high_risk_owner:"(SELECT is_high_risk FROM la_user WHERE id=la_rental_accounts.user_id)"}};
    for(const key of Object.keys(TABLES))delete TABLES[key];TABLES.accountDisplay=display;
}
if (process.argv.includes("--skin-dictionary-only")) {
    for (const key of Object.keys(TABLES)) delete TABLES[key];
    TABLES.skinDictionaryTypes = { table: "la_dict_type", fields: ["id", "type", "name", "value", "code", "type_name", "type_value", "dict_name", "dict_type", "dict_key", "field", "field_name", "is_delete", "status", "create_time", "update_time"] };
    TABLES.skinDictionaryData = { table: "la_dict_data", fields: ["id", "type_id", "dict_type_id", "dict_label", "dict_value", "name", "value", "label", "code", "sort", "is_delete", "status", "create_time", "update_time"] };
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2), option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--capture")) {
    console.log(JSON.stringify({ action: "PLAN", source: "local frozen MySQL only", domains: Object.keys(TABLES), required: ["--capture", "--container-id", "--out"], dbConnections: 0, credentialReads: 0, rawContentsPublic: false }));
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
const receipt = { schema: "zzsh.legacy-source-capture.v1", startedAt: new Date().toISOString(), containerId, database: "sg_zzsh_restore", status: "STARTED", files: {}, statements: 0, privateReads: 0, connections: 1 };
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
    send("SELECT JSON_OBJECT('_phase','column','table',TABLE_NAME,'name',COLUMN_NAME) FROM information_schema.columns WHERE TABLE_SCHEMA='sg_zzsh_restore' AND TABLE_NAME IN (" + Object.values(TABLES).map(item => "'" + item.table + "'").join(",") + ") ORDER BY TABLE_NAME,ORDINAL_POSITION;");
    send("SELECT JSON_OBJECT('_phase','columns-complete');");
    for await (const line of lines) {
        if (!line)
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
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
            if (args.includes("--skin-dictionary-only")) receipt.physicalColumns = Object.fromEntries([...columns].map(([table, fields]) => [table, [...fields]]));
            for (const [domain, entry] of Object.entries(TABLES)) {
                const present = columns.get(entry.table);
                if (!present?.has("id"))
                    throw new Error("SOURCE_REQUIRED_TABLE_MISSING:" + entry.table);
                const fields = [...new Set(entry.fields)].filter(field => present.has(field) || Object.hasOwn(entry.expressions??{},field));
                receipt.files[domain] = { file: domain + ".jsonl", table: entry.table, fields, missingFields: entry.fields.filter(field => !present.has(field) && !Object.hasOwn(entry.expressions??{},field)), rows: 0, bytes: 0 };
                handles.set(domain, { fd: openSync(join(destination, domain + ".jsonl"), "wx"), hash: createHash("sha256") });
                send("SELECT JSON_OBJECT('_phase','section','domain','" + domain + "');");
                send("SELECT JSON_OBJECT(" + fields.flatMap(field => ["'" + field + "'", entry.expressions?.[field]??"CAST(`" + field + "` AS CHAR)"]).join(",") + ") FROM `" + entry.table + "`" + (entry.where ? " WHERE " + entry.where : "") + " ORDER BY id;");
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
        else {
            const handle = handles.get(section);
            if (!handle)
                throw new Error("SOURCE_ROW_OUTSIDE_SECTION");
            const bytes = Buffer.from(line + "\n");
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
    receipt.finishedAt = new Date().toISOString();
    receipt.monotonicElapsedMs = performance.now() - monotonicStarted;
    writeFileSync(join(destination, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: receipt.status, output: destination, rollbackConfirmed, clientClosed: receipt.clientClosed, counts: Object.fromEntries(Object.entries(receipt.files).map(([name, file]) => [name, file.rows])), failure: receipt.failure }));
}
