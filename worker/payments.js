import catalogue from './catalogue-seed.json' with { type: 'json' };

// br_orders and br_payment_requests are isolated from the old site's orders.
// Credentials and request tokens are never written to the public asset bundle.
const enc = new TextEncoder();
const productNames = new Map((catalogue.products || []).map(p => [String(p.id), p.name]));
const stages = ['New', 'Accepted', 'Preparing', 'Ready', 'Completed', 'Cancelled'];
const keyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const orderPattern = /^order_[A-Za-z0-9]+$/;
const paymentPattern = /^pay_[A-Za-z0-9]+$/;

export class PaymentError extends Error {
  constructor(message, code = 'INVALID_CHECKOUT', status = 400) {
    super(message); this.name = 'PaymentError'; this.code = code; this.status = status;
  }
}

export function configured(env) {
  return /^rzp_(test|live)_/.test(env.RAZORPAY_KEY_ID || '') && Boolean(env.RAZORPAY_KEY_SECRET);
}

function requireConfigured(env) {
  if (!configured(env)) throw new PaymentError('Payments are not connected yet. No payment has been taken.', 'PAYMENTS_NOT_CONFIGURED', 503);
}

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function hash(value) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
async function sign(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, typeof value === 'string' ? enc.encode(value) : value));
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function now() { return Math.floor(Date.now() / 1000); }
function randomId() { return 'BR-' + hex(crypto.getRandomValues(new Uint8Array(12))); }

