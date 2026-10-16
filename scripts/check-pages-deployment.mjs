import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('wrangler.pages.json', 'utf8'));
const worker = JSON.parse(await readFile('wrangler.json', 'utf8'));
const staged = JSON.parse(await readFile('.pages-deploy/wrangler.json', 'utf8'));
const normalizedStaged = { ...staged, $schema: config.$schema, pages_build_output_dir: config.pages_build_output_dir };
if (JSON.stringify(normalizedStaged) !== JSON.stringify(config) || staged.pages_build_output_dir !== '../pages-dist') {
  throw new Error('Rebuild Pages before deployment: staged configuration is stale.');
}
const db = config.d1_databases?.find(binding => binding.binding === 'DB');
const hasher = config.durable_objects?.bindings?.find(binding => binding.name === 'ADMIN_PASSWORD_HASHER');
if (config.name !== 'babas-bar-restro' || config.pages_build_output_dir !== 'pages-dist' || config.account_id !== worker.account_id) {
  throw new Error('Pages must use its separate output and the existing restaurant account/project.');
}
if (!db?.database_id || db.database_id !== worker.d1_databases?.find(binding => binding.binding === 'DB')?.database_id) {
  throw new Error('Pages must use the existing restaurant D1 database.');
}
if (hasher?.class_name !== 'AdminPasswordHasher' || hasher.script_name !== worker.name || config.migrations || config.main || config.assets || config.routes || config.route) {
  throw new Error('Pages must bind to the existing Worker hashing namespace without new classes or routes.');
}
if (config.r2_buckets || config.vars?.BR_ADMIN_REQUIRE_PASSWORD_CHANGE !== 'true') {
  throw new Error('Keep uploads unconfigured and require the initial admin password change.');
}
const routes = JSON.parse(await readFile('pages-dist/_routes.json', 'utf8'));
if (routes.version !== 1 || !routes.include?.includes('/api/*') || !routes.include.includes('/assets/uploads/*') || routes.exclude?.length) {
  throw new Error('Pages APIs and uploaded images must execute the application.');
}
await readFile('pages-dist/404.html');
await readFile('pages-dist/_worker.js');
console.log('Pages package uses the existing DB and hashing Worker. No DNS or root-domain changes are part of this command.');
