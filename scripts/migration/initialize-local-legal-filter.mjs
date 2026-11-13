import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LocalSession, localOrigin, validateProfile, writePrivate } from '../local-auth.mjs';
import { deriveR07FilterConfig, parseRegionWordList } from './legacy-region-coverage.mjs';
import { NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';

// Local R06 formal HTTP initialization only. No DB connection or advisory lock.
const restricted = 'E:/zzsh-local-state/restricted';
const runtime = 'E:/zzsh-local-state/runtime';
const defaults = {
  terms: 'E:/zzsh/zzsh/tmp/legal-drafting-20261104/release-01/平台服务协议-20261104.txt',
  privacy: 'E:/zzsh/zzsh/tmp/legal-drafting-20261104/release-01/用户隐私政策-20261104.txt',
  filter: 'E:/zzsh-local-state/restricted/data-first-bootstrap-round04-filter-01/config.json',
  businessManifest: 'E:/zzsh-local-state/restricted/data-first-bootstrap-20261103-business-02-coffee-clean-r06-20261105/manifest.json',
  registry: 'E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/regression_test/resource.json',
  buildManifest: 'D:/CodexWorktrees/admin-finance-clarity-20261105/zzsh/tmp/r06-preview-build-20261105/build-manifest-v3.json',
};
const sourceHashes = {
  terms: '454a4c022f955042049c0aac73a94f76a18344b90f410f51d4ae6ceb3cca0a7c',
  privacy: 'cb9cfb39cdeb6a5e75b08618b3e7bbf7bed0f5057e05bdb536bd6cc999a17cbd',
  filter: '7bce263322c03bc2e64961912be5cc7a64862b3fc9349a50ed5506dc19ff382a',
  businessManifest: 'eda1cd485dace33a901953b3a13cee7eb3fa886be073e2541a3db307c29ff2f3',
};
const docSpecs = [
  { key: 'terms', type: 'PLATFORM_TERMS', title: '平台服务协议' },
  { key: 'privacy', type: 'PLATFORM_PRIVACY', title: '用户隐私政策' },
];
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const normalize = value => value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
const json = bytes => JSON.parse(bytes.toString('utf8'));
const pin = path => { const file = realpathSync(path); return { path: file, sha256: digest(readFileSync(file)) }; };
const readPin = ref => { assert(ref && hash(ref.sha256), 'PIN_REQUIRED'); const bytes = readFileSync(ref.path); assert.equal(digest(bytes), ref.sha256, 'PIN_CHANGED'); return bytes; };
function within(root, path) {
  const part = relative(realpathSync(root), realpathSync(path));
  return Boolean(part && !part.startsWith('..') && !isAbsolute(part));
}
function newPrivateDir(path) {
  const out = resolve(path), parent = realpathSync(dirname(out));
  assert.equal(parent.toLowerCase(), realpathSync(restricted).toLowerCase(), 'RESTRICTED_OUTPUT_REQUIRED');
  assert(/^round0[67]-legal-filter-[a-z0-9-]+$/i.test(basename(out)), 'OUTPUT_NAME_INVALID');
  mkdirSync(out, { mode: 0o700 });
  return out;
}
function tableRows(manifest, manifestPath, table) {
  const matches = manifest.tables?.filter(row => row.schema === 'zzsh_supply' && row.table === table);
  assert(matches?.length === 1 && /^[A-Za-z0-9._-]+\.json$/.test(matches[0].file), 'BUSINESS_TABLE_MISSING');
  const ref = { path: join(dirname(manifestPath), matches[0].file), sha256: matches[0].sha256 };
  const file = json(readPin(ref));
  assert(file.schema === 'zzsh_supply' && file.table === table && Array.isArray(file.rows) && file.rows.length === matches[0].rows, 'BUSINESS_TABLE_CHANGED');
  return file.rows.map(row => typeof row === 'string' ? JSON.parse(row) : row);
}

/** Validate sealed R06 identity, fresh runtime, source bytes and all seed references. */
export function validateInputs(plan, read = readPin, { expectedHashes = sourceHashes, tableRead = tableRows } = {}) {
  const r07 = plan?.schema === 'zzsh.round07-legal-filter-plan.v1';
  assert((r07 || plan?.schema === 'zzsh.round06-legal-filter-plan.v1') && plan.refs && token(plan.filterKey), 'INVALID_PLAN');
  const roundInput=read(plan.refs.roundInput), round=json(roundInput);
  assert.notEqual(round?.target?.migrationProfile, NEXT_MIGRATION_PROFILE, 'NEXT_LEGACY_LEGAL_FILTER_RETIRED');
  const registryBytes=read(plan.refs.registry), registry=json(registryBytes);
  assert.notEqual(registry?.migrationProfile, NEXT_MIGRATION_PROFILE, 'NEXT_LEGACY_LEGAL_FILTER_RETIRED');
  const bytes = Object.fromEntries(Object.entries(plan.refs).map(([name, ref]) => [name,
    name === 'roundInput' ? roundInput : name === 'registry' ? registryBytes : read(ref)]));
  const requiredHashes = r07 ? {...expectedHashes, filter:plan.sourceHashes?.filter, businessManifest:plan.sourceHashes?.businessManifest} : expectedHashes;
  for (const name of Object.keys(requiredHashes)) assert(hash(requiredHashes[name]) && digest(bytes[name]) === requiredHashes[name], 'REVIEWED_SOURCE_CHANGED');
  const core = json(bytes.roundReceipt), binding = json(bytes.binding);
  const actor = json(bytes.actor), profile = validateProfile(json(bytes.profile)), state = json(bytes.session);
  const business = json(bytes.businessReceipt), manifest = json(bytes.businessManifest), config = json(bytes.filter);
  const build = json(bytes.buildManifest);
  const target = round.target, actual = binding.actualResource, resource = binding.resource;
  assert(round.schema === 'zzsh.local-round.v1' && target?.bootstrapReservation === (r07 ? 'ROUND07_BOOTSTRAP_RESERVED' : 'ROUND06_BOOTSTRAP_RESERVED')
    && /^[1-9]\d*$/.test(target.oid ?? '') && /^[a-f0-9]{24}$/.test(target.nonce ?? ''), 'R06_ROUND_TARGET_REQUIRED');
  assert(core.inputSha256 === plan.refs.roundInput.sha256 && core.datasetSha256 === round.dataset?.sha256
    && ['DATASET_AND_GROWTH_ACK_READBACK_PASS', 'DATASET_AND_GROWTH_REVALIDATED_PASS'].includes(core.status)
    && core.completion?.status === 'COMPLETE' && String(core.target?.oid) === target.oid && core.target?.nonce === target.nonce, 'R06_CORE_RECEIPT_REQUIRED');
  assert(binding.status === (r07 ? 'R07_MAINTENANCE_API_LISTENING' : 'R06_MAINTENANCE_API_LISTENING') && binding.roundInputSha256 === plan.refs.roundInput.sha256 && binding.roundReceiptSha256 === plan.refs.roundReceipt.sha256
    && binding.NoIM === true && binding.financialCommandCapabilities === false && binding.workersEnabled === false
    && binding.formalAppMounted === true && binding.maintenanceLockReleased === true && binding.maintenanceClosed === true
    && binding.finalBuildManifestSha256 === plan.refs.buildManifest.sha256 && Number.isSafeInteger(binding.pid) && binding.pid > 0, 'R06_MAINTENANCE_BINDING_REQUIRED');
  const normalPath = value => typeof value === 'string' ? value.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase() : '';
  assert(normalPath(round.apiDist) && normalPath(binding.compiledRoot) === normalPath(round.apiDist)
    && binding.bundleSha256 === round.bootstrapEvidence?.bundle?.sha256
    && round.dependencyBinding?.buildManifest?.sha256 === plan.refs.buildManifest.sha256, 'R06_LOADED_BUILD_MISMATCH');
  assert(typeof build.layout?.apiDistDir === 'string' && Array.isArray(build.components?.api) && round.buildFiles && typeof round.buildFiles === 'object', 'R06_BUILD_MANIFEST_REQUIRED');
  const prefix = build.layout.apiDistDir + '/';
  const buildFiles = build.components.api.filter(row => typeof row.path === 'string' && row.path.startsWith(prefix) && row.path.endsWith('.js'));
  const buildMap = new Map(buildFiles.map(row => [row.path.slice(prefix.length), row.sha256]));
  assert(buildMap.size === buildFiles.length && buildMap.size === Object.keys(round.buildFiles).length
    && [...buildMap].every(([path,sha]) => hash(sha) && round.buildFiles[path] === sha), 'R06_ROUND_BUILD_MISMATCH');
  for (const r of [resource, actual]) assert(r?.database === 'zzsh_test_regression' && String(r.oid ?? r.resourceOid) === target.oid
    && r.nonce === target.nonce && r.marker === 'zzsh:regression-test:v1', 'R06_RUNTIME_TARGET_MISMATCH');
  assert(actual.read_only === 'on' && String(actual.migration_role_oid) === String(target.migrationRoleOid), 'R06_RUNTIME_READONLY_PROOF_REQUIRED');
  assert(registry.database === resource.database && registry.marker === resource.marker && String(registry.oid) === target.oid
    && registry.nonce === target.nonce && !registry.pendingReset && String(registry.roles?.migration?.oid) === String(target.migrationRoleOid)
    && registry.roles?.runtime?.name === actual.runtime_role && String(registry.roles?.runtime?.oid) === String(actual.runtime_role_oid), 'R06_REGISTRY_MISMATCH');
  if (r07) {
    const instance = target.instance;
    assert(instance?.host === '127.0.0.1' && Number.isInteger(instance.port) && /^[0-9]+$/.test(instance.systemIdentifier ?? '')
      && [registry.instance, core.target?.instance, resource.instance, actual.instance, business.instance].every(value => sameConfig(value, instance))
      && normalPath(plan.refs.registry.path) === normalPath(join(dirname(round.credentials), 'resource.json')), 'R07_INSTANCE_BINDING_REQUIRED');
    assert(manifest.catalogModel === 'OWNER_KIND_V2', 'R07_CATALOG_PROFILE_REQUIRED');
  }
  const apiOrigin = localOrigin(binding.origins?.apiOrigin);
  assert(Number(new URL(apiOrigin).port) === Number(binding.port), 'R06_RUNTIME_PORT_MISMATCH');
  const boss = profile.actors?.['boss-one'];
  assert(round.actor?.sha256 === plan.refs.actor.sha256 && actor.realm === 'admin' && actor.id === actor.actorId
    && actor.id === boss?.userId && actor.sessionId && String(actor.resourceOid) === target.oid && actor.nonce === target.nonce
    && boss.realm === 'admin' && boss.username?.toLowerCase() === 'zz00001' && Array.isArray(state.cookies), 'R06_BOSS_PROOF_REQUIRED');
  assert(round.bootstrapEvidence?.business?.sha256 === plan.refs.businessReceipt.sha256
    && business.status === 'REFERENCE_BOOTSTRAP_COMMITTED' && String(business.oid) === target.oid && business.nonce === target.nonce
    && business.manifestSha256 === plan.refs.businessManifest.sha256 && business.maintenanceAdminId === actor.id
    && business.commitAck === true && business.poolClosed === true && business.unlock === true && business.maintenanceClosed === true, 'R06_BUSINESS_PROOF_REQUIRED');
  assert(manifest.gameCode === 'delta' && config.schemaVersion === 1 && Array.isArray(config.fields) && Array.isArray(config.sorts), 'SOURCE_CONFIGURATION_INVALID');
  const games = tableRead(manifest, plan.refs.businessManifest.path, 'game');
  const game = games.filter(row => row.code === 'delta' && row.enabled === true);
  assert(game.length === 1 && token(game[0].id), 'R06_DELTA_SEED_REQUIRED');
  const items = tableRead(manifest, plan.refs.businessManifest.path, 'billable_item');
  const itemIds = [...new Set([...config.fields.flatMap(field => (field.items ?? []).map(item => item.itemId)),
    ...config.sorts.flatMap(sort => sort.itemIds ?? [])])];
  assert(itemIds.length > 0 && !config.fields.some(field => field.categoryIds?.length), 'UNMAPPED_FILTER_REFERENCE');
  const selectedItems = itemIds.map(id => {
    const matches = items.filter(item => item.id === id && item.game_id === game[0].id && item.enabled === true);
    assert(matches.length === 1 && token(matches[0].code) && typeof matches[0].name === 'string' && token(matches[0].unit), 'FILTER_ITEM_SEED_MISMATCH');
    return matches[0];
  });
  assert(new Set(selectedItems.map(item => item.code)).size === selectedItems.length, 'FILTER_ITEM_CODE_CONFLICT');
  const documents = Object.fromEntries(docSpecs.map(spec => {
    const body = bytes[spec.key].toString('utf8');
    assert(Buffer.byteLength(normalize(body), 'utf8') <= 20000 && normalize(body).length > 0, 'LEGAL_SOURCE_INVALID');
    return [spec.key, { ...spec, body, digest: digest(normalize(body)), sourceSha256: plan.refs[spec.key].sha256 }];
  }));
  assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(plan.effectiveAtUtc ?? '') && Number.isFinite(Date.parse(plan.effectiveAtUtc)), 'EFFECTIVE_TIME_INVALID');
  for (const spec of docSpecs) assert(token(plan.requestIds?.['draft-' + spec.key]) && token(plan.requestIds?.['seal-' + spec.key]), 'REQUEST_ID_REQUIRED');
  assert(token(plan.requestIds?.filter), 'REQUEST_ID_REQUIRED');
  return { round, core, binding, actor, profile, state, business, config, game: game[0], items: selectedItems, documents, target, apiOrigin };
}

