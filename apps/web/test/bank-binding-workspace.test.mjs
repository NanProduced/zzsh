import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import { loadInformation } from './information-module.mjs';
const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(tree + '/package.json'), React = require('react'), ts = require('typescript');
const { Window } = require('happy-dom');
const { WithdrawalRequestError } = require(tree + '/apps/web/src/lib/withdrawal-client-core.ts');
const { validateBankBindingInput } = require(tree + '/apps/web/src/lib/withdrawal-bank-binding-client.ts');
const file = tree + '/apps/web/src/components/account/bank-binding-workspace.tsx';
const source = fs.readFileSync(file, 'utf8'), information = loadInformation();
const at = '2026-10-25T00:00:00.000Z';
const bank = (revision = '1', tail = '0015') => ({ contractVersion: 'withdrawal-bank-binding.v1', integration: 'INTEGRATED', expectedRevision: revision, binding: { id: 'bank-1', revision, cardMask: '**** **** ' + tail, holderNameMask: '测**', updatedAt: at, ownershipVerification: 'NOT_VERIFIED' } });
const emptyBank = { contractVersion: 'withdrawal-bank-binding.v1', integration: 'INTEGRATED', expectedRevision: '0', binding: null };
const unavailableBank = { contractVersion: 'withdrawal-bank-binding.v1', integration: 'NOT_INTEGRATED', expectedRevision: null, binding: null };
const options = (binding = bank(), allowed = true) => ({ contractVersion: 'withdrawal-request-context.v1', bankBinding: binding, canQuote: allowed, policy: { version: 'policy-1', minCents: '100', maxCents: '100000', fee: { kind: 'FIXED', cents: '100' }, maxIntents: 3, quotaStart: at, quotaEnd: '2026-10-26T00:00:00.000Z' }, reasonCodes: allowed ? [] : ['BANK_BINDING_REQUIRED'], bankOwnershipVerification: 'NOT_VERIFIED', bankArrival: 'UNKNOWN' });
const quote = { contractVersion: 'native-withdrawal.v1', source: 'JOINPAY', grossCents: '10000', netCents: '9900', feeCents: '100', policyVersion: 'policy-1', destination: { id: 'bank-1', revision: '1', mask: '**** **** 0015' }, expectedWalletVersion: 'jwdq1:' + 'a'.repeat(64), ledgerRevision: '1', globalWithdrawable: 'UNKNOWN' };
const intent = { contractVersion: 'native-withdrawal.v1', source: 'JOINPAY', userId: 'user_A', id: 'intent-1', amountCents: '10000', netCents: '9900', feeCents: '100', currency: 'CNY', state: 'RESERVED', operationVersion: '1', fundsDisposition: 'RESERVED', requiresReview: false, merchantOrderNo: 'OFFLINE-ORDER-1', policyVersion: 'policy-1', destinationId: 'bank-1', acceptedAt: at, bankArrival: 'UNKNOWN', globalWithdrawable: 'UNKNOWN', originalDestination: { id: 'bank-1', revision: '1', cardMask: '**** **** 0015', basis: 'ORIGINAL_INTENT', bankOwnershipVerification: 'UNKNOWN' } };
const historyItem = (id = 'history:h1') => ({ id, source: 'HISTORICAL_WITHDRAWAL', sourceStatus: 2, amountCents: '10000', netCents: '9900', feeCents: '100', occurredAt: at });
const localItem = { id: 'local-1', state: 'RESERVED', amountCents: '5000', netCents: '4900', feeCents: '100', acceptedAt: at };
const nativeItem = { ...intent, id: 'joinpay:intent-1', occurredAt: at, sourceReference: { type: 'NATIVE', system: 'zzsh', entity: 'joinpay_withdrawal_intent', id: 'intent-1' }, intentId: 'intent-1', evidenceLevel: 'LOCAL_RECORDS_NOT_REVALIDATED', platformSerialNo: null, mayResubmit: false, reasonCodes: [] };
function history(sourceName, { items = [], cursor = null, snapshot = 'snap-1', availability = 'AVAILABLE' } = {}) {
  const notRequested = { availability: 'NOT_REQUESTED', reasonCodes: [], data: null };
  const data = sourceName === 'HISTORICAL' ? { items, coverage: { knowledge: 'KNOWN' }, asOf: at, snapshotVersion: snapshot, nextCursor: cursor }
    : sourceName === 'LOCAL_CONTROLLED' ? { items, pagination: { asOf: at, snapshotVersion: snapshot, nextCursor: cursor } }
      : { items, count: String(items.length), asOf: at, snapshotVersion: snapshot, nextCursor: cursor, scope: 'LOCAL_NATIVE_INTENTS_ONLY' };
  const key = { HISTORICAL: 'historical', LOCAL_CONTROLLED: 'controlled', JOINPAY: 'joinpay' }[sourceName];
  return { contractVersion: 'personal-withdrawals.read.v2', subjectId: 'user_A', source: sourceName, state: 'ALL', sections: { historical: notRequested, controlled: notRequested, joinpay: notRequested, [key]: { availability, reasonCodes: availability === 'AVAILABLE' ? [] : ['NOT_INSTALLED'], data: availability === 'AVAILABLE' ? data : null } } };
}
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };

