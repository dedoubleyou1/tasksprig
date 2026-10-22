import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/main/engine/index';
import { SnippetSandbox } from '../src/main/engine/sandbox';
import { atLocalTime, calendarContext, nextDaily } from '../src/main/engine/time';
import { fixedSchedule } from '../src/shared/behaviors';
import { StateStore } from '../src/main/engine/store';

const DAY = 86_400_000;
const START = '2026-10-21T12:30:00.000Z'; // 8:30 AM New York
const WEEKLY = `({ task, now }) => {
  const due = Date.parse(task.lastCompletedAt || task.createdAt) + 7 * 86400000;
  return { visible: now >= due, urgency: now < due ? 0 : Math.min(100, 30 + (now-due)/86400000*10),
    reason: now < due ? 'Not due yet' : 'Watering is due', nextDueAt: new Date(due).toISOString() };
}`;
async function fresh(dataDir = ':memory:') {
  const engine = new Engine({ dataDir, timezone: 'America/New_York' });
  await engine.init(); await engine.setClock(START);
  return engine;
}

test('recurring work starts quiet, rises after due date, and reanchors on actual completion', async () => {
  const engine = await fresh();
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Water plants', recurring: true, behaviorCode: WEEKLY } });
    assert.equal((await engine.getSnapshot()).evaluations[0].visible, false);
    await engine.setClock(new Date(Date.parse(START) + 7 * DAY).toISOString());
    assert.equal((await engine.getSnapshot()).evaluations[0].urgency, 30);
    await engine.setClock(new Date(Date.parse(START) + 9 * DAY).toISOString());
    assert.equal((await engine.getSnapshot()).evaluations[0].urgency, 50);
    await engine.applyAction({ type: 'complete_task', id: task.id });
    const state = await engine.getSnapshot();
    assert.equal(state.tasks[0].status, 'open');
    assert.equal(state.tasks[0].completionHistory.length, 1);
    assert.equal(state.evaluations[0].visible, false);
    assert.equal(state.evaluations[0].nextDueAt, new Date(Date.parse(START) + 16 * DAY).toISOString());
  } finally { await engine.close(); }
});

test('project steps respect dependencies and complete the parent when all steps finish', async () => {
  const engine = await fresh();
  try {
    const parent = await engine.applyAction({ type: 'create_task', task: { title: 'Proposal' } });
    const first = await engine.applyAction({ type: 'create_task', task: { title: 'Outline', parentId: parent.id } });
    const second = await engine.applyAction({ type: 'create_task', task: { title: 'Submit', parentId: parent.id, dependencyIds: [first.id] } });
    let snapshot = await engine.getSnapshot();
    assert.equal(snapshot.evaluations.find(item => item.taskId === parent.id)?.visible, false);
    assert.equal(snapshot.evaluations.find(item => item.taskId === second.id)?.visible, false);
    await engine.applyAction({ type: 'complete_task', id: first.id });
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.evaluations.find(item => item.taskId === second.id)?.visible, true);
    await engine.applyAction({ type: 'complete_task', id: second.id });
    assert.equal((await engine.getSnapshot()).tasks.find(item => item.id === parent.id)?.status, 'done');
    await assert.rejects(engine.applyAction({ type: 'update_task', id: first.id, patch: { dependencyIds: [second.id] } }), /circular/);
  } finally { await engine.close(); }
});

test('live lists retain completed rows and saved selections refresh after the undo grace', async t => {
  const engine = await fresh();
  try {
    const first = await engine.applyAction({ type: 'create_task', task: { title: 'First' } });
    await engine.applyAction({ type: 'create_list', list: { name: 'Live', mode: 'live' } });
    const saved = await engine.applyAction({ type: 'create_list', list: { name: 'Saved', mode: 'snapshot' } });
    const next = await engine.applyAction({ type: 'create_task', task: { title: 'Second' } });
    let snapshot = await engine.getSnapshot();
    assert.equal(snapshot.lists.find(list => list.name === 'Live')?.entries.length, 2);
    assert.deepEqual(snapshot.lists.find(list => list.name === 'Saved')?.entries.map(entry => entry.taskId), [first.id]);
    await engine.applyAction({ type: 'complete_task', id: first.id });
    snapshot = await engine.getSnapshot();
    assert.deepEqual(snapshot.lists.find(list => list.name === 'Live')?.entries.map(entry => entry.taskId), [next.id, first.id]);
    assert.equal(snapshot.lists.find(list => list.name === 'Live')?.entries[1].completedAt, START);
    assert.equal(snapshot.lists.find(list => list.name === 'Saved')?.entries[0].taskId, first.id);
    await engine.applyAction({ type: 'refresh_list', id: saved.id });
    assert.deepEqual((await engine.getSnapshot()).lists.find(list => list.name === 'Saved')?.entries.map(entry => entry.taskId), [next.id, first.id]);
    const actualNow = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => actualNow() + 31_000);
    await engine.applyAction({ type: 'refresh_list', id: saved.id });
    assert.deepEqual((await engine.getSnapshot()).lists.find(list => list.name === 'Saved')?.entries.map(entry => entry.taskId), [next.id]);
  } finally { await engine.close(); }
});

