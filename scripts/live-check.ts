/** Optional integration check. Sends only invented test data; never reads the user's task database. */
import { app } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Engine } from '../src/main/engine/index';
import { SettingsStore } from '../src/main/settings';
import { runAgent } from '../src/main/agent/index';
import { configureAppData } from '../src/main/app-data';

configureAppData();
void app.whenReady().then(async () => {
  const source = app.getPath('userData');
  const scratch = await mkdtemp(join(tmpdir(), 'tasksprig-live-check-'));
  let engine: Engine | undefined;
  try {
    const store = new SettingsStore(source);
    await store.init();
    const provider = process.env.TASKSPRIG_CHECK_PROVIDER;
    assert.ok(!provider || ['openai', 'anthropic', 'google'].includes(provider), 'TASKSPRIG_CHECK_PROVIDER must be openai, anthropic, or google.');
    const config = provider === 'openai' || provider === 'anthropic' || provider === 'google' ? store.getForProvider(provider) : store.get();
    assert.notEqual(config.provider, 'demo', 'Configure a real model in TaskSprig first.');
    assert.ok(config.apiKey, 'Configure a provider key in TaskSprig first.');
    engine = new Engine({ dataDir: scratch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    await engine.init();
    await engine.setClock('2026-10-21T12:00:00.000Z');
    await engine.applyAction({ type: 'create_task', task: { title: 'Water the fictional demo fern', estimateMinutes: 3, tags: ['Demo', 'Plants'] } });
    await engine.applyAction({ type: 'create_task', task: { title: 'Draft a fictional story outline', estimateMinutes: 20, tags: ['Demo', 'Writing'] } });
    const backend = engine;
    const ask = async (text: string) => runAgent(text, await backend.getSnapshot(), config,
      action => backend.applyAction(action), { getSnapshot: () => backend.getSnapshot() });
    console.log(`Testing configured ${config.provider}/${config.model} using only invented sample tasks in an empty temporary workspace.`);
    const listAnswer = await ask('What can I do in 20 minutes?');
    let snapshot = await backend.getSnapshot();
    const list = snapshot.lists[0];
    assert.ok(list, 'The model must actually create the requested list.');
    assert.ok(list.displayFields.length >= 1 && list.displayFields.length <= 2, 'The model must choose one or two useful row fields.');
    assert.equal(typeof list.completedClearCode, 'string', 'The model must choose a completed-item clearing policy.');
    const total = list.entries.reduce((sum, entry) => sum + snapshot.tasks.find(task => task.id === entry.taskId)!.estimateMinutes, 0);
    assert.ok(total <= 20, 'Selected tasks must fit the total time budget.');
    console.log(`Live list saved with ${list.entries.length} entries. Response: ${listAnswer}`);
    const captureAnswer = await ask('I need to replace the home air filter every six weeks. Tag it Home and Maintenance.');
    snapshot = await backend.getSnapshot();
    const task = snapshot.tasks.find(task => /air filter/i.test(task.title));
    assert.ok(task, 'The model must save the new obligation.');
    assert.ok(task.recurring);
    assert.ok(['home', 'maintenance'].every(tag => task.tags.some(value => value.toLowerCase() === tag)), 'The task must support both requested tags.');
    assert.ok(task.estimateMinutes > 0);
    assert.ok(task.behaviorCode);
    const initial = snapshot.evaluations.find(e => e.taskId === task.id)!;
    assert.equal(initial.error, undefined);
    assert.equal(initial.visible, false, 'Upkeep should stay quiet before its first due date.');
    await backend.setClock(new Date(Date.parse(snapshot.now) + 45 * 86400000).toISOString());
    const late = (await backend.getSnapshot()).evaluations.find(e => e.taskId === task.id)!;
    assert.equal(late.error, undefined);
    assert.equal(late.visible, true);
    assert.ok(late.urgency > initial.urgency);
    await backend.applyAction({ type: 'complete_task', id: task.id });
    assert.equal((await backend.getSnapshot()).evaluations.find(e => e.taskId === task.id)?.visible, false);
    await backend.applyAction({ type: 'uncomplete_task', id: task.id });
    const undone = await backend.getSnapshot();
    assert.equal(undone.evaluations.find(e => e.taskId === task.id)?.nextDueAt, late.nextDueAt);
    assert.equal(undone.tasks.find(item => item.id === task.id)?.completionHistory.length, 0);
    console.log(`Live capture saved generated timing, multiple tags, and a ${task.estimateMinutes}-minute estimate. Time progression, completion, and undo verified. Response: ${captureAnswer}`);
    console.log('Live provider check passed. The original workspace was not modified by this check.');
  } finally {
    await engine?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error.message); app.exit(1); });
