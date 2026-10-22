import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import VoiceInput, { type VoiceInputState } from './VoiceInput';
import type { Action, ListDisplayField, Provider, PublicSettings, Routine, Snapshot, Task, TaskEvaluation } from '../shared/types';

type IconName = 'spark' | 'list' | 'calendar' | 'clock' | 'settings' | 'leaf' | 'arrow' | 'refresh' | 'check' | 'chevron' | 'activity' | 'close' | 'archive' | 'repeat' | 'sun' | 'layers' | 'arrowLeft' | 'play' | 'code';
function Icon({ name, size = 16, ...props }: { name: IconName; size?: number } & React.SVGProps<SVGSVGElement>) {
  const paths: Record<IconName, React.ReactNode> = {
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/><path d="m20 2 .8 2.2L23 5l-2.2.8L20 8l-.8-2.2L17 5l2.2-.8L20 2Z"/></>,
    list: <><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 10h8M8 15h5M8 3v4M16 3v4"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 15h1M15 15h1M8 18h1"/></>,
    clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></>,
    settings: <><path d="M9 3h6l.7 3 2.7 1.5 2.9-.8 3 5.2-2.2 2.2V17l-3 1.7-.7 3H12l-.7-3L8.6 17l-2.9.8-3-5.2 2.2-2.2V7.5L9 6V3Z" transform="translate(-1 -1) scale(.94)"/><circle cx="12" cy="12" r="3"/></>,
    leaf: <><path d="M20 4C9 2 3 8 5 15s16 4 15-11Z"/><path d="M4 21 15 10"/></>,
    arrow: <><path d="M12 19V5M6 11l6-6 6 6"/></>,
    refresh: <><path d="M20 10a8 8 0 0 0-14-4L3 9m0-5v5h5M4 14a8 8 0 0 0 14 4l3-3m0 5v-5h-5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m9 5 7 7-7 7"/>,
    arrowLeft: <path d="m15 5-7 7 7 7"/>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    archive: <><path d="M5 9v11h14V9M9 13h6"/><rect x="3" y="4" width="18" height="5" rx="1.5"/></>,
    repeat: <><path d="M4 9V7a2 2 0 0 1 2-2h13l-3-3M20 15v2a2 2 0 0 1-2 2H5l3 3M19 5l-3 3M5 19l3-3"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></>,
    layers: <><path d="m3 8 9-5 9 5-9 5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/></>,
    play: <path d="m8 4 12 8-12 8V4Z"/>,
    code: <><path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

const suggestions = ['I need to water the plants every two weeks', 'Pick three priorities every morning', 'What can I do in 20 minutes?'];
const defaultModels: Record<Provider, string> = { demo: '', anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.4-mini', google: 'gemma-4-26b-a4b-it' };

function formatDate(date: string | number | Date, timezone: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options }).format(new Date(date));
}
function dateKey(date: string | number | Date, timezone: string) {
  return formatDate(date, timezone, { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function futureMorning(now: string, timezone: string, days = 1) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const wall = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + days, 9));
  let result = wall.getTime();
  for (let attempt = 0; attempt < 2; attempt++) {
    const localParts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(result));
    const part = (type: string) => Number(localParts.find(p => p.type === type)?.value);
    const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    result += wall.getTime() - represented;
  }
  return new Date(result).toISOString();
}
function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
function relativeDue(date: string | null, now: string, timezone: string) {
  if (!date) return '';
  if (dateKey(date, timezone) === dateKey(now, timezone)) return 'Due today';
  if (dateKey(date, timezone) === dateKey(futureMorning(now, timezone), timezone)) return 'Due tomorrow';
  const prefix = new Date(date).getTime() < new Date(now).getTime() ? 'Due since ' : 'Due ';
  return prefix + formatDate(date, timezone, { month: 'short', day: 'numeric' });
}

function cleanError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^(?:Error:\s*)+/i, '');
}

