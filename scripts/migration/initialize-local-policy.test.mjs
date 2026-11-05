import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { assertPolicyProfileBinding, buildLocalTestPolicyTemplate, buildPolicyDraft, runPolicyInitialization, validatePolicyContent } from "./initialize-local-policy.mjs";

const effectiveAtUtc = "2026-11-03T12:00:00.000Z", now = Date.parse(effectiveAtUtc);
const template = { policy: { status: "DRAFT", pricingScope: "ALL_ENABLED_RENTAL_MODES", effectiveAt: "OLD_SOURCE_TIME", tiers: { STANDARD: { exactAmount: "0.123456789123456789" } }, sourceRef: "TEST_ONLY_ORIGINAL" }, versionNo: 1, expectedVersion: "0", ruleReleaseId: "release-new", priceVersionId: "price-new", sourceRef: "content-sha-reference", effectiveAtUtc: "ROOT_REQUIRED" };
const profile = { version: 1, localTest: true, resource: "new_scene", actors: Object.fromEntries(["boss-one", "boss-two"].map((alias, index) => [alias, { realm: "admin", origin: "http://127.0.0.1:4281", userId: "new-boss-" + (index + 1), username: "zz0000" + (index + 1), password: "fixture-password-" + index, totp: { encoding: "base32", secret: "JBSWY3DPEHPK3PXP" } }])) };
const digest = value => createHash("sha256").update(value).digest("hex");
const modes = ["ordinary", "custom", "fast"];
const tiers = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"];
const sourceRef = "LOCAL_TEST_MEMBERSHIP_20261105";
function policyBase() {
    const result = structuredClone(template);
    result.policy.tiers = Object.fromEntries(tiers.map(tier => [tier, { tier, tenantDeposit: "ACCOUNT_BASE", pricing: Object.fromEntries(modes.map(mode => [mode, { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode, priceVersionId: result.priceVersionId, costBasisRef: result.priceVersionId, payableRatio: "1" }])) }]));
    return result;
}

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

test("new test template gives five price tiers and finite/full tenant-deposit benefits without changing its base", () => {
    const base = policyBase(), original = structuredClone(base), candidate = buildLocalTestPolicyTemplate(base, sourceRef);
    assert.deepEqual(base, original);
    assert.equal(candidate.sourceRef, sourceRef); assert.equal(candidate.policy.sourceRef, sourceRef); assert.equal(candidate.policy.version, sourceRef);
    assert.equal(candidate.ruleReleaseId, base.ruleReleaseId); assert.equal(candidate.priceVersionId, base.priceVersionId);
    for (const [index, tier] of tiers.entries()) {
        for (const mode of modes) assert.equal(candidate.policy.tiers[tier].pricing[mode].payableRatio, ["1", "0.98", "0.96", "0.94", "0.92"][index]);
        assert.deepEqual([candidate.policy.tiers[tier].tenantDeposit, candidate.policy.tiers[tier].depositAllowanceCents], [["ACCOUNT_BASE", "0"], ["ACCOUNT_BASE", "2000"], ["ACCOUNT_BASE", "10000"], ["WAIVED", "0"], ["WAIVED", "0"]][index]);
    }
    assert.throws(() => buildLocalTestPolicyTemplate(base, "TEST_ONLY_FAST_LOCAL_20261028_1"), /TEST_POLICY_BASE_OR_SOURCE_INVALID/);
    const wrongPrice = structuredClone(base); wrongPrice.policy.tiers.GOLD.pricing.fast.priceVersionId = "other-price";
    assert.throws(() => buildLocalTestPolicyTemplate(wrongPrice, sourceRef), /TEST_POLICY_PRICE_BASIS_MISMATCH/);
    const missingTier = structuredClone(base); delete missingTier.policy.tiers.SILVER;
    assert.throws(() => buildLocalTestPolicyTemplate(missingTier, sourceRef), /TEST_POLICY_TIER_NOT_CONFIGURED/);
    const changedTarget = buildLocalTestPolicyTemplate(base, sourceRef, { ruleReleaseId: "release-future", priceVersionId: "price-future" });
    assert.equal(changedTarget.ruleReleaseId, "release-future"); assert.equal(changedTarget.priceVersionId, "price-future");
    for (const tier of tiers) for (const mode of modes) {
        assert.equal(changedTarget.policy.tiers[tier].pricing[mode].priceVersionId, "price-future");
        assert.equal(changedTarget.policy.tiers[tier].pricing[mode].costBasisRef, "price-future");
        assert.equal(changedTarget.policy.tiers[tier].entitlementCap, undefined);
    }
    for (const kind of ["FRIEND", "PRESTIGE"]) for (const mode of modes) assert.equal(changedTarget.policy.entitlementRanges[kind].byMode[mode].priceVersionId, "price-future");
    assert.throws(() => buildLocalTestPolicyTemplate(base, sourceRef, { ruleReleaseId: "", priceVersionId: "price-future" }), /TEST_POLICY_BASE_OR_SOURCE_INVALID/);
});

