const encoder = new TextEncoder();
const ADMIN_TTL = 8 * 3600;
const CUSTOMER_TTL = 7 * 86400;
const COOKIE_NAMES = { admin: 'babas_session', customer: 'babas_customer' };
const now = () => Math.floor(Date.now() / 1000);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const randomHex = size => hex(crypto.getRandomValues(new Uint8Array(size)));
const query = (env, sql, ...args) => {
  if (!env.DB) throw fail('Account storage is unavailable. Please try again later.', 503);
  return env.DB.prepare(sql).bind(...args);
};
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));

// Fixed length secret hashes/tokens are compared without an early character exit.
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

function sameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw fail('Invalid request origin.', 403);
}

function cookieToken(request, kind) {
  const name = COOKIE_NAMES[kind];
  if (!name) throw fail('Invalid account type.');
  const value = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) || '';
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}

function sessionCookie(kind, token = '', ttl = 0) {
  return `${COOKIE_NAMES[kind]}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ttl}`;
}

async function issueSession(env, kind, subject) {
  const token = randomHex(32), csrf = randomHex(32), expires = now() + (kind === 'admin' ? ADMIN_TTL : CUSTOMER_TTL);
  await env.DB.batch([
    query(env, 'DELETE FROM br_sessions WHERE expires<=?', now()),
    query(env, 'INSERT INTO br_sessions (token_hash,kind,subject,csrf,expires) VALUES (?,?,?,?,?)', await digest(token), kind, subject, csrf, expires)
  ]);
  return { session: { kind, subject, csrf, expires }, cookie: sessionCookie(kind, token, kind === 'admin' ? ADMIN_TTL : CUSTOMER_TTL) };
}

export async function authenticate(request, env, kind) {
  const token = cookieToken(request, kind);
  if (!token) return null;
  const tokenHash = await digest(token);
  const session = await query(env, 'SELECT kind,subject,csrf,expires FROM br_sessions WHERE token_hash=? AND kind=? AND expires>?', tokenHash, kind, now()).first();
  if (!session) return null;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    sameOrigin(request);
    if (!equal(request.headers.get('X-CSRF-Token'), session.csrf)) throw fail('Invalid session token.', 403);
  }
  return { ...session, tokenHash, ...(kind === 'customer' ? { phone: session.subject } : {}) };
}

async function passwordHash(env, password, salt) {
  try {
    const namespace = env.ADMIN_PASSWORD_HASHER;
    if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') throw Error();
    const stub = namespace.get(namespace.idFromName('admin-pbkdf2-v1'));
    if (typeof stub?.derive !== 'function') throw Error();
    const hashed = await stub.derive(password, salt);
    if (typeof hashed !== 'string' || !/^[a-f0-9]{64}$/.test(hashed)) throw Error();
    return hashed;
  } catch {
    // No fallback here: expensive derivation must stay inside the Durable Object.
    throw fail('Password verification is temporarily unavailable. Please try again.', 503);
  }
}

async function credentials(env) {
  let stored = await query(env, 'SELECT username,salt,hash FROM br_credentials WHERE id=1').first();
  if (stored) return stored;
  if (typeof env.BR_ADMIN_USERNAME !== 'string' || !env.BR_ADMIN_USERNAME || env.BR_ADMIN_USERNAME.length > 100 ||
      !/^(?:[a-f0-9]{2}){16,64}$/i.test(env.BR_ADMIN_SALT || '') || !/^[a-f0-9]{64}$/i.test(env.BR_ADMIN_HASH || '')) {
    throw fail('Admin login is not configured.', 503);
  }
  await query(env, 'INSERT OR IGNORE INTO br_credentials (id,username,salt,hash) VALUES (1,?,?,?)', env.BR_ADMIN_USERNAME, env.BR_ADMIN_SALT.toLowerCase(), env.BR_ADMIN_HASH.toLowerCase()).run();
  return query(env, 'SELECT username,salt,hash FROM br_credentials WHERE id=1').first();
}

export async function adminPasswordIsDefault(env) {
  const stored = await credentials(env);
  return env.BR_ADMIN_REQUIRE_PASSWORD_CHANGE === 'true' && equal(env.BR_ADMIN_HASH || '', stored.hash);
}

