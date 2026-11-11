import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalSession, localOrigin, totp, validateProfile, writePrivate } from "../local-auth.mjs";
import { isRegisteredMigrationInstance, NEXT_MIGRATION_PROFILE } from "./local-target-registry.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const security = "/api/v1/admin/security/approvals/";
const policyPath = "/api/v1/admin/membership-growth/policy";
const operationCode = "membership.benefit.policy.publish", triggerCondition = "membership.policy.publish.requested";
const fail = code => { throw new Error(code); };
const assertLegacyPolicyTarget = target => { if (target?.migrationProfile === NEXT_MIGRATION_PROFILE) fail("NEXT_LEGACY_POLICY_INITIALIZER_RETIRED"); };
const TEST_POLICY_KIND = "LOCAL_TEST_MEMBERSHIP_POLICY_CONTENT_V1";
const testRatios = { STANDARD: "1", SILVER: "0.98", GOLD: "0.96", PLATINUM: "0.94", DIAMOND: "0.92" };
const testDeposits = { STANDARD: ["ACCOUNT_BASE", "0"], SILVER: ["ACCOUNT_BASE", "2000"], GOLD: ["ACCOUNT_BASE", "10000"], PLATINUM: ["WAIVED", "0"], DIAMOND: ["WAIVED", "0"] };

/** A separate, explicitly test-only policy, retaining the sealed release and cost references. */
export function buildLocalTestPolicyTemplate(base, sourceRef, binding = { ruleReleaseId: base?.ruleReleaseId, priceVersionId: base?.priceVersionId }) {
    const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    if (!/^LOCAL_TEST_MEMBERSHIP_[A-Z0-9_]{4,100}$/.test(sourceRef ?? "") || base?.policy?.status !== "DRAFT"
      || base.policy.pricingScope !== "ALL_ENABLED_RENTAL_MODES" || base.versionNo !== 1 || base.expectedVersion !== "0"
      || !validId(base.ruleReleaseId) || !validId(base.priceVersionId) || !validId(binding.ruleReleaseId) || !validId(binding.priceVersionId)) fail("TEST_POLICY_BASE_OR_SOURCE_INVALID");
    const template = structuredClone(base), policy = template.policy;
    let expectedModes;
    for (const [tier, ratio] of Object.entries(testRatios)) {
        const row = policy.tiers?.[tier];
        if (!row || row.tier !== tier || !row.pricing || !Object.keys(row.pricing).length) fail("TEST_POLICY_TIER_NOT_CONFIGURED");
        const modes = Object.keys(row.pricing).sort().join(",");
        if (expectedModes !== undefined && expectedModes !== modes) fail("TEST_POLICY_MODE_COVERAGE_DIFFERS");
        expectedModes = modes;
        for (const [mode, contract] of Object.entries(row.pricing)) {
            if (!["ordinary", "custom", "fast"].includes(mode) || contract?.status !== "CONFIGURED" || contract.kind !== "TOTAL_DISCOUNT"
              || contract.mode !== mode || contract.priceVersionId !== base.priceVersionId || !contract.costBasisRef) fail("TEST_POLICY_PRICE_BASIS_MISMATCH");
            contract.payableRatio = ratio; contract.priceVersionId = binding.priceVersionId; contract.costBasisRef = binding.priceVersionId;
        }
        [row.tenantDeposit, row.depositAllowanceCents] = testDeposits[tier];
        delete row.entitlementCap;
    }
    const modes = expectedModes.split(",");
    policy.entitlementRanges = Object.fromEntries(["FRIEND", "PRESTIGE"].map(kind => [kind, { byMode: Object.fromEntries(modes.map(mode => [mode,
      { status: "CONFIGURED", kind: "TOTAL_DISCOUNT_RANGE", mode, priceVersionId: binding.priceVersionId, costBasisRef: binding.priceVersionId, minPayableRatio: "1", maxPayableRatio: "1" }])) }]));
    delete policy.entitlementCaps;
    template.ruleReleaseId = binding.ruleReleaseId; template.priceVersionId = binding.priceVersionId;
    // A fresh local test policy cannot silently present the old test-policy identity as its own source.
    template.sourceRef = sourceRef; policy.sourceRef = sourceRef; policy.version = sourceRef;
    return template;
}