test('invalid generated revisions preserve the last working behavior and list', async () => {
  const engine = await fresh();
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Keep me', behaviorCode: WEEKLY } });
    await assert.rejects(engine.applyAction({ type: 'update_task', id: task.id, patch: { behaviorCode: '() => ({visible:true,urgency:200,reason:"Bad"})' } }), /Urgency/);
    assert.equal((await engine.getSnapshot()).tasks[0].behaviorCode, WEEKLY);
    await assert.rejects(engine.applyAction({ type: 'create_list', list: { name: 'Invalid', selectionCode: '() => [{taskId:"missing", reason:"Invalid"}]' } }), /no longer exists/);
    assert.equal((await engine.getSnapshot()).lists.length, 0);
  } finally { await engine.close(); }
});

test('daily catchup produces one recent run and survives a database restart without duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasksprig-engine-'));
  let engine = await fresh(directory);
  let calls = 0;
  const run = async () => { calls++; return 'Three priorities selected.'; };
  try {
    await engine.applyAction({ type: 'create_routine', routine: {
      name: 'Morning', instructions: 'Choose priorities', trigger: { type: 'daily', time: '09:00', timezone: 'America/New_York' },
    } });
    await engine.setClock('2026-10-31T16:00:00Z');
    await engine.tick(run); await engine.tick(run);
    assert.equal(calls, 1);
    assert.equal((await engine.getSnapshot()).routineRuns[0].scheduledFor, '2026-10-31T13:00:00.000Z');
    await engine.close();
    engine = new Engine({ dataDir: directory, timezone: 'America/New_York' });
    await engine.init(); await engine.tick(run);
    assert.equal(calls, 1);
    await engine.setClock('2026-11-01T15:00:00Z');
    await engine.tick(run);
    assert.equal(calls, 2);
    assert.equal((await engine.getSnapshot()).routineRuns[0].scheduledFor, '2026-11-01T14:00:00.000Z');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('completion callbacks remain queued across restart and failures do not retry forever', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasksprig-event-'));
  let engine = await fresh(directory);
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Finish setup' } });
    await engine.applyAction({ type: 'create_routine', routine: {
      name: 'After setup', instructions: 'Reflect', trigger: { type: 'task_completed', taskId: task.id },
    } });
    await engine.applyAction({ type: 'complete_task', id: task.id });
    await engine.close();
    engine = new Engine({ dataDir: directory, timezone: 'America/New_York' });
    let calls = 0;
    await engine.tick(async () => { calls++; throw new Error('Provider unavailable'); });
    await engine.tick(async () => { calls++; return 'Unexpected'; });
    assert.equal(calls, 1);
    assert.equal((await engine.getSnapshot()).routineRuns[0].status, 'failed');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('routine conditions skip model calls and concurrent ticks do not duplicate a claimed run', async () => {
  const engine = await fresh();
  try {
    await engine.applyAction({ type: 'create_routine', routine: {
      name: 'Conditional', instructions: 'Only if useful', trigger: { type: 'once', at: START },
      conditionCode: '() => ({run:false,reason:"Nothing needs attention"})',
    } });
    let calls = 0;
    await Promise.all([engine.tick(async () => { calls++; return ''; }), engine.tick(async () => { calls++; return ''; })]);
    assert.equal(calls, 0);
    assert.match((await engine.getSnapshot()).routineRuns[0].message, /Nothing needs attention/);
  } finally { await engine.close(); }
});

test('sandbox interrupts infinite loops, forbids host capabilities, and observes the supplied clock', async () => {
  const sandbox = await SnippetSandbox.create();
  const started = Date.now();
  assert.throws(() => sandbox.run('() => { while (true) {} }', {}, Date.parse(START)), /interrupted/);
  assert.ok(Date.now() - started < 1500, 'infinite loop should be interrupted promptly');
  assert.deepEqual(sandbox.run('() => ({require:typeof require,process:typeof process,fetch:typeof fetch,date:Date.now(),constructed:new Date().toISOString()})', {}, Date.parse(START)),
    { require: 'undefined', process: 'undefined', fetch: 'undefined', date: Date.parse(START), constructed: START });
});

test('local schedule conversion keeps morning times stable across daylight saving time', () => {
  assert.equal(new Date(atLocalTime('2026-11-01', '09:00', 'America/New_York')).toISOString(), '2026-11-01T14:00:00.000Z');
  assert.equal(new Date(nextDaily(Date.parse('2026-10-31T14:00:00Z'), '09:00', 'America/New_York')).toISOString(), '2026-11-01T14:00:00.000Z');
  const calendar = calendarContext(Date.parse(START), 'America/New_York');
  assert.equal(calendar.hour, 8);
  assert.equal(calendar.utcOffsetMinutes, -240);
  assert.equal(calendar.days.find(day => day.date === '2026-11-01')?.utcOffsetMinutes, -300);
});

test('fixed weekly cadence retains its weekday after a late completion and a DST boundary', async t => {
  const engine = await fresh();
  try {
    const task = await engine.applyAction({ type: 'create_task', task: {
      title: 'Weekly reminder', recurring: true, behaviorCode: fixedSchedule('weekly', '2026-10-21'),
    } });
    await engine.setClock('2026-10-23T14:00:00Z');
    assert.equal((await engine.getSnapshot()).evaluations[0].visible, true);
    await engine.applyAction({ type: 'complete_task', id: task.id });
    assert.equal((await engine.getSnapshot()).evaluations[0].nextDueAt, '2026-10-28T13:00:00.000Z');
    const actualNow = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => actualNow() + 31_000);
    await engine.setClock('2026-11-02T14:00:00Z');
    await engine.applyAction({ type: 'complete_task', id: task.id });
    assert.equal((await engine.getSnapshot()).evaluations[0].nextDueAt, '2026-11-04T14:00:00.000Z');
  } finally { await engine.close(); }
});

test('fixed monthly cadence clamps short months and returns to its original month day', async t => {
  const engine = await fresh();
  try {
    await engine.setClock('2026-01-31T15:00:00Z');
    const task = await engine.applyAction({ type: 'create_task', task: {
      title: 'Monthly reminder', recurring: true, behaviorCode: fixedSchedule('monthly', '2026-01-31'),
    } });
    await engine.applyAction({ type: 'complete_task', id: task.id });
    assert.equal((await engine.getSnapshot()).evaluations[0].nextDueAt, '2026-02-28T14:00:00.000Z');
    const actualNow = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => actualNow() + 31_000);
    await engine.setClock('2026-03-02T15:00:00Z');
    await engine.applyAction({ type: 'complete_task', id: task.id });
    assert.equal((await engine.getSnapshot()).evaluations[0].nextDueAt, '2026-03-31T13:00:00.000Z');
  } finally { await engine.close(); }
});

