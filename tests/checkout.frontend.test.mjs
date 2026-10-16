import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../public/shop.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await turn(); }

function setup(orderReplies, verifyReplies = [], { configured = true } = {}) {
  const dom = new JSDOM('<!doctype html><header></header><section id="menu"></section>', { url: 'https://babas.test/', runScripts: 'outside-only' });
  const window = dom.window, requests = [], checkouts = [], fetches = [];
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let counter = 0;
  Object.defineProperty(window.crypto, 'randomUUID', { value: () => '12345678-1234-4321-8321-' + String(++counter).padStart(12, '0') });
  window.babasData = { menu: [], details: {} };
  window.localStorage.setItem('babas-cart', JSON.stringify([{ id: 'food-test', name: 'Test dish', price: 349, qty: 1, image: 'assets/bowl-v2.png' }]));
  window.Razorpay = function (options) { checkouts.push(options); this.open = () => {}; };
  window.fetch = async (url, options = {}) => {
    fetches.push(url);
    if (url === 'catalogue.json') return { ok: true, json: async () => ({ products: [] }) };
    if (url === '/api/store-config') return { ok: true, json: async () => ({ dineInDiscount: 8, deliveryDiscount: 5 }) };
    if (url === '/api/payment-config') return { ok: true, json: async () => ({ configured }) };
    if (url === '/api/payment-order') {
      requests.push(JSON.parse(options.body));
      const reply = orderReplies.shift();
      if (reply instanceof Error) throw reply;
      assert.ok(reply, 'Unexpected checkout request');
      return { ok: reply.ok !== false, json: async () => reply.body };
    }
    if (url === '/api/payment-verify') {
      const reply = verifyReplies.shift();
      assert.ok(reply, 'Unexpected payment verification request');
      return { ok: reply.ok !== false, json: async () => reply.body };
    }
    throw new Error('Unexpected URL: ' + url);
  };
  window.eval(source);
  const button = text => [...window.document.querySelectorAll('button')].find(item => item.textContent === text);
  const read = key => JSON.parse(window.localStorage.getItem(key));
  const startCheckout = async () => {
    window.document.querySelector('[title^="Cart ("]').click();
    button('Continue to checkout').click(); await settle();
  };
  const openCheckout = async () => {
    await startCheckout();
    const form = window.document.querySelector('dialog form');
    form.elements.namedItem('name').value = 'First guest';
    form.elements.namedItem('phone').value = '9876543210';
    return form;
  };
  const submit = async form => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); };
  return { dom, window, requests, checkouts, fetches, read, button, startCheckout, openCheckout, submit };
}

const acceptedOrder = { id: 'BR-test', token: 'saved-order-token', order_id: 'order_same123', amount: 32108, currency: 'INR', key: 'rzp_test_demo', status: 'Awaiting payment' };

test('unconfigured checkout shows ordering unavailable without collecting details or starting payment', async () => {
  const app = setup([], [], { configured: false });
  try {
    await app.startCheckout();
    const dialog = app.window.document.querySelector('dialog');
    assert.equal(dialog.open, true);
    assert.match(dialog.textContent, /Online ordering is currently unavailable\./);
    assert.equal(dialog.querySelector('form'), null);
    assert.equal(dialog.querySelector('input, select, textarea'), null);
    assert.doesNotMatch(dialog.textContent, /Demo checkout|gateway credentials|Preview payment|Payment preview/);
    assert.deepEqual(app.fetches.filter(url => url.startsWith('/api/')), ['/api/payment-config']);
    assert.equal(app.requests.length, 0);
    assert.equal(app.checkouts.length, 0);
    assert.equal(app.window.document.querySelector('script[src*="razorpay"]'), null);
    assert.equal(app.read('babas-checkout-attempt'), null);
    assert.equal(app.read('babas-pending-payment'), null);
    app.button('Back to cart').click();
    assert.equal(dialog.querySelector('h2').textContent, 'Your cart');
    assert.match(dialog.textContent, /Test dish/);
    assert.equal(app.read('babas-cart').length, 1);
  } finally { app.dom.window.close(); }
});