async function probe(overrides = {}) {
  const window = new Window({ url: 'http://127.0.0.1:4220/account?view=wallet&wallet=withdraw' });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, DOMException: window.DOMException, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  const session = { status: 'authenticated', userId: 'user_A', identityVersion: 1, revalidate() {} }, store = { getSnapshot: () => session };
  const calls = [], changes = [], commits = [];
  let pendingBank = overrides.pendingBank ?? null, pendingNative = overrides.pendingNative ?? null;
  const bankApi = {
    validateBankBindingInput, readBankBinding: async () => bank(), pendingBankBinding: () => pendingBank,
    saveBankBinding: async (userId, body, opts) => { calls.push({ method: 'saveBank', userId, body, opts }); pendingBank = null; return bank('2', body.cardNo.slice(-4)); },
    recoverBankBinding: async () => ({ knowledge: 'UNKNOWN', receipt: null, current: null }), ...overrides.bank,
  };
  const channelApi = {
    readChannelWithdrawalOptions: async () => options(), pendingChannelWithdrawal: () => pendingNative,
    quoteChannelWithdrawal: async (userId, input) => { calls.push({ method: 'quote', userId, input }); return quote; },
    submitChannelWithdrawal: async (userId, value, opts) => { calls.push({ method: 'submit', userId, value, opts }); pendingNative = null; return intent; },
    recoverChannelWithdrawal: async () => ({ knowledge: 'UNKNOWN', receipt: null, current: null }), readChannelWithdrawal: async () => intent, ...overrides.channel,
  };
  const historyApi = {
    readWithdrawalHistory: async (userId, query) => { calls.push({ method: 'history', userId, query }); return history(query.source); },
    readWithdrawalHistoryItem: async () => ({ contractVersion: 'personal-withdrawals.read.v2', subjectId: 'user_A', source: 'JOINPAY', availability: 'AVAILABLE', reasonCodes: [], data: { item: nativeItem, scope: 'LOCAL_NATIVE_INTENTS_ONLY' } }), recoverWithdrawalFromHistory: async () => ({ contractVersion: 'personal-withdrawals.read.v2', subjectId:'user_A', source:'JOINPAY', knowledge:'UNKNOWN',item:null,mayResubmit:false,receiptMeaning:'CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK' }), ...overrides.history,
  };
  // Control adapters isolate business UI behavior; real library visuals require browser verification.
  const Button = ({ children, onPress, isDisabled, variant: _variant, ...props }) => React.createElement('button', { ...props, disabled: isDisabled, onClick: onPress, type: props.type ?? 'button' }, children);
  const Input = props => React.createElement('input', props);
  const ConfirmAlertDialog = props => props.open ? React.createElement('div', { role: 'alertdialog' }, React.createElement('h2', null, props.title), props.description, props.consequences,
    React.createElement('button', { disabled: props.busy, onClick: () => props.onOpenChange(false) }, props.cancelLabel), React.createElement('button', { disabled: props.busy || props.confirmDisabled, onClick: props.onConfirm }, props.confirmLabel)) : null;
  const module = new Module(file); module.filename = file; module.paths = Module._nodeModulePaths(tree);
  module.require = name => {
    if (name === '@heroui/react') return { Button };
    if (name === '@/components/ui/form-controls') return { Input };
    if (name === '@/components/ui/information') return information;
    if (name === '@/components/ui/alert-dialog') return { ConfirmAlertDialog };
    if (name === '@/components/session/user-session-provider') return { useUserSession: () => session, useUserSessionStore: () => store };
    if (name === '@/lib/withdrawal-bank-binding-client') return bankApi;
    if (name === '@/lib/channel-withdrawal-client') return channelApi;
    if (name === '@/lib/withdrawal-history-client') return historyApi;
    if (name === 'next/link') return ({ children, ...props }) => React.createElement('a', props, children);
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/')) return require(tree + '/apps/web/src/' + name.slice(2) + '.ts');
    return require(name);
  };
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = require('react-dom/client').createRoot(host);
  const settle = async () => { for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(setImmediate); }); };
  function Track() { const scope = `${session.userId}:${session.identityVersion}`; React.useLayoutEffect(() => { commits.push({ scope, text: host.textContent }); }); return React.createElement(module.exports.BankBindingWorkspace, { scope, onWalletChanged: () => changes.push('wallet') }); }
  const render = async () => { await React.act(async () => root.render(React.createElement(Track))); await settle(); };
  const click = async (text, within = host) => { const b = [...within.querySelectorAll('button')].find(x => x.textContent.includes(text)); assert(b, `missing button ${text}`); assert.equal(b.disabled, false, `button ${text} disabled`); await React.act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise(setImmediate); }); await settle(); };
  const fill = async (selector, value) => { const input = host.querySelector(selector); assert(input, selector); await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); await settle(); };
  const submit = async selector => { const form = host.querySelector(selector); assert(form); await React.act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await new Promise(setImmediate); }); await settle(); };
  return { host, session, bankApi, channelApi, historyApi, calls, changes, commits, render, settle, click, fill, submit, setPendingBank: x => { pendingBank = x; }, setPendingNative: x => { pendingNative = x; }, async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); } };
}

