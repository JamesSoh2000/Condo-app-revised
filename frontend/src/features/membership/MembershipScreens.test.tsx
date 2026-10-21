// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { parseJoinCode } from '@/features/onboarding/JoinCodeForm';
import { BIRCH, MAPLE, RESIDENT_ME, calls, json, membership, problem, renderApp, stubApi } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type Schemas = components['schemas'];

const ME = 'GET /api/auth/me';
const status = (building: { id: string }) => `GET /api/buildings/${building.id}/onboarding/me`;
const meWith = (...memberships: Schemas['MeMembershipOut'][]): Schemas['MeOut'] => ({ ...RESIDENT_ME, memberships });
const mine = (overrides: Partial<Schemas['OnboardingMeOut']>): Schemas['OnboardingMeOut'] => ({
  status: 'pending',
  unit_label: '1003',
  tower: null,
  relationship: 'tenant',
  decision_reason: null,
  ...overrides,
});
const location = () => screen.getByTestId('location').textContent;

describe('pending screen', () => {
  it('shows the unit and relationship submitted, from onboarding/me (1)', async () => {
    stubApi({ [ME]: () => json(meWith(membership(MAPLE, { status: 'pending' }))), [status(MAPLE)]: () => json(mine({ tower: 'A' })) });
    renderApp(['/']);
    const pending = await screen.findByTestId('pending-request');
    await waitFor(() => expect(within(pending).getByTestId('pending-unit').textContent).toContain('Unit A-1003'));
    expect(pending.textContent).toContain('Maple Tower');
    expect(pending.textContent).toContain('Tenant');
    expect(pending.textContent).toContain('The building manager will review your request.');
  });

  it('still names the building and the wait when onboarding/me fails', async () => {
    stubApi({ [ME]: () => json(meWith(membership(MAPLE, { status: 'pending' }))), [status(MAPLE)]: () => problem(500, 'internal') });
    renderApp(['/']);
    const pending = await screen.findByTestId('pending-request');
    await waitFor(() => expect(pending.textContent).toContain('The building manager will review your request.'));
    expect(pending.textContent).toContain('Maple Tower');
    expect(within(pending).queryByTestId('pending-unit')).toBeNull();
  });

  it('lists each pending building with its own request', async () => {
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: 'pending' }), membership(BIRCH, { status: 'pending' }))),
      [status(MAPLE)]: () => json(mine({ unit_label: '1003' })),
      [status(BIRCH)]: () => json(mine({ unit_label: '204', relationship: 'owner' })),
    });
    renderApp(['/']);
    await waitFor(() => expect(screen.getAllByTestId('pending-unit')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('pending-request');
    // Sorted by building name, as the picker is.
    expect(first.textContent).toContain('Birch Court');
    expect(first.textContent).toContain('Unit 204');
    expect(first.textContent).toContain('Owner');
    expect(second.textContent).toContain('Maple Tower');
  });

  it('lands on the home once a reload finds the membership approved (2)', async () => {
    let approved = false;
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: approved ? 'active' : 'pending' }))),
      [status(MAPLE)]: () => json(mine({})),
    });
    renderApp(['/']);
    await screen.findByTestId('pending-request');
    cleanup();

    approved = true;
    renderApp(['/']);
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeTruthy();
    expect(screen.queryByTestId('pending-request')).toBeNull();
  });
});

describe('denied screen', () => {
  it("shows the manager's reason, and Submit again opens the unit picker (3)", async () => {
    const reason = "Unit number doesn't match our records";
    const fetchMock = stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: 'denied' }))),
      [status(MAPLE)]: () => json(mine({ status: 'denied', decision_reason: reason })),
      'GET /api/join/MAPLE-2026': () => json({ building_id: MAPLE.id, building_name: 'Maple Tower' }),
      'GET /api/join/MAPLE-2026/units': () => json([]),
    });
    renderApp(['/']);
    const denied = await screen.findByTestId('denied-request');
    await waitFor(() => expect(within(denied).getByTestId('denied-reason').textContent).toContain(reason));
    expect(denied.textContent).toContain('Maple Tower');

    fireEvent.change(screen.getByLabelText('Join code or link'), { target: { value: 'MAPLE-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit again' }));
    await screen.findByTestId('join-request');
    expect(location()).toBe('/join/MAPLE-2026');
    expect(screen.queryByTestId('join-signup-form')).toBeNull();
    expect(calls(fetchMock)).not.toContain('POST /api/auth/signup');
  });

  it('says no reason was given when there is none', async () => {
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: 'denied' }))),
      [status(MAPLE)]: () => json(mine({ status: 'denied', unit_label: null, relationship: null })),
    });
    renderApp(['/']);
    expect(await screen.findByText('No reason was given.')).toBeTruthy();
  });
});