test('reset demo seeds the requested examples, runnable lists, and a morning callback', async () => {
  const engine = await fresh();
  try {
    await engine.resetDemo();
    const snapshot = await engine.getSnapshot();
    assert.ok(snapshot.simulated);
    assert.equal(snapshot.tasks.filter(task => task.recurring).length, 4);
    assert.ok(snapshot.evaluations.every(evaluation => !evaluation.error));
    assert.equal(snapshot.lists.length, 2);
    assert.equal(snapshot.routines.length, 1);
    assert.equal(snapshot.tasks.find(task => /plant/.test(task.title))?.estimateMinutes, 5);
  } finally { await engine.close(); }
});

test('rewinding the demo clock rebases daily callbacks and previously claimed dates do not strand the schedule', async () => {
  const engine = await fresh();
  try {
    await engine.applyAction({ type: 'create_routine', routine: {
      name: 'Morning', instructions: 'Choose priorities', trigger: { type: 'daily', time: '09:00', timezone: 'America/New_York' },
    } });
    let calls = 0;
    const run = async () => { calls++; return 'Done'; };
    await engine.setClock('2026-11-10T15:00:00Z');
    await engine.tick(run);
    await engine.setClock(START);
    assert.equal((await engine.getSnapshot()).routines[0].nextRunAt, '2026-10-21T13:00:00.000Z');
    await engine.setClock('2026-10-22T14:00:00Z');
    await engine.tick(run);
    assert.equal(calls, 2);
    await engine.setClock('2026-11-10T15:00:00Z');
    await engine.tick(run);
    assert.equal(calls, 2, 'an occurrence already demonstrated is not duplicated');
    assert.equal((await engine.getSnapshot()).routines[0].nextRunAt, '2026-11-11T14:00:00.000Z');
    await engine.setClock('2026-11-11T15:00:00Z');
    await engine.tick(run);
    assert.equal(calls, 3);
  } finally { await engine.close(); }
});

