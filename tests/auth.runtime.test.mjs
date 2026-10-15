import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

test('actual Workerd + D1 runs local admin hash, durable sessions and atomic OTP counters', async () => {
  const salt = 'd63e8200397fa71b5a9236b00c1ef725';
  const password = 'runtime test admin password';
  const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310000, 32, 'sha256').toString('hex');
  const bundle = await build({ bundle: true, write: false, format: 'esm', platform: 'browser',
    stdin: { resolveDir: fileURLToPath(new URL('../worker', import.meta.url)), contents: `
      import { adminLogin,authenticate,sendOtp } from './auth.js';
      export default {async fetch(request,env){try{
        const path=new URL(request.url).pathname;
        if(path==='/login'){const result=await adminLogin(request,env,await request.json());return Response.json(result.payload,{headers:{'Set-Cookie':result.cookie}})}
        if(path==='/session'){const result=await authenticate(request,env,'admin');return Response.json({authenticated:!!result,subject:result?.subject})}
        if(path==='/send'){const result=await sendOtp(request,env,await request.json());return Response.json(result)}
        return new Response('Not found',{status:404});
      }catch(error){return Response.json({error:error.message},{status:error.status||500})}}};`
    } });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-06',
    d1Databases: { DB: 'auth-runtime-test' }, bindings: { BR_ADMIN_USERNAME: 'runtime-admin', BR_ADMIN_SALT: salt, BR_ADMIN_HASH: hash,
      BABA_SMS_WEBHOOK: 'https://sms.example/private', BABA_SMS_TOKEN: 'runtime-private-relay-token' },
    outboundService: () => new Response('', { status: 202 }) });
  try {
    const db = await mf.getD1Database('DB');
    await db.batch([
      'CREATE TABLE br_sessions(token_hash TEXT PRIMARY KEY,kind TEXT,subject TEXT,csrf TEXT,expires INTEGER)',
      'CREATE TABLE br_challenges(id TEXT PRIMARY KEY,phone TEXT,hash TEXT,expires INTEGER,attempts INTEGER)',
      'CREATE TABLE br_customers(phone TEXT PRIMARY KEY,name TEXT,email TEXT)',
      'CREATE TABLE br_rate(key TEXT,created INTEGER)',
      'CREATE TABLE br_credentials(id INTEGER PRIMARY KEY,username TEXT,salt TEXT,hash TEXT)'
    ].map(sql => db.prepare(sql)));
    const headers = { Origin: 'https://babas.test', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.55' };
    const login = await mf.dispatchFetch('https://babas.test/login', { method: 'POST', headers, body: JSON.stringify({ username: 'runtime-admin', password }) });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const session = await mf.dispatchFetch('https://babas.test/session', { headers: { Cookie: cookie } });
    assert.deepEqual(await session.json(), { authenticated: true, subject: 'runtime-admin' });
    const phone = '9876543210';
    const started = await mf.dispatchFetch('https://babas.test/send', { method: 'POST', headers, body: JSON.stringify({ phone }) });
    assert.equal(started.status, 200, await started.clone().text());
    const limits = await db.prepare('SELECT COUNT(*) AS count FROM br_rate').first();
    assert.equal(limits.count, 2);
    const sends = await Promise.all(Array.from({ length: 3 }, () => mf.dispatchFetch('https://babas.test/send', { method: 'POST', headers, body: JSON.stringify({ phone }) })));
    assert.ok(sends.every(response => response.status === 429));
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM br_rate').first()).count, 2);
  } finally { await mf.dispose(); }
});
