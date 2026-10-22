import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const bundleId = 'org.tasksprig.desktop';
const allowedRootEntries = new Set(['dist', 'node_modules', 'package.json', 'LICENSE']);

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('Run this local packaging script on an Apple Silicon or Intel Mac.');
}

let packageApp;
try {
  const module = await import('@electron/packager');
  packageApp = module.packager ?? module.default;
} catch {
  throw new Error('Install the packaging dependency first: npm install --save-dev @electron/packager');
}
if (typeof packageApp !== 'function') throw new Error('The installed @electron/packager API was not recognized.');

const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const electron = JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8'));
await access(path.join(root, metadata.main));

const outputs = await packageApp({
  dir: root,
  name: 'TaskSprig',
  executableName: 'TaskSprig',
  appBundleId: bundleId,
  helperBundleId: `${bundleId}.helper`,
  appCategoryType: 'public.app-category.productivity',
  usageDescription: {
    Microphone: 'Transcribe your spoken request live with OpenAI. A pause sends the request to TaskSprig; Escape cancels.',
  },
  appVersion: metadata.version,
  buildVersion: metadata.version,
  electronVersion: electron.version,
  platform: 'darwin',
  arch: process.arch,
  out: path.join(root, 'artifacts'),
  overwrite: true,
  prune: true,
  // Keep Node's ordinary filesystem paths for both SQL.js and QuickJS WASM assets.
  asar: false,
  // Packager matches these against slash-prefixed paths relative to dir.
  // The allowlist excludes all local data, test captures, environment files, and source worktrees.
  ignore: [
    /^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$|LICENSE$)/,
    /(?:^|\/)\.env(?:\.[^/]*)?(?:\/|$)/,
    /(?:^|\/)[^/]*\.sqlite(?:-[^/]*)?(?:\/|$)/,
    /(?:^|\/)settings\.json$/,
    /^\/dist\/.*\.map$/,
    /^\/dist\/(?!main(?:\/|$)|renderer(?:\/|$))/,
  ],
});

for (const output of outputs) {
  const application = path.join(output, 'TaskSprig.app');
  const resources = path.join(application, 'Contents', 'Resources', 'app');
  const identifier = execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleIdentifier', path.join(application, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim();
  if (identifier !== bundleId) throw new Error(`Unexpected bundle identifier: ${identifier}`);
  const unexpected = (await readdir(resources)).filter(name => !allowedRootEntries.has(name));
  if (unexpected.length) throw new Error(`Unexpected files in packaged app: ${unexpected.join(', ')}`);
  await access(path.join(resources, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
  for (const dependency of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'quickjs-emscripten', 'typebox', 'ws']) {
    const directory = path.join(resources, 'node_modules', dependency);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const entry = manifest.exports?.['.']?.import ?? manifest.module ?? manifest.main;
    if (typeof entry !== 'string') throw new Error(`Missing runtime entry for ${dependency}`);
    await access(path.join(directory, entry));
  }
  console.log(`\nPackaged ${application}\nBundle ID: ${identifier}\nLocal unsigned build; no publishing or notarization was performed.`);
}