export async function adminLogin(request, env, body) {
  sameOrigin(request);
  const timestamp = now(), key = 'admin-login:' + await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
  // Conditional insertion is one database write: simultaneous requests share a durable limit.
  const reserved = await query(env, 'INSERT INTO br_rate (key,created) SELECT ?,? WHERE (SELECT COUNT(*) FROM br_rate WHERE key=? AND created>?)<5', key, timestamp, key, timestamp - 60).run();
  if (reserved.meta.changes !== 1) throw fail('Too many attempts. Try again in one minute.', 429);
  await query(env, 'DELETE FROM br_rate WHERE created<=?', timestamp - 86400).run();
  const stored = await credentials(env);
  if (typeof body?.username !== 'string' || body.username.length > 100 || typeof body?.password !== 'string' || body.password.length > 256) throw fail('Incorrect username or password.', 401);
  const hashed = await passwordHash(env, body.password, stored.salt);
  if (!equal(body.username, stored.username) || !equal(hashed, stored.hash)) throw fail('Incorrect username or password.', 401);
  await query(env, 'DELETE FROM br_rate WHERE key=?', key).run();
  const issued = await issueSession(env, 'admin', stored.username);
  return { payload: { csrf: issued.session.csrf }, cookie: issued.cookie };
}

export async function adminLogout(request, env) {
  sameOrigin(request);
  const session = await authenticate(request, env, 'admin');
  if (session) await query(env, 'DELETE FROM br_sessions WHERE token_hash=?', session.tokenHash).run();
  return { payload: { loggedOut: true }, cookie: sessionCookie('admin') };
}

export async function changePassword(request, env, session, body) {
  sameOrigin(request);
  if (!session || session.kind !== 'admin' || !equal(request.headers.get('X-CSRF-Token'), session.csrf)) throw fail('Please sign in again.', 403);
  const current = body?.current, password = body?.password;
  if (typeof current !== 'string' || current.length > 256 || typeof password !== 'string' || password.length < 10 || password.length > 128) throw fail('Use a new password of 10–128 characters.');
  const stored = await credentials(env);
  if (!equal(await passwordHash(env, current, stored.salt), stored.hash)) throw fail('Current password is incorrect.', 401);
  if (password === current) throw fail('Choose a different password from your current password.');
  const salt = randomHex(16), hash = await passwordHash(env, password, salt);
  const result = await env.DB.batch([
    query(env, 'UPDATE br_credentials SET salt=?,hash=? WHERE id=1 AND salt=? AND hash=?', salt, hash, stored.salt, stored.hash),
    query(env, "DELETE FROM br_sessions WHERE kind='admin'")
  ]);
  if (result[0].meta.changes !== 1) throw fail('Account credentials changed. Please sign in again.', 409);
  return { payload: { changed: true }, cookie: sessionCookie('admin') };
}

function indianPhone(value) {
  if (typeof value !== 'string') throw fail('Enter a valid Indian mobile number.');
  let number = value.replace(/[\s+\-]/g, '');
  if (number.length === 12 && number.startsWith('91')) number = number.slice(2);
  if (!/^[6-9][0-9]{9}$/.test(number)) throw fail('Enter a valid 10-digit Indian mobile number.');
  return number;
}

export function customerConfigured(env) {
  try {
    const url = new URL(env.BABA_SMS_WEBHOOK);
    return url.protocol === 'https:' && !url.username && !url.password && !!env.BABA_SMS_TOKEN;
  } catch { return false; }
}

function otpCode() {
  // Rejection sampling avoids modulo bias while preserving leading zeroes.
  let number;
  do { number = crypto.getRandomValues(new Uint32Array(1))[0]; } while (number >= 4294000000);
  return String(number % 1000000).padStart(6, '0');
}

async function otpHash(env, challenge, code) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.BABA_SMS_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`babas-otp:${challenge}:${code}`))));
}