test('workspace composes installed controls and never persists raw inputs itself', () => {
  assert.ok(!/<(?:input|select|button|dialog)\b/.test(source));
  assert.ok(!/localStorage\.setItem|sessionStorage\.setItem/.test(source));
});

test('not-integrated binding is not displayed as no bank and cannot create a quote', async () => {
  const p = await probe({ bank: { readBankBinding: async () => unavailableBank }, channel: { readChannelWithdrawalOptions: async () => options(unavailableBank, false) } });
  try { await p.render(); assert.match(p.host.textContent, /收款资料暂未接通/); assert.doesNotMatch(p.host.textContent, /尚未绑定收款银行卡/); assert.equal([...p.host.querySelectorAll('button')].some(x => x.textContent === '绑定银行卡'), false); await p.fill('.bank-withdraw-form input', '100'); assert.equal(p.host.querySelector('.bank-withdraw-form button').disabled, true); assert.equal(p.calls.filter(x => x.method === 'quote').length, 0); } finally { await p.close(); }
});

test('editing never prefills previous name/card and saved data is not bank verification', async () => {
  const p = await probe();
  try { await p.render(); await p.click('修改收款资料'); assert.equal(p.host.querySelector('[name="bank-holder-name"]').value, ''); assert.equal(p.host.querySelector('[name="bank-card-number"]').value, ''); assert.match(p.host.textContent, /不代表银行卡开户归属已验证/); assert.doesNotMatch(p.host.querySelector('.bank-saved .info-status-badge').textContent, /验证/); } finally { await p.close(); }
});

