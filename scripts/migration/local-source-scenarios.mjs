import { createHash } from 'node:crypto';

const key = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const nonzero = value => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);

/** Selection is explicit: "full" means every row of the bound capture, not every legacy table. */
export function resolvePopulationMode(args) {
  const count = flag => args.filter(value => value === flag).length;
  const scenario = count('--scenario-selection'), full = count('--full-source'), selected = count('--business-selection');
  // The seventh round keeps a business-selected subset: a distinct mode, not a variant of the full
  // capture and not the retired scenario sample.
  if (scenario + full + selected !== 1) throw new Error('EXACTLY_ONE_POPULATION_MODE_REQUIRED');
  return selected ? 'SELECTED_BUSINESS_SCOPE' : full ? 'FULL_CAPTURED_SOURCE' : 'SCENARIO_SELECTION';
}

/** Digests cover original source IDs in capture order; selected means considered, not imported or enabled. */
export function summarizePopulationScope(data,mode,selection,sourceReceiptSha256) {
  if(!['FULL_CAPTURED_SOURCE','SCENARIO_SELECTION','SELECTED_BUSINESS_SCOPE'].includes(mode)||!/^([a-f0-9]{64})$/.test(sourceReceiptSha256??'')
    ||mode==='SCENARIO_SELECTION'&&typeof selection?.includes!=='function'||mode==='FULL_CAPTURED_SOURCE'&&selection!==null||mode==='SELECTED_BUSINESS_SCOPE'&&typeof selection?.includes!=='function')throw new Error('POPULATION_SCOPE_INPUT_INVALID');
  for(const required of ['users','accounts','orders'])if(!Array.isArray(data[required]))throw new Error('POPULATION_REQUIRED_DOMAIN_MISSING');
  const domains={};
  for(const domain of Object.keys(data).sort()){
    const rows=data[domain];if(!Array.isArray(rows))throw new Error('POPULATION_DOMAIN_INVALID');
    const source=createHash('sha256'),selected=createHash('sha256'),seen=new Set();let selectedCount=0;
    for(const row of rows){
      if(typeof row?.id!=='string'||!row.id||seen.has(row.id))throw new Error('POPULATION_SOURCE_KEY_INVALID:'+domain);
      seen.add(row.id);const bytes=JSON.stringify(row.id)+'\n';source.update(bytes);
      if(mode==='FULL_CAPTURED_SOURCE'||selection.includes(domain,row)){selected.update(bytes);selectedCount++;}
    }
    domains[domain]={captured:rows.length,considered:selectedCount,excluded:rows.length-selectedCount,
      capturedIdsSha256:source.digest('hex'),consideredIdsSha256:selected.digest('hex')};
  }
  return {schema:'zzsh.local-population-scope.v1',mode,sourceReceiptSha256,
    meaning:'CAPTURED_DOMAINS_ONLY_NOT_ALL_LEGACY_TABLES',digestOrder:'CAPTURE_ORDER_JSON_ID_PER_LINE',
    consideredMeans:'INPUT_LOADED_NOT_CONVERTED_OR_IMPORTED',sourceStatusPolicy:'PRESERVE_SOURCE_FLAGS_VERIFY_SEPARATELY',
    targetStatus:'NOT_VERIFIED',domains,
   // This planner hands empty finance coverage to the bounded chunk sink; a dataset built before that
   // path existed must not pass the full-execution admission on the strength of this build alone.
   ...(mode==='FULL_CAPTURED_SOURCE'?{boundedEmptyCoverage:true}:{})};
}

