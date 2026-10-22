import { build } from 'esbuild';
await build({ entryPoints: ['scripts/live-voice-check.ts'], outfile: 'dist/live-voice-check.js',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22' });
