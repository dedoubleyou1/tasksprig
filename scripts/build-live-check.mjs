import { build } from 'esbuild';
await build({ entryPoints: ['scripts/live-check.ts'], outfile: 'dist/live-check.js',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22' });
