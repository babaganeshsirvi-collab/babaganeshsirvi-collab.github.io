import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const username = 'babas-owner';
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(32).toString('hex');
const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310000, 32, 'sha256').toString('hex');
await mkdir('.private', { recursive: true, mode: 0o700 });
await writeFile('.private/admin-secrets.json', JSON.stringify({
  BR_ADMIN_USERNAME: username, BR_ADMIN_SALT: salt, BR_ADMIN_HASH: hash,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await writeFile('.private/admin-login.txt', 'Username: ' + username + '\nInitial password: ' + password + '\nChange this password after signing in.\n', { flag: 'wx', mode: 0o600 });
console.log('Fresh bootstrap credentials saved in ignored .private/ files. Keep them private; no secrets printed.');