describe('no-membership screen', () => {
  it('takes a join link and opens it (P2-06b carry)', async () => {
    stubApi({
      [ME]: () => json(meWith()),
      'GET /api/join/MAPLE-2026': () => json({ building_id: MAPLE.id, building_name: 'Maple Tower' }),
      'GET /api/join/MAPLE-2026/units': () => json([]),
    });
    renderApp(['/']);
    fireEvent.change(await screen.findByLabelText('Join code or link'), {
      target: { value: 'https://condo.example/join/MAPLE-2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('join-request');
  });

  it('refuses an empty or malformed value and stays (17)', async () => {
    stubApi({ [ME]: () => json(meWith()) });
    renderApp(['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter the join code or link your building gave you.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Join code or link'), { target: { value: 'MAPLE 2026!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Join code or link').getAttribute('aria-invalid')).toBe('true');
    expect(location()).toBe('/');
  });
});

describe('parseJoinCode (17)', () => {
  it.each([
    ['MAPLE-2026', 'MAPLE-2026'],
    [' maple-2026 ', 'MAPLE-2026'],
    ['https://condo.example/join/MAPLE-2026', 'MAPLE-2026'],
    ['condo.example/join/maple-2026?x=1#y', 'MAPLE-2026'],
    ['/join/MAPLE-2026/', 'MAPLE-2026'],
    ['//condo.example/join/MAPLE-2026', 'MAPLE-2026'],
  ])('reads %j as %s', (input, code) => {
    expect(parseJoinCode(input)).toBe(code);
  });

  it.each([
    '',
    '   ',
    'MAPLE 2026',
    'MAPLE_2026',
    'A'.repeat(17),
    'https://condo.example/invite/abc',
    'https://condo.example/join/',
    // P4-08d criterion 11 (PR #98 round 3 L1): `/join/<code>` must be the whole path.
    'https://condo.example/join/MAPLE-2026/garbage',
    'https://condo.example/help?next=/join/MAPLE-2026',
    'https://condo.example/help#/join/MAPLE-2026',
    'https://condo.example/x/join/MAPLE-2026',
  ])(
    'refuses %j',
    (input) => {
      expect(parseJoinCode(input)).toBeNull();
    },
  );
});

describe('review round 2 (Codex gpt-6.1-sol)', () => {
  it('M1: a denial seen on a fresh /me shows its reason, not the cached pending details', async () => {
    let denied = false;
    const reason = "Unit number doesn't match our records";
    const fetchMock = stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: denied ? 'denied' : 'pending' }))),
      [status(MAPLE)]: () => json(denied ? mine({ status: 'denied', decision_reason: reason }) : mine({})),
    });
    const app = renderApp(['/']);
    await screen.findByTestId('pending-unit');
    denied = true;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'], exact: true }));
    await waitFor(() => expect(screen.getByTestId('denied-reason').textContent).toContain(reason));
    expect(calls(fetchMock).filter((call) => call === status(MAPLE))).toHaveLength(2);
  });

  it('M1 neighbour: a pending request seen after a denial shows the new request, not the cached denial', async () => {
    let pendingAgain = false;
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: pendingAgain ? 'pending' : 'denied' }))),
      [status(MAPLE)]: () =>
        json(pendingAgain ? mine({ unit_label: '1004', relationship: 'owner' }) : mine({ status: 'denied', decision_reason: 'No' })),
    });
    const app = renderApp(['/']);
    await screen.findByTestId('denied-reason');
    pendingAgain = true;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'], exact: true }));
    await waitFor(() => expect(screen.getByTestId('pending-unit').textContent).toContain('1004'));
  });
});

describe('P4-08d: a repeated denial shows its own reason (criterion 10; PR #98 round 3 M1)', () => {
  let visibility: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
  };
  afterEach(() => {
    if (visibility !== 'visible') setVisibility('visible');
  });

  it('denied → pending → denied within 30 s: the second reason, never the first, not even while it loads', async () => {
    let state: 'denied A' | 'pending' | 'denied B' = 'denied A';
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: state === 'pending' ? 'pending' : 'denied' }))),
      [status(MAPLE)]: async () => {
        if (state === 'pending') return json(mine({}));
        if (state === 'denied A') return json(mine({ status: 'denied', decision_reason: 'Reason A' }));
        await gate;
        return json(mine({ status: 'denied', decision_reason: 'Reason B' }));
      },
    });
    const app = renderApp(['/']);
    await waitFor(() => expect(screen.getByTestId('denied-reason').textContent).toContain('Reason A'));

    state = 'pending';
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'], exact: true }));
    await screen.findByTestId('pending-unit');

    state = 'denied B';
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'], exact: true }));
    await screen.findByTestId('denied-request');
    expect(screen.queryByTestId('denied-reason')).toBeNull();

    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(screen.getByTestId('denied-reason').textContent).toContain('Reason B'));
  });

  it('a denied screen left open shows a newer denial once the tab is visible again', async () => {
    let reason = 'Reason A';
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: 'denied' }))),
      [status(MAPLE)]: () => json(mine({ status: 'denied', decision_reason: reason })),
    });
    renderApp(['/']);
    await waitFor(() => expect(screen.getByTestId('denied-reason').textContent).toContain('Reason A'));

    // Another tab resubmits and is denied again, within 30 s.
    setVisibility('hidden');
    reason = 'Reason B';
    setVisibility('visible');

    await waitFor(() => expect(screen.getByTestId('denied-reason').textContent).toContain('Reason B'));
  });
});
