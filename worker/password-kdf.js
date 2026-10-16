import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 310000;
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');

// Called only inside the password-hashing Durable Object in production. Keeping
// this operation out of the HTTP Worker preserves its small free-plan CPU budget.
export async function derivePasswordHash(password, salt) {
  if (typeof password !== 'string' || password.length > 256 ||
      typeof salt !== 'string' || !/^(?:[a-f0-9]{2}){16,64}$/i.test(salt)) {
    throw new TypeError('Invalid password derivation input.');
  }
  const input = encoder.encode(password);
  const saltBytes = Uint8Array.from(salt.match(/../g), pair => parseInt(pair, 16));
  try {
    const material = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    return hex(new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', salt: saltBytes, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256',
    }, material, 256)));
  } catch (error) {
    // Production Workerd caps native PBKDF2. The audited library preserves the
    // existing 310,000-iteration hash without weakening or resetting credentials.
    if (!/iteration|100000|100,000|not supported/i.test(String(error?.message))) throw error;
    return hex(await pbkdf2Async(sha256, input, saltBytes, {
      c: PASSWORD_ITERATIONS, dkLen: 32, asyncTick: 10,
    }));
  } finally {
    input.fill(0);
    saltBytes.fill(0);
  }
}
