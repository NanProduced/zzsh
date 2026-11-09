import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../src/auth/security-core";
import { createLocalSandboxCheckoutSigner, signLocalSandboxCheckout, verifyLocalSandboxCheckout, localSandboxPaymentAnchor } from "../src/order/local-sandbox-checkout-crypto";
import { createSandboxControlledPaymentSource, confirmOrderPayment, type PaymentInput } from "../src/order/payment-confirmation";
import type { PaymentDistributionStore } from "../src/finance/distribution-payment-store";
import { sandboxFixture, sandboxClient, sandboxResource } from "./local-financial-sandbox-fixture";
import { localFinancialSandboxRegistration } from "../src/finance/local-financial-sandbox-resource";
import {issueLocalSandboxCheckout,completeLocalSandboxCheckout,readLocalSandboxCheckoutReceipt,readLocalSandboxCheckoutAvailability,LocalSandboxCheckoutCommitUnknown} from '../src/order/local-sandbox-checkout-service';

const actor = { userId: 'renter', sessionId: 'session' }, at = '2026-11-02T10:02:00.000Z';
test('genuine checkout ticket binds original money/user/session/order/time/resource and copied signer never verifies', () => {
  const sandbox = sandboxFixture(), key = Buffer.alloc(32, 7), signer = createLocalSandboxCheckoutSigner(sandbox, key); key.fill(0);
  const claims = { schema: 'local-sandbox-checkout.v1' as const, sandboxDigest: localFinancialSandboxRegistration(sandbox).digest,
    checkoutId: 'checkout', userId: actor.userId, sessionHash: createHash('sha256').update(actor.sessionId).digest('hex'), orderId: 'order',
    displayNo: 'ZZ_TEST_1', amountCents: '200', currency: 'CNY' as const, orderCreatedAt: '2026-11-02T10:00:00.000Z', issuedAt: '2026-11-02T10:01:00.000Z', expiresAt: '2026-11-02T10:03:00.000Z' };
  const token = signLocalSandboxCheckout(signer, claims); assert.equal(verifyLocalSandboxCheckout(signer, token, actor, 'order', at).amountCents, '200');
  for (const who of [{ ...actor, userId: 'other' }, { ...actor, sessionId: 'other' }]) assert.throws(() => verifyLocalSandboxCheckout(signer, token, who, 'order', at));
  for (const time of [claims.expiresAt, '2026-11-02T10:00:59.999Z']) assert.throws(() => verifyLocalSandboxCheckout(signer, token, actor, 'order', time));
  assert.throws(() => verifyLocalSandboxCheckout(signer, token, actor, 'other', at));
  assert.throws(() => verifyLocalSandboxCheckout({ ...signer }, token, actor, 'order', at));
  assert.throws(() => verifyLocalSandboxCheckout(createLocalSandboxCheckoutSigner(sandbox, Buffer.alloc(32, 8)), token, actor, 'order', at));
  const [body, sig] = token.split('.'); const tampered = { ...JSON.parse(Buffer.from(body!, 'base64url').toString()), amountCents: '201' };
  assert.throws(() => verifyLocalSandboxCheckout(signer, Buffer.from(JSON.stringify(tampered)).toString('base64url') + '.' + sig, actor, 'order', at));
  for (const patch of [{ amountCents: '2.00' }, { amountCents: '-1' }, { currency: 'USD' }, { expiresAt: '2026-11-02T10:03:00.001Z' }, { extra: true }]) assert.throws(() => signLocalSandboxCheckout(signer, { ...claims, ...patch } as typeof claims));
});