/** Legacy reviewed content remains valid; new test content must explicitly bind its template and release. */
export function validatePolicyContent(content, templateBytes) {
    if (content?.newApprovalRequired !== true || sha(templateBytes) !== content.draftInputTemplateSha256) fail("REVIEWED_TEST_ONLY_POLICY_CONTENT_REQUIRED");
    const template = JSON.parse(templateBytes);
    if (content.kind !== TEST_POLICY_KIND && content.selected?.sourceRef === "TEST_ONLY_FAST_LOCAL_20261028_1"
      && template.policy?.sourceRef === content.selected.sourceRef) return template;
    if (content.kind !== TEST_POLICY_KIND || content.productionOperatingPolicy !== false
      || !/^LOCAL_TEST_MEMBERSHIP_[A-Z0-9_]{4,100}$/.test(content.selected?.sourceRef ?? "")
      || template.sourceRef !== content.selected.sourceRef || template.policy?.sourceRef !== content.selected.sourceRef
      || template.policy?.version !== content.selected.sourceRef || template.policy?.status !== "DRAFT"
      || template.policy?.pricingScope !== "ALL_ENABLED_RENTAL_MODES"
      || template.ruleReleaseId !== content.ruleReleaseId || template.priceVersionId !== content.priceVersionId
      || !/^[a-f0-9]{64}$/.test(content.baseTemplateSha256 ?? "")) fail("REVIEWED_TEST_ONLY_POLICY_CONTENT_REQUIRED");
    for (const tier of Object.keys(testRatios)) {
        const contracts = template.policy.tiers?.[tier]?.pricing;
        if (!contracts || !Object.keys(contracts).length || Object.values(contracts).some(contract => contract?.priceVersionId !== template.priceVersionId || contract.costBasisRef !== template.priceVersionId)) fail("REVIEWED_TEST_ONLY_POLICY_CONTENT_REQUIRED");
    }
    for (const kind of ["FRIEND", "PRESTIGE"]) {
        const contracts = template.policy.entitlementRanges?.[kind]?.byMode;
        if (!contracts || !Object.keys(contracts).length || Object.values(contracts).some(contract => contract?.priceVersionId !== template.priceVersionId || contract.costBasisRef !== template.priceVersionId)) fail("REVIEWED_TEST_ONLY_POLICY_CONTENT_REQUIRED");
    }
    return template;
}

export function assertPolicyProfileBinding(content, input, profileBytes) {
    if ((content.kind === TEST_POLICY_KIND || input.profileSha256 !== undefined)
      && (!/^[a-f0-9]{64}$/.test(input.profileSha256 ?? "") || sha(profileBytes) !== input.profileSha256)) fail("EXACT_POLICY_ACTOR_PROFILE_SHA_REQUIRED");
}

/** A seventh-round policy may only use the independently registered local runtime. */
export function assertPolicyRuntimeBinding(input, binding, bindingBytes) {
    if (sha(bindingBytes) !== input.serverBinding.sha256 || binding.resource?.database !== input.target.database || String(binding.resource.oid ?? binding.resource.resourceOid) !== input.target.oid || binding.resource.nonce !== input.target.nonce || binding.NoIM !== true || binding.imProvisioner !== false || binding.imIdentityRepository !== false || binding.imAppId !== false) fail("EXACT_OPENED_NO_IM_RUNTIME_BINDING_REQUIRED");
    if (input.target.instance || binding.status === "R07_BOOTSTRAP_API_LISTENING") {
        const instance = input.target.instance, equal = value => value?.host === instance.host && value?.port === instance.port && value?.systemIdentifier === instance.systemIdentifier;
        if (!isRegisteredMigrationInstance({ host: instance?.host, port: instance?.port, instance, migrationProfile: input.target.migrationProfile })
          || !/^[1-9][0-9]*$/.test(input.target.migrationRoleOid ?? "")
          || [binding.resource,binding.actualResource].some(value=>(value?.migrationProfile??null)!==(input.target.migrationProfile??null))
          || !equal(binding.resource.instance) || !equal(binding.actualResource?.instance) || binding.status !== "R07_BOOTSTRAP_API_LISTENING"
          || binding.port !== 4242 || binding.origins?.apiOrigin !== "http://127.0.0.1:4242"
          || binding.actualResource?.read_only !== "on" || String(binding.actualResource?.migration_role_oid) !== String(input.target.migrationRoleOid)
          || binding.formalAppMounted !== true || binding.financialCommandCapabilities !== false || binding.workersEnabled !== false
          || binding.maintenanceLockReleased !== true || binding.maintenanceClosed !== true) fail("R07_POLICY_RUNTIME_BINDING_REQUIRED");
    }
}

