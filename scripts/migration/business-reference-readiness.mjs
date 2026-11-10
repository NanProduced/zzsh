import { createHash } from 'node:crypto';

export const BUSINESS_REFERENCE_TABLES = [
  ...['game', 'game_service_operation', 'firearm_classification', 'firearm_alias', 'full_payout_terms_version', 'billable_item',
    'skin_rarity', 'skin_owner', 'firearm', 'skin', 'price_version', 'price_line', 'term_version', 'term_option',
    'agreement_version', 'rule_release', 'media_asset'].map(name => 'zzsh_supply.' + name),
  'zzsh_content.legal_document_version',
];
export const RENTAL_REFERENCE_TABLES = ['game', 'game_service_operation', 'rule_release', 'price_version', 'term_version',
  'agreement_version', 'full_payout_terms_version', 'billable_item', 'price_line', 'term_option'];

/** Check structural prerequisites for the current rental game before importing a reference package. */
export function assertRentalReferenceReady(tables, gameCode) {
  const fail = code => { throw new Error('BUSINESS_RENTAL_REFERENCE_' + code); };
  if (!(tables instanceof Map) || typeof gameCode !== 'string' || !gameCode) fail('GAME_UNAVAILABLE');
  const rows = name => {
    const value = tables.get('zzsh_supply.' + name);
    if (!Array.isArray(value)) fail('TABLE_MISSING:' + name);
    return value;
  };
  const exactlyOne = (items, code) => items.length === 1 ? items[0] : fail(code);
  const game = exactlyOne(rows('game').filter(row => row.code === gameCode && row.enabled === true), 'GAME_UNAVAILABLE');
  exactlyOne(rows('game_service_operation').filter(row => row.game_id === game.id && row.service_code === 'ACCOUNT_RENTAL' && row.enabled === true), 'SERVICE_UNAVAILABLE');
  const release = exactlyOne(rows('rule_release').filter(row => row.id === game.current_release_id && row.game_id === game.id), 'RELEASE_MISSING');
  const version = (table, id) => exactlyOne(rows(table).filter(row => row.id === id && row.game_id === game.id && row.status === 'SEALED'), 'VERSION_MISSING:' + table);
  const price = version('price_version', release.price_version_id);
  version('term_version', release.term_version_id);
  const agreement = version('agreement_version', release.agreement_version_id);
  const digestMatches = row => typeof row.body === 'string' && row.body.length > 0 && typeof row.title === 'string' && row.title.trim()
    && /^[a-f0-9]{64}$/.test(row.digest ?? '') && createHash('sha256').update(row.body, 'utf8').digest('hex') === row.digest;
  if (!digestMatches(agreement)) fail('AGREEMENT_INVALID');
  const rule = price.haff_rule;
  if (!Object.hasOwn(price, 'funding_policy') || !['SPREAD', 'PERCENT'].includes(price.mode) || price.rounding_policy !== 'HALF_UP_CENT_V1'
    || !rule || !['haff-ratio-v1', 'haff-ratio-v2'].includes(rule.schema)
    || !rule.dailyDeltaByTermOption || typeof rule.dailyDeltaByTermOption !== 'object' || Array.isArray(rule.dailyDeltaByTermOption)) fail('PRICE_RULE_MISSING');
  const options = rows('term_option').filter(row => row.version_id === release.term_version_id);
  if (!options.length || options.some(row => typeof row.code !== 'string' || !Object.hasOwn(rule.dailyDeltaByTermOption, row.code)
    || typeof rule.dailyDeltaByTermOption[row.code] !== 'string' || row.duration_rounding !== 'CEIL_DAY'
    || !/^[1-9]\d*$/.test(String(row.daily_consumption)) || typeof row.daily_consumption === 'number' && !Number.isSafeInteger(row.daily_consumption))) fail('TERM_OPTIONS_INCOMPLETE');
  const allItems = rows('billable_item');
  if (allItems.some(row => typeof row.game_id !== 'string' || typeof row.enabled !== 'boolean')) fail('ITEM_STATE_UNKNOWN');
  const items = allItems.filter(row => row.game_id === game.id && row.enabled === true);
  exactlyOne(items.filter(row => row.unit === 'HAFF_BASE'), 'HAFF_ITEM_MISSING');
  const prices = rows('price_line').filter(row => row.price_version_id === price.id && row.customer_tier === 'STANDARD');
  const nonNegative = value => typeof value === 'number' ? Number.isFinite(value) && value >= 0
    : typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value);
  for (const item of items) {
    const line = exactlyOne(prices.filter(row => row.item_id === item.id), 'STANDARD_PRICE_MISSING');
    if (item.unit === 'HAFF_BASE' ? line.pricing_kind !== 'HAFF_RATIO'
      : !['ROUND', 'PIECE', 'DAY'].includes(item.unit) || line.pricing_kind !== 'FIXED_UNIT'
        || !/^[1-9]\d*$/.test(String(line.unit_quantity)) || typeof line.unit_quantity === 'number' && !Number.isSafeInteger(line.unit_quantity)
        || !nonNegative(line.buyer_unit_amount)
        || (price.mode === 'SPREAD' ? !nonNegative(line.owner_unit_amount) : line.owner_unit_amount !== null)) fail('STANDARD_PRICE_INCOMPLETE');
  }
  let fullPayout = 'NOT_CONFIGURED';
  if (price.funding_policy != null) {
    const policy = price.funding_policy;
    const terms = exactlyOne(rows('full_payout_terms_version').filter(row => row.id === price.full_payout_terms_version_id
      && row.game_id === game.id && row.status === 'SEALED'), 'FULL_PAYOUT_TERMS_MISSING');
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || !digestMatches(terms) || ![policy.fullPayoutPolicyRef, policy.fullPayoutPolicyVersion, policy.disclosureVersion].every(value => typeof value === 'string' && value.length > 0)
      || terms.policy_ref !== policy.fullPayoutPolicyRef || terms.policy_version !== policy.fullPayoutPolicyVersion
      || terms.disclosure_version !== policy.disclosureVersion || terms.digest !== price.full_payout_terms_digest
      || terms.disclosure_version !== price.full_payout_disclosure_version) fail('FULL_PAYOUT_TERMS_MISMATCH');
    fullPayout = 'REFERENCE_CHECKED';
  }
  return { status: 'SOURCE_RENTAL_REFERENCE_CHECKED', gameCode, termOptions: options.length, enabledItems: items.length, fullPayout,
    tableCounts: Object.fromEntries(RENTAL_REFERENCE_TABLES.map(name => [name, rows(name).length])) };
}