function kernelProbe(options: { freezeAtPartyLock?: boolean; revokeAtPartyLock?: boolean; expireAtOrderLock?: boolean; auditFailure?: boolean; wrongAmount?: boolean } = {}) {
  const sandbox = sandboxFixture(), base = sandboxClient(sandbox), proof = localFinancialSandboxRegistration(sandbox), anchor = localSandboxPaymentAnchor(sandbox, 'order');
  const input: PaymentInput = { orderId: 'order', merchantOrderNo: 'ZZ_TEST_1', providerTransactionId: anchor.providerTransactionId, amountCents: '200', currency: 'CNY', providerPaidAt: '2026-11-02T10:00:00.000Z', requestId: anchor.requestId };
  let frozen = false, revoked = false, expired = false, declaration: Record<string, unknown> | undefined, confirmation: Record<string, unknown> | undefined;
  let admission:Record<string,unknown>|undefined={id:'admission',mode:'LOCAL_CONTROLLED',resource_oid:2400547,resource_name:sandboxResource.database,resource_marker:sandboxResource.marker,approval_digest:proof.digest};
  let snapshot:any,idem=new Map<string,any>(),commits=0;const controls={clock:at,commitUnknownAt:0,eligible:true};
  const seen: string[] = [];
  const query = async (sql: string, values: any[] = []): Promise<any> => {
    seen.push(sql); const one = (value?: unknown) => ({ rows: value ? [value] : [], rowCount: value ? 1 : 0 });
    if (sql === 'BEGIN') { snapshot = structuredClone({ declaration, confirmation,admission,idem }); return one(); }
    if (sql === 'ROLLBACK') { if(snapshot){declaration = snapshot.declaration; confirmation = snapshot.confirmation;admission=snapshot.admission;idem=snapshot.idem;} return one(); }
    if (sql === 'COMMIT') {commits++;snapshot=undefined;if(controls.commitUnknownAt===commits)throw Error('synthetic commit ACK lost');return one();}
    if(sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'||sql==='SET CONSTRAINTS ALL IMMEDIATE'||sql.startsWith('SELECT set_config'))return one();
    if(sql.includes('FROM "zzsh_supply"."idempotency_record"'))return one(idem.get(values[0]+'|'+values[1]));
    if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){idem.set(values[0]+'|'+values[1],{requestFingerprint:values[2],responseStatus:values[3],responseBody:JSON.parse(values[4]),publishRequired:false});return one();}
    if(sql.startsWith('SELECT response_status,response_body')){const r=idem.get(values[0]+'|'+values[1]);return one(r&&{response_status:r.responseStatus,response_body:r.responseBody});}
    if(sql.startsWith('SELECT to_char(clock_timestamp()'))return one({at:controls.clock});
    if(sql.startsWith('SELECT id,display_no,status,currency'))return values[1]===actor.userId?one({id:'order',display_no:'ZZ_TEST_1',status:confirmation?'PAID':'PENDING_PAYMENT',currency:'CNY',amount_cents:'200',created_at:'2026-11-02T10:00:00.000Z',hold_until:'2026-11-02T10:10:00.000Z'}):one();
    if(sql.startsWith('SELECT count(a.id)=1 AS eligible'))return one({eligible:controls.eligible});
    if(sql.startsWith('SELECT id,mode,resource_oid'))return one(admission);
    if(sql.startsWith('SELECT a.id'))return one({id:'creation_fixture'});
    if(sql.startsWith('INSERT INTO zzsh_order.distribution_order_admission')){admission={id:values[0],mode:'LOCAL_CONTROLLED',resource_oid:2400547,resource_name:sandboxResource.database,resource_marker:sandboxResource.marker,approval_digest:proof.digest};return one();}
    if (sql.includes("FROM zzsh_order.distribution_order_admission WHERE order_id=$1 AND mode='LOCAL_CONTROLLED'")) return one(admission);
    if (sql.startsWith('SELECT renter_user_id FROM zzsh_order.rental_order')) return one({ renter_user_id: actor.userId });
    if (sql.startsWith('SELECT "suspended"')) return one({ suspended: frozen });
    if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return one({ accountStatus: frozen ? 'FROZEN' : 'ACTIVE' });
    if (sql.includes('FROM "zzsh_auth_user"."session"')) return revoked ? one() : one({ ok: 1 });
    if (sql.includes('current_database() AS db')) return one({ db: sandboxResource.database, actor: sandboxResource.runtimeRole });
    if (sql.includes('pg_advisory_xact_lock')) return one({ ok: 1 });
    if (sql.includes('FROM zzsh_order.payment_confirmation')) return one(confirmation);
    if (sql.startsWith('SELECT account_id')) return one({ account_id: 'account', renter_user_id: actor.userId, owner_user_id: 'owner' });
    if (sql.includes('WHERE id = ANY')) { frozen = options.freezeAtPartyLock === true; revoked = options.revokeAtPartyLock === true; return { rows: [{ id: 'owner' }, { id: 'renter' }], rowCount: 2 }; }
    if (sql.startsWith('SELECT id FROM zzsh_supply.rental_account')) return one({ id: 'account' });
    if (sql.startsWith('SELECT status, display_no')) { expired = options.expireAtOrderLock === true; return one({ status: 'PENDING_PAYMENT', display_no: input.merchantOrderNo, currency: 'CNY', total: options.wrongAmount ? '201' : input.amountCents, hold: '2026-11-02T10:10:00.000000Z' }); }
    if (sql.includes(' AS accepted,')) return one({ accepted: controls.clock.slice(0,-1)+'000Z', open: true, checkout_open: !expired&&Date.parse(controls.clock)<Date.parse(values[1]) });
    if (sql.startsWith('INSERT INTO zzsh_order.controlled_payment_declaration')) { declaration = { canonical_payment: values[9], payment_digest: values[10], approval_digest: proof.digest, resource_oid: 2400547, app_id: 'app' }; return one(); }
    if (sql.includes('FROM zzsh_order.controlled_payment_declaration')) return one(declaration);
    if (sql.startsWith('INSERT INTO zzsh_order.payment_confirmation')) { confirmation = { id: values[0], ...input, disposition: 'APPLIED', reasonCode: null }; return one(); }
    if (sql.startsWith('UPDATE zzsh_order.rental_order') || sql.startsWith('INSERT INTO zzsh_order.im_order_group')) return one({ ok: 1 });
    if (sql.includes('FROM zzsh_order.payment_confirmation') && sql.includes('WHERE id = $1 AND order_id = $2')) {
      return one({ id: values[0], amountCents: input.amountCents, currency: 'CNY', disposition: 'APPLIED' });
    }
    if (sql.includes('FROM zzsh_order.rental_opening WHERE order_id = $1')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM zzsh_order.rental_order o')) {
      return one({ id: 'order', renterUserId: actor.userId, ownerUserId: 'owner', accountId: 'account', listingVersionId: 'listing',
        gameId: 'game', status: 'PAID', depositCents: '0', contentHash: 'hash', ruleReleaseId: 'release', quote: null, revision: '1', appId: 'app' });
    }
    if (sql.includes('INSERT INTO zzsh_order.rental_opening_generation')) return one({ ok: 1 });
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (options.auditFailure) throw Error('synthetic audit unavailable'); return one({ ok: 1 }); }
    return base.query(sql, values);
  };
  const client = { query, release() {} } as unknown as PoolClient, pool = { connect: async () => client } as unknown as Pool;
  const source = createSandboxControlledPaymentSource({ sandbox, payerUserId: actor.userId, payerSessionId: actor.sessionId, checkoutExpiresAt: '2026-11-02T10:03:00.000Z', appId: 'app' });
  const distribution = { prepare: async () => { seen.push('GRAPH_LOCK'); return { orderId: 'order' }; }, record: async () => ({}), readOriginal: async () => ({ knowledge: 'KNOWN' }) } as unknown as PaymentDistributionStore;
  const checkout={sandbox,signer:createLocalSandboxCheckoutSigner(sandbox,Buffer.alloc(32,7)),appId:'app',distribution};
  return { client, pool, input, source, distribution, checkout,controls,seen,clearAdmission(){admission=undefined;},state: () => ({ declaration, confirmation }) };
}

