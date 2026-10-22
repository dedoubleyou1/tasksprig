const DAY = 86_400_000;

export function validTimezone(timezone: string): string {
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  return timezone;
}

export function localDate(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (name: string) => parts.find(part => part.type === name)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function shiftDay(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + amount * DAY).toISOString().slice(0, 10);
}

/** Convert a local wall-clock date to an instant; chooses the later side of a DST gap. */
export function atLocalTime(day: string, time: string, timezone: string): number {
  const target = Date.parse(`${day}T${time}:00Z`);
  let candidate = target;
  const seen: number[] = [];
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const parts = formatter.formatToParts(candidate);
    const value = (name: string) => parts.find(part => part.type === name)!.value;
    const wall = Date.parse(`${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}Z`);
    const delta = target - wall;
    if (!delta) return candidate;
    seen.push(candidate);
    candidate += delta;
    if (seen.includes(candidate)) return Math.max(candidate, ...seen);
  }
  return candidate;
}

export function nextDaily(now: number, time: string, timezone: string): number {
  const day = localDate(now, timezone);
  const today = atLocalTime(day, time, timezone);
  return today > now ? today : atLocalTime(shiftDay(day, 1), time, timezone);
}

export function latestDaily(now: number, time: string, timezone: string): number {
  const day = localDate(now, timezone);
  const today = atLocalTime(day, time, timezone);
  return today <= now ? today : atLocalTime(shiftDay(day, -1), time, timezone);
}

export function calendarContext(now: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const value = (name: string) => Number(parts.find(part => part.type === name)!.value);
  const year = value('year'), month = value('month'), day = value('day');
  const hour = value('hour'), minute = value('minute');
  const dayString = localDate(now, timezone);
  const days = Array.from({ length: 65 }, (_, index) => {
    const date = shiftDay(dayString, index - 2);
    const [year, month, day] = date.split('-').map(Number);
    const noon = atLocalTime(date, '12:00', timezone);
    return { date, year, month, day, weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
      utcOffsetMinutes: (Date.parse(`${date}T12:00:00Z`) - noon) / 60000 };
  });
  return { date: dayString, year, month, day, hour, minute,
    weekday: new Date(`${dayString}T12:00:00Z`).getUTCDay(),
    utcOffsetMinutes: (Date.UTC(year, month - 1, day, hour, minute) - Math.floor(now / 60000) * 60000) / 60000,
    days };
}
