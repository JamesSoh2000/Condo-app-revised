// A `datetime-local` value: a wall date and time, seconds optional.
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY = 86_400_000;

const formats = new Map<string, Intl.DateTimeFormat>();
function format(timeZone: string): Intl.DateTimeFormat {
  let found = formats.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(timeZone, found);
  }
  return found;
}

/** `Date.UTC`, without its mapping of years 0–99 to 1900–1999. */
function utc(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  return new Date(Date.UTC(2000, month - 1, day, hour, minute, second)).setUTCFullYear(year, month - 1, day);
}

/** The wall time `timeZone` shows at instant `t`, as milliseconds of a UTC date with the same fields. */
function wallAt(t: number, timeZone: string): number {
  const parts = Object.fromEntries(format(timeZone).formatToParts(t).map((part) => [part.type, Number(part.value)]));
  return utc(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * The instant (ISO, UTC) of a `datetime-local` value read in `timeZone`, the building's, never the device's (P6-02d
 * criterion 4); null when the value isn't a real date and time. As Temporal's `compatible`: a time the DST change
 * skips moves forward by the gap, a time it repeats is the earlier instant. Assumes at most one offset change within a
 * day either side.
 */
export function toInstant(local: string, timeZone: string): string | null {
  const match = LOCAL.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const wall = utc(year, month, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  // The offsets a day before and after: a candidate is right if the zone shows `wall` at it.
  const before = wall - (wallAt(wall - DAY, timeZone) - (wall - DAY));
  const after = wall - (wallAt(wall + DAY, timeZone) - (wall + DAY));
  const right = [before, after].filter((t) => wallAt(t, timeZone) === wall);
  // None is right in a gap: the offset from before it lands the gap's length later.
  return new Date(right.length ? Math.min(...right) : before).toISOString();
}

/** The `datetime-local` value `timeZone` shows at `iso`; seconds only when they aren't zero. */
export function toLocalInput(iso: string, timeZone: string): string {
  const wall = new Date(wallAt(Date.parse(iso), timeZone)).toISOString();
  return wall.endsWith(':00.000Z') ? wall.slice(0, 16) : wall.slice(0, 19);
}
