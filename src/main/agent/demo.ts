import type { AgentOptions, ApplyAction, ListDisplayField, ListEntry, Snapshot, Task } from '../../shared/types';
import { DEADLINE, FLEXIBLE, PRIORITY_SELECTION, fixedSchedule, intervalUpkeep, quickSelection } from '../../shared/behaviors';
import { isCompletionHistoryRequest } from './intent';

const PREFIX = 'Demo mode · ';
const DAY = 86400000;

/** Deliberately narrow deterministic examples. Never presented as a live model or a general parser. */
export async function runDemo(text: string, snapshot: Snapshot, apply: ApplyAction, options: AgentOptions = {}): Promise<string> {
  const lower = text.toLowerCase();
  const now = Date.parse(snapshot.now);
  if (options.routine) {
    const routine = options.routine;
    const linked = snapshot.lists.find(list => list.id === routine.listId);
    if (linked) {
      if (!/priorit|three|\b3\b|check.?in/i.test(routine.instructions)) {
        if (!linked.selectionCode.trim()) return PREFIX + 'This routine needs a live model to interpret its custom instructions. Add an API key in Model settings; no list changes were made.';
        await apply({ type: 'refresh_list', id: linked.id });
        return PREFIX + `Refreshed “${linked.name}” using its saved selection code. A live model is needed to reinterpret the routine's custom instructions.`;
      }
      const entries = priorityEntries(snapshot).slice(0, 3);
      await apply({ type: 'refresh_list', id: linked.id, entries });
      const total = entries.reduce((sum, entry) => sum + (snapshot.tasks.find(task => task.id === entry.taskId)?.estimateMinutes || 0), 0);
      return PREFIX + `Refreshed “${linked.name}” with ${entries.length} actionable ${entries.length === 1 ? 'item' : 'items'} (about ${total} minutes). ${/check.?in/i.test(routine.instructions) ? 'How much time and energy do you have this morning?' : 'The selection stays stable until its next refresh.'}`;
    }
    return PREFIX + 'Your scheduled check-in is ready. How much time and energy do you have today? The offline demo supports linked priority lists; connect a model for custom routine instructions.';
  }

  const makeTemporary = /\b(?:make|keep) (?:this|that|current)(?: list)? (?:temporary|ephemeral)\b|\b(?:don't|do not) (?:save|keep) (?:this|that)(?: list)?\b/.test(lower);
  const saveCurrent = /\b(?:save|keep) (?:this|that|current)(?: list)?\b|\bmake (?:this|that|current)(?: list)? (?:permanent|persistent)\b/.test(lower);
  if (makeTemporary || saveCurrent) {
    const temporary = snapshot.lists.filter(list => list.ephemeral);
    const current = snapshot.lists.find(list => list.id === options.activeListId)
      ?? (temporary.length === 1 ? temporary[0] : snapshot.lists.length === 1 ? snapshot.lists[0] : undefined);
    if (!current) return PREFIX + 'Open the list you mean, then ask me to save it or make it temporary.';
    await apply({ type: 'update_list', id: current.id, patch: { ephemeral: makeTemporary } });
    return PREFIX + (makeTemporary ? `Made “${current.name}” temporary. Its tasks stay saved when you leave the list.` : `Saved “${current.name}”. It will stay available between sessions.`);
  }

  if (isCompletionHistoryRequest(text)) {
    const today = localDate(now, snapshot.timezone);
    const morning = /this morning/.test(lower);
    const todayOnly = morning || /today/.test(lower);
    const matches = (iso: string) => {
      if (!Number.isFinite(Date.parse(iso)) || Date.parse(iso) > now) return false;
      if (todayOnly && localDate(Date.parse(iso), snapshot.timezone) !== today) return false;
      return !morning || Number(new Intl.DateTimeFormat('en-US', { timeZone: snapshot.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso))) < 12;
    };
    const entries = snapshot.tasks.filter(task => [task.completedAt, task.lastCompletedAt, ...task.completionHistory].some(iso => iso && matches(iso)))
      .map(task => ({ taskId: task.id, reason: morning ? 'Finished this morning' : todayOnly ? 'Finished today' : 'Previously completed' }));
    await apply({ type: 'create_list', list: {
      name: morning ? 'Finished this morning' : todayOnly ? 'Finished today' : 'Completed items', mode: 'snapshot', ephemeral: true,
      displayFields: ['reason'], completedClearCode: '', entries, instructions: text,
    } });
    return PREFIX + `Brought back ${entries.length} completed ${entries.length === 1 ? 'item' : 'items'} in a temporary history list. Their recorded completions stay unchanged.`;
  }

  if (/plant|watering/.test(lower) && /watered|finished|completed|done/.test(lower)) {
    const task = snapshot.tasks.find(task => /plant|watering/i.test(task.title) && task.status === 'open');
    if (!task) return PREFIX + 'Add “I need to water the plants weekly” first, then record when you watered them.';
    if (/yesterday/.test(lower)) {
      await apply({ type: 'update_task', id: task.id, patch: { lastCompletedAt: new Date(now - DAY).toISOString() } });
      return PREFIX + 'Recorded that you watered the plants yesterday. The next watering now follows that completion date.';
    }
    await apply({ type: 'complete_task', id: task.id });
    return PREFIX + 'Watering recorded. Its next interval starts from this completion.';
  }

  if (/plant|watering/.test(lower)) {
    const days = /biweekly|every (?:two|2) weeks|fortnight/.test(lower) ? 14 : 7;
    const existing = snapshot.tasks.find(task => /water.*plant|plant.*water/i.test(task.title) && task.status === 'open');
    const task = {
      title: 'Water the plants', tags: ['Home', 'Plants'], importance: 40, estimateMinutes: 5,
      recurring: true, behaviorCode: intervalUpkeep(days),
      behaviorExplanation: `Estimated 5 minutes. Hidden until ${days} days after the last completion (or capture), then attention increases with each overdue day. Completion starts the next ${days}-day interval.`,
      originalRequest: text,
    };
    if (existing) await apply({ type: 'update_task', id: existing.id, patch: task });
    else await apply({ type: 'create_task', task });
    return PREFIX + `${existing ? 'Updated' : 'Added'} plant watering every ${days === 14 ? 'two weeks (interpreting biweekly as every 14 days)' : 'week'}. Estimated 5 minutes. It stays quiet until due and becomes more prominent if it slips; completing it resets the interval.`;
  }

  if (/medicine|medication|\bmeds\b|\bshots?\b/.test(lower)) {
    const period = /\bmonthly\b|\b(?:every|each) (?:1 |one )?month\b|\bonce a month\b/.test(lower) ? 'monthly'
      : /\bweekly\b|\b(?:every|each) (?:1 |one )?week\b|\bonce a week\b/.test(lower) ? 'weekly'
      : /\bdaily\b|\b(?:every|each) (?:1 |one )?day\b|\bonce a day\b/.test(lower) ? 'daily' : null;
    if (!period) return PREFIX + 'What schedule do you already follow for this medicine? I can record a daily, weekly, or monthly reminder in the offline demo.';
    const pet = /dog|pet/.test(lower);
    const title = pet ? 'Give the dog their scheduled medicine' : /\bshots?\b/.test(lower) ? `${period.charAt(0).toUpperCase() + period.slice(1)} shot reminder` : 'Take scheduled medicine';
    const existing = snapshot.tasks.find(task => task.title === title && task.status === 'open');
    const today = localDate(now, snapshot.timezone);
    const first = new Date(`${today}T12:00:00Z`);
    if (period === 'daily') first.setUTCDate(first.getUTCDate() + 1);
    else if (period === 'weekly') first.setUTCDate(first.getUTCDate() + 7);
    else {
      const targetMonth = first.getUTCMonth() + 1;
      const day = first.getUTCDate();
      first.setUTCDate(1); first.setUTCMonth(targetMonth);
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      first.setUTCDate(Math.min(day, last));
    }
    const anchor = first.toISOString().slice(0, 10);
    const task = {
      title, tags: pet ? ['Pet care', 'Health'] : ['Health'], importance: 85, estimateMinutes: /\bshots?\b/.test(lower) ? 5 : 2,
      recurring: true, behaviorCode: fixedSchedule(period, anchor), originalRequest: text,
      notes: 'Reminder only. Follow the existing prescribed instructions; no dose or missed-dose guidance is inferred.',
      behaviorExplanation: `Fixed ${period} reminder. Assumed first reminder ${anchor} at 09:00 local time; editable. A late completion does not shift the calendar cadence. No backlog of doses is created.`,
    };
    if (existing) await apply({ type: 'update_task', id: existing.id, patch: task });
    else await apply({ type: 'create_task', task });
    return PREFIX + `Added a fixed ${period} reminder, estimated ${task.estimateMinutes} minutes. I assumed the first reminder is ${anchor} at 9:00 AM; adjust that in a live-model conversation if needed. This records your schedule without inferring dosing or catch-up instructions.`;
  }

  if (/(every morning|daily|each morning|every day|each day)/.test(lower) && /(priorit|three|\b3\b|check.?in|check in)/.test(lower)) {
    const list = snapshot.lists.find(list => /morning priorit/i.test(list.name));
    const listId = list?.id ?? (await apply({ type: 'create_list', list: {
      name: 'Morning priorities', description: 'A small, stable selection for your day.', mode: 'snapshot', ephemeral: false, displayFields: ['dueAt', 'reason'], completedClearCode: '',
      selectionCode: PRIORITY_SELECTION, instructions: 'Pick up to three highest-priority actionable tasks each morning. Consider urgency, importance, effort and dependencies. Explain each choice.',
    } })).id;
    await apply({ type: 'refresh_list', id: listId, entries: priorityEntries(snapshot).slice(0, 3) });
    const explicitTime = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    let hour = explicitTime ? Number(explicitTime[1]) : 9;
    if (explicitTime?.[3] === 'pm' && hour < 12) hour += 12;
    if (explicitTime?.[3] === 'am' && hour === 12) hour = 0;
    const time = `${String(Math.min(23, hour)).padStart(2, '0')}:${explicitTime?.[2] ?? '00'}`;
    const existing = snapshot.routines.find(routine => routine.listId === listId);
    const routine = {
      name: 'Morning priorities', instructions: `${text}\nRefresh the linked snapshot list with up to three actionable priorities, short reasons, and estimated total time.`,
      trigger: { type: 'daily' as const, time, timezone: snapshot.timezone }, listId, enabled: true,
    };
    if (existing) await apply({ type: 'update_routine', id: existing.id, patch: routine });
    else await apply({ type: 'create_routine', routine });
    return PREFIX + `Created “Morning priorities” and a daily ${time} routine in ${snapshot.timezone}. It picks up to three actionable items and keeps the selection stable until refreshed. Advance the demo clock to see the callback run.`;
  }

  const minuteMatch = lower.match(/\b(\d+|five|ten|fifteen|twenty|thirty|forty[- ]five|sixty)[\s-]*(?:minutes?|mins?)\b/);
  if (minuteMatch && /have|can i|can you|things|tasks|list|quick/.test(lower)) {
    const writtenNumbers: Record<string, number> = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, 'forty five': 45, sixty: 60 };
    const minutes = Math.max(1, Math.min(480, writtenNumbers[minuteMatch[1]] ?? Number(minuteMatch[1])));
    const name = `${minutes}-minute window`;
    const reference = /\b(?:my|existing|saved|this|that|refresh|update)\b/.test(lower);
    const existing = snapshot.lists.find(list => list.name === name && list.ephemeral)
      ?? (reference ? snapshot.lists.find(list => list.name === name && !list.ephemeral) : undefined);
    const ephemeral = existing && !existing.ephemeral ? false : !keepList(lower);
    const list = { name, description: `Actionable tasks that fit within ${minutes} minutes total.`, mode: 'live' as const, ephemeral, displayFields: existing?.displayFields ?? ['estimateMinutes'] as ListDisplayField[], completedClearCode: existing?.completedClearCode ?? '(ctx) => ctx.now - Date.parse(ctx.completedAt) >= 60000', selectionCode: quickSelection(minutes), instructions: text };
    if (existing) await apply({ type: 'update_list', id: existing.id, patch: list });
    else await apply({ type: 'create_list', list });
    return PREFIX + `${existing ? 'Updated' : 'Created'} ${ephemeral ? 'a temporary' : 'a saved'} “${name}” list. It includes actionable tasks whose estimated total fits your available time.`;
  }

  if (/proposal|conference|application/.test(lower)) {
    const existing = snapshot.tasks.find(task => !task.parentId && /proposal/i.test(task.title) && task.status === 'open');
    if (existing) return PREFIX + 'The proposal is already captured with its next steps. Connect a live model to change the deadline or tailor the steps.';
    const due = nextFriday(snapshot);
    const parent = await apply({ type: 'create_task', task: {
      title: 'Submit conference proposal', tags: ['Work', 'Conference'], importance: 80, estimateMinutes: 90,
      dueAt: due, recurring: false, behaviorCode: DEADLINE, originalRequest: text,
      behaviorExplanation: 'Due Friday at 5 PM local time (editable assumption). Importance and urgency are separate; the next actionable step rises as the deadline approaches.',
    } });
    let previous: string | undefined;
    for (const [title, estimateMinutes] of [['Choose a proposal topic', 15], ['Draft the proposal abstract', 45], ['Review and submit the proposal', 30]] as const) {
      const result = await apply({ type: 'create_task', task: {
        title, tags: ['Work', 'Conference'], importance: 80, estimateMinutes, dueAt: due, parentId: parent.id,
        dependencyIds: previous ? [previous] : [], behaviorCode: DEADLINE,
        behaviorExplanation: 'Work on this step after its predecessor is complete; attention increases toward Friday.', originalRequest: text,
      } });
      previous = result.id;
    }
    return PREFIX + 'Split the proposal into three steps: choose a topic (15 min), draft the abstract (45 min), then review and submit (30 min). Assumed Friday at 5 PM local time. Lists surface the next unblocked step.';
  }

  if (/overdue|household|home tasks|waiting on/.test(lower)) {
    const overdue = /overdue/.test(lower);
    const waiting = /waiting/.test(lower);
    await apply({ type: 'create_list', list: {
      name: overdue ? 'Needs a nudge' : waiting ? 'Waiting on something' : 'Around the house', mode: 'live', ephemeral: !keepList(lower), instructions: text,
      displayFields: overdue ? ['dueAt', 'reason'] : waiting ? ['reason'] : ['tags'],
      completedClearCode: '',
      selectionCode: `(ctx) => ctx.tasks.filter(t => t.status === 'open' && ${overdue ? "ctx.evaluations.some(e => e.taskId === t.id && e.nextDueAt && Date.parse(e.nextDueAt) < ctx.now)" : waiting ? "t.dependencyIds.some(id => ctx.tasks.some(other => other.id === id && other.status === 'open'))" : "(t.tags || []).some(tag => /home|household/i.test(tag))"}).map(t => ({taskId:t.id,reason:${JSON.stringify(overdue ? 'Its due date has passed.' : waiting ? 'A prerequisite is still open.' : 'Part of your home care.')}}))`,
    } });
    return PREFIX + 'Created a live subset list. Its membership updates as tasks and time change.';
  }

  if (/\b(buy|clean|call|email|book|pay|read|write|organize|renew|return|fix)\b/.test(lower)) {
    const title = text.replace(/^(?:i (?:need|want) to|remind me to|please|can you remind me to)\s+/i, '').replace(/[.!?]$/, '');
    await apply({ type: 'create_task', task: { title: title.charAt(0).toUpperCase() + title.slice(1), estimateMinutes: 15, importance: 40, tags: ['Personal'], behaviorCode: FLEXIBLE, behaviorExplanation: 'Offline demo assumption: a flexible task estimated at 15 minutes. Connect a model for detailed timing inference.', originalRequest: text } });
    return PREFIX + 'Captured this as a flexible task with a 15-minute placeholder estimate. Connect a model for intelligent timing, effort estimates, and decomposition beyond these demo examples.';
  }

  return PREFIX + 'This offline interpreter supports plants weekly/biweekly, scheduled medicine reminders, a conference proposal, morning priorities, and a “20-minute window” list. Try one of those, or add an API key in Model settings for unrestricted requests.';
}

