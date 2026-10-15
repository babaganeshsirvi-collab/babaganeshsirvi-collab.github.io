import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import * as payments from '../worker/payments.js';

// Execute real SQLite JSON/CAS statements through the same D1-shaped surface.
// This catches concurrency and JSON patch errors that SQL-string mocks miss.
class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('CREATE TABLE br_orders(id TEXT PRIMARY KEY, token TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE br_payment_requests(request_key TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL)');
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql); let values = [];
    const result = {
      bind: (...v) => { values = v; return result; },
      first: async () => stmt.get(...values) || null,
      all: async () => ({ results: stmt.all(...values) }),
      run: async () => ({ meta: { changes: stmt.run(...values).changes } }),
    };
    return result;
  }
}

const settings = { orderingEnabled: true, policiesApproved: true, supportEmail: 'support@example.test', dineInDiscount: 8, deliveryDiscount: 5, liquorDeliveryEnabled: false, deliveryPincodes: [], isRajasthanPincode: pin => pin === '302001' };
const site = { menu: [{ id: 'food1', name: 'Butter Chicken', price: '349', available: true }, { id: 'small', name: 'Small', price: '1.01', available: true }, { id: 'hidden', price: '100', available: false }], catalogueOverrides: { '168': { servingPrice: '9800', available: true } } };
const base = { requestKey: 'request_key_0000000000000001', requestToken: 'request_token_0000000000000000000000001', channel: 'dine-in', customer: { name: 'Guest', phone: '9876543210', country: 'IN' }, method: 'upi', items: [{ id: 'food1', qty: 2, price: 1 }] };
function env() { return { DB: new D1(), RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'test-secret', RAZORPAY_WEBHOOK_SECRET: 'webhook-secret' }; }
function cloned(value) { return JSON.parse(JSON.stringify(value)); }
function gatewayResponse(value) { return Response.json(value); }
function sign(secret, raw) { return createHmac('sha256', secret).update(raw).digest('hex'); }
async function withGateway(fn, work) {
  const original = globalThis.fetch; globalThis.fetch = fn;
  try { return await work(); } finally { globalThis.fetch = original; }
}
async function create(e = env(), body = base, config = settings) {
  let created;
  const result = await withGateway(async (url, init) => {
    assert.equal(url, 'https://api.razorpay.com/v1/orders');
    const requested = JSON.parse(init.body);
    created = { ...requested, id: 'order_test', status: 'created' };
    return gatewayResponse(created);
  }, () => payments.start(e, cloned(body), site, config));
  return { e, result, created };
}
function captured(order, extra = {}) { return { id: 'pay_test', order_id: order.order_id, amount: order.amount, currency: 'INR', method: 'upi', status: 'captured', captured: true, ...extra }; }
async function hook(e, entity, event = 'payment.captured') {
  const raw = JSON.stringify({ event, payload: { payment: { entity } } });
  return payments.webhook(e, raw, sign('webhook-secret', raw));
}

test('server prices, integer paise, dine-in and delivery discounts', async () => {
  const { result, created } = await create();
  assert.equal(result.amount, 64216); // 69800 - 8%.
  assert.equal(created.amount, 64216);
  assert.equal(created.partial_payment, false);
  assert.equal(created.currency, 'INR');
  assert.equal(created.notes.service, 'babas-bar-restro');
  assert.equal(result.token, base.requestToken);
  const delivery = { ...base, channel: 'delivery', customer: { ...base.customer, state: 'Rajasthan', city: 'Jaipur', pincode: '302001', address: 'House 12, Example Street' } };
  const d = await create(env(), delivery);
  assert.equal(d.result.amount, 66310);
  const fractional = await create(env(), { ...base, items: [{ id: 'small', qty: 1 }] });
  assert.equal(fractional.result.amount, 93); // Half-up discount, no floating drift.
});

