import { DurableObject } from 'cloudflare:workers';
import { derivePasswordHash } from './password-kdf.js';

// An internal namespace binding is the only route to this object. Passwords and
// derived values live only for the RPC call; nothing is written to DO storage.
export class AdminPasswordHasher extends DurableObject {
  async derive(password, salt) {
    return derivePasswordHash(password, salt);
  }

  // Hashing has no HTTP endpoint, including through an internal stub.fetch().
  fetch() {
    return new Response('Not found', { status: 404 });
  }
}
