import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import electron from 'electron';
await import('./build-main.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
let desktop;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  vite.kill(); desktop?.kill();
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
vite.on('exit', code => { if (!stopping) stop(code ?? 1); });
for (let attempt = 0; attempt < 100; attempt++) {
  try { const response = await fetch('http://127.0.0.1:5173'); if (response.ok) break; } catch {}
  if (attempt === 99) throw new Error('Vite did not start in time');
  await delay(150);
}
desktop = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, TASKSPRIG_DEV_URL: 'http://127.0.0.1:5173' } });
desktop.on('exit', code => stop(code ?? 0));
