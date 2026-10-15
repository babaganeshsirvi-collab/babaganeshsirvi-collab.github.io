import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';

const mf = new Miniflare({
  modules: true,
  scriptPath: 'dist/server/index.js',
  compatibilityDate: '2026-01-01',
  host: '127.0.0.1',
  port: 8082,
  d1Databases: ['DB'],
  r2Buckets: ['BUCKET'],
  assets: {
    directory: 'dist/client', binding: 'ASSETS',
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    assetConfig: { html_handling: 'auto-trailing-slash' },
  },
});

try {
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    for (const sql of (await readFile('migrations/' + file, 'utf8')).split('--> statement-breakpoint')) {
      if (sql.trim()) await db.prepare(sql.trim()).run();
    }
  }
  console.log('Temporary local preview:', String(await mf.ready));
  console.log('Ordering, payments, SMS and admin bootstrap are unconfigured in this preview.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await mf.dispose(); process.exit(); });
} catch (error) {
  await mf.dispose();
  throw error;
}