/** Trades, current supply and recorded funds seed the owner and upstream closure. */
export function selectSourceScenarios(data, contacts = new Map()) {
  const byId = {}, selected = { users: new Set(), accounts: new Set(), orders: new Set() }, queue = [], missing = [];
  for (const domain of ["users", "accounts", "orders"]) {
    byId[domain] = new Map();
    for (const row of data[domain]) {
      if (!key(row.id) || byId[domain].has(row.id)) throw new Error("SOURCE_ID_NOT_UNIQUE:" + domain);
      byId[domain].set(row.id, row);
    }
  }
  const links = new Map(), ownerAccounts = new Map();
  const link = (from, to) => { const list = links.get(from) ?? []; list.push(to); links.set(from, list); };
  for (const row of data.users) for (const field of ["inviter_id", "first_leader", "second_leader", "third_leader"]) {
    if (key(row[field])) link(row.id, row[field]);
  }
  for (const row of data.accounts) { const list = ownerAccounts.get(row.user_id) ?? []; list.push(row.id); ownerAccounts.set(row.user_id, list); }
  function add(domain, id, cause) {
    if (!byId[domain].has(id)) { missing.push({ domain, sourceId: id ?? null, cause }); return; }
    if (!selected[domain].has(id)) { selected[domain].add(id); queue.push([domain, id]); }
  }
  const scenes = {};
  function scene(name, domain, predicate) {
    const matches = data[domain].filter(predicate);
    scenes[name] = { domain, source: matches.length, selected: matches.filter(row => includes(domain, row)).length };
  }
  for (const row of data.orders) add("orders", row.id, "all-trades");
  for (const row of data.accounts) {
    if (row.is_delete === "0" && (row.status === "3" || row.status === "6"))
      add("accounts", row.id, row.status === "3" ? "current-listing" : "pending-payment-account");
    if (nonzero(row.pay_money)) add("accounts", row.id, "account-guarantee-amount");
  }
  const coreUsers = new Set(data.orders.flatMap(row => [row.user_id, row.sale_user_id]).filter(id => byId.users.has(id)));
  for (const row of data.users) if (nonzero(row.money) || nonzero(row.earnings)) add("users", row.id, "stored-balance");
  for (const domain of ["earnings", "moneyLogs", "withdraws", "refunds", "distributionOrders", "orderAfter"])
    for (const row of data[domain] ?? []) add("users", row.user_id, domain + ":" + row.id);
  for (const row of data.pays ?? []) {
    if (row.order_type === "1") add("orders", row.order_id, "order-payment:" + row.id);
    else if (row.order_type === "2") add("accounts", row.order_id, "account-guarantee-payment:" + row.id);
    else missing.push({ domain: "pays", sourceId: row.id, cause: "unmapped-payment-parent-type" });
  }
  const traded = new Set(data.orders.map(row => row.accounts_id));
  for (let i = 0; i < queue.length; i++) {
    const [domain, id] = queue[i], row = byId[domain].get(id);
    if (domain === "orders") {
      add("users", row.user_id, "order-renter:" + id); add("users", row.sale_user_id, "order-owner:" + id); add("accounts", row.accounts_id, "order-account:" + id);
    } else if (domain === "accounts") add("users", row.user_id, "account-owner:" + id);
    else {
      for (const other of links.get(id) ?? []) add("users", other, "invitation-component:" + id);
      for (const accountId of ownerAccounts.get(id) ?? []) add("accounts", accountId, "complete-owner-history:" + id);
    }
  }
  function includes(domain, row) {
    if (selected[domain]) return selected[domain].has(row.id);
    if (domain === "accountDisplay") return selected.accounts.has(row.id);
    if (["earnings", "moneyLogs", "withdraws", "distribution", "distributionOrders"].includes(domain)) return selected.users.has(row.user_id);
    if (domain === "pays") return row.order_type === "1" && selected.orders.has(row.order_id) || row.order_type === "2" && selected.accounts.has(row.order_id);
    if (domain === "refunds") return selected.users.has(row.user_id) || row.order_type === "order" && selected.orders.has(row.order_id);
    if (domain === "orderAfter") return selected.users.has(row.user_id) || selected.orders.has(row.order_id);
    return true;
  }
  scene("all-trades", "orders", () => true);
  scene("nonzero-balance", "users", row => nonzero(row.money) || nonzero(row.earnings));
  scene("untraded-listed", "accounts", row => row.status === "3" && row.is_delete === "0" && !traded.has(row.id));
  scene("frozen-user", "users", row => row.is_disable === "1" && row.is_delete === "0");
  scene("cancelled-user", "users", row => row.is_delete === "1");
  scene("missing-phone", "users", row => !row.mobile);
  scene("ambiguous-phone", "users", row => contacts.get(row.id)?.decision === "AMBIGUOUS_NON_CANCELLED");
  scene("empty-account-number", "accounts", row => row.no === null || row.no === "");
  scene("empty-title", "accounts", row => row.title === null || row.title === "");
  for (const value of ["0", "1"]) scene("demulan-" + value, "accounts", row => row.is_demulan === value);
  for (const value of ["0", "1", null]) scene("next-pass-" + (value ?? "unknown"), "accounts", row => row.is_next_season_pass === value);
  const domains = Object.fromEntries(Object.entries(data).map(([domain, rows]) => { const count = rows.filter(row => includes(domain, row)).length; return [domain, { source: rows.length, selected: count, excluded: rows.length - count }]; }));
  return { selected, includes, missing, summary: { schema: "zzsh.source-scenarios.v1", coreOrderUsers: coreUsers.size, necessaryRelatedUsers: selected.users.size - coreUsers.size, domains, scenes, missingScenes: Object.entries(scenes).filter(([, entry]) => entry.selected === 0).map(([name]) => name), missingReferences: missing.length, invitationClosure: "ANCESTORS_ONLY_FULL_SOURCE_CHILD_PROOFS_RETAINED", selectedUsersHaveCompleteHistory: true, excludedUsersMeaning: "OUTSIDE_SCENARIO_SELECTION_NOT_DISCARDED_OR_ORPHAN" } };
}
