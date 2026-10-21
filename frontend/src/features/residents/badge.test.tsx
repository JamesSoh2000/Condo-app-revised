// @vitest-environment jsdom
/**
 * P4-08d: the pending-requests badge on the nav's "Residents" item. Each `describe` names the criteria it proves
 * (docs/tickets/P4-08d-pending-badge-and-onboarding-follow-ups.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import {
  BIRCH,
  MAPLE,
  RESIDENT_ME,
  buildingOut,
  calls,
  json,
  membership,
  openAccountMenu,
  problem,
  renderApp,
  stubApi,
  type Handler,
} from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

type Role = components['schemas']['Role'];
type Request = components['schemas']['OnboardingRequestManagerOut'];

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    window.dispatchEvent(new Event('visibilitychange'));
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  if (visibility !== 'visible') setVisibility('visible');
});

const summary = (building = MAPLE) => `GET /api/buildings/${building.id}/onboarding-requests/summary`;
const pending = (n: number) => json({ pending_onboarding_count: n });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const nav = () => screen.getByRole('navigation', { name: 'Main' });
const residents = () => within(nav()).queryByRole('link', { name: /^Residents/ });
const summaryCalls = (fetchMock: ReturnType<typeof stubApi>, building = MAPLE) =>
  calls(fetchMock).filter((c) => c === summary(building)).length;

/** Maple with `roles` in both `/me` and the building's answer. */
function persona(roles: Role[], routes: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
    ...routes,
  };
}

const ROBIN: Request = {
  id: '01929a4e-0000-7000-8000-0000000e0001',
  full_name: 'Robin Park',
  email: 'robin@example.test',
  unit_id: '01929a4e-0000-7000-8000-0000000c0001',
  unit_label: '1203',
  tower: null,
  relationship: 'tenant',
  status: 'pending',
  submitted_at: '2026-10-20T14:30:00Z',
  decided_at: null,
  decision_reason: null,
};

