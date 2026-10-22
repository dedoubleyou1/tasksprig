import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/main/engine/index';
import { runAgent } from '../src/main/agent/index';
import type { Action, ModelSettings } from '../src/shared/types';

const settings: ModelSettings = { provider: 'demo', model: '', apiKey: '' };

test('demo capture, generated behavior, daily list, and restart form a complete local loop', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tasksprig-integration-'));
  let engine = new Engine({ dataDir, timezone: 'America/New_York' });
  try {
    await engine.init();
    await engine.setClock('2026-10-21T16:00:00.000Z');
    const apply = (action: Action) => engine.applyAction(action);
    const ask = async (text: string) => runAgent(text, await engine.getSnapshot(), settings, apply);
    const response = await ask('I need to water the plants every two weeks');
    assert.ok(response.length > 0);
    let snapshot = await engine.getSnapshot();
    const plant = snapshot.tasks.find(task => /plant/i.test(task.title));
    assert.ok(plant, 'plain-language capture creates a plant task');
    assert.ok(plant.recurring);
    assert.ok(plant.estimateMinutes > 0);
    assert.match(plant.behaviorCode, /=>|function/);
    assert.equal(snapshot.evaluations.find(e => e.taskId === plant.id)?.visible, false);

    await ask('Pick three priorities for me every morning');
    snapshot = await engine.getSnapshot();
    assert.ok(snapshot.routines.some(r => r.trigger.type === 'daily'));
    assert.ok(snapshot.lists.length > 0);
    const routineCount = snapshot.routines.length;

    await engine.setClock('2026-11-05T16:00:00.000Z');
    await engine.tick((routine, current) => runAgent(routine.instructions, current, settings, apply, { routine }));
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.evaluations.find(e => e.taskId === plant.id)?.visible, true);
    assert.ok(snapshot.lists.some(list => list.entries.some(entry => entry.taskId === plant.id)));
    assert.equal(snapshot.routines.length, routineCount, 'executing a routine does not create another routine');
    const runCount = snapshot.routineRuns.length;
    await engine.tick((routine, current) => runAgent(routine.instructions, current, settings, apply, { routine }));
    assert.equal((await engine.getSnapshot()).routineRuns.length, runCount);

    await apply({ type: 'complete_task', id: plant.id });
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.tasks.find(t => t.id === plant.id)?.status, 'open');
    assert.equal(snapshot.evaluations.find(e => e.taskId === plant.id)?.visible, false);
    await engine.close();
    engine = new Engine({ dataDir, timezone: 'America/New_York' });
    await engine.init();
    const restored = await engine.getSnapshot();
    assert.equal(restored.tasks.find(t => t.id === plant.id)?.completionHistory.length, 1);
    assert.equal(restored.routines.length, routineCount);
    assert.equal(restored.routineRuns.length, runCount);
  } finally {
    await engine.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('demo project decomposition produces ordered actionable steps', async () => {
  const engine = new Engine({ dataDir: ':memory:', timezone: 'America/New_York' });
  try {
    await engine.init();
    await engine.setClock('2026-10-21T16:00:00.000Z');
    await runAgent('I need to submit a conference proposal by Friday', await engine.getSnapshot(), settings,
      action => engine.applyAction(action));
    const snapshot = await engine.getSnapshot();
    const parent = snapshot.tasks.find(t => snapshot.tasks.some(child => child.parentId === t.id));
    assert.ok(parent);
    const children = snapshot.tasks.filter(t => t.parentId === parent.id);
    assert.ok(children.length >= 2 && children.length <= 5);
    assert.ok(children.every(t => t.estimateMinutes > 0));
    assert.ok(children.some(t => t.dependencyIds.length > 0));
    assert.equal(snapshot.evaluations.find(e => e.taskId === parent.id)?.visible, false);
    const first = children.find(t => t.dependencyIds.length === 0);
    assert.ok(first);
    assert.equal(snapshot.evaluations.find(e => e.taskId === first.id)?.visible, true);
    await engine.applyAction({ type: 'complete_task', id: first.id });
    const after = await engine.getSnapshot();
    assert.ok(children.some(t => t.dependencyIds.includes(first.id) && after.evaluations.find(e => e.taskId === t.id)?.visible));
  } finally { await engine.close(); }
});
