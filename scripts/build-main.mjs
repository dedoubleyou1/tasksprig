import { build } from 'esbuild';
await build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', sourcemap: true, target: 'node22' });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true, target: 'node22' });