test('registered payment kernel writes its durable source after all original locks and then replays one original transaction', async () => {
  const p = kernelProbe(), fact = p.source(p.input), result = await withTransaction(p.pool, c => confirmOrderPayment(c, fact, p.distribution));
  assert.equal(result.disposition, 'APPLIED');
  const declare = p.seen.findIndex(sql => sql.startsWith('INSERT INTO zzsh_order.controlled_payment_declaration'));
  assert(declare > p.seen.indexOf('GRAPH_LOCK')); assert(declare > p.seen.findIndex(sql => sql.includes('WHERE id = ANY')));
  assert(declare > p.seen.findIndex(sql => sql.startsWith('SELECT status, display_no')));
  const writes = p.seen.filter(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)).length;
  assert.equal((await confirmOrderPayment(p.client, p.source(p.input), p.distribution)).replay, true);
  assert.equal(p.seen.filter(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)).length, writes);
});

test('freeze/session revocation or signed-ticket expiry while waiting cannot write a declaration, payment or money', async () => {
  for (const options of [{ freezeAtPartyLock: true }, { revokeAtPartyLock: true }, { expireAtOrderLock: true }, { wrongAmount: true }]) {
    const p = kernelProbe(options); await assert.rejects(withTransaction(p.pool, c => confirmOrderPayment(c, p.source(p.input), p.distribution)));
    assert(!p.seen.some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql))); assert.equal(p.seen.at(-1), 'ROLLBACK');
  }
  const p = kernelProbe(); await assert.rejects(confirmOrderPayment(p.client, { ...p.source(p.input) }, p.distribution)); assert.equal(p.seen.length, 0);
});