export function buildPolicyDraft(template, effectiveAtUtc, now = Date.now()) {
    const effective = Date.parse(effectiveAtUtc);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(effectiveAtUtc ?? "") || !Number.isFinite(effective) || Math.abs(effective - now) > 5 * 60_000) fail("ROOT_CURRENT_EFFECTIVE_UTC_REQUIRED");
    if (template?.policy?.status !== "DRAFT" || template.policy.pricingScope !== "ALL_ENABLED_RENTAL_MODES" || template.versionNo !== 1 || template.expectedVersion !== "0" || !template.ruleReleaseId || !template.priceVersionId || !template.sourceRef) fail("REVIEWED_UNIFIED_POLICY_TEMPLATE_REQUIRED");
    return { ...template, effectiveAtUtc, policy: { ...template.policy, effectiveAt: effectiveAtUtc } };
}

/** Fixed formal policy flow; authority and idempotency stay in the existing API. No database or resource lock. */
export async function runPolicyInitialization({ profile, template, effectiveAtUtc, apiOrigin, commandKeyPrefix, write, fetcher = fetch, now = Date.now(), target, provenance }) {
    assertLegacyPolicyTarget(target);
    const started = performance.now(), startedAt = new Date().toISOString();
    validateProfile(profile); apiOrigin = localOrigin(apiOrigin);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,88}$/.test(commandKeyPrefix ?? "")) fail("STABLE_POLICY_COMMAND_PREFIX_REQUIRED");
    const first = profile.actors["boss-one"], second = profile.actors["boss-two"];
    if (!first || !second || first.realm !== "admin" || second.realm !== "admin" || first.userId === second.userId || first.username.toLowerCase() !== "zz00001" || second.username.toLowerCase() !== "zz00002") fail("EXACT_NEW_TWO_BOSS_PROFILE_REQUIRED");
    const draftInput = buildPolicyDraft(template, effectiveAtUtc, now);
    const receipt = { status: "STARTED", startedAt, ...(target ? { target } : {}), ...(provenance ? { provenance } : {}), effectiveAtUtc, commandKeyPrefix, steps: [], oldApprovalsCopied: false, resourceLockTaken: false, productionOperatingPolicy: false,
      policySourceRef: template.sourceRef, ruleReleaseId: template.ruleReleaseId, priceVersionId: template.priceVersionId };
    const exchanges = [];
    let pending, idempotencyKey;
    const session = () => new LocalSession(apiOrigin, "admin", [], (url, options) => fetcher(url, { ...options, headers: { ...options.headers, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) } }));
    const call = async (client, step, path, body, key) => {
        const stepStarted = performance.now();
        idempotencyKey = key; pending = { step, path, startedAt: new Date().toISOString(), ...(key ? { idempotencyKey: key } : {}), ...(body === undefined ? {} : { bodySha256: sha(JSON.stringify(body)) }) };
        receipt.pending = pending; write("receipt.json", receipt);
        const exchange = { ...pending, requestBody: body }; exchanges.push(exchange); write("http-exchanges.json", exchanges);
        try {
            const result = await client.request(path, body);
            Object.assign(exchange, { httpStatus: result.status, responseBody: result.body, storageState: client.state() }); write("http-exchanges.json", exchanges);
            pending.httpStatus = result.status; receipt.steps.push(pending); delete receipt.pending; write("receipt.json", receipt);
            if (result.status !== 200) fail("FORMAL_POLICY_HTTP_" + result.status);
            return result.body;
        } finally {
            pending.finishedAt = new Date().toISOString(); pending.wallMs = performance.now() - stepStarted; write("receipt.json", receipt);
        }
    };
    async function login(actor, alias) {
        const client = session();
        const signedIn = await call(client, alias + ":sign-in", "/api/auth/admin/sign-in/username", { username: actor.username, password: actor.password });
        if (signedIn.twoFactorRedirect) await call(client, alias + ":totp", "/api/auth/admin/two-factor/verify-totp", { code: totp(actor.totp) });
        const current = await call(client, alias + ":session", "/api/auth/admin/get-session");
        if (current?.user?.id !== actor.userId || current.user.suspended || current.user.twoFactorEnabled !== true) fail("NEW_BOSS_SESSION_IDENTITY_REQUIRED");
        return client;
    }
    try {
        write("draft-input.json", draftInput);
        const bossOne = await login(first, "boss-one"), bossTwo = await login(second, "boss-two");
        const before = await call(bossOne, "workspace-before", policyPath);
        if (before.meta !== null || before.approvedMeta !== null || before.bootstrap?.expectedVersion !== "0" || before.bootstrap.ruleReleaseId !== draftInput.ruleReleaseId || before.bootstrap.priceVersionId !== draftInput.priceVersionId) fail("FRESH_POLICY_WORKSPACE_AND_SAME_RELEASE_REQUIRED");
        const draft = await call(bossOne, "save-draft", "/api/v1/admin/membership-growth/policy-drafts", draftInput);
        if (!draft.id || draft.version !== "1" || draft.status !== "DRAFT" || !/^[a-f0-9]{64}$/.test(draft.payloadHash ?? "") || !Array.isArray(draft.warnings) || draft.warnings.length || draft.unifiedPricing?.knowledge !== "KNOWN") fail("NEW_COMPLETE_UNIFIED_DRAFT_RECEIPT_REQUIRED");
        // DRAFT status makes the current API's publishable flag false; request creation validates the APPROVED candidate.
        receipt.draft = { id: draft.id, version: draft.version, payloadHash: draft.payloadHash, serverPublishableFlag: draft.publishable };
        await call(bossOne, "configure-new-candidate", security + "templates/update", { operationCode, triggerCondition, candidateUsernames: [second.username] }, commandKeyPrefix + ":template");
        const created = await call(bossOne, "request-policy", security + "requests", {
            operationCode, triggerCondition, payloadVersion: 1,
            payload: { policyDraftId: draft.id, policyDraftVersion: 1, policyDraftHash: draft.payloadHash, ruleReleaseId: draftInput.ruleReleaseId, priceVersionId: draftInput.priceVersionId, sourceRef: draftInput.sourceRef, effectiveAtUtc },
            summary: "本地场景会员政策重新审批，不承接旧审批或宣称生产经营政策",
        }, commandKeyPrefix + ":request");
        const requestId = created.approvalRequestId;
        if (!requestId || created.requestId !== requestId) fail("NEW_APPROVAL_REQUEST_ID_REQUIRED");
        receipt.approvalRequestId = requestId; write("receipt.json", receipt);
        await call(bossTwo, "boss-two-approve", security + "requests/decision", { requestId, decision: "APPROVE", password: second.password, totpCode: totp(second.totp) }, commandKeyPrefix + ":decision");
        const executed = await call(bossOne, "boss-one-execute", security + "requests/execute", { requestId, password: first.password, totpCode: totp(first.totp) }, commandKeyPrefix + ":execute");
        if (executed.status !== "EXECUTED" || executed.executionStatus !== "SUCCEEDED" || executed.resultCode !== "MEMBERSHIP_POLICY_PUBLISHED" || !executed.businessResultRef) fail("NEW_POLICY_EXECUTION_RECEIPT_REQUIRED");
        const detail = await call(bossOne, "new-approval-readback", security + "requests/detail?requestId=" + encodeURIComponent(requestId));
        const after = await call(bossOne, "new-policy-readback", policyPath);
        if (detail.status !== "EXECUTED" || detail.decision?.decision !== "APPROVED" || detail.decision.approver?.id !== second.userId || detail.execution?.status !== "SUCCEEDED" || detail.execution.resultCode !== "MEMBERSHIP_POLICY_PUBLISHED" || detail.execution.resultDetail !== executed.businessResultRef || detail.execution.executor?.id !== first.userId || after.approvedMeta?.id !== executed.businessResultRef || after.approvedMeta.version !== "1" || after.approvedMeta.ruleReleaseId !== draftInput.ruleReleaseId || after.approvedMeta.priceVersionId !== draftInput.priceVersionId || Date.parse(after.approvedMeta.effectiveAtUtc) !== Date.parse(effectiveAtUtc) || after.approvedPolicy?.status !== "APPROVED") fail("NEW_POLICY_AND_APPROVAL_READBACK_DIFFERS");
        receipt.status = "FORMAL_LOCAL_POLICY_INITIALIZED"; receipt.policyId = executed.businessResultRef; receipt.executionStatus = "SUCCEEDED";
        return receipt;
    } catch (error) {
        receipt.status = exchanges.at(-1)?.httpStatus === undefined ? "STOPPED_HTTP_RESULT_UNKNOWN" : "STOPPED_REJECTED_OR_READBACK_DIFFERS";
        receipt.error = { step: pending?.step ?? null, code: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "FORMAL_POLICY_FAILED" };
        receipt.retryPolicy = "preserve original keys, bodies and target; no automatic retry or fresh request";
        return receipt;
    } finally {
        receipt.finishedAt = new Date().toISOString(); receipt.wallMs = performance.now() - started;
        write("receipt.json", receipt);
    }
}