type PanelName = 'calendar' | 'routines' | 'conversation' | 'activity' | 'demo' | 'list';
type Act = (action: Action, notice?: string) => Promise<void>;

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [view, setView] = useState('initial');
  const [showAll, setShowAll] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceInputState>('idle');
  const [composer, setComposer] = useState('');
  const [error, setError] = useState('');
  const [chatError, setChatError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [dismissedResponse, setDismissedResponse] = useState('');
  const [toast, setToast] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialChoice = useRef(false);
  const lastSavedView = useRef('all');
  const voiceDraft = useRef('');

  const reload = useCallback(async () => {
    const next = await window.tasksprig.snapshot();
    setSnapshot(next);
    if (!initialChoice.current) {
      initialChoice.current = true;
      lastSavedView.current = next.lists.find(list => !list.ephemeral)?.id ?? 'all';
      setView(lastSavedView.current);
    }
  }, []);

  useEffect(() => {
    if (!window.tasksprig) { setError('Start TaskSprig through the desktop app.'); return; }
    void Promise.all([reload(), window.tasksprig.settings().then(setSettings)]).catch(e => setError(cleanError(e)));
    return window.tasksprig.onChange(() => { void reload().catch(e => setError(cleanError(e))); });
  }, [reload]);
  useEffect(() => { setShowAll(false); }, [view]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', closeOutside);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', closeOutside); window.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  const act: Act = async (action, notice) => {
    setBusy(true); setError('');
    try { setSnapshot(await window.tasksprig.act(action)); if (notice) setToast(notice); }
    catch (e) { setError(cleanError(e)); }
    finally { setBusy(false); }
  };
  const chooseList = async (nextView: string) => {
    const previous = snapshot?.lists.find(list => list.id === view);
    setView(nextView); setPanel(null);
    if (!snapshot?.lists.find(list => list.id === nextView)?.ephemeral) lastSavedView.current = nextView;
    if (previous?.ephemeral && previous.id !== nextView) {
      await act({ type: 'delete_list', id: previous.id });
    }
  };
  const submit = async (text = composer, fromVoice = false) => {
    if (!text.trim() || chatBusy || (!fromVoice && voiceState !== 'idle')) return;
    setComposer(''); setChatBusy(true); setChatError(''); setDismissedResponse('');
    const oldIds = new Set(snapshot?.lists.map(list => list.id));
    const activeList = snapshot?.lists.find(list => list.id === view);
    if (activeList?.ephemeral) setView(lastSavedView.current);
    try {
      const result = await window.tasksprig.chat(text.trim(), activeList?.id);
      const next = await window.tasksprig.snapshot();
      setSnapshot(next);
      const focusList = next.lists.find(list => list.id === result.focusListId)
        ?? next.lists.find(list => !oldIds.has(list.id));
      if (focusList) {
        setView(focusList.id); setPanel(null); setShowAll(false);
        if (!focusList.ephemeral) lastSavedView.current = focusList.id;
      }
    } catch (e) { setChatError(cleanError(e)); }
    finally { setChatBusy(false); }
  };
  const changeClock = async (iso: string | null) => {
    setBusy(true); setError('');
    try { setSnapshot(await window.tasksprig.setClock(iso)); }
    catch (e) { setError(cleanError(e)); }
    finally { setBusy(false); }
  };
  const prompt = (text: string) => {
    setPanel(null); setMenuOpen(false); setComposer(text);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };
  const openPanel = (name: PanelName) => { setMenuOpen(false); setPanel(name); };
  const selectedList = snapshot?.lists.find(list => list.id === view);
  const evaluations = useMemo(() => new Map(snapshot?.evaluations.map(item => [item.taskId, item]) ?? []), [snapshot?.evaluations]);
  const tasks = useMemo(() => new Map(snapshot?.tasks.map(item => [item.id, item]) ?? []), [snapshot?.tasks]);

  if (!snapshot) return <div className="loading-page"><span className="wordmark">tasksprig</span><p>{error || 'Loading…'}</p>{error && <button className="text-button" onClick={() => void reload().catch(e => setError(String(e)))}>Try again</button>}</div>;

  const title = selectedList?.name ?? (view === 'completed' ? 'Completed' : 'All items');
  const linkedRoutines = selectedList ? snapshot.routines.filter(routine => routine.listId === selectedList.id) : [];
  const listSubtitle = linkedRoutines.length
    ? linkedRoutines.map(routine => routineScheduleLabel(routine, snapshot.timezone)).join('; ')
    : selectedList?.description;
  const taskDone = (task: Task) => task.status === 'done' || !!evaluations.get(task.id)?.completed;
  const entries = selectedList
    ? selectedList.entries.flatMap(entry => {
      const task = tasks.get(entry.taskId);
      return task && task.status !== 'dropped' ? [{ task, reason: entry.reason, done: taskDone(task) || !!entry.completedAt }] : [];
    })
    : snapshot.tasks.filter(task => {
      if (task.status === 'dropped' || (view === 'completed' && !taskDone(task))) return false;
      const parent = task.parentId ? tasks.get(task.parentId) : undefined;
      return !parent || parent.status === 'dropped' || (view === 'completed' && !taskDone(parent));
    }).map(task => ({ task, reason: evaluations.get(task.id)?.reason || task.behaviorExplanation, done: taskDone(task) }));
  const displayFields: ListDisplayField[] = selectedList?.displayFields ?? ['dueAt', 'estimateMinutes'];
  const activeEntries = entries.filter(entry => !entry.done);
  const completedEntries = entries.filter(entry => entry.done);
  const latestResponse = [...snapshot.messages].reverse().find(message => message.role === 'assistant');
  const hasConversation = snapshot.messages.some(message => message.role === 'user') || snapshot.routineRuns.length > 0;
  const showResponse = !chatBusy && hasConversation && latestResponse && latestResponse.id !== dismissedResponse;
  const visibleActiveEntries = showAll ? activeEntries : activeEntries.slice(0, 3);
  const renderEntry = ({ task, reason, done }: typeof entries[number]) => <TaskRow key={task.id} task={task} reason={reason} evaluation={evaluations.get(task.id)} tasks={snapshot.tasks} now={snapshot.now} timezone={snapshot.timezone} busy={busy} done={done} displayFields={displayFields} act={act}/>;
  const panelTitles: Record<PanelName, string> = { calendar: 'Calendar', routines: 'Routines', conversation: 'Conversation', activity: 'Activity', demo: 'Demo controls', list: 'List options' };

  return <div className="app">
    <header className="app-header">
      <span className="wordmark">tasksprig</span>
      <div className="header-controls">
        <label className="screen-reader-only" htmlFor="list-chooser">Choose list</label>
        <select id="list-chooser" className="list-chooser" disabled={chatBusy || busy} value={selectedList?.id ?? (view === 'completed' ? 'completed' : 'all')} onChange={event => void chooseList(event.target.value)}>
          {selectedList?.ephemeral && <option value={selectedList.id}>{selectedList.name}</option>}
          {snapshot.lists.filter(list => !list.ephemeral).map(list => <option value={list.id} key={list.id}>{list.name}</option>)}
          <option value="all">All items</option>
          <option value="completed">Completed</option>
        </select>
        <div className="menu-container" ref={menuRef}>
          <button className="menu-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
          {menuOpen && <div className="app-menu" role="menu">
            {selectedList && <button role="menuitem" onClick={() => openPanel('list')}>List options</button>}
            <button role="menuitem" onClick={() => openPanel('calendar')}>Calendar</button>
            <button role="menuitem" onClick={() => openPanel('routines')}>Routines</button>
            <button role="menuitem" onClick={() => openPanel('conversation')}>Conversation</button>
            <button role="menuitem" onClick={() => openPanel('activity')}>Activity</button>
            <div className="menu-divider"/>
            <button role="menuitem" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}>Settings</button>
            <button role="menuitem" onClick={() => openPanel('demo')}>Demo controls</button>
          </div>}
        </div>
      </div>
    </header>

    <div className="workspace-scroll">
      <main className="main-content">
        {error && <div className="error-banner"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={13}/></button></div>}
        <h1>{title}</h1>
        {listSubtitle && <p className="list-description" title={listSubtitle}>{listSubtitle}</p>}
        {selectedList?.error && <p className="chat-error">This list needs attention: {selectedList.error}</p>}
        <div className="task-list">
          {[...visibleActiveEntries.map(renderEntry),
            activeEntries.length > 3 ? <button key="show-more" className="show-more" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show ${activeEntries.length - 3} more`}</button> : null,
            ...completedEntries.map(renderEntry)]}
        </div>
        {!entries.length && <p className="empty-state">{selectedList ? 'Nothing in this list right now.' : view === 'completed' ? 'Completed items will appear here.' : 'Tell TaskSprig something you need to keep track of.'}</p>}
      </main>
    </div>

    <div className="capture-dock">
      <div className="capture-inner">
        {chatBusy && <p className="thinking" role="status">Working on it…</p>}
        {showResponse && <div className="latest-response">
          <p className={latestResponse.error ? 'response-text response-error' : 'response-text'}>{latestResponse.error ? cleanError(latestResponse.text) : latestResponse.text}</p>
          <div className="response-actions">{latestResponse.focusListId && latestResponse.focusListId !== view && snapshot.lists.some(list => list.id === latestResponse.focusListId) && <button onClick={() => void chooseList(latestResponse.focusListId!)}>Open list</button>}<button onClick={() => openPanel('conversation')}>Read conversation</button><button aria-label="Dismiss response" onClick={() => setDismissedResponse(latestResponse.id)}><Icon name="close" size={12}/></button></div>
        </div>}
        {chatError && !(latestResponse?.error && cleanError(latestResponse.text) === chatError) && <div className="chat-error">{chatError} <button className="inline-button" onClick={() => setSettingsOpen(true)}>Settings</button></div>}
        <form className="capture-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="screen-reader-only" htmlFor="capture">Tell TaskSprig what you need</label>
          <textarea id="capture" ref={composerRef} rows={1} value={composer} placeholder="Tell TaskSprig what you need…" disabled={chatBusy} readOnly={voiceState !== 'idle'} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
          <VoiceInput disabled={chatBusy} hasOpenAIKey={!!settings?.configuredProviders?.includes('openai')}
            requestPermission={() => window.tasksprig.requestMicrophoneAccess()}
            startStream={() => window.tasksprig.startVoiceStream()}
            sendAudio={chunk => window.tasksprig.pushVoiceAudio(chunk)}
            stopStream={request => window.tasksprig.stopVoiceStream(request)}
            onStreamEvent={listener => window.tasksprig.onVoiceStreamEvent(listener)}
            onStateChange={state => { if (state === 'requesting') voiceDraft.current = composer; setVoiceState(state); }}
            onPartialTranscript={text => setComposer([voiceDraft.current.trim(), text].filter(Boolean).join(' '))}
            onCancel={() => setComposer(voiceDraft.current)}
            onTranscript={text => { void submit([voiceDraft.current.trim(), text].filter(Boolean).join(' '), true); }}/>
          <button type="submit" className="send-button" disabled={chatBusy || voiceState !== 'idle' || !composer.trim()} aria-label="Send request"><Icon name="arrow" size={17}/></button>
        </form>
        {settings?.provider === 'demo' && <button className="demo-label" onClick={() => setSettingsOpen(true)}>Scripted demo · connect a model for open-ended requests</button>}
      </div>
    </div>

    {panel && <Panel title={panelTitles[panel]} wide={panel === 'calendar'} onClose={() => setPanel(null)}>
      {panel === 'calendar' && <Calendar snapshot={snapshot} evaluations={evaluations}/>}
      {panel === 'routines' && <>{snapshot.routines.length ? snapshot.routines.map(routine => <RoutineCard key={routine.id} routine={routine} snapshot={snapshot} busy={busy} act={act} onEdit={() => prompt(`Change my “${routine.name}” routine to `)}/>) : <p className="empty-state">Ask TaskSprig to set up a routine, such as a morning check-in.</p>}<p className="panel-note">Routines run while TaskSprig is open. Missed daily routines catch up once when you return.</p></>}
      {panel === 'conversation' && <div className="conversation-history">{snapshot.messages.map(message => <article className={`history-message ${message.role}`} key={message.id}><span>{message.role === 'user' ? 'You' : message.mode === 'demo' ? 'TaskSprig · scripted demo' : 'TaskSprig'}</span><p className={message.error ? 'response-error' : ''}>{message.text}</p>{message.focusListId && message.focusListId !== view && snapshot.lists.some(list => list.id === message.focusListId) && <button className="text-button" onClick={() => void chooseList(message.focusListId!)}>Open list</button>}</article>)}{!snapshot.messages.length && <p className="empty-state">Your conversation will appear here.</p>}</div>}
      {panel === 'activity' && <div className="activity-list">{snapshot.activity.map(item => <article className="activity-row" key={item.id}><p>{item.message}</p><time>{formatDate(item.at, snapshot.timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></article>)}{!snapshot.activity.length && <p className="empty-state">No activity yet.</p>}</div>}
      {panel === 'list' && selectedList && <>
        <p className="panel-description">{linkedRoutines.length ? listSubtitle : selectedList.instructions || selectedList.description}</p>
        <p className="panel-note">{selectedList.mode === 'live' ? 'This list updates as tasks and time change.' : 'This selection stays the same until refreshed.'}</p>
        <div className="action-row"><button className="text-button" disabled={busy} onClick={() => void act({ type: 'refresh_list', id: selectedList.id }, 'List refreshed.')}><Icon name="refresh" size={13}/>Refresh list</button><button className="text-button" onClick={() => prompt(`Change my “${selectedList.name}” list to `)}>Change list</button></div>
        {selectedList.lastRefreshedAt && <p className="panel-note">Last refreshed {formatDate(selectedList.lastRefreshedAt, snapshot.timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.</p>}
        {selectedList.selectionCode && <details className="inspector"><summary>Selection code</summary>{linkedRoutines.length > 0 && selectedList.instructions && <p>Saved selection instructions: {selectedList.instructions}</p>}<pre>{selectedList.selectionCode}</pre></details>}
        <button className="text-button danger remove-list" disabled={busy} onClick={() => { void act({ type: 'delete_list', id: selectedList.id }, 'List removed. Tasks are still in All items.'); setView('all'); setPanel(null); }}>Remove list</button>
      </>}
      {panel === 'demo' && <>
        <p className="demo-date">{formatDate(snapshot.now, snapshot.timezone, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
        <p className="panel-note">{snapshot.simulated ? 'Simulated time' : 'Real time'} · {snapshot.timezone}</p>
        <div className="action-row"><button className="text-button" disabled={busy || chatBusy} onClick={() => void changeClock(new Date(Date.parse(snapshot.now) + 3600000).toISOString())}>+1 hour</button><button className="text-button" disabled={busy || chatBusy} onClick={() => void changeClock(futureMorning(snapshot.now, snapshot.timezone))}>Next morning</button><button className="text-button" disabled={busy || chatBusy} onClick={() => void changeClock(futureMorning(snapshot.now, snapshot.timezone, 7))}>+1 week</button>{snapshot.simulated && <button className="text-button" disabled={busy || chatBusy} onClick={() => void changeClock(null)}>Real time</button>}</div>
        <p className="panel-note">Time travel changes this workspace. Returning to real time keeps actions already taken.</p>
        <details className="inspector"><summary>Example requests</summary><div className="demo-examples">{suggestions.map(suggestion => <button key={suggestion} onClick={() => prompt(suggestion)}>{suggestion}<Icon name="chevron" size={12}/></button>)}</div></details>
        <button className="text-button danger remove-list" disabled={busy || chatBusy} onClick={() => setResetOpen(true)}>Reset demo</button>
      </>}
    </Panel>}
    {settingsOpen && settings && <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} onSave={async next => { setSettings(await window.tasksprig.saveSettings(next)); setSettingsOpen(false); setToast('Settings saved.'); }}/>}
    {resetOpen && <Panel title="Reset the demo?" onClose={() => setResetOpen(false)}>
      <p className="panel-description">This replaces your tasks, lists, routines, and conversation with the sample workspace. Model settings stay saved.</p>
      <div className="modal-footer"><button className="text-button" onClick={() => setResetOpen(false)}>Cancel</button><button className="text-button primary" disabled={busy} onClick={async () => { setBusy(true); try { const next = await window.tasksprig.resetDemo(); setSnapshot(next); setView(next.lists[0]?.id ?? 'all'); setResetOpen(false); setPanel(null); setToast('Demo reset.'); } catch (e) { setError(cleanError(e)); } finally { setBusy(false); } }}>Reset demo</button></div>
    </Panel>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function TaskRow({ task, reason, evaluation, tasks, now, timezone, busy, done, displayFields, act }: { task: Task; reason: string; evaluation?: TaskEvaluation; tasks: Task[]; now: string; timezone: string; busy: boolean; done: boolean; displayFields: ListDisplayField[]; act: Act }) {
  const [expanded, setExpanded] = useState(false);
  const checkboxRef = useRef<HTMLButtonElement>(null);
  const restoreCheckboxFocus = useRef(false);
  useLayoutEffect(() => {
    if (!busy && restoreCheckboxFocus.current) {
      restoreCheckboxFocus.current = false;
      if (document.activeElement === document.body || document.activeElement === checkboxRef.current) checkboxRef.current?.focus({ preventScroll: true });
    }
  }, [busy, done]);
  const children = tasks.filter(child => child.parentId === task.id && child.status !== 'dropped');
  const parent = tasks.find(parent => parent.id === task.parentId);
  const deferred = task.snoozedUntil && Date.parse(task.snoozedUntil) > Date.parse(now);
  const due = evaluation?.nextDueAt || task.dueAt;
  const displayReason = done ? task.recurring ? 'Done for this occurrence.' : 'Completed.' : deferred ? `Set aside until ${formatDate(task.snoozedUntil!, timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : reason || task.behaviorExplanation;
  const fieldValues: Record<ListDisplayField, string> = { estimateMinutes: minutesLabel(task.estimateMinutes), dueAt: relativeDue(due, now, timezone), tags: task.tags.join(' · '), reason: displayReason };
  const fields = displayFields.slice(0, 2).filter(field => !!fieldValues[field]);
  return <article data-task-id={task.id} className={`task-row ${done ? 'completed' : ''} ${expanded ? 'expanded' : ''}`}>
    <div className="task-row-main">
      <button ref={checkboxRef} className={`task-checkbox ${done ? 'checked' : ''}`} title={done ? 'Mark as not done' : 'Mark as done'} role="checkbox" aria-checked={done} aria-label={task.title} disabled={busy} onClick={() => { restoreCheckboxFocus.current = true; void act({ type: done ? 'uncomplete_task' : 'complete_task', id: task.id }); }}>{done && <Icon name="check" size={13}/>}</button>
      <button className="task-disclosure" aria-label={`Details for ${task.title}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="task-copy"><span className="task-title">{task.title}</span>{fields.length > 0 && <span className="task-fields">{fields.map(field => <span className={`task-field field-${field}`} data-field={field} key={field}>{fieldValues[field]}</span>)}</span>}</span><Icon name="chevron" size={13}/>
      </button>
    </div>
    {expanded && <div className="task-details">
      {parent && <p className="task-parent">Part of {parent.title}</p>}
      {!fields.includes('reason') && displayReason && <p>{displayReason}</p>}
      {task.notes && <p>{task.notes}</p>}
      <div className="task-meta">{task.tags.length > 0 && <span className="task-tags">{task.tags.join(' · ')}</span>}<span>{minutesLabel(task.estimateMinutes)}</span>{due && <span>{relativeDue(due, now, timezone)}</span>}{task.recurring && <span>Recurring</span>}</div>
      {children.length > 0 && <ul className="task-subtasks">{children.map(child => <li className={`subtask-row ${child.status === 'done' ? 'done' : ''}`} key={child.id}><span>{child.title}</span><span>{minutesLabel(child.estimateMinutes)}{child.status === 'done' ? ' · done' : ''}</span></li>)}</ul>}
      {evaluation?.error && <p className="chat-error">Timing needs a repair: {evaluation.error}</p>}
    </div>}
  </article>;
}

function Panel({ title, wide = false, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal panel ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><Icon name="close" size={16}/></button></div>{children}</section></div>;
}

function triggerLabel(routine: Routine, timezone: string) {
  if (routine.trigger.type === 'daily') {
    const [hours, minutes] = routine.trigger.time.split(':').map(Number);
    return `Daily at ${hours % 12 || 12}:${String(minutes || 0).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
  }
  if (routine.trigger.type === 'once') return formatDate(routine.trigger.at, timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return routine.trigger.taskId ? 'When its task is completed' : 'When a task is completed';
}

function routineScheduleLabel(routine: Routine, timezone: string) {
  const zone = routine.trigger.type === 'daily' ? routine.trigger.timezone : timezone;
  const zoneLabel = routine.trigger.type === 'task_completed' ? '' : ` (${zone})`;
  return `${routine.enabled ? '' : 'Paused — '}${triggerLabel(routine, timezone)}${zoneLabel}`;
}

function RoutineCard({ routine, snapshot, busy, act, onEdit }: { routine: Routine; snapshot: Snapshot; busy: boolean; act: Act; onEdit: () => void }) {
  const latestRun = snapshot.routineRuns.find(run => run.routineId === routine.id);
  return <article className="routine-card"><div className="routine-heading"><div><h3>{routine.name}</h3><p>{triggerLabel(routine, snapshot.timezone)}</p></div><button className={`toggle ${routine.enabled ? 'on' : ''}`} aria-label={`${routine.enabled ? 'Pause' : 'Enable'} ${routine.name}`} aria-pressed={routine.enabled} disabled={busy} onClick={() => void act({ type: 'update_routine', id: routine.id, patch: { enabled: !routine.enabled } }, routine.enabled ? 'Routine paused.' : 'Routine enabled.')}/></div><details className="inspector"><summary>Details</summary><p>{routine.instructions}</p><button className="text-button" onClick={onEdit}>Change routine</button>{latestRun && <><p>Last run: {latestRun.status} · {formatDate(latestRun.startedAt, snapshot.timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p><p>{latestRun.message}</p></>}</details></article>;
}

function Calendar({ snapshot, evaluations }: { snapshot: Snapshot; evaluations: Map<string, TaskEvaluation> }) {
  const [offset, setOffset] = useState(0);
  const days = Array.from({ length: 7 }, (_, index) => futureMorning(snapshot.now, snapshot.timezone, offset + index));
  const events = snapshot.tasks.filter(task => task.status === 'open').map(task => ({ task, due: evaluations.get(task.id)?.nextDueAt || task.dueAt })).filter(event => !!event.due);
  return <><div className="calendar-header"><span>{formatDate(days[0], snapshot.timezone, { month: 'short', day: 'numeric' })} – {formatDate(days[6], snapshot.timezone, { month: 'short', day: 'numeric', year: 'numeric' })}</span><div className="action-row"><button className="icon-button" aria-label="Previous week" onClick={() => setOffset(offset - 7)}><Icon name="arrowLeft" size={13}/></button><button className="text-button" onClick={() => setOffset(0)}>This week</button><button className="icon-button" aria-label="Next week" onClick={() => setOffset(offset + 7)}><Icon name="chevron" size={13}/></button></div></div><div className="calendar-grid">{days.map(day => <div key={day} className={`calendar-day ${dateKey(day, snapshot.timezone) === dateKey(snapshot.now, snapshot.timezone) ? 'current' : ''}`}><div className="day-label">{formatDate(day, snapshot.timezone, { weekday: 'short' })}</div><div className="day-number">{formatDate(day, snapshot.timezone, { day: 'numeric' })}</div>{events.filter(event => dateKey(event.due!, snapshot.timezone) === dateKey(day, snapshot.timezone)).map(({ task }) => <div key={task.id} className={`calendar-event ${task.recurring ? '' : 'deadline'}`}>{task.title}<small>{task.recurring ? 'Next occurrence' : 'Due'} · {minutesLabel(task.estimateMinutes)}</small></div>)}{snapshot.routines.filter(routine => routine.enabled && (routine.trigger.type === 'daily' || (routine.trigger.type === 'once' && dateKey(routine.trigger.at, snapshot.timezone) === dateKey(day, snapshot.timezone)))).map(routine => <div key={routine.id} className="calendar-event routine">{routine.name}<small>{routine.trigger.type === 'daily' ? routine.trigger.time : 'Scheduled'}</small></div>)}</div>)}</div><p className="panel-note">Dates show the next occurrence or deadline, not a reserved time block.</p></>;
}

function SettingsModal({ settings, onClose, onSave }: { settings: PublicSettings; onClose: () => void; onSave: (settings: { provider: Provider; model: string; apiKey?: string }) => Promise<void> }) {
  const [provider, setProvider] = useState<Provider>(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const updateProvider = (next: Provider) => { setProvider(next); setModel(defaultModels[next]); setApiKey(''); };
  const providerHasKey = settings.configuredProviders?.includes(provider) ?? (settings.hasApiKey && provider === settings.provider);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onSubmit={async event => { event.preventDefault(); setSaving(true); setError(''); try { await onSave({ provider, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }); } catch (e) { setError(cleanError(e)); } finally { setSaving(false); } }}><div className="modal-heading"><h2 id="settings-title">Make TaskSprig yours.</h2><button className="icon-button" type="button" aria-label="Close settings" onClick={onClose}><Icon name="close" size={14}/></button></div><p className="modal-intro">Your workspace lives on this Mac. Connect a cloud model for open-ended requests, or explore the scripted demo.</p><div className="settings-mode"><button type="button" className={provider === 'demo' ? 'selected' : ''} onClick={() => updateProvider('demo')}>Scripted demo<small>Try the example requests. No API key needed.</small></button><button type="button" className={provider !== 'demo' ? 'selected' : ''} onClick={() => updateProvider(settings.provider === 'demo' ? 'anthropic' : settings.provider)}>Your model<small>Real agent reasoning, custom behavior, and lists.</small></button></div>{provider !== 'demo' && <><div className="form-field"><label htmlFor="provider">Provider</label><select id="provider" value={provider} onChange={event => updateProvider(event.target.value as Provider)}><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="google">Google / Gemma</option></select></div><div className="form-field"><label htmlFor="model">Model ID</label><input id="model" value={model} onChange={event => setModel(event.target.value)} required placeholder={defaultModels[provider]}/><div className="field-help">Use a model available with your provider account.</div></div><div className="form-field"><label htmlFor="api-key">API key</label><input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={providerHasKey ? 'A key is available. Leave blank to keep it.' : 'Paste your provider API key'}/><div className="field-help">Each provider keeps its own key. Leave this blank to use its existing key. New keys are saved locally and never included in task behavior or conversations.</div></div></>}<div className="modal-note">{provider === 'demo' ? 'Demo mode uses deterministic example handling, not a language model. It is designed to demonstrate tasks, lists, routines, and time changing.' : 'Your requests and task context are sent to the selected provider to generate responses. Tasks and routines are stored locally.'}</div>{error && <div className="chat-error" style={{ marginTop: 14 }}>{error}</div>}<div className="modal-footer"><button type="button" className="text-button" onClick={onClose}>Cancel</button><button type="submit" className="text-button primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div></form></div>;
}