test('binding UNKNOWN re-enters original data without allocating a replacement request', async () => {
  const marker = { userId: 'user_A', key: 'old-binding-key', expectedRevision: '0' };
  const p = await probe({ pendingBank: marker, bank: { readBankBinding: async () => emptyBank } });
  try { await p.render(); assert.match(p.host.textContent, /原保存结果待确认/); await p.click('重新输入原资料'); assert.equal(p.host.querySelector('[name="bank-card-number"]').value, ''); await p.fill('[name="bank-holder-name"]', '离线测试甲'); await p.fill('[name="bank-card-number"]', '0000000000000015'); await p.submit('.bank-binding-form'); const call = p.calls.find(x => x.method === 'saveBank'); assert.equal(call.opts.resume, true); assert.deepEqual(call.opts.expectedPending,marker); assert.notEqual(call.opts.expectedPending,marker); assert.equal(call.body.expectedRevision, '0'); assert.equal(call.body.cardNo, '0000000000000015'); assert.equal(p.host.querySelector('.bank-binding-form'), null); } finally { await p.close(); }
});

test('known bank save with failed current read never substitutes its old ACK', async () => {
  const p = await probe({ pendingBank: { userId: 'user_A', key: 'k', expectedRevision: '0' }, bank: { recoverBankBinding: async () => { p.setPendingBank(null); return { knowledge: 'KNOWN', receipt: bank('1','1234'), current: null }; } } });
  try { await p.render(); await p.click('查询原保存结果'); const panel = p.host.querySelector('.bank-binding-panel'); assert.match(panel.textContent, /原保存已确认，当前收款资料还需重新读取/); assert.doesNotMatch(panel.textContent, /1234/); assert.equal(panel.querySelector('.bank-saved'), null); } finally { await p.close(); }
});

test('server quote values require explicit confirmation before withdrawal submission', async () => {
  const p = await probe();
  try { await p.render(); await p.fill('.bank-withdraw-form input', '100'); await p.submit('.bank-withdraw-form'); assert.deepEqual(p.calls.find(x => x.method === 'quote').input, { amountCents: '10000', destinationId: 'bank-1', policyVersion: 'policy-1' }); assert.match(p.host.querySelector('.bank-quote').textContent, /¥99\.00/); assert.equal(p.calls.filter(x => x.method === 'submit').length, 0); await p.click('确认提现申请'); assert.ok(p.host.querySelector('[role="alertdialog"]')); assert.equal(p.calls.filter(x => x.method === 'submit').length, 0); await p.click('确认提交申请'); assert.equal(p.calls.filter(x => x.method === 'submit').length, 1); assert.match(p.host.querySelector('[aria-label="原提现申请记录"]').textContent, /尚未核验/); } finally { await p.close(); }
});

test('invalid or zero amount is explained without issuing a quote', async () => {
  const p = await probe();
  try { await p.render(); for (const input of ['0','1.234','bad']) { await p.fill('.bank-withdraw-form input', input); await p.submit('.bank-withdraw-form'); assert.match(p.host.textContent, /大于0、最多两位小数/); } assert.equal(p.calls.filter(x => x.method === 'quote').length, 0); } finally { await p.close(); }
});

test('unknown withdrawal recovery stays available when new options fail; ACK is not current state', async () => {
  const pending = { userId: 'user_A', key: 'old-native-key', body: { amountCents: '10000', destinationId: 'bank-1', policyVersion: 'policy-1', expectedWalletVersion: quote.expectedWalletVersion } };
  const p = await probe({ pendingNative: pending, channel: { readChannelWithdrawalOptions: async () => { throw new WithdrawalRequestError(503,'NOT_INTEGRATED'); }, recoverChannelWithdrawal: async () => { p.setPendingNative(null); return { knowledge: 'KNOWN', receipt: { ...intent, state: 'SUCCEEDED', originalDestination: { ...intent.originalDestination, cardMask: '**** **** 1234' } }, current: null }; } } });
  try { await p.render(); await p.click('查询原提现申请'); assert.match(p.host.textContent, /原提交已确认，当前申请状态还需重新读取/); assert.equal(p.host.querySelector('[aria-label="原提现申请记录"]'), null); assert.doesNotMatch(p.host.textContent, /1234/); assert.equal(p.calls.filter(x => x.method === 'submit').length, 0); } finally { await p.close(); }
});

