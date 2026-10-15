import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestKind, kindHint, groupConditions, liftSummary, conditionHeadline, independentFacts, parseSavedViews, serializeSavedViews } from '../src/views/supply-accounts/account-list-model.ts';

const facts = (o = {}) => ({ publicVisible: true, publicSource: null, newOrders: true, reasons: [], ownerPaused: false, staffRestricted: false, occupancy: 'FREE', sources: [], legacyNumbers: [], ...o });

test('search type is only a suggestion; pure digits never become nickname', () => {
  assert.equal(suggestKind('88213'), null);
  assert.ok(kindHint('88213', 'nickname').includes('纯数字'));
  assert.equal(suggestKind('小鹿出租'), 'nickname');
  assert.equal(suggestKind('ZZ-D-1'), null);
  assert.equal(suggestKind('account_abc'), 'account');
});

test('pending conditions are counted, never folded into satisfied', () => {
  const g = groupConditions(facts({ staffRestricted: true, newOrders: false, reasons: ['STAFF_RESTRICTED', 'PUBLISHER_BAIL_UNCONFIRMED'] }));
  assert.equal(g.blocked.length, 1); assert.equal(g.pending.length, 1);
  assert.equal(liftSummary(g), '另有 0 项已确认阻塞、1 项待核；解除后重新检查接单资格');
  assert.ok(!conditionHeadline(g).includes('全部满足'));
  const u = groupConditions(facts({ newOrders: null, publicVisible: null }));
  assert.ok(u.pending.length >= 1);
});

test('independent facts: occupied and restricted at once', () => {
  const f = independentFacts(facts({ occupancy: 'OCCUPIED', staffRestricted: true, newOrders: false, reasons: ['OCCUPIED', 'STAFF_RESTRICTED'] }));
  assert.equal(f.find(x => x.label === '占用').value, '占用中');
  assert.equal(f.find(x => x.label === '运营限制').value, '限制中');
  assert.ok(!JSON.stringify(f).includes('正在出租'));
});

test('missing flags and independent unknowns never become satisfied conditions', () => {
  const value = facts({ staffRestricted: undefined, ownerPaused: undefined, newOrders: null, publicVisible: null, occupancy: 'UNKNOWN', reasons: ['FUNDING_UNKNOWN'] });
  const g = groupConditions(value);
  assert.deepEqual(g.satisfied, []);
  assert.deepEqual(g.pending.map(x => x.code).sort(), ['FUNDING_UNKNOWN', 'NEW_ORDERS_UNKNOWN', 'OCCUPANCY_UNKNOWN', 'PAUSE_UNKNOWN', 'PUBLIC_UNKNOWN', 'RESTRICTION_UNKNOWN'].sort());
  assert.equal(independentFacts(value).find(x => x.label === '运营限制').value, '待核');
  assert.equal(independentFacts(value).find(x => x.label === '号主暂停').value, '待核');
  assert.equal(groupConditions(facts({ occupancy: 'UNKNOWN', reasons: ['OCCUPANCY_UNKNOWN'] })).pending.filter(x => x.code === 'OCCUPANCY_UNKNOWN').length, 1);
});

test('saved views validate corrupt, stale, foreign and partial data', () => {
  assert.ok(parseSavedViews('{bad', 'me').notice.includes('损坏'));
  assert.ok(parseSavedViews(JSON.stringify({ version: 0, views: [] }), 'me').notice.includes('过期'));
  assert.ok(parseSavedViews(serializeSavedViews([], 'other'), 'me').notice.includes('不属于'));
  const raw = JSON.stringify({ version: 1, adminId: 'me', views: [{ name: 'a', view: 'all', kind: 'account', q: '', gameId: '' }, { name: 'b', view: 'rule', kind: 'account', q: '', gameId: '' }] });
  const r = parseSavedViews(raw, 'me'); assert.equal(r.views.length, 1); assert.ok(r.notice.includes('跳过 1'));
  assert.deepEqual(parseSavedViews(null, 'me'), { views: [] });
});

