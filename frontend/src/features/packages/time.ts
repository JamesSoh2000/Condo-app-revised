import { useEffect, useState } from 'react';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a package was received, in whole units rounded down: "just now", "N min ago", "N h ago", "N d ago".
 * A time ahead of `now` (another clock) reads "just now". Relative, so it needs no timezone.
 */
export function packageAge(receivedAt: string, now: number): string {
  const age = now - Date.parse(receivedAt);
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  return `${Math.floor(age / DAY)} d ago`;
}

/** The current time, as a state that moves on every `intervalMs`, so ages on screen move on without a request. */
export function useNow(intervalMs = MINUTE): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A date and time in the building's timezone and locale (P5-04 criterion 4), not the device's; undefined until the building loads. */
export function buildingTime(building: { locale: string; timezone: string } | undefined): Intl.DateTimeFormat | undefined {
  return building && new Intl.DateTimeFormat(building.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: building.timezone });
}