test('show_list validates the saved list without changing its contents, timestamps, or history', async () => {
  const engine = await fresh();
  try {
    await engine.applyAction({ type: 'create_task', task: { title: 'An existing item' } });
    const list = await engine.applyAction({ type: 'create_list', list: { name: 'An existing selection', mode: 'snapshot' } });
    const before = await engine.getSnapshot();
    const result = await engine.applyAction({ type: 'show_list', id: list.id });
    assert.equal(result.id, list.id);
    assert.match(result.message, /An existing selection/);
    assert.deepEqual(await engine.getSnapshot(), before);
    await assert.rejects(engine.applyAction({ type: 'show_list', id: 'missing' }), /no longer exists/);
  } finally { await engine.close(); }
});

test('ephemeral lists evaluate live but never enter SQLite and do not return after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasksprig-temporary-'));
  let engine = await fresh(directory);
  try {
    const first = await engine.applyAction({ type: 'create_task', task: { title: 'Quick call', estimateMinutes: 5 } });
    const saved = await engine.applyAction({ type: 'create_list', list: { name: 'Keep this list' } });
    const temporary = await engine.applyAction({ type: 'create_list', list: {
      name: 'For the next twenty minutes', ephemeral: true, mode: 'live',
      selectionCode: '({tasks}) => tasks.filter(t => t.estimateMinutes <= 20).map(t => ({taskId:t.id,reason:"Fits now"}))',
    } });
    const second = await engine.applyAction({ type: 'create_task', task: { title: 'Short chore', estimateMinutes: 10 } });
    await engine.appendMessage({ role: 'assistant', text: 'Here is a temporary selection.', mode: 'demo' });
    const snapshot = await engine.getSnapshot();
    assert.deepEqual(snapshot.lists.find(list => list.id === temporary.id)?.entries.map(entry => entry.taskId), [first.id, second.id]);
    const disk = await StateStore.open(join(directory, 'tend.sqlite'));
    assert.deepEqual(disk.read<{ lists: Array<{ id: string }> }>()?.lists.map(list => list.id), [saved.id]);
    disk.close();
    await engine.close();
    engine = new Engine({ dataDir: directory, timezone: 'America/New_York' });
    await engine.init();
    const restored = await engine.getSnapshot();
    assert.equal(restored.lists.length, 1);
    assert.equal(restored.lists[0].id, saved.id);
    assert.equal(restored.tasks.length, 2);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('discarding an ephemeral list keeps tasks; explicitly saving it persists across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasksprig-promote-'));
  let engine = await fresh(directory);
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Keep this task' } });
    const discarded = await engine.applyAction({ type: 'create_list', list: { name: 'Temporary', ephemeral: true } });
    await engine.applyAction({ type: 'delete_list', id: discarded.id });
    assert.equal((await engine.getSnapshot()).tasks[0].id, task.id);
    const promoted = await engine.applyAction({ type: 'create_list', list: { name: 'Keep this selection', ephemeral: true } });
    await engine.applyAction({ type: 'update_list', id: promoted.id, patch: { ephemeral: false } });
    await engine.close();
    engine = new Engine({ dataDir: directory, timezone: 'America/New_York' });
    await engine.init();
    const snapshot = await engine.getSnapshot();
    assert.equal(snapshot.lists[0].id, promoted.id);
    assert.equal(snapshot.lists[0].ephemeral, false);
    assert.equal(snapshot.lists[0].entries[0].taskId, task.id);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('linking a routine promotes its temporary list only after successful validation', async () => {
  const engine = await fresh();
  try {
    const list = await engine.applyAction({ type: 'create_list', list: { name: 'Temporary priorities', ephemeral: true } });
    await assert.rejects(engine.applyAction({ type: 'create_routine', routine: {
      name: 'Broken routine', instructions: 'Review', trigger: { type: 'daily', time: '09:00', timezone: 'America/New_York' },
      listId: list.id, conditionCode: '() => ({wrong:true})',
    } }), /run: boolean/);
    assert.equal((await engine.getSnapshot()).lists[0].ephemeral, true);
    await engine.applyAction({ type: 'create_routine', routine: {
      name: 'Morning', instructions: 'Review', trigger: { type: 'daily', time: '09:00', timezone: 'America/New_York' }, listId: list.id,
    } });
    assert.equal((await engine.getSnapshot()).lists[0].ephemeral, false);
    await assert.rejects(engine.applyAction({ type: 'update_list', id: list.id, patch: { ephemeral: true } }), /must stay saved/);
  } finally { await engine.close(); }
});

