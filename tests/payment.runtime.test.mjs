import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

const body = { requestKey: 'runtime_request_key_0000000000001', requestToken: 'runtime_request_secret_0000000000000000001', channel: 'dine-in', customer: { name: 'Guest', phone: '9876543210', country: 'IN' }, method: 'upi', items: [{ id: 'food1', qty: 2, price: 1 }] };
const headers = { 'Content-Type': 'application/json' };
function signature(raw) { return createHmac('sha256', 'runtime-hook').update(raw).digest('hex'); }

test('actual Workerd and D1 use strict captured webhooks, atomic fulfillment and same-key reuse', async () => {
  const bundle = await build({ bundle: true, write: false, format: 'esm', platform: 'browser',
    stdin: { resolveDir: fileURLToPath(new URL('../worker', import.meta.url)), contents: `
      import * as p from './payments.js';
      const site={menu:[{id:'food1',name:'Butter Chicken',price:'349',available:true}],catalogueOverrides:{}};
      const config={orderingEnabled:true,policiesApproved:true,supportEmail:'support@example.test',dineInDiscount:8,deliveryDiscount:5,liquorDeliveryEnabled:false,deliveryPincodes:[],isRajasthanPincode:pin=>pin==='302001'};
      export default {async fetch(request,env){try{
        const path=new URL(request.url).pathname;
        if(path==='/start')return Response.json(await p.start(env,await request.json(),site,config,request));
        if(path==='/verify')return Response.json(await p.verify(env,await request.json()));
        if(path==='/hook')return Response.json(await p.webhook(env,await request.text(),request.headers.get('X-Razorpay-Signature')));
        if(path==='/status')return Response.json(await p.setFulfilment(env,await request.json()));
        if(path==='/orders')return Response.json(await p.listOrders(env));
        return new Response('Not found',{status:404});
      }catch(error){return Response.json({error:error.message,code:error.code},{status:error.status||500})}}};`
    } });
  const gateway = []; let createCount = 0;
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-01-01',
    d1Databases: { DB: 'payment-runtime-test' }, bindings: { RAZORPAY_KEY_ID: 'rzp_test_runtime', RAZORPAY_KEY_SECRET: 'runtime-secret', RAZORPAY_WEBHOOK_SECRET: 'runtime-hook' },
    outboundService: async request => {
      if (request.method === 'POST') {
        createCount++; const input = await request.json();
        const order = { ...input, id: 'order_runtime' }; gateway.push(order); return Response.json(order);
      }
      return Response.json({ items: gateway });
    } });
  try {
    const db = await mf.getD1Database('DB');
    await db.batch([
      'CREATE TABLE br_orders(id TEXT PRIMARY KEY,token TEXT NOT NULL,payload TEXT NOT NULL)',
      'CREATE TABLE br_payment_requests(request_key TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL)',
    ].map(sql => db.prepare(sql)));
    const first = await mf.dispatchFetch('https://babas.test/start', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(first.status, 200, await first.clone().text()); const order = await first.json();
    assert.equal(order.amount, 64216);
    const repeated = await mf.dispatchFetch('https://babas.test/start', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(repeated.status, 200, await repeated.clone().text()); assert.equal((await repeated.json()).order_id, order.order_id); assert.equal(createCount, 1);
    const entity = { id: 'pay_runtime', order_id: order.order_id, amount: order.amount, currency: 'INR', method: 'upi', status: 'captured', captured: true };
    const sendHook = async (payment, event = 'payment.captured') => {
      const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } });
      return mf.dispatchFetch('https://babas.test/hook', { method: 'POST', headers: { ...headers, 'X-Razorpay-Signature': signature(raw) }, body: raw });
    };
    const weak = await sendHook({ ...entity, captured: false }); assert.equal(weak.status, 400);
    const paid = await sendHook(entity); assert.equal(paid.status, 200, await paid.clone().text());
    const advance = await mf.dispatchFetch('https://babas.test/status', { method: 'POST', headers, body: JSON.stringify({ id: order.id, fulfilment: 'Preparing' }) });
    assert.equal(advance.status, 200, await advance.clone().text());
    const lateFailure = await sendHook({ ...entity, status: 'failed', captured: false }, 'payment.failed'); assert.equal(lateFailure.status, 200);
    const replay = await sendHook(entity); assert.equal(replay.status, 200);
    const verify = await mf.dispatchFetch('https://babas.test/verify', { method: 'POST', headers, body: JSON.stringify({ id: order.id, token: order.token }) });
    const receipt = await verify.json(); assert.equal(receipt.status, 'Paid'); assert.equal(receipt.fulfilment, 'Preparing');
    const backward = await mf.dispatchFetch('https://babas.test/status', { method: 'POST', headers, body: JSON.stringify({ id: order.id, fulfilment: 'Accepted' }) }); assert.equal(backward.status, 409);
    const saved = await db.prepare('SELECT token,payload FROM br_orders WHERE id=?').bind(order.id).first();
    assert.equal(saved.token.length, 64); assert.equal(saved.payload.includes(body.requestToken), false);
  } finally { await mf.dispose(); }
});