test('sources paginate independently and unavailable history is not an empty list', async () => {
  const seen = [];
  const p = await probe({ history: { readWithdrawalHistory: async (_user, query) => { seen.push(query); return query.source === 'HISTORICAL' ? history(query.source,{items:[historyItem(query.cursor?'history:h2':'history:h1')],cursor:query.cursor?null:'history-next',snapshot:'h'}) : query.source === 'LOCAL_CONTROLLED' ? history(query.source,{items:[localItem],cursor:'controlled-next',snapshot:'c'}) : history(query.source,{availability:'NOT_INTEGRATED'}); } } });
  try { await p.render(); const unavailable = p.host.querySelector('[data-history-source="JOINPAY"]'); assert.match(unavailable.textContent, /不表示没有提现记录/); const controlled = p.host.querySelector('[data-history-source="LOCAL_CONTROLLED"]').textContent; await p.click('加载更多旧系统提现记录'); assert.deepEqual(seen.at(-1),{source:'HISTORICAL',cursor:'history-next',limit:20}); assert.equal(p.host.querySelector('[data-history-source="HISTORICAL"]').querySelectorAll('.bank-history-row').length,2); assert.equal(p.host.querySelector('[data-history-source="LOCAL_CONTROLLED"]').textContent, controlled); } finally { await p.close(); }
});

test('historical original destination never falls back to the current bank', async () => {
  const old = { ...nativeItem, originalDestination: null };
  const p = await probe({ history: { readWithdrawalHistory: async (_user, query) => history(query.source,{items:query.source==='JOINPAY'?[old]:[]}), readWithdrawalHistoryItem: async()=>({contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'JOINPAY',availability:'AVAILABLE',reasonCodes:[],data:{item:old,scope:'LOCAL_NATIVE_INTENTS_ONLY'}}) } });
  try { await p.render(); const section = p.host.querySelector('[data-history-source="JOINPAY"]'); await p.click('详情',section); assert.match(section.textContent,/原收款目标未提供/); assert.doesNotMatch(section.textContent,/0015/); assert.match(section.textContent,/尚未核验/); } finally { await p.close(); }
});

test('identity changes hide previous bank data and diagnostics before effect cleanup', async () => {
  const gate = deferred(); let second = false;
  const p = await probe({ bank:{ readBankBinding:async()=>second?gate.promise:bank('1','1111') }, channel:{ readChannelWithdrawalOptions:async()=>second?gate.promise:options(),quoteChannelWithdrawal:async()=>{throw new WithdrawalRequestError(503,'TEST_FAILURE','PRIVATE_A_TRACE');} },history:{readWithdrawalHistory:async(_user,query)=>second?gate.promise:history(query.source)} });
  try { await p.render(); await p.fill('.bank-withdraw-form input','100'); await p.submit('.bank-withdraw-form'); assert.match(p.host.textContent,/PRIVATE_A_TRACE/); const mark=p.commits.length; second=true; p.session.userId='user_B';p.session.identityVersion=2;await p.render();const first=p.commits.slice(mark).find(x=>x.scope==='user_B:2');assert(first);assert.doesNotMatch(first.text,/1111|PRIVATE_A_TRACE/); } finally { await p.close(); }
});

test('editing bank invalidates a late quote without leaving the new quote action permanently busy', async () => {
  const gate=deferred();let current=bank();let quoted=0;
  const p=await probe({bank:{readBankBinding:async()=>current,saveBankBinding:async()=>{current=bank('2','0023');return current;}},channel:{readChannelWithdrawalOptions:async()=>options(current),quoteChannelWithdrawal:async()=>{quoted++;return quoted===1?gate.promise:{...quote,destination:{...quote.destination,revision:'2',mask:'**** **** 0023'}};}}});
  try{await p.render();await p.fill('.bank-withdraw-form input','100');await p.submit('.bank-withdraw-form');await p.click('修改收款资料');await p.fill('[name="bank-holder-name"]','离线测试甲');await p.fill('[name="bank-card-number"]','0000000000000023');await p.submit('.bank-binding-form');gate.resolve(quote);await p.settle();assert.equal(p.host.querySelector('.bank-quote'),null);assert.equal(p.host.querySelector('.bank-withdraw-form button').disabled,false);await p.submit('.bank-withdraw-form');assert.match(p.host.querySelector('.bank-quote').textContent,/0023/);}finally{gate.resolve(quote);await p.close();}
});