test('audit failure rolls the original local declaration and confirmation back together, never acknowledging success', async () => {
  const p = kernelProbe({ auditFailure: true }); await assert.rejects(withTransaction(p.pool, c => confirmOrderPayment(c, p.source(p.input), p.distribution)));
  assert.deepEqual(p.state(), { declaration: undefined, confirmation: undefined }); assert.equal(p.seen.at(-1), 'ROLLBACK'); assert(!p.seen.includes('COMMIT'));
});

test('actual ISSUE/COMPLETE service freezes one ticket, creates admission under the ISSUE order lock and recovers the same key after COMMIT ACK loss',async()=>{
 const p=kernelProbe(),who={...actor,requestId:'request_fixture'};p.clearAdmission();
 const issued=await issueLocalSandboxCheckout(p.pool,who,'order','issue-fixture-key',p.checkout),body=issued.body as any;
 const admission=p.seen.findIndex(sql=>sql.startsWith('INSERT INTO zzsh_order.distribution_order_admission'));
 assert(admission>p.seen.findIndex(sql=>sql.startsWith('SELECT id,display_no,status,currency')&&sql.endsWith('FOR UPDATE')));
 assert(!p.seen.includes('GRAPH_LOCK'));assert(!p.seen.some(sql=>sql.startsWith('INSERT INTO zzsh_order.controlled_payment_declaration')));
 p.controls.clock='2026-11-02T10:02:10.000Z';const replay=await issueLocalSandboxCheckout(p.pool,who,'order','issue-fixture-key',p.checkout);
 assert.equal(replay.replayed,true);assert.deepEqual(replay.body,issued.body);
 p.controls.commitUnknownAt=3;
 await assert.rejects(completeLocalSandboxCheckout(p.pool,who,'order',body.checkout.ticket,body.checkout.completeKey,p.checkout),e=>e instanceof LocalSandboxCheckoutCommitUnknown&&e.originalKey===body.checkout.completeKey);
 const found=await readLocalSandboxCheckoutReceipt(p.pool,who,'order','COMPLETE',body.checkout.completeKey,p.checkout);
 assert.equal(found.knowledge,'KNOWN');assert.equal((found.receipt as any).payment.disposition,'APPLIED');
 assert.equal(p.seen.filter(sql=>sql.startsWith('INSERT INTO zzsh_order.payment_confirmation')).length,1);
});

test('actual completion refuses cross-session or expired ticket before declaration; missing original receipt remains UNKNOWN and GET never retries',async()=>{
 for(const change of ['SESSION','EXPIRED']){
  const p=kernelProbe(),who={...actor,requestId:'request_fixture'},issued=await issueLocalSandboxCheckout(p.pool,who,'order','issue-fixture-key',p.checkout),body=issued.body as any;
  if(change==='EXPIRED')p.controls.clock=body.checkout.expiresAt;
  await assert.rejects(completeLocalSandboxCheckout(p.pool,change==='SESSION'?{...who,sessionId:'another_session'}:who,'order',body.checkout.ticket,body.checkout.completeKey,p.checkout));
  assert(!p.seen.some(sql=>sql.startsWith('INSERT INTO zzsh_order.controlled_payment_declaration')||sql.startsWith('INSERT INTO zzsh_order.payment_confirmation')));
  const start=p.seen.length,unknown=await readLocalSandboxCheckoutReceipt(p.pool,who,'order','COMPLETE',body.checkout.completeKey,p.checkout);
  assert.equal(unknown.knowledge,'UNKNOWN');assert.equal(unknown.mayReapply,false);assert(!p.seen.slice(start).some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)));
 }
});

test('checkout discovery is pure read and cannot enable expired, unproved or another tenant order',async()=>{
 const p=kernelProbe(),who={...actor,requestId:'request_fixture'};
 assert.equal((await readLocalSandboxCheckoutAvailability(p.pool,who,'order',p.checkout)).checkoutEnabled,true);
 p.controls.eligible=false;assert.equal((await readLocalSandboxCheckoutAvailability(p.pool,who,'order',p.checkout)).checkoutEnabled,false);
 p.controls.eligible=true;p.controls.clock='2026-11-02T10:10:00.000Z';assert.equal((await readLocalSandboxCheckoutAvailability(p.pool,who,'order',p.checkout)).checkoutEnabled,false);
 await assert.rejects(readLocalSandboxCheckoutAvailability(p.pool,{...who,userId:'other'},'order',p.checkout));
 assert(!p.seen.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)||sql.includes('FOR UPDATE')));
});
