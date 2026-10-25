/**
 * P6-02d criterion 4: a `datetime-local` value is a wall time in the building's timezone, never the device's. Two zones,
 * so at least one isn't the test machine's; DST's skipped and repeated hours resolve as Temporal's `compatible`.
 */
import { describe, expect, it } from 'vitest';

import { toInstant, toLocalInput } from '@/features/notices/expiry';

const TORONTO = 'America/Toronto';
const TOKYO = 'Asia/Tokyo';

describe('toInstant (criterion 4)', () => {
  it.each([
    ['18:00 in summer is EDT', '2026-07-15T18:00', TORONTO, '2026-07-15T22:00:00.000Z'],
    ['18:00 in winter is EST', '2026-12-15T18:00', TORONTO, '2026-12-15T23:00:00.000Z'],
    ['18:00 on the day DST ends is EST', '2026-11-01T18:00', TORONTO, '2026-11-01T23:00:00.000Z'],
    ['18:00 on the day DST starts is EDT', '2026-03-08T18:00', TORONTO, '2026-03-08T22:00:00.000Z'],
    ['a skipped time moves forward by the gap', '2026-03-08T02:30', TORONTO, '2026-03-08T07:30:00.000Z'],
    ['a repeated time is the earlier one', '2026-11-01T01:30', TORONTO, '2026-11-01T05:30:00.000Z'],
    ['midnight in Tokyo is the day before in UTC', '2026-07-15T00:00', TOKYO, '2026-07-14T15:00:00.000Z'],
    ['a year boundary', '2027-01-01T08:59', TOKYO, '2026-12-31T23:59:00.000Z'],
    ['a year below 100 is that year, not 19xx', '0050-06-01T12:00', TOKYO, '0050-06-01T02:41:01.000Z'],
    ['seconds are kept when the input has them', '2026-07-15T18:00:30', TORONTO, '2026-07-15T22:00:30.000Z'],
  ])('%s', (_, local, zone, instant) => {
    expect(toInstant(local, zone)).toBe(instant);
  });

  it('is null for an empty or malformed value', () => {
    expect(toInstant('', TORONTO)).toBeNull();
    expect(toInstant('2026-13-01T10:00', TORONTO)).toBeNull();
    expect(toInstant('2026-02-30T10:00', TORONTO)).toBeNull();
    expect(toInstant('tomorrow', TORONTO)).toBeNull();
  });
});

describe('toLocalInput (criterion 4: an existing expiry shows in building time)', () => {
  it.each([
    ['2026-07-15T22:00:00Z', TORONTO, '2026-07-15T18:00'],
    ['2026-12-15T23:00:00Z', TORONTO, '2026-12-15T18:00'],
    ['2026-11-01T05:30:00Z', TORONTO, '2026-11-01T01:30'],
    ['2026-11-01T06:30:00Z', TORONTO, '2026-11-01T01:30'],
    ['2026-07-14T15:00:00Z', TOKYO, '2026-07-15T00:00'],
    ['2026-07-15T22:00:45.5Z', TORONTO, '2026-07-15T18:00:45'],
  ])('%s in %s is %s', (iso, zone, local) => {
    expect(toLocalInput(iso, zone)).toBe(local);
  });

  it('round-trips every hour of a DST-change day, except the repeated hour’s second pass', () => {
    for (let hour = 0; hour < 24; hour++) {
      const local = `2026-11-01T${String(hour).padStart(2, '0')}:15`;
      expect(toLocalInput(toInstant(local, TORONTO)!, TORONTO)).toBe(local);
    }
  });
});