test('ordering, country, official pincode, alcohol age and delivery gates', async () => {
  const rejects = [
    [{ ...base }, { ...settings, orderingEnabled: false }, /not enabled/],
    [{ ...base, customer: { ...base.customer, country: 'US' } }, settings, /Indian/],
    [{ ...base, channel: 'delivery', customer: { ...base.customer, state: 'Gujarat', city: 'Jaipur', pincode: '302001', address: 'House 12, Example Street' } }, settings, /Rajasthan/],
    [{ ...base, channel: 'delivery', customer: { ...base.customer, state: 'Rajasthan', city: 'Jaipur', pincode: '303999', address: 'House 12, Example Street' } }, settings, /verified pincodes/],
    [{ ...base, channel: 'delivery', customer: { ...base.customer, state: 'Rajasthan', city: 'Jaipur', pincode: '302001', address: 'House 12, Example Street' } }, { ...settings, isRajasthanPincode: undefined, deliveryPincodes: [] }, /verified pincodes/],
    [{ ...base, items: [{ id: 'bottle-168', qty: 1 }] }, settings, /legal age/],
    [{ ...base, ageConfirmed: true, channel: 'delivery', items: [{ id: 'bottle-168', qty: 1 }], customer: { ...base.customer, state: 'Rajasthan', city: 'Jaipur', pincode: '302001', address: 'House 12, Example Street' } }, settings, /Liquor delivery/],
    [{ ...base, items: [{ id: 'demo-butter', qty: 1 }] }, settings, /unavailable/],
    [{ ...base, items: [{ id: 'hidden', qty: 1 }] }, settings, /unavailable/],
    [{ ...base, items: [{ id: 'food1', qty: 21 }] }, settings, /quantity/],
    [{ ...base, items: [{ id: 'food1', qty: 1 }, { id: 'food1', qty: 2 }] }, settings, /duplicate/],
    [{ ...base, items: [null] }, settings, /product/],
    [{ ...base, requestToken: 'short' }, settings, /checkout/],
    [{ ...base, method: 'cash' }, settings, /checkout/],
  ];
  await withGateway(() => { throw new Error('must not contact gateway'); }, async () => {
    for (const [body, config, message] of rejects) await assert.rejects(payments.start(env(), cloned(body), site, config), message);
    await assert.rejects(payments.start({ DB: new D1() }, cloned(base), site, settings), /not connected/);
  });
  const bottle = await create(env(), { ...base, ageConfirmed: true, items: [{ id: 'bottle-168', qty: 1 }] });
  const saved = (await payments.listOrders(bottle.e))[0];
  assert.notEqual(saved.items[0].name, 'bottle-168');
  assert.equal(saved.items[0].unit, 980000);
});

test('same-key retry reuses order, tokens hashed, changed cart and wrong owner rejected', async () => {
  const { e, result } = await create();
  await withGateway(() => { throw new Error('must not create twice'); }, async () => {
    const again = await payments.start(e, cloned(base), site, settings);
    assert.equal(again.order_id, result.order_id);
    assert.equal(again.id, result.id);
    await assert.rejects(payments.start(e, { ...base, requestToken: 'other_secret_0000000000000000000000001' }, site, settings), /not found/);
    await assert.rejects(payments.start(e, { ...base, items: [{ id: 'food1', qty: 1 }] }, site, settings), /different cart/);
  });
  const all = e.DB.db.prepare('SELECT token, payload FROM br_orders').all();
  assert.equal(all[0].token.length, 64);
  assert.equal(JSON.stringify(all).includes(base.requestToken), false);
  const requests = e.DB.db.prepare('SELECT owner, payload FROM br_payment_requests').all();
  assert.equal(JSON.stringify(requests).includes(base.requestToken), false);
});

test('uncertain provider create recovers by unique receipt without repeating POST', async () => {
  const e = env(); let providerOrder; let creates = 0;
  await withGateway(async (url, init) => {
    if (init.method === 'POST') {
      creates++; providerOrder = { ...JSON.parse(init.body), id: 'order_recovered' };
      throw new Error('Network timeout after provider create');
    }
    assert.equal(new URL(url).searchParams.get('receipt'), providerOrder.receipt);
    return gatewayResponse({ items: [providerOrder] });
  }, async () => {
    await assert.rejects(payments.start(e, cloned(base), site, settings), /before retrying/);
    const recovered = await payments.start(e, cloned(base), site, settings);
    assert.equal(recovered.order_id, 'order_recovered');
    assert.equal(creates, 1);
  });
});

