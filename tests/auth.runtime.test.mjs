import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

const passwordDigest = (password, salt) => pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310000, 32, 'sha256').toString('hex');

test('actual Workerd SQLite Durable Object preserves 310k hashes through D1 login, logout, password rotation and OTP throttling', async () => {
  const salt = 'd63e8200397fa71b5a9236b00c1ef725';
  const password = 'runtime test admin password';
  const hash = passwordDigest(password, salt);
  const bundle = await build({
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
    stdin: {
      resolveDir: fileURLToPath(new URL('../worker', import.meta.url)),
      contents: `
        import { adminLogin,adminLogout,authenticate,changePassword,sendOtp } from './auth.js';
        export { AdminPasswordHasher } from './password-hasher.js';
        export default {async fetch(request,env){try{
          const path=new URL(request.url).pathname;
          if(path==='/login'){const result=await adminLogin(request,env,await request.json());return Response.json(result.payload,{headers:{'Set-Cookie':result.cookie}})}
          if(path==='/session'){const result=await authenticate(request,env,'admin');return Response.json({authenticated:!!result,subject:result?.subject})}
          if(path==='/logout'){const result=await adminLogout(request,env);return Response.json(result.payload,{headers:{'Set-Cookie':result.cookie}})}
          if(path==='/password'){const session=await authenticate(request,env,'admin');const result=await changePassword(request,env,session,await request.json());return Response.json(result.payload,{headers:{'Set-Cookie':result.cookie}})}
          if(path==='/send'){const result=await sendOtp(request,env,await request.json());return Response.json(result)}
          if(path==='/derive'){const body=await request.json();const stub=env.ADMIN_PASSWORD_HASHER.get(env.ADMIN_PASSWORD_HASHER.idFromName('admin-pbkdf2-v1'));return Response.json({hash:await stub.derive(body.password,body.salt)})}
          if(path==='/internal-fetch'){const stub=env.ADMIN_PASSWORD_HASHER.get(env.ADMIN_PASSWORD_HASHER.idFromName('admin-pbkdf2-v1'));return stub.fetch(request)}
          return new Response('Not found',{status:404});
        }catch(error){return Response.json({error:error.message},{status:error.status||500})}}};`
    }
  });
  const mf = new Miniflare({
    name: 'auth-runtime-worker', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-06', unsafeInspectDurableObjects: true,
    d1Databases: { DB: 'auth-runtime-test' },
    durableObjects: { ADMIN_PASSWORD_HASHER: { className: 'AdminPasswordHasher', useSQLite: true } },
    bindings: {
      BR_ADMIN_USERNAME: 'runtime-admin', BR_ADMIN_SALT: salt, BR_ADMIN_HASH: hash,
      BABA_SMS_WEBHOOK: 'https://sms.example/private', BABA_SMS_TOKEN: 'runtime-private-relay-token'
    },
    outboundService: () => new Response('', { status: 202 })
  });
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
    const post = (path, body = {}, extra = {}) => mf.dispatchFetch('https://babas.test' + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const session = async cookie => {
      const response = await mf.dispatchFetch('https://babas.test/session', { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return response.json();
    };
    const login = async value => {
      const response = await post('/login', { username: 'runtime-admin', password: value });
      assert.equal(response.status, 200, await response.clone().text());
      const cookie = response.headers.get('Set-Cookie');
      assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
      return { cookie: cookie.split(';')[0], ...(await response.json()) };
    };

    const derived = await post('/derive', { password, salt });
    assert.equal(derived.status, 200, await derived.clone().text());
    assert.equal((await derived.json()).hash, hash, 'real DO must preserve the exact existing 310,000 iteration hash');
    const unavailable = await post('/internal-fetch', { password, salt });
    assert.equal(unavailable.status, 404, 'the hashing object exposes no HTTP hashing API');
    const rejectedInput = await post('/derive', { password, salt: 'bad' });
    assert.equal(rejectedInput.status, 500);

    const first = await login(password);
    assert.deepEqual(await session(first.cookie), { authenticated: true, subject: 'runtime-admin' });
    assert.deepEqual(await db.prepare('SELECT username,salt,hash FROM br_credentials WHERE id=1').first(), { username: 'runtime-admin', salt, hash });
    const persisted = await db.prepare('SELECT token_hash FROM br_sessions').first();
    assert.match(persisted.token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(persisted.token_hash, first.cookie.split('=')[1]);
    let response = await post('/logout', {}, { Cookie: first.cookie });
    assert.equal(response.status, 403, 'logout requires the matching session CSRF token');
    response = await post('/logout', {}, { Cookie: first.cookie, 'X-CSRF-Token': first.csrf });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0$/);
    assert.deepEqual(await session(first.cookie), { authenticated: false });

    const second = await login(password), third = await login(password);
    await db.prepare('INSERT INTO br_sessions VALUES (?,?,?,?,?)').bind('c'.repeat(64), 'customer', '9876543210', 'customer-csrf', Math.floor(Date.now() / 1000) + 300).run();
    response = await post('/password', { current: 'wrong', password: 'replacement runtime password' }, { Cookie: second.cookie, 'X-CSRF-Token': second.csrf });
    assert.equal(response.status, 401);
    assert.equal((await db.prepare('SELECT hash FROM br_credentials WHERE id=1').first()).hash, hash);
    response = await post('/password', { current: password, password: 'replacement runtime password' }, { Cookie: second.cookie, 'X-CSRF-Token': second.csrf });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { changed: true });
    const rotated = await db.prepare('SELECT salt,hash FROM br_credentials WHERE id=1').first();
    assert.notEqual(rotated.salt, salt);
    assert.equal(rotated.hash, passwordDigest('replacement runtime password', rotated.salt));
    assert.deepEqual(await session(second.cookie), { authenticated: false });
    assert.deepEqual(await session(third.cookie), { authenticated: false });
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM br_sessions WHERE kind='customer'").first()).count, 1);
    response = await post('/login', { username: 'runtime-admin', password });
    assert.equal(response.status, 401);
    const fourth = await login('replacement runtime password');
    assert.equal((await session(fourth.cookie)).authenticated, true);

    const phone = '9876543210';
    response = await post('/send', { phone });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM br_rate').first()).count, 2);
    const sends = await Promise.all(Array.from({ length: 3 }, () => post('/send', { phone })));
    assert.ok(sends.every(result => result.status === 429));
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM br_rate').first()).count, 2);
    const storage = await mf.unsafeGetDurableObjectStorage('auth-runtime-worker', 'AdminPasswordHasher', { name: 'admin-pbkdf2-v1' });
    const tables = await storage.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    // Miniflare itself records the named-object ID; it is not application data.
    for (const { name } of tables.filter(table => table.name !== '__miniflare_do_name')) {
      assert.match(name, /^[A-Za-z0-9_]+$/);
      const rows = await storage.exec(`SELECT COUNT(*) AS count FROM "${name}"`);
      assert.equal(rows[0].count, 0, `password hasher must not retain rows in ${name}`);
    }
  } finally { await mf.dispose(); }
});