test('completion undo survives restart, restores original selections and cancels queued callbacks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tasksprig-undo-'));
  let engine = await fresh(directory);
  try {
    const first = await engine.applyAction({ type: 'create_task', task: { title: 'First', notes: 'Keep these notes' } });
    const second = await engine.applyAction({ type: 'create_task', task: { title: 'Second' } });
    const saved = await engine.applyAction({ type: 'create_list', list: { name: 'Saved order', mode: 'snapshot' } });
    await engine.applyAction({ type: 'create_list', list: { name: 'Live order' } });
    await engine.applyAction({ type: 'create_routine', routine: {
      name: 'Completion callback', instructions: 'Reflect', trigger: { type: 'task_completed', taskId: first.id },
    } });
    await engine.applyAction({ type: 'complete_task', id: first.id });
    let snapshot = await engine.getSnapshot();
    assert.ok(snapshot.lists.every(list => list.entries[1].taskId === first.id && list.entries[1].completedAt === START));
    assert.equal(snapshot.evaluations.find(item => item.taskId === first.id)?.completed, true);
    const actualNow = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => actualNow() + 31_000);
    await engine.applyAction({ type: 'refresh_list', id: saved.id });
    assert.deepEqual((await engine.getSnapshot()).lists.find(list => list.id === saved.id)?.entries.map(entry => entry.taskId), [second.id]);
    await engine.close();
    engine = new Engine({ dataDir: directory, timezone: 'America/New_York' });
    await engine.init();
    await engine.applyAction({ type: 'update_task', id: first.id, patch: { notes: 'Keep this later edit too' } });
    await engine.applyAction({ type: 'uncomplete_task', id: first.id });
    let callbacks = 0;
    await engine.tick(async () => { callbacks++; return 'Unexpected'; });
    snapshot = await engine.getSnapshot();
    assert.equal(callbacks, 0);
    assert.ok(snapshot.lists.every(list => list.entries[0].taskId === first.id && !list.entries[0].completedAt));
    assert.equal(snapshot.tasks[0].status, 'open');
    assert.equal(snapshot.tasks[0].notes, 'Keep this later edit too');
    assert.deepEqual(snapshot.tasks[0].completionHistory, []);
    assert.equal(snapshot.tasks[0].lastCompletedAt, null);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recurring completion can be undone and a demo jump cannot bypass the real undo grace', async t => {
  const engine = await fresh();
  const actualNow = Date.now.bind(Date);
  let wallOffset = 0;
  t.mock.method(Date, 'now', () => actualNow() + wallOffset);
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Plants', recurring: true, behaviorCode: WEEKLY } });
    await engine.setClock(new Date(Date.parse(START) + 7 * DAY).toISOString());
    await engine.applyAction({ type: 'create_list', list: { name: 'Watering', completedClearCode: '() => true' } });
    const original = (await engine.getSnapshot()).evaluations[0];
    await engine.applyAction({ type: 'complete_task', id: task.id });
    let snapshot = await engine.getSnapshot();
    assert.equal(snapshot.evaluations[0].completed, true);
    assert.equal(snapshot.evaluations[0].nextDueAt, new Date(Date.parse(START) + 14 * DAY).toISOString());
    await engine.applyAction({ type: 'uncomplete_task', id: task.id });
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.evaluations[0].nextDueAt, original.nextDueAt);
    assert.equal(snapshot.evaluations[0].visible, true);
    assert.equal(snapshot.lists[0].entries[0].completedAt, undefined);
    assert.deepEqual(snapshot.tasks[0].completionHistory, []);
    await engine.applyAction({ type: 'complete_task', id: task.id });
    await engine.setClock(new Date(Date.parse(START) + 15 * DAY).toISOString());
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.evaluations[0].completed, true, 'a simulated week is not thirty real seconds');
    assert.ok(snapshot.lists[0].entries[0].completedAt);
    await assert.rejects(engine.applyAction({ type: 'complete_task', id: task.id }), /already completed/);
    wallOffset = 31_000;
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.evaluations[0].completed, false);
    assert.equal(snapshot.evaluations[0].visible, true);
    assert.equal(snapshot.lists[0].entries[0].taskId, task.id);
    assert.equal(snapshot.lists[0].entries[0].completedAt, undefined, 'old clear rules cannot remove a new open occurrence');
  } finally { await engine.close(); }
});

