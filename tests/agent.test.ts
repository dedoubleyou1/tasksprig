import test from 'node:test';
import assert from 'node:assert/strict';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, validateToolArguments, type AssistantMessage } from '@earendil-works/pi-ai';
import { createModelAdapter, type ModelAdapter } from '../src/main/agent/providers';
import { createAgentTools } from '../src/main/agent/tools';
import { runDemo } from '../src/main/agent/demo';
import { runLiveAgent } from '../src/main/agent/index';
import { artifactIntent } from '../src/main/agent/intent';
import type { Action, Routine, Snapshot, TaskList } from '../src/shared/types';
import { Engine } from '../src/main/engine/index';
import { intervalUpkeep } from '../src/shared/behaviors';
import { formatAgentError } from '../src/main/agent/errors';

test('provider adapter uses OpenAI Responses and Gemma 4 with supported thinking settings', () => {
  const openai = createModelAdapter({ provider: 'openai', model: '', apiKey: 'test-only-not-a-real-key' });
  assert.equal(openai.model.api, 'openai-responses');
  assert.equal(openai.model.id, 'gpt-5.4-mini');
  assert.equal(openai.thinkingLevel, 'low');
  const gemma = createModelAdapter({ provider: 'google', model: '', apiKey: 'test-only-not-a-real-key' });
  assert.equal(gemma.model.id, 'gemma-4-26b-a4b-it');
  assert.equal(gemma.model.api, 'google-generative-ai');
  assert.equal(gemma.thinkingLevel, 'minimal');
  assert.throws(() => createModelAdapter({ provider: 'openai', model: '', apiKey: '  ' }), /API key/);
});

test('Pi validates custom application tool inputs before any mutation', async () => {
  let mutations = 0;
  const tools = createAgentTools(async () => { mutations++; return { id: 'saved-task', message: 'Saved' }; });
  const create = tools.find(tool => tool.name === 'create_task')!;
  const parse = (args: Record<string, unknown>) => validateToolArguments(create, { type: 'toolCall', id: 'test-call', name: create.name, arguments: args as never });
  assert.throws(() => parse({ title: 'Water plants', importance: 101 }));
  assert.throws(() => parse({ title: 'Water plants', estimateMinutes: -10 }));
  assert.throws(() => parse({ title: 'Water plants', shell: 'rm anything' }));
  assert.throws(() => parse({ title: 'Water plants', behaviorCode: 'x'.repeat(32001) }));
  assert.throws(() => parse({ title: 'Water plants', category: 'Home' }), 'new model tools expose tags, not the legacy category alias');
  assert.throws(() => parse({ title: 'Water plants', tags: Array.from({ length: 13 }, (_, i) => `Tag ${i}`) }));
  assert.throws(() => parse({ title: 'Water plants', tags: ['a'.repeat(81)] }));
  assert.equal(mutations, 0);
  const valid = parse({ title: 'Water plants', estimateMinutes: 5, importance: 40, tags: ['Home', 'Plants'] });
  assert.deepEqual(valid.tags, ['Home', 'Plants']);
  const result = await create.execute('test-call', valid);
  assert.equal(result.details.id, 'saved-task');
  assert.equal(mutations, 1);
  const cancelled = AbortSignal.abort();
  await assert.rejects(() => create.execute('cancelled', valid, cancelled), /cancelled/);
  assert.equal(mutations, 1);
});

const emptySnapshot: Snapshot = {
  tasks: [], evaluations: [], lists: [], routines: [], routineRuns: [], activity: [], messages: [],
  now: '2026-10-21T16:00:00.000Z', simulated: true, timezone: 'America/New_York',
};

test('offline demo understands plural and written minute windows from conversational requests', async () => {
  for (const text of ['I have 20 minutes. What can I do?', 'I have 20 mins', 'What can I do in twenty minutes?', 'Make a 20-minute list']) {
    const actions: Action[] = [];
    const answer = await runDemo(text, emptySnapshot, async action => { actions.push(action); return { id: 'new-list', message: 'Saved' }; });
    assert.match(answer, /^Demo mode/);
    assert.equal(actions.length, 1, text);
    assert.equal(actions[0].type, 'create_list', text);
    if (actions[0].type === 'create_list') {
      assert.equal(actions[0].list.name, '20-minute window', text);
      assert.equal(actions[0].list.ephemeral, true, text);
      assert.deepEqual(actions[0].list.displayFields, ['estimateMinutes'], text);
      assert.match(actions[0].list.completedClearCode!, /60000/);
    }
  }
});

