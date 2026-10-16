import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, webcrypto } from 'node:crypto';
import { derivePasswordHash } from '../worker/password-kdf.js';
import { authenticate, adminLogin, adminLogout, adminPasswordIsDefault, changePassword, customerConfigured, sendOtp, verifyOtp, customerProfile, saveCustomer, customerLogout } from '../worker/auth.js';

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  async run() {
    const results = this.db.prepare(this.sql).all(...this.args);
    return { results, success: true, meta: { changes: this.db.prepare('SELECT changes() AS count').get().count } };
  }
}
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE br_sessions(token_hash TEXT PRIMARY KEY,kind TEXT,subject TEXT,csrf TEXT,expires INTEGER);
    CREATE TABLE br_challenges(id TEXT PRIMARY KEY,phone TEXT,hash TEXT,expires INTEGER,attempts INTEGER);
    CREATE TABLE br_customers(phone TEXT PRIMARY KEY,name TEXT,email TEXT);
    CREATE TABLE br_rate(key TEXT,created INTEGER);
    CREATE INDEX br_rate_key_created ON br_rate(key,created);
    CREATE TABLE br_credentials(id INTEGER PRIMARY KEY,username TEXT,salt TEXT,hash TEXT);`);
  const DB = {
    prepare: sql => new Statement(sqlite, sql),
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const values = []; for (const statement of statements) values.push(await statement.run()); sqlite.exec('COMMIT'); return values; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const salt = '00f17ce8526a93bdaf243256aec137d4';
  const password = 'a different test password';
  const rpc = [];
  const ADMIN_PASSWORD_HASHER = {
    idFromName(name) { assert.equal(name, 'admin-pbkdf2-v1'); return 'test-hasher-id'; },
    get(id) {
      assert.equal(id, 'test-hasher-id');
      return { async derive(value, saltHex) { rpc.push({ password: value, salt: saltHex }); return derivePasswordHash(value, saltHex); } };
    }
  };
  const env = { DB, ADMIN_PASSWORD_HASHER, BR_ADMIN_USERNAME: 'test-admin', BR_ADMIN_SALT: salt,
    BR_ADMIN_HASH: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310000, 32, 'sha256').toString('hex') };
  return { sqlite, env, password, rpc };
}
const request = (path, options = {}) => new Request('https://babas.test' + path, {
  method: options.method || 'POST', headers: { Origin: 'https://babas.test', 'CF-Connecting-IP': options.ip || '203.0.113.5',
    ...(options.cookie ? { Cookie: options.cookie.split(';')[0] } : {}), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}), ...options.headers }
});
const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);

test('admin credentials preserve 310k PBKDF2 through the internal hasher; hashed sessions and CSRF protect writes', async () => {
  const { sqlite, env, password } = setup();
  await rejects(adminLogin(request('/api/login'), env, { username: 'test-admin', password: 'wrong' }), 401);
  const signed = await adminLogin(request('/api/login'), env, { username: 'test-admin', password });
  assert.match(signed.cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(signed.cookie, /Max-Age=28800$/);
  const session = await authenticate(request('/api/session', { method: 'GET', cookie: signed.cookie }), { ...env }, 'admin');
  assert.equal(session.subject, 'test-admin');
  const stored = sqlite.prepare('SELECT * FROM br_sessions').get();
  assert.equal(stored.token_hash.length, 64);
  assert.notEqual(stored.token_hash, signed.cookie.split('=')[1].split(';')[0]);
  await rejects(authenticate(request('/api/save', { cookie: signed.cookie }), env, 'admin'), 403);
  await rejects(authenticate(request('/api/save', { cookie: signed.cookie, csrf: session.csrf, headers: { Origin: 'https://other.test' } }), env, 'admin'), 403);
  const writeSession = await authenticate(request('/api/save', { cookie: signed.cookie, csrf: session.csrf }), env, 'admin');
  assert.equal(writeSession.csrf, signed.payload.csrf);
  assert.equal(await adminPasswordIsDefault(env), false);
  env.BR_ADMIN_REQUIRE_PASSWORD_CHANGE = 'true';
  assert.equal(await adminPasswordIsDefault(env), true);
  await adminLogout(request('/api/logout', { cookie: signed.cookie, csrf: session.csrf }), env);
  assert.equal(await authenticate(request('/api/session', { method: 'GET', cookie: signed.cookie }), env, 'admin'), null);
  sqlite.close();
});

test('password helper preserves exact 310k vectors under native WebCrypto and the Workers iteration cap', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const vectors = [
    { password: 'runtime test admin password', salt: 'd63e8200397fa71b5a9236b00c1ef725' },
    { password: 'नमस्ते-🍊-a password', salt: '00F17CE8526A93BDAF243256AEC137D4' }
  ];
  let cappedCalls = 0;
  try {
    for (const vector of vectors) {
      const expected = pbkdf2Sync(vector.password, Buffer.from(vector.salt, 'hex'), 310000, 32, 'sha256').toString('hex');
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
      assert.equal(await derivePasswordHash(vector.password, vector.salt), expected);
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: {
        importKey: (...args) => webcrypto.subtle.importKey(...args),
        deriveBits(parameters) {
          cappedCalls++;
          assert.equal(parameters.iterations, 310000);
          throw new Error('PBKDF2 iteration counts above 100000 are not supported');
        }
      } } });
      assert.equal(await derivePasswordHash(vector.password, vector.salt), expected);
      assert.notEqual(expected, pbkdf2Sync(vector.password, Buffer.from(vector.salt, 'hex'), 100000, 32, 'sha256').toString('hex'));
    }
    assert.equal(cappedCalls, vectors.length);
  } finally { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); }
});

test('password helper rejects invalid input and propagates unrelated native crypto failure', async () => {
  for (const [password, salt] of [[null, 'ab'.repeat(16)], ['x'.repeat(257), 'ab'.repeat(16)], ['secret', 'ab'], ['secret', 'zz'.repeat(16)]]) {
    await assert.rejects(derivePasswordHash(password, salt), TypeError);
  }
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const failure = new Error('Key material is unavailable');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { importKey() { throw failure; } } } });
  try { await assert.rejects(derivePasswordHash('secret', 'ab'.repeat(16)), error => error === failure); }
  finally { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); }
});

test('missing or failing internal hashing and malformed RPC results fail closed without main Worker derivation', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let localDerivations = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: array => webcrypto.getRandomValues(array),
    subtle: {
      digest: (...args) => webcrypto.subtle.digest(...args),
      importKey() { localDerivations++; throw new Error('PBKDF2 iteration counts above 100000 are not supported'); },
      deriveBits() { localDerivations++; throw new Error('PBKDF2 iteration counts above 100000 are not supported'); }
    }
  } });
  const cases = [
    undefined,
    { idFromName() { throw new Error('namespace unavailable'); }, get() { throw new Error('must not get'); } },
    { idFromName: () => 'id', get() { throw new Error('object unavailable'); } },
    { idFromName: () => 'id', get: () => ({ derive() { throw new Error('internal RPC failed'); } }) },
    { idFromName: () => 'id', get: () => ({}) },
    ...[undefined, null, {}, 'a'.repeat(63), 'z'.repeat(64), 'A'.repeat(64)].map(value => ({ idFromName: () => 'id', get: () => ({ derive: async () => value }) }))
  ];
  try {
    for (const ADMIN_PASSWORD_HASHER of cases) {
      const { sqlite, env, password } = setup();
      try {
        await rejects(adminLogin(request('/api/login'), { ...env, ADMIN_PASSWORD_HASHER }, { username: 'test-admin', password }), 503);
        assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM br_sessions').get().count, 0);
      } finally { sqlite.close(); }
    }
    assert.equal(localDerivations, 0, 'authentication must never import or derive a local password key');
  } finally { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); }
});

test('failed admin attempts have a durable throttle and missing configuration fails closed', async () => {
  const { sqlite, env, rpc } = setup();
  for (let i = 0; i < 5; i++) await rejects(adminLogin(request('/api/login'), env, { username: 'test-admin', password: 'bad' }), 401);
  assert.equal(rpc.length, 5);
  await rejects(adminLogin(request('/api/login'), { ...env }, { username: 'test-admin', password: 'bad' }), 429);
  assert.equal(rpc.length, 5, 'durable rate gate must reject before calling the hasher');
  await rejects(adminLogin(request('/api/login', { ip: '203.0.113.6' }), { DB: env.DB, ADMIN_PASSWORD_HASHER: env.ADMIN_PASSWORD_HASHER }, {}), 401); // Persisted credentials survive secret removal.
  const missing = setup();
  await rejects(adminLogin(request('/api/login'), { DB: missing.env.DB }, {}), 503);
  sqlite.close(); missing.sqlite.close();
});

test('password change invalidates all admin sessions and keeps customer sessions', async () => {
  const { sqlite, env, password } = setup();
  const first = await adminLogin(request('/api/login'), env, { username: 'test-admin', password });
  const second = await adminLogin(request('/api/login'), env, { username: 'test-admin', password });
  sqlite.prepare('INSERT INTO br_sessions VALUES (?,?,?,?,?)').run('c'.repeat(64), 'customer', '9876543210', 'csrf', Math.floor(Date.now() / 1000) + 300);
  const session = await authenticate(request('/api/password', { cookie: first.cookie, csrf: first.payload.csrf }), env, 'admin');
  await rejects(changePassword(request('/api/password', { cookie: first.cookie, csrf: session.csrf }), env, session, { current: 'wrong', password: 'replacement test password' }), 401);
  const changed = await changePassword(request('/api/password', { cookie: first.cookie, csrf: session.csrf }), env, session, { current: password, password: 'replacement test password' });
  assert.equal(changed.payload.changed, true);
  const stored = sqlite.prepare('SELECT salt,hash FROM br_credentials WHERE id=1').get();
  assert.equal(stored.hash, pbkdf2Sync('replacement test password', Buffer.from(stored.salt, 'hex'), 310000, 32, 'sha256').toString('hex'));
  env.BR_ADMIN_REQUIRE_PASSWORD_CHANGE = 'true';
  assert.equal(await adminPasswordIsDefault(env), false);
  assert.equal(await authenticate(request('/api/session', { method: 'GET', cookie: second.cookie }), env, 'admin'), null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM br_sessions WHERE kind='customer'").get().count, 1);
  await rejects(adminLogin(request('/api/login'), env, { username: 'test-admin', password }), 401);
  assert.ok((await adminLogin(request('/api/login'), env, { username: 'test-admin', password: 'replacement test password' })).cookie);
  sqlite.close();
});

test('password change preserves credentials and sessions when either hashing RPC fails', async () => {
  for (const failingCall of [1, 2]) {
    const { sqlite, env, password } = setup();
    try {
      const signed = await adminLogin(request('/api/login'), env, { username: 'test-admin', password });
      const req = request('/api/password', { cookie: signed.cookie, csrf: signed.payload.csrf });
      const session = await authenticate(req, env, 'admin');
      const before = sqlite.prepare('SELECT username,salt,hash FROM br_credentials WHERE id=1').get();
      let calls = 0;
      const unavailable = { ...env, ADMIN_PASSWORD_HASHER: {
        idFromName: () => 'test-hasher-id',
        get: () => ({ async derive(value, salt) {
          if (++calls === failingCall) throw new Error('DO unavailable');
          return derivePasswordHash(value, salt);
        } })
      } };
      await rejects(changePassword(req, unavailable, session, { current: password, password: 'replacement test password' }), 503);
      assert.deepEqual(sqlite.prepare('SELECT username,salt,hash FROM br_credentials WHERE id=1').get(), before);
      assert.ok(await authenticate(request('/api/session', { method: 'GET', cookie: signed.cookie }), env, 'admin'));
      assert.equal(calls, failingCall);
    } finally { sqlite.close(); }
  }
});

test('OTP absent configuration and provider failure never return success', async () => {
  const { sqlite, env } = setup();
  assert.equal(customerConfigured(env), false);
  await rejects(sendOtp(request('/api/customer-send'), env, { phone: '9876543210' }), 503);
  env.BABA_SMS_WEBHOOK = 'https://sms.example/private'; env.BABA_SMS_TOKEN = 'test-private-relay-token';
  const previous = globalThis.fetch;
  let status = 503;
  globalThis.fetch = async () => new Response('', { status });
  try {
    await rejects(sendOtp(request('/api/customer-send'), env, { phone: '9876543210' }), 502);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM br_challenges').get().count, 0);
    status = 302;
    await rejects(sendOtp(request('/api/customer-send', { ip: '203.0.113.6' }), env, { phone: '9876543211' }), 502);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM br_challenges').get().count, 0);
  } finally { globalThis.fetch = previous; sqlite.close(); }
});

test('OTP validates format, hashes only the code, consumes once, and profile writes require CSRF', async () => {
  const { sqlite, env } = setup();
  env.BABA_SMS_WEBHOOK = 'https://sms.example/private'; env.BABA_SMS_TOKEN = 'test-private-relay-token';
  const previous = globalThis.fetch; let sent;
  globalThis.fetch = async (url, options) => { sent = { url, options, body: JSON.parse(options.body) }; return new Response('', { status: 202 }); };
  try {
    await rejects(sendOtp(request('/api/customer-send'), env, { phone: '1234567890' }), 400);
    const started = await sendOtp(request('/api/customer-send'), env, { phone: '+91 9876543210' });
    assert.equal(started.expiresIn, 300); assert.equal(started.resendAfter, 60);
    assert.equal(sent.body.phone, '+919876543210'); assert.equal(sent.options.redirect, 'manual');
    const code = sent.body.message.match(/code is (\d{6})/)[1];
    const stored = sqlite.prepare('SELECT * FROM br_challenges').get();
    assert.equal(stored.hash.length, 64); assert.notEqual(stored.hash, code);
    await rejects(sendOtp(request('/api/customer-send'), env, { phone: '9876543210' }), 429);
    await rejects(verifyOtp(request('/api/customer-verify'), env, { challenge: started.challenge, code: code === '000000' ? '111111' : '000000' }), 400);
    const verified = await verifyOtp(request('/api/customer-verify'), env, { challenge: started.challenge, code });
    assert.equal(verified.payload.profile.verified, true);
    assert.equal(verified.payload.profile.phone, '9876543210');
    assert.match(verified.cookie, /Max-Age=604800$/);
    await rejects(verifyOtp(request('/api/customer-verify'), env, { challenge: started.challenge, code }), 400);
    const session = await authenticate(request('/api/customer-save', { cookie: verified.cookie, csrf: verified.payload.csrf }), { ...env }, 'customer');
    await rejects(authenticate(request('/api/customer-save', { cookie: verified.cookie }), env, 'customer'), 403);
    await rejects(saveCustomer(env, session, { name: '', email: 'bad' }), 400);
    const saved = await saveCustomer(env, session, { name: '  Baba Guest  ', email: 'guest@example.com' });
    assert.equal(saved.name, 'Baba Guest');
    assert.equal((await customerProfile(env, session)).email, 'guest@example.com');
    await customerLogout(request('/api/customer-logout', { cookie: verified.cookie, csrf: session.csrf }), env);
    assert.equal(await authenticate(request('/api/customer-profile', { method: 'GET', cookie: verified.cookie }), env, 'customer'), null);
  } finally { globalThis.fetch = previous; sqlite.close(); }
});

test('OTP expires, allows at most five wrong attempts, and uses durable phone/IP/hour limits', async () => {
  const { sqlite, env } = setup();
  env.BABA_SMS_WEBHOOK = 'https://sms.example/private'; env.BABA_SMS_TOKEN = 'test-private-relay-token';
  const previousFetch = globalThis.fetch, previousTime = Date.now;
  let time = 1800000000000, code;
  Date.now = () => time;
  globalThis.fetch = async (url, options) => { code = JSON.parse(options.body).message.match(/code is (\d{6})/)[1]; return new Response('', { status: 200 }); };
  try {
    const first = await sendOtp(request('/api/customer-send'), env, { phone: '9876543210' });
    const bad = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await rejects(verifyOtp(request('/api/customer-verify'), env, { challenge: first.challenge, code: bad }), 400);
    await rejects(verifyOtp(request('/api/customer-verify'), env, { challenge: first.challenge, code }), 400);
    for (let i = 1; i < 5; i++) { time += 61000; await sendOtp(request('/api/customer-send'), { ...env }, { phone: '9876543210' }); }
    time += 61000;
    await rejects(sendOtp(request('/api/customer-send', { ip: '203.0.113.7' }), env, { phone: '9876543210' }), 429);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM br_rate').get().count, 10);
    // A denied phone limit did not consume another IP slot.
    for (let i = 0; i < 5; i++) await sendOtp(request('/api/customer-send'), env, { phone: '987654322' + i });
    await rejects(sendOtp(request('/api/customer-send'), env, { phone: '9876543230' }), 429);
    time += 3601000;
    const fresh = await sendOtp(request('/api/customer-send'), env, { phone: '9876543210' });
    time += 300000;
    await rejects(verifyOtp(request('/api/customer-verify'), env, { challenge: fresh.challenge, code }), 400);
  } finally { Date.now = previousTime; globalThis.fetch = previousFetch; sqlite.close(); }
});