test('history-key recovery can show local records without clearing the original ACK recovery slot', async () => {
  const pending={userId:'user_A',key:'native-old-key',body:{amountCents:'10000',destinationId:'bank-1',policyVersion:'policy-1',expectedWalletVersion:quote.expectedWalletVersion}};const seen=[];
  const p=await probe({pendingNative:pending,channel:{readChannelWithdrawalOptions:async()=>{throw new WithdrawalRequestError(503,'NOT_INTEGRATED');}},history:{recoverWithdrawalFromHistory:async(userId,key)=>{seen.push({userId,key});return {contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'JOINPAY',knowledge:'KNOWN',item:nativeItem,mayResubmit:false,receiptMeaning:'CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK'};}}});
  try{await p.render();await p.click('查询原申请本地记录');assert.deepEqual(seen,[{userId:'user_A',key:'native-old-key'}]);assert.match(p.host.querySelector('[aria-label="原申请本地查询结果"]').textContent,/不是原提交回执/);assert.equal(p.channelApi.pendingChannelWithdrawal().key,'native-old-key');assert.equal(p.host.querySelector('.bank-withdraw-form button').disabled,true);assert.equal(p.calls.filter(x=>x.method==='submit').length,0);}finally{await p.close();}
});

test('saved binding with failed latest read clears raw draft and requests a refresh instead of another save', async()=>{
  const p=await probe({bank:{saveBankBinding:async()=>{throw new WithdrawalRequestError(503,'BANK_BINDING_CURRENT_READ_UNAVAILABLE');}}});
  try{await p.render();await p.click('修改收款资料');await p.fill('[name="bank-holder-name"]','离线测试甲');await p.fill('[name="bank-card-number"]','0000000000000015');await p.submit('.bank-binding-form');assert.equal(p.host.querySelector('.bank-binding-form'),null);assert.match(p.host.querySelector('.bank-binding-panel').textContent,/原保存已确认，当前收款资料还需重新读取/);assert.equal(p.host.querySelector('.bank-saved'),null);}finally{await p.close();}
});

test('revoking one history source clears its open private detail without hiding the other sources', async()=>{
  let revoked=false;
  const p=await probe({history:{readWithdrawalHistory:async(_user,query)=>{if(query.source==='JOINPAY'&&revoked)throw new WithdrawalRequestError(403,'FORBIDDEN');return history(query.source,{items:query.source==='JOINPAY'?[nativeItem]:query.source==='LOCAL_CONTROLLED'?[localItem]:[]});},readWithdrawalHistoryItem:async()=>({contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'JOINPAY',availability:'AVAILABLE',reasonCodes:[],data:{item:{...nativeItem,merchantOrderNo:'PRIVATE_DETAIL_BEFORE_REVOCATION'},scope:'LOCAL_NATIVE_INTENTS_ONLY'}})}});
  try{await p.render();const section=p.host.querySelector('[data-history-source="JOINPAY"]');await p.click('详情',section);assert.match(section.textContent,/PRIVATE_DETAIL_BEFORE_REVOCATION/);revoked=true;await p.click('刷新',section);assert.doesNotMatch(section.textContent,/PRIVATE_DETAIL_BEFORE_REVOCATION/);assert.equal(section.querySelector('.bank-history-detail'),null);assert.equal(p.host.querySelector('[data-history-source="LOCAL_CONTROLLED"]').querySelectorAll('.bank-history-row').length,1);}finally{await p.close();}
});

