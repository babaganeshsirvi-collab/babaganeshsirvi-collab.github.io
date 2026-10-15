import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await cp('public', 'dist/client', { recursive: true });
await build({
  entryPoints: ['worker/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/server/index.js',
});
console.log('Built public assets and Worker. No deployment performed.');