function keepList(text: string): boolean {
  return /\b(?:save|keep|maintain|reuse)\b[^.!?]*\b(?:list|selection|this|that|it|track)\b|\b(?:reusable|permanent|ongoing)\b|\b(?:name|call) (?:it|this list|the list)\b|\b(?:named|called)\s+\S/.test(text);
}

function priorityEntries(snapshot: Snapshot): ListEntry[] {
  const now = Date.parse(snapshot.now);
  const actionable = (task: Task) => task.status === 'open'
    && !snapshot.tasks.some(child => child.parentId === task.id && child.status === 'open')
    && !task.dependencyIds.some(id => snapshot.tasks.some(other => other.id === id && other.status === 'open'))
    && (!task.snoozedUntil || Date.parse(task.snoozedUntil) <= now);
  return snapshot.tasks.filter(actionable)
    .map(task => ({ task, evaluation: snapshot.evaluations.find(evaluation => evaluation.taskId === task.id) }))
    .filter(pair => pair.evaluation?.visible)
    .sort((a, b) => (b.evaluation!.urgency + b.task.importance * 0.25) - (a.evaluation!.urgency + a.task.importance * 0.25))
    .map(({ task, evaluation }) => ({ taskId: task.id, reason: evaluation!.nextDueAt && Date.parse(evaluation!.nextDueAt) < now ? 'Past its due date' : evaluation!.urgency >= 70 ? 'Needs attention soon' : task.importance >= 75 ? 'An important next step' : 'Ready for attention' }));
}

function localDate(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(name => parts.find(part => part.type === name)!.value).join('-');
}

function nextFriday(snapshot: Snapshot): string {
  const date = new Date(`${localDate(Date.parse(snapshot.now), snapshot.timezone)}T17:00:00Z`);
  const days = (5 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + (days || 7));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: snapshot.timezone, timeZoneName: 'longOffset' }).formatToParts(date);
  const offset = parts.find(part => part.type === 'timeZoneName')?.value.match(/GMT([+-])(\d{2}):(\d{2})/);
  const minutes = offset ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1) : 0;
  return new Date(date.getTime() - minutes * 60000).toISOString();
}
