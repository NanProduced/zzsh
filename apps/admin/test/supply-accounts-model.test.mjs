import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestKind, kindHint, groupConditions, liftSummary, conditionHeadline, independentFacts, parseSavedViews, serializeSavedViews, rowListingStatus, nextStep, primaryReason } from '../src/views/supply-accounts/account-list-model.ts';

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

import { compactTime, versionText, idTail } from '../src/views/supply-accounts/account-list-model.ts';
test('row reason: primary + others, concrete next steps, compact time', () => {
  const r = primaryReason(facts({ staffRestricted: true, primaryReasonCode: 'STAFF_RESTRICTED', newOrders: false, reasons: ['STAFF_RESTRICTED', 'OCCUPIED', 'FUNDING_UNKNOWN'] }));
  assert.equal(r.code, 'STAFF_RESTRICTED'); assert.equal(r.others, 2);
  assert.equal(nextStep('RULE_CHANGED'), '按新规则重新核价并确认');
  assert.ok(!['STAFF_RESTRICTED','OWNER_PAUSED','RULE_CHANGED','FUNDING_UNKNOWN','X'].map(nextStep).includes('平台'));
  assert.equal(compactTime('2026-10-12T12:11:00.000000Z', new Date('2026-10-12T00:00:00Z')), '10-12 20:11');
  assert.equal(versionText(null), '版本未提供'); assert.equal(idTail('account_362b3c1f8efe'), '…1f8efe');
});

/* ---------- F2：列表事实只来自正式摘要，缺值保持未提供 ---------- */
import {
  alignedQuickRow, rowHaffText, rowQuoteText, rowDepositText, rowGuaranteeRequirementText,
  rowGuaranteeEligibilityText, rowGuaranteeProofText, rowFullPayout,
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
  assert.equal(rowListingStatus(rowOf({ facts: facts({ occupancy: 'OCCUPIED', publicVisible: true }) })).label, '占用中');
  assert.equal(rowListingStatus(rowOf({ facts: facts({ occupancy: 'OCCUPIED', occupancyKind: 'PENDING_PAYMENT', publicVisible: true, newOrders: false }) })).label, '待付款预留');
  assert.equal(rowListingStatus(rowOf({ facts: facts({ occupancy: 'OCCUPIED', occupancyKind: 'RENTED', publicVisible: true, newOrders: false }) })).label, '租用中');
  assert.equal(rowListingStatus(rowOf({ facts: facts({ publicVisible: true, newOrders: false, occupancy: 'FREE' }) })).label, '可查看');
  assert.notEqual(rowListingStatus(rowOf({ facts: facts({ publicVisible: true, newOrders: false }) })).label, '上架中');
  assert.equal(rowListingStatus(rowOf({ facts: facts({ publicVisible: true, newOrders: true, occupancy: 'FREE' }) })).label, '可接新单');
});

test('an unfinished draft is one step, not three operational faults', () => {
  const draft = facts({ publicVisible: false, newOrders: false, reasons: ['RULE_CHANGED', 'PUBLICATION_REQUIRED', 'CONFIRMATION_OR_MEDIA_REQUIRED', 'QUOTE_REQUIRED'] });
  const g = groupConditions(draft);
  assert.equal(g.blocked.filter(item => ['RULE_CHANGED', 'PUBLICATION_REQUIRED', 'CONFIRMATION_OR_MEDIA_REQUIRED', 'QUOTE_REQUIRED'].includes(item.code)).length, 1);
  assert.equal(primaryReason(draft).code, 'QUOTE_REQUIRED');
  assert.match(nextStep('QUOTE_REQUIRED'), /草稿/);
  assert.doesNotMatch(nextStep('RULE_CHANGED'), /重建资料/);
  const bail = facts({ publicVisible: true, newOrders: null, reasons: ['PUBLISHER_BAIL_UNCONFIRMED'] });
  assert.equal(groupConditions(bail).pending.length, 1);
  assert.equal(groupConditions(bail).pending[0].code, 'PUBLISHER_BAIL_UNCONFIRMED');
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

const historicalRead = {
  resourceNo: 'OLD-7', canCreateOrder: false, trade: 'UNKNOWN', quote: null,
  historicalQuote: { haffRentYuan: '125.30', goodsYuan: '0.00', depositYuan: '0.00', termDays: '10', dailyHaffBase: '10000000' },
  display: { state: 'KNOWN', facts: { resources: [{ code: 'haff', name: '哈夫币', quantity: '0', unit: 'HAFF_BASE' }] } },
};

test('historical display fills missing list facts with explicit provenance and preserves zero', () => {
  const historical = rowOf({ facts: facts({ historicalRead }) });
  assert.equal(rowHaffText(historical), '历史 0 M 哈夫币');
  assert.equal(rowDepositText(historical), '历史 ¥0.00');
  assert.equal(rowQuoteText(historical).total, '历史租金 ¥125.30');
  assert.match(rowQuoteText(historical).note, /历史物资费 ¥0.00.*10 天.*非当前报价/);
  const notImported = rowOf({ facts: facts({ historicalRead: { ...historicalRead, display: { state: 'NOT_IMPORTED', facts: null } } }) });
  assert.equal(rowHaffText(notImported), '未提供', 'daily consumption is never read as inventory');
});

test('current list facts stay authoritative when separate historical facts also exist', () => {
  const current = rowOf({ facts: facts({ historicalRead }), summary: {
    haff: { quantity: '12500000' }, baseDeposit: { amountCents: '5000' },
    quote: { resourceTotal: { amount: '212.77' }, personalised: false },
  } });
  assert.equal(rowHaffText(current), '12.5 M 哈夫币');
  assert.equal(rowDepositText(current), '¥50.00');
  assert.equal(rowQuoteText(current).total, '¥212.77');
  assert.equal(rowHaffText({ ...current, summary: { ...current.summary, haff: { quantity: null } } }), '未确认', 'a current unknown does not silently become historical inventory');
});

test('cross-version quickview keeps the loaded declaration and separates zero, absent and unknown deposits', () => {
  const row = rowOf({ summary: { versionId: 'v-1', baseDeposit: { amountCents: '11100' } } });
  const read = (declaration) => alignedQuickRow(row, { version: { id: 'v-3', quote: null, presentation: { items: [] }, catalogItems: [], declaration: { inventory: [], attributes: { owner_deposit_declaration: declaration } } } });
  const declaration = (amountCents) => ({ schema: 'owner-deposit-declaration-v1', declarationVersion: 'v-3', amountCents });
  assert.equal(rowDepositText(read(declaration('9900'))), '¥99.00');
  assert.equal(rowDepositText(read(declaration('0'))), '¥0.00');
  assert.equal(rowDepositText(read(null)), '未申报');
  for (const value of [undefined, declaration('1e2'), declaration('1.1'), declaration('-1'), { ...declaration('9900'), schema: 'unknown' }]) {
    assert.equal(rowDepositText(read(value)), '未提供');
  }
  assert.equal(rowDepositText(alignedQuickRow(row)), '¥111.00');
});