function verifyCatalog(ctx, games, catalog) {
  const matches = games?.games?.filter(row => row.code === 'delta');
  assert(matches?.length === 1 && matches[0].id === ctx.game.id && matches[0].enabled === true
    && catalog?.game?.id === ctx.game.id && catalog.game.code === 'delta' && Array.isArray(catalog.items), 'LIVE_GAME_MISMATCH');
  for (const seed of ctx.items) {
    const rows = catalog.items.filter(row => row.id === seed.id && row.code === seed.code);
    assert(rows.length === 1 && rows[0].name === seed.name && rows[0].unit === seed.unit && rows[0].enabled === true, 'LIVE_FILTER_ITEM_MISMATCH');
  }
}
function checkDocument(row, spec, effectiveAt, status) {
  assert(row?.docType === spec.type && row.title === spec.title && row.digest === spec.digest && row.status === status
    && token(row.id) && typeof row.body === 'string' && digest(row.body) === spec.digest
    && Date.parse(row.effectiveAt) === Date.parse(effectiveAt), 'DOCUMENT_READBACK_MISMATCH');
}
const sameConfig = (a, b) => canonical(a) === canonical(b);
export function checkPublicFilters(config, result) {
  assert(result?.available === true && result.reasonCode === null && Array.isArray(result.fields) && Array.isArray(result.sorts), 'PUBLIC_FILTER_UNAVAILABLE');
  const sameKeys = (left,right) => sameConfig([...left].sort(), [...right].sort());
  const fields = config.fields.filter(field => field.enabled), sorts = config.sorts.filter(sort => sort.enabled);
  assert(sameKeys(fields.map(field=>field.key), result.fields.map(field=>field.key))
    && sameKeys(sorts.map(sort=>sort.key), result.sorts.map(sort=>sort.key)), 'PUBLIC_FILTER_FIELDS_DIFFER');
  for (const field of fields) {
    const matches = result.fields.filter(row=>row.key===field.key); assert(matches.length===1, 'PUBLIC_FILTER_FIELDS_DIFFER');
    const displayed = matches[0];
    if (field.items) assert(sameKeys(field.items.map(row=>row.itemId), (displayed.items ?? []).map(row=>row.itemId)), 'PUBLIC_FILTER_ITEMS_DIFFER');
    if (field.options) assert(sameKeys(field.options.map(row=>row.value), (displayed.options ?? []).map(row=>row.value)), 'PUBLIC_FILTER_OPTIONS_DIFFER');
    if (field.levels) assert(sameKeys(field.levels, displayed.levels ?? []), 'PUBLIC_FILTER_LEVELS_DIFFER');
    if (field.ownerKinds) assert(sameKeys(field.ownerKinds, displayed.ownerKinds ?? []), 'PUBLIC_FILTER_OWNERS_DIFFER');
    if (field.regions) assert(sameKeys(field.regions.map(row=>JSON.stringify([row.province,row.city])), (displayed.regions ?? []).map(row=>JSON.stringify([row.province,row.city]))), 'PUBLIC_FILTER_REGIONS_DIFFER');
    if (field.categoryIds) assert(sameKeys(field.categoryIds, displayed.categoryIds ?? []), 'PUBLIC_FILTER_CATEGORIES_DIFFER');
  }
  for (const sort of sorts) if (sort.itemIds) {
    const rows = result.sorts.filter(row=>row.key===sort.key);
    assert(rows.length===1 && sameKeys(sort.itemIds,rows[0].itemIds ?? []), 'PUBLIC_FILTER_SORT_ITEMS_DIFFER');
  }
}
function makeReceipt(plan, ctx) {
  return { schema: receiptSchema(plan), status: 'STARTED', startedAt: new Date().toISOString(),
    target: { database: ctx.binding.resource.database, oid: ctx.target.oid, nonce: ctx.target.nonce, marker: ctx.binding.resource.marker, ...(ctx.target.instance ? {instance:ctx.target.instance} : {}) },
    roundInputSha256: plan.refs.roundInput.sha256, roundReceiptSha256: plan.refs.roundReceipt.sha256,
    runtimeBindingSha256: plan.refs.binding.sha256, buildManifestSha256: ctx.binding.finalBuildManifestSha256,
    businessManifestSha256: plan.refs.businessManifest.sha256, businessReceiptSha256: plan.refs.businessReceipt.sha256,
    actorId: ctx.actor.id, actorProofSha256: plan.refs.actor.sha256, effectiveAtUtc: plan.effectiveAtUtc,
    legal: {}, filter: { gameId: ctx.game.id, sourceSha256: plan.refs.filter.sha256, matchedItemCount: ctx.items.length, idempotencyKey: plan.filterKey },
    isolation: { loopbackOnly: true, noIM: true, workersEnabled: false, financialCommandCapabilities: false, resourceLockTaken: false,
      maintenanceLockReleased: true, maintenanceClosed: true, maintenanceEvidence: 'RUNTIME_BINDING_AT_START_ONLY', oldAdminReused: false, userAcceptanceWritten: false },
    writeAcksComplete: false, httpWriteInFlight: false, steps: [], pending: null };
}
function receiptSchema(plan) { return plan.schema === 'zzsh.round07-legal-filter-plan.v1' ? 'zzsh.round07-legal-filter-receipt.v1' : 'zzsh.round06-legal-filter-receipt.v1'; }
export function initialSession(ctx, fetcher) {
  let method, extraHeaders;
  const client = new LocalSession(ctx.apiOrigin, 'admin', ctx.state.cookies, (url, options) => fetcher(url, {
    ...options, method: method ?? options.method, headers: { ...options.headers, ...extraHeaders },
  }));
  assert(client.cookies.length > 0, 'R06_BOSS_SESSION_REQUIRED');
  return async ({ path, body, verb, requestId, key }) => {
    method = verb; extraHeaders = { ...(requestId ? { 'X-Request-Id': requestId } : {}), ...(key ? { 'Idempotency-Key': key } : {}) };
    try { return await client.request(path, body); } finally { method = undefined; extraHeaders = undefined; }
  };
}
async function checkedCall(call, path, options = {}) {
  const response = await call({ path, ...options });
  if (response.status !== 200) throw Object.assign(new Error('FORMAL_HTTP_REJECTED'), { httpStatus: response.status });
  return response.body;
}
async function checkSession(call, ctx) {
  const current = await checkedCall(call, '/api/auth/admin/get-session');
  assert(current?.user?.id === ctx.actor.id && current?.session?.id === ctx.actor.sessionId
    && current.user.suspended !== true && current.user.twoFactorEnabled === true, 'R06_BOSS_SESSION_MISMATCH');
}

