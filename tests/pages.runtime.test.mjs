import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { buildPages, pagesRoutes } from '../scripts/build-pages.mjs';

test('Pages package preserves Worker output and uses shared app with real external hashing namespace', async () => {
  const workerBefore = await readFile('dist/server/index.js');
  const workerConfigBefore = await readFile('wrangler.json');
  await buildPages();
  assert.deepEqual(await readFile('dist/server/index.js'), workerBefore);
  assert.deepEqual(await readFile('wrangler.json'), workerConfigBefore);
  await promisify(execFile)(process.execPath, ['scripts/check-pages-deployment.mjs']);
  assert.deepEqual(JSON.parse(await readFile('pages-dist/_routes.json', 'utf8')), pagesRoutes);
  assert.match(await readFile('pages-dist/404.html', 'utf8'), /Page not found/);
  const bundle = await build({ entryPoints: ['worker/pages.js'], bundle: true, write: false, format: 'esm', platform: 'browser', metafile: true });
  const output = Object.values(bundle.metafile.outputs)[0];
  assert.deepEqual(output.exports, ['default']);
  assert.ok(!Object.keys(bundle.metafile.inputs).some(path => path.endsWith('/password-hasher.js')));

  // This is an actual second Workerd script, not an RPC mock or HTTP hashing API.
  const owner = await build({ entryPoints: ['worker/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  const salt = 'bfb606d9915ce8b1c7ba2ac586e38536', password = 'pages-test-only-password';
  const mf = new Miniflare({ workers: [
    {
      name: 'restaurant-pages', modules: true, scriptPath: 'pages-dist/_worker.js', compatibilityDate: '2026-01-01',
      d1Databases: { DB: 'restaurant-pages-test' },
      durableObjects: { ADMIN_PASSWORD_HASHER: { className: 'AdminPasswordHasher', scriptName: 'babas-bar-restro', useSQLite: true } },
      bindings: { BR_ADMIN_USERNAME: 'pages-owner', BR_ADMIN_SALT: salt, BR_ADMIN_HASH: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310000, 32, 'sha256').toString('hex'), BR_ADMIN_REQUIRE_PASSWORD_CHANGE: 'true' },
      assets: { directory: 'pages-dist', binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
    },
    {
      name: 'babas-bar-restro', modules: true, script: owner.outputFiles[0].text, compatibilityDate: '2026-01-01',
      durableObjects: { ADMIN_PASSWORD_HASHER: { className: 'AdminPasswordHasher', useSQLite: true } },
    },
  ] });
  try {
    const db = await mf.getD1Database('DB', 'restaurant-pages');
    for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
      for (const sql of (await readFile('migrations/' + file, 'utf8')).split('--> statement-breakpoint')) if (sql.trim()) await db.prepare(sql.trim()).run();
    }
    const get = (path, headers = {}) => mf.dispatchFetch('https://bar.test' + path, { headers, redirect: 'manual' });
    const post = (path, body, headers = {}) => mf.dispatchFetch('https://bar.test' + path, { method: 'POST', headers: { Origin: 'https://bar.test', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let response = await get('/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Baba's Bar &amp;|Baba's Bar & Restro/);
    response = await get('/catalogue.json');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).products.length, 1954);
    for (const path of ['/.admin/admin.sqlite3', '/.private/admin-login.txt', '/missing-page', '/assets/uploads/missing.png', '/_worker.js', '/_worker.js/index.js', '/_routes.json', '/_headers', '/wrangler.json']) {
      assert.equal((await get(path)).status, 404, path);
    }
    response = await get('/dist/');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://bar.test/');
    response = await get('/api/store-config');
    const config = await response.json();
    assert.equal(config.orderingEnabled, false);
    assert.equal(config.region, 'Rajasthan, India');
    assert.equal(config.supportEmail, 'ganesh@bababeardo.world');
    assert.equal((await (await get('/api/payment-config')).json()).configured, false);
    assert.equal((await post('/api/customer-send', { phone: '9876543210' })).status, 503);
    assert.equal((await get('/api/admin-site')).status, 401);
    response = await post('/api/login', { username: 'pages-owner', password });
    assert.equal(response.status, 200, await response.clone().text());
    const session = await response.json(), cookie = response.headers.get('Set-Cookie').split(';')[0];
    assert.ok(session.csrf);
    assert.equal((await get('/api/admin-site', { Cookie: cookie })).status, 200);
    response = await get('/api/launch-readiness', { Cookie: cookie });
    const catalogue = JSON.parse(await readFile('worker/catalogue-seed.json', 'utf8'));
    assert.equal((await response.json()).images.refined, catalogue.products.filter(product => product.imageTreatment === 'AI-refined illustration').length);
    assert.equal((await post('/api/upload', { data: 'iVBORw==' }, { Cookie: cookie, 'X-CSRF-Token': session.csrf })).status, 503);
    response = await post('/api/login', { username: 'pages-owner', password: 'incorrect' });
    assert.equal(response.status, 401);
  } finally { await mf.dispose(); }
});
