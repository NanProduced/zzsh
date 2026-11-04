import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPolicyDraft, runPolicyInitialization } from "./initialize-local-policy.mjs";

const effectiveAtUtc = "2026-11-03T12:00:00.000Z", now = Date.parse(effectiveAtUtc);
const template = { policy: { status: "DRAFT", pricingScope: "ALL_ENABLED_RENTAL_MODES", effectiveAt: "OLD_SOURCE_TIME", tiers: { STANDARD: { exactAmount: "0.123456789123456789" } }, sourceRef: "TEST_ONLY_ORIGINAL" }, versionNo: 1, expectedVersion: "0", ruleReleaseId: "release-new", priceVersionId: "price-new", sourceRef: "content-sha-reference", effectiveAtUtc: "ROOT_REQUIRED" };
const profile = { version: 1, localTest: true, resource: "new_scene", actors: Object.fromEntries(["boss-one", "boss-two"].map((alias, index) => [alias, { realm: "admin", origin: "http://127.0.0.1:4281", userId: "new-boss-" + (index + 1), username: "zz0000" + (index + 1), password: "fixture-password-" + index, totp: { encoding: "base32", secret: "JBSWY3DPEHPK3PXP" } }])) };

test("policy plan is zero connection and uses the strict true feature value", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./initialize-local-policy.mjs", import.meta.url)), "--plan"], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.action, "PLAN"); assert.equal(plan.connections, 0); assert.equal(plan.credentialReads, 0); assert.equal(plan.resourceLocks, 0);
    assert.equal(plan.feature, "ZZSH_MEMBERSHIP_GROWTH_ENABLED=true");
});

test("new effective time changes both fields without changing exact policy values or original template", () => {
    const before = JSON.stringify(template), draft = buildPolicyDraft(template, effectiveAtUtc, now);
    assert.equal(draft.effectiveAtUtc, effectiveAtUtc); assert.equal(draft.policy.effectiveAt, effectiveAtUtc);
    assert.equal(draft.policy.tiers.STANDARD.exactAmount, "0.123456789123456789");
    assert.equal(draft.policy.sourceRef, "TEST_ONLY_ORIGINAL"); assert.equal(JSON.stringify(template), before);
    assert.throws(() => buildPolicyDraft(template, "2026-09-01T00:00:00.000Z", now), /ROOT_CURRENT_EFFECTIVE_UTC_REQUIRED/);
});

for (const mode of ["success", "response-unknown", "not-publishable", "readback-differs"]) test("new policy formal flow: " + mode, async () => {
    const calls = [], files = new Map(); let executed = false;
    const fakeFetch = async (url, options) => {
        const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
        const token = /zzsh_admin.session_token=boss-(\d)/.exec(options.headers.Cookie ?? "");
        const actor = token?.[1] ?? null; calls.push({ path, body, actor, key: options.headers["Idempotency-Key"] });
        let result = {}, headers = {};
        if (path.endsWith("/sign-in/username")) { const n = body.username.endsWith("1") ? "1" : "2"; headers["set-cookie"] = "zzsh_admin.session_token=boss-" + n + "; Path=/; HttpOnly"; result = { twoFactorRedirect: false }; }
        else if (path.endsWith("/get-session")) result = { user: { id: "new-boss-" + actor, suspended: false, twoFactorEnabled: true } };
        else if (path.endsWith("/policy")) result = executed ? { approvedMeta: { id: "new-policy", version: "1", ruleReleaseId: "release-new", priceVersionId: "price-new", effectiveAtUtc }, approvedPolicy: { status: "APPROVED" } } : { meta: null, approvedMeta: null, bootstrap: { expectedVersion: "0", ruleReleaseId: "release-new", priceVersionId: "price-new" } };
        else if (path.endsWith("/policy-drafts")) result = { id: "new-draft", version: "1", status: "DRAFT", payloadHash: "a".repeat(64), publishable: false, warnings: mode === "not-publishable" ? ["CONFIG_PENDING"] : [], unifiedPricing: { knowledge: "KNOWN" } };
        else if (path.endsWith("/requests")) result = { requestId: "new-approval", approvalRequestId: "new-approval" };
        else if (path.endsWith("/decision") && mode === "response-unknown") throw Error("FIXTURE_RESPONSE_LOST");
        else if (path.endsWith("/execute")) { executed = true; result = { status: "EXECUTED", executionStatus: "SUCCEEDED", resultCode: "MEMBERSHIP_POLICY_PUBLISHED", businessResultRef: "new-policy" }; }
        else if (path.endsWith("/detail")) result = { status: "EXECUTED", decision: { decision: "APPROVED", approver: { id: mode === "readback-differs" ? "old-boss" : "new-boss-2" } }, execution: { status: "SUCCEEDED", resultCode: "MEMBERSHIP_POLICY_PUBLISHED", resultDetail: "new-policy", executor: { id: "new-boss-1" } } };
        return new Response(JSON.stringify(result), { status: 200, headers });
    };
    const receipt = await runPolicyInitialization({ profile, template, effectiveAtUtc, now, apiOrigin: "http://127.0.0.1:4282", commandKeyPrefix: "scene-policy-fixed-command", fetcher: fakeFetch, write: (file, value) => files.set(file, structuredClone(value)) });
    assert.equal(receipt.resourceLockTaken, false); assert.equal(receipt.oldApprovalsCopied, false); assert.equal(receipt.productionOperatingPolicy, false);
    const writes = calls.filter(call => call.key);
    assert.equal(new Set(writes.map(call => call.key)).size, writes.length);
    const decision = calls.find(call => call.path.endsWith("/decision")), execute = calls.find(call => call.path.endsWith("/execute"));
    if (decision) { assert.equal(decision.actor, "2"); assert.equal(decision.body.requestId, "new-approval"); assert.match(decision.body.totpCode, /^\d{6}$/); }
    if (execute) { assert.equal(execute.actor, "1"); assert.equal(execute.body.requestId, "new-approval"); }
    if (mode === "success") {
        assert.equal(receipt.status, "FORMAL_LOCAL_POLICY_INITIALIZED"); assert.equal(receipt.policyId, "new-policy");
        assert.equal(calls.find(call => call.path.endsWith("/templates/update")).body.candidateUsernames[0], "zz00002");
        assert.equal(calls.find(call => call.path.endsWith("/requests")).body.payload.policyDraftId, "new-draft");
    } else if (mode === "response-unknown") {
        assert.equal(receipt.status, "STOPPED_HTTP_RESULT_UNKNOWN"); assert.equal(execute, undefined);
        assert.equal(calls.filter(call => call.path.endsWith("/decision")).length, 1);
        assert.match(receipt.retryPolicy, /no automatic retry/);
    } else if (mode === "not-publishable") {
        assert.equal(receipt.status, "STOPPED_REJECTED_OR_READBACK_DIFFERS"); assert.equal(decision, undefined); assert.equal(execute, undefined);
    } else { assert.equal(receipt.status, "STOPPED_REJECTED_OR_READBACK_DIFFERS"); assert.equal(receipt.error.code, "NEW_POLICY_AND_APPROVAL_READBACK_DIFFERS"); }
    assert.ok(files.has("http-exchanges.json")); assert.ok(files.has("receipt.json"));
});