/** Call only after sealed R06 inputs and live listener proof. Injected calls keep tests offline. */
export async function executeInitialization({ plan, ctx, call, save, listener, now = Date.now, resumeFilter = null }) {
  const filterBody = { expectedRevision: '0', config: ctx.config, reason: plan.schema === 'zzsh.round07-legal-filter-plan.v1' ? '第七轮本地测试初始化筛选配置' : '第六轮本地测试初始化筛选配置' };
  const filterPath = `/api/v1/admin/supply/games/${ctx.game.id}/listing-filters`;
  if (resumeFilter) {
    const pending = resumeFilter.pending;
    assert(resumeFilter.schema === receiptSchema(plan)
      && resumeFilter.status === 'STOPPED_MUTATION_RESULT_UNKNOWN_OR_REJECTED' && resumeFilter.steps?.length === 0
      && Object.keys(resumeFilter.legal ?? {}).length === 0 && resumeFilter.target?.oid === ctx.target.oid
      && sameConfig(resumeFilter.target?.instance ?? null,ctx.target.instance ?? null)
      && resumeFilter.target?.nonce === ctx.target.nonce && resumeFilter.roundInputSha256 === plan.refs.roundInput.sha256
      && resumeFilter.roundReceiptSha256 === plan.refs.roundReceipt.sha256 && resumeFilter.runtimeBindingSha256 === plan.refs.binding.sha256
      && pending?.name === 'filter' && pending.path === filterPath && pending.verb === 'PUT'
      && pending.idempotencyKey === plan.filterKey && pending.requestId === plan.requestIds.filter
      && pending.bodySha256 === digest(JSON.stringify(filterBody))
      && pending.requestFingerprint === digest(JSON.stringify(['supply.listing_filters.save',ctx.game.id,filterBody])), 'ORIGINAL_FILTER_INTENT_REQUIRED');
  }
  const receipt = resumeFilter ? structuredClone(resumeFilter) : makeReceipt(plan, ctx), effective = Date.parse(plan.effectiveAtUtc);
  if (resumeFilter) { receipt.status = 'FILTER_RESUME_STARTED'; receipt.resumeStartedAt = new Date().toISOString(); delete receipt.failure; }
  const started = performance.now();
  const persist = () => save(receipt);
  const get = async path => { await listener(); return checkedCall(call, path); };
  const mutate = async (name, path, body, verb, key) => {
    await listener();
    const requestId = plan.requestIds[name], pending = { name, path, verb, requestId,
      bodySha256: digest(JSON.stringify(body)), ...(key ? { idempotencyKey: key } : {}), startedAt: new Date().toISOString() };
    if (key) pending.requestFingerprint = digest(JSON.stringify(['supply.listing_filters.save', ctx.game.id, body]));
    receipt.pending = pending; receipt.httpWriteInFlight = true; persist();
    let response;
    try { response = await checkedCall(call, path, { body, verb, requestId, key }); }
    catch (error) { receipt.httpWriteInFlight = Number.isInteger(error.httpStatus) ? false : 'UNKNOWN'; throw error; }
    receipt.httpWriteInFlight = false;
    pending.finishedAt = new Date().toISOString(); pending.httpStatus = 200;
    receipt.steps.push(pending); receipt.pending = null; persist();
    return response;
  };
  try {
    persist(); assert(effective - now() >= 90_000, 'EFFECTIVE_WINDOW_TOO_SHORT');
    await listener(); await checkSession(call, ctx);
    const games = await get('/api/v1/admin/supply/games');
    const catalog = await get(`/api/v1/admin/supply/games/${ctx.game.id}/catalog`);
    const before = await get(`/api/v1/admin/supply/games/${ctx.game.id}/listing-filters`);
    const existing = await get('/api/v1/admin/legal-documents');
    const current = await get('/api/v1/legal-documents/current');
    verifyCatalog(ctx, games, catalog);
    assert(before?.gameId === ctx.game.id && Array.isArray(before.history)
      && (before.revision === '0' && before.config === null && before.history.length === 0
        || Boolean(resumeFilter) && before.revision === '1' && sameConfig(before.config, ctx.config)), 'FILTER_NOT_FRESH');
    assert(Array.isArray(existing?.versions) && existing.versions.length < 50 && !existing.versions.some(row => docSpecs.some(spec => spec.type === row.docType))
      && !current?.terms && !current?.privacy, 'LEGAL_NOT_FRESH');
    const filter = await mutate('filter', filterPath, filterBody, 'PUT', plan.filterKey);
    assert(filter?.gameId === ctx.game.id && filter.revision === '1' && sameConfig(filter.config, ctx.config), 'FILTER_WRITE_READBACK_MISMATCH');
    Object.assign(receipt.filter, { revision: filter.revision, configSha256: digest(canonical(filter.config)) }); persist();
    for (const spec of docSpecs) {
      const source = ctx.documents[spec.key];
      const draft = await mutate('draft-' + spec.key, '/api/v1/admin/legal-documents/drafts',
        { docType: spec.type, title: spec.title, body: source.body, effectiveAt: plan.effectiveAtUtc }, 'POST');
      checkDocument(draft, source, plan.effectiveAtUtc, 'DRAFT');
      assert(typeof draft.revision === 'string' && /^[1-9]\d*$/.test(draft.revision), 'DRAFT_REVISION_INVALID');
      receipt.legal[spec.key] = { id: draft.id, revision: draft.revision, digest: source.digest, sourceSha256: source.sourceSha256, status: 'DRAFT' }; persist();
    }
    for (const spec of docSpecs) {
      assert(effective - now() >= 30_000, 'LEGAL_PAIR_WINDOW_EXPIRED');
      const row = receipt.legal[spec.key];
      const sealed = await mutate('seal-' + spec.key, `/api/v1/admin/legal-documents/drafts/${row.id}/seal`, { expectedRevision: row.revision }, 'POST');
      checkDocument(sealed, ctx.documents[spec.key], plan.effectiveAtUtc, 'SEALED');
      assert(sealed.id === row.id, 'SEALED_DOCUMENT_ID_CHANGED'); row.status = 'SEALED'; row.effectiveAt = sealed.effectiveAt; persist();
    }
    const after = await get(`/api/v1/admin/supply/games/${ctx.game.id}/listing-filters`);
    const listed = await get('/api/v1/admin/legal-documents');
    assert(after?.revision === '1' && after.gameId === ctx.game.id && sameConfig(after.config, ctx.config), 'FILTER_ADMIN_READBACK_MISMATCH');
    for (const spec of docSpecs) {
      const rows = listed?.versions?.filter(row => row.id === receipt.legal[spec.key].id);
      assert(rows?.length === 1, 'LEGAL_ADMIN_READBACK_MISMATCH'); checkDocument(rows[0], ctx.documents[spec.key], plan.effectiveAtUtc, 'SEALED');
    }
    receipt.writeAcksComplete = true; receipt.status = 'SEALED_AWAITING_EFFECTIVE_PUBLIC_READBACK';
  } catch (error) {
    receipt.status = receipt.pending ? 'STOPPED_MUTATION_RESULT_UNKNOWN_OR_REJECTED' : 'STOPPED_BEFORE_OR_AFTER_ACK';
    receipt.failure = { code: /^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'LOCAL_INITIALIZATION_FAILED',
      ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) };
  } finally { receipt.finishedAt = new Date().toISOString(); receipt.wallMs = performance.now() - started; persist(); }
  return receipt;
}

