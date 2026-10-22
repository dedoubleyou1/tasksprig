/** Shared wire contract. All dates are ISO timestamps; clock values are milliseconds. */
export type Provider = 'demo' | 'anthropic' | 'openai' | 'google';
export type TaskStatus = 'open' | 'done' | 'dropped';
export interface Task {
  id: string; title: string; notes: string; tags: string[];
  /** Compatibility alias for previously generated timing/list code. New code uses tags. */
  category?: string;
  status: TaskStatus; importance: number; estimateMinutes: number;
  createdAt: string; updatedAt: string; dueAt: string | null;
  completedAt: string | null; lastCompletedAt: string | null;
  completionHistory: string[]; snoozedUntil: string | null;
  parentId: string | null; dependencyIds: string[];
  recurring: boolean; behaviorCode: string; behaviorExplanation: string;
  originalRequest: string;
}
/** Code is a JS expression evaluating to function(ctx). It receives plain JSON only.
 * Task ctx = {task, tasks, now:number, timezone:string}.
 * Returns {visible:boolean, urgency:0..100, reason:string, nextEvaluationAt?:ISO|null,
 *          nextDueAt?:ISO|null}. Date calculations use ctx.now, never ambient Date.now().
 * Recurring completion leaves task open, appends history and updates lastCompletedAt.
 */
export interface TaskEvaluation {
  taskId: string; visible: boolean; urgency: number; reason: string;
  nextEvaluationAt: string | null; nextDueAt: string | null; error?: string;
  /** Engine-owned completion state for the current occurrence, independent of list visibility. */
  completed?: boolean;
}
export interface ListEntry {
  taskId: string; reason: string;
  /** Engine-owned marker keeping a completed occurrence available for undo in this list. */
  completedAt?: string;
}
export type ListDisplayField = 'estimateMinutes' | 'dueAt' | 'tags' | 'reason';
export interface TaskList {
  id: string; name: string; description: string; mode: 'live' | 'snapshot';
  /** Temporary subsets stay in memory only; promoting to false saves them normally. */
  ephemeral: boolean;
  /** One or two pieces of context chosen by the agent for collapsed task rows. */
  displayFields: ListDisplayField[];
  /** JS function(ctx) => boolean: true hides a completed row, never deletes its task/history.
   * ctx={task,completedAt,list:{id,name,mode,lastRefreshedAt},now,timezone,calendar}.
   * The engine always allows at least 30 seconds for undo. Empty means keep until refresh.
   */
  completedClearCode: string;
  /** JS function expression receiving {tasks, evaluations, now, timezone}, returning
   * Array<{taskId,reason}>. All tasks are available, including completed history;
   * ordinary action lists filter to open tasks and may deliberately include deferred ones. */
  selectionCode: string; instructions: string; entries: ListEntry[];
  createdAt: string; updatedAt: string; lastRefreshedAt: string | null;
  error?: string;
}
export type RoutineTrigger =
  | { type: 'daily'; time: string; timezone: string }
  | { type: 'once'; at: string }
  | { type: 'task_completed'; taskId: string | null };