test('offline demo accepts ordinary medicine cadence wording without inferring unsupported schedules', async () => {
  for (const [text, period] of [
    ['I take my medicines daily', 'daily'],
    ['I take shots once a week', 'weekly'],
    ['Give the dog medicines each month', 'monthly'],
  ]) {
    const actions: Action[] = [];
    await runDemo(text, emptySnapshot, async action => { actions.push(action); return { id: 'new-task', message: 'Saved' }; });
    assert.equal(actions[0]?.type, 'create_task', text);
    if (actions[0]?.type === 'create_task') assert.match(actions[0].task.behaviorExplanation!, new RegExp(`Fixed ${period} reminder`));
  }
  let mutations = 0;
  const answer = await runDemo('I take medicine every 2 weeks', emptySnapshot, async () => { mutations++; return { id: 'bad', message: 'Saved' }; });
  assert.equal(mutations, 0);
  assert.match(answer, /schedule/);
});

test('artifact intent distinguishes task selections from app questions and optional conversation', () => {
  for (const request of ['What can I do in 20 minutes?', 'Pick three things every morning', 'Show my overdue tasks', 'I need a list for my trip', 'Show what I finished this morning', 'Bring back completed items', 'What did I finish today?']) {
    assert.equal(artifactIntent(request).list, true, request);
  }
  assert.equal(artifactIntent('Pick three priorities every morning').routine, true);
  for (const request of ['What can I do to change settings?', 'How do lists work?', 'Explain how you choose priorities', 'I watered the plants', 'Thanks!', 'How long will watering take?']) {
    assert.equal(artifactIntent(request).list, false, request);
  }
});

function scriptedAdapter(responses: AssistantMessage[]): { adapter: ModelAdapter; calls: () => number } {
  const faux = createFauxCore({ provider: 'agent-tests', models: [{ id: 'scripted' }] });
  faux.setResponses(responses);
  return { adapter: { model: faux.getModel(), streamFn: faux.streamSimple, thinkingLevel: 'off', getApiKey: () => '' }, calls: () => faux.state.callCount };
}