test('fresh pre-order rejections release stale cart/address payload so corrected checkout uses a new request', async () => {
  for (const code of ['INVALID_CHECKOUT', 'CHECKOUT_INVALID', 'OUTSIDE_DELIVERY_AREA', 'AGE_CONFIRMATION_REQUIRED', 'LIQUOR_DELIVERY_DISABLED', 'ORDERING_DISABLED', 'PAYMENTS_NOT_CONFIGURED', 'LAUNCH_NOT_READY', 'INVALID_CONFIGURATION']) {
    const app = setup([{ ok: false, body: { error: 'Checkout was rejected before order creation', code } }, { body: acceptedOrder }]);
    try {
      const form = await app.openCheckout(); await app.submit(form);
      assert.equal(app.read('babas-checkout-attempt'), null, code);
      assert.equal(app.read('babas-pending-payment'), null, code);
      assert.equal(app.read('babas-cart').length, 1, 'Rejected checkout should retain the cart');
      form.elements.namedItem('name').value = 'Corrected guest'; await app.submit(form);
      assert.notEqual(app.requests[0].requestKey, app.requests[1].requestKey, code);
      assert.notEqual(app.requests[0].requestToken, app.requests[1].requestToken, code);
      assert.equal(app.requests[1].customer.name, 'Corrected guest');
      assert.equal(app.checkouts.length, 1);
    } finally { app.dom.window.close(); }
  }
});

test('uncertain/resumed checkout preserves immutable request and same order through later rejection, dismissal and noncaptured payment', async () => {
  const app = setup([
    new TypeError('Network response lost'),
    { ok: false, body: { code: 'ORDERING_DISABLED', error: 'Ordering temporarily disabled' } },
    { body: acceptedOrder }
  ], [
    { body: { id: 'BR-test', status: 'Payment failed', amount: 32108, items: [] } },
    { body: { id: 'BR-test', status: 'Paid', amount: 32108, fulfilment: 'New', items: [] } }
  ]);
  try {
    const form = await app.openCheckout(); await app.submit(form);
    const attempt = app.read('babas-checkout-attempt');
    assert.ok(attempt);
    form.elements.namedItem('name').value = 'Later guest'; await app.submit(form);
    assert.deepEqual(app.read('babas-checkout-attempt'), attempt, 'Later validation rejection cannot erase an uncertain earlier request');
    await app.submit(form);
    assert.equal(app.requests.length, 3);
    for (const sent of app.requests) assert.deepEqual(sent, attempt.payload);
    assert.equal(app.checkouts[0].order_id, 'order_same123');
    app.checkouts[0].modal.ondismiss();
    assert.ok(app.read('babas-checkout-attempt')); assert.ok(app.read('babas-pending-payment'));
    await app.checkouts[0].handler({ razorpay_payment_id: 'pay_failed123' }); await settle();
    assert.ok(app.read('babas-checkout-attempt')); assert.ok(app.read('babas-pending-payment'));
    assert.equal(app.read('babas-cart').length, 1, 'A failed or uncaptured payment cannot empty the cart');
    await app.checkouts[0].handler({ razorpay_payment_id: 'pay_captured123' }); await settle();
    assert.equal(app.read('babas-checkout-attempt'), null); assert.equal(app.read('babas-pending-payment'), null);
    assert.equal(app.read('babas-cart').length, 0);
    assert.equal(app.read('babas-last-order').status, 'Paid');
  } finally { app.dom.window.close(); }
});

test('provider uncertainty, invalid provider response and unknown rejection retain fresh saved checkout', async () => {
  for (const reply of [
    new TypeError('Network timed out'),
    { ok: false, body: { code: 'PAYMENT_CREATE_UNCERTAIN', error: 'Creation is uncertain' } },
    { ok: false, body: { code: 'INVALID_PROVIDER_RESPONSE', error: 'Provider returned an invalid order' } },
    { ok: false, body: { code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Provider unavailable' } },
    { ok: false, body: { code: 'CHECKOUT_CHANGED', error: 'Different saved cart' } },
    { ok: false, body: { error: 'Unknown server error' } }
  ]) {
    const app = setup([reply]);
    try {
      const form = await app.openCheckout(); await app.submit(form);
      assert.ok(app.read('babas-checkout-attempt'));
      assert.equal(app.read('babas-pending-payment'), null);
      assert.equal(app.checkouts.length, 0);
    } finally { app.dom.window.close(); }
  }
});
