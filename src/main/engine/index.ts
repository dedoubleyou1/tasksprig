import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  Action, ActionResult, Activity, ChatMessage, EngineAPI, EngineOptions, ListEntry,
  Routine, RoutineRun, Snapshot, Task, TaskEvaluation, TaskList,
} from '../../shared/types';
import { fixedSchedule, intervalUpkeep } from '../../shared/behaviors';
import { SnippetSandbox } from './sandbox';
import { StateStore } from './store';
import { atLocalTime, calendarContext, latestDaily, localDate, nextDaily, shiftDay, validTimezone } from './time';

const DAY = 86_400_000;
const COMPLETION_GRACE_MS = 30_000;
const DEFAULT_BEHAVIOR = `({ task, now }) => {
  const due = task.dueAt ? Date.parse(task.dueAt) : null;
  const remaining = due === null ? null : (due - now) / 86400000;
  return { visible: true, urgency: remaining === null ? 20 : Math.max(0, Math.min(100, 60 - remaining * 12)),
    reason: due === null ? 'Ready when you have capacity.' : remaining < 0 ? 'Past its due date.' : 'Time remaining before its deadline.',
    nextDueAt: task.dueAt, nextEvaluationAt: new Date(now + 3600000).toISOString() };
}`;
export const DEFAULT_SELECTION = `({ tasks, evaluations }) => evaluations
  .filter(e => e.visible && tasks.some(t => t.id === e.taskId && t.status === 'open'))
  .sort((a, b) => b.urgency - a.urgency)
  .map(e => ({ taskId: e.taskId, reason: e.reason }))`;

interface CompletionEvent { id: string; taskId: string; at: string; routineIds: string[]; }
type CompletionFields = Pick<Task, 'status' | 'completedAt' | 'lastCompletedAt' | 'completionHistory' | 'snoozedUntil'>;
interface CompletionChange {
  taskId: string; at: string; recordedAt: number; historyLength: number; before: CompletionFields; eventId: string;
  memberships: Array<{ listId: string; entry: ListEntry; index: number }>;
}
interface CompletionUndo { id: string; rootTaskId: string; changes: CompletionChange[]; }
interface ClearedCompletion { listId: string; taskId: string; at: string; }
interface StoredState {
  version: 1; tasks: Task[]; lists: TaskList[]; routines: Routine[];
  routineRuns: RoutineRun[]; activity: Activity[]; messages: ChatMessage[];
  completionEvents: CompletionEvent[]; completionUndo: CompletionUndo[]; clearedCompletions: ClearedCompletion[]; clockMs: number | null;
}