test('undo restores parent and child completion effects without reopening unrelated finished siblings', async () => {
  const engine = await fresh();
  try {
    const parent = await engine.applyAction({ type: 'create_task', task: { title: 'Project' } });
    const first = await engine.applyAction({ type: 'create_task', task: { title: 'First step', parentId: parent.id } });
    const second = await engine.applyAction({ type: 'create_task', task: { title: 'Second step', parentId: parent.id } });
    await engine.applyAction({ type: 'complete_task', id: first.id });
    await engine.applyAction({ type: 'complete_task', id: second.id });
    await engine.applyAction({ type: 'uncomplete_task', id: first.id });
    let tasks = (await engine.getSnapshot()).tasks;
    assert.equal(tasks.find(task => task.id === parent.id)?.status, 'open');
    assert.equal(tasks.find(task => task.id === first.id)?.status, 'open');
    assert.equal(tasks.find(task => task.id === second.id)?.status, 'done');
    await engine.applyAction({ type: 'complete_task', id: parent.id });
    await engine.applyAction({ type: 'uncomplete_task', id: parent.id });
    tasks = (await engine.getSnapshot()).tasks;
    assert.equal(tasks.find(task => task.id === first.id)?.status, 'open');
    assert.equal(tasks.find(task => task.id === second.id)?.status, 'done');
    assert.deepEqual(tasks.find(task => task.id === parent.id)?.completionHistory, []);
    await engine.applyAction({ type: 'complete_task', id: parent.id });
    await engine.applyAction({ type: 'drop_task', id: first.id });
    await engine.applyAction({ type: 'uncomplete_task', id: parent.id });
    assert.equal((await engine.getSnapshot()).tasks.find(task => task.id === first.id)?.status, 'dropped', 'a later explicit drop survives undoing the parent completion');
  } finally { await engine.close(); }
});

test('undo explains that callbacks already executed are not rolled back', async () => {
  const engine = await fresh();
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Finish' } });
    await engine.applyAction({ type: 'create_routine', routine: {
      name: 'After finish', instructions: 'Follow up', trigger: { type: 'task_completed', taskId: task.id },
    } });
    await engine.applyAction({ type: 'complete_task', id: task.id });
    await engine.tick(async () => {
      await engine.applyAction({ type: 'create_task', task: { title: 'Callback effect' } });
      return 'Added follow up';
    });
    const result = await engine.applyAction({ type: 'uncomplete_task', id: task.id });
    assert.match(result.message, /already ran were left unchanged/);
    assert.equal((await engine.getSnapshot()).tasks.length, 2);
    assert.equal((await engine.getSnapshot()).routineRuns[0].status, 'succeeded');
  } finally { await engine.close(); }
});