import { primaryReason, nextStep, compactTime, versionText, idTail } from '../src/views/supply-accounts/account-list-model.ts';
test('row reason: primary + others, concrete next steps, compact time', () => {
  const r = primaryReason(facts({ staffRestricted: true, primaryReasonCode: 'STAFF_RESTRICTED', newOrders: false, reasons: ['STAFF_RESTRICTED', 'OCCUPIED', 'FUNDING_UNKNOWN'] }));
  assert.equal(r.code, 'STAFF_RESTRICTED'); assert.equal(r.others, 2);
  assert.equal(nextStep('RULE_CHANGED'), '号主按新规则重建资料');
  assert.ok(!['STAFF_RESTRICTED','OWNER_PAUSED','RULE_CHANGED','FUNDING_UNKNOWN','X'].map(nextStep).includes('平台'));
  assert.equal(compactTime('2026-10-12T12:11:00.000000Z', new Date('2026-10-12T00:00:00Z')), '10-12 20:11');
  assert.equal(versionText(null), '版本未提供'); assert.equal(idTail('account_362b3c1f8efe'), '…1f8efe');
});

/* ---------- F2：列表事实只来自正式摘要，缺值保持未提供 ---------- */
import {
  rowHaffText, rowQuoteText, rowDepositText, rowGuaranteeRequirementText,
  rowGuaranteeEligibilityText, rowGuaranteeProofText, rowFullPayout, rowListingStatus,
} from '../src/views/supply-accounts/account-list-model.ts';

const rowOf = (over = {}) => ({ id: 'a', accountId: 'a', displayNo: 'A-1', ownerId: 'u-1', ownerName: '阿洛', revision: '3', gameName: 'g', versionId: 'v-1', sequence: '2', title: '100M 不包赔账号 3x3箱', reviewState: 'PUBLISHED', sortAt: '2026-10-03T00:00:00.000000Z', facts: facts(), ...over });

test('missing summary never becomes 免保证金、未交、已包赔 or 已下架', () => {
  const bare = rowOf();
  assert.equal(rowGuaranteeRequirementText(bare), '要求未提供（摘要未装配）');
  assert.equal(rowGuaranteeEligibilityText(bare), '资格未提供');
  assert.equal(rowGuaranteeProofText(bare), '凭证事实未提供（摘要未装配）');
  assert.equal(rowFullPayout(bare).label, '未提供');
  assert.equal(rowHaffText(bare), '未提供', 'the 100M in the title is never a quantity');
  assert.equal(rowDepositText(bare), '摘要未装配');
  assert.equal(rowQuoteText(bare).total, '未提供');
  assert.ok(!rowFullPayout(bare).label.includes('❌'));
  for (const text of [rowDepositText(bare), rowGuaranteeProofText(bare), rowGuaranteeRequirementText(bare)]) {
    assert.ok(!['未申报', '无凭证记录', '政策不要求'].includes(text), text);
  }
});

test('R2 only a delivered summary can confirm absence of a declaration or proof', () => {
  const guarantee = (over = {}) => ({ requirement: null, requirementSource: 'UNAVAILABLE', eligibility: null, recordedProof: null, ...over });
  const declared = rowOf({ summary: { versionId: 'v-1', sequence: '2', refs: {}, timing: {}, haff: null, quote: null, baseDeposit: null, fullPayout: 'NOT_DECLARED', guarantee: guarantee() } });
  assert.equal(rowDepositText(declared), '未申报', 'the server read the declaration and found none');
  assert.equal(rowGuaranteeProofText(declared), '无凭证记录', 'the server read the proof table and found no row');
  assert.equal(rowGuaranteeRequirementText(declared), '要求未提供');
  const present = rowOf({ summary: { ...declared.summary, baseDeposit: { amountCents: '5000' }, guarantee: guarantee({ requirement: { mode: 'NOT_REQUIRED', requiredCents: '0' }, requirementSource: 'CREDIT_GUARANTEE' }) } });
  assert.equal(rowDepositText(present), '¥50.00');
  assert.equal(rowGuaranteeRequirementText(present), '信用机制不要求');
  const legacy = rowOf({ summary: { ...declared.summary, guarantee: guarantee({ requirement: { mode: 'NOT_REQUIRED', requiredCents: '0' }, requirementSource: 'FIXED_FUNDING_POLICY' }) } });
  assert.equal(rowGuaranteeRequirementText(legacy), '固定政策不要求', 'the basis stays visible so a stale fixed policy is not read as credit-waived');
  const required = rowOf({ summary: { ...declared.summary, guarantee: guarantee({ requirement: { mode: 'FIXED_CENTS', requiredCents: '500' }, requirementSource: 'CREDIT_GUARANTEE', eligibility: 'UNCONFIRMED' }) } });
  assert.equal(rowGuaranteeRequirementText(required), '要求 ¥5.00（信用机制）');
  assert.equal(rowGuaranteeEligibilityText(required), '资格待核', 'a credit requirement and its eligibility stay two separate statements');
});