export interface Routine {
  id: string; name: string; instructions: string; trigger: RoutineTrigger;
  enabled: boolean; listId: string | null;
  /** Optional JS function(ctx) returning {run:boolean,reason?:string}; same context as list. */
  conditionCode: string; createdAt: string; updatedAt: string;
  lastRunAt: string | null; nextRunAt: string | null;
}
export interface RoutineRun {
  id: string; routineId: string; scheduledFor: string;
  status: 'running' | 'succeeded' | 'failed'; startedAt: string;
  finishedAt: string | null; message: string;
}
export interface Activity { id: string; at: string; kind: string; message: string; }
export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; text: string; at: string;
  mode: 'demo' | 'live'; error?: boolean; focusListId?: string;
}
export interface ModelSettings { provider: Provider; model: string; apiKey: string; }
export interface PublicSettings { provider: Provider; model: string; hasApiKey: boolean; configuredProviders?: Provider[]; }
export interface Snapshot {
  tasks: Task[]; evaluations: TaskEvaluation[]; lists: TaskList[];
  routines: Routine[]; routineRuns: RoutineRun[]; activity: Activity[];
  messages: ChatMessage[]; now: string; simulated: boolean; timezone: string;
}
export type TaskInput = Pick<Task, 'title'> & Partial<Omit<Task, 'id' | 'title' | 'createdAt' | 'updatedAt'>>;
export type ListInput = Pick<TaskList, 'name'> & Partial<Omit<TaskList, 'id' | 'name' | 'createdAt' | 'updatedAt'>>;
export type RoutineInput = Pick<Routine, 'name' | 'instructions' | 'trigger'> & Partial<Omit<Routine, 'id' | 'name' | 'instructions' | 'trigger' | 'createdAt' | 'updatedAt'>>;
export type Action =
  | { type: 'create_task'; task: TaskInput }
  | { type: 'update_task'; id: string; patch: Partial<TaskInput> }
  | { type: 'complete_task'; id: string }
  | { type: 'uncomplete_task'; id: string }
  | { type: 'snooze_task'; id: string; until: string }
  | { type: 'drop_task'; id: string }
  | { type: 'create_list'; list: ListInput }
  | { type: 'update_list'; id: string; patch: Partial<ListInput> }
  | { type: 'refresh_list'; id: string; entries?: ListEntry[] }
  | { type: 'show_list'; id: string }
  | { type: 'delete_list'; id: string }
  | { type: 'create_routine'; routine: RoutineInput }
  | { type: 'update_routine'; id: string; patch: Partial<RoutineInput> };
export interface ActionResult { id: string; message: string; }
/** Engine public API, implemented by engine subagent. */
export interface EngineAPI {
  init(): Promise<void>;
  getSnapshot(): Promise<Snapshot>;
  applyAction(action: Action): Promise<ActionResult>;
  setClock(iso: string | null): Promise<void>;
  resetDemo(): Promise<void>;
  appendMessage(message: Omit<ChatMessage, 'id' | 'at'>): Promise<void>;
  /** Claims due runs durably and executes each once. No unbounded catchup. */
  tick(run: (routine: Routine, snapshot: Snapshot) => Promise<string>): Promise<void>;
  close(): Promise<void>;
}
export interface EngineOptions { dataDir: string; timezone?: string; }
/** Agent entry point: runAgent(text, snapshot, settings, applyAction, options?).
 * Return final human-facing string. Apply mutations through callback only.
 * options.routine means this is an automated run of saved user instructions.
 */
export interface AgentOptions { routine?: Routine; getSnapshot?: () => Promise<Snapshot>; activeListId?: string; }
export type ApplyAction = (action: Action) => Promise<ActionResult>;
export interface ChatResult { text: string; mode: 'demo' | 'live'; focusListId?: string; error?: boolean; }
export interface TranscriptionRequest { audio: Uint8Array | ArrayBuffer; mimeType: string; durationMs: number; }
export interface VoiceStreamEvent {
  sessionId: string;
  type: 'ready' | 'partial' | 'final' | 'error' | 'speech_started' | 'speech_stopped';
  text?: string;
  message?: string;
}
export interface VoiceAudioChunk { sessionId: string; audio: Uint8Array; }
export interface VoiceStreamStop { sessionId: string; cancel?: boolean; }
export interface TaskSprigAPI {
  snapshot(): Promise<Snapshot>;
  act(action: Action): Promise<Snapshot>;
  chat(text: string, activeListId?: string): Promise<ChatResult>;
  requestMicrophoneAccess(): Promise<void>;
  transcribeAudio(request: TranscriptionRequest): Promise<{ text: string }>;
  startVoiceStream(): Promise<{ sessionId: string }>;
  pushVoiceAudio(chunk: VoiceAudioChunk): Promise<void>;
  stopVoiceStream(request: VoiceStreamStop): Promise<void>;
  onVoiceStreamEvent(callback: (event: VoiceStreamEvent) => void): () => void;
  setClock(iso: string | null): Promise<Snapshot>;
  resetDemo(): Promise<Snapshot>;
  settings(): Promise<PublicSettings>;
  saveSettings(settings: { provider: Provider; model: string; apiKey?: string }): Promise<PublicSettings>;
  onChange(callback: () => void): () => void;
}
declare global { interface Window { tasksprig: TaskSprigAPI; } }