test("new test content binds exact template, release, source and actor profile; old content stays readable", () => {
    const candidate = buildLocalTestPolicyTemplate(policyBase(), sourceRef), bytes = Buffer.from(JSON.stringify(candidate));
    const content = { kind: "LOCAL_TEST_MEMBERSHIP_POLICY_CONTENT_V1", newApprovalRequired: true, productionOperatingPolicy: false,
      selected: { sourceRef }, draftInputTemplateSha256: digest(bytes), baseTemplateSha256: "b".repeat(64), ruleReleaseId: candidate.ruleReleaseId, priceVersionId: candidate.priceVersionId };
    assert.deepEqual(validatePolicyContent(content, bytes), candidate);
    for (const change of [c => { c.productionOperatingPolicy = true; }, c => { c.newApprovalRequired = false; }, c => { c.ruleReleaseId = "wrong"; }, c => { c.priceVersionId = "wrong"; }, c => { c.selected.sourceRef = "TEST_ONLY_FAST_LOCAL_20261028_1"; }, c => { c.draftInputTemplateSha256 = "f".repeat(64); }]) {
        const invalid = structuredClone(content); change(invalid);
        assert.throws(() => validatePolicyContent(invalid, bytes), /REVIEWED_TEST_ONLY_POLICY_CONTENT_REQUIRED/);
    }
    const profileBytes = Buffer.from(JSON.stringify(profile));
    assert.doesNotThrow(() => assertPolicyProfileBinding(content, { profileSha256: digest(profileBytes) }, profileBytes));
    assert.throws(() => assertPolicyProfileBinding(content, {}, profileBytes), /EXACT_POLICY_ACTOR_PROFILE_SHA_REQUIRED/);
    assert.throws(() => assertPolicyProfileBinding(content, { profileSha256: "f".repeat(64) }, profileBytes), /EXACT_POLICY_ACTOR_PROFILE_SHA_REQUIRED/);
    const legacyCandidate = structuredClone(candidate); legacyCandidate.policy.sourceRef = "TEST_ONLY_FAST_LOCAL_20261028_1";
    const legacyBytes = Buffer.from(JSON.stringify(legacyCandidate));
    const legacy = { kind: "CURRENT_MEMBERSHIP_POLICY_CONTENT_NOT_APPROVAL_IMPORT", newApprovalRequired: true, selected: { sourceRef: "TEST_ONLY_FAST_LOCAL_20261028_1" }, draftInputTemplateSha256: digest(legacyBytes) };
    assert.deepEqual(validatePolicyContent(legacy, legacyBytes), legacyCandidate);
    legacy.draftInputTemplateSha256 = digest(bytes);
    assert.throws(() => validatePolicyContent(legacy, bytes), /REVIEWED_TEST_ONLY_POLICY_CONTENT_REQUIRED/);
    assert.doesNotThrow(() => assertPolicyProfileBinding(legacy, {}, profileBytes));
});