for(const [caseName,changed] of [['missing',null],['different-key',{userId:'user_A',key:'replacement-key',expectedRevision:'0'}],['different-revision',{userId:'user_A',key:'original-key',expectedRevision:'9'}]]){
  test(`recovery form keeps its original mode and stops when marker is ${caseName}`,async()=>{
    const original={userId:'user_A',key:'original-key',expectedRevision:'0'};
    const p=await probe({pendingBank:original,bank:{readBankBinding:async()=>emptyBank}});
    try{await p.render();await p.click('重新输入原资料');await p.fill('[name="bank-holder-name"]','离线测试甲');await p.fill('[name="bank-card-number"]','0000000000000015');p.setPendingBank(changed);await p.submit('.bank-binding-form');assert.equal(p.calls.filter(x=>x.method==='saveBank').length,0);assert.match(p.host.querySelector('.bank-binding-form').textContent,/原保存记录已变化/);assert.match(p.host.querySelector('.bank-binding-form button[type="submit"]').textContent,/核对并恢复原保存/);assert.equal(p.host.querySelector('.bank-binding-form button[type="submit"]').disabled,true);await p.click('取消填写');assert.match(p.host.querySelector('.bank-binding-panel').textContent,/原保存结果待确认/);assert.equal([...p.host.querySelectorAll('.bank-binding-panel button')].some(x=>x.textContent==='修改收款资料'||x.textContent==='绑定银行卡'),false);}finally{await p.close();}
  });
}

test('a new edit never turns itself into a resume when another pending marker appears',async()=>{
  const marker={userId:'user_A',key:'other-request',expectedRevision:'1'};
  const p=await probe();
  try{await p.render();await p.click('修改收款资料');await p.fill('[name="bank-holder-name"]','离线新资料');await p.fill('[name="bank-card-number"]','0000000000000023');p.setPendingBank(marker);await p.submit('.bank-binding-form');assert.equal(p.calls.filter(x=>x.method==='saveBank').length,0);assert.match(p.host.querySelector('.bank-binding-form').textContent,/发现待确认的原保存/);assert.equal(p.host.querySelector('.bank-binding-form button[type="submit"]').textContent,'保存收款资料');await p.click('重新输入原资料');assert.equal(p.host.querySelector('[name="bank-holder-name"]').value,'');assert.equal(p.host.querySelector('[name="bank-card-number"]').value,'');await p.fill('[name="bank-holder-name"]','离线原资料');await p.fill('[name="bank-card-number"]','0000000000000015');await p.submit('.bank-binding-form');const call=p.calls.find(x=>x.method==='saveBank');assert.equal(call.opts.resume,true);assert.deepEqual(call.opts.expectedPending,marker);assert.equal(call.body.expectedRevision,'1');}finally{await p.close();}
});

test('readonly recovery uses the selected original key after marker replacement and leaves the other request intact',async()=>{
  const original={userId:'user_A',key:'original-key',expectedRevision:'0'},replacement={userId:'user_A',key:'replacement-key',expectedRevision:'1'},seen=[];
  const p=await probe({pendingBank:original,bank:{recoverBankBinding:async(userId,opts)=>{seen.push({userId,expectedPending:opts.expectedPending});return {knowledge:'KNOWN',receipt:bank('1'),current:bank('2','0023')};}}});
  try{await p.render();await p.click('重新输入原资料');p.setPendingBank(replacement);await p.submit('.bank-binding-form');await p.click('查询原保存结果');assert.deepEqual(seen,[{userId:'user_A',expectedPending:original}]);assert.deepEqual(p.bankApi.pendingBankBinding(),replacement);assert.equal(p.calls.filter(x=>x.method==='saveBank').length,0);assert.match(p.host.querySelector('.bank-binding-panel').textContent,/原保存结果待确认/);}finally{await p.close();}
});

test('formal admission quota/age blockers use their exact server reason copy, not a generic failure', async () => {
  const p = await probe({ channel: { readChannelWithdrawalOptions: async () => ({ ...options(bank(), false),
    reasonCodes: ['ADULT_STATUS_REQUIRED', 'WITHDRAWAL_QUOTA_EXHAUSTED'] }) } });
  try {
    await p.render();
    assert.match(p.host.textContent, /当前年龄资料不符合提现要求/);
    assert.match(p.host.textContent, /今日提现申请次数已用完/);
    assert.doesNotMatch(p.host.textContent, /暂未满足服务端提现条件/);
  } finally { await p.close(); }
});