/** An inspection only reports observations; absence cannot prove a timed-out request did not commit. */
export async function inspectInitialization({ plan, ctx, original, call, listener }) {
  assert(original?.schema === receiptSchema(plan) && original.target?.oid === ctx.target.oid
    && sameConfig(original.target?.instance ?? null,ctx.target.instance ?? null)
    && original.target?.nonce === ctx.target.nonce && original.roundInputSha256 === plan.refs.roundInput.sha256
    && original.runtimeBindingSha256 === plan.refs.binding.sha256, 'ORIGINAL_RECEIPT_MISMATCH');
  await listener(); await checkSession(call, ctx);
  await listener(); const legal = await checkedCall(call, '/api/v1/admin/legal-documents');
  await listener(); const filter = await checkedCall(call, `/api/v1/admin/supply/games/${ctx.game.id}/listing-filters`);
  assert(Array.isArray(legal?.versions) && legal.versions.length < 50 && filter?.gameId === ctx.game.id, 'INSPECTION_READBACK_INCOMPLETE');
  return { schema:plan.schema === 'zzsh.round07-legal-filter-plan.v1' ? 'zzsh.round07-legal-filter-inspection.v1' : 'zzsh.round06-legal-filter-inspection.v1', status:'INSPECTED_NOT_A_SUCCESS_OR_ABSENCE_PROOF',
    target:original.target, originalStatus:original.status, pending:original.pending,
    legal:legal.versions.filter(row=>docSpecs.some(spec=>spec.type===row.docType)).map(row=>({id:row.id,docType:row.docType,status:row.status,digest:row.digest,effectiveAt:row.effectiveAt})),
    filter:{gameId:filter.gameId,revision:filter.revision,configMatches:filter.config !== null && sameConfig(filter.config,ctx.config)},
    inspectedAt:new Date().toISOString(), resourceLockTaken:false };
}

