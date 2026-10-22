/** Small readable examples used by the explicitly labelled offline demo interpreter. */
export const WEEKLY_UPKEEP = `(ctx) => {
  const day = 86400000;
  const base = Date.parse(ctx.task.lastCompletedAt || ctx.task.createdAt);
  const due = base + 7 * day;
  const lateDays = Math.max(0, Math.floor((ctx.now - due) / day));
  return {
    visible: ctx.now >= due,
    urgency: ctx.now < due ? 0 : Math.min(95, 35 + lateDays * 15),
    reason: ctx.now < due ? 'Not due yet — next watering ' + new Date(due).toISOString().slice(0, 10) : lateDays ? 'Watering is ' + lateDays + ' days overdue' : 'Weekly watering is due',
    nextDueAt: new Date(due).toISOString(),
    nextEvaluationAt: new Date(ctx.now < due ? due : ctx.now + day).toISOString()
  };
}`;

export function intervalUpkeep(days: number): string {
  return WEEKLY_UPKEEP.replace('7 * day', `${days} * day`).replace('Weekly watering is due', `Watering is due after ${days} days`);
}

/** Fixed local calendar cadence. A late completion never moves the weekday or day-of-month. */
export function fixedSchedule(period: 'daily' | 'weekly' | 'monthly', anchorDate: string): string {
  return `(ctx) => {
    const day = 86400000;
    const anchor = ${JSON.stringify(anchorDate)}.split('-').map(Number);
    const anchorDay = Date.UTC(anchor[0], anchor[1]-1, anchor[2]);
    const cal = ctx.calendar || {};
    const date = (cal.date || new Date(ctx.now).toISOString().slice(0,10)).split('-').map(Number);
    const today = Date.UTC(date[0], date[1]-1, date[2]);
    const monthly = ${period === 'monthly'};
    const step = ${period === 'weekly' ? 7 : 1};
    function atCycle(cycle) {
      let d;
      if (monthly) {
        const first = new Date(Date.UTC(anchor[0],anchor[1]-1+cycle,1));
        const lastDay = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
        d = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),Math.min(anchor[2],lastDay)));
      } else d = new Date(anchorDay + cycle * step * day);
      const key = d.toISOString().slice(0,10);
      const local = (cal.days || []).find(x => x.date === key);
      return d.getTime() + 9 * 3600000 - (local?.utcOffsetMinutes ?? cal.utcOffsetMinutes ?? 0) * 60000;
    }
    let cycle = Math.max(0, monthly ? (date[0]-anchor[0])*12 + date[1]-anchor[1] : Math.floor((today-anchorDay)/(step*day)));
    let due = atCycle(cycle);
    if (due > ctx.now && cycle > 0) { cycle -= 1; due = atCycle(cycle); }
    const completed = ctx.task.lastCompletedAt ? Date.parse(ctx.task.lastCompletedAt) : -Infinity;
    if (completed >= due) due = atCycle(cycle+1);
    const overdue = ctx.now >= due;
    return {
      visible: overdue,
      urgency: overdue ? Math.min(95,65 + Math.floor((ctx.now-due)/day)*5) : 0,
      reason: overdue ? 'Scheduled reminder is due. Follow your existing instructions; this reminder does not recommend catch-up doses.' : 'Next scheduled reminder: ' + new Date(due).toISOString().slice(0,10),
      nextDueAt: new Date(due).toISOString(),
      nextEvaluationAt: new Date(overdue ? ctx.now+3600000 : due).toISOString()
    };
  }`;
}

export const DEADLINE = `(ctx) => {
  const day = 86400000;
  const due = Date.parse(ctx.task.dueAt);
  const daysLeft = (due - ctx.now) / day;
  const blocked = ctx.task.dependencyIds.some(id => ctx.tasks.some(t => t.id === id && t.status === 'open'));
  return {
    visible: !blocked,
    urgency: blocked ? 0 : Math.min(100, Math.max(15, 85 - daysLeft * 10)),
    reason: blocked ? 'Waiting for the previous step' : daysLeft < 0 ? 'Deadline passed — this still needs attention' : 'Due in ' + Math.max(1, Math.ceil(daysLeft)) + ' days; leave time for the remaining steps',
    nextDueAt: ctx.task.dueAt,
    nextEvaluationAt: new Date(ctx.now + day).toISOString()
  };
}`;

export const FLEXIBLE = `(ctx) => ({
  visible: true,
  urgency: 15,
  reason: 'Flexible task — choose it when your time and energy fit',
  nextEvaluationAt: new Date(ctx.now + 86400000).toISOString(),
  nextDueAt: ctx.task.dueAt
})`;

export const PRIORITY_SELECTION = `(ctx) => {
  const candidates = ctx.tasks.filter(t => t.status === 'open'
    && !ctx.tasks.some(child => child.parentId === t.id && child.status === 'open')
    && !t.dependencyIds.some(id => ctx.tasks.some(other => other.id === id && other.status === 'open'))
    && (!t.snoozedUntil || Date.parse(t.snoozedUntil) <= ctx.now))
    .map(task => ({task, evaluation: ctx.evaluations.find(e => e.taskId === task.id)}))
    .filter(x => x.evaluation && x.evaluation.visible)
    .sort((a,b) => (b.evaluation.urgency + b.task.importance * 0.25) - (a.evaluation.urgency + a.task.importance * 0.25));
  return candidates.slice(0,3).map(x => ({taskId: x.task.id, reason: x.evaluation.reason + ' · about ' + x.task.estimateMinutes + ' min'}));
}`;

export function quickSelection(minutes: number): string {
  return `(ctx) => {
    let remaining = ${minutes};
    return ctx.tasks.filter(t => t.status === 'open'
      && !ctx.tasks.some(child => child.parentId === t.id && child.status === 'open')
      && !t.dependencyIds.some(id => ctx.tasks.some(other => other.id === id && other.status === 'open'))
      && (!t.snoozedUntil || Date.parse(t.snoozedUntil) <= ctx.now))
      .map(task => ({task, evaluation: ctx.evaluations.find(e => e.taskId === task.id)}))
      .filter(x => x.evaluation && x.evaluation.visible)
      .sort((a,b) => b.evaluation.urgency - a.evaluation.urgency)
      .filter(x => { if (x.task.estimateMinutes > remaining) return false; remaining -= x.task.estimateMinutes; return true; })
      .map(x => ({taskId:x.task.id, reason:'Fits your ${minutes}-minute window · about ' + x.task.estimateMinutes + ' min'}));
  }`;
}
