/**
 * P6-04c `buildTimeline` (criteria 1a, 1b): the merge of the request's row, its status events and its comments. Review
 * round 1 (Codex gpt-6.1-sol) F2 and F3.
 */
import { describe, expect, it } from 'vitest';

import { buildTimeline } from '@/features/maintenance/Timeline';
import { maintenanceRequest } from '@/test/maintenance';
import { comment, statusEvent } from '@/test/maintenanceView';

const REQUEST = maintenanceRequest(1, { submitted_at: '2026-10-21T11:00:00Z' });
const names = (entries: ReturnType<typeof buildTimeline>) => entries.map((entry) => entry.body ?? entry.title);

describe('review round 1 (Codex gpt-6.1-sol)', () => {
  it('F3: orders microsecond timestamps in one millisecond by time, before the status-first tie rule', () => {
    const earlier = comment('2026-10-21T12:00:00.000100Z', { body: 'Earlier comment' });
    const later = statusEvent('2026-10-21T12:00:00.000900Z', 'submitted', 'in_progress');
    expect(names(buildTimeline(REQUEST, { items: [later], more: false }, { items: [earlier], more: false }))).toEqual([
      'Submitted',
      'Earlier comment',
      'Work started',
    ]);
  });

  it('F3 neighbour: the same instant written with and without a fraction is a tie, the status change first', () => {
    const atComment = comment('2026-10-21T12:00:00Z', { body: 'Same instant' });
    const atEvent = statusEvent('2026-10-21T12:00:00.000000Z', 'submitted', 'in_progress');
    expect(names(buildTimeline(REQUEST, { items: [atEvent], more: false }, { items: [atComment], more: false }))).toEqual([
      'Submitted',
      'Work started',
      'Same instant',
    ]);
  });

  it('F3 neighbour: an offset other than Z compares by the instant it names', () => {
    const utc = comment('2026-10-21T12:00:00.5Z', { body: 'UTC' });
    const offset = statusEvent('2026-10-21T08:00:00.4-04:00', 'submitted', 'in_progress');
    expect(names(buildTimeline(REQUEST, { items: [offset], more: false }, { items: [utc], more: false }))).toEqual(['Submitted', 'Work started', 'UTC']);
  });

  it('F2: a comment whose time is earlier than the one before it in the API’s order stays after it', () => {
    // A transaction that started first commits last: a larger id with an earlier `created_at`.
    const first = comment('2026-10-21T12:00:05Z', { body: 'First in the API' });
    const delayed = comment('2026-10-21T12:00:01Z', { body: 'Delayed writer' });
    const event = statusEvent('2026-10-21T12:00:03Z', 'submitted', 'in_progress');
    expect(names(buildTimeline(REQUEST, { items: [event], more: false }, { items: [first, delayed], more: false }))).toEqual([
      'Submitted',
      'Work started',
      'First in the API',
      'Delayed writer',
    ]);
  });

  it('F2: rows shown before a page loads are the first rows after it, whatever the new page holds', () => {
    const page1 = Array.from({ length: 3 }, (_, n) => comment(`2026-10-21T12:00:0${n + 2}Z`, { body: `Note ${n + 1}` }));
    const delayed = comment('2026-10-21T12:00:00Z', { body: 'Delayed writer' });
    const events = [statusEvent('2026-10-21T12:00:03.5Z', 'submitted', 'in_progress'), statusEvent('2026-10-21T12:00:09Z', 'in_progress', 'on_hold')];
    const before = names(buildTimeline(REQUEST, { items: events, more: false }, { items: page1, more: true }));
    const after = names(buildTimeline(REQUEST, { items: events, more: false }, { items: [...page1, delayed], more: false }));

    expect(before).toEqual(['Submitted', 'Note 1', 'Note 2', 'Work started', 'Note 3']);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(['Delayed writer', 'Put on hold']);
  });

  it('F2 neighbour: both reads paged at once stop at whichever runs out first, and resume in order', () => {
    const t = (s: number) => `2026-10-21T12:00:${String(s).padStart(2, '0')}Z`;
    const events = [statusEvent(t(1), 'submitted', 'in_progress'), statusEvent(t(4), 'in_progress', 'on_hold')];
    const comments = [comment(t(2), { body: 'c2' }), comment(t(3), { body: 'c3' }), comment(t(6), { body: 'c6' })];
    const step1 = names(buildTimeline(REQUEST, { items: events.slice(0, 1), more: true }, { items: comments.slice(0, 2), more: true }));
    // Events ran out after the first (it has more): nothing after it shows, though c2 and c3 are known.
    expect(step1).toEqual(['Submitted', 'Work started']);
    const step2 = names(buildTimeline(REQUEST, { items: events, more: false }, { items: comments.slice(0, 2), more: true }));
    expect(step2).toEqual(['Submitted', 'Work started', 'c2', 'c3']);
    const step3 = names(buildTimeline(REQUEST, { items: events, more: false }, { items: comments, more: false }));
    expect(step3).toEqual(['Submitted', 'Work started', 'c2', 'c3', 'Put on hold', 'c6']);
  });

  it('F2 neighbour: a cancel from the row waits while a read still has pages', () => {
    const cancelled = maintenanceRequest(1, { submitted_at: '2026-10-21T11:00:00Z', status: 'cancelled', cancelled_at: '2026-10-21T12:00:05Z' });
    const early = comment('2026-10-21T12:00:01Z', { body: 'Before the cancel' });
    expect(names(buildTimeline(cancelled, { items: [], more: false }, { items: [early], more: true }))).toEqual(['Submitted', 'Before the cancel']);
    expect(names(buildTimeline(cancelled, { items: [], more: false }, { items: [early], more: false }))).toEqual(['Submitted', 'Before the cancel', 'Cancelled']);
  });
});