test('agent clear policies honor real grace, persist hidden membership, and keep history recoverable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tasksprig-cleared-'));
  let engine = await fresh(directory);
  const actualNow = Date.now.bind(Date);
  let wallOffset = 0;
  t.mock.method(Date, 'now', () => actualNow() + wallOffset);
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Quick chore', notes: 'Still saved underneath' } });
    const list = await engine.applyAction({ type: 'create_list', list: {
      name: 'Quick things', mode: 'live', completedClearCode: '() => true',
      selectionCode: '({tasks}) => tasks.map(t => ({taskId:t.id,reason:"Everything"}))',
    } });
    await engine.applyAction({ type: 'complete_task', id: task.id });
    await engine.setClock(new Date(Date.parse(START) + 31 * DAY).toISOString());
    assert.equal((await engine.getSnapshot()).lists[0].entries.length, 1);
    await engine.applyAction({ type: 'refresh_list', id: list.id, entries: [] });
    assert.equal((await engine.getSnapshot()).lists[0].entries.length, 1, 'explicit refresh also preserves real undo grace');
    wallOffset = 31_000;
    assert.equal((await engine.getSnapshot()).lists[0].entries.length, 0);
    assert.equal((await engine.getSnapshot()).lists[0].entries.length, 0, 'live selection cannot reinsert the cleared occurrence');
    await engine.close();
    engine = new Engine({ dataDir: directory, timezone: 'America/New_York' });
    let snapshot = await engine.getSnapshot();
    assert.equal(snapshot.lists[0].entries.length, 0);
    assert.equal(snapshot.tasks[0].notes, 'Still saved underneath');
    assert.deepEqual(snapshot.tasks[0].completionHistory, [START]);
    const history = await engine.applyAction({ type: 'create_list', list: {
      name: 'Completed history', mode: 'snapshot', completedClearCode: '() => true',
      selectionCode: '({tasks}) => tasks.filter(t => t.status === "done").map(t => ({taskId:t.id,reason:"Completed earlier"}))',
    } });
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.lists.find(item => item.id === history.id)?.entries[0].taskId, task.id);
    assert.equal(snapshot.lists.find(item => item.id === history.id)?.entries[0].completedAt, undefined);
    await engine.applyAction({ type: 'uncomplete_task', id: task.id });
    assert.equal((await engine.getSnapshot()).lists.find(item => item.id === list.id)?.entries[0].taskId, task.id);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('clear policy uses task-clock TTL and retains rows with a readable error when generated code fails', async t => {
  const engine = await fresh();
  const actualNow = Date.now.bind(Date);
  let wallOffset = 0;
  t.mock.method(Date, 'now', () => actualNow() + wallOffset);
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Action' } });
    await assert.rejects(engine.applyAction({ type: 'create_list', list: { name: 'Invalid rule', completedClearCode: '() => "yes"' } }), /boolean/);
    const ttl = await engine.applyAction({ type: 'create_list', list: { name: 'One hour', completedClearCode: '({now,completedAt}) => now - Date.parse(completedAt) >= 3600000' } });
    const broken = await engine.applyAction({ type: 'create_list', list: { name: 'Fail safely', completedClearCode: '({task}) => { if(task.status === "done") throw new Error("Please repair this rule"); return false; }' } });
    await engine.applyAction({ type: 'complete_task', id: task.id });
    wallOffset = 31_000;
    let snapshot = await engine.getSnapshot();
    assert.equal(snapshot.lists.find(list => list.id === ttl.id)?.entries.length, 1, 'wall grace passing does not advance the agent TTL');
    assert.equal(snapshot.lists.find(list => list.id === broken.id)?.entries.length, 1);
    assert.match(snapshot.lists.find(list => list.id === broken.id)?.error ?? '', /Completed items kept.*repair this rule/);
    await engine.setClock(new Date(Date.parse(START) + 3600000).toISOString());
    snapshot = await engine.getSnapshot();
    assert.equal(snapshot.lists.find(list => list.id === ttl.id)?.entries.length, 0);
    assert.equal(snapshot.lists.find(list => list.id === broken.id)?.entries.length, 1);
  } finally { await engine.close(); }
});

test('display fields are bounded and unique; tags normalize while legacy category snippets keep working', async () => {
  const engine = await fresh();
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Chore', tags: [' Home ', 'home', 'Quick'], category: 'Ignored' } });
    assert.deepEqual((await engine.getSnapshot()).tasks[0].tags, ['Home', 'Quick']);
    assert.equal((await engine.getSnapshot()).tasks[0].category, 'Home');
    const list = await engine.applyAction({ type: 'create_list', list: {
      name: 'Home', displayFields: ['tags', 'estimateMinutes'], selectionCode: '({tasks}) => tasks.filter(t => t.category === "Home").map(t => ({taskId:t.id,reason:"At home"}))',
    } });
    assert.equal((await engine.getSnapshot()).lists[0].entries[0].taskId, task.id);
    for (const fields of [[], ['reason', 'reason'], ['reason', 'dueAt', 'tags'], ['category']]) {
      await assert.rejects(engine.applyAction({ type: 'update_list', id: list.id, patch: { displayFields: fields as never } }), /one or two unique/);
    }
    await engine.applyAction({ type: 'update_task', id: task.id, patch: { category: 'Work' } });
    assert.deepEqual((await engine.getSnapshot()).tasks[0].tags, ['Work']);
    await engine.applyAction({ type: 'update_task', id: task.id, patch: { tags: [] } });
    assert.equal((await engine.getSnapshot()).tasks[0].category, '');
    await assert.rejects(engine.applyAction({ type: 'update_task', id: task.id, patch: { tags: Array.from({ length: 13 }, (_, i) => `tag${i}`) } }), /twelve/);
    await assert.rejects(engine.applyAction({ type: 'update_task', id: task.id, patch: { tags: ['a'.repeat(81)] } }), /80/);
    const defaultList = await engine.applyAction({ type: 'create_list', list: { name: 'Defaults' } });
    assert.deepEqual((await engine.getSnapshot()).lists.find(item => item.id === defaultList.id)?.displayFields, ['reason']);
  } finally { await engine.close(); }
});