export async function readbackInitialization({ plan, ctx, original, call, listener, now = Date.now }) {
  assert(original.schema === receiptSchema(plan) && original.status === 'SEALED_AWAITING_EFFECTIVE_PUBLIC_READBACK'
    && original.pending === null && original.writeAcksComplete === true && original.httpWriteInFlight === false
    && original.roundInputSha256 === plan.refs.roundInput.sha256
    && original.roundReceiptSha256 === plan.refs.roundReceipt.sha256 && original.runtimeBindingSha256 === plan.refs.binding.sha256
    && original.businessManifestSha256 === plan.refs.businessManifest.sha256 && original.businessReceiptSha256 === plan.refs.businessReceipt.sha256
    && original.buildManifestSha256 === ctx.binding.finalBuildManifestSha256 && original.actorId === ctx.actor.id
    && original.target?.oid === ctx.target.oid && original.target?.nonce === ctx.target.nonce
    && sameConfig(original.target?.instance ?? null,ctx.target.instance ?? null)
    && original.filter?.idempotencyKey === plan.filterKey && original.filter?.gameId === ctx.game.id
    && original.filter?.revision === '1' && original.filter?.sourceSha256 === plan.refs.filter.sha256
    && original.filter?.configSha256 === digest(canonical(ctx.config)) && original.filter?.matchedItemCount === ctx.items.length,
    'ORIGINAL_SEALED_RECEIPT_REQUIRED');
  const expectedSteps = ['filter','draft-terms','draft-privacy','seal-terms','seal-privacy'];
  assert(Array.isArray(original.steps) && original.steps.length === expectedSteps.length
    && expectedSteps.every((name, i) => original.steps[i]?.name === name && original.steps[i]?.requestId === plan.requestIds[name]
      && original.steps[i]?.httpStatus === 200), 'ORIGINAL_MUTATION_ACKS_REQUIRED');
  for (const spec of docSpecs) {
    const entry = original.legal?.[spec.key], doc = ctx.documents[spec.key];
    assert(entry?.status === 'SEALED' && token(entry.id) && entry.digest === doc.digest && entry.sourceSha256 === doc.sourceSha256
      && Date.parse(entry.effectiveAt) === Date.parse(plan.effectiveAtUtc), 'ORIGINAL_SEALED_DOCUMENT_REQUIRED');
  }
  assert(now() >= Date.parse(plan.effectiveAtUtc), 'DOCUMENTS_NOT_YET_EFFECTIVE');
  await listener(); await checkSession(call, ctx);
  const get = async path => { await listener(); return checkedCall(call, path); };
  const current = await get('/api/v1/legal-documents/current');
  const terms = await get('/api/v1/legal-documents/terms');
  const privacy = await get('/api/v1/legal-documents/privacy');
  const admin = await get(`/api/v1/admin/supply/games/${ctx.game.id}/listing-filters`);
  const publicFilters = await get(`/api/v1/supply/games/${ctx.game.id}/listing-filters?skinGrouping=TYPE`);
  const result = structuredClone(original);
  for (const spec of docSpecs) {
    const value = spec.key === 'terms' ? terms : privacy, entry = result.legal[spec.key];
    assert(value?.state === 'PUBLISHED' && value.docType === spec.type && current?.[spec.key]?.id === entry.id
      && current[spec.key].digest === entry.digest && value.document?.id === entry.id, 'PUBLIC_LEGAL_READBACK_MISMATCH');
    checkDocument(value.document, ctx.documents[spec.key], plan.effectiveAtUtc, 'SEALED');
    Object.assign(entry, { publicState: value.state, publicId: value.document.id, publicDigest: value.document.digest });
  }
  assert(admin?.gameId === ctx.game.id && admin.revision === '1' && sameConfig(admin.config, ctx.config)
    && publicFilters?.gameId === ctx.game.id && publicFilters.filterRevision === '1', 'PUBLIC_FILTER_READBACK_MISMATCH');
  checkPublicFilters(ctx.config, publicFilters);
  Object.assign(result.filter, { publicRevision: publicFilters.filterRevision, available:true, reasonCode:null, publicProjectionMatches:true });
  result.status = 'FORMAL_LOCAL_LEGAL_FILTER_INITIALIZED'; result.finishedAt = new Date().toISOString();
  result.readbackAt = result.finishedAt; return result;
}

