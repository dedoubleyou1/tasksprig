import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataDir = await mkdtemp(join(tmpdir(), 'tasksprig-desktop-smoke-'));
await mkdir('artifacts', { recursive: true });
let desktop;
const errors = [];
async function launch() {
  desktop = await electron.launch({
    ...(process.env.TASKSPRIG_EXECUTABLE_PATH ? { executablePath: process.env.TASKSPRIG_EXECUTABLE_PATH, args: [] } : { args: ['.'] }),
    env: { ...process.env, TASKSPRIG_DATA_DIR: dataDir }, timeout: 30000,
  });
  const page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Menu', exact: true }).waitFor();
  return page;
}
async function ask(page, text) {
  await page.getByLabel('Tell TaskSprig what you need').fill(text);
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForFunction(() => !document.querySelector('.thinking'));
  const error = await page.locator('.chat-error').allTextContents();
  assert.equal(error.length, 0, error.join('\n'));
}
async function openPanel(page, name) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
try {
  let page = await launch();
  const initial = await page.evaluate(() => window.tasksprig.snapshot());
  assert.ok(initial.tasks.length > 0);
  await page.screenshot({ path: 'artifacts/desktop-initial.png' });
  await ask(page, 'I have 20 minutes. What can I do?');
  await page.getByRole('heading', { name: '20-minute window', exact: true }).waitFor();
  let state = await page.evaluate(() => window.tasksprig.snapshot());
  let quickList = state.lists.find(list => list.name === '20-minute window');
  assert.ok(quickList);
  assert.equal(quickList.ephemeral, true);
  const total = quickList.entries.reduce((sum, entry) => sum + state.tasks.find(task => task.id === entry.taskId).estimateMinutes, 0);
  assert.ok(total <= 20);
  assert.equal(await page.getByLabel('Choose list', { exact: true }).inputValue(), quickList.id, 'new list opens automatically');
  // Repeating the request updates the same list and must bring it back into view.
  await ask(page, 'What can I do in 20 minutes?');
  assert.equal(await page.getByLabel('Choose list', { exact: true }).inputValue(), quickList.id, 'existing updated list opens automatically');
  await page.getByLabel('Choose list', { exact: true }).selectOption('all');
  await page.waitForFunction(async id => !(await window.tasksprig.snapshot()).lists.some(list => list.id === id), quickList.id);
  assert.equal((await page.evaluate(() => window.tasksprig.snapshot())).tasks.length, initial.tasks.length, 'dismissing a temporary list keeps its tasks');
  await ask(page, 'What can I do in 20 minutes?');
  state = await page.evaluate(() => window.tasksprig.snapshot());
  quickList = state.lists.find(list => list.name === '20-minute window');
  await ask(page, 'Keep this list');
  state = await page.evaluate(() => window.tasksprig.snapshot());
  assert.equal(state.lists.find(list => list.id === quickList.id).ephemeral, false, 'natural-language request saves the selected list');
  await ask(page, 'What can I do in 20 minutes?');
  state = await page.evaluate(() => window.tasksprig.snapshot());
  assert.ok(state.lists.some(list => list.ephemeral && list.id !== quickList.id), 'an ad hoc request does not overwrite the saved selection');
  await ask(page, 'Pick three priorities every morning');
  assert.equal((await page.evaluate(() => window.tasksprig.snapshot())).lists.some(list => list.ephemeral), false, 'a new request clears the previous temporary selection');
  await ask(page, 'Pick three priorities every morning at 7');
  await page.locator('.list-description').filter({ hasText: '7:00 AM' }).waitFor();
  assert.equal((await page.locator('.list-description').innerText()).includes('9:00'), false, 'schedule label follows the actual routine');
  await openPanel(page, 'Demo controls');
  await page.getByRole('button', { name: 'Next morning' }).click();
  await page.waitForFunction(async () => (await window.tasksprig.snapshot()).routineRuns.some(run => run.status === 'succeeded'));
  state = await page.evaluate(() => window.tasksprig.snapshot());
  assert.ok(state.routines.some(r => r.name === 'Morning priorities'));
  const successes = state.routineRuns.filter(r => r.status === 'succeeded').length;
  assert.ok(successes > 0);
  const callbackMessages = state.messages.filter(m => m.text.startsWith('Morning priorities\n\n'));
  assert.equal(callbackMessages.length, successes, 'one chat message per callback');
  await page.getByRole('button', { name: 'Close Demo controls', exact: true }).click();
  const priorities = state.lists.find(list => list.name === 'Morning priorities');
  await page.getByLabel('Choose list', { exact: true }).selectOption(priorities.id);
  await page.screenshot({ path: 'artifacts/desktop-priorities.png' });
  assert.ok(priorities.entries.length <= 3);
  if (priorities.entries.length) {
    const task = state.tasks.find(t => t.id === priorities.entries[0].taskId);
    await page.getByRole('checkbox', { name: task.title, exact: true }).click();
    await page.waitForFunction(async ({ id }) => {
      const task = (await window.tasksprig.snapshot()).tasks.find(t => t.id === id);
      return task.status === 'done' || task.completionHistory.length > 0;
    }, { id: task.id });
  }
  // Verify reversible completion and list-specific fields in an isolated live list.
  const uiFixtures = await page.evaluate(async () => {
    const now = (await window.tasksprig.snapshot()).now;
    for (const [index, title] of ['Smoke one-off task', 'Smoke recurring task', 'Smoke third task', 'Smoke fourth task', 'Smoke fifth task'].entries()) {
      await window.tasksprig.act({ type: 'create_task', task: {
        title, tags: index === 0 ? ['Home', 'Plants'] : ['Home'], originalRequest: 'Smoke interface fixture', estimateMinutes: 7 + index, dueAt: now,
        notes: index === 0 ? 'A plain note for the expanded task.' : '', recurring: index === 1,
        ...(index === 1 ? { behaviorCode: `ctx => { const due = ctx.task.lastCompletedAt ? Date.parse(ctx.task.lastCompletedAt) + 7 * 86400000 : Date.parse(ctx.task.dueAt); return { visible: ctx.now >= due, urgency: 50, reason: "A weekly test occurrence", nextDueAt: new Date(due).toISOString() }; }` } : {}),
      } });
    }
    let snapshot = await window.tasksprig.snapshot();
    const oneOff = snapshot.tasks.find(task => task.title === 'Smoke one-off task');
    const recurring = snapshot.tasks.find(task => task.title === 'Smoke recurring task');
    await window.tasksprig.act({ type: 'create_task', task: { title: 'Smoke plain-text subtask', parentId: oneOff.id, estimateMinutes: 2 } });
    await window.tasksprig.act({ type: 'create_list', list: {
      name: 'UI completion check', mode: 'live', displayFields: ['reason'],
      selectionCode: 'ctx => ctx.tasks.filter(task => task.originalRequest === "Smoke interface fixture" && !task.parentId && task.status === "open").map(task => ({ taskId: task.id, reason: "A useful next step." }))',
    } });
    snapshot = await window.tasksprig.snapshot();
    return { oneOffId: oneOff.id, recurringId: recurring.id, listId: snapshot.lists.find(list => list.name === 'UI completion check').id, priorHistory: recurring.completionHistory.length };
  });
  await page.getByLabel('Choose list', { exact: true }).selectOption(uiFixtures.listId);
  const fixtureRow = id => page.locator(`.task-row[data-task-id="${id}"]`);
  await fixtureRow(uiFixtures.oneOffId).waitFor();
  assert.equal(await page.locator('.task-row').count(), 3, 'large lists start with three active rows');
  assert.deepEqual(await page.locator('.task-row').first().locator('.task-field').evaluateAll(fields => fields.map(field => field.dataset.field)), ['reason']);
  await fixtureRow(uiFixtures.oneOffId).getByRole('button', { name: 'Details for Smoke one-off task', exact: true }).click();
  assert.equal(await fixtureRow(uiFixtures.oneOffId).locator('.task-details button, .task-details details, .task-details summary, .task-details pre').count(), 0, 'expanded task contains only plain information');
  assert.ok((await fixtureRow(uiFixtures.oneOffId).locator('.task-details').innerText()).includes('Smoke plain-text subtask'));
  assert.equal(await fixtureRow(uiFixtures.oneOffId).locator('.task-details .task-tags').innerText(), 'Home · Plants', 'expanded details show all tags as plain text');
  assert.equal(await fixtureRow(uiFixtures.oneOffId).getByRole('checkbox').count(), 1, 'subtask details do not add controls');
  await fixtureRow(uiFixtures.oneOffId).getByRole('button', { name: 'Details for Smoke one-off task', exact: true }).click();
  assert.equal(await page.locator('.toast').count(), 0);
  await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`.task-row[data-task-id="${id}"]`)?.classList.contains('completed'), uiFixtures.oneOffId);
  assert.equal(await page.locator('.task-row').last().getAttribute('data-task-id'), uiFixtures.oneOffId, 'completed row moves to the actual bottom');
  assert.equal(await page.locator('.task-row').count(), 4, 'completion stays visible beyond the three-active-row limit');
  assert.ok(await fixtureRow(uiFixtures.oneOffId).evaluate(row => Number(getComputedStyle(row).opacity) < 1), 'completed row fades');
  assert.equal(await page.locator('.toast').count(), 0, 'completion does not show a toast');
  assert.equal(await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).getAttribute('aria-checked'), 'true');
  let fixtureSnapshot = await page.evaluate(() => window.tasksprig.snapshot());
  assert.ok(fixtureSnapshot.lists.find(list => list.id === uiFixtures.listId).entries.find(entry => entry.taskId === uiFixtures.oneOffId)?.completedAt, 'live selection retains completed rows across recomputation');
  assert.equal(await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).evaluate(checkbox => checkbox === document.activeElement), true, 'moving the row preserves checkbox focus');
  await page.keyboard.press('Space');
  await page.waitForFunction(async id => (await window.tasksprig.snapshot()).tasks.find(task => task.id === id).status === 'open', uiFixtures.oneOffId);
  assert.equal(await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).getAttribute('aria-checked'), 'false');
  await page.getByRole('checkbox', { name: 'Smoke recurring task', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`.task-row[data-task-id="${id}"]`)?.classList.contains('completed'), uiFixtures.recurringId);
  assert.equal(await page.locator('.task-row').last().getAttribute('data-task-id'), uiFixtures.recurringId);
  fixtureSnapshot = await page.evaluate(() => window.tasksprig.snapshot());
  assert.equal(fixtureSnapshot.tasks.find(task => task.id === uiFixtures.recurringId).status, 'open', 'recurring completion retains the obligation');
  assert.equal(fixtureSnapshot.tasks.find(task => task.id === uiFixtures.recurringId).completionHistory.length, uiFixtures.priorHistory + 1);
  await page.getByLabel('Choose list', { exact: true }).selectOption('all');
  assert.equal(await page.getByRole('checkbox', { name: 'Smoke recurring task', exact: true }).getAttribute('aria-checked'), 'true', 'All items reflects completed recurring occurrences');
  await page.getByRole('checkbox', { name: 'Smoke recurring task', exact: true }).click();
  await page.waitForFunction(async ({ id, count }) => (await window.tasksprig.snapshot()).tasks.find(task => task.id === id).completionHistory.length === count, { id: uiFixtures.recurringId, count: uiFixtures.priorHistory });
  await page.getByLabel('Choose list', { exact: true }).selectOption(uiFixtures.listId);
  await page.evaluate(async id => { await window.tasksprig.act({ type: 'update_list', id, patch: { displayFields: ['tags', 'estimateMinutes'] } }); }, uiFixtures.listId);
  await page.waitForFunction(() => document.querySelectorAll('.task-row:first-child [data-field="estimateMinutes"]').length === 1);
  assert.deepEqual(await page.locator('.task-row').first().locator('.task-field').evaluateAll(fields => fields.map(field => field.dataset.field)), ['tags', 'estimateMinutes'], 'collapsed rows show only the list-selected fields');
  assert.equal(await fixtureRow(uiFixtures.oneOffId).locator('[data-field="tags"]').innerText(), 'Home · Plants', 'a task can show multiple tags');
  await page.evaluate(async id => { await window.tasksprig.act({ type: 'update_list', id, patch: { displayFields: ['dueAt', 'reason'] } }); }, uiFixtures.listId);
  await page.waitForFunction(() => document.querySelectorAll('.task-row:first-child [data-field="dueAt"]').length === 1);
  assert.deepEqual(await page.locator('.task-row').first().locator('.task-field').evaluateAll(fields => fields.map(field => field.dataset.field)), ['dueAt', 'reason']);
  assert.equal(await page.locator('.task-row .field-estimateMinutes').count(), 0, 'estimates are not hardwired into every list');
  // Agent-authored clearing hides a finished row after the undo grace period, not its task/history.
  await page.evaluate(async id => { await window.tasksprig.act({ type: 'update_list', id, patch: { completedClearCode: '() => true' } }); }, uiFixtures.listId);
  await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`.task-row[data-task-id="${id}"]`)?.classList.contains('completed'), uiFixtures.oneOffId);
  await page.getByRole('checkbox', { name: 'Smoke recurring task', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`.task-row[data-task-id="${id}"]`)?.classList.contains('completed'), uiFixtures.recurringId);
  const completedAt = await page.evaluate(async id => (await window.tasksprig.snapshot()).tasks.find(task => task.id === id).completedAt, uiFixtures.oneOffId);
  await page.evaluate(async at => { await window.tasksprig.setClock(new Date(Date.parse(at) + 29_000).toISOString()); }, completedAt);
  assert.equal(await fixtureRow(uiFixtures.oneOffId).count(), 1, 'clearing preserves the minimum undo grace period');
  await page.evaluate(async at => { await window.tasksprig.setClock(new Date(Date.parse(at) + 31_000).toISOString()); }, completedAt);
  assert.equal(await fixtureRow(uiFixtures.oneOffId).count(), 1, 'advancing the simulated clock cannot bypass the real-time undo grace period');
  // Advance wall time only inside this isolated test process; the app exposes no test clock control.
  await desktop.evaluate(() => {
    globalThis.tasksprigSmokeOriginalDateNow = Date.now;
    Date.now = () => globalThis.tasksprigSmokeOriginalDateNow() + 31_000;
  });
  try {
    await page.evaluate(async () => { await window.tasksprig.setClock((await window.tasksprig.snapshot()).now); });
    await page.waitForFunction(id => !document.querySelector(`.task-row[data-task-id="${id}"]`), uiFixtures.oneOffId);
    await page.waitForFunction(id => !document.querySelector(`.task-row[data-task-id="${id}"]`), uiFixtures.recurringId);
  } finally {
    await desktop.evaluate(() => { Date.now = globalThis.tasksprigSmokeOriginalDateNow; delete globalThis.tasksprigSmokeOriginalDateNow; });
  }
  const retainedTask = await page.evaluate(async id => (await window.tasksprig.snapshot()).tasks.find(task => task.id === id), uiFixtures.oneOffId);
  assert.equal(retainedTask.status, 'done');
  assert.equal(retainedTask.completionHistory.at(-1), completedAt, 'clearing preserves completion history');
  assert.equal(await page.evaluate(async ({ listId, taskId }) => (await window.tasksprig.snapshot()).lists.find(list => list.id === listId).entries.some(entry => entry.taskId === taskId), { listId: uiFixtures.listId, taskId: uiFixtures.recurringId }), false, 'live selection does not immediately restore a cleared recurring occurrence');
  // This explicit snapshot is the same action an agent uses to answer a history request.
  const historyListId = await page.evaluate(async ({ taskId, recurringId }) => {
    await window.tasksprig.act({ type: 'create_list', list: { name: 'Finished task history', mode: 'snapshot', selectionCode: '', completedClearCode: '', displayFields: ['reason'], entries: [{ taskId, reason: 'Completed earlier; kept in task history.' }, { taskId: recurringId, reason: 'The latest weekly occurrence was completed.' }] } });
    return (await window.tasksprig.snapshot()).lists.find(list => list.name === 'Finished task history').id;
  }, { taskId: uiFixtures.oneOffId, recurringId: uiFixtures.recurringId });
  await page.getByLabel('Choose list', { exact: true }).selectOption(historyListId);
  assert.equal(await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).getAttribute('aria-checked'), 'true', 'an agent-created history list brings the finished item back');
  assert.equal(await page.getByRole('checkbox', { name: 'Smoke recurring task', exact: true }).getAttribute('aria-checked'), 'true', 'new history entries use global recurring occurrence completion without a clearing marker');
  await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).click();
  await page.waitForFunction(async id => (await window.tasksprig.snapshot()).tasks.find(task => task.id === id).status === 'open', uiFixtures.oneOffId);
  await page.getByRole('checkbox', { name: 'Smoke recurring task', exact: true }).click();
  await page.waitForFunction(async ({ id, count }) => (await window.tasksprig.snapshot()).tasks.find(task => task.id === id).completionHistory.length === count, { id: uiFixtures.recurringId, count: uiFixtures.priorHistory });
  await page.getByLabel('Choose list', { exact: true }).selectOption(uiFixtures.listId);
  await fixtureRow(uiFixtures.oneOffId).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Smoke one-off task', exact: true }).getAttribute('aria-checked'), 'false', 'undo from history restores the original list membership');
  await page.getByLabel('Choose list', { exact: true }).selectOption(priorities.id);
  await openPanel(page, 'Calendar');
  assert.equal(await page.locator('.calendar-day').count(), 7);
  await page.screenshot({ path: 'artifacts/desktop-calendar.png' });
  await page.getByRole('button', { name: 'Close Calendar', exact: true }).click();
  await openPanel(page, 'Settings');
  await page.getByRole('button', { name: /^Your model/ }).click();
  await page.getByLabel('Provider', { exact: true }).selectOption('openai');
  assert.equal(await page.getByLabel('Model ID').inputValue(), 'gpt-5.4-mini');
  assert.equal(await page.getByLabel('API key').getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Exercise native encrypted credential persistence without making a provider request.
  await page.evaluate(async () => {
    await window.tasksprig.saveSettings({ provider: 'openai', model: 'gpt-5.4-mini', apiKey: 'tasksprig-smoke-fixture-not-a-real-key' });
    await window.tasksprig.saveSettings({ provider: 'google', model: 'gemma-4-26b-a4b-it', apiKey: 'tasksprig-google-fixture-not-a-real-key' });
    await window.tasksprig.saveSettings({ provider: 'demo', model: '' });
    await window.tasksprig.saveSettings({ provider: 'openai', model: 'gpt-5.4-mini' });
  });
  assert.equal((await page.evaluate(() => window.tasksprig.settings())).hasApiKey, true, 'switching to demo retains provider credentials');
  assert.equal((await readFile(join(dataDir, 'settings.json'), 'utf8')).includes('tasksprig-smoke-fixture-not-a-real-key'), false);
  await page.evaluate(() => window.tasksprig.saveSettings({ provider: 'google', model: 'gemma-4-26b-a4b-it' }));
  assert.equal((await page.evaluate(() => window.tasksprig.settings())).hasApiKey, true, 'Google and OpenAI credentials persist independently');
  const configured = (await page.evaluate(() => window.tasksprig.settings())).configuredProviders;
  assert.ok(configured.includes('openai') && configured.includes('google'));
  assert.equal((await readFile(join(dataDir, 'settings.json'), 'utf8')).includes('tasksprig-google-fixture-not-a-real-key'), false);
  await page.evaluate(() => window.tasksprig.saveSettings({ provider: 'demo', model: '' }));
  // Exercise actual AudioWorklet capture with synthetic audio and a mocked realtime boundary.
  // No microphone, provider connection, or user workspace is involved.
  await desktop.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('tasksprig:microphone-access');
    ipcMain.handle('tasksprig:microphone-access', () => {});
    for (const channel of ['tasksprig:voice-start', 'tasksprig:voice-audio', 'tasksprig:voice-stop']) ipcMain.removeHandler(channel);
    const sessions = new Map();
    let sequence = 0;
    globalThis.tasksprigSmokeVoice = { audioChunks: 0, finalizations: 0, cancellations: 0, manualStops: 0, activeId: '' };
    const finish = sessionId => {
      const session = sessions.get(sessionId);
      if (!session || session.closed) return;
      session.closed = true;
      globalThis.tasksprigSmokeVoice.finalizations += 1;
      session.sender.send('tasksprig:voice-event', { sessionId, type: 'speech_stopped' });
      const final = { sessionId, type: 'final', text: 'water the plants weekly' };
      session.sender.send('tasksprig:voice-event', final);
      // A stale duplicate must not submit a second request.
      session.sender.send('tasksprig:voice-event', final);
    };
    globalThis.tasksprigSmokeFinishVoice = finish;
    ipcMain.handle('tasksprig:voice-start', event => {
      const sessionId = `voice-smoke-${++sequence}`;
      sessions.set(sessionId, { sender: event.sender, chunks: 0, closed: false });
      globalThis.tasksprigSmokeVoice.activeId = sessionId;
      setTimeout(() => event.sender.send('tasksprig:voice-event', { sessionId, type: 'ready' }), 10);
      return { sessionId };
    });
    ipcMain.handle('tasksprig:voice-audio', (_event, request) => {
      const session = sessions.get(request.sessionId);
      if (!session || session.closed) return;
      if (!request.audio?.byteLength || request.audio.byteLength > 4800 || request.audio.byteLength % 2) throw new Error('Expected bounded PCM16 chunks');
      globalThis.tasksprigSmokeVoice.audioChunks += 1;
      session.chunks += 1;
      if (session.chunks === 2) {
        session.sender.send('tasksprig:voice-event', { sessionId: request.sessionId, type: 'speech_started' });
        session.sender.send('tasksprig:voice-event', { sessionId: request.sessionId, type: 'partial', text: 'water the plants' });
      }
    });
    ipcMain.handle('tasksprig:voice-stop', (_event, request) => {
      const session = sessions.get(request.sessionId);
      if (!session || session.closed) return;
      if (request.cancel) {
        session.closed = true;
        globalThis.tasksprigSmokeVoice.cancellations += 1;
        // A cancelled stream can still have an already-queued event in transit.
        session.sender.send('tasksprig:voice-event', { sessionId: request.sessionId, type: 'final', text: 'never send this cancelled request' });
      } else {
        globalThis.tasksprigSmokeVoice.manualStops += 1;
        finish(request.sessionId);
      }
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Record voice', exact: true }).waitFor();
  await page.evaluate(() => {
    window.tasksprigSmokeAudio = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      const destination = context.createMediaStreamDestination();
      const source = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.1;
      source.connect(gain); gain.connect(destination); source.start();
      await context.resume();
      window.tasksprigSmokeAudio.push({ context, source, gain });
      return destination.stream;
    };
  });
  const beforeVoice = await page.evaluate(() => window.tasksprig.snapshot());
  const initialUserMessages = beforeVoice.messages.filter(message => message.role === 'user').length;
  await page.getByLabel('Tell TaskSprig what you need').fill('Please');
  await page.getByRole('button', { name: 'Record voice', exact: true }).click();
  try {
    await page.waitForFunction(() => document.querySelector('#capture')?.value === 'Please water the plants', undefined, { timeout: 10000 });
    assert.equal((await page.evaluate(() => window.tasksprig.snapshot())).messages.length, beforeVoice.messages.length, 'partial transcription appears before a request is sent');
    assert.equal(await page.getByRole('button', { name: 'Send request', exact: true }).isDisabled(), true);
    assert.ok(await desktop.evaluate(() => globalThis.tasksprigSmokeVoice.audioChunks >= 2), 'the real worklet streamed PCM chunks');
    await page.evaluate(() => { window.tasksprigSmokeAudio.at(-1).gain.gain.value = 0; });
    // Simulate the backend's pause detection; the renderer must release capture and submit final text.
    await desktop.evaluate(() => globalThis.tasksprigSmokeFinishVoice(globalThis.tasksprigSmokeVoice.activeId));
    await page.waitForFunction(async count => (await window.tasksprig.snapshot()).messages.filter(message => message.role === 'user').length === count + 1, initialUserMessages);
    await page.waitForFunction(() => !document.querySelector('.thinking'));
    const afterAutomatic = await page.evaluate(() => window.tasksprig.snapshot());
    const requests = afterAutomatic.messages.filter(message => message.role === 'user').slice(initialUserMessages);
    assert.deepEqual(requests.map(message => message.text), ['Please water the plants weekly'], 'final text sends once with the original draft, without repeating the partial');
    assert.equal(await page.getByLabel('Tell TaskSprig what you need').inputValue(), '');

    await page.getByLabel('Tell TaskSprig what you need').fill('Keep this draft');
    await page.getByRole('button', { name: 'Record voice', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#capture')?.value === 'Keep this draft water the plants');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#capture')?.value === 'Keep this draft');
    assert.equal((await page.evaluate(() => window.tasksprig.snapshot())).messages.length, afterAutomatic.messages.length, 'Escape after a partial never submits');
    assert.equal(await desktop.evaluate(() => globalThis.tasksprigSmokeVoice.cancellations), 1);

    await page.getByLabel('Tell TaskSprig what you need').fill('');
    await page.getByRole('button', { name: 'Record voice', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#capture')?.value === 'water the plants');
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await page.waitForFunction(async count => (await window.tasksprig.snapshot()).messages.filter(message => message.role === 'user').length === count + 2, initialUserMessages);
    await page.waitForFunction(() => !document.querySelector('.thinking'));
    const finalRequests = (await page.evaluate(() => window.tasksprig.snapshot())).messages.filter(message => message.role === 'user').slice(initialUserMessages);
    assert.deepEqual(finalRequests.map(message => message.text), ['Please water the plants weekly', 'water the plants weekly']);
    assert.equal(await desktop.evaluate(() => globalThis.tasksprigSmokeVoice.manualStops), 1, 'manual Stop commits once');
    assert.equal(await desktop.evaluate(() => globalThis.tasksprigSmokeVoice.finalizations), 2);
    await page.evaluate(async () => {
      for (const { context, source } of window.tasksprigSmokeAudio) { source.stop(); await context.close(); }
    });
  } catch (error) {
    await page.screenshot({ path: 'artifacts/voice-failure.png' });
    throw new Error(`Streaming voice smoke failed: ${await page.locator('.voice-status').allTextContents()}; composer=${await page.getByLabel('Tell TaskSprig what you need').inputValue()}`, { cause: error });
  }
  state = await page.evaluate(() => window.tasksprig.snapshot());
  await desktop.close(); desktop = undefined;
  page = await launch();
  const restored = await page.evaluate(() => window.tasksprig.snapshot());
  assert.equal(restored.tasks.length, state.tasks.length);
  assert.equal(restored.routineRuns.length, state.routineRuns.length);
  assert.ok(restored.lists.some(list => list.id === quickList.id));
  assert.deepEqual(errors, []);
  console.log('Desktop smoke passed: temporary/saved lists, schedule labels, callbacks, reversible completion, clearing/history recovery, list fields, plain task details, calendar, keys, streaming voice partials/automatic send/manual stop/cancel, persistence.');
} finally {
  if (desktop) await desktop.close();
  await rm(dataDir, { recursive: true, force: true });
}