test('unknown axes stay unknown instead of collapsing into 已下架', () => {
  const unknown = rowOf({ facts: facts({ publicVisible: null, newOrders: null, occupancy: 'UNKNOWN', ownerPaused: undefined, staffRestricted: undefined, reasons: ['OCCUPANCY_UNKNOWN'] }) });
  assert.equal(rowListingStatus(unknown).label, '公开状态待核');
  for (const state of [rowOf({ facts: facts({ publicVisible: false }) }), rowOf({ facts: facts({ publicVisible: true }) })]) {
    assert.notEqual(rowListingStatus(state).label, '已下架');
  }
  assert.equal(rowListingStatus(rowOf({ facts: facts({ staffRestricted: true, reasons: ['STAFF_RESTRICTED'] }) })).label, '运营限制');
  assert.equal(rowListingStatus(rowOf({ facts: facts({ occupancy: 'OCCUPIED', publicVisible: true }) })).label, '已出租');
});

test('guarantee requirement, eligibility and recorded proof are three separate statements', () => {
  const summary = (over = {}) => ({ versionId: 'v-1', sequence: '2', refs: {}, timing: { accountCreatedAt: 'x' }, haff: null, quote: null, baseDeposit: null, fullPayout: 'NOT_DECLARED', guarantee: { requirement: null, requirementSource: 'UNAVAILABLE', eligibility: null, recordedProof: null }, ...over });
  const waived = rowOf({ summary: summary({ guarantee: { requirement: { mode: 'NOT_REQUIRED', requiredCents: '0' }, requirementSource: 'FIXED_FUNDING_POLICY', eligibility: 'CONFIRMED', recordedProof: null } }) });
  assert.equal(rowGuaranteeRequirementText(waived), '固定政策不要求');
  assert.equal(rowGuaranteeEligibilityText(waived), '资格已确认');
  const required = rowOf({ summary: summary({ guarantee: { requirement: { mode: 'FIXED_CENTS', requiredCents: '300000' }, requirementSource: 'CREDIT_GUARANTEE', eligibility: 'UNCONFIRMED', recordedProof: { id: 'p1', versionNo: '2', ownerUserId: 'u-1', priceVersionId: 'price-1', policyVersion: '1', status: 'SATISFIED', requiredCents: '300000', coveredCents: '300000', validUntil: '2026-12-01T00:00:00.000000Z', valid: true } } }) });
  assert.equal(rowGuaranteeRequirementText(required), '要求 ¥3,000.00（信用机制）');
  assert.equal(rowGuaranteeEligibilityText(required), '资格待核');
  const proofText = rowGuaranteeProofText(required);
  assert.ok(proofText.includes('覆盖达标凭证') && proofText.includes('不代表现金到账或退款'), proofText);
  assert.ok(!proofText.includes('已缴'));
});

test('declared payout and frozen amounts keep their exact three states and decimal strings', () => {
  const summary = (over = {}) => ({ refs: {}, timing: {}, haff: null, quote: null, baseDeposit: null, fullPayout: 'NOT_DECLARED', guarantee: { requirement: null, requirementSource: 'UNAVAILABLE', eligibility: null, recordedProof: null }, ...over });
  for (const [state, label] of [['SELECTED', '已选'], ['NOT_SELECTED', '未选'], ['NOT_DECLARED', '未申报']]) {
    assert.equal(rowFullPayout(rowOf({ summary: summary({ fullPayout: state }) })).label, label);
  }
  const money = rowOf({ summary: summary({ haff: { itemId: 'haff-unit', quantity: '12500000', unit: 'HAFF_BASE' }, baseDeposit: { amountCents: '5000' }, quote: { currency: 'CNY', resourceTotal: { amount: '212.77', currency: 'CNY', unit: 'yuan', scale: '2' }, tenantDeposit: null, tenantPayableTotal: null, frozen: true, personalised: false } }) });
  assert.equal(rowHaffText(money), '12.5 M 哈夫币', 'exact quantity, no integer truncation');
  assert.equal(rowQuoteText(money).total, '¥212.77', 'no rounding to whole yuan');
  assert.match(rowQuoteText(money).note, /非下单应付/);
  assert.equal(rowDepositText(money), '¥50.00');
});