async function main() {
    const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    if (args.includes("--prepare-test-template")) {
        if (args.includes("--execute")) fail("ONE_POLICY_ACTION_REQUIRED");
        const restricted = realpathSync("E:/zzsh-local-state/restricted"), source = realpathSync(option("--base-template") ?? ""), out = resolve(option("--out") ?? "");
        if (!source.toLowerCase().startsWith(restricted.toLowerCase() + "\\") || dirname(out).toLowerCase() !== restricted.toLowerCase()
          || !/^data-first-bootstrap-[a-z0-9-]+$/i.test(basename(out)) || existsSync(out)) fail("NEW_RESTRICTED_POLICY_OUTPUT_REQUIRED");
        const baseBytes = readFileSync(source), baseSha256 = sha(baseBytes);
        if (baseSha256 !== option("--base-template-sha")) fail("POLICY_BASE_TEMPLATE_SHA_MISMATCH");
        const targetBinding = { ruleReleaseId: option("--rule-release-id"), priceVersionId: option("--price-version-id") };
        const sourceRef = "LOCAL_TEST_MEMBERSHIP_" + sha(JSON.stringify([baseSha256, targetBinding])).slice(0, 16).toUpperCase();
        const template = buildLocalTestPolicyTemplate(JSON.parse(baseBytes), sourceRef, targetBinding);
        const templateSha256 = sha(Buffer.from(JSON.stringify(template, null, 2) + "\n"));
        const manifest = { kind: TEST_POLICY_KIND, newApprovalRequired: true, productionOperatingPolicy: false, selected: { sourceRef },
          baseTemplateSha256: baseSha256, draftInputTemplateSha256: templateSha256, ruleReleaseId: template.ruleReleaseId, priceVersionId: template.priceVersionId };
        writePrivate(join(out, "draft-input-template.json"), template);
        writePrivate(join(out, "manifest.json"), manifest);
        console.log(JSON.stringify({ status: "TEST_POLICY_TEMPLATE_PREPARED_NOT_PUBLISHED", manifest: join(out, "manifest.json"), manifestSha256: sha(readFileSync(join(out, "manifest.json"))), templateSha256, connections: 0, credentialReads: 0, targetWrites: 0, productionOperatingPolicy: false }));
        return;
    }
    if (!args.includes("--execute")) { console.log(JSON.stringify({ action: "PLAN", required: ["--execute", "--input", "--input-sha", "--out"], prepareTestTemplate: ["--prepare-test-template", "--base-template", "--base-template-sha", "--rule-release-id", "--price-version-id", "--out"], routePrefixes: [policyPath, security], feature: "ZZSH_MEMBERSHIP_GROWTH_ENABLED=true", connections: 0, credentialReads: 0, resourceLocks: 0, scope: "new two-Boss formal local TEST_ONLY policy reissue" })); return; }
    if (process.version !== "v24.20.0") fail("NODE_BASELINE_MISMATCH");
    const bytes = readFileSync(option("--input")); if (sha(bytes) !== option("--input-sha")) fail("POLICY_INPUT_SHA_MISMATCH");
    const input = JSON.parse(bytes);
    if (input.kind !== "FORMAL_LOCAL_MEMBERSHIP_POLICY_INITIALIZATION_V1" || input.target?.database !== "zzsh_test_regression" || !input.target.oid || !input.target.nonce) fail("EXACT_POLICY_TARGET_INPUT_REQUIRED");
    assertLegacyPolicyTarget(input.target);
    const bindingBytes = readFileSync(input.serverBinding.file), binding = JSON.parse(bindingBytes);
    assertPolicyRuntimeBinding(input, binding, bindingBytes);
    const contentBytes = readFileSync(input.contentManifest.file); if (sha(contentBytes) !== input.contentManifest.sha256) fail("POLICY_CONTENT_MANIFEST_SHA_MISMATCH");
    const content = JSON.parse(contentBytes), templateFile = join(dirname(resolve(input.contentManifest.file)), "draft-input-template.json"), templateBytes = readFileSync(templateFile);
    const template = validatePolicyContent(content, templateBytes);
    const out = resolve(option("--out")), restricted = realpathSync("E:/zzsh-local-state/restricted");
    if (dirname(out).toLowerCase() !== restricted.toLowerCase() || !/^data-first-bootstrap-[a-z0-9-]+$/i.test(basename(out)) || existsSync(out)) fail("NEW_RESTRICTED_POLICY_OUTPUT_REQUIRED");
    const profileBytes = readFileSync(input.profileFile);
    assertPolicyProfileBinding(content, input, profileBytes);
    const profile = JSON.parse(profileBytes);
    writePrivate(join(out, "input.json"), input);
    const receipt = await runPolicyInitialization({ profile, template, effectiveAtUtc: input.effectiveAtUtc, apiOrigin: binding.origins.apiOrigin, commandKeyPrefix: input.commandKeyPrefix,
      target: input.target, provenance: { inputSha256: sha(bytes), runtimeBindingSha256: sha(bindingBytes), contentManifestSha256: sha(contentBytes) },
      write: (file, value) => writePrivate(join(out, file), value) });
    writePrivate(join(out, "target-binding.json"), { target: input.target, inputSha256: sha(bytes), runtimeBindingSha256: sha(bindingBytes), contentManifestSha256: sha(contentBytes) });
    console.log(JSON.stringify({ status: receipt.status, policyId: receipt.policyId, approvalRequestId: receipt.approvalRequestId, receipt: join(out, "receipt.json"), resourceLocks: 0, productionOperatingPolicy: false, error: receipt.error }));
    if (receipt.status !== "FORMAL_LOCAL_POLICY_INITIALIZED") process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ status: "STOPPED_BEFORE_OR_OUTSIDE_FLOW", code: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "FORMAL_POLICY_INPUT_OR_IO_FAILED" })); process.exitCode = 1; });