test('existing category data migrates to tags and old list fields receive compatible defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasksprig-migrate-'));
  let engine = await fresh(directory);
  try {
    await engine.applyAction({ type: 'create_task', task: { title: 'Existing task', category: 'Home' } });
    await engine.applyAction({ type: 'create_list', list: { name: 'Existing list' } });
    await engine.close();
    const store = await StateStore.open(join(directory, 'tend.sqlite'));
    const state = store.read<{ tasks: Array<{ tags?: string[] }>; lists: Array<{ displayFields?: string[]; completedClearCode?: string }> }>()!;
    delete state.tasks[0].tags;
    state.lists[0].displayFields = ['category'];
    delete state.lists[0].completedClearCode;
    store.write(state); store.close();
    engine = new Engine({ dataDir: directory, timezone: 'America/New_York' });
    const snapshot = await engine.getSnapshot();
    assert.deepEqual(snapshot.tasks[0].tags, ['Home']);
    assert.deepEqual(snapshot.lists[0].displayFields, ['tags']);
    assert.equal(snapshot.lists[0].completedClearCode, '');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recurring behaviors without calendar dates become actionable again when their visibility changes', async t => {
  const engine = await fresh();
  const actualNow = Date.now.bind(Date);
  let wallOffset = 0;
  t.mock.method(Date, 'now', () => actualNow() + wallOffset);
  try {
    const task = await engine.applyAction({ type: 'create_task', task: {
      title: 'Flexible recurrence', recurring: true,
      behaviorCode: '({task,now}) => ({visible: !task.lastCompletedAt || now-Date.parse(task.lastCompletedAt)>=86400000,urgency:40,reason:"Check daily"})',
    } });
    await engine.applyAction({ type: 'complete_task', id: task.id });
    wallOffset = 31_000;
    assert.equal((await engine.getSnapshot()).evaluations[0].completed, true);
    await engine.setClock(new Date(Date.parse(START) + DAY).toISOString());
    assert.equal((await engine.getSnapshot()).evaluations[0].completed, false);
    assert.equal((await engine.getSnapshot()).evaluations[0].visible, true);
    await engine.applyAction({ type: 'complete_task', id: task.id });
    assert.equal((await engine.getSnapshot()).tasks[0].completionHistory.length, 2);
  } finally { await engine.close(); }
});

test('empty history stays empty, tag reordering preserves legacy selection, and undo retains a later snooze', async () => {
  const engine = await fresh();
  try {
    const task = await engine.applyAction({ type: 'create_task', task: { title: 'Plants', category: 'Home', recurring: true, behaviorCode: WEEKLY } });
    const history = await engine.applyAction({ type: 'create_list', list: { name: 'No completions yet', mode: 'snapshot', entries: [] } });
    assert.deepEqual((await engine.getSnapshot()).lists.find(list => list.id === history.id)?.entries, []);
    await engine.applyAction({ type: 'update_task', id: task.id, patch: { tags: ['Plants', 'Home'] } });
    assert.deepEqual((await engine.getSnapshot()).tasks[0].tags, ['Plants', 'Home']);
    assert.equal((await engine.getSnapshot()).tasks[0].category, 'Home');
    await engine.applyAction({ type: 'complete_task', id: task.id });
    const until = '2026-11-02T12:30:00.000Z';
    await engine.applyAction({ type: 'snooze_task', id: task.id, until });
    await engine.applyAction({ type: 'update_task', id: task.id, patch: { notes: 'A newer note' } });
    await engine.applyAction({ type: 'uncomplete_task', id: task.id });
    const snapshot = await engine.getSnapshot();
    assert.equal(snapshot.tasks[0].snoozedUntil, until);
    assert.equal(snapshot.tasks[0].notes, 'A newer note');
    assert.deepEqual(snapshot.tasks[0].completionHistory, []);
  } finally { await engine.close(); }
});