function emptyState(): StoredState {
  return { version: 1, tasks: [], lists: [], routines: [], routineRuns: [], activity: [], messages: [], completionEvents: [], completionUndo: [], clearedCompletions: [], clockMs: null };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const iso = (value: number): string => new Date(value).toISOString();
function date(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid date.`);
  return iso(Date.parse(value));
}
function text(value: unknown, name: string, limit = 2000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${name} must be text under ${limit} characters.`);
  return value;
}
function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}
function mergeKnown<T extends object>(original: T, patch: object, protectedKeys: string[] = []): T {
  const result = copy(original);
  for (const key of Object.keys(original)) {
    if (!protectedKeys.includes(key) && Object.prototype.hasOwnProperty.call(patch, key)) {
      (result as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
  }
  return result;
}

export class Engine implements EngineAPI {
  private state: StoredState = emptyState();
  private store!: StateStore;
  private sandbox!: SnippetSandbox;
  private initialized?: Promise<void>;
  private ticking = false;
  private cachedCalendar?: { minute: number; value: ReturnType<typeof calendarContext> };
  readonly timezone: string;

  constructor(private readonly options: EngineOptions) {
    this.timezone = validTimezone(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  async init(): Promise<void> {
    this.initialized ??= (async () => {
      [this.store, this.sandbox] = await Promise.all([
        StateStore.open(this.options.dataDir === ':memory:' ? ':memory:' : join(this.options.dataDir, 'tend.sqlite')),
        SnippetSandbox.create(),
      ]);
      this.state = this.store.read<StoredState>() ?? emptyState();
      if (this.state.version !== 1) throw new Error('This database version is not supported.');
      this.state.tasks.forEach(task => this.normalizeTags(task, task));
      this.state.lists = this.state.lists.filter(list => !list.ephemeral).map(list => ({ ...list, ephemeral: false,
        completedClearCode: list.completedClearCode ?? '',
        displayFields: (list.displayFields ?? ['reason']).map(field => (field as string) === 'category' ? 'tags' : field) }));
      this.state.completionUndo ??= [];
      this.state.clearedCompletions ??= [];
      for (const group of this.state.completionUndo) for (const change of group.changes) change.recordedAt ??= Date.now();
      // Claimed work is never silently retried after a crash: effects may already have landed.
      for (const run of this.state.routineRuns.filter(run => run.status === 'running')) {
        run.status = 'failed';
        run.finishedAt = this.timestamp();
        run.message = 'The app closed during this run. Refresh the list or ask the agent to run it again.';
      }
      this.persist();
    })();
    return this.initialized;
  }

  private now(): number { return this.state.clockMs ?? Date.now(); }
  private timestamp(): string { return iso(this.now()); }
  private calendar(now: number) {
    const minute = Math.floor(now / 60000);
    if (this.cachedCalendar?.minute !== minute) this.cachedCalendar = { minute, value: calendarContext(now, this.timezone) };
    return this.cachedCalendar.value;
  }
  private persist(): void {
    // Every write path uses this projection, including live refresh, routine claims,
    // clock changes, chat appends, and shutdown. Temporary subsets never reach SQLite.
    const lists = this.state.lists.filter(list => !list.ephemeral);
    const savedIds = new Set(lists.map(list => list.id));
    const completionUndo = this.state.completionUndo.map(group => ({ ...group, changes: group.changes.map(change => ({
      ...change, memberships: change.memberships.filter(membership => savedIds.has(membership.listId)),
    })) }));
    const clearedCompletions = this.state.clearedCompletions.filter(item => savedIds.has(item.listId));
    this.store.write({ ...this.state, lists, completionUndo, clearedCompletions });
  }
  private activity(kind: string, message: string): void {
    this.state.activity.unshift({ id: randomUUID(), at: this.timestamp(), kind, message } satisfies Activity);
    this.state.activity = this.state.activity.slice(0, 250);
  }

  private task(id: string): Task {
    const task = this.state.tasks.find(task => task.id === id);
    if (!task) throw new Error('That task no longer exists.');
    return task;
  }
  private list(id: string): TaskList {
    const list = this.state.lists.find(list => list.id === id);
    if (!list) throw new Error('That list no longer exists.');
    return list;
  }
  private routine(id: string): Routine {
    const routine = this.state.routines.find(routine => routine.id === id);
    if (!routine) throw new Error('That routine no longer exists.');
    return routine;
  }

  private validateEvaluation(value: unknown, taskId: string): TaskEvaluation {
    if (!value || typeof value !== 'object') throw new Error('Behavior must return an object.');
    const result = value as Record<string, unknown>;
    if (typeof result.visible !== 'boolean') throw new Error('Behavior must return a boolean visible field.');
    return {
      taskId, visible: result.visible, urgency: number(result.urgency, 'Urgency', 0, 100),
      reason: text(result.reason, 'Reason'), nextEvaluationAt: date(result.nextEvaluationAt, 'Next evaluation'),
      nextDueAt: date(result.nextDueAt, 'Next due date'),
    };
  }

  private evaluateTask(task: Task, now = this.now(), validateOnly = false): TaskEvaluation {
    const evaluation = this.validateEvaluation(this.sandbox.run(task.behaviorCode || DEFAULT_BEHAVIOR,
      { task, tasks: this.state.tasks, now, timezone: this.timezone, calendar: this.calendar(now) }, now), task.id);
    if (!validateOnly) {
      evaluation.completed = task.status === 'done' || (task.recurring && task.status === 'open'
        && !!task.lastCompletedAt && task.completionHistory.at(-1) === task.lastCompletedAt
        && (this.withinCompletionGrace(task.id, task.lastCompletedAt)
          || (evaluation.nextDueAt ? Date.parse(evaluation.nextDueAt) > now : !evaluation.visible)));
      if (task.status !== 'open') return { ...evaluation, visible: false, urgency: 0, reason: task.status === 'done' ? 'Completed.' : 'No longer needed.', nextDueAt: null };
      if (evaluation.completed) return { ...evaluation, visible: false, urgency: 0, reason: 'This occurrence is completed.' };
      if (task.snoozedUntil && Date.parse(task.snoozedUntil) > now) return { ...evaluation, visible: false, urgency: 0, reason: `Deferred until ${task.snoozedUntil}.` };
      const dependencies = task.dependencyIds.map(id => this.state.tasks.find(item => item.id === id)).filter(item => item && item.status === 'open');
      if (dependencies.length) return { ...evaluation, visible: false, urgency: 0, reason: `Waiting for: ${dependencies.map(item => item!.title).join(', ')}.` };
      if (this.state.tasks.some(item => item.parentId === task.id && item.status === 'open')) return { ...evaluation, visible: false, reason: 'The next actionable step is shown instead of this project.' };
    }
    return evaluation;
  }

  private evaluations(now = this.now()): TaskEvaluation[] {
    return this.state.tasks.map(task => {
      try { return this.evaluateTask(task, now); }
      catch (error) {
        return { taskId: task.id, visible: task.status === 'open', completed: task.status === 'done', urgency: 0, reason: 'Timing needs repair; your task is still saved.', nextEvaluationAt: null, nextDueAt: task.dueAt, error: String((error as Error).message) };
      }
    });
  }

  private listContext(now = this.now(), evaluations = this.evaluations()) {
    return { tasks: this.state.tasks, evaluations, now, timezone: this.timezone, calendar: this.calendar(now) };
  }

  private validateEntries(value: unknown, preserveCompletion = false): ListEntry[] {
    if (!Array.isArray(value) || value.length > 500) throw new Error('List selection must return an array of up to 500 entries.');
    const seen = new Set<string>();
    return value.map(entry => {
      if (!entry || typeof entry !== 'object') throw new Error('Each list entry needs a taskId and reason.');
      const taskId = text(entry.taskId, 'Task id', 100);
      this.task(taskId);
      return { taskId, reason: text(entry.reason, 'Selection reason'),
        ...(preserveCompletion && entry.completedAt ? { completedAt: date(entry.completedAt, 'Completed occurrence')! } : {}) };
    }).filter(entry => {
      if (seen.has(entry.taskId)) return false;
      seen.add(entry.taskId);
      return true;
    });
  }

  private select(list: TaskList, evaluations = this.evaluations(), refresh = false): ListEntry[] {
    if (!list.selectionCode.trim()) return refresh ? this.validateEntries(list.entries.filter(entry => !entry.completedAt)) : list.entries;
    return this.validateEntries(this.sandbox.run(list.selectionCode, this.listContext(this.now(), evaluations), this.now()));
  }

  private clearContext(list: TaskList, task: Task | object, completedAt: string) {
    return { task, completedAt, list: { id: list.id, name: list.name, mode: list.mode, lastRefreshedAt: list.lastRefreshedAt },
      now: this.now(), timezone: this.timezone, calendar: this.calendar(this.now()) };
  }

  private shouldClear(list: TaskList, task: Task | object, completedAt: string): boolean {
    if (!list.completedClearCode.trim()) return false;
    const result = this.sandbox.run(list.completedClearCode, this.clearContext(list, task, completedAt), this.now());
    if (typeof result !== 'boolean') throw new Error('Completed-row clearing must return a boolean.');
    return result;
  }

  private withinCompletionGrace(taskId: string, completedAt: string): boolean {
    const receipt = [...this.state.completionUndo].reverse().flatMap(group => group.changes)
      .find(change => change.taskId === taskId && change.at === completedAt);
    // The undo window is real elapsed time, independent of the simulated task clock.
    return Date.now() - (receipt?.recordedAt ?? Date.parse(completedAt)) < COMPLETION_GRACE_MS;
  }

  private reconcileEntries(list: TaskList, selected: ListEntry[], evaluations: TaskEvaluation[], refresh = false, explicitEntries = false): ListEntry[] {
    const retained: ListEntry[] = [];
    let clearError: string | undefined;
    for (const entry of list.entries) {
      if (!entry.completedAt) continue;
      const task = this.task(entry.taskId);
      if (task.lastCompletedAt !== entry.completedAt || !evaluations.find(item => item.taskId === task.id)?.completed) continue;
      let clear = false;
      if (!this.withinCompletionGrace(task.id, entry.completedAt)) {
        try { clear = refresh || this.shouldClear(list, task, entry.completedAt); }
        catch (error) { clearError = `Completed items kept: ${(error as Error).message}`; }
      }
      if (clear) {
        if (!this.state.clearedCompletions.some(item => item.listId === list.id && item.taskId === task.id && item.at === entry.completedAt)) {
          this.state.clearedCompletions.push({ listId: list.id, taskId: task.id, at: entry.completedAt });
        }
      } else retained.push(entry);
    }
    const retainedById = new Map(retained.map(entry => [entry.taskId, entry]));
    const entries = selected.filter(entry => retainedById.has(entry.taskId) || explicitEntries || !this.state.clearedCompletions.some(item =>
      item.listId === list.id && item.taskId === entry.taskId && this.task(entry.taskId).lastCompletedAt === item.at
      && evaluations.find(evaluation => evaluation.taskId === entry.taskId)?.completed))
      .map(entry => {
        const retainedEntry = retainedById.get(entry.taskId);
        if (retainedEntry) return retainedEntry;
        const clean = { ...entry }; delete clean.completedAt; return clean;
      });
    for (const entry of retained) if (!entries.some(item => item.taskId === entry.taskId)) entries.push(entry);
    // Explicit entries can request a history view. Those unmarked rows are not
    // subject to occurrence-clearing rules and do not recreate the original task.
    if (explicitEntries) this.state.clearedCompletions = this.state.clearedCompletions.filter(item =>
      item.listId !== list.id || !entries.some(entry => entry.taskId === item.taskId && !entry.completedAt));
    if (clearError) list.error = clearError; else delete list.error;
    return entries;
  }

  async getSnapshot(): Promise<Snapshot> {
    await this.init();
    const evaluations = this.evaluations();
    const priorCleared = JSON.stringify(this.state.clearedCompletions);
    this.state.clearedCompletions = this.state.clearedCompletions.filter(item => this.state.lists.some(list => list.id === item.listId)
      && this.state.tasks.some(task => task.id === item.taskId && task.lastCompletedAt === item.at)
      && evaluations.some(evaluation => evaluation.taskId === item.taskId && evaluation.completed));
    let changed = false;
    for (const list of this.state.lists) {
      try {
        const oldError = list.error;
        const selected = list.mode === 'live' ? this.select(list, evaluations) : list.entries;
        const entries = this.reconcileEntries(list, selected, evaluations);
        if (JSON.stringify(entries) !== JSON.stringify(list.entries) || list.error !== oldError) {
          list.entries = entries;
          if (list.mode === 'live') list.lastRefreshedAt = this.timestamp();
          changed = true;
        }
      } catch (error) {
        const message = (error as Error).message;
        if (list.error !== message) { list.error = message; changed = true; }
      }
    }
    if (changed || JSON.stringify(this.state.clearedCompletions) !== priorCleared) this.persist();
    const lists = this.state.lists.map(list => ({ ...list, entries: [...list.entries].sort((a, b) =>
      Number(!!a.completedAt || this.task(a.taskId).status === 'done') - Number(!!b.completedAt || this.task(b.taskId).status === 'done')) }));
    return copy({ tasks: this.state.tasks, evaluations, lists, routines: this.state.routines,
      routineRuns: this.state.routineRuns, activity: this.state.activity, messages: this.state.messages,
      now: this.timestamp(), simulated: this.state.clockMs !== null, timezone: this.timezone });
  }

  private validateTask(task: Task): void {
    if (!text(task.title, 'Title', 200).trim()) throw new Error('Give the task a title.');
    text(task.notes, 'Notes', 10000); text(task.category, 'Category', 100);
    text(task.behaviorExplanation, 'Behavior explanation', 4000); text(task.originalRequest, 'Original request', 10000);
    number(task.importance, 'Importance', 0, 100); number(task.estimateMinutes, 'Effort estimate', 0, 10080);
    if (!['open', 'done', 'dropped'].includes(task.status)) throw new Error('Unknown task status.');
    if (typeof task.recurring !== 'boolean') throw new Error('Recurring must be a boolean.');
    for (const key of ['dueAt', 'completedAt', 'lastCompletedAt', 'snoozedUntil'] as const) task[key] = date(task[key], key);
    if (!Array.isArray(task.completionHistory)) throw new Error('Completion history must be an array.');
    task.completionHistory = task.completionHistory.map(value => date(value, 'Completion date')!).slice(-250);
    if (!Array.isArray(task.dependencyIds)) throw new Error('Dependencies must be an array.');
    task.dependencyIds = [...new Set(task.dependencyIds)];
    for (const id of task.dependencyIds) {
      this.task(id);
      const visited = new Set<string>();
      const visit = (dependencyId: string): void => {
        if (dependencyId === task.id) throw new Error('Tasks cannot have circular dependencies.');
        if (visited.has(dependencyId)) return;
        visited.add(dependencyId);
        this.task(dependencyId).dependencyIds.forEach(visit);
      };
      visit(id);
    }
    if (task.parentId) {
      const parent = this.task(task.parentId);
      if (parent.id === task.id || parent.parentId || this.state.tasks.some(item => item.parentId === task.id)) throw new Error('Projects support one level of subtasks.');
    }
    if (!task.behaviorCode) task.behaviorCode = DEFAULT_BEHAVIOR;
    for (const offset of [-DAY, 0, DAY, 8 * DAY, 30 * DAY]) this.evaluateTask(task, this.now() + offset, true);
    if (task.recurring) this.evaluateTask({ ...task, lastCompletedAt: this.timestamp() }, this.now() + DAY, true);
  }

  private normalizeTags(task: Task, input: { tags?: unknown; category?: unknown }): void {
    const source = Object.prototype.hasOwnProperty.call(input, 'tags') ? input.tags
      : Object.prototype.hasOwnProperty.call(input, 'category') ? (input.category ? [input.category] : [])
      : task.tags ?? (task.category ? [task.category] : []);
    if (!Array.isArray(source)) throw new Error('Tags must be an array of text labels.');
    const tags: string[] = [];
    for (const raw of source) {
      const tag = text(raw, 'Tag', 80).trim();
      if (tag && !tags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) tags.push(tag);
    }
    if (tags.length > 12) throw new Error('Use at most twelve tags per task.');
    task.tags = tags;
    // Existing saved snippets can keep reading the old single-category property.
    task.category = tags.find(tag => tag.toLocaleLowerCase() === task.category?.toLocaleLowerCase()) ?? tags[0] ?? '';
  }

  private validateList(list: TaskList, preserveCompletion = false): void {
    if (!text(list.name, 'List name', 120).trim()) throw new Error('Give the list a name.');
    text(list.description, 'Description', 4000); text(list.instructions, 'Instructions', 10000);
    if (!['live', 'snapshot'].includes(list.mode)) throw new Error('List mode must be live or snapshot.');
    if (typeof list.ephemeral !== 'boolean') throw new Error('Temporary list state must be a boolean.');
    if (!Array.isArray(list.displayFields) || list.displayFields.length < 1 || list.displayFields.length > 2
      || new Set(list.displayFields).size !== list.displayFields.length
      || list.displayFields.some(field => !['estimateMinutes', 'dueAt', 'tags', 'reason'].includes(field))) {
      throw new Error('Choose one or two unique display fields: estimateMinutes, dueAt, tags, or reason.');
    }
    if (list.ephemeral && this.state.routines.some(routine => routine.listId === list.id)) {
      throw new Error('A list linked to a routine must stay saved. Unlink the routine before making it temporary.');
    }
    if (typeof list.selectionCode !== 'string') throw new Error('Selection code must be text.');
    text(list.completedClearCode, 'Completed-row clearing code', 20000);
    list.entries = this.validateEntries(list.entries, preserveCompletion);
    if (list.completedClearCode.trim()) {
      const sample = this.state.tasks[0] ?? { id: 'sample', title: 'Sample task', status: 'done', tags: [], category: '',
        notes: '', recurring: false, estimateMinutes: 15, importance: 50, completionHistory: [this.timestamp()],
        completedAt: this.timestamp(), lastCompletedAt: this.timestamp(), dueAt: null, createdAt: this.timestamp(),
        updatedAt: this.timestamp(), snoozedUntil: null, parentId: null, dependencyIds: [], originalRequest: '' };
      this.shouldClear(list, sample, iso(this.now() - COMPLETION_GRACE_MS - 1));
    }
    if (list.selectionCode.trim()) {
      for (const offset of [0, DAY, 8 * DAY]) {
        const now = this.now() + offset;
        const evaluations = this.evaluations(now);
        this.validateEntries(this.sandbox.run(list.selectionCode, this.listContext(now, evaluations), now));
      }
    }
  }

  private validateRoutine(routine: Routine): void {
    if (!text(routine.name, 'Routine name', 120).trim()) throw new Error('Give the routine a name.');
    text(routine.instructions, 'Routine instructions', 10000);
    if (typeof routine.enabled !== 'boolean') throw new Error('Enabled must be a boolean.');
    if (routine.listId) this.list(routine.listId);
    const trigger = routine.trigger;
    if (!trigger || typeof trigger !== 'object') throw new Error('A routine needs a trigger.');
    if (trigger.type === 'daily') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time)) throw new Error('Daily time must use HH:MM.');
      validTimezone(trigger.timezone);
    } else if (trigger.type === 'once') {
      trigger.at = date(trigger.at, 'Scheduled time')!;
      if (!trigger.at) throw new Error('A scheduled callback needs a time.');
    } else if (trigger.type === 'task_completed') {
      if (trigger.taskId) this.task(trigger.taskId);
    } else throw new Error('Unknown routine trigger.');
    if (typeof routine.conditionCode !== 'string') throw new Error('Condition code must be text.');
    if (routine.conditionCode.trim()) this.condition(routine);
  }

  private condition(routine: Routine): { run: boolean; reason?: string } {
    if (!routine.conditionCode.trim()) return { run: true };
    const result = this.sandbox.run<{ run: boolean; reason?: string }>(routine.conditionCode, this.listContext(), this.now());
    if (!result || typeof result.run !== 'boolean') throw new Error('Routine condition must return { run: boolean }.');
    if (result.reason !== undefined) text(result.reason, 'Condition reason');
    return result;
  }

  private schedule(routine: Routine): void {
    routine.nextRunAt = !routine.enabled || routine.trigger.type === 'task_completed' ? null
      : routine.trigger.type === 'once' ? routine.trigger.at
      : iso(nextDaily(this.now(), routine.trigger.time, routine.trigger.timezone));
  }

  private saveRoutineList(routine: Routine, now: string): void {
    if (!routine.listId) return;
    const list = this.list(routine.listId);
    if (list.ephemeral) {
      list.ephemeral = false;
      list.updatedAt = now;
      this.activity('save_list', `Saved “${list.name}” for its routine.`);
    }
  }

  private completionFields(task: Task): CompletionFields {
    return copy({ status: task.status, completedAt: task.completedAt, lastCompletedAt: task.lastCompletedAt,
      completionHistory: task.completionHistory, snoozedUntil: task.snoozedUntil });
  }

  private recordCompletion(task: Task, at: string, undo: CompletionUndo): void {
    const eventId = randomUUID();
    const change: CompletionChange = { taskId: task.id, at, recordedAt: Date.now(), historyLength: Math.min(250, task.completionHistory.length + 1),
      before: this.completionFields(task), eventId, memberships: [] };
    for (const list of this.state.lists) {
      const index = list.entries.findIndex(entry => entry.taskId === task.id);
      if (index >= 0) {
        change.memberships.push({ listId: list.id, entry: copy(list.entries[index]), index });
        list.entries[index] = { ...list.entries[index], completedAt: at };
      }
    }
    undo.changes.push(change);
    task.lastCompletedAt = at; task.completedAt = task.recurring ? null : at;
    task.completionHistory.push(at); task.completionHistory = task.completionHistory.slice(-250);
    task.status = task.recurring ? 'open' : 'done'; task.snoozedUntil = null; task.updatedAt = at;
    this.state.completionEvents.push({ id: eventId, taskId: task.id, at,
      routineIds: this.state.routines.filter(routine => routine.enabled && routine.trigger.type === 'task_completed'
        && (!routine.trigger.taskId || routine.trigger.taskId === task.id)).map(routine => routine.id) });
  }

  private latestCompletion(task: Task): { group: CompletionUndo; change: CompletionChange } | undefined {
    for (const group of [...this.state.completionUndo].reverse()) {
      const change = group.changes.find(change => change.taskId === task.id && change.at === task.lastCompletedAt
        && change.historyLength === task.completionHistory.length);
      if (change) return { group, change };
    }
    return undefined;
  }

  private undoCompletion(task: Task, now: string): boolean {
    if (task.status === 'dropped') throw new Error('This task was dropped; restore it before undoing a completion.');
    const latest = this.latestCompletion(task);
    if (!latest) {
      // Older databases have completion history but no undo receipt. Preserve the
      // prior history when available, rather than making those rows irreversible.
      if (task.status !== 'done' && (!task.recurring || !task.lastCompletedAt)) throw new Error('This task has no completion to undo.');
      const at = task.lastCompletedAt ?? task.completedAt;
      if (task.completionHistory.at(-1) === at) task.completionHistory.pop();
      task.lastCompletedAt = task.completionHistory.at(-1) ?? null;
      task.completedAt = null; task.status = 'open'; task.updatedAt = now;
      this.state.completionEvents = this.state.completionEvents.filter(event => event.taskId !== task.id || event.at !== at);
      this.state.clearedCompletions = this.state.clearedCompletions.filter(item => item.taskId !== task.id || item.at !== at);
      for (const list of this.state.lists) for (const entry of list.entries) if (entry.taskId === task.id) delete entry.completedAt;
      if (task.parentId && this.task(task.parentId).status === 'done') this.undoCompletion(this.task(task.parentId), now);
      return false;
    }
    const selected = latest.group.rootTaskId === task.id ? [...latest.group.changes] : [latest.change];
    if (task.parentId) {
      const parent = this.task(task.parentId);
      const parentCompletion = this.latestCompletion(parent);
      if (parent.status === 'done' && parentCompletion && !selected.includes(parentCompletion.change)) selected.push(parentCompletion.change);
    }
    let alreadyRan = false;
    for (const change of selected) {
      const current = this.task(change.taskId);
      if (current.status === 'dropped' || current.lastCompletedAt !== change.at || current.completionHistory.length !== change.historyLength) continue;
      const newerSnooze = current.snoozedUntil;
      Object.assign(current, copy(change.before), { updatedAt: now });
      if (newerSnooze !== null) current.snoozedUntil = newerSnooze;
      alreadyRan ||= this.state.routineRuns.some(run => run.id.endsWith(`:event:${change.eventId}`));
      this.state.completionEvents = this.state.completionEvents.filter(event => event.id !== change.eventId);
      this.state.clearedCompletions = this.state.clearedCompletions.filter(item => item.taskId !== current.id || item.at !== change.at);
      for (const list of this.state.lists) for (const entry of list.entries) if (entry.taskId === current.id) delete entry.completedAt;
      for (const membership of change.memberships) {
        const list = this.state.lists.find(list => list.id === membership.listId);
        if (list && !list.entries.some(entry => entry.taskId === current.id)) {
          const entry = { ...membership.entry }; delete entry.completedAt;
          list.entries.splice(Math.min(membership.index, list.entries.length), 0, entry);
        }
      }
      for (const group of this.state.completionUndo) group.changes = group.changes.filter(item => item !== change);
    }
    this.state.completionUndo = this.state.completionUndo.filter(group => group.changes.length);
    return alreadyRan;
  }

  async applyAction(action: Action): Promise<ActionResult> {
    await this.init();
    let id: string;
    let message: string;
    const now = this.timestamp();
    switch (action.type) {
      case 'create_task': {
        if (this.state.tasks.length >= 500) throw new Error('This demo supports up to 500 tasks.');
        const defaults: Task = { id: randomUUID(), title: '', notes: '', tags: ['Personal'], category: 'Personal', status: 'open',
          importance: 50, estimateMinutes: 15, createdAt: now, updatedAt: now, dueAt: null, completedAt: null,
          lastCompletedAt: null, completionHistory: [], snoozedUntil: null, parentId: null, dependencyIds: [],
          recurring: false, behaviorCode: DEFAULT_BEHAVIOR, behaviorExplanation: 'Available whenever you have capacity.', originalRequest: '' };
        const task = mergeKnown(defaults, action.task, ['id', 'createdAt', 'updatedAt']);
        this.normalizeTags(task, action.task);
        this.validateTask(task);
        this.state.tasks.push(task);
        id = task.id; message = `Added “${task.title}”.`;
        break;
      }
      case 'update_task': {
        const old = this.task(action.id);
        const task = mergeKnown(old, action.patch, ['id', 'createdAt', 'updatedAt']);
        this.normalizeTags(task, action.patch);
        task.updatedAt = now;
        this.validateTask(task);
        this.state.tasks[this.state.tasks.indexOf(old)] = task;
        id = task.id; message = `Updated “${task.title}”.`;
        break;
      }
      case 'complete_task': {
        const task = this.task(action.id);
        if (task.status !== 'open') throw new Error('That task is already closed.');
        if (task.recurring && this.evaluateTask(task).completed) throw new Error('This occurrence is already completed. Undo it to change the completion.');
        const undo: CompletionUndo = { id: randomUUID(), rootTaskId: task.id, changes: [] };
        this.recordCompletion(task, now, undo);
        for (const child of this.state.tasks.filter(item => item.parentId === task.id && item.status === 'open')) {
          this.recordCompletion(child, now, undo);
        }
        if (task.parentId) {
          const parent = this.task(task.parentId);
          if (!this.state.tasks.some(item => item.parentId === parent.id && item.status === 'open')) {
            this.recordCompletion(parent, now, undo);
          }
        }
        this.state.completionUndo.push(undo);
        this.state.completionUndo = this.state.completionUndo.slice(-250);
        id = task.id; message = task.recurring ? `Completed “${task.title}”; its next occurrence is ready.` : `Completed “${task.title}”.`;
        break;
      }
      case 'uncomplete_task': {
        const task = this.task(action.id);
        const alreadyRan = this.undoCompletion(task, now);
        id = task.id; message = `Undid completion of “${task.title}”.${alreadyRan ? ' Routines that already ran were left unchanged.' : ''}`;
        break;
      }
      case 'snooze_task': {
        const task = this.task(action.id);
        const until = date(action.until, 'Deferral date');
        if (!until || Date.parse(until) <= this.now()) throw new Error('Choose a future time to defer this task.');
        task.snoozedUntil = until; task.updatedAt = now;
        id = task.id; message = `Deferred “${task.title}”.`;
        break;
      }
      case 'drop_task': {
        const task = this.task(action.id);
        for (const item of [task, ...this.state.tasks.filter(item => item.parentId === task.id && item.status === 'open')]) {
          item.status = 'dropped'; item.updatedAt = now;
        }
        id = task.id; message = `Dropped “${task.title}”.`;
        break;
      }
      case 'create_list': {
        if (this.state.lists.length >= 50) throw new Error('This demo supports up to 50 lists.');
        const list = mergeKnown<TaskList>({ id: randomUUID(), name: '', description: '', mode: 'live', ephemeral: false, displayFields: ['reason'], completedClearCode: '', selectionCode: DEFAULT_SELECTION,
          instructions: '', entries: [], createdAt: now, updatedAt: now, lastRefreshedAt: null }, action.list, ['id', 'createdAt', 'updatedAt']);
        this.validateList(list);
        if (action.list.entries === undefined && !list.entries.length) list.entries = this.select(list);
        list.lastRefreshedAt = now;
        this.state.lists.push(list); id = list.id; message = `Created “${list.name}”.`;
        break;
      }
      case 'update_list': {
        const old = this.list(action.id);
        const list = mergeKnown(old, action.patch, ['id', 'createdAt', 'updatedAt']);
        this.validateList(list, action.patch.entries === undefined); list.updatedAt = now; delete list.error;
        if (action.patch.entries !== undefined) {
          const selected = list.entries; list.entries = old.entries;
          list.entries = this.reconcileEntries(list, selected, this.evaluations(), true, true);
        }
        this.state.lists[this.state.lists.indexOf(old)] = list;
        id = list.id; message = `Updated “${list.name}”.`;
        break;
      }
      case 'refresh_list': {
        const list = this.list(action.id);
        const evaluations = this.evaluations();
        const selected = action.entries === undefined ? this.select(list, evaluations, true) : this.validateEntries(action.entries);
        list.entries = this.reconcileEntries(list, selected, evaluations, true, action.entries !== undefined);
        list.lastRefreshedAt = now; list.updatedAt = now;
        id = list.id; message = `Refreshed “${list.name}”.`;
        break;
      }
      case 'show_list': {
        const list = this.list(action.id);
        return { id: list.id, message: `Opened “${list.name}”.` };
      }
      case 'delete_list': {
        const list = this.list(action.id);
        this.state.lists = this.state.lists.filter(item => item.id !== list.id);
        for (const routine of this.state.routines.filter(routine => routine.listId === list.id)) {
          routine.enabled = false; routine.listId = null; routine.nextRunAt = null;
        }
        id = list.id; message = `Removed “${list.name}”; its tasks are still saved.`;
        break;
      }
      case 'create_routine': {
        if (this.state.routines.length >= 50) throw new Error('This demo supports up to 50 routines.');
        const routine = mergeKnown<Routine>({ id: randomUUID(), name: '', instructions: '', trigger: { type: 'once', at: now },
          enabled: true, listId: null, conditionCode: '', createdAt: now, updatedAt: now, lastRunAt: null, nextRunAt: null }, action.routine, ['id', 'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt']);
        this.validateRoutine(routine); this.schedule(routine);
        this.saveRoutineList(routine, now);
        this.state.routines.push(routine); id = routine.id; message = `Scheduled “${routine.name}”.`;
        break;
      }
      case 'update_routine': {
        const old = this.routine(action.id);
        const routine = mergeKnown(old, action.patch, ['id', 'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt']);
        this.validateRoutine(routine); routine.updatedAt = now;
        if (JSON.stringify(routine.trigger) !== JSON.stringify(old.trigger) || old.enabled !== routine.enabled) this.schedule(routine);
        this.saveRoutineList(routine, now);
        this.state.routines[this.state.routines.indexOf(old)] = routine;
        id = routine.id; message = `Updated “${routine.name}”.`;
        break;
      }
      default: throw new Error('Unknown action.');
    }
    this.activity(action.type, message);
    this.persist();
    return { id, message };
  }

  async setClock(value: string | null): Promise<void> {
    await this.init();
    const parsed = date(value, 'Demo clock');
    const previousNow = this.now();
    this.state.clockMs = parsed ? Date.parse(parsed) : null;
    // Time travel is not undo, but schedules must resume from the restored clock.
    // Without rebasing, returning from a demo weeks ahead would silence daily work.
    if (this.now() < previousNow) {
      for (const routine of this.state.routines.filter(item => item.enabled && item.trigger.type === 'daily')) this.schedule(routine);
    }
    this.activity('clock', parsed ? `Demo clock moved to ${parsed}.` : 'Returned to the real clock.');
    this.persist();
  }

  async appendMessage(message: Omit<ChatMessage, 'id' | 'at'>): Promise<void> {
    await this.init();
    this.state.messages.push({ ...message, id: randomUUID(), at: this.timestamp() });
    this.state.messages = this.state.messages.slice(-250);
    this.persist();
  }

  async tick(runAgent: (routine: Routine, snapshot: Snapshot) => Promise<string>): Promise<void> {
    await this.init();
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Gather at most one time-based occurrence per routine, plus bounded completion events.
      const due: Array<{ routineId: string; key: string; scheduledFor: string; eventId?: string }> = [];
      for (const routine of this.state.routines.filter(item => item.enabled)) {
        if (routine.trigger.type === 'task_completed') {
          for (const event of this.state.completionEvents.filter(event => event.routineIds.includes(routine.id))) {
            due.push({ routineId: routine.id, key: `${routine.id}:event:${event.id}`, scheduledFor: event.at, eventId: event.id });
          }
        } else if (routine.nextRunAt && Date.parse(routine.nextRunAt) <= this.now()) {
          const scheduledFor = routine.trigger.type === 'daily'
            ? iso(latestDaily(this.now(), routine.trigger.time, routine.trigger.timezone)) : routine.trigger.at;
          due.push({ routineId: routine.id, key: `${routine.id}:${scheduledFor}`, scheduledFor });
        }
      }
      let executed = 0;
      for (const job of due) {
        if (job.eventId && !this.state.completionEvents.some(event => event.id === job.eventId)) continue;
        const routine = this.state.routines.find(item => item.id === job.routineId && item.enabled);
        if (this.state.routineRuns.some(run => run.id === job.key)) {
          if (routine && routine.trigger.type !== 'task_completed') {
            routine.nextRunAt = routine.trigger.type === 'daily' ? iso(nextDaily(this.now(), routine.trigger.time, routine.trigger.timezone)) : null;
          }
          continue;
        }
        if (!routine || executed >= 10) continue;
        executed++;
        const run: RoutineRun = { id: job.key, routineId: routine.id, scheduledFor: job.scheduledFor,
          status: 'running', startedAt: this.timestamp(), finishedAt: null, message: '' };
        this.state.routineRuns.unshift(run);
        routine.lastRunAt = this.timestamp();
        routine.nextRunAt = routine.trigger.type === 'daily' ? iso(nextDaily(this.now(), routine.trigger.time, routine.trigger.timezone)) : null;
        this.persist(); // Claim before any asynchronous work or external model call.
        try {
          const condition = this.condition(routine);
          run.message = condition.run ? await runAgent(copy(routine), await this.getSnapshot())
            : condition.reason ?? 'The callback condition did not match.';
          run.status = 'succeeded';
          this.activity('routine', `${routine.name}: ${condition.run ? 'finished' : 'condition skipped'}.`);
        } catch (error) {
          run.status = 'failed'; run.message = (error as Error).message;
          this.activity('routine_error', `${routine.name}: ${run.message}`);
        }
        run.finishedAt = this.timestamp();
        this.persist();
      }
      // Keep event evidence until every captured callback has a durable result.
      this.state.completionEvents = this.state.completionEvents.filter(event => event.routineIds.some(id =>
        this.state.routines.some(routine => routine.id === id && routine.enabled)
        && !this.state.routineRuns.some(run => run.id === `${id}:event:${event.id}`)));
      this.persist();
    } finally { this.ticking = false; }
  }

  async resetDemo(): Promise<void> {
    await this.init();
    if (this.ticking) throw new Error('Wait for the current routine to finish before resetting.');
    this.state = emptyState();
    this.state.clockMs = atLocalTime(localDate(Date.now(), this.timezone), '08:30', this.timezone);
    const now = this.now();
    await this.applyAction({ type: 'create_task', task: {
      title: 'Water the plants', category: 'Home', estimateMinutes: 5, importance: 45, recurring: true,
      originalRequest: 'I need to water the plants every two weeks.', lastCompletedAt: iso(now - 14 * DAY),
      behaviorExplanation: 'Quiet for two weeks after watering, then more prominent each day until completed. Estimated effort: 5 minutes.',
      behaviorCode: intervalUpkeep(14),
    } });
    const today = localDate(now, this.timezone);
    for (const example of [
      { title: 'Take daily medicine', period: 'daily' as const, anchor: shiftDay(today, -1), category: 'Health', estimateMinutes: 2 },
      { title: 'Weekly shot reminder', period: 'weekly' as const, anchor: shiftDay(today, -5), category: 'Health', estimateMinutes: 5 },
      { title: 'Give the dog monthly medicine', period: 'monthly' as const, anchor: shiftDay(today, -27), category: 'Pet care', estimateMinutes: 5 },
    ]) {
      await this.applyAction({ type: 'create_task', task: {
        title: example.title, category: example.category, estimateMinutes: example.estimateMinutes, importance: 80, recurring: true,
        lastCompletedAt: iso(atLocalTime(example.anchor, '09:00', this.timezone)),
        originalRequest: example.title, notes: 'Sample schedule at 9 AM; edit it to match your existing schedule.',
        behaviorExplanation: `A fixed ${example.period} calendar reminder at 9 AM. Late completion keeps the original cadence.`,
        behaviorCode: fixedSchedule(example.period, example.anchor),
      } });
    }
    const project = await this.applyAction({ type: 'create_task', task: {
      title: 'Submit a conference proposal', category: 'Work', estimateMinutes: 90, importance: 85,
      dueAt: iso(now + 3 * DAY), originalRequest: 'I need to submit a conference proposal in three days.',
      behaviorExplanation: 'Broken into three steps so the deadline leaves room to draft and review.',
    } });
    const first = await this.applyAction({ type: 'create_task', task: {
      title: 'Choose a proposal topic and outline', category: 'Work', estimateMinutes: 20, importance: 85,
      dueAt: iso(now + DAY), parentId: project.id, behaviorExplanation: 'Start here to leave time for the draft and submission.',
    } });
    const draft = await this.applyAction({ type: 'create_task', task: {
      title: 'Draft the proposal abstract', category: 'Work', estimateMinutes: 45, importance: 85,
      dueAt: iso(now + 2 * DAY), parentId: project.id, dependencyIds: [first.id],
    } });
    await this.applyAction({ type: 'create_task', task: {
      title: 'Review and submit the proposal', category: 'Work', estimateMinutes: 25, importance: 85,
      dueAt: iso(now + 3 * DAY), parentId: project.id, dependencyIds: [draft.id],
    } });
    await this.applyAction({ type: 'create_task', task: {
      title: 'Book a dentist appointment', category: 'Personal', estimateMinutes: 10, importance: 60,
      originalRequest: 'Remind me to book a dentist appointment.', behaviorExplanation: 'A quick call when you have a little time.',
    } });
    const priorities = await this.applyAction({ type: 'create_list', list: {
      name: 'Morning priorities', description: 'Three useful places to start. Refreshed each morning at 9.', mode: 'snapshot',
      displayFields: ['dueAt', 'reason'],
      instructions: 'Pick up to three actionable priorities, balancing urgency, importance, and effort. Explain each choice.',
      selectionCode: `({ tasks, evaluations }) => evaluations.filter(e => e.visible)
        .sort((a,b) => (b.urgency + (tasks.find(t => t.id === b.taskId)?.importance || 0) * .35) - (a.urgency + (tasks.find(t => t.id === a.taskId)?.importance || 0) * .35))
        .slice(0,3).map(e => ({taskId:e.taskId, reason:e.reason}))`,
    } });
    await this.applyAction({ type: 'create_list', list: {
      name: 'Small wins', description: 'Available actions that take 15 minutes or less.', mode: 'live',
      displayFields: ['estimateMinutes'],
      instructions: 'Show actionable tasks that take at most fifteen minutes.',
      selectionCode: `({tasks,evaluations}) => tasks.filter(t => t.estimateMinutes <= 15 && evaluations.some(e => e.taskId === t.id && e.visible))
        .map(t => ({ taskId:t.id, reason:t.estimateMinutes + ' minutes · ' + evaluations.find(e => e.taskId === t.id).reason }))`,
    } });
    await this.applyAction({ type: 'create_routine', routine: {
      name: 'Choose morning priorities', instructions: 'Refresh the Morning priorities list with up to three actionable priorities. Explain the choices briefly and ask whether they fit the day.',
      trigger: { type: 'daily', time: '09:00', timezone: this.timezone }, listId: priorities.id,
    } });
    this.state.messages = [{ id: randomUUID(), role: 'assistant', mode: 'demo', at: this.timestamp(),
      text: 'This is a sample workspace. I’ve arranged daily, weekly, and monthly reminders, plants every two weeks, a proposal with three steps, and two custom lists. Advance to 9 AM to run the morning routine, or tell me what you need to keep track of.' }];
    this.activity('demo', 'Loaded the sample workspace with a simulated clock.');
    this.persist();
  }

  async close(): Promise<void> {
    await this.init();
    this.persist();
    this.store.close();
  }
}