function listenerProof(binding, refs) {
  const port = Number(new URL(localOrigin(binding.origins.apiOrigin)).port);
  const script = `$c=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue);if($c.Count -ne 1){throw 'listener'};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c[0].OwningProcess);if(!$p){throw 'process'};[pscustomobject]@{pid=[int]$p.ProcessId;address=$c[0].LocalAddress;started=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`;
  let first;
  return async () => {
    readPin(refs.binding); readPin(refs.registry);
    assert(binding.stopFile && !existsSync(binding.stopFile), 'R06_STOP_REQUESTED');
    const observed = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
    assert(observed.pid === binding.pid && observed.address === '127.0.0.1' && Date.parse(observed.started) <= Date.parse(binding.at), 'R06_LISTENER_CHANGED');
    if (first) assert.equal(observed.started, first, 'R06_LISTENER_RESTARTED'); else first = observed.started;
  };
}

function parseOptions(args) {
  const names = ['round-input','round-receipt','binding','profile','actor','session','business-receipt','business-manifest','business-manifest-sha','build-manifest','terms','privacy','filter','filter-sha','filter-baseline','filter-baseline-sha','region-wordlist-sha','registry','effective-at','input','input-sha','receipt','receipt-sha','out'];
  return parseArgs({ args, options: Object.fromEntries([...names.map(name => [name, { type: 'string' }]),
    ...['derive-filter','prepare','execute','resume-filter','inspect','readback'].map(name => [name, { type: 'boolean' }])]) }).values;
}
function requireLocalRefs(refs) {
  for (const name of ['roundInput','roundReceipt','profile','actor','session','businessReceipt','businessManifest','filter'])
    assert(within(restricted, refs[name].path), 'RESTRICTED_REFERENCE_REQUIRED');
  assert(within(runtime, refs.binding.path), 'RUNTIME_REFERENCE_REQUIRED');
  assert(within(restricted, refs.registry.path) || existsSync(defaults.registry) && realpathSync(refs.registry.path).toLowerCase() === realpathSync(defaults.registry).toLowerCase(), 'REGISTERED_RESOURCE_REQUIRED');
}
function assertAttemptReceipt(planFile, planSha, receiptFile, resumedAllowed) {
  const dir = dirname(resolve(planFile)), expected = ['execute-attempt.json', ...(resumedAllowed ? ['resume-filter-attempt.json'] : [])];
  assert(within(restricted, receiptFile), 'RESTRICTED_RECEIPT_REQUIRED');
  const matches = expected.filter(name => {
    const file = join(dir,name); if (!existsSync(file)) return false;
    const marker = json(readFileSync(file));
    return marker.planSha256 === planSha && resolve(marker.output, 'receipt.json').toLowerCase() === resolve(receiptFile).toLowerCase();
  });
  assert(matches.length === 1, 'ORIGINAL_ATTEMPT_RECEIPT_REQUIRED');
}
async function main() {
  const v = parseOptions(process.argv.slice(2));
  assert([v['derive-filter'], v.prepare, v.execute, v['resume-filter'], v.inspect, v.readback].filter(Boolean).length <= 1, 'ONE_ACTION_REQUIRED');
  if (!v['derive-filter'] && !v.prepare && !v.execute && !v['resume-filter'] && !v.inspect && !v.readback) {
    console.log(JSON.stringify({ status: 'PLAN_ONLY', actions: ['--derive-filter','--prepare','--execute','--resume-filter','--inspect','--readback'], databaseConnections: 0, httpCalls: 0 })); return;
  }
  assert(process.version === 'v24.20.0', 'NODE_BASELINE_MISMATCH');
  if (v['derive-filter']) {
    const wordlist=resolve(dirname(fileURLToPath(import.meta.url)),'../../apps/web/src/lib/delta-region-options.ts');
    assert(v['filter-baseline'] && within(restricted,v['filter-baseline']) && hash(v['filter-baseline-sha']) && hash(v['region-wordlist-sha']) && v.out,'FILTER_DERIVATION_ARGUMENTS_REQUIRED');
    const baseline=readFileSync(v['filter-baseline']),words=readFileSync(wordlist);
    assert(digest(baseline)===v['filter-baseline-sha'] && v['filter-baseline-sha']===sourceHashes.filter && digest(words)===v['region-wordlist-sha'],'FILTER_DERIVATION_SOURCE_CHANGED');
    const wordList=parseRegionWordList(words.toString('utf8')),config=deriveR07FilterConfig(json(baseline),wordList),out=newPrivateDir(v.out);
    writePrivate(join(out,'config.json'),config);
    const receipt={status:'R07_FILTER_DERIVED_NOT_APPLIED',baselineSha256:digest(baseline),wordListSha256:digest(words),regionDigest:wordList.digest,regions:wordList.pairs.length,
      configSha256:digest(readFileSync(join(out,'config.json'))),databaseConnections:0,httpCalls:0};
    writePrivate(join(out,'receipt.json'),receipt);console.log(JSON.stringify(receipt));return;
  }
  if (v.prepare) {
    const paths = { roundInput: v['round-input'], roundReceipt: v['round-receipt'], binding: v.binding, profile: v.profile, actor: v.actor,
      session: v.session, businessReceipt: v['business-receipt'], businessManifest: v['business-manifest'] ?? defaults.businessManifest,
      terms: v.terms ?? defaults.terms, privacy: v.privacy ?? defaults.privacy, filter: v.filter ?? defaults.filter,
      buildManifest: v['build-manifest'] ?? defaults.buildManifest, registry: v.registry ?? defaults.registry };
    assert(Object.values(paths).every(Boolean) && v['effective-at'] && v.out, 'PREPARE_ARGUMENTS_REQUIRED');
    const refs = Object.fromEntries(Object.entries(paths).map(([name,path]) => [name,pin(path)])); requireLocalRefs(refs);
    const r07=Boolean(v.registry),prefix=r07?'r07':'r06';
    if(r07) assert(v.filter && v['business-manifest'] && v['build-manifest'] && hash(v['filter-sha']) && hash(v['business-manifest-sha']) && refs.filter.sha256===v['filter-sha'] && refs.businessManifest.sha256===v['business-manifest-sha'], 'R07_EXPLICIT_SOURCE_HASHES_REQUIRED');
    const requestIds = Object.fromEntries(['filter','draft-terms','draft-privacy','seal-terms','seal-privacy'].map(name => [name,prefix+'_' + name.replaceAll('-','_') + '_' + randomUUID().replaceAll('-','')]));
    const plan = { schema: r07?'zzsh.round07-legal-filter-plan.v1':'zzsh.round06-legal-filter-plan.v1', refs, ...(r07?{sourceHashes:{filter:v['filter-sha'],businessManifest:v['business-manifest-sha']}}:{}), effectiveAtUtc: v['effective-at'], filterKey: prefix+'_filter_' + randomUUID().replaceAll('-',''), requestIds };
    validateInputs(plan); assert(Date.parse(plan.effectiveAtUtc) - Date.now() >= 90_000, 'EFFECTIVE_WINDOW_TOO_SHORT');
    const out = newPrivateDir(v.out); writePrivate(join(out,'plan.json'), plan);
    console.log(JSON.stringify({ status: 'PLAN_SEALED_NOT_APPLIED', path: join(out,'plan.json'), sha256: digest(readFileSync(join(out,'plan.json'))), databaseConnections: 0, httpCalls: 0 })); return;
  }
  assert(v.input && hash(v['input-sha']) && v.out, 'PINNED_INPUT_REQUIRED');
  assert(within(restricted, v.input), 'RESTRICTED_PLAN_REQUIRED');
  const planBytes = readFileSync(v.input); assert.equal(digest(planBytes), v['input-sha'], 'PLAN_SHA_CHANGED');
  const plan = json(planBytes); requireLocalRefs(plan.refs); const ctx = validateInputs(plan);
  const call = initialSession(ctx, fetch), listener = listenerProof(ctx.binding, plan.refs);
  const out = newPrivateDir(v.out);
  if (v.execute || v['resume-filter']) {
    // One attempt per sealed plan; a crash must be inspected, not silently restarted.
    const mark = join(dirname(resolve(v.input)), v.execute ? 'execute-attempt.json' : 'resume-filter-attempt.json');
    let original = null;
    if (v['resume-filter']) {
      assert(v.receipt && hash(v['receipt-sha']) && existsSync(join(dirname(resolve(v.input)), 'execute-attempt.json')), 'ORIGINAL_ATTEMPT_REQUIRED');
      assertAttemptReceipt(v.input, v['input-sha'], v.receipt, false);
      original = json(readPin({ path:v.receipt, sha256:v['receipt-sha'] }));
    }
    const fd = openSync(mark, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ planSha256: v['input-sha'], output: out, at: new Date().toISOString() }) + '\n'); } finally { closeSync(fd); }
    const receipt = await executeInitialization({ plan, ctx, call, listener, resumeFilter:original, save: value => writePrivate(join(out,'receipt.json'), value) });
    console.log(JSON.stringify({ status: receipt.status, receipt: join(out,'receipt.json'), sha256: digest(readFileSync(join(out,'receipt.json'))), failure: receipt.failure ?? null }));
    if (receipt.status !== 'SEALED_AWAITING_EFFECTIVE_PUBLIC_READBACK') process.exitCode = 1; return;
  }
  assert(v.receipt && hash(v['receipt-sha']), 'PINNED_RECEIPT_REQUIRED');
  assertAttemptReceipt(v.input, v['input-sha'], v.receipt, true);
  const original = json(readPin({ path: v.receipt, sha256: v['receipt-sha'] }));
  try {
    const receipt = v.inspect ? await inspectInitialization({ plan, ctx, original, call, listener })
      : await readbackInitialization({ plan, ctx, original, call, listener });
    receipt.originalReceiptSha256 = v['receipt-sha']; writePrivate(join(out,'receipt.json'), receipt);
    console.log(JSON.stringify({ status: receipt.status, receipt: join(out,'receipt.json'), sha256: digest(readFileSync(join(out,'receipt.json'))) }));
  } catch (error) {
    writePrivate(join(out,'receipt.json'), { schema:plan.schema === 'zzsh.round07-legal-filter-plan.v1' ? 'zzsh.round07-legal-filter-readback.v1' : 'zzsh.round06-legal-filter-readback.v1', status:'READBACK_NOT_COMPLETE', originalReceiptSha256:v['receipt-sha'],
      code:/^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'READBACK_FAILED', finishedAt:new Date().toISOString() });
    console.log(JSON.stringify({ status:'READBACK_NOT_COMPLETE', receipt:join(out,'receipt.json') })); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ status:'STOPPED', code:/^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'INPUT_OR_IO_FAILED' })); process.exitCode = 1;
});
