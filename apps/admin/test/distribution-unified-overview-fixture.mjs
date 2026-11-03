// Synthetic response only; not service, PG, migration or financial acceptance.
export const metric = (cents = '0', count = '0') => ({ knowledge: 'KNOWN', cents, count, reasonCodes: [] });
export const overviewFixture = () => ({
  asOf: '2026-11-03T03:42:00Z', snapshotVersion: 'fixture-only', applied: { rankingLimit: 10 }, scope: { network: 'AVAILABLE' },
  current: { settled: metric('4441695', '12'), pending: metric('0'), recovery: metric('20', '1'), needsReview: metric('390891', '3') },
  recordSummary: { knowledge: 'UNKNOWN', mappedRecordCount: '16', coverage: { knowledge: 'UNKNOWN' }, reasonCodes: [] },
  flow: { settled: metric('95', '1'), accrued: metric('100', '1'), orders: metric('0', '1'), unconfirmedCreditCount: '2', unconfirmedOccurredCount: '0' },
  trend: [{ date: '2026-11-02', cents: '95', accruedCents: '100', knowledge: 'KNOWN' }, { date: '2026-11-03', cents: '0', accruedCents: '0', knowledge: 'KNOWN' }],
  rankings: { earnings: [{ rank: 1, userId: 'u-1', name: '可读受益人', cents: '4441695', roles: ['OWNER_REFERRAL'], count: '12' }], directInvites: { knowledge: 'KNOWN', reasonCodes: [], items: [{ rank: 1, userId: 'u-1', name: '可读受益人', cents: '0', roles: [], count: '4' }] } },
  participants: { participants: metric('0', '8'), eligible: metric('0', '6'), frozen: metric('0', '1'), inviter: metric('0', '5'), leader: metric('0', '4') },
  recent: [{ id: 'record-1', source: 'LEGACY', beneficiaryId: 'u-1', beneficiaryName: '可读受益人', role: 'OWNER_REFERRAL', orderId: null, orderNumber: 'DIST-1', amountCents: '9007199254740993', recoveryRequiredCents: null, state: 'UNKNOWN', occurredAt: '2024-01-02T03:00:00Z', settledAt: null }], reasonCodes: [],
});
