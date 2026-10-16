import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
const db = config.d1_databases?.find(binding => binding.binding === 'DB');
const bucket = config.r2_buckets?.find(binding => binding.binding === 'BUCKET');
const hasher = config.durable_objects?.bindings?.find(binding => binding.name === 'ADMIN_PASSWORD_HASHER');
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(db?.database_id || '') || /^0{8}-/.test(db.database_id)) {
  throw new Error('Set the actual provisioned Cloudflare D1 database ID in wrangler.json before deployment.');
}
if (bucket && (!bucket.bucket_name || /replace|placeholder/i.test(bucket.bucket_name))) {
  throw new Error('Set the actual provisioned private R2 bucket name, or remove the optional BUCKET binding.');
}
if (config.routes || config.route || config.workers_dev !== true) {
  throw new Error('This initial package is intended for workers.dev without custom-domain routes.');
}
if (hasher?.class_name !== 'AdminPasswordHasher' || hasher.script_name ||
    !config.migrations?.some(migration => migration.new_sqlite_classes?.includes('AdminPasswordHasher'))) {
  throw new Error('Configure the internal SQLite-backed AdminPasswordHasher binding and migration before deployment.');
}
console.log('Resource bindings provided. Wrangler will publish to the configured account when deployment runs.');
if (!bucket) console.log('R2 is not bound. Catalogue browsing works; admin image uploads remain unavailable.');
