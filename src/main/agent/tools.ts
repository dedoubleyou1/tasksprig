import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import type { Action, ApplyAction, Snapshot } from '../../shared/types';
import { tasksForModel } from './context';

const text = (description: string, maxLength = 4000) => Type.String({ description, maxLength });
const id = () => text('Existing record ID returned by a tool or shown in the context.', 120);
const date = () => Type.Union([text('ISO 8601 timestamp including timezone offset.', 50), Type.Null()]);
const code = (description: string) => text(description, 32000);
const entry = Type.Object({ taskId: id(), reason: text('Short phrase explaining this choice; it may appear inline beside the task title.', 160) }, { additionalProperties: false });
const displayFields = () => Type.Array(Type.Union([
  Type.Literal('estimateMinutes'), Type.Literal('dueAt'), Type.Literal('tags'), Type.Literal('reason'),
]), { minItems: 1, maxItems: 2, uniqueItems: true, description: 'Choose one or two distinct fields shown beside each collapsed task title, in display order. Match this list’s purpose; effort is not always useful.' });
const taskFields = {
  title: text('Concise actionable title.', 300),
  notes: Type.Optional(text('Useful context and editable assumptions.')),
  tags: Type.Optional(Type.Array(text('A short, useful context tag; reuse an existing name when it fits.', 80), { maxItems: 12, uniqueItems: true, description: 'Flexible overlapping tags, usually one to three. Infer useful contexts rather than assigning a fixed category.' })),
  importance: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  estimateMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 10080 })),
  dueAt: Type.Optional(date()),
  lastCompletedAt: Type.Optional(date()),
  snoozedUntil: Type.Optional(date()),
  parentId: Type.Optional(Type.Union([id(), Type.Null()])),
  dependencyIds: Type.Optional(Type.Array(id(), { maxItems: 20 })),
  recurring: Type.Optional(Type.Boolean()),
  behaviorCode: Type.Optional(code('JavaScript function expression (ctx) => result for temporal relevance. See system contract.')),
  behaviorExplanation: Type.Optional(text('Plain-language description of inferred temporal behavior and assumptions.')),
  originalRequest: Type.Optional(text('Original short request that this task represents.')),
};
const listFields = {
  name: text('Short descriptive list name.', 120),
  description: Type.Optional(text('What the list helps with.', 1000)),
  mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('snapshot')])),
  ephemeral: Type.Optional(Type.Boolean({ description: 'Choose true for temporary selections, false for lists with ongoing value. Infer the lifetime from intent; temporary lists disappear when leaving them.' })),
  displayFields: Type.Optional(displayFields()),
  completedClearCode: Type.Optional(code('Function(ctx) => boolean: true hides a completed row. Empty string keeps it until refresh. Context includes task, completedAt, list, now, timezone, calendar. Engine enforces at least 30 seconds for undo.')),
  selectionCode: Type.Optional(code('Function(ctx) returning [{taskId,reason}], with tasks, evaluations, now, timezone.')),
  instructions: Type.Optional(text('Saved user intent for future agent refreshes.')),
  entries: Type.Optional(Type.Array(entry, { maxItems: 100 })),
};
const trigger = Type.Union([
  Type.Object({ type: Type.Literal('daily'), time: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }), timezone: text('IANA timezone, e.g. America/New_York.', 80) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('once'), at: Type.String({ maxLength: 50 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('task_completed'), taskId: Type.Union([id(), Type.Null()]) }, { additionalProperties: false }),
]);
const routineFields = {
  name: text('Short routine name.', 120),
  instructions: text('Standing user request to execute on every trigger.'),
  trigger,
  enabled: Type.Optional(Type.Boolean()),
  listId: Type.Optional(Type.Union([id(), Type.Null()])),
  conditionCode: Type.Optional(code('Optional function(ctx) returning {run:boolean,reason?:string}. Empty means always run.')),
};