/** Read the target in the caller's transaction; hash PostgreSQL's text before JSON number conversion. */
export async function readTargetRentalReference(client, gameCode) {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const result = await client.query(`WITH target_game AS (SELECT id FROM zzsh_supply.game WHERE code=$1)
    SELECT jsonb_build_object(
      'game', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.game t JOIN target_game g ON g.id=t.id),'[]'::jsonb),
      'game_service_operation', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.game_service_operation t JOIN target_game g ON g.id=t.game_id),'[]'::jsonb),
      'rule_release', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.rule_release t JOIN target_game g ON g.id=t.game_id),'[]'::jsonb),
      'price_version', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.price_version t JOIN target_game g ON g.id=t.game_id),'[]'::jsonb),
      'term_version', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.term_version t JOIN target_game g ON g.id=t.game_id),'[]'::jsonb),
      'agreement_version', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.agreement_version t JOIN target_game g ON g.id=t.game_id),'[]'::jsonb),
      'full_payout_terms_version', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.full_payout_terms_version t JOIN target_game g ON g.id=t.game_id),'[]'::jsonb),
      'billable_item', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.billable_item t JOIN target_game g ON g.id=t.game_id),'[]'::jsonb),
      'price_line', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.price_line t JOIN zzsh_supply.price_version v ON v.id=t.price_version_id JOIN target_game g ON g.id=v.game_id),'[]'::jsonb),
      'term_option', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM zzsh_supply.term_option t JOIN zzsh_supply.term_version v ON v.id=t.version_id JOIN target_game g ON g.id=v.game_id),'[]'::jsonb)
    )::text AS snapshot`, [gameCode]);
  if (result.rows.length !== 1 || typeof result.rows[0]?.snapshot !== 'string') throw new Error('BUSINESS_RENTAL_TARGET_UNAVAILABLE');
  const snapshot = result.rows[0].snapshot, data = JSON.parse(snapshot);
  const tables = new Map(Object.entries(data).map(([name, values]) => ['zzsh_supply.' + name, values]));
  const ready = assertRentalReferenceReady(tables, gameCode);
  return { ...ready, status: 'TARGET_RENTAL_REFERENCE_CHECKED', targetDigest: createHash('sha256').update(snapshot, 'utf8').digest('hex') };
}

