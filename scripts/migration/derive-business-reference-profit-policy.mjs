import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace a single JSON scalar without reserializing unrelated numeric source values.
function scalar(raw, key, before, after) {
  const re = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)${escapeRegExp(JSON.stringify(before))}(?=\\s*[,}])`, 'g');
  const matches = [...raw.matchAll(re)];
  requireThat(matches.length === 1, 'SOURCE_SCALAR_NOT_UNIQUE');
  return raw.replace(re, (_, prefix) => prefix + JSON.stringify(after));
}
function one(rows, condition, code) {
  const matches = rows.filter(row => condition(JSON.parse(row)));
  requireThat(matches.length === 1, code);
  return matches[0];
}
function withChanges(raw, changes) {
  let result = raw;
  for (const [key, before, after] of changes) result = scalar(result, key, before, after);
  const expected = JSON.parse(raw), actual = JSON.parse(result);
  for (const [key, , after] of changes) expected[key] = after;
  requireThat(JSON.stringify(expected) === JSON.stringify(actual), 'UNEXPECTED_ROW_CHANGE');
  return result;
}

// Replace only the enabled fast-mode object, preserving every other source byte.
// There is also a separate compatibility.fast price lane, so match by its
// validated object value rather than assuming key order or JSON whitespace.
function withFastRatioMaximum(raw, expectedMode, maximum) {
  const matches = [];
  for (const match of raw.matchAll(/"fast"\s*:\s*\{/g)) {
    const start = match.index + match[0].lastIndexOf('{');
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = start; i < raw.length; i++) {
      const char = raw[i];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) continue;
    try { if (JSON.stringify(JSON.parse(raw.slice(start, end))) === JSON.stringify(expectedMode)) matches.push({ start, end }); } catch { /* not an object value */ }
  }
  requireThat(matches.length === 1, 'FAST_MODE_SOURCE_NOT_UNIQUE');
  const next = { ...expectedMode, max: { base: 'ABSOLUTE', value: maximum } };
  const { start, end } = matches[0];
  return raw.slice(0, start) + JSON.stringify(next) + raw.slice(end);
}

/** Pure transformation: all prior rows remain byte-identical; only the game pointer and new immutable rows differ. */
export function deriveProfitPolicy(manifestBytes, tableBytes, decision, decisionSha256, evidenceBytes, options = {}) {
  const freshAdminId = options.freshAdminId ?? null;
  requireThat(digest(decisionSha256) && sha(manifestBytes) === decision?.sourceManifestSha256, 'SOURCE_MANIFEST_SHA_MISMATCH');
  requireThat(decision.kind === 'ZZSH_BUSINESS_PROFIT_POLICY_DECISION_V2'
    && decision.authorization === 'OWNER_DIRECTED_FRESH_INITIALIZATION'
    && decision.gameCode === 'delta' && decision.expectedOldOrdinary === '8'
    && decision.ordinarySpread === '6' && decision.fastSpread === '12' && decision.fastRatioMaxWanPerYuan === '99'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(decision.derivedAt ?? '')
    && Number.isFinite(Date.parse(decision.derivedAt)) && digest(decision.policyEvidenceSha256)
    && sha(evidenceBytes) === decision.policyEvidenceSha256, 'POLICY_DECISION_NOT_BOUND');
  const evidence = JSON.parse(evidenceBytes);
  requireThat(evidence.schema === 'zzsh.r06-pricing-source-comparison.v1' && evidence.status === 'READ_ONLY_COMPARISON_COMPLETE'
    && evidence.source === 'MYSQL_DUMP_AND_RESTORE_CAPTURE' && evidence.sourceRuntimeCache === 'UNKNOWN'
    && evidence.sourceQuoteScope === 'ORDINARY_USER' && evidence.spreads?.ordinary?.source === '6'
    && evidence.spreads?.ordinary?.current === '8' && evidence.spreads?.fast?.source === '12'
    && evidence.spreads?.fast?.current === '12' && evidence.targetWrites === 0
    && evidence.rollbackAcknowledged === true && evidence.clientClosed === true, 'POLICY_EVIDENCE_MISMATCH');
  const manifest = JSON.parse(manifestBytes);
  requireThat(manifest.kind === 'BUSINESS_REFERENCE_PACKAGE_V1' && manifest.gameCode === 'delta'
    && manifest.transactionRollback === true && manifest.clientClosed === true
    && typeof manifest.sourceRawUnchanged === 'boolean' && Array.isArray(manifest.tables), 'SOURCE_PACKAGE_INVALID');
  const tables = new Map(), names = new Set();
  for (const descriptor of manifest.tables) {
    const key = `${descriptor.schema}.${descriptor.table}`, bytes = tableBytes.get(descriptor.file);
    requireThat(!tables.has(key) && typeof descriptor.file === 'string' && descriptor.file === basename(descriptor.file)
      && !names.has(descriptor.file) && Buffer.isBuffer(bytes) && sha(bytes) === descriptor.sha256, 'SOURCE_TABLE_BINDING_INVALID');
    names.add(descriptor.file);
    const table = JSON.parse(bytes);
    requireThat(table.schema === descriptor.schema && table.table === descriptor.table && Array.isArray(table.rows)
      && table.rows.length === descriptor.rows && table.rows.every(row => typeof row === 'string'), 'SOURCE_TABLE_SHAPE_INVALID');
    tables.set(key, { descriptor, table });
  }
  const need = name => { const value = tables.get('zzsh_supply.' + name); requireThat(value, 'SOURCE_TABLE_REQUIRED'); return value; };
  const game = need('game'), releases = need('rule_release'), versions = need('price_version'), lines = need('price_line');
  const gameRaw = one(game.table.rows, row => row.code === 'delta', 'GAME_NOT_UNIQUE'), gameRow = JSON.parse(gameRaw);
  requireThat(game.table.rows.length === 1 && typeof gameRow.id === 'string', 'SINGLE_GAME_REQUIRED');
  const releaseRaw = one(releases.table.rows, row => row.id === gameRow.current_release_id, 'CURRENT_RELEASE_NOT_UNIQUE');
  const release = JSON.parse(releaseRaw);
  requireThat(release.game_id === gameRow.id && Number.isSafeInteger(release.generation) && release.generation > 0
    && releases.table.rows.every(raw => { const row=JSON.parse(raw); return row.game_id === gameRow.id && Number.isSafeInteger(row.generation) && row.generation <= release.generation; }), 'RELEASE_SEQUENCE_INVALID');
  requireThat(new Set(releases.table.rows.map(raw=>JSON.parse(raw).generation)).size===releases.table.rows.length
    && Number.isFinite(Date.parse(release.activated_at)) && Date.parse(release.activated_at)<=Date.parse(decision.derivedAt), 'RELEASE_SEQUENCE_INVALID');
  const versionRaw = one(versions.table.rows, row => row.id === release.price_version_id, 'CURRENT_PRICE_NOT_UNIQUE');
  const version = JSON.parse(versionRaw), rule = version.haff_rule;
  requireThat(version.game_id === gameRow.id && version.status === 'SEALED' && version.mode === 'SPREAD'
    && Number.isSafeInteger(version.revision) && version.revision > 0 && rule?.schema === 'haff-ratio-v2'
    && rule.compatibility?.ordinary?.spreadDelta === decision.expectedOldOrdinary
    && rule.compatibility?.fast?.spreadDelta === decision.fastSpread
    && rule.compatibility?.modes?.ordinary?.enabled === true && rule.compatibility?.modes?.custom?.enabled === true
    && rule.compatibility?.modes?.fast?.enabled === true, 'SOURCE_POLICY_CHANGED');
  const fastMode = rule.compatibility.modes.fast;
  const exactBound = (bound, base, value) => bound && typeof bound === 'object' && !Array.isArray(bound)
    && Object.keys(bound).length === 2 && bound.base === base && bound.value === value;
  requireThat(Object.keys(fastMode).every(key => ['enabled', 'min', 'max'].includes(key))
    && exactBound(fastMode.min, 'C', '6')
    && (fastMode.max === undefined || exactBound(fastMode.max, 'ABSOLUTE', '99')), 'SOURCE_FAST_BOUNDS_CHANGED');
  const currentLines = lines.table.rows.filter(raw => JSON.parse(raw).price_version_id === version.id);
  requireThat(currentLines.length > 0 && currentLines.some(raw => JSON.parse(raw).pricing_kind === 'HAFF_RATIO'), 'SOURCE_PRICE_LINES_REQUIRED');
  const seed = sha(JSON.stringify(['profit-policy-v1', decision.sourceManifestSha256, decisionSha256]));
  const priceId = 'pver_init_' + seed.slice(0, 32), releaseId = 'release_init_' + seed.slice(0, 32);
  const allVersionIds = new Set(versions.table.rows.map(raw => JSON.parse(raw).id));
  const allReleaseIds = new Set(releases.table.rows.map(raw => JSON.parse(raw).id));
  const allLineIds = new Set(lines.table.rows.map(raw => JSON.parse(raw).id));
  requireThat(allVersionIds.size === versions.table.rows.length && allReleaseIds.size === releases.table.rows.length
    && allLineIds.size === lines.table.rows.length, 'SOURCE_IDENTIFIERS_NOT_UNIQUE');
  requireThat(!allVersionIds.has(priceId) && !allReleaseIds.has(releaseId), 'DERIVED_ID_ALREADY_EXISTS');
  const newGame = withChanges(gameRaw, [['current_release_id', gameRow.current_release_id, releaseId]]);
  let newVersion = withChanges(versionRaw, [['id', version.id, priceId], ['revision', version.revision, 1],
    ['created_at', version.created_at, decision.derivedAt], ['updated_at', version.updated_at, decision.derivedAt],
    ['sealed_at', version.sealed_at, decision.derivedAt]]);
  newVersion = scalar(newVersion, 'spreadDelta', decision.expectedOldOrdinary, decision.ordinarySpread);
  newVersion = withFastRatioMaximum(newVersion, fastMode, decision.fastRatioMaxWanPerYuan);
  const expectedRule = structuredClone(rule); expectedRule.compatibility.ordinary.spreadDelta = decision.ordinarySpread;
  expectedRule.compatibility.modes.fast.max = { base: 'ABSOLUTE', value: decision.fastRatioMaxWanPerYuan };
  requireThat(JSON.stringify(JSON.parse(newVersion).haff_rule) === JSON.stringify(expectedRule), 'UNEXPECTED_POLICY_CHANGE');
  // Only the newly derived row is re-sealed; the source rows keep their original sealer and are
  // dropped in fresh mode rather than rewritten.
  if (freshAdminId !== null) newVersion = withChanges(newVersion, [['sealed_by_admin_id', version.sealed_by_admin_id, freshAdminId], ['created_by_admin_id', version.created_by_admin_id, freshAdminId]]);
  const newRelease = withChanges(releaseRaw, [['id', release.id, releaseId], ['price_version_id', version.id, priceId],
    ['generation', release.generation, release.generation + 1], ['created_at', release.created_at, decision.derivedAt],
    ['activated_at', release.activated_at, decision.derivedAt]]);
  const newLines = currentLines.map(raw => {
    const line = JSON.parse(raw), id = 'pline_init_' + sha(JSON.stringify([seed, line.id])).slice(0, 32);
    requireThat(typeof line.id === 'string' && !allLineIds.has(id), 'DERIVED_LINE_ID_ALREADY_EXISTS');
    allLineIds.add(id);
    return withChanges(raw, [['id', line.id, id], ['price_version_id', version.id, priceId], ['created_at', line.created_at, decision.derivedAt]]);
  });
  const changed = new Map([
    [game.descriptor.file, { ...game.table, rows: [newGame] }],
    [versions.descriptor.file, { ...versions.table, rows: freshAdminId !== null ? [newVersion] : [...versions.table.rows, newVersion] }],
    [releases.descriptor.file, { ...releases.table, rows: freshAdminId !== null ? [newRelease] : [...releases.table.rows, newRelease] }],
    [lines.descriptor.file, { ...lines.table, rows: freshAdminId !== null ? [...newLines] : [...lines.table.rows, ...newLines] }],
  ]);
  const output = new Map(tableBytes);
  for (const [name, table] of changed) output.set(name, Buffer.from(JSON.stringify(table, null, 2) + '\n'));
  const derivedManifest = structuredClone(manifest);
  derivedManifest.sourceRawUnchanged = false;
  derivedManifest.tables = derivedManifest.tables.map(descriptor => changed.has(descriptor.file)
    ? { ...descriptor, rows: changed.get(descriptor.file).rows.length, sha256: sha(output.get(descriptor.file)) } : descriptor);
  derivedManifest.derivationLineage = [...(Array.isArray(manifest.derivationLineage) ? manifest.derivationLineage : []), {
    kind: 'OWNER_DIRECTED_FRESH_PROFIT_POLICY_V2', sourceManifestSha256: decision.sourceManifestSha256,
    decisionSha256, policyEvidenceSha256: decision.policyEvidenceSha256,
    sourceRuntimeCache: 'UNKNOWN', ordinarySpread: '6', fastSpread: '12', fastRatioMaxWanPerYuan: '99', derivedAt: decision.derivedAt,
    timestampBasis: 'PACKAGE_SEED_TIME_NOT_TARGET_ACTIVATION_ACK',
  }];
  const resultManifest = Buffer.from(JSON.stringify(derivedManifest, null, 2) + '\n');
  return { manifest: resultManifest, tables: output, addedLines: newLines.length, priceId, releaseId,
    previousGeneration: release.generation, generation: release.generation + 1,
    changedFiles: [...changed.keys()].sort(), inputManifestSha256: decision.sourceManifestSha256 };
}

function privatePath(root, value) {
  requireThat(isAbsolute(value ?? ''), 'ABSOLUTE_PRIVATE_PATH_REQUIRED');
  const path = resolve(value), rel = relative(root, path);
  requireThat(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'PRIVATE_PATH_REQUIRED');
  let part = existsSync(path) ? path : dirname(path);
  for (;;) { requireThat(!lstatSync(part).isSymbolicLink(), 'SYMLINK_REFUSED'); const parent=dirname(part); if(parent===part) break; part=parent; }
  return path;
}
function makePrivate(path) {
  mkdirSync(path, { mode: 0o700 });
  if (process.platform !== 'win32') { chmodSync(path, 0o700); const info=statSync(path); requireThat((info.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || info.uid === process.getuid()), 'PRIVATE_MODE_UNVERIFIED'); return; }
  const who=spawnSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:5000});
  const sid=/S-1-5-[0-9-]+/.exec(who.stdout)?.[0]; requireThat(who.status===0 && sid, 'PRIVATE_SID_REQUIRED');
  requireThat(spawnSync('icacls',[path,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,timeout:5000}).status===0, 'PRIVATE_ACL_FAILED');
  const check="$a=Get-Acl -LiteralPath $env:ZZSH_PROFIT_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_PROFIT_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}";
  requireThat(spawnSync('pwsh.exe',['-NoProfile','-Command',check],{env:{...process.env,ZZSH_PROFIT_ACL_PATH:path,ZZSH_PROFIT_ACL_SID:sid},windowsHide:true,timeout:5000}).status===0, 'PRIVATE_ACL_UNVERIFIED');
}
function main() {
  const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]};
  const freshAdminId=option('--fresh-admin-id');
// A fresh environment must not inherit another environment's sealed price history, so this mode
// keeps only the newly derived version and seals it under this round's own administrator.
const fresh=freshAdminId!==undefined;
requireThat((args.length===(fresh?14:12)) && ['--private-root','--source','--decision','--decision-sha','--evidence','--out'].every(name=>args.filter(x=>x===name).length===1)
&& (!fresh || (args.filter(x=>x==='--fresh-admin-id').length===1 && /^admin_[a-f0-9]{32}$/.test(freshAdminId))), 'EXACT_ARGUMENTS_REQUIRED');
  const root=realpathSync(option('--private-root')), source=privatePath(root,option('--source'));
  const decisionFile=privatePath(root,option('--decision')), out=privatePath(root,option('--out'));
  requireThat(!existsSync(out) && relative(source,out).startsWith('..'+sep) && relative(out,source).startsWith('..'+sep), 'NEW_NONOVERLAPPING_OUTPUT_REQUIRED');
  const decisionBytes=readFileSync(decisionFile), decisionSha256=sha(decisionBytes);
  requireThat(digest(option('--decision-sha')) && decisionSha256===option('--decision-sha'), 'DECISION_SHA_MISMATCH');
  const decision=JSON.parse(decisionBytes), evidenceFile=privatePath(root,option('--evidence'));
  const manifestFile=privatePath(root,join(source,'manifest.json')), manifestBytes=readFileSync(manifestFile);
  const manifest=JSON.parse(manifestBytes), bytes=new Map();
  requireThat(Array.isArray(manifest.tables), 'SOURCE_PACKAGE_INVALID');
  for(const entry of manifest.tables) {
    requireThat(typeof entry.file==='string' && entry.file===basename(entry.file) && !bytes.has(entry.file)
      && !['manifest.json','media-objects.json','derivation-receipt.json'].includes(entry.file)
      && !/^(lineage|profit-decision|policy-evidence)-[a-f0-9]{64}\.json$/.test(entry.file), 'SOURCE_FILE_INVALID');
    bytes.set(entry.file,readFileSync(privatePath(root,join(source,entry.file))));
  }
  const media=readFileSync(privatePath(root,join(source,'media-objects.json'))), evidence=readFileSync(evidenceFile);
  const lineage=new Map();
  for(const name of readdirSync(source).filter(name=>/^(lineage|profit-decision|policy-evidence)-[a-f0-9]{64}\.json$/.test(name))) {
    const content=readFileSync(privatePath(root,join(source,name)));
    requireThat(name.endsWith(`-${sha(content)}.json`),'UPSTREAM_LINEAGE_SHA_MISMATCH');lineage.set(name,content);
  }
  if(manifest.sourceRawUnchanged===false) {
    const parent=readFileSync(privatePath(root,join(source,'derivation-receipt.json'))), parsed=JSON.parse(parent);
    requireThat(digest(decision.parentReceiptSha256) && sha(parent)===decision.parentReceiptSha256
      && parsed.derivedManifestSha256===sha(manifestBytes), 'PARENT_RECEIPT_MISMATCH');
    lineage.set(`lineage-${sha(parent)}.json`,parent);
  }
  const built=deriveProfitPolicy(manifestBytes,bytes,decision,decisionSha256,evidence,{freshAdminId});
  const files=new Map([...built.tables,['manifest.json',built.manifest],['media-objects.json',media],
    [`profit-decision-${decisionSha256}.json`,decisionBytes],[`policy-evidence-${sha(evidence)}.json`,evidence],...lineage]);
  const derivedDescriptors=JSON.parse(built.manifest).tables;
  const receipt={kind:'BUSINESS_REFERENCE_PROFIT_POLICY_DERIVATION_V1',status:'DERIVED_READBACK_VERIFIED',
    sourceManifestSha256:sha(manifestBytes),derivedManifestSha256:sha(built.manifest),decisionSha256,
    policyEvidenceSha256:sha(evidence),sourceRuntimeCache:'UNKNOWN',ownerAuthorization:decision.authorization,fastRatioMaxWanPerYuan:decision.fastRatioMaxWanPerYuan,
    timestampBasis:'PACKAGE_SEED_TIME_NOT_TARGET_ACTIVATION_ACK',
    sourceRawUnchanged:false,previousGeneration:built.previousGeneration,generation:built.generation,
    addedPriceVersions:1,addedReleases:1,addedPriceLines:built.addedLines,changedFiles:built.changedFiles,
    previousPriceAndReleaseRowsPreserved:!fresh,priceHistoryDisposition:fresh?'FRESH_DERIVED_ONLY':'SOURCE_HISTORY_RETAINED',
    derivationToolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),gameCurrentReleasePointerChanged:true,
    tables:manifest.tables.map((source,i)=>({table:source.schema+'.'+source.table,sourceRows:source.rows,
      derivedRows:derivedDescriptors[i].rows,sourceSha256:source.sha256,derivedSha256:derivedDescriptors[i].sha256})),
    sourceFileWrites:0,dbConnections:0,channelCalls:0};
  makePrivate(out);
  for(const [name,content] of files) writeFileSync(join(out,name),content,{flag:'wx',mode:0o600});
  requireThat(sha(readFileSync(manifestFile))===sha(manifestBytes) && sha(readFileSync(decisionFile))===decisionSha256
    && sha(readFileSync(evidenceFile))===sha(evidence), 'SOURCE_CHANGED_DURING_DERIVATION');
  for(const [name,content] of bytes) requireThat(sha(readFileSync(join(source,name)))===sha(content), 'SOURCE_CHANGED_DURING_DERIVATION');
  for(const [name,content] of files) requireThat(sha(readFileSync(join(out,name)))===sha(content), 'OUTPUT_READBACK_MISMATCH');
  writeFileSync(join(out,'derivation-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:receipt.status,derivedManifestSha256:receipt.derivedManifestSha256,addedPriceVersions:1,addedReleases:1,addedPriceLines:receipt.addedPriceLines,dbConnections:0,channelCalls:0}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'DERIVATION_FAILED'); process.exitCode=1; }
}
