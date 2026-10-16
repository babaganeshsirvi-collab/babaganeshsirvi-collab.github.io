import { build } from 'esbuild';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const pagesRoutes = {
  version: 1,
  include: ['/api/*', '/assets/uploads/*', '/dist', '/dist/*', '/_worker.js', '/_worker.js/*', '/_routes.json', '/_headers', '/_redirects', '/wrangler*'],
  exclude: [],
};

// A top-level 404 disables Pages' implicit SPA fallback. Private/missing paths
// therefore return an actual 404 instead of a copy of the home page with 200.
const notFound = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found | Baba's Bar &amp; Restro</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#292d23;color:#f4f0e5;font:16px/1.6 system-ui,sans-serif}main{padding:2rem;max-width:30rem}a{color:#f16649}</style></head><body><main><h1>Page not found</h1><p>The page you requested is unavailable.</p><a href="/">Return to Baba's</a></main></body></html>\n`;

async function checkPublicTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Public output must not contain symlinks: ${path}`);
    if (entry.name.startsWith('.') || /^(?:node_modules|worker|scripts|tests|migrations|backups)$/i.test(entry.name) ||
        /(?:\.sqlite3?|\.db|\.pem|\.key|\.log)$/i.test(entry.name) || /(?:credentials|secrets)/i.test(entry.name)) {
      throw new Error(`Private or source path cannot be published: ${path}`);
    }
    if (entry.isDirectory()) await checkPublicTree(path);
  }
}

export async function buildPages(outputDirectory = 'pages-dist') {
  if (resolve(outputDirectory) !== resolve('pages-dist')) throw new Error('Pages output must be the separate pages-dist directory.');
  await checkPublicTree('public');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await cp('public', outputDirectory, { recursive: true });
  const result = await build({
    entryPoints: ['worker/pages.js'], bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', outfile: `${outputDirectory}/_worker.js`, metafile: true,
  });
  const workerOutput = Object.values(result.metafile.outputs).find(output => output.entryPoint === 'worker/pages.js');
  if (workerOutput?.exports.join(',') !== 'default' || Object.keys(result.metafile.inputs).some(input => input.endsWith('/password-hasher.js'))) {
    throw new Error('Pages must export only the app default and consume the deployed hashing namespace.');
  }
  await writeFile(`${outputDirectory}/_routes.json`, JSON.stringify(pagesRoutes, null, 2) + '\n');
  await writeFile(`${outputDirectory}/404.html`, notFound);
  // Pages CLI rejects --config with a custom filename. Stage only its standard
  // config outside the public output; never replace the Worker's wrangler.json.
  const config = JSON.parse(await readFile('wrangler.pages.json', 'utf8'));
  if (config.pages_build_output_dir !== 'pages-dist') throw new Error('Unexpected Pages output directory.');
  await mkdir('.pages-deploy', { recursive: true });
  await writeFile('.pages-deploy/wrangler.json', JSON.stringify({
    ...config,
    $schema: '../node_modules/wrangler/config-schema.json',
    pages_build_output_dir: '../pages-dist',
  }, null, 2) + '\n');
  console.log('Built isolated Pages assets and API Worker. Existing Worker output is unchanged.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildPages();
