import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Engine } from './engine/index';
import { runAgent } from './agent/index';
import { SettingsStore } from './settings';
import { requestMicrophoneAccess, transcribeAudio } from './transcription';
import { RealtimeTranscriptionSession } from './realtime-transcription';
import { configureAppData } from './app-data';
import type { Action, Routine, Snapshot, VoiceAudioChunk, VoiceStreamStop } from '../shared/types';

const dirname = path.dirname(fileURLToPath(import.meta.url));
// Electron's instance lock follows userData, so isolated demo/test workspaces can coexist.
configureAppData();
const ownsWorkspace = app.requestSingleInstanceLock();
if (!ownsWorkspace) app.quit();
let window: BrowserWindow | null = null;
let engine: Engine;
let settings: SettingsStore;
let timer: ReturnType<typeof setInterval>;
let queue: Promise<unknown> = Promise.resolve();
let quitting = false;
let tickPending = false;
let transcriptionBusy = false;
let voiceSession: RealtimeTranscriptionSession | null = null;
function cancelVoice() { voiceSession?.stop(true); voiceSession = null; }
function assertVoiceCaller(event: Electron.IpcMainInvokeEvent) {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Voice input is available only in TaskSprig.');
}
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}
function notify() { if (window && !window.isDestroyed()) window.webContents.send('tasksprig:changed'); }
async function applyAction(action: Action) {
  const result = await engine.applyAction(action);
  notify();
  return result;
}
async function runRoutine(routine: Routine, snapshot: Snapshot): Promise<string> {
  const config = settings.get();
  const mode = config.provider === 'demo' ? 'demo' : 'live';
  let focusListId = routine.listId || undefined;
  const text = await runAgent(routine.instructions, snapshot, config, async action => {
    const result = await applyAction(action);
    if (['create_list', 'update_list', 'refresh_list', 'show_list'].includes(action.type)) focusListId = result.id;
    return result;
  }, { routine, getSnapshot: () => engine.getSnapshot() });
  await engine.appendMessage({ role: 'assistant', text: `${routine.name}\n\n${text}`, mode, focusListId });
  notify();
  return text;
}
async function tick() { await engine.tick(runRoutine); notify(); }
function createWindow() {
  window = new BrowserWindow({ width: 960, height: 780, minWidth: 700, minHeight: 600,
    title: 'TaskSprig', backgroundColor: '#f7f7f1',
    webPreferences: { preload: path.join(dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const session = window.webContents.session;
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === window?.webContents && permission === 'media' && details.mediaType === 'audio' && details.isMainFrame);
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(contents === window?.webContents && permission === 'media' &&
      !!mediaTypes?.length && mediaTypes.every(type => type === 'audio'));
  });
  if (process.env.TASKSPRIG_DEV_URL) void window.loadURL(process.env.TASKSPRIG_DEV_URL);
  else void window.loadFile(path.join(dirname, '../renderer/index.html'));
  window.webContents.on('render-process-gone', cancelVoice);
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancelVoice(); });
  window.on('closed', () => { cancelVoice(); window = null; });
}
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
if (ownsWorkspace) app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  engine = new Engine({ dataDir, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  settings = new SettingsStore(dataDir);
  await engine.init();
  await settings.init();
  const initial = await engine.getSnapshot();
  if (initial.tasks.length === 0 && initial.lists.length === 0 && initial.activity.length === 0) await engine.resetDemo();
  ipcMain.handle('tasksprig:snapshot', () => engine.getSnapshot());
  ipcMain.handle('tasksprig:settings', () => settings.public());
  ipcMain.handle('tasksprig:microphone-access', async event => {
    assertVoiceCaller(event);
    if (!settings.getForProvider('openai').apiKey) throw new Error('Add an OpenAI key in Settings to use voice input.');
    await requestMicrophoneAccess();
  });
  ipcMain.handle('tasksprig:transcribe', async (event, request) => {
    assertVoiceCaller(event);
    if (transcriptionBusy) throw new Error('A recording is already being transcribed.');
    transcriptionBusy = true;
    try { return await transcribeAudio(request, settings.getForProvider('openai').apiKey); }
    finally { transcriptionBusy = false; }
  });
  ipcMain.handle('tasksprig:voice-start', event => {
    assertVoiceCaller(event);
    if (voiceSession && !voiceSession.isClosed) throw new Error('Voice input is already running.');
    const apiKey = settings.getForProvider('openai').apiKey;
    if (!apiKey) throw new Error('Add an OpenAI key in Settings to use voice input.');
    const sessionId = randomUUID();
    const sender = event.sender;
    const session = new RealtimeTranscriptionSession({
      sessionId, apiKey,
      onEvent: voiceEvent => { if (!sender.isDestroyed()) sender.send('tasksprig:voice-event', voiceEvent); },
      onClose: () => { if (voiceSession === session) voiceSession = null; },
    });
    voiceSession = session;
    session.start();
    return { sessionId };
  });
  ipcMain.handle('tasksprig:voice-audio', (event, chunk: VoiceAudioChunk) => {
    assertVoiceCaller(event);
    if (!chunk || !voiceSession || chunk.sessionId !== voiceSession.sessionId) return;
    voiceSession.pushAudio(chunk.audio);
  });
  ipcMain.handle('tasksprig:voice-stop', (event, request: VoiceStreamStop) => {
    assertVoiceCaller(event);
    if (!request || !voiceSession || request.sessionId !== voiceSession.sessionId) return;
    voiceSession.stop(request.cancel === true);
  });
  ipcMain.handle('tasksprig:save-settings', (_, input) => serial(async () => { const value = await settings.save(input); notify(); return value; }));
  ipcMain.handle('tasksprig:act', (_, action) => serial(async () => {
    // Return direct edits promptly so a completion can be unchecked immediately.
    // The scheduler processes queued completion callbacks on its next tick.
    await applyAction(action); return engine.getSnapshot();
  }));
  ipcMain.handle('tasksprig:chat', (_, input: unknown, activeListId?: string) => serial(async () => {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Please enter a request.');
    if (input.length > 16000) throw new Error('Please keep this request under 16,000 characters.');
    const config = settings.get();
    const mode = config.provider === 'demo' ? 'demo' : 'live';
    const before = await engine.getSnapshot();
    const activeId = before.lists.some(list => list.id === activeListId) ? activeListId : undefined;
    await engine.appendMessage({ role: 'user', text: input, mode }); notify();
    let focusListId: string | undefined;
    try {
      const text = await runAgent(input, await engine.getSnapshot(), config, async action => {
        const result = await applyAction(action);
        if (['create_list', 'update_list', 'refresh_list', 'show_list'].includes(action.type)) focusListId = result.id;
        return result;
      }, { getSnapshot: () => engine.getSnapshot(), activeListId: activeId });
      await engine.appendMessage({ role: 'assistant', text, mode, focusListId }); notify();
      await tick();
      return { text, mode, focusListId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request could not be completed.';
      await engine.appendMessage({ role: 'assistant', text: message, mode, error: true, focusListId }); notify();
      return { text: message, mode, focusListId, error: true };
    } finally {
      // Keep the old selection available for follow-ups such as "save this list".
      // Once the request finishes, only the new visible temporary result survives.
      const current = await engine.getSnapshot();
      for (const list of current.lists) {
        if (list.ephemeral && list.id !== focusListId) {
          await engine.applyAction({ type: 'delete_list', id: list.id });
        }
      }
      notify();
    }
  }));
  ipcMain.handle('tasksprig:clock', (_, iso: string | null) => serial(async () => {
    if (iso !== null && (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso)))) throw new Error('Invalid clock date');
    await engine.setClock(iso); await tick(); return engine.getSnapshot();
  }));
  ipcMain.handle('tasksprig:reset', () => serial(async () => { await engine.resetDemo(); notify(); return engine.getSnapshot(); }));
  createWindow();
  timer = setInterval(() => {
    if (tickPending || quitting) return;
    tickPending = true;
    void serial(tick).catch(error => console.error('Scheduler error:', error.message)).finally(() => { tickPending = false; });
  }, 15000);
  void serial(tick).catch(error => console.error('Startup scheduler error:', error.message));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!engine || quitting) return;
  event.preventDefault(); quitting = true; clearInterval(timer);
  cancelVoice();
  void queue.then(() => engine.close()).catch(error => console.error('Shutdown error:', error.message)).finally(() => app.quit());
});