describe('the count on the Residents item (criterion 1)', () => {
  it('names the count to a screen reader and shows it as a badge', async () => {
    stubApi(persona(['property_management'], { [summary()]: () => pending(3) }));

    renderApp(['/']);

    const link = await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', {
      name: 'Residents, 3 pending',
    });
    const badge = within(link).getByText('3');
    expect(badge.closest('[aria-hidden="true"]')).toBe(badge);
    // Only one part is read, and it says it all: Chromium spaces the parts of a name apart (stack run).
    const read = [...link.childNodes].filter((node) => !(node instanceof Element && node.getAttribute('aria-hidden') === 'true'));
    expect(read.map((node) => node.textContent)).toEqual(['Residents, 3 pending']);
    expect(link.getAttribute('href')).toBe('/manage/residents');
  });

  it('shows no badge and the plain name with none pending', async () => {
    const fetchMock = stubApi(persona(['property_management'], { [summary()]: () => pending(0) }));

    renderApp(['/']);
    await screen.findByRole('navigation', { name: 'Main' });
    await waitFor(() => expect(summaryCalls(fetchMock)).toBe(1));
    await settle();

    const link = residents()!;
    expect(link.textContent).toBe('Residents');
    expect(within(nav()).getByRole('link', { name: 'Residents' })).toBe(link);
    expect(link.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('shows 99+ above 99, with the exact count in the name', async () => {
    stubApi(persona(['property_management'], { [summary()]: () => pending(120) }));

    renderApp(['/']);

    const link = await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', {
      name: 'Residents, 120 pending',
    });
    expect(within(link).getByText('99+').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('asked again after a decision (criterion 2)', () => {
  const approve = `POST /api/buildings/${MAPLE.id}/onboarding-requests/${ROBIN.id}/approve`;
  const deny = `POST /api/buildings/${MAPLE.id}/onboarding-requests/${ROBIN.id}/deny`;

  it.each([
    ['an approval', 'Approve', () => json({ ...ROBIN, status: 'approved' })],
    ['a deny', 'Deny', () => json({ ...ROBIN, status: 'denied' })],
    ['a 409', 'Approve', () => problem(409, 'already_decided')],
    ['a 500', 'Approve', () => problem(500, 'internal_error')],
  ] as const)('after %s', async (_label, action, answer) => {
    let count = 1;
    const fetchMock = stubApi(
      persona(['property_management'], {
        [summary()]: () => pending(count),
        [`GET /api/buildings/${MAPLE.id}/onboarding-requests`]: () => json({ items: count ? [ROBIN] : [], next_cursor: null }),
        [action === 'Approve' ? approve : deny]: () => {
          count = 0;
          return answer();
        },
      }),
    );
    renderApp(['/manage/residents']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 1 pending' });
    const list = await screen.findByRole('list', { name: 'Pending requests' });

    fireEvent.click(within(list).getByRole('button', { name: `${action} Robin Park` }));
    const dialog = screen.getByRole('dialog');
    if (action === 'Deny') fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Not a resident' } });
    fireEvent.click(within(dialog).getByRole('button', { name: action }));

    await waitFor(() => expect(summaryCalls(fetchMock)).toBe(2));
    expect(await within(nav()).findByRole('link', { name: 'Residents' })).toBeTruthy();
  });
});

describe('only for property managers (criterion 3)', () => {
  it.each([
    ['a resident', ['resident']],
    ['security', ['security']],
    ['council only', ['council']],
  ] as const)('%s makes no summary request', async (_label, roles) => {
    const fetchMock = stubApi(persona([...roles]));

    renderApp(['/']);
    await screen.findByRole('navigation', { name: 'Main' });
    await settle();

    expect(calls(fetchMock)).toEqual([
      'GET /api/auth/me',
      `GET /api/buildings/${MAPLE.id}`,
      `GET /api/buildings/${MAPLE.id}/notifications/summary`,
    ]);
  });
});

describe('council "view as" (criterion 4)', () => {
  it('viewing as Resident: no item and no request; Management asks', async () => {
    sessionStorage.setItem('condo.viewAs', 'resident');
    const fetchMock = stubApi(persona(['property_management', 'council', 'resident'], { [summary()]: () => pending(2) }));

    renderApp(['/']);
    await screen.findByRole('navigation', { name: 'Main' });
    await settle();
    expect(residents()).toBeNull();
    expect(summaryCalls(fetchMock)).toBe(0);

    openAccountMenu();
    fireEvent.click(screen.getByRole('radio', { name: 'Management' }));

    expect(await within(nav()).findByRole('link', { name: 'Residents, 2 pending' })).toBeTruthy();
    expect(summaryCalls(fetchMock)).toBe(1);
  });
});

describe('polled like the notification summary (criterion 5)', () => {
  it('asks again at 30 s, not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let count = 1;
    const fetchMock = stubApi(persona(['property_management'], { [summary()]: () => pending(count) }));

    renderApp(['/']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 1 pending' });
    expect(summaryCalls(fetchMock)).toBe(1);

    count = 2;
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(summaryCalls(fetchMock)).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(await within(nav()).findByRole('link', { name: 'Residents, 2 pending' })).toBeTruthy();
    expect(summaryCalls(fetchMock)).toBe(2);
  });

  it('never while hidden, and again as soon as the tab is visible, even under 30 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let count = 1;
    const fetchMock = stubApi(persona(['property_management'], { [summary()]: () => pending(count) }));

    renderApp(['/']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 1 pending' });

    setVisibility('hidden');
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(summaryCalls(fetchMock)).toBe(1);

    count = 4;
    setVisibility('visible');
    expect(await within(nav()).findByRole('link', { name: 'Residents, 4 pending' })).toBeTruthy();
    expect(summaryCalls(fetchMock)).toBe(2);

    // Hidden for a moment only: the last answer is fresh, and it is asked again anyway.
    setVisibility('hidden');
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    count = 5;
    setVisibility('visible');
    expect(await within(nav()).findByRole('link', { name: 'Residents, 5 pending' })).toBeTruthy();
    expect(summaryCalls(fetchMock)).toBe(3);
  });
});

describe('a failed summary (criterion 6)', () => {
  it.each([
    ['a 500', () => problem(500, 'internal_error')],
    ['a 403', () => problem(403, 'forbidden')],
  ] as const)('%s shows no count, not the last one', async (_label, failure) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    stubApi(persona(['property_management'], { [summary()]: () => (fail ? failure() : pending(3)) }));

    renderApp(['/']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 3 pending' });

    fail = true;
    // A 500 is retried twice (queryClient.ts), immediately in tests (`retryDelay: 0`).
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    const link = await within(nav()).findByRole('link', { name: 'Residents' });
    expect(link.textContent).toBe('Residents');
  });
});

describe('each building its own count (criterion 7)', () => {
  it('shows the other building’s count after a switch', async () => {
    const roles: Role[] = ['property_management'];
    const fetchMock = stubApi({
      'GET /api/auth/me': () =>
        json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles }), membership(BIRCH, { roles })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, roles)),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      [summary()]: () => pending(3),
      [summary(BIRCH)]: () => pending(7),
    });
    sessionStorage.setItem('condo.buildingId', MAPLE.id);

    renderApp(['/']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 3 pending' });

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    // The nav is gone while Birch loads.
    await waitFor(() => expect(within(nav()).getByRole('link', { name: 'Residents, 7 pending' })).toBeTruthy());
    expect(summaryCalls(fetchMock, BIRCH)).toBe(1);
  });
});

describe('review round 1 (Codex gpt-6.1-sol)', () => {
  const council: Role[] = ['property_management', 'council', 'resident'];
  const approve = `POST /api/buildings/${MAPLE.id}/onboarding-requests/${ROBIN.id}/approve`;
  const list = `GET /api/buildings/${MAPLE.id}/onboarding-requests`;
  const viewAs = (name: 'Management' | 'Resident') => {
    openAccountMenu();
    fireEvent.click(screen.getByRole('radio', { name }));
  };

  it('F1: a decision asks again even while the first summary is still out (it counted before the decision)', async () => {
    let decided = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requests = 0;
    const fetchMock = stubApi(
      persona(['property_management'], {
        [summary()]: async () => {
          requests += 1;
          const count = decided ? 0 : 1;
          if (requests === 1) await gate;
          return pending(count);
        },
        [list]: () => json({ items: decided ? [] : [ROBIN], next_cursor: null }),
        [approve]: () => {
          decided = true;
          return json({ ...ROBIN, status: 'approved' });
        },
      }),
    );
    renderApp(['/manage/residents']);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Robin Park' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await screen.findByText('No pending requests.');
    await act(async () => {
      release();
      await gate;
    });

    await waitFor(() => expect(summaryCalls(fetchMock)).toBe(2));
    await settle();
    expect(within(nav()).getByRole('link', { name: 'Residents' }).textContent).toBe('Residents');
  });

  it('F1 neighbour: a decision while a poll is out ends with the newer count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let decided = false;
    let hold = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubApi(
      persona(['property_management'], {
        [summary()]: async () => {
          const count = decided ? 0 : 1;
          if (hold) {
            hold = false;
            await gate;
          }
          return pending(count);
        },
        [list]: () => json({ items: decided ? [] : [ROBIN], next_cursor: null }),
        [approve]: () => {
          decided = true;
          return json({ ...ROBIN, status: 'approved' });
        },
      }),
    );
    renderApp(['/manage/residents']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 1 pending' });
    hold = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    fireEvent.click(await screen.findByRole('button', { name: 'Approve Robin Park' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await screen.findByText('No pending requests.');
    await act(async () => {
      release();
      await gate;
    });
    await settle();

    expect(within(nav()).getByRole('link', { name: 'Residents' }).textContent).toBe('Residents');
  });

  it('F2: back to Management under 30 s asks again instead of showing the count from before', async () => {
    let count = 3;
    const fetchMock = stubApi(persona(council, { [summary()]: () => pending(count) }));
    renderApp(['/']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 3 pending' });

    viewAs('Resident');
    expect(residents()).toBeNull();
    count = 7;
    viewAs('Management');

    await waitFor(() => expect(summaryCalls(fetchMock)).toBe(2));
    expect(await within(nav()).findByRole('link', { name: 'Residents, 7 pending' })).toBeTruthy();
  });

  it('F2 neighbour: back to a building under 30 s asks again for its count', async () => {
    const roles: Role[] = ['property_management'];
    let maple = 3;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles }), membership(BIRCH, { roles })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, roles)),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      [summary()]: () => pending(maple),
      [summary(BIRCH)]: () => pending(7),
    });
    sessionStorage.setItem('condo.buildingId', MAPLE.id);
    renderApp(['/']);
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Residents, 3 pending' });

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });
    await waitFor(() => expect(within(nav()).getByRole('link', { name: 'Residents, 7 pending' })).toBeTruthy());
    maple = 5;
    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: MAPLE.id } });

    await waitFor(() => expect(within(nav()).getByRole('link', { name: 'Residents, 5 pending' })).toBeTruthy());
    expect(summaryCalls(fetchMock)).toBe(2);
  });
});