for (const mode of ["success", "test-policy-success", "existing-policy", "response-unknown", "not-publishable", "readback-differs"]) test("new policy formal flow: " + mode, async () => {
    const calls = [], files = new Map(); let executed = false;
    const fakeFetch = async (url, options) => {
        const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
        const token = /zzsh_admin.session_token=boss-(\d)/.exec(options.headers.Cookie ?? "");
        const actor = token?.[1] ?? null; calls.push({ path, body, actor, key: options.headers["Idempotency-Key"] });
        let result = {}, headers = {};
        if (path.endsWith("/sign-in/username")) { const n = body.username.endsWith("1") ? "1" : "2"; headers["set-cookie"] = "zzsh_admin.session_token=boss-" + n + "; Path=/; HttpOnly"; result = { twoFactorRedirect: false }; }
        else if (path.endsWith("/get-session")) result = { user: { id: "new-boss-" + actor, suspended: false, twoFactorEnabled: true } };
        else if (path.endsWith("/policy")) result = executed ? { approvedMeta: { id: "new-policy", version: "1", ruleReleaseId: "release-new", priceVersionId: "price-new", effectiveAtUtc }, approvedPolicy: { status: "APPROVED" } } : { meta: mode === "existing-policy" ? { id: "existing" } : null, approvedMeta: null, bootstrap: { expectedVersion: "0", ruleReleaseId: "release-new", priceVersionId: "price-new" } };
        else if (path.endsWith("/policy-drafts")) result = { id: "new-draft", version: "1", status: "DRAFT", payloadHash: "a".repeat(64), publishable: false, warnings: mode === "not-publishable" ? ["CONFIG_PENDING"] : [], unifiedPricing: { knowledge: "KNOWN" } };
        else if (path.endsWith("/requests")) result = { requestId: "new-approval", approvalRequestId: "new-approval" };
        else if (path.endsWith("/decision") && mode === "response-unknown") throw Error("FIXTURE_RESPONSE_LOST");
        else if (path.endsWith("/execute")) { executed = true; result = { status: "EXECUTED", executionStatus: "SUCCEEDED", resultCode: "MEMBERSHIP_POLICY_PUBLISHED", businessResultRef: "new-policy" }; }
        else if (path.endsWith("/detail")) result = { status: "EXECUTED", decision: { decision: "APPROVED", approver: { id: mode === "readback-differs" ? "old-boss" : "new-boss-2" } }, execution: { status: "SUCCEEDED", resultCode: "MEMBERSHIP_POLICY_PUBLISHED", resultDetail: "new-policy", executor: { id: "new-boss-1" } } };
        return new Response(JSON.stringify(result), { status: 200, headers });
    };
    const selectedTemplate = mode === "test-policy-success" ? buildLocalTestPolicyTemplate(policyBase(), sourceRef) : template;
    const target = { database: "zzsh_test_regression", oid: "42", nonce: "fixture" }, provenance = { inputSha256: "a".repeat(64) };
    const receipt = await runPolicyInitialization({ profile, template: selectedTemplate, effectiveAtUtc, now, apiOrigin: "http://127.0.0.1:4282", commandKeyPrefix: "scene-policy-fixed-command", fetcher: fakeFetch, target, provenance, write: (file, value) => files.set(file, structuredClone(value)) });
    assert.equal(receipt.resourceLockTaken, false); assert.equal(receipt.oldApprovalsCopied, false); assert.equal(receipt.productionOperatingPolicy, false);
    assert.deepEqual(receipt.target, target); assert.deepEqual(receipt.provenance, provenance);
    assert.ok(Number.isFinite(Date.parse(receipt.startedAt)) && Number.isFinite(Date.parse(receipt.finishedAt)) && receipt.wallMs >= 0);
    assert.ok(receipt.steps.every(step => Number.isFinite(Date.parse(step.startedAt)) && Number.isFinite(Date.parse(step.finishedAt)) && step.wallMs >= 0));
    const writes = calls.filter(call => call.key);
    assert.equal(new Set(writes.map(call => call.key)).size, writes.length);
    const decision = calls.find(call => call.path.endsWith("/decision")), execute = calls.find(call => call.path.endsWith("/execute"));
    if (decision) { assert.equal(decision.actor, "2"); assert.equal(decision.body.requestId, "new-approval"); assert.match(decision.body.totpCode, /^\d{6}$/); }
    if (execute) { assert.equal(execute.actor, "1"); assert.equal(execute.body.requestId, "new-approval"); }
    if (mode === "success" || mode === "test-policy-success") {
        assert.equal(receipt.status, "FORMAL_LOCAL_POLICY_INITIALIZED"); assert.equal(receipt.policyId, "new-policy");
        assert.equal(calls.find(call => call.path.endsWith("/templates/update")).body.candidateUsernames[0], "zz00002");
        assert.equal(calls.find(call => call.path.endsWith("/requests")).body.payload.policyDraftId, "new-draft");
        if (mode === "test-policy-success") {
            const draft = calls.find(call => call.path.endsWith("/policy-drafts")).body;
            assert.equal(draft.policy.tiers.GOLD.pricing.ordinary.payableRatio, "0.96");
            assert.equal(draft.policy.tiers.GOLD.depositAllowanceCents, "10000");
            assert.equal(draft.policy.tiers.DIAMOND.tenantDeposit, "WAIVED");
            assert.equal(draft.sourceRef, sourceRef);
        }
    } else if (mode === "existing-policy") {
        assert.equal(receipt.status, "STOPPED_REJECTED_OR_READBACK_DIFFERS");
        assert.equal(receipt.error.code, "FRESH_POLICY_WORKSPACE_AND_SAME_RELEASE_REQUIRED");
        assert.equal(calls.some(call => call.path.endsWith("/policy-drafts")), false);
    } else if (mode === "response-unknown") {
        assert.equal(receipt.status, "STOPPED_HTTP_RESULT_UNKNOWN"); assert.equal(execute, undefined);
        assert.ok(receipt.pending?.wallMs >= 0 && Number.isFinite(Date.parse(receipt.pending.finishedAt)));
        assert.equal(calls.filter(call => call.path.endsWith("/decision")).length, 1);
        assert.match(receipt.retryPolicy, /no automatic retry/);
    } else if (mode === "not-publishable") {
        assert.equal(receipt.status, "STOPPED_REJECTED_OR_READBACK_DIFFERS"); assert.equal(decision, undefined); assert.equal(execute, undefined);
    } else { assert.equal(receipt.status, "STOPPED_REJECTED_OR_READBACK_DIFFERS"); assert.equal(receipt.error.code, "NEW_POLICY_AND_APPROVAL_READBACK_DIFFERS"); }
    assert.ok(files.has("http-exchanges.json")); assert.ok(files.has("receipt.json"));
});