test('concurrent starts never POST twice, absent recovery stays uncertain', async () => {
  const e = env(); let unblock; let posting; let creates = 0;
  const started = new Promise(resolve => { posting = resolve; });
  const held = new Promise(resolve => { unblock = resolve; });
  await withGateway(async (url, init) => {
    if (init.method === 'POST') { creates++; posting(); await held; return gatewayResponse({ ...JSON.parse(init.body), id: 'order_concurrent' }); }
    return gatewayResponse({ items: [] });
  }, async () => {
    const first = payments.start(e, cloned(base), site, settings);
    await started;
    await assert.rejects(payments.start(e, cloned(base), site, settings), /still being reconciled/);
    unblock(); const result = await first;
    const repeat = await payments.start(e, cloned(base), site, settings);
    assert.equal(repeat.order_id, result.order_id);
    assert.equal(creates, 1);
  });
});

test('verification rejects wrong owner/signature; trusts captured amount, currency and method only', async () => {
  const { e, result } = await create();
  const verifiedBody = { id: result.id, token: result.token, razorpay_payment_id: 'pay_test', razorpay_order_id: result.order_id, razorpay_signature: sign('test-secret', result.order_id + '|pay_test') };
  await withGateway(() => { throw new Error('must not query before signatures'); }, async () => {
    await assert.rejects(payments.verify(e, { ...verifiedBody, token: 'other_secret_0000000000000000000000001' }), /not found/);
    await assert.rejects(payments.verify(e, { ...verifiedBody, razorpay_signature: '0'.repeat(64) }), /signature/);
  });
  for (const extra of [{ status: 'authorized', captured: false }, { amount: 1 }, { currency: 'USD' }, { method: 'wallet' }]) {
    await withGateway(() => gatewayResponse(captured(result, extra)), async () => {
      assert.equal((await payments.verify(e, verifiedBody)).status, 'Awaiting payment');
    });
  }
  await withGateway(() => gatewayResponse(captured(result)), async () => {
    assert.equal((await payments.verify(e, verifiedBody)).status, 'Paid');
  });
  await withGateway(() => { throw new Error('already paid must not regress'); }, async () => {
    assert.equal((await payments.verify(e, { id: result.id, token: result.token })).status, 'Paid');
  });
});

test('signed captured webhook, no weak fallback, no failed regression, fulfillment preserved', async () => {
  const { e, result } = await create();
  await assert.rejects(payments.webhook(e, '{}', 'bad'), /signature/);
  await assert.rejects(hook(e, captured(result, { status: 'authorized', captured: false })), /lacks a captured/);
  assert.equal((await payments.listOrders(e))[0].status, 'Awaiting payment');
  await assert.rejects(payments.setFulfilment(e, { id: result.id, fulfilment: 'Accepted' }), /verified paid/);
  await hook(e, captured(result)); await hook(e, captured(result));
  await payments.setFulfilment(e, { id: result.id, fulfilment: 'Preparing' });
  await hook(e, captured(result, { status: 'failed', captured: false }), 'payment.failed');
  await hook(e, captured(result));
  const after = (await payments.listOrders(e))[0];
  assert.equal(after.status, 'Paid'); assert.equal(after.fulfilment, 'Preparing');
  await assert.rejects(payments.setFulfilment(e, { id: result.id, fulfilment: 'Accepted' }), /backwards/);
  await payments.setFulfilment(e, { id: result.id, fulfilment: 'Completed' });
  await assert.rejects(payments.setFulfilment(e, { id: result.id, fulfilment: 'Cancelled' }), /Final/);
});

test('pending-order webhook recovers provider order after persistence crash', async () => {
  const e = env(); let providerOrder;
  await withGateway(async (url, init) => {
    if (init.method === 'POST') { providerOrder = { ...JSON.parse(init.body), id: 'order_pending' }; throw new Error('crash'); }
    assert.equal(url, 'https://api.razorpay.com/v1/orders/order_pending');
    return gatewayResponse(providerOrder);
  }, async () => {
    await assert.rejects(payments.start(e, cloned(base), site, settings), /unavailable/);
    await hook(e, captured({ order_id: 'order_pending', amount: providerOrder.amount }));
  });
  assert.equal((await payments.listOrders(e))[0].status, 'Paid');
});