/** Tool schemas restrict the model to app actions; the engine validates cross-record invariants and code. */
export function createAgentTools(apply: ApplyAction, getSnapshot?: () => Promise<Snapshot>, onClarification?: (question: string) => void): AgentTool[] {
  const requireRecurringBehavior = (task: { behaviorCode?: unknown; behaviorExplanation?: unknown }) => {
    if (typeof task.behaviorCode !== 'string' || !task.behaviorCode.trim()
      || typeof task.behaviorExplanation !== 'string' || !task.behaviorExplanation.trim()) {
      throw new Error('A new recurring task requires explicit behaviorCode and behaviorExplanation. Write its timing function; the generic default does not implement recurrence.');
    }
  };
  const tool = (name: string, description: string, parameters: TSchema, action: (params: any) => Action | Promise<Action>): AgentTool => ({
    name, label: name.replaceAll('_', ' '), description, parameters, executionMode: 'sequential',
    execute: async (_callId, params, signal) => {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const result = await apply(await action(params));
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
  const tools: AgentTool[] = [
    tool('create_task', 'Save an inferred task or a parent/subtask. The result includes its ID. Include effort and custom timing behavior. A recurring task requires explicit behaviorCode AND behaviorExplanation.', object(taskFields), task => {
      if (task.recurring === true) requireRecurringBehavior(task);
      return { type: 'create_task', task };
    }),
    tool('update_task', 'Revise an existing task, including effort, timing code, dependencies, or last completion. Omitted fields stay unchanged. Making a nonrecurring task recurring requires new behaviorCode AND behaviorExplanation.', object({ id: id(), patch: Type.Partial(object(taskFields)) }), async p => {
      if (p.patch.recurring === true) {
        const existing = getSnapshot ? (await getSnapshot()).tasks.find(task => task.id === p.id) : undefined;
        if (!existing?.recurring) requireRecurringBehavior(p.patch);
      }
      return { type: 'update_task', id: p.id, patch: p.patch };
    }),
    tool('complete_task', 'Record completion. Recurring tasks stay open and schedule their next occurrence using behavior code.', object({ id: id() }), p => ({ type: 'complete_task', id: p.id })),
    tool('uncomplete_task', 'Undo the latest recorded completion when the user requests a correction. Reopen a one-time task or restore the previous completion anchor for a recurring task; retain the task.', object({ id: id() }), p => ({ type: 'uncomplete_task', id: p.id })),
    tool('snooze_task', 'Defer attention until a given timestamp.', object({ id: id(), until: Type.String({ maxLength: 50 }) }), p => ({ type: 'snooze_task', id: p.id, until: p.until })),
    tool('drop_task', 'Mark a task no longer needed, preserving its history. Only when requested by the user.', object({ id: id() }), p => ({ type: 'drop_task', id: p.id })),
    tool('create_list', 'Create a custom subset list, choosing its lifetime, one or two displayFields, and when completed rows clear. Quick/ad-hoc selections usually use ephemeral:true; ongoing tracking, explicitly saved lists and recurring routines use false. Infer from intent. Use live for dynamic filters and snapshot for stable selections.', object({ ...listFields, ephemeral: Type.Boolean({ description: 'Required lifetime decision: temporary selection=true, ongoing or saved list=false.' }), displayFields: displayFields(), completedClearCode: code('Required clearing decision: empty string keeps completed rows until refresh; otherwise function(ctx)=>boolean hides them when appropriate. At least 30 seconds of undo time is always enforced.') }), list => ({ type: 'create_list', list })),
    tool('update_list', 'Change an existing list purpose, selection behavior, name, entries, or displayFields. Omit displayFields to preserve its presentation on an ordinary refresh. Set ephemeral:false to save a temporary list when requested. Do not overwrite an unrelated permanent list for an ad-hoc request.', object({ id: id(), patch: Type.Partial(object(listFields)) }), p => ({ type: 'update_list', id: p.id, patch: p.patch })),
    tool('refresh_list', 'Refresh a saved selection. Supply entries for an agent-reasoned choice or omit entries to run its selection code.', object({ id: id(), entries: Type.Optional(Type.Array(entry, { maxItems: 100 })) }), p => ({ type: 'refresh_list', id: p.id, ...(p.entries === undefined ? {} : { entries: p.entries }) })),
    tool('show_list', 'Open an existing list in the main view without changing it. Use when the user asks to show/open/view a named saved list; do not recreate it.', object({ id: id() }), p => ({ type: 'show_list', id: p.id })),
    tool('delete_list', 'Remove a custom list only when the user explicitly requests its removal. Underlying tasks are retained.', object({ id: id() }), p => ({ type: 'delete_list', id: p.id })),
    tool('create_routine', 'Save a standing request triggered daily, once, or by task completion. Do not duplicate existing routines.', object(routineFields), routine => ({ type: 'create_routine', routine })),
    tool('update_routine', 'Revise or pause an existing routine; enabled:false pauses it.', object({ id: id(), patch: Type.Partial(object(routineFields)) }), p => ({ type: 'update_routine', id: p.id, patch: p.patch })),
  ];
  if (getSnapshot) tools.unshift({
    name: 'read_snapshot', label: 'Read current tasks and lists',
    description: 'Read fresh persisted tasks, evaluated relevance, lists and routines after changes. Use before selecting priorities if you just changed tasks or timing.',
    parameters: object({}),
    execute: async (_callId, _params, signal) => {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const snapshot = await getSnapshot();
      const data = { tasks: tasksForModel(snapshot.tasks), evaluations: snapshot.evaluations, lists: snapshot.lists, routines: snapshot.routines, now: snapshot.now, timezone: snapshot.timezone };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: { taskCount: snapshot.tasks.length, listCount: snapshot.lists.length } };
    },
  });
  if (onClarification) tools.push({
    name: 'request_clarification', label: 'Ask one necessary question',
    description: 'Use only when genuinely missing information materially prevents fulfilling the request. Never ask whether to save a requested list or task: that is already authorized. Do not use for optional preferences.',
    parameters: object({ question: text('One concise question for the user.', 500), whyNeeded: text('The missing information that prevents a correct result.', 500) }),
    execute: async (_callId, rawParams, signal) => {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const params = rawParams as { question: string; whyNeeded: string };
      onClarification(params.question);
      return { content: [{ type: 'text', text: params.question }], details: { question: params.question }, terminate: true };
    },
  });
  return tools;
}