async function gateway(env, path, body) {
  requireConfigured(env);
  try {
    const response = await fetch('https://api.razorpay.com/v1/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Basic ' + btoa(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Provider response failed');
    const value = await response.json();
    if (!plain(value)) throw new Error('Invalid provider response');
    return value;
  } catch {
    throw new PaymentError('Payment provider unavailable. Check this order before retrying; no second order will be created automatically.', 'PAYMENT_PROVIDER_UNAVAILABLE', 503);
  }
}

function paise(value) {
  const text = String(value ?? '');
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new PaymentError('A product has an invalid selling price.');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentError('A product has an invalid selling price.');
  return amount;
}

function customerFields(customer, channel) {
  if (!plain(customer) || customer.country !== 'IN' || typeof customer.name !== 'string' || !customer.name.trim() || customer.name.trim().length > 100 || typeof customer.phone !== 'string' || !/^[6-9][0-9]{9}$/.test(customer.phone)) {
    throw new PaymentError('Enter your name and a valid Indian mobile number.');
  }
  const result = { name: customer.name.trim(), phone: customer.phone, country: 'IN' };
  if (channel === 'delivery') {
    if (customer.state !== 'Rajasthan' || typeof customer.city !== 'string' || customer.city.trim().length < 2 || customer.city.trim().length > 100 || typeof customer.pincode !== 'string' || !/^[1-9][0-9]{5}$/.test(customer.pincode) || typeof customer.address !== 'string' || customer.address.trim().length < 10 || customer.address.trim().length > 500) {
      throw new PaymentError('Enter your complete delivery address, city and pincode in Rajasthan.');
    }
    Object.assign(result, { state: 'Rajasthan', city: customer.city.trim(), pincode: customer.pincode, address: customer.address.trim() });
  }
  return result;
}

async function deliveryAllowed(config, pincode) {
  // The official Rajasthan checker is required; a broad 30xxxx/34xxxx test is unsafe.
  const official = typeof config.isRajasthanPincode === 'function'
    ? await config.isRajasthanPincode(pincode)
    : Array.isArray(config.rajasthanPincodes) && config.rajasthanPincodes.includes(pincode);
  if (!official) throw new PaymentError('Delivery is available only to verified pincodes in Rajasthan.', 'OUTSIDE_DELIVERY_AREA');
  if (Array.isArray(config.deliveryPincodes) && config.deliveryPincodes.length && !config.deliveryPincodes.includes(pincode)) {
    throw new PaymentError('Delivery is not available for this pincode.', 'OUTSIDE_DELIVERY_AREA');
  }
}

function identity(body, customer) {
  // Ignore all client prices and labels. The same key cannot buy a changed cart.
  return JSON.stringify({ channel: body.channel, method: body.method, ageConfirmed: body.ageConfirmed === true, customer, items: body.items.map(p => ({ id: p.id, qty: p.qty })).sort((a, b) => a.id.localeCompare(b.id)) });
}

function trustedOrder(body, site, config, customer) {
  const menu = new Map((site.menu || []).map(p => [String(p.id), p]));
  const overrides = site.catalogueOverrides || {};
  const seen = new Set(); const lines = []; let subtotal = 0;
  for (const item of body.items) {
    if (!plain(item) || typeof item.id !== 'string' || seen.has(item.id) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20) throw new PaymentError('Invalid quantity or duplicate product.');
    seen.add(item.id);
    const bottle = item.id.startsWith('bottle-');
    if (bottle && body.ageConfirmed !== true) throw new PaymentError('Confirm legal age before ordering alcohol.', 'AGE_CONFIRMATION_REQUIRED');
    if (bottle && body.channel === 'delivery' && config.liquorDeliveryEnabled !== true) throw new PaymentError('Liquor delivery is not enabled.', 'LIQUOR_DELIVERY_DISABLED');
    const id = bottle ? item.id.slice(7) : item.id;
    const product = bottle ? overrides[id] : menu.get(id);
    if (!plain(product) || product.available !== true) throw new PaymentError('Product is unavailable. Demo items cannot be purchased.');
    const unit = paise(bottle ? product.servingPrice : product.price);
    const amount = unit * item.qty;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(subtotal + amount)) throw new PaymentError('Order amount is too large.');
    subtotal += amount;
    lines.push({ id: item.id, name: product.name || (bottle && productNames.get(id)) || item.id, qty: item.qty, unit });
  }
  const percent = body.channel === 'dine-in' ? config.dineInDiscount : config.deliveryDiscount;
  if (!Number.isInteger(percent) || percent < 0 || percent > 30) throw new PaymentError('Checkout discount is not configured correctly.', 'INVALID_CONFIGURATION', 503);
  const discount = Number((BigInt(subtotal) * BigInt(percent) + 50n) / 100n);
  const amount = subtotal - discount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentError('Invalid order amount.');
  return { id: randomId(), amount, currency: 'INR', items: lines, method: body.method, status: 'Starting payment', created: now(), subtotal, discount, discountPercent: percent, channel: body.channel, customer, ageConfirmed: body.ageConfirmed === true };
}

async function orderRow(env, id) {
  return env.DB.prepare('SELECT token, payload FROM br_orders WHERE id = ?').bind(id).first();
}

async function ensureOrder(env, state, owner) {
  await env.DB.prepare('INSERT INTO br_orders (id, token, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(state.order.id, owner, JSON.stringify(state.order)).run();
  const row = await orderRow(env, state.order.id);
  if (!row || !equal(row.token, owner)) throw new PaymentError('Order ownership could not be confirmed.', 'ORDER_NOT_FOUND', 404);
  return JSON.parse(row.payload);
}

function validProviderOrder(g, order) {
  return plain(g) && orderPattern.test(g.id || '') && g.amount === order.amount && g.currency === 'INR' && g.receipt === order.id;
}

async function saveProviderOrder(env, requestKey, state, gatewayOrder) {
  if (!validProviderOrder(gatewayOrder, state.order)) throw new PaymentError('Payment provider order does not match this checkout.', 'INVALID_PROVIDER_RESPONSE', 503);
  // Patch the live row rather than overwriting a stale copy changed by a webhook/admin.
  await env.DB.prepare("UPDATE br_orders SET payload = json_set(payload, '$.gateway_order_id', ?, '$.status', CASE WHEN json_extract(payload, '$.status') = 'Starting payment' THEN 'Awaiting payment' ELSE json_extract(payload, '$.status') END) WHERE id = ? AND (json_extract(payload, '$.gateway_order_id') IS NULL OR json_extract(payload, '$.gateway_order_id') = ?)").bind(gatewayOrder.id, state.order.id, gatewayOrder.id).run();
  const row = await orderRow(env, state.order.id);
  const order = row && JSON.parse(row.payload);
  if (!order || order.gateway_order_id !== gatewayOrder.id) throw new PaymentError('Checkout could not be reconciled. Contact support before retrying.', 'PAYMENT_CREATE_UNCERTAIN', 503);
  await env.DB.prepare("UPDATE br_payment_requests SET payload = json_set(payload, '$.state', 'Ready', '$.gateway_order_id', ?) WHERE request_key = ?").bind(gatewayOrder.id, requestKey).run();
  return order;
}

async function recoverProviderOrder(env, requestKey, state) {
  // A timeout may happen after Razorpay creates the order. Never repeat its POST.
  const found = await gateway(env, 'orders?receipt=' + encodeURIComponent(state.order.id) + '&count=100');
  const exact = (Array.isArray(found.items) ? found.items : []).filter(p => p.receipt === state.order.id);
  if (exact.length !== 1) throw new PaymentError('This checkout is still being reconciled. Retry the same checkout shortly or contact support; do not start a new payment.', 'PAYMENT_CREATE_UNCERTAIN', 503);
  return saveProviderOrder(env, requestKey, state, exact[0]);
}

function startResponse(env, order, token) {
  return { id: order.id, token, order_id: order.gateway_order_id, amount: order.amount, currency: 'INR', key: env.RAZORPAY_KEY_ID, status: order.status };
}

export async function start(env, body, site, config, request) {
  requireConfigured(env);
  if (config.orderingEnabled !== true) throw new PaymentError('Ordering is not enabled yet.', 'ORDERING_DISABLED', 503);
  if (config.policiesApproved !== true || typeof config.supportEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail) || !env.RAZORPAY_WEBHOOK_SECRET) throw new PaymentError('Order support, policies and payment verification must be configured before checkout.', 'LAUNCH_NOT_READY', 503);
  if (!plain(body) || !['dine-in', 'delivery'].includes(body.channel) || !['upi', 'card'].includes(body.method) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50 || !keyPattern.test(body.requestKey || '') || !tokenPattern.test(body.requestToken || '')) throw new PaymentError('Invalid checkout.');
  // Validate item structure before canonicalizing; malformed input must not escape as TypeError.
  if (body.items.some(p => !plain(p) || typeof p.id !== 'string' || !Number.isInteger(p.qty) || p.qty < 1 || p.qty > 20) || new Set(body.items.map(p => p.id)).size !== body.items.length) throw new PaymentError('Invalid product, quantity or duplicate product.');
  if (body.items.some(p => p.id.startsWith('bottle-'))) {
    if (body.ageConfirmed !== true) throw new PaymentError('Confirm legal age before ordering alcohol.', 'AGE_CONFIRMATION_REQUIRED');
    if (body.channel === 'delivery' && config.liquorDeliveryEnabled !== true) throw new PaymentError('Liquor delivery is not enabled.', 'LIQUOR_DELIVERY_DISABLED');
  }
  const customer = customerFields(body.customer, body.channel);
  if (body.channel === 'delivery') await deliveryAllowed(config, customer.pincode);
  const fingerprint = await hash(identity(body, customer));
  const owner = await hash(body.requestToken);
  let row = await env.DB.prepare('SELECT owner, payload FROM br_payment_requests WHERE request_key = ?').bind(body.requestKey).first();
  if (!row) {
    const order = trustedOrder(body, site, config, customer);
    const state = { state: 'Prepared', fingerprint, order };
    await env.DB.prepare('INSERT INTO br_payment_requests (request_key, owner, payload) VALUES (?, ?, ?) ON CONFLICT(request_key) DO NOTHING').bind(body.requestKey, owner, JSON.stringify(state)).run();
    row = await env.DB.prepare('SELECT owner, payload FROM br_payment_requests WHERE request_key = ?').bind(body.requestKey).first();
  }
  if (!row || !equal(row.owner, owner)) throw new PaymentError('Checkout not found.', 'CHECKOUT_NOT_FOUND', 404);
  const state = JSON.parse(row.payload);
  if (!equal(state.fingerprint, fingerprint)) throw new PaymentError('This checkout belongs to a different cart. Recover it before starting a new order.', 'CHECKOUT_CHANGED', 409);
  let order = await ensureOrder(env, state, owner);
  if (order.gateway_order_id) return startResponse(env, order, body.requestToken);
  const claimed = await env.DB.prepare("UPDATE br_payment_requests SET payload = json_set(payload, '$.state', 'Creating', '$.attemptedAt', ?) WHERE request_key = ? AND json_extract(payload, '$.state') = 'Prepared'").bind(now(), body.requestKey).run();
  if (claimed.meta?.changes === 1) {
    try {
      const g = await gateway(env, 'orders', { amount: order.amount, currency: 'INR', receipt: order.id, partial_payment: false, notes: { service: 'babas-bar-restro', local_order_id: order.id } });
      order = await saveProviderOrder(env, body.requestKey, state, g);
    } catch (error) {
      // Durable Creating state is intentionally retained on every ambiguous result.
      // A subsequent same-key request can recover by receipt without a second POST.
      throw error;
    }
  } else {
    order = await recoverProviderOrder(env, body.requestKey, state);
  }
  return startResponse(env, order, body.requestToken);
}

function matchesPayment(payment, order) {
  return plain(payment) && paymentPattern.test(payment.id || '') && payment.order_id === order.gateway_order_id && payment.amount === order.amount && payment.currency === 'INR' && payment.method === order.method;
}

async function markPaid(env, order, payment) {
  await env.DB.prepare("UPDATE br_orders SET payload = json_set(payload, '$.status', 'Paid', '$.payment_id', COALESCE(json_extract(payload, '$.payment_id'), ?), '$.fulfilment', COALESCE(json_extract(payload, '$.fulfilment'), 'New'), '$.paidAt', COALESCE(json_extract(payload, '$.paidAt'), ?)) WHERE id = ? AND json_extract(payload, '$.gateway_order_id') = ? AND json_extract(payload, '$.amount') = ?").bind(payment.id, now(), order.id, order.gateway_order_id, order.amount).run();
  const row = await orderRow(env, order.id);
  return JSON.parse(row.payload);
}

function publicOrder(order) {
  return { id: order.id, status: order.status, amount: order.amount, currency: order.currency, items: order.items, fulfilment: order.fulfilment || 'New', channel: order.channel, subtotal: order.subtotal, discount: order.discount || 0, discountPercent: order.discountPercent || 0, created: order.created };
}

export async function verify(env, body) {
  requireConfigured(env);
  if (!plain(body) || typeof body.id !== 'string' || !tokenPattern.test(body.token || '')) throw new PaymentError('Invalid order.');
  const row = await orderRow(env, body.id);
  if (!row || !equal(row.token, await hash(body.token))) throw new PaymentError('Order not found.', 'ORDER_NOT_FOUND', 404);
  let order = JSON.parse(row.payload);
  if (!orderPattern.test(order.gateway_order_id || '')) throw new PaymentError('Order is still being reconciled. Retry the same checkout.', 'PAYMENT_CREATE_UNCERTAIN', 503);
  if (order.status === 'Paid') return publicOrder(order);
  const pid = body.razorpay_payment_id;
  let payments;
  if (pid !== undefined) {
    if (!paymentPattern.test(pid || '') || typeof body.razorpay_signature !== 'string' || !/^[a-f0-9]{64}$/.test(body.razorpay_signature) || body.razorpay_order_id !== order.gateway_order_id) throw new PaymentError('Invalid payment verification.');
    if (!equal(body.razorpay_signature, await sign(env.RAZORPAY_KEY_SECRET, order.gateway_order_id + '|' + pid))) throw new PaymentError('Payment signature verification failed.', 'INVALID_PAYMENT_SIGNATURE');
    payments = [await gateway(env, 'payments/' + pid)];
  } else {
    const result = await gateway(env, 'orders/' + order.gateway_order_id + '/payments');
    if (!Array.isArray(result.items)) throw new PaymentError('Payment status could not be checked.', 'INVALID_PROVIDER_RESPONSE', 503);
    payments = result.items;
  }
  const match = payments.find(p => matchesPayment(p, order) && p.status === 'captured' && p.captured === true);
  if (match) order = await markPaid(env, order, match);
  else {
    // A concurrent captured webhook may have completed while the provider was read.
    const latest = await orderRow(env, order.id); order = JSON.parse(latest.payload);
  }
  return publicOrder(order);
}

export async function webhook(env, raw, signature) {
  if (!env.RAZORPAY_WEBHOOK_SECRET || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || !equal(signature, await sign(env.RAZORPAY_WEBHOOK_SECRET, typeof raw === 'string' ? raw : new Uint8Array(raw)))) throw new PaymentError('Invalid webhook signature.', 'INVALID_WEBHOOK_SIGNATURE', 401);
  let event; try { event = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { throw new PaymentError('Invalid webhook.'); }
  if (!plain(event) || !['payment.captured', 'payment.failed'].includes(event.event)) return { received: true };
  const payment = event.payload?.payment?.entity;
  if (!plain(payment) || !orderPattern.test(payment.order_id || '')) throw new PaymentError('Invalid webhook payment.');
  let row = await env.DB.prepare("SELECT id, payload FROM br_orders WHERE json_extract(payload, '$.gateway_order_id') = ?").bind(payment.order_id).first();
  if (!row) {
    // Handles a crash after provider creation but before its id was persisted.
    const providerOrder = await gateway(env, 'orders/' + payment.order_id);
    if (!/^BR-[a-f0-9]{24}$/.test(providerOrder.receipt || '')) return { received: true };
    const pending = await orderRow(env, providerOrder.receipt);
    if (!pending) return { received: true };
    const order = JSON.parse(pending.payload);
    if (!validProviderOrder(providerOrder, order)) throw new PaymentError('Webhook order does not match checkout.');
    await env.DB.prepare("UPDATE br_orders SET payload = json_set(payload, '$.gateway_order_id', ?) WHERE id = ? AND (json_extract(payload, '$.gateway_order_id') IS NULL OR json_extract(payload, '$.gateway_order_id') = ?)").bind(payment.order_id, order.id, payment.order_id).run();
    row = { id: order.id, payload: JSON.stringify({ ...order, gateway_order_id: payment.order_id }) };
  }
  const order = JSON.parse(row.payload);
  if (!matchesPayment(payment, order)) throw new PaymentError('Webhook payment does not match order.');
  if (event.event === 'payment.captured') {
    if (payment.status !== 'captured' || payment.captured !== true) throw new PaymentError('Captured webhook lacks a captured payment.');
    await markPaid(env, order, payment);
  } else {
    if (payment.status !== 'failed' || payment.captured === true) throw new PaymentError('Invalid failed payment webhook.');
    await env.DB.prepare("UPDATE br_orders SET payload = json_set(payload, '$.status', 'Payment failed') WHERE id = ? AND json_extract(payload, '$.status') != 'Paid'").bind(order.id).run();
  }
  return { received: true };
}

export async function listOrders(env) {
  const result = await env.DB.prepare("SELECT payload FROM br_orders ORDER BY json_extract(payload, '$.created') DESC LIMIT 250").all();
  return (result.results || []).map(row => JSON.parse(row.payload));
}

export async function setFulfilment(env, body) {
  if (!plain(body) || typeof body.id !== 'string' || !stages.includes(body.fulfilment)) throw new PaymentError('Invalid order update.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await orderRow(env, body.id);
    if (!row) throw new PaymentError('Order not found.', 'ORDER_NOT_FOUND', 404);
    const order = JSON.parse(row.payload); const old = order.fulfilment || 'New';
    if (order.status !== 'Paid') throw new PaymentError('Only verified paid orders can be processed.');
    if (['Completed', 'Cancelled'].includes(old) && old !== body.fulfilment) throw new PaymentError('Final order status cannot be changed.', 'FINAL_ORDER_STATUS', 409);
    if (body.fulfilment !== 'Cancelled' && stages.indexOf(body.fulfilment) < stages.indexOf(old)) throw new PaymentError('Order status cannot move backwards.', 'ORDER_STATUS_BACKWARDS', 409);
    const result = await env.DB.prepare("UPDATE br_orders SET payload = json_set(payload, '$.fulfilment', ?, '$.updated', ?) WHERE id = ? AND json_extract(payload, '$.status') = 'Paid' AND COALESCE(json_extract(payload, '$.fulfilment'), 'New') = ?").bind(body.fulfilment, now(), body.id, old).run();
    if (result.meta?.changes === 1) return { id: body.id, fulfilment: body.fulfilment };
  }
  throw new PaymentError('Order changed while updating. Refresh and retry.', 'ORDER_UPDATE_CONFLICT', 409);
}