test('live harness repairs a prose-only task recommendation into a persisted list', async () => {
  const scripted = scriptedAdapter([
    fauxAssistantMessage('You could water the plants or draft an outline.'),
    fauxAssistantMessage(fauxToolCall('create_list', { name: '20-minute window', mode: 'snapshot', ephemeral: true, displayFields: ['estimateMinutes'], completedClearCode: '', entries: [] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Saved your 20-minute window list.'),
  ]);
  const actions: Action[] = [];
  const answer = await runLiveAgent('What can I do in 20 minutes?', emptySnapshot, scripted.adapter, async action => { actions.push(action); return { id: 'saved-list', message: 'Saved' }; });
  assert.equal(actions[0]?.type, 'create_list');
  assert.equal(actions[0]?.type === 'create_list' && actions[0].list.ephemeral, true, 'a temporary list fulfills the UI artifact requirement');
  assert.match(answer, /Saved/);
  assert.equal(scripted.calls(), 3, 'one initial response, one repair tool call, one confirmation');
});

test('live harness accepts an updated existing list without a redundant repair', async () => {
  const scripted = scriptedAdapter([
    fauxAssistantMessage(fauxToolCall('refresh_list', { id: 'existing-list', entries: [] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Here are the tasks that fit.'),
  ]);
  const actions: Action[] = [];
  await runLiveAgent('What can I do in 20 minutes?', emptySnapshot, scripted.adapter, async action => { actions.push(action); return { id: 'existing-list', message: 'Refreshed' }; });
  assert.equal(actions.length, 1);
  assert.equal(scripted.calls(), 2);
});

test('opening an existing list uses navigation without requiring an artificial mutation', async () => {
  const scripted = scriptedAdapter([
    fauxAssistantMessage(fauxToolCall('show_list', { id: 'existing-list' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Opened your 20-minute window list.'),
  ]);
  const actions: Action[] = [];
  await runLiveAgent('Show me my 20-minute window list', emptySnapshot, scripted.adapter, async action => { actions.push(action); return { id: 'existing-list', message: 'Opened' }; });
  assert.deepEqual(actions.map(action => action.type), ['show_list']);
  assert.equal(scripted.calls(), 2);
});

test('live harness reports failure after one unsuccessful repair instead of claiming a saved list', async () => {
  const scripted = scriptedAdapter([fauxAssistantMessage('Do these three things.'), fauxAssistantMessage('Would you like me to save them?')]);
  await assert.rejects(() => runLiveAgent('Pick three priorities', emptySnapshot, scripted.adapter, async () => ({ id: 'none', message: 'unused' })), /without completing the requested result in the app/);
  assert.equal(scripted.calls(), 2);
});

test('live harness allows genuinely necessary clarification and ordinary app questions', async () => {
  const question = scriptedAdapter([fauxAssistantMessage(fauxToolCall('request_clarification', { question: 'Which trip is this for?', whyNeeded: 'There are two different trips with different preparation needs.' }), { stopReason: 'toolUse' })]);
  assert.equal(await runLiveAgent('Make a list for my trip', emptySnapshot, question.adapter, async () => ({ id: 'unused', message: 'unused' })), 'Which trip is this for?');
  assert.equal(question.calls(), 1);
  const app = scriptedAdapter([fauxAssistantMessage('Open Model settings to change it.')]);
  assert.match(await runLiveAgent('What can I do to change settings?', emptySnapshot, app.adapter, async () => ({ id: 'unused', message: 'unused' })), /settings/);
  assert.equal(app.calls(), 1);
});

test('linked routine execution must refresh its actual list, not a different one', async () => {
  const routine: Routine = { id: 'routine', name: 'Morning priorities', instructions: 'Pick three priorities', trigger: { type: 'daily', time: '09:00', timezone: 'America/New_York' }, enabled: true, listId: 'linked-list', conditionCode: '', createdAt: emptySnapshot.now, updatedAt: emptySnapshot.now, lastRunAt: null, nextRunAt: null };
  const scripted = scriptedAdapter([
    fauxAssistantMessage(fauxToolCall('refresh_list', { id: 'different-list', entries: [] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage(fauxToolCall('refresh_list', { id: 'linked-list', entries: [] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Updated morning priorities.'),
  ]);
  const actions: Action[] = [];
  await runLiveAgent(routine.instructions, emptySnapshot, scripted.adapter, async action => { actions.push(action); return { id: 'list', message: 'Saved' }; }, { routine });
  assert.equal(actions.length, 2);
  assert.equal(actions[1].type === 'refresh_list' && actions[1].id, 'linked-list');
});

test('recurring priority requests save both the custom list and its routine', async () => {
  const scripted = scriptedAdapter([
    fauxAssistantMessage(fauxToolCall('create_list', { name: 'Morning priorities', mode: 'snapshot', ephemeral: false, displayFields: ['dueAt', 'reason'], completedClearCode: '', entries: [] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Created your list.'),
    fauxAssistantMessage(fauxToolCall('create_routine', { name: 'Morning priorities', instructions: 'Pick three priorities', listId: 'saved-list', trigger: { type: 'daily', time: '09:00', timezone: 'America/New_York' } }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Saved the list and daily routine.'),
  ]);
  const actions: Action[] = [];
  await runLiveAgent('Pick three priorities every morning', emptySnapshot, scripted.adapter, async action => { actions.push(action); return { id: 'saved-list', message: 'Saved' }; });
  assert.deepEqual(actions.map(action => action.type), ['create_list', 'create_routine']);
});

test('repeated offline time-window requests update the existing list', async () => {
  const list: TaskList = { id: 'existing', name: '20-minute window', mode: 'live', ephemeral: true, displayFields: ['reason'], completedClearCode: '', description: '', instructions: '', selectionCode: '', entries: [], createdAt: emptySnapshot.now, updatedAt: emptySnapshot.now, lastRefreshedAt: null };
  const actions: Action[] = [];
  await runDemo('I have 20 minutes', { ...emptySnapshot, lists: [list] }, async action => { actions.push(action); return { id: list.id, message: 'Updated' }; });
  assert.deepEqual(actions.map(action => action.type), ['update_list']);
  assert.deepEqual(actions[0].type === 'update_list' && actions[0].patch.displayFields, ['reason'], 'ordinary refresh preserves the list presentation');
  assert.equal(actions[0].type === 'update_list' && actions[0].patch.completedClearCode, '', 'ordinary refresh preserves clearing behavior');
});

test('list tools require explicit lifetime, concise display fields and completed clearing behavior', () => {
  const tools = createAgentTools(async () => ({ id: 'list', message: 'Saved' }));
  const create = tools.find(tool => tool.name === 'create_list')!;
  const update = tools.find(tool => tool.name === 'update_list')!;
  assert.throws(() => validateToolArguments(create, fauxToolCall('create_list', { name: 'Quick selection' })));
  const valid = { name: 'Quick selection', ephemeral: true, displayFields: ['estimateMinutes'], completedClearCode: '' };
  assert.equal(validateToolArguments(create, fauxToolCall('create_list', valid)).ephemeral, true);
  assert.equal(validateToolArguments(create, fauxToolCall('create_list', { ...valid, name: 'Trip preparation', ephemeral: false, displayFields: ['dueAt', 'reason'] })).ephemeral, false);
  const { displayFields: _fields, ...missingFields } = valid;
  const { completedClearCode: _clear, ...missingClear } = valid;
  assert.throws(() => validateToolArguments(create, fauxToolCall('create_list', missingFields)));
  assert.throws(() => validateToolArguments(create, fauxToolCall('create_list', missingClear)));
  for (const displayFields of [[], ['reason', 'reason'], ['estimateMinutes', 'dueAt', 'tags'], ['importance'], ['category']]) {
    assert.throws(() => validateToolArguments(create, fauxToolCall('create_list', { ...valid, displayFields })));
    assert.throws(() => validateToolArguments(update, fauxToolCall('update_list', { id: 'list', patch: { displayFields } })));
  }
  assert.equal(validateToolArguments(update, fauxToolCall('update_list', { id: 'list', patch: { ephemeral: false } })).patch.ephemeral, false);
  assert.deepEqual(validateToolArguments(update, fauxToolCall('update_list', { id: 'list', patch: { displayFields: ['tags'] } })).patch.displayFields, ['tags']);
});

test('ad-hoc demo selections do not overwrite permanent lists; explicit keep requests persist', async () => {
  const saved: TaskList = { id: 'saved', name: '20-minute window', mode: 'live', ephemeral: false, displayFields: ['estimateMinutes'], completedClearCode: '', description: '', instructions: '', selectionCode: '', entries: [], createdAt: emptySnapshot.now, updatedAt: emptySnapshot.now, lastRefreshedAt: null };
  const actions: Action[] = [];
  await runDemo('What can I do in 20 minutes?', { ...emptySnapshot, lists: [saved] }, async action => { actions.push(action); return { id: 'temporary', message: 'Created' }; });
  assert.equal(actions[0].type, 'create_list');
  assert.equal(actions[0].type === 'create_list' && actions[0].list.ephemeral, true);
  actions.length = 0;
  await runDemo('Create and keep a 20-minute list', emptySnapshot, async action => { actions.push(action); return { id: 'saved', message: 'Saved' }; });
  assert.equal(actions[0].type === 'create_list' && actions[0].list.ephemeral, false);
});

test('demo save-this and make-this-temporary requests target the active list without duplication', async () => {
  const list: TaskList = { id: 'active', name: 'Quick selection', mode: 'snapshot', ephemeral: true, displayFields: ['reason'], completedClearCode: '', description: '', instructions: '', selectionCode: '', entries: [], createdAt: emptySnapshot.now, updatedAt: emptySnapshot.now, lastRefreshedAt: null };
  const actions: Action[] = [];
  const apply = async (action: Action) => { actions.push(action); return { id: 'active', message: 'Updated' }; };
  await runDemo('Keep this list', { ...emptySnapshot, lists: [list] }, apply, { activeListId: 'active' });
  await runDemo('Make this temporary', { ...emptySnapshot, lists: [{ ...list, ephemeral: false }] }, apply, { activeListId: 'active' });
  assert.deepEqual(actions, [
    { type: 'update_list', id: 'active', patch: { ephemeral: false } },
    { type: 'update_list', id: 'active', patch: { ephemeral: true } },
  ]);
});

test('history requests surface existing completed tasks and undo uses the scoped completion tool', async () => {
  const engine = new Engine({ dataDir: ':memory:', timezone: 'America/New_York' });
  try {
    await engine.init();
    await engine.setClock('2026-10-20T13:00:00.000Z');
    const yesterday = await engine.applyAction({ type: 'create_task', task: { title: 'Yesterday task', tags: ['Home'] } });
    await engine.applyAction({ type: 'complete_task', id: yesterday.id });
    await engine.setClock('2026-10-21T13:00:00.000Z');
    const today = await engine.applyAction({ type: 'create_task', task: { title: 'Morning task', tags: ['Home', 'Errands'] } });
    await engine.applyAction({ type: 'complete_task', id: today.id });
    await engine.setClock(emptySnapshot.now);
    const before = await engine.getSnapshot();
    await runDemo('Show what I finished this morning', before, action => engine.applyAction(action));
    const after = await engine.getSnapshot();
    assert.equal(after.tasks.length, 2, 'history never recreates completed tasks');
    assert.equal(after.tasks.find(task => task.id === today.id)?.status, 'done', 'showing history does not reopen tasks');
    const history = after.lists.find(list => list.name === 'Finished this morning')!;
    assert.equal(history.ephemeral, true);
    assert.equal(history.completedClearCode, '');
    assert.deepEqual(history.displayFields, ['reason']);
    assert.deepEqual(history.entries.map(entry => entry.taskId), [today.id]);
    const tools = createAgentTools(action => engine.applyAction(action), () => engine.getSnapshot());
    const read = tools.find(tool => tool.name === 'read_snapshot')!;
    const context = await read.execute('read-tags', {});
    const content = context.content.find(item => item.type === 'text');
    assert.ok(content && content.type === 'text');
    const exposed = JSON.parse(content.text).tasks;
    assert.deepEqual(exposed.find((task: { id: string }) => task.id === today.id).tags, ['Home', 'Errands']);
    assert.ok(exposed.every((task: object) => !Object.hasOwn(task, 'category')), 'legacy category is omitted from model context');
    const undo = tools.find(tool => tool.name === 'uncomplete_task')!;
    await undo.execute('undo-completion', validateToolArguments(undo, fauxToolCall('uncomplete_task', { id: today.id })));
    const restored = (await engine.getSnapshot()).tasks.find(task => task.id === today.id)!;
    assert.equal(restored.status, 'open');
    assert.equal(restored.lastCompletedAt, null);
    assert.deepEqual(restored.completionHistory, []);
  } finally { await engine.close(); }
});

test('live harness repairs a prose-only completed-history request into a review list', async () => {
  const scripted = scriptedAdapter([
    fauxAssistantMessage('You completed your morning tasks.'),
    fauxAssistantMessage(fauxToolCall('create_list', { name: 'Completed this morning', mode: 'snapshot', ephemeral: true, displayFields: ['reason'], completedClearCode: '', entries: [] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Opened your completed items for review.'),
  ]);
  const actions: Action[] = [];
  await runLiveAgent('Show what I finished this morning', emptySnapshot, scripted.adapter, async action => { actions.push(action); return { id: 'history', message: 'Saved' }; });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'create_list');
  assert.equal(scripted.calls(), 3);
});

test('recurring creation and conversion require authored timing instead of the generic engine default', async () => {
  const engine = new Engine({ dataDir: ':memory:', timezone: 'America/New_York' });
  try {
    await engine.init();
    const tools = createAgentTools(action => engine.applyAction(action), () => engine.getSnapshot());
    const create = tools.find(tool => tool.name === 'create_task')!;
    const update = tools.find(tool => tool.name === 'update_task')!;
    await assert.rejects(() => create.execute('missing-code', { title: 'Recurring upkeep', recurring: true }), /requires explicit behaviorCode and behaviorExplanation/);
    await assert.rejects(() => create.execute('missing-explanation', { title: 'Recurring upkeep', recurring: true, behaviorCode: intervalUpkeep(42) }), /requires explicit/);
    assert.equal((await engine.getSnapshot()).tasks.length, 0, 'invalid recurrence never persists with the generic visible default');
    const original = await engine.applyAction({ type: 'create_task', task: { title: 'Replace an air filter' } });
    await assert.rejects(() => update.execute('convert-without-code', { id: original.id, patch: { recurring: true } }), /requires explicit/);
    assert.equal((await engine.getSnapshot()).tasks[0].recurring, false);
    await update.execute('valid-conversion', { id: original.id, patch: { recurring: true, behaviorCode: intervalUpkeep(42), behaviorExplanation: 'Quiet until 42 days after capture or actual completion.' } });
    const saved = await engine.getSnapshot();
    assert.equal(saved.tasks[0].recurring, true);
    assert.equal(saved.evaluations[0].visible, false);
    await update.execute('ordinary-estimate-correction', { id: original.id, patch: { recurring: true, estimateMinutes: 10 } });
    assert.equal((await engine.getSnapshot()).tasks[0].estimateMinutes, 10, 'editing an already recurring task preserves its authored code');
  } finally { await engine.close(); }
});

const googleQuotaError = JSON.stringify({ error: { code: 429, message: JSON.stringify({ error: {
  code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota. Quota exceeded for metric generate_content_free_tier_input_token_count, limit: 16000, model: gemma-4-26b-a4b-it. Please retry in 44.2s.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '44s' }],
} }) } });

test('nested provider errors become readable quota, billing and authentication messages without raw JSON', () => {
  const quota = formatAgentError(new Error(googleQuotaError), 'google');
  assert.match(quota, /Google's input-token allowance/);
  assert.match(quota, /about 4[45] seconds/);
  assert.doesNotMatch(quota, /[{}]|RESOURCE_EXHAUSTED|generate_content|billing/);
  const billing = formatAgentError(JSON.stringify({ error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } }), 'openai');
  assert.match(billing, /OpenAI.*API credits or billing quota/);
  const key = 'sk-example-secret-for-test-only';
  const auth = formatAgentError(JSON.stringify({ error: { code: 'invalid_api_key', message: `Incorrect API key: ${key}` } }), 'openai', key);
  assert.match(auth, /could not authenticate/);
  assert.ok(!auth.includes(key));
  const unknown = formatAgentError(JSON.stringify({ error: { message: `Unrecognized issue; authorization: Bearer ${key}` } }), 'google', key);
  assert.doesNotMatch(unknown, /[{}]|Bearer|sk-example/);
  assert.match(unknown, /could not complete the request/);
  assert.match(formatAgentError('429 rate_limit_exceeded', 'anthropic'), /Anthropic's request limit.*wait for the limit to reset/);
});

test('formatted provider failures retain an accurate partial-change note', async () => {
  const scripted = scriptedAdapter([
    fauxAssistantMessage(fauxToolCall('create_task', { title: 'Call the fictional gardener', estimateMinutes: 5 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: googleQuotaError }),
  ]);
  scripted.adapter.model.provider = 'google';
  await assert.rejects(
    () => runLiveAgent('Remember to call the fictional gardener', emptySnapshot, scripted.adapter, async () => ({ id: 'saved-task', message: 'Saved' })),
    (error: Error) => {
      assert.match(error.message, /Google's input-token allowance/);
      assert.match(error.message, /1 change was saved before the interruption/);
      assert.doesNotMatch(error.message, /[{}]|RESOURCE_EXHAUSTED/);
      return true;
    },
  );
});