export async function sendOtp(request, env, body) {
  sameOrigin(request);
  const phone = indianPhone(body?.phone);
  if (!customerConfigured(env)) throw fail('SMS OTP is not connected yet. Please try again after setup.', 503);
  const timestamp = now(), phoneKey = 'otp-phone:' + await digest(phone), ipKey = 'otp-ip:' + await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
  // Both counters are reserved atomically. A denied request consumes neither.
  const reserved = await query(env, `WITH requested(key,maximum,cooldown) AS (VALUES (?,5,60),(?,10,0))
    INSERT INTO br_rate (key,created) SELECT key,? FROM requested
    WHERE NOT EXISTS (SELECT 1 FROM requested AS r WHERE
      (SELECT COUNT(*) FROM br_rate WHERE key=r.key AND created>?)>=r.maximum OR
      (r.cooldown>0 AND EXISTS (SELECT 1 FROM br_rate WHERE key=r.key AND created>?)))`, phoneKey, ipKey, timestamp, timestamp - 3600, timestamp - 60).run();
  if (reserved.meta.changes !== 2) throw fail('Please wait before requesting another OTP.', 429);
  const challenge = randomHex(32), code = otpCode(), hash = await otpHash(env, challenge, code);
  await env.DB.batch([
    query(env, 'DELETE FROM br_challenges WHERE phone=? OR expires<=?', phone, timestamp),
    query(env, 'DELETE FROM br_rate WHERE created<=?', timestamp - 86400),
    query(env, 'DELETE FROM br_sessions WHERE expires<=?', timestamp),
    query(env, 'INSERT INTO br_challenges (id,phone,hash,expires,attempts) VALUES (?,?,?,?,0)', challenge, phone, hash, timestamp + 300)
  ]);
  try {
    const response = await fetch(env.BABA_SMS_WEBHOOK, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.BABA_SMS_TOKEN },
      body: JSON.stringify({ phone: '+91' + phone, message: `Your Baba's Bar & Restro verification code is ${code}. Valid for 5 minutes. Do not share it.` })
    });
    if (![200, 201, 202, 204].includes(response.status)) throw new Error('Provider rejected request.');
  } catch {
    await query(env, 'DELETE FROM br_challenges WHERE id=?', challenge).run();
    throw fail('OTP could not be sent. Please try again later.', 502);
  }
  return { challenge, expiresIn: 300, resendAfter: 60 };
}

export async function verifyOtp(request, env, body) {
  sameOrigin(request);
  if (!customerConfigured(env)) throw fail('SMS OTP is not connected yet. Please try again after setup.', 503);
  const challenge = body?.challenge, code = body?.code;
  if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/.test(challenge)) throw fail('OTP expired. Request a new code.');
  const validCode = typeof code === 'string' && /^[0-9]{6}$/.test(code);
  const hashed = validCode ? await otpHash(env, challenge, code) : '';
  // Atomic consume permits one successful verification, including simultaneous requests.
  const accepted = validCode ? await query(env, 'DELETE FROM br_challenges WHERE id=? AND hash=? AND expires>? AND attempts<5 RETURNING phone', challenge, hashed, now()).first() : null;
  if (!accepted) {
    const failed = await query(env, 'UPDATE br_challenges SET attempts=attempts+1 WHERE id=? AND expires>? AND attempts<5 RETURNING attempts', challenge, now()).first();
    if (!failed) throw fail('OTP expired or too many attempts. Request a new code.');
    if (failed.attempts >= 5) {
      await query(env, 'DELETE FROM br_challenges WHERE id=?', challenge).run();
      throw fail('Too many attempts. Request a new OTP.');
    }
    throw fail('Incorrect OTP.');
  }
  await query(env, 'INSERT OR IGNORE INTO br_customers (phone,name,email) VALUES (?,?,?)', accepted.phone, '', '').run();
  const issued = await issueSession(env, 'customer', accepted.phone);
  return { payload: { profile: await customerProfile(env, issued.session), csrf: issued.session.csrf }, cookie: issued.cookie };
}

export async function customerProfile(env, session) {
  if (!session || session.kind !== 'customer') throw fail('Verify your mobile number first.', 401);
  const row = await query(env, 'SELECT name,email FROM br_customers WHERE phone=?', session.subject).first();
  if (!row) throw fail('Profile is unavailable. Please sign in again.', 401);
  return { phone: session.subject, name: row.name, email: row.email, verified: true };
}

export async function saveCustomer(env, session, body) {
  if (!session || session.kind !== 'customer') throw fail('Verify your mobile number first.', 401);
  const name = body?.name, email = body?.email;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || typeof email !== 'string' || email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw fail('Enter your name and a valid email, or leave email blank.');
  await query(env, 'UPDATE br_customers SET name=?,email=? WHERE phone=?', name.trim(), email, session.subject).run();
  return customerProfile(env, session);
}

export async function customerLogout(request, env) {
  sameOrigin(request);
  const session = await authenticate(request, env, 'customer');
  if (session) await query(env, 'DELETE FROM br_sessions WHERE token_hash=?', session.tokenHash).run();
  return { payload: { loggedOut: true }, cookie: sessionCookie('customer') };
}