/** A separate runtime login must see the same configuration and close its read-only snapshot. */
export async function verifyRuntimeRentalReference(client, expected, assertIdentity) {
  let transaction = false, rollbackAttempted = false;
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await assertIdentity(client);
    const actual = await readTargetRentalReference(client, expected.gameCode);
    if (actual.targetDigest !== expected.targetDigest || ['gameCode', 'termOptions', 'enabledItems', 'fullPayout'].some(field => actual[field] !== expected[field])
      || JSON.stringify(actual.tableCounts) !== JSON.stringify(expected.tableCounts))
      throw new Error('RENTAL_REFERENCE_RUNTIME_CHANGED');
    rollbackAttempted = true;
    if ((await client.query('ROLLBACK')).command !== 'ROLLBACK') throw new Error('RENTAL_REFERENCE_RUNTIME_ROLLBACK_UNCONFIRMED');
    transaction = false;
    return { runtimeAccess: 'VERIFIED', runtimeRollbackConfirmed: true, runtimeClosed: true };
  } finally {
    try {
      if (transaction && !rollbackAttempted && (await client.query('ROLLBACK')).command !== 'ROLLBACK')
        throw new Error('RENTAL_REFERENCE_RUNTIME_ROLLBACK_UNCONFIRMED');
    } finally { await client.end(); }
  }
}

/** New rounds require the complete committed reference receipt, not just a nonempty table list. */
export function assertRentalReferenceReceipt(business) {
  const fail = () => { throw new Error('ROUND_RENTAL_REFERENCE_UNCONFIRMED'); };
  const ready = business?.rentalReference, entries = business?.tables;
  if (ready?.status !== 'SOURCE_RENTAL_REFERENCE_CHECKED' || typeof ready.gameCode !== 'string' || !ready.gameCode
    || !/^[a-f0-9]{64}$/.test(ready.validatorSha256 ?? '') || !/^[a-f0-9]{64}$/.test(ready.targetDigest ?? '')
    || !Number.isSafeInteger(ready.termOptions) || ready.termOptions < 1 || !Number.isSafeInteger(ready.enabledItems) || ready.enabledItems < 1
    || !['NOT_CONFIGURED', 'REFERENCE_CHECKED'].includes(ready.fullPayout)
    || business.sourceIdsPreserved !== true || business.sourceRawUnchanged !== true || !Array.isArray(business.pending) || business.pending.length !== 0
    || !Array.isArray(entries) || entries.length !== BUSINESS_REFERENCE_TABLES.length) fail();
  const byTable = new Map(entries.map(row => [row?.table, row]));
  if (byTable.size !== BUSINESS_REFERENCE_TABLES.length) fail();
  for (const name of BUSINESS_REFERENCE_TABLES) {
    const row = byTable.get(name);
    if (row?.inserted !== true || ![row.rows, row.exact, row.baselineTimestampOnly].every(value => Number.isSafeInteger(value) && value >= 0)
      || row.exact + row.baselineTimestampOnly !== row.rows) fail();
  }
  if (!ready.tableCounts || Object.keys(ready.tableCounts).length !== RENTAL_REFERENCE_TABLES.length
    || RENTAL_REFERENCE_TABLES.some(name => ready.tableCounts[name] !== byTable.get('zzsh_supply.' + name)?.rows)) fail();
  return true;
}
